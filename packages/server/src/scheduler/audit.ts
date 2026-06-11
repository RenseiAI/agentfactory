/**
 * Scheduling Decision Audit Records
 *
 * Stores and retrieves SchedulingDecision records for debugging purposes.
 * Each scheduling decision produced by the orchestrator can be persisted
 * to Redis with structured logging for observability.
 *
 * Redis Key Layout:
 * - scheduling:decisions:{sessionId}   — JSON, latest decision for a session (24hr TTL)
 * - scheduling:decisions:recent        — List (capped at 1000), recent decision IDs
 * - scheduling:decisions:log:{id}      — JSON, full decision record (24hr TTL)
 */

import crypto from 'node:crypto'
import type { SchedulingDecision } from './orchestrator.js'
import { isRedisConfigured, getRedisClient } from '../redis.js'
import { createLogger } from '../logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredSchedulingDecision extends SchedulingDecision {
  /** Unique identifier for this stored decision */
  id: string
  /** Unix milliseconds when the decision was recorded */
  timestamp: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DECISION_TTL = 86400 // 24 hours in seconds
const RECENT_LIST_CAP = 1000

const KEY_PREFIX = 'scheduling:decisions:'
const RECENT_KEY = 'scheduling:decisions:recent'
const LOG_PREFIX = 'scheduling:decisions:log:'

const logger = createLogger('scheduler-audit')

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a scheduling decision to Redis and emit a structured log entry.
 *
 * @param decision - The scheduling decision from the orchestrator
 * @returns The generated UUID for the stored record
 */
export async function recordSchedulingDecision(
  decision: SchedulingDecision,
): Promise<string> {
  const id = crypto.randomUUID()
  const timestamp = Date.now()

  const stored: StoredSchedulingDecision = {
    ...decision,
    id,
    timestamp,
  }

  // Structured log — always emitted regardless of Redis availability
  logger.info('scheduling_decision', {
    sessionId: decision.workSessionId,
    outcome: decision.outcome,
    totalWorkers: decision.totalWorkers,
    feasibleWorkers: decision.feasibleWorkers,
    assignedWorkerId: decision.assignedWorkerId,
    assignedScore: decision.assignedScore,
    durationMs: decision.totalDurationMs,
  })

  if (!isRedisConfigured()) {
    return id
  }

  try {
    const redis = getRedisClient()
    const serialized = JSON.stringify(stored)

    // Store latest decision for this session (24hr TTL)
    await redis.setex(`${KEY_PREFIX}${decision.workSessionId}`, DECISION_TTL, serialized)

    // Store full decision record by ID (24hr TTL)
    await redis.setex(`${LOG_PREFIX}${id}`, DECISION_TTL, serialized)

    // Push to recent decisions list and cap at 1000
    await redis.lpush(RECENT_KEY, id)
    await redis.ltrim(RECENT_KEY, 0, RECENT_LIST_CAP - 1)
  } catch (error) {
    logger.error('Failed to store scheduling decision', {
      error,
      sessionId: decision.workSessionId,
      decisionId: id,
    })
  }

  return id
}

/**
 * Retrieve the latest scheduling decision for a given session.
 *
 * @param sessionId - The work session ID
 * @returns The stored decision or null if not found / Redis unavailable
 */
export async function getSchedulingDecision(
  sessionId: string,
): Promise<StoredSchedulingDecision | null> {
  if (!isRedisConfigured()) {
    return null
  }

  try {
    const redis = getRedisClient()
    const raw = await redis.get(`${KEY_PREFIX}${sessionId}`)
    if (raw === null) {
      return null
    }
    return JSON.parse(raw) as StoredSchedulingDecision
  } catch (error) {
    logger.error('Failed to get scheduling decision', { error, sessionId })
    return null
  }
}

/**
 * Retrieve recent scheduling decisions, newest first.
 *
 * @param limit - Maximum number of decisions to return (default: 50)
 * @returns Array of stored decisions (may be shorter if records have expired)
 */
export async function getRecentDecisions(
  limit: number = 50,
): Promise<StoredSchedulingDecision[]> {
  if (!isRedisConfigured()) {
    return []
  }

  try {
    const redis = getRedisClient()

    // Get recent decision IDs
    const ids = await redis.lrange(RECENT_KEY, 0, limit - 1)
    if (ids.length === 0) {
      return []
    }

    // Batch-fetch full records via pipeline
    const pipeline = redis.pipeline()
    for (const id of ids) {
      pipeline.get(`${LOG_PREFIX}${id}`)
    }
    const results = await pipeline.exec()

    const decisions: StoredSchedulingDecision[] = []
    if (results) {
      for (const [err, raw] of results) {
        if (!err && raw !== null && typeof raw === 'string') {
          try {
            decisions.push(JSON.parse(raw) as StoredSchedulingDecision)
          } catch {
            // Skip malformed records
          }
        }
      }
    }

    return decisions
  } catch (error) {
    logger.error('Failed to get recent scheduling decisions', { error })
    return []
  }
}
