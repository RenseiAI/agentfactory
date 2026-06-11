/**
 * Orphan Cleanup Module
 *
 * Detects and handles orphaned sessions - sessions marked as running/claimed
 * but whose worker is no longer active (heartbeat timeout).
 *
 * When a worker disconnects, the work is re-queued for another worker to resume.
 * The Linear issue status is NOT rolled back - the issue remains in its current
 * workflow state and the next worker will resume from where the previous one left off.
 */

import { createLogger } from './logger.js'
import {
  getAllSessions,
  getSessionState,
  resetSessionForRequeue,
  updateSessionStatus,
  type AgentSessionState,
} from './session-storage.js'
import { listWorkers } from './worker-storage.js'
import {
  releaseClaim,
  isSessionInQueue,
  type QueuedWork,
} from './work-queue.js'
import {
  dispatchWork,
  cleanupExpiredLocksWithPendingWork,
  cleanupStaleLocksWithIdleWorkers,
  isSessionParkedForIssue,
  getIssueLock,
  releaseIssueLock,
} from './issue-lock.js'

const log = createLogger('orphan-cleanup')

// How long a session can be running without a valid worker before being considered orphaned
const ORPHAN_THRESHOLD_MS = 120_000 // 2 minutes (worker TTL + buffer)

// Statuses that mean a session's work is finished and will never resume
const TERMINAL_STATUSES = new Set<AgentSessionState['status']>([
  'completed',
  'failed',
  'stopped',
])

/**
 * Check whether a session row is a per-dispatch alias: a row stored under its
 * own key whose `trackerSessionId` points at a DIFFERENT (shared) tracker
 * session. Every lifecycle write (claim/start/complete/requeue) keys off
 * `trackerSessionId`, so alias rows never receive status updates under their
 * own key. They must never drive re-dispatch (the tracker-keyed session owns
 * the lifecycle) and are reconciled by `findStrandedDispatchRows` instead.
 */
function isPerDispatchAliasRow(session: AgentSessionState): boolean {
  return (
    !!session.rowSessionId &&
    session.rowSessionId !== session.trackerSessionId
  )
}

/**
 * Callback for when an orphaned session is re-queued
 */
export interface OrphanCleanupCallbacks {
  /** Called when an orphaned session is re-queued. Use to post Linear comments, etc. */
  onOrphanRequeued?: (session: AgentSessionState) => Promise<void>
  /** Called when a zombie pending session is recovered. Use to post Linear comments, etc. */
  onZombieRecovered?: (session: AgentSessionState) => Promise<void>
}

export interface OrphanCleanupResult {
  checked: number
  orphaned: number
  requeued: number
  failed: number
  /** Stranded per-dispatch rows terminal-marked under their own key */
  terminalMarked: number
  details: Array<{
    sessionId: string
    issueIdentifier: string
    action: 'requeued' | 'failed' | 'terminal-marked'
    reason?: string
    /** Path to worktree that may need cleanup (if on worker machine) */
    worktreePath?: string
  }>
  /** Worktree paths that need cleanup on worker machines */
  worktreePathsToCleanup: string[]
}

/**
 * Find sessions that are orphaned (running/claimed but worker is gone)
 */
export async function findOrphanedSessions(): Promise<AgentSessionState[]> {
  const [sessions, workers] = await Promise.all([
    getAllSessions(),
    listWorkers(),
  ])

  // Build set of active worker IDs
  const activeWorkerIds = new Set(
    workers
      .filter((w) => w.status === 'active')
      .map((w) => w.id)
  )

  const orphaned: AgentSessionState[] = []

  for (const session of sessions) {
    // Only check running or claimed sessions
    if (session.status !== 'running' && session.status !== 'claimed') {
      continue
    }

    // Per-dispatch alias rows never receive lifecycle writes under their own
    // key — re-queuing one would duplicate the tracker-keyed session's work
    if (isPerDispatchAliasRow(session)) {
      continue
    }

    // Grace period: skip sessions updated recently — prevents race when a worker
    // re-registers with a new ID but hasn't transferred session ownership yet
    const sessionAge = Date.now() - session.updatedAt
    if (sessionAge < ORPHAN_THRESHOLD_MS) {
      log.debug('Session recently updated, skipping orphan check', {
        sessionId: session.trackerSessionId,
        ageMs: sessionAge,
      })
      continue
    }

    // If session has no worker assigned, it's orphaned
    if (!session.workerId) {
      log.debug('Session has no worker assigned', {
        sessionId: session.trackerSessionId,
        status: session.status,
      })
      orphaned.push(session)
      continue
    }

    // If the assigned worker is no longer active, session is orphaned
    if (!activeWorkerIds.has(session.workerId)) {
      log.debug('Session worker is no longer active', {
        sessionId: session.trackerSessionId,
        workerId: session.workerId,
        status: session.status,
      })
      orphaned.push(session)
      continue
    }
  }

  return orphaned
}

// How long a pending session can exist without a queue entry before being considered a zombie
const ZOMBIE_PENDING_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Find zombie pending sessions — sessions stuck in `pending` status
 * that have no corresponding entry in the work queue or any issue-pending queue.
 *
 * These arise when:
 * - claimWork() removes from queue, but claimSession() fails and requeue also fails
 * - Issue lock expires but promotion fails silently
 */
export async function findZombiePendingSessions(): Promise<AgentSessionState[]> {
  const sessions = await getAllSessions()
  const now = Date.now()
  const zombies: AgentSessionState[] = []

  for (const session of sessions) {
    if (session.status !== 'pending') continue

    // Per-dispatch alias rows are not zombies: their pending status is frozen
    // by design (lifecycle writes key off trackerSessionId). Re-dispatching
    // the tracker session for every alias row caused an infinite
    // re-queue -> pop -> drop churn on each cleanup pass. They are reconciled
    // by findStrandedDispatchRows instead.
    if (isPerDispatchAliasRow(session)) continue

    // Only consider sessions older than the threshold
    const age = now - session.updatedAt
    if (age < ZOMBIE_PENDING_THRESHOLD_MS) continue

    // Check if session is in the global work queue
    const inQueue = await isSessionInQueue(session.trackerSessionId)
    if (inQueue) continue

    // Check if session is parked in the issue-pending queue
    const parked = await isSessionParkedForIssue(
      session.issueId,
      session.trackerSessionId
    )
    if (parked) continue

    // Session is pending but not in any queue — it's a zombie
    log.warn('Found zombie pending session', {
      sessionId: session.trackerSessionId,
      issueIdentifier: session.issueIdentifier,
      ageMinutes: Math.round(age / 60_000),
    })
    zombies.push(session)
  }

  return zombies
}

/**
 * Find stranded per-dispatch rows — alias rows written under their own key
 * whose stored `trackerSessionId` was later patched to a shared tracker
 * session. Since every lifecycle write keys off `trackerSessionId`, these
 * rows never leave their initial status under their own key. Once the
 * tracker-keyed session is terminal (or has expired), the row is permanently
 * stranded: it renders as a phantom queued/parked session and, before this
 * sweep existed, was re-queued on every cleanup pass.
 *
 * Returns alias rows that are non-terminal and older than the zombie
 * threshold. The caller decides terminality by checking the tracker-keyed
 * session state.
 */
export async function findStrandedDispatchRows(): Promise<AgentSessionState[]> {
  const sessions = await getAllSessions()
  const now = Date.now()
  const stranded: AgentSessionState[] = []

  for (const session of sessions) {
    if (!isPerDispatchAliasRow(session)) continue
    if (TERMINAL_STATUSES.has(session.status)) continue

    // Grace period: leave fresh rows alone (dispatch may still be in flight)
    const age = now - session.updatedAt
    if (age < ZOMBIE_PENDING_THRESHOLD_MS) continue

    stranded.push(session)
  }

  return stranded
}

/**
 * Clean up orphaned sessions by re-queuing them
 *
 * @param callbacks - Optional callbacks for external integrations (e.g., posting Linear comments)
 */
export async function cleanupOrphanedSessions(
  callbacks?: OrphanCleanupCallbacks
): Promise<OrphanCleanupResult> {
  const result: OrphanCleanupResult = {
    checked: 0,
    orphaned: 0,
    requeued: 0,
    failed: 0,
    terminalMarked: 0,
    details: [],
    worktreePathsToCleanup: [],
  }

  try {
    const sessions = await getAllSessions()
    result.checked = sessions.length

    const orphaned = await findOrphanedSessions()
    result.orphaned = orphaned.length

    if (orphaned.length > 0) {
      log.info('Found orphaned sessions', { count: orphaned.length })
    }

    for (const session of orphaned) {
      try {
        const issueIdentifier = session.issueIdentifier || session.issueId.slice(0, 8)

        log.info('Re-queuing orphaned session', {
          sessionId: session.trackerSessionId,
          issueIdentifier,
          previousWorker: session.workerId,
          previousStatus: session.status,
        })

        // Release any existing claim
        await releaseClaim(session.trackerSessionId)

        // Release the issue lock if held by this orphaned session.
        // Without this, dispatchWork() below would fail to acquire the lock
        // (SET NX) and park the work instead — leaving it stuck until the
        // lock's 2-hour TTL expires, since the session is reset to 'pending'
        // which the stale-lock cleanup doesn't consider terminal.
        const existingLock = await getIssueLock(session.issueId)
        if (existingLock && existingLock.sessionId === session.trackerSessionId) {
          log.info('Releasing issue lock held by orphaned session', {
            sessionId: session.trackerSessionId,
            issueId: session.issueId,
          })
          await releaseIssueLock(session.issueId)
        }

        // Reset session for requeue (clears workerId so new worker can claim)
        await resetSessionForRequeue(session.trackerSessionId)

        // Re-queue the work with higher priority
        // IMPORTANT: Preserve workType to prevent incorrect status transitions
        // NOTE: Do NOT preserve providerSessionId - the old session may be corrupted
        // from the crash that caused the orphan. Starting fresh is safer.
        const work: QueuedWork = {
          sessionId: session.trackerSessionId,
          issueId: session.issueId,
          issueIdentifier,
          priority: Math.max(1, (session.priority || 3) - 1), // Boost priority
          queuedAt: Date.now(),
          prompt: session.promptContext,
          // providerSessionId intentionally omitted - don't resume crashed sessions
          workType: session.workType,
          projectName: session.projectName,
        }

        const dispatchResult = await dispatchWork(work)

        if (dispatchResult.dispatched || dispatchResult.parked) {
          result.requeued++
          result.details.push({
            sessionId: session.trackerSessionId,
            issueIdentifier,
            action: 'requeued',
            worktreePath: session.worktreePath,
          })

          // Track worktree path for cleanup on worker machines
          if (session.worktreePath) {
            result.worktreePathsToCleanup.push(session.worktreePath)
          }

          // Call external callback (e.g., post Linear comment)
          if (callbacks?.onOrphanRequeued) {
            try {
              await callbacks.onOrphanRequeued(session)
            } catch (err) {
              log.warn('onOrphanRequeued callback failed', { error: err })
            }
          }
        } else {
          result.failed++
          result.details.push({
            sessionId: session.trackerSessionId,
            issueIdentifier,
            action: 'failed',
            reason: 'Failed to queue work',
          })
        }
      } catch (err) {
        log.error('Failed to cleanup orphaned session', {
          sessionId: session.trackerSessionId,
          error: err,
        })
        result.failed++
        result.details.push({
          sessionId: session.trackerSessionId,
          issueIdentifier: session.issueIdentifier || 'unknown',
          action: 'failed',
          reason: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }

    // Check for zombie pending sessions (pending but not in any queue)
    try {
      const zombies = await findZombiePendingSessions()

      if (zombies.length > 0) {
        log.info('Found zombie pending sessions', { count: zombies.length })
      }

      for (const session of zombies) {
        try {
          const issueIdentifier = session.issueIdentifier || session.issueId.slice(0, 8)

          log.info('Re-dispatching zombie pending session', {
            sessionId: session.trackerSessionId,
            issueIdentifier,
          })

          // Release issue lock if held by this zombie session (same rationale as orphan cleanup)
          const existingLock = await getIssueLock(session.issueId)
          if (existingLock && existingLock.sessionId === session.trackerSessionId) {
            log.info('Releasing issue lock held by zombie session', {
              sessionId: session.trackerSessionId,
              issueId: session.issueId,
            })
            await releaseIssueLock(session.issueId)
          }

          const work: QueuedWork = {
            sessionId: session.trackerSessionId,
            issueId: session.issueId,
            issueIdentifier,
            priority: Math.max(1, (session.priority || 3) - 1),
            queuedAt: Date.now(),
            prompt: session.promptContext,
            workType: session.workType,
            projectName: session.projectName,
          }

          const dispatchResult = await dispatchWork(work)

          if (dispatchResult.dispatched || dispatchResult.parked) {
            result.requeued++
            result.details.push({
              sessionId: session.trackerSessionId,
              issueIdentifier,
              action: 'requeued',
              reason: 'Zombie pending session recovered',
            })

            // Call external callback
            if (callbacks?.onZombieRecovered) {
              try {
                await callbacks.onZombieRecovered(session)
              } catch (err) {
                log.warn('onZombieRecovered callback failed', { error: err })
              }
            }
          } else {
            result.failed++
            result.details.push({
              sessionId: session.trackerSessionId,
              issueIdentifier,
              action: 'failed',
              reason: 'Failed to re-dispatch zombie session',
            })
          }
        } catch (err) {
          log.error('Failed to recover zombie session', {
            sessionId: session.trackerSessionId,
            error: err,
          })
          result.failed++
          result.details.push({
            sessionId: session.trackerSessionId,
            issueIdentifier: session.issueIdentifier || 'unknown',
            action: 'failed',
            reason: err instanceof Error ? err.message : 'Unknown error',
          })
        }
      }
    } catch (err) {
      log.error('Failed to find zombie pending sessions', { error: err })
    }

    // Terminal-mark stranded per-dispatch rows under their OWN key.
    // These rows alias a shared tracker session; when the tracker-keyed state
    // is terminal or missing the alias can never progress, so stop it here
    // instead of letting it strand as a phantom forever.
    try {
      const stranded = await findStrandedDispatchRows()

      if (stranded.length > 0) {
        log.info('Found stranded per-dispatch session rows', {
          count: stranded.length,
        })
      }

      for (const session of stranded) {
        // findStrandedDispatchRows guarantees rowSessionId is set
        const rowSessionId = session.rowSessionId as string
        const issueIdentifier =
          session.issueIdentifier || session.issueId.slice(0, 8)

        try {
          const tracker = await getSessionState(session.trackerSessionId)

          if (tracker && !TERMINAL_STATUSES.has(tracker.status)) {
            // Tracker session is still live — it owns the lifecycle. The
            // alias row converges on a later pass once the tracker finishes.
            log.debug('Stranded row tracker session still active, skipping', {
              rowSessionId,
              trackerSessionId: session.trackerSessionId,
              trackerStatus: tracker.status,
            })
            continue
          }

          const stoppedReason = tracker
            ? `Stranded per-dispatch row: tracker session ${session.trackerSessionId} is ${tracker.status}`
            : `Stranded per-dispatch row: tracker session ${session.trackerSessionId} no longer exists`

          const marked = await updateSessionStatus(rowSessionId, 'stopped', {
            stoppedReason,
          })

          if (marked) {
            result.terminalMarked++
            result.details.push({
              sessionId: rowSessionId,
              issueIdentifier,
              action: 'terminal-marked',
              reason: stoppedReason,
            })

            log.info('Terminal-marked stranded per-dispatch row', {
              rowSessionId,
              trackerSessionId: session.trackerSessionId,
              issueIdentifier,
              trackerStatus: tracker?.status ?? 'missing',
            })
          }
        } catch (err) {
          log.error('Failed to terminal-mark stranded per-dispatch row', {
            rowSessionId,
            error: err,
          })
          result.failed++
          result.details.push({
            sessionId: rowSessionId,
            issueIdentifier,
            action: 'failed',
            reason: err instanceof Error ? err.message : 'Unknown error',
          })
        }
      }
    } catch (err) {
      log.error('Failed to reconcile stranded per-dispatch rows', { error: err })
    }

    // Also check for expired issue locks with pending work
    try {
      const promoted = await cleanupExpiredLocksWithPendingWork()
      if (promoted > 0) {
        log.info('Promoted pending work from expired issue locks', { promoted })
      }
    } catch (err) {
      log.error('Failed to cleanup expired issue locks', { error: err })
    }

    // Check for stale locks held by completed sessions when workers have idle capacity.
    // Only runs when workers are online — no point promoting if nobody can pick it up.
    try {
      const workers = await listWorkers()
      const activeWorkers = workers.filter((w) => w.status === 'active')
      const hasIdleWorkers =
        activeWorkers.length > 0 &&
        activeWorkers.some((w) => w.activeCount < w.capacity)

      if (hasIdleWorkers) {
        const promoted = await cleanupStaleLocksWithIdleWorkers(hasIdleWorkers)
        if (promoted > 0) {
          log.info('Promoted parked work from stale issue locks', { promoted })
        }
      }
    } catch (err) {
      log.error('Failed to cleanup stale issue locks', { error: err })
    }

    log.info('Orphan cleanup completed', {
      checked: result.checked,
      orphaned: result.orphaned,
      requeued: result.requeued,
      failed: result.failed,
      terminalMarked: result.terminalMarked,
      worktreePathsToCleanup: result.worktreePathsToCleanup.length,
    })

    // Log worktree cleanup info if any paths need attention
    if (result.worktreePathsToCleanup.length > 0) {
      log.info('Worktree cleanup needed on worker machines', {
        paths: result.worktreePathsToCleanup,
        note: 'Run cleanup-worktrees on each worker machine to remove orphaned worktrees',
      })
    }
  } catch (err) {
    log.error('Orphan cleanup failed', { error: err })
  }

  return result
}

/**
 * Check if cleanup should run based on time since last cleanup
 * Returns true if enough time has passed
 */
let lastCleanupTime = 0
const CLEANUP_INTERVAL_MS = 60_000 // Run at most once per minute

export function shouldRunCleanup(): boolean {
  const now = Date.now()
  if (now - lastCleanupTime >= CLEANUP_INTERVAL_MS) {
    lastCleanupTime = now
    return true
  }
  return false
}

/**
 * Run cleanup if enough time has passed (debounced)
 * Safe to call frequently - will only actually run periodically
 *
 * @param callbacks - Optional callbacks for external integrations
 */
export async function maybeCleanupOrphans(
  callbacks?: OrphanCleanupCallbacks
): Promise<OrphanCleanupResult | null> {
  if (!shouldRunCleanup()) {
    return null
  }
  return cleanupOrphanedSessions(callbacks)
}
