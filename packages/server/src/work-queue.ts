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
  redisDel,
  redisGet,
  redisEval,
  redisZAdd,
  redisZRem,
  redisZRangeByScore,
  redisZCard,
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
export const WORK_CLAIM_PREFIX = 'work:claim:'
export const WORK_RECONCILIATION_TOMBSTONE_PREFIX = 'work:reconciliation:'

// Legacy key for migration
const LEGACY_QUEUE_KEY = 'work:queue:legacy'

// Default TTL for work claims (1 hour)
const WORK_CLAIM_TTL = parseInt(process.env.WORK_CLAIM_TTL ?? '3600', 10)

/**
 * A reconciliation tombstone is an opaque, caller-owned generation that makes
 * every later claim for the same work item fail closed. The caller supplies
 * the TTL because this package does not own admission lifetime policy; it must
 * be at least as long as the admission lifetime that could produce the work.
 */
export interface WorkReconciliationTombstone {
  generation: string
  ttlSeconds: number
}

/** Successful work-claim receipt. */
export interface WorkClaimReceipt {
  status: 'claimed'
  sessionId: string
  workerId: string
  work: QueuedWork
}

/** A claim rejected by a durable reconciliation tombstone. */
export interface WorkClaimRefusedReconciled {
  status: 'claim_refused_reconciled'
  sessionId: string
  reconciliationGeneration: string | null
}

/** A claim that could not acquire an available queue item. */
export interface WorkClaimUnavailable {
  status: 'claim_unavailable'
  sessionId: string
}

/** Typed outcome for consumers that must distinguish reconciliation refusal. */
export type WorkClaimResult =
  | WorkClaimReceipt
  | WorkClaimRefusedReconciled
  | WorkClaimUnavailable

/** Successful durable reconciliation receipt. */
export interface WorkReconciliationReceipt {
  status: 'reconcile_tombstone_written' | 'reconcile_tombstone_exists'
  sessionId: string
  generation: string | null
}

/** Reconciliation lost the race to a worker claim. */
export interface WorkReconciliationRefusedClaimed {
  status: 'reconcile_refused_claimed'
  sessionId: string
  workerId: string
}

/** Reconciliation attempted to reuse a session ID with another generation. */
export interface WorkReconciliationGenerationConflict {
  status: 'reconcile_generation_conflict'
  sessionId: string
  generation: string | null
}

/** Reconciliation could not reach the work queue's durable store. */
export interface WorkReconciliationUnavailable {
  status: 'reconcile_unavailable'
  sessionId: string
}

/** Typed outcome for recording a reconciliation tombstone. */
export type WorkReconciliationResult =
  | WorkReconciliationReceipt
  | WorkReconciliationRefusedClaimed
  | WorkReconciliationGenerationConflict
  | WorkReconciliationUnavailable

type LuaTuple = [string, ...string[]]

const CLAIM_WORK_SCRIPT = `
local tombstone = redis.call('GET', KEYS[2])
if tombstone then
  -- A delayed producer can requeue work after reconciliation. Remove only the
  -- stale queue artifacts; the tombstone remains the durable refusal record.
  redis.call('ZREM', KEYS[4], ARGV[3])
  redis.call('HDEL', KEYS[3], ARGV[3])
  return {'claim_refused_reconciled', tombstone}
end

if redis.call('EXISTS', KEYS[1]) == 1 then
  return {'claim_unavailable'}
end

local item = redis.call('HGET', KEYS[3], ARGV[3])
if not item then
  return {'claim_unavailable'}
end

if not redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then
  return {'claim_unavailable'}
end

if redis.call('ZREM', KEYS[4], ARGV[3]) ~= 1 then
  redis.call('DEL', KEYS[1])
  return {'claim_unavailable'}
end

redis.call('HDEL', KEYS[3], ARGV[3])
return {'claimed', item}
`

const POP_AND_CLAIM_WORK_SCRIPT = `
local sessionIds = redis.call('ZRANGE', KEYS[2], 0, 0)
if #sessionIds == 0 then
  return {'claim_unavailable'}
end

local sessionId = sessionIds[1]
local claimKey = ARGV[3] .. sessionId
local tombstoneKey = ARGV[4] .. sessionId
local tombstone = redis.call('GET', tombstoneKey)
if tombstone then
  redis.call('ZREM', KEYS[2], sessionId)
  redis.call('HDEL', KEYS[1], sessionId)
  return {'claim_refused_reconciled', tombstone, sessionId}
end

local item = redis.call('HGET', KEYS[1], sessionId)
if not item then
  redis.call('ZREM', KEYS[2], sessionId)
  return {'claim_unavailable', '', sessionId}
end

if redis.call('EXISTS', claimKey) == 1 then
  return {'claim_unavailable', '', sessionId}
end

if not redis.call('SET', claimKey, ARGV[1], 'NX', 'EX', ARGV[2]) then
  return {'claim_unavailable', '', sessionId}
end

if redis.call('ZREM', KEYS[2], sessionId) ~= 1 then
  redis.call('DEL', claimKey)
  return {'claim_unavailable', '', sessionId}
end

redis.call('HDEL', KEYS[1], sessionId)
return {'claimed', item, sessionId}
`

const RECONCILE_WORK_SCRIPT = `
local existing = redis.call('GET', KEYS[2])
if existing then
  if existing == ARGV[1] then
    local existingTtl = redis.call('TTL', KEYS[2])
    local requestedTtl = tonumber(ARGV[2])
    if existingTtl >= 0 and requestedTtl > existingTtl then
      redis.call('EXPIRE', KEYS[2], requestedTtl)
    end
    return {'reconcile_tombstone_exists', existing}
  end
  return {'reconcile_generation_conflict', existing}
end

local workerId = redis.call('GET', KEYS[1])
if workerId then
  return {'reconcile_refused_claimed', workerId}
end

redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
redis.call('ZREM', KEYS[4], ARGV[3])
redis.call('HDEL', KEYS[3], ARGV[3])
return {'reconcile_tombstone_written', ARGV[1]}
`

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

/** Build the Redis key that records a worker's active work claim. */
export function getWorkClaimKey(sessionId: string): string {
  return `${WORK_CLAIM_PREFIX}${sessionId}`
}

/** Build the Redis key for the durable per-work reconciliation tombstone. */
export function getWorkReconciliationTombstoneKey(sessionId: string): string {
  return `${WORK_RECONCILIATION_TOMBSTONE_PREFIX}${sessionId}`
}

function asLuaTuple(result: unknown): LuaTuple | null {
  if (!Array.isArray(result) || result.length === 0 || typeof result[0] !== 'string') {
    return null
  }
  if (!result.every(value => typeof value === 'string')) {
    return null
  }
  return result as LuaTuple
}

function readTombstoneGeneration(serialized: string | undefined): string | null {
  if (!serialized) return null
  try {
    const parsed = JSON.parse(serialized) as { generation?: unknown }
    return typeof parsed.generation === 'string' ? parsed.generation : null
  } catch {
    // A malformed tombstone must still fail claims closed; callers receive a
    // null generation rather than treating corrupted durable state as absent.
    return null
  }
}

function decodeClaimResult(
  rawResult: unknown,
  workerId: string,
  fallbackSessionId?: string
): WorkClaimResult {
  const result = asLuaTuple(rawResult)
  const sessionId = fallbackSessionId ?? result?.[2] ?? ''

  if (!result) {
    return { status: 'claim_unavailable', sessionId }
  }

  if (result[0] === 'claim_refused_reconciled') {
    return {
      status: 'claim_refused_reconciled',
      sessionId,
      reconciliationGeneration: readTombstoneGeneration(result[1]),
    }
  }

  if (result[0] !== 'claimed' || !result[1]) {
    return { status: 'claim_unavailable', sessionId }
  }

  try {
    const work = JSON.parse(result[1]) as QueuedWork
    return { status: 'claimed', sessionId: work.sessionId, workerId, work }
  } catch (error) {
    log.error('Claim script returned invalid work JSON', {
      error,
      sessionId,
      workerId,
    })
    return { status: 'claim_unavailable', sessionId }
  }
}

function assertTombstoneInput(tombstone: WorkReconciliationTombstone): void {
  if (!tombstone.generation.trim()) {
    throw new Error('Reconciliation tombstone generation must be non-empty')
  }
  if (!Number.isSafeInteger(tombstone.ttlSeconds) || tombstone.ttlSeconds <= 0) {
    throw new Error('Reconciliation tombstone TTL must be a positive whole number of seconds')
  }
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
 * Atomically claim one named work item, refusing if reconciliation has already
 * recorded a durable tombstone. The Lua transition owns every claim mutation:
 * tombstone read, claim SET NX EX, and queue/hash removal happen in one Redis
 * command, so a reconciliation and claim cannot both win.
 */
export async function claimWorkWithReceipt(
  sessionId: string,
  workerId: string
): Promise<WorkClaimResult> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot claim work')
    return { status: 'claim_unavailable', sessionId }
  }

  try {
    const result = decodeClaimResult(
      await redisEval(
        CLAIM_WORK_SCRIPT,
        [
          getWorkClaimKey(sessionId),
          getWorkReconciliationTombstoneKey(sessionId),
          WORK_ITEMS_KEY,
          WORK_QUEUE_KEY,
        ],
        [workerId, WORK_CLAIM_TTL, sessionId]
      ),
      workerId,
      sessionId
    )

    if (result.status === 'claimed') {
      log.info('Work claimed', {
        sessionId,
        workerId,
        issueIdentifier: result.work.issueIdentifier,
      })
    } else if (result.status === 'claim_refused_reconciled') {
      log.warn('Work claim refused by reconciliation', {
        sessionId,
        workerId,
        reconciliationGeneration: result.reconciliationGeneration,
      })
    }

    return result
  } catch (error) {
    log.error('Failed to claim work', { error, sessionId, workerId })
    return { status: 'claim_unavailable', sessionId }
  }
}

/**
 * Backward-compatible claim helper for consumers that only need work or null.
 * It still uses the reconciliation-fenced Lua transition above.
 */
export async function claimWork(
  sessionId: string,
  workerId: string
): Promise<QueuedWork | null> {
  const result = await claimWorkWithReceipt(sessionId, workerId)
  return result.status === 'claimed' ? result.work : null
}

/**
 * Atomically select, reconcile-check, and claim the highest-priority work item.
 * The script deliberately removes delayed stale queue artifacts on a tombstone
 * refusal so a reconciled item cannot pin the head of the poll queue forever.
 */
export async function popAndClaimWorkWithReceipt(
  workerId: string
): Promise<WorkClaimResult> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot pop work')
    return { status: 'claim_unavailable', sessionId: '' }
  }

  try {
    const result = decodeClaimResult(
      await redisEval(
        POP_AND_CLAIM_WORK_SCRIPT,
        [WORK_ITEMS_KEY, WORK_QUEUE_KEY],
        [
          workerId,
          WORK_CLAIM_TTL,
          WORK_CLAIM_PREFIX,
          WORK_RECONCILIATION_TOMBSTONE_PREFIX,
        ]
      ),
      workerId
    )

    if (result.status === 'claimed') {
      log.info('Work popped and claimed', {
        sessionId: result.sessionId,
        workerId,
        issueIdentifier: result.work.issueIdentifier,
      })
    } else if (result.status === 'claim_refused_reconciled') {
      log.warn('Popped work claim refused by reconciliation', {
        sessionId: result.sessionId,
        workerId,
        reconciliationGeneration: result.reconciliationGeneration,
      })
    }

    return result
  } catch (error) {
    log.error('Failed to pop and claim work', { error, workerId })
    return { status: 'claim_unavailable', sessionId: '' }
  }
}

/**
 * Backward-compatible pop helper for consumers that only need work or null.
 * It still uses the reconciliation-fenced Lua transition above.
 */
export async function popAndClaimWork(
  workerId: string
): Promise<QueuedWork | null> {
  const result = await popAndClaimWorkWithReceipt(workerId)
  return result.status === 'claimed' ? result.work : null
}

/**
 * Atomically record a durable reconciliation tombstone and remove queued work.
 * If a worker claimed first, this returns its identity and does not write a
 * tombstone. If reconciliation wins, all later claim attempts return the typed
 * `claim_refused_reconciled` result until the caller-provided TTL expires.
 */
export async function reconcileWork(
  sessionId: string,
  tombstone: WorkReconciliationTombstone
): Promise<WorkReconciliationResult> {
  assertTombstoneInput(tombstone)

  if (!isRedisConfigured()) {
    return { status: 'reconcile_unavailable', sessionId }
  }

  const serializedTombstone = JSON.stringify({ generation: tombstone.generation })

  try {
    const tuple = asLuaTuple(
      await redisEval(
        RECONCILE_WORK_SCRIPT,
        [
          getWorkClaimKey(sessionId),
          getWorkReconciliationTombstoneKey(sessionId),
          WORK_ITEMS_KEY,
          WORK_QUEUE_KEY,
        ],
        [serializedTombstone, tombstone.ttlSeconds, sessionId]
      )
    )
    const existingGeneration = readTombstoneGeneration(tuple?.[1])

    if (tuple?.[0] === 'reconcile_tombstone_written' || tuple?.[0] === 'reconcile_tombstone_exists') {
      return {
        status: tuple[0],
        sessionId,
        generation: existingGeneration,
      }
    }
    if (tuple?.[0] === 'reconcile_refused_claimed' && tuple[1]) {
      return { status: 'reconcile_refused_claimed', sessionId, workerId: tuple[1] }
    }
    return {
      status: 'reconcile_generation_conflict',
      sessionId,
      generation: existingGeneration,
    }
  } catch (error) {
    log.error('Failed to reconcile work', { error, sessionId })
    return { status: 'reconcile_unavailable', sessionId }
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
