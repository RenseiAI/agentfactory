/**
 * Session Supervisor — heartbeat, drain, and reap logic
 *
 * Extracted from orchestrator.ts.
 *
 * Provides type definitions and pure helper logic for the session lifecycle
 * concerns that AgentOrchestrator's `waitForAll`, `stopAgent`, `cleanup`, and
 * `shutdownProviders` methods implement.  The actual methods remain on the
 * orchestrator class (so they have access to private Maps), but they are now
 * isolated and documented here as the canonical reference.
 *
 * Design intent (per 013-orchestrator-and-governor.md §Worker process supervision):
 *   - Heartbeat — written by HeartbeatWriter at an interval; read on recovery
 *   - Drain — allow in-flight work to finish before shutdown
 *   - Reap — forcibly stop hung agents, record stop reason
 *
 * Architectural Intelligence retrieval is wired at session start and
 * session end via context-injection.ts. The supervisor exposes the
 * shouldFlushObservations() helper to determine when a session end warrants
 * flushing new observations back into the AI graph.
 */

import type { AgentProcess } from './types.js'
import type { Logger } from '../logger.js'

// ---------------------------------------------------------------------------
// Session-end observation flush decision
// ---------------------------------------------------------------------------

/**
 * Determine whether post-session observation flushing should occur.
 *
 * Flushing is only warranted when:
 * 1. The agent completed (not stopped/failed/incomplete).
 * 2. The work result was 'passed' (QA/acceptance) or the work type does not
 *    produce a work-result marker (development, research, etc.).
 *
 * This is intentionally conservative — flushing failed sessions could
 * introduce noise into the architectural graph.
 */
export function shouldFlushObservations(
  agent: AgentProcess,
): boolean {
  if (agent.status !== 'completed') return false
  // For work types that produce a structured work result, only flush on 'passed'.
  // For other work types (development, research, etc.), flush on completion.
  const resultSensitiveTypes = new Set(['qa', 'acceptance'])
  if (agent.workType && resultSensitiveTypes.has(agent.workType)) {
    return agent.workResult === 'passed'
  }
  return true
}

// ---------------------------------------------------------------------------
// Timeout configuration
// ---------------------------------------------------------------------------

/** Default inactivity timeout: 5 minutes */
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 300_000

/**
 * Coordination inactivity timeout: 30 minutes.
 * Coordinators spawn foreground sub-agents via the Agent tool. During sub-agent
 * execution the parent event stream is silent (no tool_progress events), so the
 * standard 5-minute inactivity timeout kills coordinators prematurely.
 */
export const COORDINATION_INACTIVITY_TIMEOUT_MS = 1_800_000

/** Default max session timeout: unlimited (undefined) */
export const DEFAULT_MAX_SESSION_TIMEOUT_MS: number | undefined = undefined

// ---------------------------------------------------------------------------
// Timeout decision
// ---------------------------------------------------------------------------

export interface TimeoutConfig {
  inactivityTimeoutMs: number
  maxSessionTimeoutMs?: number
}

/**
 * Decide which timeout values apply to a given work type.
 *
 * Resolution order:
 *   1. Per-work-type override from `workTypeTimeouts`
 *   2. Coordination work types get COORDINATION_INACTIVITY_TIMEOUT_MS
 *   3. Base config value
 *   4. Default
 */
export function resolveTimeoutConfig(
  workType: string | undefined,
  baseInactivityMs: number,
  baseMaxSessionMs: number | undefined,
  workTypeTimeouts?: Record<string, { inactivityTimeoutMs?: number; maxSessionTimeoutMs?: number }>,
): TimeoutConfig {
  // Per-work-type override takes precedence
  if (workType && workTypeTimeouts?.[workType]) {
    const override = workTypeTimeouts[workType]
    return {
      inactivityTimeoutMs: override.inactivityTimeoutMs ?? baseInactivityMs,
      maxSessionTimeoutMs: override.maxSessionTimeoutMs ?? baseMaxSessionMs,
    }
  }

  // Coordination work types default to a longer inactivity timeout
  const COORDINATION_TYPES = new Set([
    'coordination',
    'inflight-coordination',
    'qa-coordination',
    'acceptance-coordination',
    'refinement-coordination',
  ])

  if (workType && COORDINATION_TYPES.has(workType)) {
    return {
      inactivityTimeoutMs: COORDINATION_INACTIVITY_TIMEOUT_MS,
      maxSessionTimeoutMs: baseMaxSessionMs,
    }
  }

  return {
    inactivityTimeoutMs: baseInactivityMs,
    maxSessionTimeoutMs: baseMaxSessionMs,
  }
}

// ---------------------------------------------------------------------------
// Drain / reap helpers
// ---------------------------------------------------------------------------

export interface DrainCheckResult {
  shouldStop: boolean
  stopReason?: 'timeout' | 'inactivity'
  details?: string
}

/**
 * Evaluate whether a single agent should be reaped during the drain loop.
 *
 * Pure function — does not mutate any state.  The orchestrator calls this
 * once per second per active agent inside `waitForAll`.
 */
export function evaluateDrainReap(
  agent: AgentProcess,
  now: number,
  timeoutConfig: TimeoutConfig,
  inactivityTimeoutOverride?: number,
): DrainCheckResult {
  const inactivityTimeout = inactivityTimeoutOverride ?? timeoutConfig.inactivityTimeoutMs
  const maxSessionTimeout = timeoutConfig.maxSessionTimeoutMs
  const timeSinceLastActivity = now - agent.lastActivityAt.getTime()
  const totalRuntime = now - agent.startedAt.getTime()

  if (maxSessionTimeout && totalRuntime > maxSessionTimeout) {
    return {
      shouldStop: true,
      stopReason: 'timeout',
      details: `total runtime ${Math.floor(totalRuntime / 1000)}s exceeded max ${Math.floor(maxSessionTimeout / 1000)}s`,
    }
  }

  if (timeSinceLastActivity > inactivityTimeout) {
    return {
      shouldStop: true,
      stopReason: 'inactivity',
      details: `inactive for ${Math.floor(timeSinceLastActivity / 1000)}s (limit ${Math.floor(inactivityTimeout / 1000)}s)`,
    }
  }

  return { shouldStop: false }
}

// ---------------------------------------------------------------------------
// Logging helpers for supervisor events
// ---------------------------------------------------------------------------

export function logMaxSessionTimeout(log: Logger | undefined, totalRuntime: number, maxSessionTimeout: number): void {
  log?.warn('Agent reached max session timeout', {
    totalRuntime: `${Math.floor(totalRuntime / 1000)}s`,
    maxSessionTimeout: `${Math.floor(maxSessionTimeout / 1000)}s`,
  })
}

export function logInactivityTimeout(log: Logger | undefined, timeSinceLastActivity: number, inactivityTimeout: number, lastActivityAt: Date): void {
  log?.warn('Agent timed out due to inactivity', {
    timeSinceLastActivity: `${Math.floor(timeSinceLastActivity / 1000)}s`,
    inactivityTimeout: `${Math.floor(inactivityTimeout / 1000)}s`,
    lastActivityAt: lastActivityAt.toISOString(),
  })
}
