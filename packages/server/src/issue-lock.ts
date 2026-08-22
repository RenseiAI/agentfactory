/**
 * Issue Lock Module
 *
 * Prevents overlapping agents for the same issue by providing:
 * - Per-issue mutex (Redis SET NX) that gates work dispatch
 * - Per-issue pending queue for parking incoming work while locked
 * - Automatic promotion: releasing a lock dispatches the next pending item
 *
 * Redis Keys:
 * - issue:lock:{issueId}         -- String (JSON IssueLock), 2hr TTL
 * - issue:pending:{issueId}      -- Sorted Set (priority-ordered session IDs)
 * - issue:pending:items:{issueId} -- Hash (sessionId -> JSON QueuedWork)
 */

import {
  redisSetNX,
  redisGet,
  redisDel,
  redisExpire,
  redisSet,
  redisZAdd,
  redisZRem,
  redisZRangeByScore,
  redisZPopMin,
  redisCompareAndRemoveSortedHashMember,
  redisZCard,
  redisHSet,
  redisHGet,
  redisHDel,
  redisHGetAll,
  isRedisConfigured,
  redisKeys,
} from './redis.js'
import { queueWork, type QueuedWork } from './work-queue.js'
import { getSessionState, type AgentSessionState } from './session-storage.js'
import type { AgentWorkType } from './types.js'
import {
  evaluateCleanupMutationPolicy,
  type BeforeCleanupMutation,
  type CleanupMutationAction,
  type CleanupMutationDecision,
  type CleanupMutationReason,
} from './cleanup-mutation-policy.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[issue-lock] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[issue-lock] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[issue-lock] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// Redis key prefixes
const LOCK_PREFIX = 'issue:lock:'
const PENDING_PREFIX = 'issue:pending:'
const PENDING_ITEMS_PREFIX = 'issue:pending:items:'

// Default lock TTL: 2 hours
const LOCK_TTL_SECONDS = 2 * 60 * 60

// Pending queue TTL: 24 hours
const PENDING_TTL_SECONDS = 24 * 60 * 60

/**
 * Lock payload stored in Redis
 */
export interface IssueLock {
  sessionId: string
  workType: AgentWorkType
  workerId: string | null
  lockedAt: number
  issueIdentifier: string
}

/**
 * Result of a dispatchWork call
 */
export interface DispatchResult {
  dispatched: boolean
  parked: boolean
  replaced: boolean
}

export interface IssueLockCleanupCandidate {
  session?: AgentSessionState
  sessionId: string
  issueId: string
  issueIdentifier: string
  action: Extract<
    CleanupMutationAction,
    'expired_lock_promote' | 'stale_lock_release'
  >
  reason: Extract<
    CleanupMutationReason,
    'expired_issue_lock' | 'stale_issue_lock'
  >
}

/** Optional composing policy for issue-lock maintenance mutations. */
export interface IssueLockCleanupCallbacks {
  beforeMutation?: BeforeCleanupMutation
  onRefused?: (
    candidate: IssueLockCleanupCandidate,
    decision: Extract<CleanupMutationDecision, { permitted: false }>
  ) => void
}

async function issueLockCleanupPermitted(
  callbacks: IssueLockCleanupCallbacks | undefined,
  candidate: IssueLockCleanupCandidate
): Promise<boolean> {
  if (!callbacks?.beforeMutation) return true

  const decision = candidate.session
    ? await evaluateCleanupMutationPolicy(callbacks.beforeMutation, {
        session: candidate.session,
        action: candidate.action,
        reason: candidate.reason,
        now: Date.now(),
      })
    : {
        permitted: false as const,
        code: 'pre_mutation_candidate_unresolved',
        detail: 'candidate session state is unavailable',
      }

  if (decision.permitted) return true

  try {
    callbacks.onRefused?.(candidate, decision)
  } catch (err) {
    log.warn('Issue-lock cleanup refusal callback failed', {
      sessionId: candidate.sessionId,
      action: candidate.action,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return false
}

/**
 * Acquire an issue-level lock.
 * Uses SET NX for atomicity -- only one caller wins.
 *
 * @returns true if lock was acquired
 */
export async function acquireIssueLock(
  issueId: string,
  lock: IssueLock
): Promise<boolean> {
  if (!isRedisConfigured()) {
    return true // No Redis = no locking, pass through
  }

  try {
    const key = `${LOCK_PREFIX}${issueId}`
    const acquired = await redisSetNX(key, JSON.stringify(lock), LOCK_TTL_SECONDS)

    if (acquired) {
      log.info('Issue lock acquired', {
        issueId,
        sessionId: lock.sessionId,
        workType: lock.workType,
        issueIdentifier: lock.issueIdentifier,
      })
    } else {
      log.debug('Issue lock not acquired (already held)', {
        issueId,
        sessionId: lock.sessionId,
      })
    }

    return acquired
  } catch (error) {
    log.error('Failed to acquire issue lock', { error, issueId })
    return false
  }
}

/**
 * Read the current lock for an issue.
 */
export async function getIssueLock(issueId: string): Promise<IssueLock | null> {
  if (!isRedisConfigured()) return null

  try {
    const key = `${LOCK_PREFIX}${issueId}`
    // redisSetNX stores the raw JSON string; redisGet parses it back
    // Since redisSetNX stores JSON.stringify(lock), redisGet returns the parsed lock directly
    return await redisGet<IssueLock>(key)
  } catch (error) {
    log.error('Failed to get issue lock', { error, issueId })
    return null
  }
}

/**
 * Release an issue lock. Idempotent.
 */
export async function releaseIssueLock(issueId: string): Promise<void> {
  if (!isRedisConfigured()) return

  try {
    const key = `${LOCK_PREFIX}${issueId}`
    await redisDel(key)
    log.info('Issue lock released', { issueId })
  } catch (error) {
    log.error('Failed to release issue lock', { error, issueId })
  }
}

/**
 * Refresh the TTL on an issue lock (extend while agent is alive).
 */
export async function refreshIssueLockTTL(
  issueId: string,
  ttlSeconds: number = LOCK_TTL_SECONDS
): Promise<boolean> {
  if (!isRedisConfigured()) return false

  try {
    const key = `${LOCK_PREFIX}${issueId}`
    return await redisExpire(key, ttlSeconds)
  } catch (error) {
    log.error('Failed to refresh issue lock TTL', { error, issueId })
    return false
  }
}

/**
 * Park work for a locked issue.
 *
 * Deduplication: at most one parked item per workType per issue.
 * If a parked item with the same workType already exists, it's replaced
 * (the latest webhook wins). Different workTypes can coexist.
 */
export async function parkWorkForIssue(
  issueId: string,
  work: QueuedWork
): Promise<{ parked: boolean; replaced: boolean }> {
  if (!isRedisConfigured()) {
    return { parked: false, replaced: false }
  }

  try {
    const pendingKey = `${PENDING_PREFIX}${issueId}`
    const itemsKey = `${PENDING_ITEMS_PREFIX}${issueId}`
    const workType = work.workType || 'development'

    // Dedup key: use workType as the sorted set member
    // This means at most one pending item per workType
    const dedupMember = workType

    // Check if there's already a parked item with this workType
    const existing = await redisHGet(itemsKey, dedupMember)
    const replaced = !!existing

    if (replaced) {
      // Remove old entry from sorted set before adding new one
      await redisZRem(pendingKey, dedupMember)
      log.info('Replacing existing parked work', {
        issueId,
        workType,
        sessionId: work.sessionId,
      })
    }

    // Score = priority (lower = higher priority)
    const score = work.priority

    // Add to sorted set and hash
    await redisZAdd(pendingKey, score, dedupMember)
    await redisHSet(itemsKey, dedupMember, JSON.stringify(work))

    // Set TTL on both keys
    await redisExpire(pendingKey, PENDING_TTL_SECONDS)
    await redisExpire(itemsKey, PENDING_TTL_SECONDS)

    log.info('Work parked for issue', {
      issueId,
      workType,
      sessionId: work.sessionId,
      priority: work.priority,
      replaced,
    })

    return { parked: true, replaced }
  } catch (error) {
    log.error('Failed to park work for issue', { error, issueId })
    return { parked: false, replaced: false }
  }
}

/**
 * Promote the next pending work item for an issue.
 * Pops the highest-priority item, acquires the issue lock for it,
 * and queues it in the global work queue.
 *
 * @returns The promoted work item, or null if nothing to promote
 */
export async function promoteNextPendingWork(
  issueId: string,
  cleanupCallbacks?: IssueLockCleanupCallbacks
): Promise<QueuedWork | null> {
  if (!isRedisConfigured()) return null

  try {
    const pendingKey = `${PENDING_PREFIX}${issueId}`
    const itemsKey = `${PENDING_ITEMS_PREFIX}${issueId}`

    let dedupMember: string
    if (cleanupCallbacks?.beforeMutation) {
      // Inspect without mutating so policy can run before the exact candidate's
      // first write. Removal below compares the hash bytes atomically, avoiding
      // authorization of one same-workType item followed by removal of another.
      const pendingMembers = await redisZRangeByScore(
        pendingKey,
        '-inf',
        '+inf',
        1
      )
      if (pendingMembers.length === 0) {
        log.debug('No pending work to promote', { issueId })
        return null
      }
      dedupMember = pendingMembers[0]
    } else {
      // Preserve the original atomic pop for standalone callers without a
      // composing policy.
      const popped = await redisZPopMin(pendingKey)
      if (!popped) {
        log.debug('No pending work to promote', { issueId })
        return null
      }
      dedupMember = popped.member
    }

    // Get the work item from the hash
    const workJson = await redisHGet(itemsKey, dedupMember)
    if (!workJson) {
      log.warn('Pending work item not found in hash', { issueId, dedupMember })
      return null
    }

    const work = JSON.parse(workJson) as QueuedWork

    if (cleanupCallbacks?.beforeMutation) {
      const session = await getSessionState(work.sessionId)
      const permitted = await issueLockCleanupPermitted(cleanupCallbacks, {
        session: session ?? undefined,
        sessionId: work.sessionId,
        issueId,
        issueIdentifier: work.issueIdentifier,
        action: 'expired_lock_promote',
        reason: 'expired_issue_lock',
      })
      if (!permitted) return null

      const removed = await redisCompareAndRemoveSortedHashMember(
        pendingKey,
        itemsKey,
        dedupMember,
        workJson
      )
      if (!removed) {
        log.debug('Pending work changed before authorized promotion', {
          issueId,
          dedupMember,
        })
        return null
      }
    } else {
      // The standalone path already popped from the sorted set above.
      await redisHDel(itemsKey, dedupMember)
    }

    // Acquire the issue lock for this promoted work
    const lock: IssueLock = {
      sessionId: work.sessionId,
      workType: work.workType || 'development',
      workerId: null,
      lockedAt: Date.now(),
      issueIdentifier: work.issueIdentifier,
    }

    const acquired = await acquireIssueLock(issueId, lock)
    if (!acquired) {
      log.warn('Failed to acquire lock for promoted work -- another lock appeared', {
        issueId,
        sessionId: work.sessionId,
      })
      // Re-park the work since we couldn't acquire the lock
      await parkWorkForIssue(issueId, work)
      return null
    }

    // Queue in the global work queue
    const queued = await queueWork(work)
    if (!queued) {
      log.error('Failed to queue promoted work', { issueId, sessionId: work.sessionId })
      // Release the lock since we couldn't queue
      await releaseIssueLock(issueId)
      return null
    }

    log.info('Pending work promoted', {
      issueId,
      sessionId: work.sessionId,
      workType: work.workType,
      issueIdentifier: work.issueIdentifier,
    })

    return work
  } catch (error) {
    log.error('Failed to promote pending work', { error, issueId })
    return null
  }
}

/**
 * Get the count of pending work items for an issue.
 */
export async function getPendingWorkCount(issueId: string): Promise<number> {
  if (!isRedisConfigured()) return 0

  try {
    const pendingKey = `${PENDING_PREFIX}${issueId}`
    return await redisZCard(pendingKey)
  } catch (error) {
    log.error('Failed to get pending work count', { error, issueId })
    return 0
  }
}

/**
 * Main entry point for dispatching work.
 *
 * Try to acquire the issue lock:
 * - If acquired -> queue the work in the global queue
 * - If locked -> park the work in the per-issue pending queue
 *
 * @returns DispatchResult indicating what happened
 */
export async function dispatchWork(work: QueuedWork): Promise<DispatchResult> {
  if (!isRedisConfigured()) {
    // No Redis -- fall back to direct queueing (no locking)
    const queued = await queueWork(work)
    return { dispatched: queued, parked: false, replaced: false }
  }

  const issueId = work.issueId

  // Try to acquire the issue lock
  const lock: IssueLock = {
    sessionId: work.sessionId,
    workType: work.workType || 'development',
    workerId: null,
    lockedAt: Date.now(),
    issueIdentifier: work.issueIdentifier,
  }

  const acquired = await acquireIssueLock(issueId, lock)

  if (acquired) {
    // Lock acquired -- dispatch to global queue
    const queued = await queueWork(work)
    if (!queued) {
      // Failed to queue -- release the lock
      await releaseIssueLock(issueId)
      return { dispatched: false, parked: false, replaced: false }
    }

    log.info('Work dispatched (lock acquired)', {
      issueId,
      sessionId: work.sessionId,
      workType: work.workType,
      issueIdentifier: work.issueIdentifier,
    })

    return { dispatched: true, parked: false, replaced: false }
  }

  // Lock held by another session -- park this work
  const { parked, replaced } = await parkWorkForIssue(issueId, work)

  if (parked) {
    log.info('Work parked (issue locked)', {
      issueId,
      sessionId: work.sessionId,
      workType: work.workType,
      replaced,
    })
  }

  return { dispatched: false, parked, replaced }
}

/**
 * Remove a parked work item by sessionId.
 *
 * The issue-pending hash is keyed by workType, so we scan all entries
 * to find the one matching the given sessionId.
 *
 * @returns true if a matching parked item was found and removed
 */
export async function removeParkedWorkBySessionId(
  issueId: string,
  sessionId: string
): Promise<boolean> {
  if (!isRedisConfigured()) return false

  try {
    const pendingKey = `${PENDING_PREFIX}${issueId}`
    const itemsKey = `${PENDING_ITEMS_PREFIX}${issueId}`

    // Get all entries in the hash (keyed by workType)
    const entries = await redisHGetAll(itemsKey)
    if (!entries) return false

    for (const [dedupMember, workJson] of Object.entries(entries)) {
      try {
        const work = JSON.parse(workJson as string) as QueuedWork
        if (work.sessionId === sessionId) {
          // Found the matching entry -- remove from both sorted set and hash
          await redisZRem(pendingKey, dedupMember)
          await redisHDel(itemsKey, dedupMember)

          log.info('Removed parked work by sessionId', {
            issueId,
            sessionId,
            workType: dedupMember,
          })
          return true
        }
      } catch {
        // Skip malformed entries
        continue
      }
    }

    log.debug('No parked work found for sessionId', { issueId, sessionId })
    return false
  } catch (error) {
    log.error('Failed to remove parked work by sessionId', { error, issueId, sessionId })
    return false
  }
}

/**
 * Clear all parked work for an issue.
 *
 * Deletes both the pending sorted set and the items hash.
 * Used by the webhook handler on status changes to prevent stale parked work
 * from being promoted after the issue has moved to a new state.
 *
 * @returns The number of parked items that were cleared
 */
export async function clearAllParkedWork(issueId: string): Promise<number> {
  if (!isRedisConfigured()) return 0

  try {
    const pendingKey = `${PENDING_PREFIX}${issueId}`
    const itemsKey = `${PENDING_ITEMS_PREFIX}${issueId}`

    // Count items before clearing
    const count = await redisZCard(pendingKey)

    if (count === 0) {
      return 0
    }

    // Delete both keys
    await redisDel(pendingKey)
    await redisDel(itemsKey)

    log.info('Cleared all parked work for issue', { issueId, clearedCount: count })
    return count
  } catch (error) {
    log.error('Failed to clear all parked work', { error, issueId })
    return 0
  }
}

/**
 * Check if a session is parked in any issue-pending queue.
 *
 * Scans the issue:pending:items:{issueId} hash entries for a matching sessionId.
 *
 * @param issueId - The issue to check
 * @param sessionId - The session to look for
 * @returns true if the session is parked for this issue
 */
export async function isSessionParkedForIssue(
  issueId: string,
  sessionId: string
): Promise<boolean> {
  if (!isRedisConfigured()) return false

  try {
    const itemsKey = `${PENDING_ITEMS_PREFIX}${issueId}`
    const entries = await redisHGetAll(itemsKey)
    if (!entries) return false

    for (const workJson of Object.values(entries)) {
      try {
        const work = JSON.parse(workJson as string) as QueuedWork
        if (work.sessionId === sessionId) {
          return true
        }
      } catch {
        continue
      }
    }

    return false
  } catch (error) {
    log.error('Failed to check if session is parked', { error, issueId, sessionId })
    return false
  }
}

/**
 * Scan for expired issue locks that have pending work.
 * If a lock expired naturally (TTL) but pending items remain, promote them.
 *
 * Called from orphan-cleanup to handle crashed workers that didn't release locks.
 */
export async function cleanupExpiredLocksWithPendingWork(
  cleanupCallbacks?: IssueLockCleanupCallbacks
): Promise<number> {
  if (!isRedisConfigured()) return 0

  let promoted = 0

  try {
    // Find all pending queues
    const pendingKeys = await redisKeys(`${PENDING_PREFIX}*`)

    for (const pendingKey of pendingKeys) {
      // Extract issueId from key
      const issueId = pendingKey.replace(PENDING_PREFIX, '')

      // Skip keys that are actually issue:pending:items:* hashes (not sorted sets)
      if (issueId.includes(':')) continue

      // Check if lock still exists
      const lockKey = `${LOCK_PREFIX}${issueId}`
      const lock = await redisGet(lockKey)

      if (!lock) {
        // Lock expired but pending work exists -- promote
        const count = await redisZCard(pendingKey)
        if (count > 0) {
          log.info('Found expired lock with pending work, promoting', {
            issueId,
            pendingCount: count,
          })

          const work = await promoteNextPendingWork(issueId, cleanupCallbacks)
          if (work) {
            promoted++
          }
        }
      }
    }

    if (promoted > 0) {
      log.info('Promoted pending work from expired locks', { promoted })
    }
  } catch (error) {
    log.error('Failed to cleanup expired locks', { error })
  }

  return promoted
}

// Statuses where a session should NOT be holding an issue lock.
// Terminal: session finished (completed/failed/stopped/timed_out) but lock release failed.
// Pending: session was reset by orphan cleanup but lock wasn't released (see orphan-cleanup.ts).
const STALE_LOCK_STATUSES = new Set(['completed', 'failed', 'stopped', 'timed_out', 'pending'])

/**
 * Startup grace window for a `pending` lock holder.
 *
 * A freshly-dispatched session — especially an on-demand / CLOUD one whose
 * in-box runner is still provisioning + booting its sandbox — legitimately sits
 * in `pending` while holding its issue lock. It only flips to `running` once the
 * runner boots and claims the work. Releasing its lock during that window hands
 * the issue to another worker and makes the still-booting runner lose ownership
 * mid-boot: its next heartbeat sees the lost lock (`runtime/heartbeat: session
 * ownership lost`) and the agent aborts. The observed symptom is the stale-lock
 * sweep reaping a legitimately-held lock at `lockAge=0` because the session had
 * not yet left `pending`.
 *
 * So a `pending` holder is treated as still-needing-its-lock until its lock is
 * OLDER than this window. TERMINAL holders (completed/failed/stopped/timed_out)
 * are unaffected — they release immediately, as before.
 *
 * SIZING — this grace must cover dispatch→first-activity, NOT just boot.
 * `lock.lockedAt` is stamped ONCE at DISPATCH (see dispatchWork /
 * promoteNextPendingWork) and is never reset afterwards — not by register, not by
 * claim, not by the status='running' POST, and not by the heartbeat TTL refresh
 * (refreshIssueLockTTL only calls redisExpire) — so this grace clock runs from
 * dispatch. The platform provisioner mints the on-demand worker registration token
 * with a ~10-minute TTL ("enough time to boot + register"), but that is only the
 * BOOT budget. The pending→running flip does not fire until the runner's FIRST
 * successful activity POST, and reaching that point additionally requires: E2B box
 * provision, repo clone, kit toolchain install (e.g. pnpm install on a large repo),
 * Claude cold start, and the agent's first turn. If this grace equalled the 10-min
 * boot budget, a run whose boot consumed most of that allowance would be reaped
 * before first activity. Such a reap is NOT unconditionally terminal: the platform
 * heartbeat lock-refresh's re-acquire branch (lock-refresh/route.ts) DOES include
 * 'pending' in its allow-list (alongside claimed/running/finalizing) and re-stamps
 * lockedAt via acquireIssueLock — but that acquire is a SET NX, so it only fires
 * when the lock is FREE. A reaped pending lock is therefore recoverable on the very
 * next heartbeat UNLESS a parked sibling was promoted into the freed slot first, in
 * which case the SET NX fails and the reap IS terminal (the next heartbeat sees the
 * lost lock and the agent aborts with "session ownership lost" mid-boot). Sizing the
 * grace generously means we never lean on that recovery race, so we size it to the
 * boot budget PLUS a generous post-register first-activity budget.
 *
 * This does NOT weaken genuine orphan cleanup: a truly-orphaned pending session
 * (whose explicit lock release in orphan-cleanup.ts failed) carries a lock far
 * older than this window and is STILL reaped here; the lock's 2h TTL remains the
 * hard backstop. The only cost of the larger window is that a genuinely-dead
 * pending holder waits longer for PROACTIVE cleanup before the TTL expires.
 *
 * FOLLOWUP (more-correct variant, deferred — not a single-package change): stamp a
 * separate boot-deadline field (or reset lockedAt) when the box first
 * registers/heartbeats, so the grace keys off boot-complete rather than a fixed
 * dispatch+budget. That needs a register/heartbeat hook wired through the platform
 * lock-refresh route (cross-repo) and would break genuine orphan cleanup unless it
 * fires exactly once, so it is out of scope for this minimal sizing fix.
 *
 * WARNING for that followup: any boot-deadline/lockedAt reset MUST be gated to a
 * fire-once, lock-free / first-register condition (e.g. the SET NX re-acquire branch
 * in lock-refresh/route.ts, which only fires on a FREE lock). It must NOT be added to
 * the steady-state refresh-TTL branch (the `existing?.sessionId === sessionId` path
 * that only calls redisExpire). A stuck-`pending` session heartbeats on that branch
 * every ~30s while still holding its own lock; re-stamping lockedAt there would reset
 * the grace clock on every heartbeat, so this reaper's pending-grace check would never
 * fire and the session would indefinitely defer its own reap until the 2h TTL backstop.
 */
const PENDING_LOCK_STARTUP_GRACE_MS = 25 * 60 * 1000 // boot budget (~10 min) + post-register first-activity budget

/**
 * Release issue locks held by sessions that should no longer hold them.
 *
 * This handles cases where:
 * - A session completes but the lock release failed (network error during cleanup)
 * - Orphan cleanup resets a session to 'pending' but the lock wasn't released
 *
 * The lock's 2-hour TTL would eventually expire, but this proactively clears it
 * when workers have idle capacity.
 *
 * Only runs when workers are online -- if no workers are available, there's no
 * point promoting parked work since nothing can pick it up.
 *
 * @param hasIdleWorkers - true if at least one worker is online with spare capacity
 * @returns Number of stale locks released and parked work promoted
 */
export async function cleanupStaleLocksWithIdleWorkers(
  hasIdleWorkers: boolean,
  cleanupCallbacks?: IssueLockCleanupCallbacks
): Promise<number> {
  if (!isRedisConfigured()) return 0
  if (!hasIdleWorkers) return 0

  let promoted = 0

  try {
    // Find all issue locks
    const lockKeys = await redisKeys(`${LOCK_PREFIX}*`)

    for (const lockKey of lockKeys) {
      const issueId = lockKey.replace(LOCK_PREFIX, '')
      // Skip keys that look like pending queue keys (contain extra colons)
      if (issueId.includes(':')) continue

      const lock = await redisGet<IssueLock>(lockKey)
      if (!lock) continue

      // Check if the lock holder's session is in a terminal state
      const session = await getSessionState(lock.sessionId)
      if (!session) {
        const permitted = await issueLockCleanupPermitted(cleanupCallbacks, {
          sessionId: lock.sessionId,
          issueId,
          issueIdentifier: lock.issueIdentifier,
          action: 'stale_lock_release',
          reason: 'stale_issue_lock',
        })
        if (!permitted) continue

        // Session expired from Redis (24h TTL) but lock remains (2h TTL)
        // Safe to release -- the session is long gone
        log.info('Releasing lock for expired session', {
          issueId,
          sessionId: lock.sessionId,
          issueIdentifier: lock.issueIdentifier,
        })
        await releaseIssueLock(issueId)
        const work = await promoteNextPendingWork(issueId, cleanupCallbacks)
        if (work) promoted++
        continue
      }

      if (STALE_LOCK_STATUSES.has(session.status)) {
        // A `pending` holder in its normal startup window still needs its lock:
        // a cloud runner is still provisioning + booting before it flips the
        // session to `running` and claims. Only reap a `pending` lock once it is
        // OLDER than the startup grace budget — a genuinely-orphaned pending
        // session's lock is far older than this and is still reaped below. This
        // is the fix for the cloud pending→running startup window; terminal
        // holders deliberately skip the grace and release immediately.
        const lockAgeMs = Date.now() - lock.lockedAt
        if (
          session.status === 'pending' &&
          lockAgeMs < PENDING_LOCK_STARTUP_GRACE_MS
        ) {
          log.debug(
            'Skipping stale-lock release: pending session within startup grace',
            {
              issueId,
              sessionId: lock.sessionId,
              issueIdentifier: lock.issueIdentifier,
              lockAgeMs,
              graceMs: PENDING_LOCK_STARTUP_GRACE_MS,
            }
          )
          continue
        }

        const permitted = await issueLockCleanupPermitted(cleanupCallbacks, {
          session,
          sessionId: lock.sessionId,
          issueId,
          issueIdentifier: lock.issueIdentifier,
          action: 'stale_lock_release',
          reason: 'stale_issue_lock',
        })
        if (!permitted) continue

        log.info('Releasing stale lock (session no longer needs lock)', {
          issueId,
          sessionId: lock.sessionId,
          sessionStatus: session.status,
          issueIdentifier: lock.issueIdentifier,
          lockAge: Math.round((Date.now() - lock.lockedAt) / 1000),
        })

        await releaseIssueLock(issueId)
        const work = await promoteNextPendingWork(issueId, cleanupCallbacks)
        if (work) {
          promoted++
          log.info('Promoted parked work after stale lock cleanup', {
            issueId,
            promotedSessionId: work.sessionId,
            promotedWorkType: work.workType,
          })
        }
      }
    }

    if (promoted > 0) {
      log.info('Promoted parked work from stale locks', { promoted })
    }
  } catch (error) {
    log.error('Failed to cleanup stale locks', { error })
  }

  return promoted
}
