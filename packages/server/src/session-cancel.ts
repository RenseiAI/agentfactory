/**
 * Session Cancel Coordinator (Decision 4)
 *
 * Cooperative cancel for the long-running runtime substrate.  External
 * callers (UI, governor, parent agent) signal `requestSessionCancel`;
 * workers observe between steps via `isCancelRequested` and emit a final
 * `session.cancelled` event when the in-flight step completes.
 *
 * Architecture references:
 *   - donmai-architecture/ADR-2026-04-29-long-running-runtime-substrate.md
 *     (commit 56f2bc6) — Decision 4 (cancel/resume semantics).
 *   - Layer 6 hook bus (where cancel events surface).
 *   - journal primitive (resume-from-journal consumes the same
 *     `listSessionJournal` API to determine the last completed step).
 *
 * Design contract:
 *   - The cancel signal is a Redis SETNX with TTL — durable across worker
 *     restarts, no thundering-herd if multiple callers race the request.
 *   - Cancel observation is between-step.  Mid-step interrupt is opt-in
 *     per step via `interrupt: 'safe' | 'unsafe'` (see `step-runner.ts`).
 *   - Failures in the bus emit are isolated; the cancel itself is
 *     authoritative once the Redis flag is set.
 *   - The `session.cancel-requested` event is emitted from
 *     `requestSessionCancel`; the matching `session.cancelled` event is
 *     emitted by the worker once the in-flight step has finished
 *     (or, for `unsafe`, the subprocess was killed).
 */

import { isRedisConfigured, redisSet, redisGet, redisDel } from './redis.js'
import { sessionEventBus, type SessionEventBus } from './session-event-bus.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[session-cancel] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[session-cancel] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.error(`[session-cancel] ${msg}`, data ? JSON.stringify(data) : ''),
}

// ---------------------------------------------------------------------------
// Redis key layout
// ---------------------------------------------------------------------------

/**
 * Cancel signal key — durable until the worker observes the cancel and
 * fires the terminal `session.cancelled` event, after which the key is
 * cleared by `clearCancel`.
 */
export function cancelKey(sessionId: string): string {
  return `session:cancel:${sessionId}`
}

/**
 * Default TTL for the cancel flag — long enough that even a 30-minute
 * step completion window observes the request, short enough that a
 * forgotten flag from a crashed pre-emption attempt eventually drains.
 */
export const DEFAULT_CANCEL_TTL_SECONDS = 60 * 60 // 1 hour

// ---------------------------------------------------------------------------
// Persisted cancel record
// ---------------------------------------------------------------------------

/**
 * The shape of the JSON value stored at `session:cancel:{sessionId}`.
 * `requestedAt` lets observers compute waiting time; `requestedBy` is
 * surfaced in audit trails; `reason` is free-form and shown in UI.
 */
export interface CancelRecord {
  sessionId: string
  requestedAt: number
  requestedBy?: string
  reason?: string
  /**
   * Per-session interrupt preference.  Workers consume this when
   * deciding whether to cooperate (safe) or hard-kill (unsafe) on the
   * in-flight step.  The per-step `interrupt` config still wins; this
   * field is the session-level default the runner consults when the
   * step did not declare its own preference.
   */
  interrupt?: 'safe' | 'unsafe'
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RequestCancelOptions {
  requestedBy?: string
  reason?: string
  interrupt?: 'safe' | 'unsafe'
  /** Override the default 1h TTL (test only). */
  ttlSeconds?: number
  /** Override the bus the `session.cancel-requested` event fires on. */
  bus?: SessionEventBus
}

/**
 * Signal that a session should be cancelled.  Returns `true` if the
 * signal was newly recorded; returns `false` if a prior cancel for the
 * same session was already pending (idempotent — no double-emit).
 *
 * The `session.cancel-requested` Layer 6 event fires on success.  The
 * matching `session.cancelled` terminal event is the worker's
 * responsibility once it observes the flag and the in-flight step has
 * finished (see `confirmSessionCancelled`).
 */
export async function requestSessionCancel(
  sessionId: string,
  options: RequestCancelOptions = {},
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot record cancel signal', { sessionId })
    return false
  }

  const requestedAt = Date.now()
  const record: CancelRecord = {
    sessionId,
    requestedAt,
    ...(options.requestedBy !== undefined && { requestedBy: options.requestedBy }),
    ...(options.reason !== undefined && { reason: options.reason }),
    ...(options.interrupt !== undefined && { interrupt: options.interrupt }),
  }

  try {
    // Check whether a prior cancel is already pending.  We don't use
    // SETNX here because the value carries the requestedAt — we want a
    // first-writer-wins guarantee, but read-then-write is fine: a race
    // between two callers is benign (latest reason wins, idempotent
    // observation).
    const existing = await redisGet<CancelRecord>(cancelKey(sessionId))
    if (existing) {
      log.info('Cancel already pending — idempotent re-request', {
        sessionId,
        firstRequestedAt: existing.requestedAt,
      })
      return false
    }

    await redisSet(
      cancelKey(sessionId),
      record,
      options.ttlSeconds ?? DEFAULT_CANCEL_TTL_SECONDS,
    )

    const bus = options.bus ?? sessionEventBus
    // Bus emit is fire-and-forget — subscribers (UI, observability) may
    // crash but the cancel signal itself is durable in Redis.
    try {
      await bus.emit({
        kind: 'session.cancel-requested',
        sessionId,
        requestedAt,
        ...(options.requestedBy !== undefined && { requestedBy: options.requestedBy }),
        ...(options.reason !== undefined && { reason: options.reason }),
      })
    } catch (err) {
      log.error('Bus emit threw on session.cancel-requested (defensive)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    log.info('Cancel signal recorded', {
      sessionId,
      requestedBy: options.requestedBy,
      interrupt: options.interrupt ?? 'cooperative',
    })
    return true
  } catch (error) {
    log.error('Failed to record cancel signal', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Read the persisted cancel record for a session, or null if no cancel
 * is pending / Redis is unavailable.
 */
export async function readCancelRecord(
  sessionId: string,
): Promise<CancelRecord | null> {
  if (!isRedisConfigured()) return null
  try {
    return await redisGet<CancelRecord>(cancelKey(sessionId))
  } catch (error) {
    log.error('Failed to read cancel record', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Convenience boolean wrapper around `readCancelRecord`.  Workers call
 * this between steps; when it returns `true` the loop exits and the
 * runner emits the terminal `session.cancelled` event.
 */
export async function isCancelRequested(sessionId: string): Promise<boolean> {
  const record = await readCancelRecord(sessionId)
  return record !== null
}

export interface ConfirmCancelOptions {
  workerId: string
  /**
   * The last step the worker successfully finished before observing the
   * cancel.  Used by resume-from-journal forensics; the platform mirror
   * uses it to display "stopped after step X" in the UI.
   */
  lastCompletedStepId?: string
  /** How the cancel actually took effect — see SessionLifecycleEvent. */
  mode?: 'cooperative' | 'safe' | 'unsafe'
  /** Override the bus the `session.cancelled` event fires on. */
  bus?: SessionEventBus
  /**
   * If true, leave the cancel record in Redis (default false; we clear
   * after a successful cancel so a future re-run isn't blocked).
   */
  retainRecord?: boolean
}

/**
 * Confirm that a previously-requested cancel has taken effect.  The
 * worker calls this once the in-flight step has finished and it is
 * about to exit the session loop.
 *
 * Emits the terminal `session.cancelled` event and (unless
 * `retainRecord` is true) clears the cancel flag from Redis.
 */
export async function confirmSessionCancelled(
  sessionId: string,
  options: ConfirmCancelOptions,
): Promise<void> {
  const cancelledAt = Date.now()
  const bus = options.bus ?? sessionEventBus

  try {
    await bus.emit({
      kind: 'session.cancelled',
      sessionId,
      workerId: options.workerId,
      cancelledAt,
      ...(options.lastCompletedStepId !== undefined && {
        lastCompletedStepId: options.lastCompletedStepId,
      }),
      mode: options.mode ?? 'cooperative',
    })
  } catch (err) {
    log.error('Bus emit threw on session.cancelled (defensive)', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (!options.retainRecord) {
    try {
      await clearCancel(sessionId)
    } catch (err) {
      log.warn('Failed to clear cancel flag (non-fatal)', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  log.info('Session cancel confirmed', {
    sessionId,
    workerId: options.workerId,
    mode: options.mode ?? 'cooperative',
  })
}

/**
 * Clear the cancel signal — used by the worker after it has emitted
 * `session.cancelled`, and by tests for cleanup.
 */
export async function clearCancel(sessionId: string): Promise<boolean> {
  if (!isRedisConfigured()) return false
  try {
    const removed = await redisDel(cancelKey(sessionId))
    return removed > 0
  } catch (error) {
    log.error('Failed to clear cancel flag', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
