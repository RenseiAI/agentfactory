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
  getClaimOwner,
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
import { heartbeatRedisKey } from './session-heartbeat.js'
import { redisGet } from './redis.js'
import {
  CleanupMutationExecutionError,
  executeCleanupMutation,
  type CleanupMutationAction,
  type CleanupMutationDecision,
  type CleanupMutationExecutionResult,
  type CleanupMutationInput,
  type CleanupMutationReason,
  type ExecuteCleanupMutation,
} from './cleanup-mutation-policy.js'

const log = createLogger('orphan-cleanup')

// How long a session can be running without a valid worker before being considered orphaned
const ORPHAN_THRESHOLD_MS = 120_000 // 2 minutes (worker TTL + buffer)

// Statuses that mean a session's work is finished and will never resume
const TERMINAL_STATUSES = new Set<AgentSessionState['status']>([
  'completed',
  'failed',
  'stopped',
  'timed_out',
])

/**
 * Liveness signal for the heartbeat pointer. A running worker writes
 * `session:heartbeat:<sessionId>` every 15s with a 60s TTL (ADR Decision 5).
 * Its mere presence proves a runner is alive RIGHT NOW for that session id,
 * independent of the session row's `updatedAt` (which is NOT bumped per
 * heartbeat — a long-running session's row goes stale while the runner is
 * very much alive). We additionally tolerate clock skew between the heartbeat
 * emitter and the cleanup host by treating any pointer younger than this
 * threshold as live; an expired Redis key simply returns null.
 */
const HEARTBEAT_LIVE_THRESHOLD_MS = 90_000 // 60s TTL + a tick of grace/skew

interface SessionHeartbeatPointer {
  sessionId: string
  workerId: string
  emittedAt: number
  stepId?: string
}

/**
 * True iff a live worker heartbeat pointer exists for the given session id.
 *
 * This is the authoritative "is the runner alive?" probe. The pointer has a
 * 60s TTL refreshed every 15s, so its presence (and recent `emittedAt`) proves
 * an in-flight session — even one whose row `updatedAt` is minutes stale. The
 * sweep MUST consult this before reaping: a long-running real session is
 * exactly the case the prior implementation mis-reaped.
 */
async function hasLiveHeartbeat(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  try {
    const pointer = await redisGet<SessionHeartbeatPointer>(
      heartbeatRedisKey(sessionId)
    )
    if (!pointer) return false
    // Defend against a stale-but-not-yet-expired pointer (clock skew, a TTL
    // that hasn't fired yet): require a recent emit, not just key presence.
    const age = Date.now() - pointer.emittedAt
    return age < HEARTBEAT_LIVE_THRESHOLD_MS
  } catch (err) {
    // On a Redis read error, fail SAFE: assume live so we never reap a row we
    // could not prove dead. A true strand is reaped on the next clean pass.
    log.warn('Heartbeat liveness probe failed; treating as live', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return true
  }
}

/**
 * True iff the session has a live worker claim (`work:claim:<sessionId>`), set
 * with a TTL when a worker claims the work item. A held claim means a worker
 * is processing (or about to process) this session and the row is NOT stranded.
 */
async function hasLiveClaim(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  try {
    return (await getClaimOwner(sessionId)) !== null
  } catch (err) {
    // Fail safe: a probe error must never license a reap.
    log.warn('Claim liveness probe failed; treating as claimed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
    return true
  }
}

/**
 * Positively determine that a per-dispatch alias row is TRULY stranded — i.e.
 * the work it represents is dead and the row can never make progress — so it
 * is safe to terminal-mark.
 *
 * A row is a true strand ONLY when EVERY liveness signal is absent. We probe
 * BOTH the row's own id (`rowSessionId`) and its `trackerSessionId`, because
 * the runner heartbeats/claims under whichever id the dispatched work carried;
 * a live signal on EITHER id means a worker is alive and we must NOT reap.
 *
 * Signals checked (any one present ⇒ NOT stranded):
 *   1. A recent worker heartbeat pointer (the authoritative liveness probe).
 *   2. A held work-claim key.
 *   3. The session is still queued in the global work queue.
 *   4. The session is parked in its issue-pending queue.
 *
 * Returns the reason string to record when the row IS stranded, or null when
 * any liveness signal proves it is still live.
 */
async function resolveStrandedReason(
  session: AgentSessionState
): Promise<string | null> {
  const rowId = session.rowSessionId as string
  const trackerId = session.trackerSessionId
  const candidateIds = trackerId && trackerId !== rowId ? [rowId, trackerId] : [rowId]

  // 1. Live heartbeat on either id ⇒ a runner is actively working.
  for (const id of candidateIds) {
    if (await hasLiveHeartbeat(id)) {
      return null
    }
  }

  // 2. Held claim on either id ⇒ a worker owns this session.
  for (const id of candidateIds) {
    if (await hasLiveClaim(id)) {
      return null
    }
  }

  // 3. Still queued (a worker can still pick it up) on either id.
  for (const id of candidateIds) {
    if (await isSessionInQueue(id)) {
      return null
    }
  }

  // 4. Parked in the issue-pending queue (awaiting promotion) on either id.
  for (const id of candidateIds) {
    if (await isSessionParkedForIssue(session.issueId, id)) {
      return null
    }
  }

  // No liveness signal anywhere — the row is a true strand. Annotate the
  // reason with the tracker session's terminal/missing state when known.
  const tracker = trackerId ? await getSessionState(trackerId) : null
  if (tracker) {
    return `Stranded per-dispatch row: no live worker; tracker session ${trackerId} is ${tracker.status}`
  }
  return `Stranded per-dispatch row: no live worker; tracker session ${trackerId} no longer exists`
}

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
  /**
   * Preferred around-mutation seam. A fresh result invokes `mutate` exactly
   * once after its durable gate; a completed replay returns without entry.
   */
  executeMutation?: ExecuteCleanupMutation
  /**
   * Backward-compatible preflight hook for existing standalone embedders.
   * Ignored when executeMutation is present.
   */
  beforeMutation?: (
    input: OrphanCleanupMutationInput
  ) => Promise<OrphanCleanupMutationDecision>
  /** Called when an orphaned session is re-queued. Use to post Linear comments, etc. */
  onOrphanRequeued?: (session: AgentSessionState) => Promise<void>
  /** Called when a zombie pending session is recovered. Use to post Linear comments, etc. */
  onZombieRecovered?: (session: AgentSessionState) => Promise<void>
}

export type OrphanCleanupMutationAction = CleanupMutationAction
export type OrphanCleanupMutationReason = CleanupMutationReason
export type OrphanCleanupMutationInput = CleanupMutationInput
export type OrphanCleanupMutationDecision = CleanupMutationDecision
export type ExecuteOrphanCleanupMutation = ExecuteCleanupMutation

export interface OrphanCleanupResult {
  checked: number
  orphaned: number
  requeued: number
  failed: number
  /** Candidates left untouched because the authoritative pre-mutation policy refused. */
  refused: number
  /** Stranded per-dispatch rows terminal-marked under their own key */
  terminalMarked: number
  details: Array<{
    sessionId: string
    issueIdentifier: string
    action: 'requeued' | 'failed' | 'terminal-marked' | 'refused'
    reason?: string
    refusalCode?: string
    /** Path to worktree that may need cleanup (if on worker machine) */
    worktreePath?: string
  }>
  /** Worktree paths that need cleanup on worker machines */
  worktreePathsToCleanup: string[]
}

function recordMutationRefusal(
  result: OrphanCleanupResult,
  session: AgentSessionState,
  decision: Extract<OrphanCleanupMutationDecision, { permitted: false }>
): void {
  result.refused++
  result.details.push({
    sessionId: session.rowSessionId || session.trackerSessionId,
    issueIdentifier: session.issueIdentifier || session.issueId.slice(0, 8),
    action: 'refused',
    refusalCode: decision.code,
    reason: decision.detail,
  })
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
 * Find CANDIDATE stranded per-dispatch rows — alias rows written under their
 * own key whose stored `trackerSessionId` points at a shared tracker session.
 * Since every status write keys off `trackerSessionId`, such a row never leaves
 * its initial status under its own key; if its work dies before reaching the
 * runner, the row is left dangling as a phantom queued/parked session.
 *
 * This function returns only *candidates*: alias rows that are non-terminal and
 * whose row `updatedAt` is older than the zombie threshold. It is deliberately
 * a cheap pre-filter — it does NOT decide that a row is truly stranded.
 *
 * CRITICAL: a stale `updatedAt` does NOT mean dead. A long-running real session
 * heartbeats via the `session:heartbeat:<id>` pointer every 15s but does NOT
 * bump its row's `updatedAt`, so its row appears "stale" while the runner is
 * very much alive. The caller (`cleanupOrphanedSessions` →
 * `resolveStrandedReason`) is the authority on terminality: it reaps a
 * candidate ONLY after positively confirming there is no live heartbeat, no
 * held claim, and no queued/parked entry on either the row id or the tracker id.
 */
export async function findStrandedDispatchRows(): Promise<AgentSessionState[]> {
  const sessions = await getAllSessions()
  const now = Date.now()
  const stranded: AgentSessionState[] = []

  for (const session of sessions) {
    if (!isPerDispatchAliasRow(session)) continue
    if (TERMINAL_STATUSES.has(session.status)) continue

    // Cheap pre-filter: don't even probe rows touched within the grace window
    // (dispatch may still be in flight). NOTE: passing this filter is NECESSARY
    // but NOT SUFFICIENT for a reap — liveness is proven in resolveStrandedReason.
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
    refused: 0,
    terminalMarked: 0,
    details: [],
    worktreePathsToCleanup: [],
  }

  // A refused lifecycle identity stays refused for the remainder of this pass.
  // This prevents a later lock-maintenance sweep from re-evaluating and then
  // mutating the same candidate through a different cleanup path.
  const refusedBySessionId = new Map<
    string,
    Extract<OrphanCleanupMutationDecision, { permitted: false }>
  >()
  const recordedRefusals = new Set<string>()
  const sessionIdentity = (session: AgentSessionState): string =>
    session.rowSessionId || session.trackerSessionId

  const runMutation = async <T>(
    input: OrphanCleanupMutationInput,
    mutate: () => Promise<T>
  ): Promise<CleanupMutationExecutionResult<T>> => {
    const identity = sessionIdentity(input.session)
    const priorRefusal = refusedBySessionId.get(identity)
    if (priorRefusal) return priorRefusal

    const result = await executeCleanupMutation({
      input,
      mutate,
      executeMutation: callbacks?.executeMutation,
      beforeMutation: callbacks?.beforeMutation,
    })
    if (!result.permitted) refusedBySessionId.set(identity, result)
    return result
  }

  const recordRefusalOnce = (
    session: AgentSessionState,
    decision: Extract<OrphanCleanupMutationDecision, { permitted: false }>
  ): void => {
    const identity = sessionIdentity(session)
    if (recordedRefusals.has(identity)) return
    recordedRefusals.add(identity)
    recordMutationRefusal(result, session, decision)
  }

  const issueLockCleanupCallbacks =
    callbacks?.executeMutation || callbacks?.beforeMutation
    ? {
        executeMutation: runMutation,
        onRefused: (
          candidate: import('./issue-lock.js').IssueLockCleanupCandidate,
          decision: Extract<
            OrphanCleanupMutationDecision,
            { permitted: false }
          >
        ) => {
          if (candidate.session) {
            recordRefusalOnce(candidate.session, decision)
            return
          }

          if (recordedRefusals.has(candidate.sessionId)) return
          recordedRefusals.add(candidate.sessionId)
          refusedBySessionId.set(candidate.sessionId, decision)
          result.refused++
          result.details.push({
            sessionId: candidate.sessionId,
            issueIdentifier: candidate.issueIdentifier,
            action: 'refused',
            refusalCode: decision.code,
            reason: decision.detail,
          })
        },
      }
    : undefined

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

        const execution = await runMutation(
          {
            session,
            action: 'orphan_requeue',
            reason: 'worker_unreachable',
            now: Date.now(),
          },
          async () => {
            // Release any existing claim
            await releaseClaim(session.trackerSessionId)

            // Release the issue lock if held by this orphaned session.
            // Without this, dispatchWork() below would fail to acquire the lock
            // (SET NX) and park the work instead — leaving it stuck until the
            // lock's 2-hour TTL expires, since the session is reset to 'pending'
            // which the stale-lock cleanup doesn't consider terminal.
            const existingLock = await getIssueLock(session.issueId)
            if (
              existingLock &&
              existingLock.sessionId === session.trackerSessionId
            ) {
              log.info('Releasing issue lock held by orphaned session', {
                sessionId: session.trackerSessionId,
                issueId: session.issueId,
              })
              await releaseIssueLock(session.issueId)
            }

            // Reset session for requeue (clears workerId so new worker can claim)
            await resetSessionForRequeue(session.trackerSessionId)

            // Re-queue the work with higher priority. Starting fresh is safer
            // than preserving a provider session from the crashed worker.
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

            return dispatchWork(work)
          }
        )
        if (!execution.permitted) {
          recordRefusalOnce(session, execution)
          continue
        }
        if (execution.idempotentReplay) continue
        const dispatchResult = execution.value

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
        if (err instanceof CleanupMutationExecutionError) throw err
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

          const execution = await runMutation(
            {
              session,
              action: 'zombie_redispatch',
              reason: 'pending_unqueued',
              now: Date.now(),
            },
            async () => {
              // Release issue lock if held by this zombie session (same
              // rationale as orphan cleanup).
              const existingLock = await getIssueLock(session.issueId)
              if (
                existingLock &&
                existingLock.sessionId === session.trackerSessionId
              ) {
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

              return dispatchWork(work)
            }
          )
          if (!execution.permitted) {
            recordRefusalOnce(session, execution)
            continue
          }
          if (execution.idempotentReplay) continue
          const dispatchResult = execution.value

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
          if (err instanceof CleanupMutationExecutionError) throw err
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
      if (err instanceof CleanupMutationExecutionError) throw err
      log.error('Failed to find zombie pending sessions', { error: err })
    }

    // Terminal-mark TRULY-stranded per-dispatch rows under their OWN key.
    // A candidate alias row is reaped ONLY after resolveStrandedReason proves
    // there is no live worker for it (no recent heartbeat, no held claim, not
    // queued, not parked) on EITHER the row id or the tracker id. This is the
    // load-bearing guard: a live long-running session heartbeats every 15s but
    // does NOT bump its row's updatedAt, so without this probe it would be
    // mis-reaped at ~5 minutes — the regression this sweep previously caused.
    try {
      const candidates = await findStrandedDispatchRows()

      if (candidates.length > 0) {
        log.info('Probing stranded per-dispatch row candidates', {
          count: candidates.length,
        })
      }

      for (const session of candidates) {
        // findStrandedDispatchRows guarantees rowSessionId is set
        const rowSessionId = session.rowSessionId as string
        const issueIdentifier =
          session.issueIdentifier || session.issueId.slice(0, 8)

        try {
          const stoppedReason = await resolveStrandedReason(session)

          if (stoppedReason === null) {
            // A liveness signal proves the row is still live — leave it. It
            // converges on a later pass once the runner actually finishes.
            log.debug('Stranded candidate still live, skipping', {
              rowSessionId,
              trackerSessionId: session.trackerSessionId,
            })
            continue
          }

          const execution = await runMutation(
            {
              session,
              action: 'stranded_terminalize',
              reason: 'dispatch_stranded',
              now: Date.now(),
            },
            () =>
              updateSessionStatus(rowSessionId, 'stopped', {
                stoppedReason,
              })
          )
          if (!execution.permitted) {
            recordRefusalOnce(session, execution)
            continue
          }
          if (execution.idempotentReplay) continue
          const marked = execution.value

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
              reason: stoppedReason,
            })
          }
        } catch (err) {
          if (err instanceof CleanupMutationExecutionError) throw err
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
      if (err instanceof CleanupMutationExecutionError) throw err
      log.error('Failed to reconcile stranded per-dispatch rows', { error: err })
    }

    // Also check for expired issue locks with pending work
    try {
      const promoted = await cleanupExpiredLocksWithPendingWork(
        issueLockCleanupCallbacks
      )
      if (promoted > 0) {
        log.info('Promoted pending work from expired issue locks', { promoted })
      }
    } catch (err) {
      if (err instanceof CleanupMutationExecutionError) throw err
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
        const promoted = await cleanupStaleLocksWithIdleWorkers(
          hasIdleWorkers,
          issueLockCleanupCallbacks
        )
        if (promoted > 0) {
          log.info('Promoted parked work from stale issue locks', { promoted })
        }
      }
    } catch (err) {
      if (err instanceof CleanupMutationExecutionError) throw err
      log.error('Failed to cleanup stale issue locks', { error: err })
    }

    log.info('Orphan cleanup completed', {
      checked: result.checked,
      orphaned: result.orphaned,
      requeued: result.requeued,
      failed: result.failed,
      refused: result.refused,
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
    if (err instanceof CleanupMutationExecutionError) throw err
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
