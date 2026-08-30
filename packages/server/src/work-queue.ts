import { randomUUID } from 'node:crypto'

/**
 * Work Queue Module (Optimized)
 *
 * Manages the queue of pending agent work items in Redis.
 * Workers poll this queue to claim and process work.
 *
 * Data Structures (optimized for high concurrency):
 * - work:queue (Sorted Set): non-authoritative priority index
 * - work:items (Hash): non-authoritative scheduler payload index
 * - work:state:{sessionId} (String): hash-tagged claim, receipt, payload, and tombstone authority
 *
 * Performance:
 * - queueWork: O(log n) - HSET + ZADD
 * - claimWork: O(1) - one colocated state Lua transition
 * - peekWork: O(log n + k) - ZRANGEBYSCORE + HMGET where k = limit
 * - getQueueLength: O(1) - ZCARD
 */

import {
  redisGet,
  redisGetRaw,
  redisDel,
  redisSetNX,
  redisEval,
  redisZAdd,
  redisZRem,
  redisZRangeByScore,
  redisZCard,
  redisHSet,
  redisHGet,
  redisHDel,
  redisHMGet,
  isRedisConfigured,
  // Legacy list operations for migration
  redisLRange,
  redisLLen,
  redisLRem,
  redisTTL,
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
export const WORK_STATE_PREFIX = 'work:state:'
const LEGACY_WORK_CLAIM_PREFIX = 'work:claim:'
const LEGACY_CLAIM_BRIDGE_PREFIX = 'bridge:'
const LEGACY_RECONCILE_BARRIER_PREFIX = 'reconcile:'
/** @deprecated Claim authority now lives in the colocated work-state record. */
export const WORK_CLAIM_PREFIX = WORK_STATE_PREFIX
/** @deprecated Reconciliation authority now lives in the colocated work-state record. */
export const WORK_RECONCILIATION_TOMBSTONE_PREFIX = WORK_STATE_PREFIX

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
  attemptToken: string
  claimedAt: number
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

/** A different active attempt owns the durable work payload. */
export interface WorkClaimInProgress {
  status: 'claim_in_progress'
  sessionId: string
  workerId: string | null
}

/** Typed outcome for consumers that must distinguish reconciliation refusal. */
export type WorkClaimResult =
  | WorkClaimReceipt
  | WorkClaimRefusedReconciled
  | WorkClaimUnavailable
  | WorkClaimInProgress

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

const ENQUEUE_WORK_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local state = {}
if raw then
  local decoded, parsed = pcall(cjson.decode, raw)
  if not decoded or type(parsed) ~= 'table' then return {'queue_unavailable'} end
  state = parsed
end

local now = tonumber(ARGV[2])
if state.tombstone then
  local expiresAt = tonumber(state.tombstone.expiresAt)
  if expiresAt and expiresAt > now then
    return {'queue_refused_reconciled'}
  end
  state.tombstone = nil
end
if state.delivery then return {'queue_unavailable'} end
if state.claim then
  local expiresAt = tonumber(state.claim.expiresAt)
  if expiresAt and expiresAt > now then return {'queue_unavailable'} end
  state.claim = nil
end

local decodedWork, work = pcall(cjson.decode, ARGV[1])
if not decodedWork or type(work) ~= 'table' then return {'queue_unavailable'} end
state.work = work
redis.call('SET', KEYS[1], cjson.encode(state))
return {'queued'}
`

const MATERIALIZE_LEGACY_WORK_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if raw then return {'state_exists'} end
if ARGV[1] == '' then return {'legacy_missing'} end

local decodedWork, work = pcall(cjson.decode, ARGV[1])
if not decodedWork or type(work) ~= 'table' then return {'legacy_invalid'} end

local state = { work = work, legacyIndex = true }
local legacyWorkerId = ARGV[2]
local legacyTtlMs = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
if legacyWorkerId ~= '' and
  string.sub(legacyWorkerId, 1, 7) ~= 'bridge:' and
  string.sub(legacyWorkerId, 1, 10) ~= 'reconcile:' and
  legacyTtlMs and legacyTtlMs > 0 and now then
  state.claim = {
    legacy = true,
    attemptToken = '',
    workerId = legacyWorkerId,
    claimedAt = now,
    expiresAt = now + legacyTtlMs,
  }
end

redis.call('SET', KEYS[1], cjson.encode(state))
return {'legacy_materialized'}
`

const CLAIM_WORK_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'claim_unavailable'} end
local decoded, state = pcall(cjson.decode, raw)
if not decoded or type(state) ~= 'table' then return {'claim_unavailable'} end

local attemptToken = ARGV[1]
local workerId = ARGV[2]
local ttlMs = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
if not ttlMs or not now then return {'claim_unavailable'} end

if state.tombstone then
  local expiresAt = tonumber(state.tombstone.expiresAt)
  if expiresAt and expiresAt > now then
    return {'claim_refused_reconciled', cjson.encode(state.tombstone)}
  end
  state.tombstone = nil
end
if state.delivery or not state.work then return {'claim_unavailable'} end

if state.claim then
  if state.claim.legacy then
    local expiresAt = tonumber(state.claim.expiresAt)
    if expiresAt and expiresAt > now then
      return {'claim_in_progress', tostring(state.claim.workerId or '')}
    end
    state.claim = nil
  end
end
if state.claim then
  if state.claim.attemptToken == attemptToken then
    if state.claim.workerId ~= workerId then
      return {'claim_in_progress', tostring(state.claim.workerId or '')}
    end
    return {'claimed', cjson.encode(state.work), cjson.encode(state.claim)}
  end
  local expiresAt = tonumber(state.claim.expiresAt)
  if expiresAt and expiresAt > now then
    return {'claim_in_progress', tostring(state.claim.workerId or '')}
  end
  state.claim = nil
end

state.claim = {
  attemptToken = attemptToken,
  workerId = workerId,
  claimedAt = now,
  expiresAt = now + ttlMs,
}
redis.call('SET', KEYS[1], cjson.encode(state))
return {'claimed', cjson.encode(state.work), cjson.encode(state.claim)}
`

const RECONCILE_WORK_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
local state = {}
if raw then
  local decoded, parsed = pcall(cjson.decode, raw)
  if not decoded or type(parsed) ~= 'table' then return {'reconcile_unavailable'} end
  state = parsed
end

local generation = ARGV[1]
local ttlMs = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
if not ttlMs or not now then return {'reconcile_unavailable'} end

if state.tombstone then
  local expiresAt = tonumber(state.tombstone.expiresAt)
  if expiresAt and expiresAt > now then
    if state.tombstone.generation == generation then
      if ttlMs > (expiresAt - now) then state.tombstone.expiresAt = now + ttlMs end
      redis.call('SET', KEYS[1], cjson.encode(state))
      return {'reconcile_tombstone_exists', cjson.encode(state.tombstone)}
    end
    return {'reconcile_generation_conflict', cjson.encode(state.tombstone)}
  end
  state.tombstone = nil
end

if state.delivery then
  local expiresAt = tonumber(state.delivery.expiresAt)
  if not expiresAt or expiresAt > now then
    return {'reconcile_refused_claimed', tostring(state.delivery.workerId or '')}
  end
  state.delivery = nil
end

if state.claim then
  local expiresAt = tonumber(state.claim.expiresAt)
  if expiresAt and expiresAt > now then
    return {'reconcile_refused_claimed', tostring(state.claim.workerId or '')}
  end
  state.claim = nil
end

state.tombstone = { generation = generation, expiresAt = now + ttlMs }
redis.call('SET', KEYS[1], cjson.encode(state))
return {'reconcile_tombstone_written', cjson.encode(state.tombstone)}
`

const RELEASE_CLAIM_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local decoded, state = pcall(cjson.decode, raw)
if not decoded or type(state) ~= 'table' then return 0 end
if not state.claim and not state.delivery then return 0 end
redis.call('DEL', KEYS[1])
return 1
`

const ACKNOWLEDGE_CLAIM_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'claim_delivery_unavailable'} end
local decoded, state = pcall(cjson.decode, raw)
if not decoded or type(state) ~= 'table' then return {'claim_delivery_unavailable'} end
local attemptToken = ARGV[1]
local now = tonumber(ARGV[2])
local ttlSeconds = tonumber(ARGV[3])
if not now or not ttlSeconds then return {'claim_delivery_unavailable'} end

if state.delivery and state.delivery.attemptToken == attemptToken then
  return {'claim_delivery_acknowledged'}
end
if not state.claim or state.claim.attemptToken ~= attemptToken then
  return {'claim_delivery_unavailable'}
end
state.delivery = {
  attemptToken = attemptToken,
  workerId = state.claim.workerId,
  deliveredAt = now,
  expiresAt = now + (ttlSeconds * 1000),
}
state.claim = nil
state.work = nil
redis.call('SETEX', KEYS[1], ttlSeconds, cjson.encode(state))
return {'claim_delivery_acknowledged'}
`

const ACKNOWLEDGE_CLAIM_BY_WORKER_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {'claim_delivery_unavailable'} end
local decoded, state = pcall(cjson.decode, raw)
if not decoded or type(state) ~= 'table' then return {'claim_delivery_unavailable'} end
local workerId = ARGV[1]
local now = tonumber(ARGV[2])
local ttlSeconds = tonumber(ARGV[3])
if not now or not ttlSeconds then return {'claim_delivery_unavailable'} end

if state.delivery and state.delivery.workerId == workerId then
  return {'claim_delivery_acknowledged'}
end
if not state.claim or state.claim.workerId ~= workerId then
  return {'claim_delivery_unavailable'}
end
state.delivery = {
  attemptToken = state.claim.attemptToken,
  workerId = workerId,
  deliveredAt = now,
  expiresAt = now + (ttlSeconds * 1000),
}
state.claim = nil
state.work = nil
redis.call('SETEX', KEYS[1], ttlSeconds, cjson.encode(state))
return {'claim_delivery_acknowledged'}
`

const REMOVE_WORK_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local decoded, state = pcall(cjson.decode, raw)
if not decoded or type(state) ~= 'table' then return 0 end
if state.claim then return 0 end
state.work = nil
if not state.claim and not state.tombstone and not state.delivery then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], cjson.encode(state))
end
return 1
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

interface StoredWorkClaim {
  legacy?: boolean
  attemptToken: string
  workerId: string
  claimedAt: number
  expiresAt: number
}

interface StoredWorkTombstone {
  generation: string
  expiresAt: number
}

interface StoredWorkState {
  legacyIndex?: boolean
  work?: QueuedWork
  claim?: StoredWorkClaim
  tombstone?: StoredWorkTombstone
  delivery?: {
    attemptToken: string
    workerId: string
    deliveredAt: number
    expiresAt?: number
  }
}

/**
 * Build the single Redis Cluster-colocated authority key for one work item.
 * The encoded session ID is the hash tag, so every Lua transition uses exactly
 * one key and cannot span cluster slots.
 */
export function getWorkStateKey(sessionId: string): string {
  return `${WORK_STATE_PREFIX}{${encodeURIComponent(sessionId)}}`
}

/** @deprecated Use getWorkStateKey; claims are fields in that record. */
export function getWorkClaimKey(sessionId: string): string {
  return getWorkStateKey(sessionId)
}

/** @deprecated Use getWorkStateKey; tombstones are fields in that record. */
export function getWorkReconciliationTombstoneKey(sessionId: string): string {
  return getWorkStateKey(sessionId)
}

function getLegacyWorkClaimKey(sessionId: string): string {
  return `${LEGACY_WORK_CLAIM_PREFIX}${sessionId}`
}

/**
 * Materialize a pre-state-record queue entry without deleting its v0.9.14
 * indexes. During a rolling upgrade, legacy workers still read those indexes,
 * while upgraded claim paths read the colocated state record. A live legacy
 * claim becomes a synthetic in-progress state claim until its original TTL.
 */
async function materializeLegacyWorkState(sessionId: string): Promise<boolean> {
  const existing = await redisGet<StoredWorkState>(getWorkStateKey(sessionId))
  if (existing) return true

  const legacyClaimKey = getLegacyWorkClaimKey(sessionId)
  const [legacyWork, legacyWorkerId, legacyTtlSeconds] = await Promise.all([
    redisHGet(WORK_ITEMS_KEY, sessionId),
    redisGetRaw(legacyClaimKey),
    redisTTL(legacyClaimKey),
  ])
  if (!legacyWork) return false

  const tuple = asLuaTuple(
    await redisEval(
      MATERIALIZE_LEGACY_WORK_SCRIPT,
      [getWorkStateKey(sessionId)],
      [
        legacyWork,
        legacyWorkerId ?? '',
        Math.max(0, legacyTtlSeconds) * 1000,
        Date.now(),
      ]
    )
  )
  return tuple?.[0] === 'legacy_materialized' || tuple?.[0] === 'state_exists'
}

function legacyClaimOwner(rawClaim: string): string {
  if (rawClaim.startsWith(LEGACY_CLAIM_BRIDGE_PREFIX)) {
    const [, workerId] = rawClaim.split(':', 3)
    return workerId || rawClaim
  }
  return rawClaim
}

function legacyClaimBridgeValue(workerId: string, attemptToken: string): string {
  return `${LEGACY_CLAIM_BRIDGE_PREFIX}${workerId}:${attemptToken}`
}

interface CompatibleBarrierResult {
  barrierValue?: string
  inProgress?: WorkClaimInProgress
  reconciliationGeneration?: string
}

async function acquireCompatibleClaimBarrier(
  sessionId: string,
  workerId: string,
  attemptToken: string,
  ttlSeconds: number = WORK_CLAIM_TTL
): Promise<CompatibleBarrierResult> {
  const legacyKey = getLegacyWorkClaimKey(sessionId)
  const bridgeValue = legacyClaimBridgeValue(workerId, attemptToken)
  let current = await redisGetRaw(legacyKey)
  if (!current) {
    const acquired = await redisSetNX(legacyKey, bridgeValue, ttlSeconds)
    if (acquired) return { barrierValue: bridgeValue }
    current = await redisGetRaw(legacyKey)
  }
  if (current === bridgeValue) return { barrierValue: bridgeValue }
  if (current?.startsWith(LEGACY_RECONCILE_BARRIER_PREFIX)) {
    return {
      reconciliationGeneration: current.slice(LEGACY_RECONCILE_BARRIER_PREFIX.length),
    }
  }
  return {
    inProgress: {
      status: 'claim_in_progress',
      sessionId,
      workerId: current ? legacyClaimOwner(current) : null,
    },
  }
}

async function clearLegacyClaimBridge(sessionId: string, expected: string): Promise<void> {
  const key = getLegacyWorkClaimKey(sessionId)
  if (await redisGetRaw(key) === expected) {
    await redisDel(key)
  }
}

async function acquireCompatibleReconcileBarrier(
  sessionId: string,
  generation: string,
  ttlSeconds: number
): Promise<{ barrierValue?: string; refused?: WorkReconciliationRefusedClaimed }> {
  const legacyKey = getLegacyWorkClaimKey(sessionId)
  const barrierValue = `${LEGACY_RECONCILE_BARRIER_PREFIX}${generation}`
  let current = await redisGetRaw(legacyKey)
  if (!current) {
    const acquired = await redisSetNX(legacyKey, barrierValue, ttlSeconds)
    if (acquired) return { barrierValue }
    current = await redisGetRaw(legacyKey)
  }
  if (current === barrierValue) return { barrierValue }
  return {
    refused: {
      status: 'reconcile_refused_claimed',
      sessionId,
      workerId: current ? legacyClaimOwner(current) : 'unknown',
    },
  }
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

function readClaimReceipt(serialized: string | undefined): StoredWorkClaim | null {
  if (!serialized) return null
  try {
    const parsed = JSON.parse(serialized) as Partial<StoredWorkClaim>
    if (
      typeof parsed.attemptToken !== 'string' ||
      typeof parsed.workerId !== 'string' ||
      typeof parsed.claimedAt !== 'number'
    ) {
      return null
    }
    return {
      attemptToken: parsed.attemptToken,
      workerId: parsed.workerId,
      claimedAt: parsed.claimedAt,
      expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
    }
  } catch {
    return null
  }
}

function decodeClaimResult(
  rawResult: unknown,
  workerId: string,
  fallbackSessionId?: string
): WorkClaimResult {
  const result = asLuaTuple(rawResult)
  const sessionId = fallbackSessionId ?? result?.[3] ?? ''

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

  if (result[0] === 'claim_in_progress') {
    return {
      status: 'claim_in_progress',
      sessionId,
      workerId: result[1] || null,
    }
  }

  if (result[0] !== 'claimed' || !result[1]) {
    return { status: 'claim_unavailable', sessionId }
  }

  const receipt = readClaimReceipt(result[2])
  if (!receipt) {
    return { status: 'claim_unavailable', sessionId }
  }

  try {
    const work = JSON.parse(result[1]) as QueuedWork
    return {
      status: 'claimed',
      sessionId: work.sessionId,
      workerId: receipt.workerId || workerId,
      attemptToken: receipt.attemptToken,
      claimedAt: receipt.claimedAt,
      work,
    }
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

function assertAttemptToken(attemptToken: string): void {
  if (!attemptToken.trim()) {
    throw new Error('Work claim attempt token must be non-empty')
  }
}

function pollAttemptToken(workerId: string, sessionId: string): string {
  // Backward-compatible retry identity for GET poll: the worker need not know
  // a token that was lost with the first HTTP response.
  return `poll:${workerId}:${sessionId}`
}

function rethrowCrossSlotError(error: unknown): void {
  if (error instanceof Error && error.message.includes('CROSSSLOT')) {
    throw error
  }
}

function isLiveClaim(state: StoredWorkState, now = Date.now()): boolean {
  return !!state.claim && state.claim.expiresAt > now
}

function isLiveTombstone(state: StoredWorkState, now = Date.now()): boolean {
  return !!state.tombstone && state.tombstone.expiresAt > now
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

    // The per-session state record is the only claim/reconciliation authority.
    // Queue/hash entries remain a non-authoritative scheduling index so this
    // mutation uses exactly one hash-tagged Lua key in Redis Cluster.
    const stateResult = asLuaTuple(
      await redisEval(
        ENQUEUE_WORK_SCRIPT,
        [getWorkStateKey(work.sessionId)],
        [serialized, Date.now()]
      )
    )
    if (stateResult?.[0] !== 'queued') {
      log.warn('Work queue rejected by durable state', {
        sessionId: work.sessionId,
        result: stateResult?.[0] ?? 'invalid',
      })
      return false
    }

    // Preserve the legacy global scheduler index. It is never read by the Lua
    // authority path, so cross-slot index cleanup cannot change claim truth.
    await redisHSet(WORK_ITEMS_KEY, work.sessionId, serialized)
    await redisZAdd(WORK_QUEUE_KEY, score, work.sessionId)

    log.info('Work queued', {
      sessionId: work.sessionId,
      issueIdentifier: work.issueIdentifier,
      priority: work.priority,
      score,
    })

    return true
  } catch (error) {
    rethrowCrossSlotError(error)
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
 * recorded a durable tombstone. The Lua transition owns the entire per-session
 * authority record and retains the payload for same-token replay until delivery
 * acknowledgement, so reconciliation and claim cannot both win.
 */
export async function claimWorkWithReceipt(
  sessionId: string,
  workerId: string,
  attemptToken: string
): Promise<WorkClaimResult> {
  assertAttemptToken(attemptToken)

  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot claim work')
    return { status: 'claim_unavailable', sessionId }
  }

  try {
    const stateBeforeClaim = await redisGet<StoredWorkState>(getWorkStateKey(sessionId))
    const hasLiveDelivery = Boolean(
      stateBeforeClaim?.delivery &&
      (stateBeforeClaim.delivery.expiresAt === undefined ||
        stateBeforeClaim.delivery.expiresAt > Date.now())
    )
    const needsCompatibleBarrier =
      !stateBeforeClaim ||
      (!isLiveClaim(stateBeforeClaim) && !isLiveTombstone(stateBeforeClaim) && !hasLiveDelivery)
    const barrier = needsCompatibleBarrier
      ? await acquireCompatibleClaimBarrier(sessionId, workerId, attemptToken)
      : {}
    if (barrier.inProgress) return barrier.inProgress
    if (barrier.reconciliationGeneration !== undefined) {
      return {
        status: 'claim_refused_reconciled',
        sessionId,
        reconciliationGeneration: barrier.reconciliationGeneration || null,
      }
    }

    await materializeLegacyWorkState(sessionId)
    const result = decodeClaimResult(
      await redisEval(
        CLAIM_WORK_SCRIPT,
        [getWorkStateKey(sessionId)],
        [attemptToken, workerId, WORK_CLAIM_TTL * 1000, Date.now()]
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

    if (result.status !== 'claimed' && barrier.barrierValue) {
      await clearLegacyClaimBridge(
        sessionId,
        barrier.barrierValue
      )
    }

    return result
  } catch (error) {
    rethrowCrossSlotError(error)
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
  const attemptToken = randomUUID()
  const result = await claimWorkWithReceipt(sessionId, workerId, attemptToken)
  if (result.status !== 'claimed') return null

  // The legacy nullable API has no replay token or follow-up acknowledgement
  // surface. Preserve its historical single-delivery contract by finalizing
  // the durable receipt before returning the payload to that caller.
  return await acknowledgeWorkClaim(sessionId, attemptToken) ? result.work : null
}

/**
 * Select a priority-index candidate, then atomically reconcile-check and claim
 * its colocated state. The global index is intentionally non-authoritative so
 * its slot never participates in the claim Lua transition.
 */
export async function popAndClaimWorkWithReceipt(
  workerId: string,
  attemptToken?: string,
  excludedSessionIds: readonly string[] = []
): Promise<WorkClaimResult> {
  if (attemptToken !== undefined) assertAttemptToken(attemptToken)

  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot pop work')
    return { status: 'claim_unavailable', sessionId: '' }
  }

  try {
    // The priority index is deliberately non-authoritative so it can live in
    // its own Redis Cluster slot. Each candidate's claim authority is one
    // colocated state key, which is the only key passed to EVAL.
    const excluded = new Set(excludedSessionIds)
    const sessionIds = await redisZRangeByScore(WORK_QUEUE_KEY, '-inf', '+inf', 10)
    for (const sessionId of sessionIds) {
      // A poll route can be replaying an already-active receipt in parallel
      // with new-work admission. Do not let that same receipt consume a new
      // selection slot or hot-block lower-priority candidates.
      if (excluded.has(sessionId)) continue
      const result = await claimWorkWithReceipt(
        sessionId,
        workerId,
        attemptToken ?? pollAttemptToken(workerId, sessionId)
      )
      if (result.status === 'claimed') {
        log.info('Work popped and claimed', {
          sessionId: result.sessionId,
          workerId,
          issueIdentifier: result.work.issueIdentifier,
        })
        return result
      }
      if (result.status === 'claim_refused_reconciled') {
        log.warn('Popped work claim refused by reconciliation', {
          sessionId: result.sessionId,
          workerId,
          reconciliationGeneration: result.reconciliationGeneration,
        })
        // A tombstone is authoritative even if this best-effort index cleanup
        // fails. Returning the typed refusal prevents accidental execution.
        await redisZRem(WORK_QUEUE_KEY, sessionId)
        await redisHDel(WORK_ITEMS_KEY, sessionId)
        return result
      }
      if (result.status === 'claim_unavailable') {
        // No durable payload remains (or it has been acknowledged), so clean
        // only the stale scheduling index and inspect the next candidate.
        await redisZRem(WORK_QUEUE_KEY, sessionId)
        await redisHDel(WORK_ITEMS_KEY, sessionId)
      }
      // A live different-token claim retains its index until its claimant
      // acknowledges delivery or expires; inspect a later candidate instead.
    }
    return { status: 'claim_unavailable', sessionId: '' }
  } catch (error) {
    rethrowCrossSlotError(error)
    log.error('Failed to pop and claim work', { error, workerId })
    return { status: 'claim_unavailable', sessionId: '' }
  }
}

/**
 * Replay an outstanding GET-poll receipt for one already-active worker
 * session. This is deliberately separate from priority selection: callers
 * use it before new-work capacity admission, so a zero-capacity retry can
 * recover its own lost response without claiming another queue candidate.
 */
export async function replayPollWorkWithReceipt(
  workerId: string,
  sessionId: string
): Promise<WorkClaimResult> {
  return claimWorkWithReceipt(sessionId, workerId, pollAttemptToken(workerId, sessionId))
}

/**
 * Backward-compatible pop helper for consumers that only need work or null.
 * It still uses the reconciliation-fenced Lua transition above.
 */
export async function popAndClaimWork(
  workerId: string
): Promise<QueuedWork | null> {
  const attemptToken = randomUUID()
  const result = await popAndClaimWorkWithReceipt(workerId, attemptToken)
  if (result.status !== 'claimed') return null
  return await acknowledgeWorkClaim(result.sessionId, attemptToken) ? result.work : null
}

/**
 * Atomically record a durable reconciliation tombstone in the colocated state.
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

  try {
    const stateBeforeReconcile = await redisGet<StoredWorkState>(getWorkStateKey(sessionId))
    const hasLiveDelivery = Boolean(
      stateBeforeReconcile?.delivery &&
      (stateBeforeReconcile.delivery.expiresAt === undefined ||
        stateBeforeReconcile.delivery.expiresAt > Date.now())
    )
    const needsCompatibleBarrier =
      !stateBeforeReconcile ||
      (!isLiveClaim(stateBeforeReconcile) &&
        !isLiveTombstone(stateBeforeReconcile) &&
        !hasLiveDelivery)
    const barrier = needsCompatibleBarrier
      ? await acquireCompatibleReconcileBarrier(
          sessionId,
          tombstone.generation,
          tombstone.ttlSeconds
        )
      : {}
    if (barrier.refused) return barrier.refused

    await materializeLegacyWorkState(sessionId)
    const tuple = asLuaTuple(
      await redisEval(
        RECONCILE_WORK_SCRIPT,
        [getWorkStateKey(sessionId)],
        [tombstone.generation, tombstone.ttlSeconds * 1000, Date.now()]
      )
    )
    const existingGeneration = readTombstoneGeneration(tuple?.[1])

    if (tuple?.[0] === 'reconcile_tombstone_written' || tuple?.[0] === 'reconcile_tombstone_exists') {
      const result: WorkReconciliationReceipt = {
        status: tuple[0],
        sessionId,
        generation: existingGeneration,
      }
      // Index cleanup is intentionally outside the colocated authority script.
      // A failure leaves a stale index that returns the same typed tombstone.
      await redisZRem(WORK_QUEUE_KEY, sessionId)
      await redisHDel(WORK_ITEMS_KEY, sessionId)
      return result
    }
    if (tuple?.[0] === 'reconcile_refused_claimed' && tuple[1]) {
      if (barrier.barrierValue) await clearLegacyClaimBridge(sessionId, barrier.barrierValue)
      return { status: 'reconcile_refused_claimed', sessionId, workerId: tuple[1] }
    }
    if (barrier.barrierValue) await clearLegacyClaimBridge(sessionId, barrier.barrierValue)
    return {
      status: 'reconcile_generation_conflict',
      sessionId,
      generation: existingGeneration,
    }
  } catch (error) {
    rethrowCrossSlotError(error)
    log.error('Failed to reconcile work', { error, sessionId })
    return { status: 'reconcile_unavailable', sessionId }
  }
}

/**
 * Mark a delivered claim only after the consumer has durably accepted its
 * payload. The acknowledgement removes the payload from the authority record;
 * same-token retries remain idempotent for one claim TTL.
 */
export async function acknowledgeWorkClaim(
  sessionId: string,
  attemptToken: string
): Promise<boolean> {
  assertAttemptToken(attemptToken)
  if (!isRedisConfigured()) return false

  try {
    await materializeLegacyWorkState(sessionId)
    const tuple = asLuaTuple(
      await redisEval(
        ACKNOWLEDGE_CLAIM_SCRIPT,
        [getWorkStateKey(sessionId)],
        [attemptToken, Date.now(), WORK_CLAIM_TTL]
      )
    )
    if (tuple?.[0] !== 'claim_delivery_acknowledged') return false
    await redisZRem(WORK_QUEUE_KEY, sessionId)
    await redisHDel(WORK_ITEMS_KEY, sessionId)
    await redisDel(getLegacyWorkClaimKey(sessionId))
    return true
  } catch (error) {
    rethrowCrossSlotError(error)
    log.error('Failed to acknowledge work claim delivery', { error, sessionId })
    return false
  }
}

/**
 * Acknowledge delivery at the existing worker `running` transition. The worker
 * can only report that status after it received the payload, so this is safe
 * for HTTP response replay without adding a new acknowledgement endpoint.
 */
export async function acknowledgeWorkClaimForWorker(
  sessionId: string,
  workerId: string
): Promise<boolean> {
  if (!workerId || !isRedisConfigured()) return false

  try {
    await materializeLegacyWorkState(sessionId)
    const tuple = asLuaTuple(
      await redisEval(
        ACKNOWLEDGE_CLAIM_BY_WORKER_SCRIPT,
        [getWorkStateKey(sessionId)],
        [workerId, Date.now(), WORK_CLAIM_TTL]
      )
    )
    if (tuple?.[0] !== 'claim_delivery_acknowledged') return false
    await redisZRem(WORK_QUEUE_KEY, sessionId)
    await redisHDel(WORK_ITEMS_KEY, sessionId)
    await redisDel(getLegacyWorkClaimKey(sessionId))
    return true
  } catch (error) {
    rethrowCrossSlotError(error)
    log.error('Failed to acknowledge worker claim delivery', { error, sessionId, workerId })
    return false
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
    await materializeLegacyWorkState(sessionId)
    const result = await redisEval(RELEASE_CLAIM_SCRIPT, [getWorkStateKey(sessionId)], [])
    if (result !== 1) return false
    await redisZRem(WORK_QUEUE_KEY, sessionId)
    await redisHDel(WORK_ITEMS_KEY, sessionId)
    await redisDel(getLegacyWorkClaimKey(sessionId))
    return true
  } catch (error) {
    rethrowCrossSlotError(error)
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
    const state = await redisGet<StoredWorkState>(getWorkStateKey(sessionId))
    if (state && isLiveClaim(state)) return state.claim!.workerId
    if (
      state?.delivery &&
      (state.delivery.expiresAt === undefined || state.delivery.expiresAt > Date.now())
    ) {
      return state.delivery.workerId
    }
    const legacyClaim = await redisGetRaw(getLegacyWorkClaimKey(sessionId))
    return legacyClaim ? legacyClaimOwner(legacyClaim) : null
  } catch (error) {
    log.error('Failed to get claim owner', { error, sessionId })
    return null
  }
}

/**
 * Check if a session has an entry in the work queue.
 * The hash-tagged state record is authoritative; the global scheduler index
 * may retain an acknowledged or reconciled stale entry until best-effort trim.
 *
 * @param sessionId - Session ID to check
 * @returns true if the session is present in the work queue
 */
export async function isSessionInQueue(sessionId: string): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  try {
    const state = await redisGet<StoredWorkState>(getWorkStateKey(sessionId))
    if (state) {
      return !!state.work && !state.delivery && !isLiveClaim(state) && !isLiveTombstone(state)
    }
    return (await redisHGet(WORK_ITEMS_KEY, sessionId)) !== null
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
    // The global queue is only a priority index; read each colocated authority
    // record before exposing pending work.
    const sessionIds = await redisZRangeByScore(WORK_QUEUE_KEY, '-inf', '+inf')

    if (sessionIds.length === 0) {
      return []
    }

    const result: QueuedWork[] = []
    const states = await Promise.all(
      sessionIds.map(async (id) => {
        await materializeLegacyWorkState(id)
        return redisGet<StoredWorkState>(getWorkStateKey(id))
      })
    )
    for (const state of states) {
      if (state?.work && !state.delivery && !isLiveClaim(state) && !isLiveTombstone(state)) {
        result.push(state.work)
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
    const removed = await redisEval(REMOVE_WORK_SCRIPT, [getWorkStateKey(sessionId)], [])
    if (removed !== 1) return false
    await redisZRem(WORK_QUEUE_KEY, sessionId)
    await redisHDel(WORK_ITEMS_KEY, sessionId)
    return true
  } catch (error) {
    rethrowCrossSlotError(error)
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

        if (!await queueWork(work)) {
          failed++
          continue
        }

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
