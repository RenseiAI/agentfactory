import { isRedisConfigured, redisSet, redisGet, redisDel, redisKeys } from './redis.js'
import { onCostUpdated } from './fleet-quota-hooks.js'
import type { AgentWorkType } from './types.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[session] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[session] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[session] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

/**
 * Agent session status
 * - pending: Queued, waiting for a worker to claim
 * - claimed: Worker has claimed but not yet started
 * - running: Agent is actively processing
 * - finalizing: Agent work done, cleanup in progress (worktree removal, orchestrator teardown)
 * - completed: Agent finished successfully (all cleanup done)
 * - failed: Agent encountered an error
 * - stopped: Agent was stopped by user
 */
export type AgentSessionStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'stopped'

/**
 * Agent session state stored in Redis for distributed access
 */
export interface AgentSessionState {
  /**
   * Tracker-agnostic session ID (from webhook or self-dispatch).
   * For Linear sessions this is the Linear AgentSession ID;
   * for GitHub Issues sessions it is a UUID assigned at dispatch time.
   */
  trackerSessionId: string
  /**
   * Issue tracker provider that owns this session.
   * Defaults to 'linear' when reading legacy Redis data written before REN-1517.
   */
  trackerProvider: string
  /**
   * @deprecated Use `trackerSessionId` instead.
   * Kept for one major version to allow zero-downtime rolling upgrades
   * against Redis data written by pre-REN-1517 workers.
   * Will be removed in the next major release.
   */
  linearSessionId?: string
  /** Linear issue ID */
  issueId: string
  /** Issue identifier (e.g., SUP-123) */
  issueIdentifier?: string
  /** Provider CLI session ID for resuming with --resume */
  providerSessionId: string | null
  /** Git worktree path */
  worktreePath: string
  /** Current agent status */
  status: AgentSessionStatus
  /** Unix timestamp in milliseconds when session was created */
  createdAt: number
  /** Unix timestamp in milliseconds of last update */
  updatedAt: number

  // Worker pool fields
  /** Worker ID handling this session (null if pending) */
  workerId?: string | null
  /** Unix timestamp in milliseconds when added to work queue */
  queuedAt?: number | null
  /** Unix timestamp in milliseconds when claimed by worker */
  claimedAt?: number | null
  /** Priority in queue (1-5, lower is higher priority) */
  priority?: number
  /** Prompt context for the session */
  promptContext?: string

  // OAuth context for Linear Agent API
  /** Linear organization ID for OAuth token lookup */
  organizationId?: string

  // Work type for status-based routing
  /** Type of work: research, development, inflight, qa, acceptance, refinement (defaults to 'development') */
  workType?: AgentWorkType

  // Agent identification (from Linear webhook)
  /** Linear Agent ID handling this session */
  agentId?: string

  /** Linear project name (for routing and dashboard visibility) */
  projectName?: string

  /** Agent provider name (claude, codex, amp) — set by worker on claim */
  provider?: string

  // Cost tracking (populated from provider result events)
  /** Total cost in USD for this session */
  totalCostUsd?: number
  /** Total input tokens consumed */
  inputTokens?: number
  /** Total output tokens consumed */
  outputTokens?: number

  /** Last tool name reported by worker heartbeat (for tool loop detection) */
  lastToolName?: string
  /** Epoch ms when this tool was first seen continuously */
  lastToolCalledAt?: number
  /** Consecutive calls to the same tool */
  toolCallCount?: number

  /**
   * Workflow instance ID that initiated this session, when the session was
   * dispatched via the workflow engine (e.g. `agent.dispatch_stage` node).
   * Absent for sessions created by direct webhook dispatch (Linear @-mention
   * with no workflow subscription, governor-generated stages, etc.).
   *
   * Read by per-workflow opt-in surfaces: the platform's activity route
   * uses this to look up the workflow's `workflowConfig` and gate behaviors
   * like Linear activity streaming on the author's per-workflow preference.
   *
   * Plan: runs/2026-05-27-linear-agentsession-integration-plan.md §2.10 (F2)
   */
  workflowInstanceId?: string

  /**
   * The session row's OWN storage id, derived from its Redis key at read time.
   *
   * Normally equals `trackerSessionId`. It differs for per-dispatch rows:
   * a dispatcher may create a row under its own UUID key and later patch the
   * stored `trackerSessionId` to a shared tracker session. Every lifecycle
   * write (claim/start/complete/requeue) keys off `trackerSessionId`, so
   * such rows can only ever be updated under THIS id. Read paths
   * (`getSessionState`, `getAllSessions`, `getSessionStateByIssue`) always
   * repopulate it from the actual key, so a stale persisted value can never
   * mask the true row identity.
   */
  rowSessionId?: string

  /**
   * Why the session was stopped. Set when orphan cleanup terminal-marks a
   * stranded per-dispatch row that can no longer make progress.
   */
  stoppedReason?: string
}

/**
 * Key prefix for session state in KV
 */
const SESSION_KEY_PREFIX = 'agent:session:'

/**
 * Session state TTL in seconds (24 hours)
 * Sessions older than this are automatically cleaned up by KV
 */
const SESSION_TTL_SECONDS = 24 * 60 * 60

/**
 * Build the KV key for a session
 */
function buildSessionKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`
}

/**
 * Migrate legacy Redis data written before REN-1517.
 *
 * Pre-REN-1517 workers stored sessions with `linearSessionId` as the primary
 * field. This helper promotes the value to `trackerSessionId` / `trackerProvider`
 * so all code can use the new shape uniformly.  The raw `linearSessionId` field
 * is left in place so it can still satisfy the deprecated optional.
 */
function migrateSessionState(raw: AgentSessionState): AgentSessionState {
  if (!raw.trackerSessionId && raw.linearSessionId) {
    return {
      ...raw,
      trackerSessionId: raw.linearSessionId,
      trackerProvider: raw.trackerProvider ?? 'linear',
    }
  }
  if (!raw.trackerProvider) {
    return { ...raw, trackerProvider: 'linear' }
  }
  return raw
}

/**
 * Hydrate a raw Redis value into session state, stamping the row's own id
 * (derived from the Redis key it was read from). Always overwrites any
 * persisted `rowSessionId` — the key is the source of truth.
 */
function hydrateSessionState(
  raw: AgentSessionState,
  rowSessionId: string
): AgentSessionState {
  return { ...migrateSessionState(raw), rowSessionId }
}

/**
 * Store agent session state in Redis
 *
 * @param sessionId - The tracker session ID (Linear AgentSession ID or self-dispatched UUID)
 * @param state - The session state to store
 */
export async function storeSessionState(
  sessionId: string,
  state: Omit<AgentSessionState, 'trackerSessionId' | 'createdAt' | 'updatedAt' | 'trackerProvider'> & {
    trackerProvider?: AgentSessionState['trackerProvider']
  }
): Promise<AgentSessionState> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, session state will not be persisted')
    const now = Date.now()
    return {
      ...state,
      trackerSessionId: sessionId,
      trackerProvider: state.trackerProvider ?? 'linear',
      rowSessionId: sessionId,
      createdAt: now,
      updatedAt: now,
    }
  }

  const now = Date.now()
  const key = buildSessionKey(sessionId)

  // Check for existing session to preserve createdAt
  const rawExisting = await redisGet<AgentSessionState>(key)
  const existing = rawExisting ? migrateSessionState(rawExisting) : null

  const sessionState: AgentSessionState = {
    ...state,
    trackerSessionId: sessionId,
    trackerProvider: state.trackerProvider ?? 'linear',
    rowSessionId: sessionId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }

  await redisSet(key, sessionState, SESSION_TTL_SECONDS)

  log.info('Stored session state', {
    sessionId,
    issueId: state.issueId,
    status: state.status,
    hasProviderSessionId: !!state.providerSessionId,
  })

  return sessionState
}

/**
 * Retrieve agent session state from Redis
 *
 * @param sessionId - The tracker session ID
 * @returns The session state or null if not found
 */
export async function getSessionState(
  sessionId: string
): Promise<AgentSessionState | null> {
  if (!isRedisConfigured()) {
    log.debug('Redis not configured, cannot retrieve session state')
    return null
  }

  const key = buildSessionKey(sessionId)
  const raw = await redisGet<AgentSessionState>(key)
  const state = raw ? hydrateSessionState(raw, sessionId) : null

  if (state) {
    log.debug('Retrieved session state', {
      sessionId,
      issueId: state.issueId,
      status: state.status,
    })
  }

  return state
}

/**
 * Update the provider session ID for a session
 * Called when the Claude init event is received with the session ID
 *
 * @param sessionId - The tracker session ID
 * @param providerSessionId - The Provider CLI session ID
 */
export async function updateProviderSessionId(
  sessionId: string,
  providerSessionId: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot update provider session ID')
    return false
  }

  const existing = await getSessionState(sessionId)
  if (!existing) {
    log.warn('Session not found for provider session ID update', { sessionId })
    return false
  }

  const key = buildSessionKey(sessionId)
  const now = Date.now()

  const updated: AgentSessionState = {
    ...existing,
    providerSessionId,
    updatedAt: now,
  }

  await redisSet(key, updated, SESSION_TTL_SECONDS)

  log.info('Updated provider session ID', { sessionId, providerSessionId })

  return true
}

/**
 * Update session status
 *
 * @param sessionId - The tracker session ID
 * @param status - The new status
 */
export async function updateSessionStatus(
  sessionId: string,
  status: AgentSessionState['status'],
  options?: { stoppedReason?: string }
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot update session status')
    return false
  }

  const existing = await getSessionState(sessionId)
  if (!existing) {
    log.warn('Session not found for status update', { sessionId })
    return false
  }

  const key = buildSessionKey(sessionId)
  const now = Date.now()

  const updated: AgentSessionState = {
    ...existing,
    status,
    ...(options?.stoppedReason ? { stoppedReason: options.stoppedReason } : {}),
    updatedAt: now,
  }

  await redisSet(key, updated, SESSION_TTL_SECONDS)

  log.info('Updated session status', { sessionId, status })

  return true
}

/**
 * Update session cost data (tokens and USD)
 *
 * @param sessionId - The tracker session ID
 * @param costData - Cost fields to persist
 */
export async function updateSessionCostData(
  sessionId: string,
  costData: { totalCostUsd?: number; inputTokens?: number; outputTokens?: number }
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot update session cost data')
    return false
  }

  const existing = await getSessionState(sessionId)
  if (!existing) {
    log.warn('Session not found for cost update', { sessionId })
    return false
  }

  const key = buildSessionKey(sessionId)
  const now = Date.now()

  const updated: AgentSessionState = {
    ...existing,
    totalCostUsd: costData.totalCostUsd ?? existing.totalCostUsd,
    inputTokens: costData.inputTokens ?? existing.inputTokens,
    outputTokens: costData.outputTokens ?? existing.outputTokens,
    updatedAt: now,
  }

  await redisSet(key, updated, SESSION_TTL_SECONDS)

  // Fleet quota: track incremental cost delta
  if (costData.totalCostUsd != null) {
    onCostUpdated(
      existing.projectName,
      existing.totalCostUsd ?? 0,
      costData.totalCostUsd
    ).catch((err) => {
      log.error('Fleet quota onCostUpdated failed', { sessionId, error: err })
    })
  }

  log.info('Updated session cost data', {
    sessionId,
    totalCostUsd: updated.totalCostUsd,
  })

  return true
}

/**
 * Reset a session for re-queuing after orphan cleanup
 * Clears workerId and resets status to pending so a new worker can claim it
 *
 * @param sessionId - The tracker session ID
 */
export async function resetSessionForRequeue(
  sessionId: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot reset session')
    return false
  }

  const existing = await getSessionState(sessionId)
  if (!existing) {
    log.warn('Session not found for reset', { sessionId })
    return false
  }

  const key = buildSessionKey(sessionId)
  const now = Date.now()

  const updated: AgentSessionState = {
    ...existing,
    status: 'pending',
    workerId: undefined, // Clear workerId so new worker can claim
    claimedAt: undefined,
    updatedAt: now,
  }

  await redisSet(key, updated, SESSION_TTL_SECONDS)

  log.info('Reset session for requeue', {
    sessionId,
    previousWorkerId: existing.workerId,
  })

  return true
}

/**
 * Delete session state from KV
 *
 * @param sessionId - The tracker session ID
 * @returns Whether the deletion was successful
 */
export async function deleteSessionState(sessionId: string): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  const key = buildSessionKey(sessionId)
  const result = await redisDel(key)

  log.info('Deleted session state', { sessionId })

  return result > 0
}

/**
 * Get session state by issue ID
 * Useful when we have the issue but not the session ID
 *
 * When multiple sessions exist for the same issue (e.g., one running + several
 * failed), this function returns the most relevant one — preferring active
 * sessions (running/claimed/pending) over inactive ones. Without this
 * prioritization, an arbitrary first-match could hide a running session behind
 * a failed one, causing the governor to re-dispatch work for an issue that
 * already has an agent in-flight.
 *
 * @param issueId - The Linear issue ID
 * @returns The most relevant session state for this issue or null
 */
export async function getSessionStateByIssue(
  issueId: string
): Promise<AgentSessionState | null> {
  if (!isRedisConfigured()) {
    return null
  }

  // Scan for sessions with this issue ID
  // Note: This is less efficient than direct lookup, use sparingly
  const keys = await redisKeys(`${SESSION_KEY_PREFIX}*`)
  const activeStatuses = ['running', 'claimed', 'pending']
  let fallback: AgentSessionState | null = null

  for (const key of keys) {
    const raw = await redisGet<AgentSessionState>(key)
    const state = raw
      ? hydrateSessionState(raw, key.slice(SESSION_KEY_PREFIX.length))
      : null
    if (state?.issueId === issueId) {
      // Prefer active sessions — return immediately if found
      if (activeStatuses.includes(state.status)) {
        return state
      }
      // Keep first non-active match as fallback
      if (!fallback) {
        fallback = state
      }
    }
  }

  return fallback
}

// ============================================
// Worker Pool Operations
// ============================================

/**
 * Mark a session as claimed by a worker
 *
 * @param sessionId - The tracker session ID
 * @param workerId - The worker claiming the session
 */
export async function claimSession(
  sessionId: string,
  workerId: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  const existing = await getSessionState(sessionId)
  if (!existing) {
    log.warn('Session not found for claim', { sessionId })
    return false
  }

  if (existing.status !== 'pending') {
    log.warn('Session not in pending status', {
      sessionId,
      status: existing.status,
    })
    return false
  }

  const key = buildSessionKey(sessionId)
  const now = Date.now()

  const updated: AgentSessionState = {
    ...existing,
    status: 'claimed',
    workerId,
    claimedAt: now,
    updatedAt: now,
  }

  await redisSet(key, updated, SESSION_TTL_SECONDS)

  log.info('Session claimed', { sessionId, workerId })

  return true
}

/**
 * Update session with worker info when work starts
 *
 * @param sessionId - The tracker session ID
 * @param workerId - The worker processing the session
 * @param worktreePath - Path to the git worktree
 */
export async function startSession(
  sessionId: string,
  workerId: string,
  worktreePath: string
): Promise<boolean> {
  if (!isRedisConfigured()) {
    return false
  }

  const existing = await getSessionState(sessionId)
  if (!existing) {
    log.warn('Session not found for start', { sessionId })
    return false
  }

  const key = buildSessionKey(sessionId)
  const now = Date.now()

  const updated: AgentSessionState = {
    ...existing,
    status: 'running',
    workerId,
    worktreePath,
    updatedAt: now,
  }

  await redisSet(key, updated, SESSION_TTL_SECONDS)

  log.info('Session started', { sessionId, workerId, worktreePath })

  return true
}

/**
 * Get all sessions from Redis
 * For dashboard display
 */
export async function getAllSessions(): Promise<AgentSessionState[]> {
  if (!isRedisConfigured()) {
    return []
  }

  try {
    const keys = await redisKeys(`${SESSION_KEY_PREFIX}*`)
    const sessions: AgentSessionState[] = []

    for (const key of keys) {
      const raw = await redisGet<AgentSessionState>(key)
      if (raw) {
        sessions.push(hydrateSessionState(raw, key.slice(SESSION_KEY_PREFIX.length)))
      }
    }

    // Sort by updatedAt descending (most recent first)
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)

    return sessions
  } catch (error) {
    log.error('Failed to get all sessions', { error })
    return []
  }
}

/**
 * Get sessions by status
 */
export async function getSessionsByStatus(
  status: AgentSessionStatus | AgentSessionStatus[]
): Promise<AgentSessionState[]> {
  const allSessions = await getAllSessions()
  const statusArray = Array.isArray(status) ? status : [status]
  return allSessions.filter((s) => statusArray.includes(s.status))
}

/**
 * Transfer session ownership to a new worker
 * Used when a worker re-registers after disconnection and gets a new ID
 *
 * @param sessionId - The tracker session ID
 * @param newWorkerId - The new worker ID to assign
 * @param oldWorkerId - The previous worker ID (for validation)
 * @returns Whether the transfer was successful
 */
export async function transferSessionOwnership(
  sessionId: string,
  newWorkerId: string,
  oldWorkerId: string
): Promise<{ transferred: boolean; reason?: string }> {
  if (!isRedisConfigured()) {
    return { transferred: false, reason: 'Redis not configured' }
  }

  const existing = await getSessionState(sessionId)
  if (!existing) {
    return { transferred: false, reason: 'Session not found' }
  }

  // Validate that the old worker ID matches (security check)
  if (existing.workerId && existing.workerId !== oldWorkerId) {
    log.warn('Session ownership transfer rejected - worker ID mismatch', {
      sessionId,
      expectedWorkerId: oldWorkerId,
      actualWorkerId: existing.workerId,
    })
    return {
      transferred: false,
      reason: `Session owned by different worker: ${existing.workerId}`,
    }
  }

  const key = buildSessionKey(sessionId)
  const now = Date.now()

  const updated: AgentSessionState = {
    ...existing,
    workerId: newWorkerId,
    updatedAt: now,
  }

  await redisSet(key, updated, SESSION_TTL_SECONDS)

  log.info('Session ownership transferred', {
    sessionId,
    oldWorkerId,
    newWorkerId,
  })

  return { transferred: true }
}
