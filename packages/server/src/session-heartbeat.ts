/**
 * Session Heartbeat Emitter (Decision 5)
 *
 * Drives the 15s step-level heartbeat loop a worker maintains while a
 * session has an in-flight step.  Each tick fires a
 * `session.heartbeat` event on the SessionEventBus (consumed by the
 * platform mirror — `agent_sessions.lastStepHeartbeat`) and also writes
 * a fast-path Redis pointer so peer workers and the governor can
 * cheaply check liveness without a Postgres round-trip.
 *
 * Architecture references:
 *   - donmai-architecture/ADR-2026-04-29-long-running-runtime-substrate.md
 *     (commit 56f2bc6) — Decision 5 (15s cadence; 60s stale threshold).
 *   - donmai-architecture/001-layered-execution-model.md §Layer 6 —
 *     hook bus emission contract.
 *
 * Lifecycle:
 *   const hb = createSessionHeartbeat({ sessionId, workerId, bus })
 *   hb.start(stepId)    // begin the 15s loop and emit the first tick
 *   ...                 // step runs
 *   hb.stop()           // cancel the timer (always called in finally)
 *
 * Design decisions:
 *   - The first heartbeat fires synchronously inside start() so the
 *     mirror is updated immediately on step start.  Later ticks run on
 *     a setInterval; clearInterval in stop() is idempotent.
 *   - Redis writes are best-effort: a Redis outage MUST NOT crash the
 *     worker.  We log a warning and keep ticking.
 *   - The bus emit is fire-and-forget (we await it but the bus catches
 *     subscriber errors itself).  A subscriber crash never disturbs
 *     the heartbeat loop.
 *   - The instance ref-tracks the timer so stop() called more than once
 *     is a no-op, matching the existing HeartbeatWriter contract in
 *     `packages/core/src/orchestrator/heartbeat-writer.ts`.
 */

import { isRedisConfigured, redisSet } from './redis.js'
import { sessionEventBus, type SessionEventBus } from './session-event-bus.js'
import { touchSessionHeartbeat } from './session-storage.js'

/**
 * 15-second heartbeat cadence (per ADR Decision 5).  Override via the
 * `SESSION_HEARTBEAT_INTERVAL_MS` environment variable for tests; never
 * change in production code.
 */
export const DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS = 15_000

/**
 * 60-second stale threshold (per ADR Decision 5).  When a session has
 * not heartbeat for this long, the governor flags it as `stuck` and
 * triggers the recovery flow on the platform side.  This constant is
 * exported so the platform's stale-detection job can reference the
 * same number.
 */
export const SESSION_STALE_THRESHOLD_MS = 60_000

/** Resolve the cadence from env (with a hard floor of 1s). */
export function getHeartbeatIntervalMs(): number {
  const raw = process.env.SESSION_HEARTBEAT_INTERVAL_MS
  if (raw) {
    const parsed = parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed >= 1_000) return parsed
  }
  return DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS
}

/**
 * Redis key shape for the fast-path pointer.  Mirrors the journal-key
 * shape established earlier for visual consistency.
 */
export function heartbeatRedisKey(sessionId: string): string {
  return `session:heartbeat:${sessionId}`
}

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[session-heartbeat] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[session-heartbeat] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.error(`[session-heartbeat] ${msg}`, data ? JSON.stringify(data) : ''),
}

export interface SessionHeartbeatOptions {
  sessionId: string
  workerId: string
  /**
   * The bus to emit on.  Defaults to the process-global
   * `sessionEventBus`; tests inject their own.
   */
  bus?: SessionEventBus
  /** Override the 15s cadence (test only). */
  intervalMs?: number
  /**
   * Optional Redis writer override.  The default uses the production
   * Redis client; tests can pass a stub to avoid Redis.
   */
  redisWriter?: (key: string, value: string, ttlSeconds: number) => Promise<void>
}

export interface SessionHeartbeatHandle {
  /** Begin the heartbeat loop for the given (optional) step id. */
  start(stepId?: string): void
  /** Stop the loop. Idempotent — safe to call from finally. */
  stop(): void
  /** Manually fire one tick (used by tests + by start()). */
  tick(): Promise<void>
  /** True once stop() has been called. */
  readonly stopped: boolean
}

/**
 * Construct a session heartbeat handle.  The handle is single-use:
 * after stop() the loop cannot be restarted (matching the
 * HeartbeatWriter contract).
 */
export function createSessionHeartbeat(
  options: SessionHeartbeatOptions
): SessionHeartbeatHandle {
  const intervalMs = options.intervalMs ?? getHeartbeatIntervalMs()
  const bus = options.bus ?? sessionEventBus
  const redisWriter = options.redisWriter ?? defaultRedisWriter

  let intervalHandle: ReturnType<typeof setInterval> | null = null
  let stepId: string | undefined
  let stopped = false

  async function tick(): Promise<void> {
    if (stopped) return

    const emittedAt = Date.now()

    // Best-effort Redis pointer for peer workers + governor.  A failure
    // here MUST NOT break the bus emit — the platform mirror is the
    // authoritative pointer for forensics.
    try {
      const ttlSeconds = Math.ceil((intervalMs * 4) / 1000) // 4 ticks of grace
      await redisWriter(
        heartbeatRedisKey(options.sessionId),
        JSON.stringify({
          sessionId: options.sessionId,
          workerId: options.workerId,
          emittedAt,
          ...(stepId !== undefined && { stepId }),
        }),
        ttlSeconds,
      )
    } catch (err) {
      log.warn('Redis heartbeat pointer write failed (non-fatal)', {
        sessionId: options.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Heartbeat-couple the session row's `updatedAt` so a long-running session
    // keeps its row fresh and is never mistaken for a strand by orphan cleanup.
    // Best-effort: a failure here MUST NOT disturb the heartbeat loop.
    try {
      await touchSessionHeartbeat(options.sessionId)
    } catch (err) {
      log.warn('Session row heartbeat touch failed (non-fatal)', {
        sessionId: options.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Re-check stopped after the Redis await — stop() may have run while
    // we were waiting and we MUST NOT emit a heartbeat for a torn-down
    // session.  This keeps the bus quiet after stop() in tight tests.
    if (stopped) return

    // Bus emit is fire-and-forget but awaited so subscribers complete
    // before the next tick.  The bus catches subscriber crashes.
    try {
      await bus.emit({
        kind: 'session.heartbeat',
        sessionId: options.sessionId,
        workerId: options.workerId,
        emittedAt,
        ...(stepId !== undefined && { stepId }),
      })
    } catch (err) {
      // SessionEventBus.emit is already swallow-on-error, so this
      // catch is defensive — log and keep ticking.
      log.error('Bus emit threw (defensive catch)', {
        sessionId: options.sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    start(nextStepId?: string): void {
      if (stopped) {
        log.warn('Heartbeat already stopped, refusing to restart', {
          sessionId: options.sessionId,
        })
        return
      }
      if (intervalHandle !== null) {
        // Already running — just update stepId and let next tick pick it up.
        stepId = nextStepId
        return
      }
      stepId = nextStepId

      // Fire the first tick immediately so the mirror updates on step
      // start without a 15s lag.
      void tick()

      intervalHandle = setInterval(() => {
        void tick()
      }, intervalMs)

      // Don't keep the process alive on tick alone; the worker runner
      // owns the lifecycle.
      intervalHandle.unref()
    },

    stop(): void {
      if (stopped) return
      stopped = true
      if (intervalHandle !== null) {
        clearInterval(intervalHandle)
        intervalHandle = null
      }
    },

    tick,

    get stopped(): boolean {
      return stopped
    },
  }
}

/**
 * Default Redis writer — uses the production client when configured,
 * otherwise no-ops.  The interval emit path is unaffected if Redis is
 * down; only the fast-path pointer is missed.
 */
async function defaultRedisWriter(
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  if (!isRedisConfigured()) return
  await redisSet(key, value, ttlSeconds)
}
