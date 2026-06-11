/**
 * Work Queue Module (Optimized)
 *
 * Manages the queue of pending agent work items in Redis.
 * Workers poll this queue to claim and process work.
 *
 * Data Structures (optimized for high concurrency):
 * - work:items (Hash): sessionId -> JSON work item - O(1) lookup
 * - work:queue (Sorted Set): score = priority, member = sessionId - O(log n) operations
 * - work:claim:{sessionId} (String): workerId with TTL - atomic claims
 *
 * Performance:
 * - queueWork: O(log n) - HSET + ZADD
 * - claimWork: O(log n) - SETNX + HGET + ZREM
 * - peekWork: O(log n + k) - ZRANGEBYSCORE + HMGET where k = limit
 * - getQueueLength: O(1) - ZCARD
 */

import {
  redisSetNX,
  redisDel,
  redisGet,
  redisZAdd,
  redisZRem,
  redisZRangeByScore,
  redisZCard,
  redisZPopMin,
  redisHSet,
  redisHGet,
  redisHDel,
  redisHMGet,
  redisHGetAll,
  isRedisConfigured,
  // Legacy list operations for migration
  redisLRange,
  redisLLen,
  redisLRem,
} from './redis.js'
import type { AgentWorkType } from './types.js'
import type { TenantEnvelope } from './jwt-envelope.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[work-queue] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[work-queue] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[work-queue] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// Redis key constants (exported for scheduling-queue.ts reuse)
export const WORK_QUEUE_KEY = 'work:queue' // Sorted set: priority queue
export const WORK_ITEMS_KEY = 'work:items' // Hash: sessionId -> work item
const WORK_CLAIM_PREFIX = 'work:claim:'

// Legacy key for migration
const LEGACY_QUEUE_KEY = 'work:queue:legacy'

// Default TTL for work claims (1 hour)
const WORK_CLAIM_TTL = parseInt(process.env.WORK_CLAIM_TTL ?? '3600', 10)

/**
 * Type of work being performed
 * @deprecated Use AgentWorkType from './types.js' instead
 */
export type WorkType = AgentWorkType

/**
 * Work item stored in the queue
 */
export interface QueuedWork {
  sessionId: string
  issueId: string
  issueIdentifier: string
  priority: number // 1-5, lower is higher priority
  queuedAt: number // Unix timestamp
  prompt?: string // For follow-up prompts
  providerSessionId?: string // For resuming sessions
  workType?: AgentWorkType // Type of work (defaults to 'development')
  sourceSessionId?: string // For QA: the dev session that completed this work
  projectName?: string // Linear project name, for worker routing
  /** Model override for the primary agent (e.g., 'claude-sonnet-4-6'). Highest priority in resolution cascade. */
  model?: string
  /** Model override for Task sub-agents spawned by coordinators (e.g., 'claude-sonnet-4-6') */
  subAgentModel?: string
  /**
   * Tenant envelope injected at enqueue time (/ ADR Decision 6).
   * Workers re-verify the JWT on consume and reject jobs whose `org` claim
   * does not match their registration.  Optional during the rollout window —
   * deployments without a configured trust anchor leave this undefined and
   * fall back to the legacy WORKER_API_KEY path.
   */
  tenantEnvelope?: TenantEnvelope
}

/**
 * Calculate priority score for sorted set
 * Lower scores = higher priority (processed first)
 * Score = (priority * 1e13) + timestamp
 * This ensures priority is the primary sort key, timestamp is secondary
 */
export function calculateScore(priority: number, queuedAt: number): number {
  // Clamp priority to 1-9 to ensure score calculation works correctly
  const clampedPriority = Math.max(1, Math.min(9, priority))
  // Use 1e13 multiplier to leave room for timestamps up to year ~2286
  return clampedPriority * 1e13 + queuedAt
}

/**
 * Add work to the queue
 *
 * @param work - Work item to queue
 * @returns true if queued successfully
 */
export async function queueWork(work: QueuedWork): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot queue work')
    return false
  }

  try {
    const score = calculateScore(work.priority, work.queuedAt)
    const serialized = JSON.stringify(work)

    // Store work item in hash (O(1) lookup)
    await redisHSet(WORK_ITEMS_KEY, work.sessionId, serialized)

    // Add to priority queue (O(log n))
    await redisZAdd(WORK_QUEUE_KEY, score, work.sessionId)

    log.info('Work queued', {
      sessionId: work.sessionId,
      issueIdentifier: work.issueIdentifier,
      priority: work.priority,
      score,
    })

    return true
  } catch (error) {
    log.error('Failed to queue work', { error, sessionId: work.sessionId })
    return false
  }
}

/**
 * Peek at pending work without removing from queue
 * Returns items sorted by priority (lowest number = highest priority)
 *
 * @param limit - Maximum number of items to return
 * @returns Array of work items sorted by priority
 */
export async function peekWork(limit: number = 10): Promise<QueuedWork[]> {
  if (!isRedisConfigured()) {
    return []
  }

  try {
    // Get session IDs from priority queue (lowest scores first)
    const sessionIds = await redisZRangeByScore(
      WORK_QUEUE_KEY,
      '-inf',
      '+inf',
      limit
    )

    if (sessionIds.length === 0) {
      return []
    }

    // Batch fetch work items from hash
    const items = await redisHMGet(WORK_ITEMS_KEY, sessionIds)

    // Parse and filter out any missing items
    const result: QueuedWork[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item) {
        try {
          result.push(JSON.parse(item) as QueuedWork)
        } catch {
          log.warn('Failed to parse work item', { sessionId: sessionIds[i] })
        }
      }
    }

    return result
  } catch (error) {
    log.error('Failed to peek work queue', { error })
    return []
  }
}

/**
 * Get the number of items in the queue
 */
export async function getQueueLength(): Promise<number> {
  if (!isRedisConfigured()) {
    return 0
  }

  try {
    return await redisZCard(WORK_QUEUE_KEY)
  } catch (error) {
    log.error('Failed to get queue length', { error })
    return 0
  }
}

/**
 * Claim a work item for processing
 *
 * Uses SETNX for atomic claim to prevent race conditions.
 * O(log n) complexity for claim + remove operations.
 *
 * @param sessionId - Session ID to claim
 * @param workerId - Worker claiming the work
 * @returns The work item if claimed successfully, null otherwise
 */
export async function claimWork(
  sessionId: string,
  workerId: string
): Promise<QueuedWork | null> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot claim work')
    return null
  }

  const claimKey = `${WORK_CLAIM_PREFIX}${sessionId}`
  let claimAcquired = false

  try {
    // Try to atomically set the claim
    const claimed = await redisSetNX(claimKey, workerId, WORK_CLAIM_TTL)

    if (!claimed) {
      log.debug('Work already claimed', { sessionId, workerId })
      return null
    }

    claimAcquired = true

    // Get work item from hash (O(1))
    const itemJson = await redisHGet(WORK_ITEMS_KEY, sessionId)

    if (!itemJson) {
      // Work item not found - release the claim
      await redisDel(claimKey)
      claimAcquired = false
      log.warn('Work item not found in hash after claim', { sessionId })
      return null
    }

    const work = JSON.parse(itemJson) as QueuedWork

    // Remove from priority queue (O(log n))
    await redisZRem(WORK_QUEUE_KEY, sessionId)

    // Remove from items hash (O(1))
    await redisHDel(WORK_ITEMS_KEY, sessionId)

    log.info('Work claimed', {
      sessionId,
      workerId,
      issueIdentifier: work.issueIdentifier,
    })

    return work
  } catch (error) {
    // Release the claim key if we acquired it to prevent deadlock.
    // Without this, a transient Redis error after SETNX would leave the
    // claim key stuck for its full TTL (1 hour), blocking all workers
    // from claiming this work item while it remains in the queue.
    if (claimAcquired) {
      try {
        await redisDel(claimKey)
      } catch (cleanupError) {
        log.error('Failed to release claim during error cleanup', {
          cleanupError,
          sessionId,
        })
      }
    }
    log.error('Failed to claim work', { error, sessionId, workerId })
    return null
  }
}

/**
 * Atomically pop and claim a work item from the queue.
 *
 * Uses ZPOPMIN to atomically remove the highest-priority item, then sets
 * the claim key. This eliminates the peek-then-claim race where multiple
 * workers see and compete for the same item.
 *
 * @param workerId - Worker claiming the work
 * @returns The work item if popped and claimed, null if queue is empty
 */
export async function popAndClaimWork(
  workerId: string
): Promise<QueuedWork | null> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot pop work')
    return null
  }

  try {
    // Atomically pop the highest-priority item (lowest score)
    const popped = await redisZPopMin(WORK_QUEUE_KEY)
    if (!popped) {
      return null
    }

    const sessionId = popped.member

    // Get work item from hash
    const itemJson = await redisHGet(WORK_ITEMS_KEY, sessionId)
    if (!itemJson) {
      log.warn('Work item not found in hash after pop', { sessionId })
      return null
    }

    // Remove from items hash
    await redisHDel(WORK_ITEMS_KEY, sessionId)

    // Set claim key (atomic, but won't race since we already popped)
    const claimKey = `${WORK_CLAIM_PREFIX}${sessionId}`
    await redisSetNX(claimKey, workerId, WORK_CLAIM_TTL)

    const work = JSON.parse(itemJson) as QueuedWork

    log.info('Work popped and claimed', {
      sessionId,
      workerId,
      issueIdentifier: work.issueIdentifier,
    })

    return work
  } catch (error) {
    log.error('Failed to pop and claim work', { error, workerId })
    return null
  }
}

/**
 * Release a work claim (e.g., on failure or cancellation)
 *
 * @param sessionId - Session ID to release
 * @returns true if released successfully
 */
export async function releaseClaim(sessionId: string): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  try {
    const claimKey = `${WORK_CLAIM_PREFIX}${sessionId}`
    const deleted = await redisDel(claimKey)
    return deleted > 0
  } catch (error) {
    log.error('Failed to release claim', { error, sessionId })
    return false
  }
}

/**
 * Check which worker has claimed a session
 *
 * @param sessionId - Session ID to check
 * @returns Worker ID if claimed, null otherwise
 */
export async function getClaimOwner(sessionId: string): Promise<string | null> {
  if (!isRedisConfigured()) {
    return null
  }

  try {
    const claimKey = `${WORK_CLAIM_PREFIX}${sessionId}`
    return await redisGet<string>(claimKey)
  } catch (error) {
    log.error('Failed to get claim owner', { error, sessionId })
    return null
  }
}

/**
 * Check if a session has an entry in the work queue.
 * O(1) check via the work items hash.
 *
 * @param sessionId - Session ID to check
 * @returns true if the session is present in the work queue
 */
export async function isSessionInQueue(sessionId: string): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  try {
    const item = await redisHGet(WORK_ITEMS_KEY, sessionId)
    return item !== null
  } catch (error) {
    log.error('Failed to check if session is in queue', { error, sessionId })
    return false
  }
}

/**
 * Re-queue work that failed or was abandoned
 *
 * @param work - Work item to re-queue
 * @param priorityBoost - Decrease priority number (higher priority) by this amount
 * @returns true if re-queued successfully
 */
export async function requeueWork(
  work: QueuedWork,
  priorityBoost: number = 1
): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  try {
    // Release any existing claim
    await releaseClaim(work.sessionId)

    // Boost priority (lower number = higher priority)
    const newPriority = Math.max(1, work.priority - priorityBoost)

    // Re-queue with updated priority and timestamp
    const updatedWork: QueuedWork = {
      ...work,
      priority: newPriority,
      queuedAt: Date.now(),
    }

    return await queueWork(updatedWork)
  } catch (error) {
    log.error('Failed to requeue work', { error, sessionId: work.sessionId })
    return false
  }
}

/**
 * Get all pending work items (for dashboard/monitoring)
 * Returns items sorted by priority
 */
export async function getAllPendingWork(): Promise<QueuedWork[]> {
  if (!isRedisConfigured()) {
    return []
  }

  try {
    // Get all session IDs from priority queue
    const sessionIds = await redisZRangeByScore(WORK_QUEUE_KEY, '-inf', '+inf')

    if (sessionIds.length === 0) {
      return []
    }

    // Batch fetch all work items
    const items = await redisHMGet(WORK_ITEMS_KEY, sessionIds)

    const result: QueuedWork[] = []
    for (const item of items) {
      if (item) {
        try {
          result.push(JSON.parse(item) as QueuedWork)
        } catch {
          // Skip invalid items
        }
      }
    }

    return result
  } catch (error) {
    log.error('Failed to get all pending work', { error })
    return []
  }
}

/**
 * Remove a work item from queue (without claiming)
 * Used for cleanup operations
 *
 * @param sessionId - Session ID to remove
 * @returns true if removed
 */
export async function removeFromQueue(sessionId: string): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  try {
    // Remove from both data structures
    await redisZRem(WORK_QUEUE_KEY, sessionId)
    await redisHDel(WORK_ITEMS_KEY, sessionId)
    return true
  } catch (error) {
    log.error('Failed to remove from queue', { error, sessionId })
    return false
  }
}

/**
 * Migrate data from legacy list-based queue to new sorted set/hash structure
 * Run this once after deployment to migrate existing data
 */
export async function migrateFromLegacyQueue(): Promise<{
  migrated: number
  failed: number
}> {
  if (!isRedisConfigured()) {
    return { migrated: 0, failed: 0 }
  }

  let migrated = 0
  let failed = 0

  try {
    // Check if there's data in the legacy queue (same key, but was a list)
    // Try to read as list first
    const legacyItems = await redisLRange(WORK_QUEUE_KEY, 0, -1)

    if (legacyItems.length === 0) {
      log.info('No legacy queue data to migrate')
      return { migrated: 0, failed: 0 }
    }

    log.info('Migrating legacy queue data', { itemCount: legacyItems.length })

    for (const itemJson of legacyItems) {
      try {
        const work = JSON.parse(itemJson) as QueuedWork

        // Add to new data structures
        const score = calculateScore(work.priority, work.queuedAt)
        await redisHSet(WORK_ITEMS_KEY, work.sessionId, itemJson)
        await redisZAdd(WORK_QUEUE_KEY, score, work.sessionId)

        // Remove from legacy list
        await redisLRem(WORK_QUEUE_KEY, 1, itemJson)

        migrated++
      } catch (err) {
        log.warn('Failed to migrate work item', { error: err, itemJson })
        failed++
      }
    }

    log.info('Legacy queue migration complete', { migrated, failed })
  } catch (error) {
    // This might fail if the key doesn't exist as a list (already migrated)
    log.debug('No legacy queue to migrate or already migrated', { error })
  }

  return { migrated, failed }
}
