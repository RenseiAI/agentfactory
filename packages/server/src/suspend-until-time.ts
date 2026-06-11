/**
 * Suspend-Until-Time Sweeper (Decision 4)
 *
 * Schedules a session to wake at a future Unix-ms timestamp.  Backed by a
 * Redis ZSET (`work:wake`) keyed by sessionId with score = wake-at; a 1Hz
 * sweeper promotes due entries by invoking the existing
 * `scheduling-queue.moveToBackoff(...)` path with `backoffMs = 0`, which
 * moves the work item back into the active queue at the next sweep tick.
 *
 * Architecture references:
 *   - donmai-architecture/ADR-2026-04-29-long-running-runtime-substrate.md
 *     (commit 56f2bc6) — Decision 4 (suspend-until-time semantics; 1Hz
 *     sweeper; sub-second precision NOT supported).
 *   - journal primitive (resume-after-wake reads the journal
 *     to skip steps already completed before suspension).
 *
 * Design contract:
 *   - The ZSET is durable (Redis persistence) so a worker restart loses
 *     no scheduled wake-ups.
 *   - The sweeper is process-global; multiple workers running in the
 *     same fleet may all run sweepers — the promotion step is
 *     idempotent (ZREM-then-promote in a pipeline, deduplicated by
 *     `moveToBackoff`'s underlying ZADD).
 *   - Sub-second precision is by design NOT a goal — the 1Hz tick is
 *     the granularity contract.  Callers needing finer resolution
 *     should use an in-process timer.
 */

import {
  isRedisConfigured,
  getRedisClient,
  redisZAdd,
  redisZRangeByScore,
  redisZRem,
  redisZCard,
} from './redis.js'
import { moveToBackoff } from './scheduling-queue.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[suspend-until-time] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[suspend-until-time] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.error(`[suspend-until-time] ${msg}`, data ? JSON.stringify(data) : ''),
}

// ---------------------------------------------------------------------------
// Redis key layout
// ---------------------------------------------------------------------------

/**
 * Wake-up sorted set.  Score = wake-at Unix ms; member = sessionId.  The
 * key is a single global set rather than per-session so the 1Hz sweeper
 * can use a single `ZRANGEBYSCORE` to find every session whose wake
 * window has passed.
 */
export const WAKE_QUEUE_KEY = 'work:wake'

/**
 * 1 Hz sweeper cadence (per ADR Decision 4).  Override via the
 * `SUSPEND_SWEEPER_INTERVAL_MS` environment variable for tests.
 */
export const DEFAULT_SWEEPER_INTERVAL_MS = 1_000

/** Resolve the sweeper interval from env (with a hard floor of 100ms). */
export function getSweeperIntervalMs(): number {
  const raw = process.env.SUSPEND_SWEEPER_INTERVAL_MS
  if (raw) {
    const parsed = parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed >= 100) return parsed
  }
  return DEFAULT_SWEEPER_INTERVAL_MS
}

// ---------------------------------------------------------------------------
// Public API — schedule a wake
// ---------------------------------------------------------------------------

/**
 * Schedule a session to wake at `wakeAtMs` (Unix ms).  If the timestamp
 * is in the past, the session is eligible at the next sweep tick.
 *
 * The ZSET ZADD is upsert-style — calling `suspendUntil` twice for the
 * same session updates the wake time without duplicating the entry.
 * Returns `true` if the entry was recorded (or updated), `false` on
 * Redis errors / not configured.
 */
export async function suspendUntil(
  sessionId: string,
  wakeAtMs: number,
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, cannot schedule suspend-until-time', {
      sessionId,
    })
    return false
  }
  if (!Number.isFinite(wakeAtMs)) {
    log.warn('suspendUntil called with non-finite wakeAtMs; ignoring', {
      sessionId,
      wakeAtMs,
    })
    return false
  }
  try {
    await redisZAdd(WAKE_QUEUE_KEY, wakeAtMs, sessionId)
    log.info('Session suspended-until-time scheduled', {
      sessionId,
      wakeAtMs,
      delayMs: wakeAtMs - Date.now(),
    })
    return true
  } catch (error) {
    log.error('Failed to schedule suspend-until-time', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Cancel a previously-scheduled wake-up.  Returns `true` if the entry
 * existed and was removed, `false` otherwise.  Useful when the parent
 * task decides to abandon the suspended session early (e.g. a cancel
 * request races a wake-up timer).
 */
export async function cancelScheduledWake(sessionId: string): Promise<boolean> {
  if (!isRedisConfigured()) return false
  try {
    const removed = await redisZRem(WAKE_QUEUE_KEY, sessionId)
    return removed > 0
  } catch (error) {
    log.error('Failed to cancel scheduled wake', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/** Number of sessions currently scheduled to wake. */
export async function pendingWakeCount(): Promise<number> {
  if (!isRedisConfigured()) return 0
  try {
    return await redisZCard(WAKE_QUEUE_KEY)
  } catch (error) {
    log.error('Failed to count pending wakes', {
      error: error instanceof Error ? error.message : String(error),
    })
    return 0
  }
}

// ---------------------------------------------------------------------------
// Sweeper — promote due entries
// ---------------------------------------------------------------------------

export interface SweepResult {
  /** Sessions that were promoted on this tick. */
  promoted: string[]
  /** Sessions whose ZSET entry was removed but had no upstream work item. */
  orphaned: string[]
}

/**
 * Promoter callback — invoked for each due session.  The default
 * implementation routes through `scheduling-queue.moveToBackoff` with
 * `backoffMs = 0` (so the session is immediately promotable on the
 * next backoff sweep) but tests / advanced consumers may override.
 */
export type WakePromoter = (sessionId: string) => Promise<boolean>

/**
 * Default promoter — uses the existing scheduling-queue surface.  Calls
 * `moveToBackoff(sessionId, 'wake-from-suspend', 0)` so the session is
 * eligible to promote back into the active queue on the next backoff
 * sweep tick (which the existing scheduler already runs).
 *
 * Returns `true` if the work item was found in the active queue (the
 * usual case after a `moveToBackoff` cycle when a worker chose to
 * suspend).  Returns `false` if the work item is not currently in the
 * active queue — this is benign (the session may already be running on
 * a different worker, or its work entry expired), and the sweeper
 * treats it as an orphan and continues.
 */
export const defaultWakePromoter: WakePromoter = async (sessionId: string) => {
  // backoffMs=0 ensures the next promote-from-backoff cycle picks it up
  return moveToBackoff(sessionId, 'wake-from-suspend', 0)
}

/**
 * Run a single sweep tick.  Returns the sessions promoted / orphaned
 * during this tick.  Useful for tests (deterministic single-shot) and
 * for callers wiring their own scheduler loop.
 */
export async function sweepWakeQueue(
  promoter: WakePromoter = defaultWakePromoter,
): Promise<SweepResult> {
  const result: SweepResult = { promoted: [], orphaned: [] }

  if (!isRedisConfigured()) return result

  try {
    const now = Date.now()
    const due = await redisZRangeByScore(WAKE_QUEUE_KEY, '-inf', now)
    if (due.length === 0) return result

    for (const sessionId of due) {
      try {
        // ZREM first so a slow promoter doesn't double-fire the wake on
        // the next tick.  This is the same pattern used by
        // `promoteFromBackoff` in scheduling-queue.ts.
        const redis = getRedisClient()
        const removed = await redis.zrem(WAKE_QUEUE_KEY, sessionId)
        if (removed === 0) {
          // Another sweeper raced us; benign.
          continue
        }

        const ok = await promoter(sessionId)
        if (ok) {
          result.promoted.push(sessionId)
        } else {
          result.orphaned.push(sessionId)
        }
      } catch (perEntryErr) {
        log.warn('Sweeper failed to promote individual entry', {
          sessionId,
          error:
            perEntryErr instanceof Error ? perEntryErr.message : String(perEntryErr),
        })
      }
    }

    if (result.promoted.length > 0 || result.orphaned.length > 0) {
      log.info('Wake queue sweep complete', {
        promoted: result.promoted.length,
        orphaned: result.orphaned.length,
      })
    }

    return result
  } catch (error) {
    log.error('Wake queue sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return result
  }
}

// ---------------------------------------------------------------------------
// Long-running sweeper loop
// ---------------------------------------------------------------------------

export interface SweeperOptions {
  intervalMs?: number
  promoter?: WakePromoter
  /**
   * Optional callback fired after every tick so callers can hook
   * observability (counts of promoted / orphaned sessions).
   */
  onTick?: (result: SweepResult) => void
}

export interface SweeperHandle {
  /** Stop the loop.  Idempotent. */
  stop(): void
  /** Fire one tick manually (used by tests). */
  tick(): Promise<SweepResult>
  /** True once stop() has been called. */
  readonly stopped: boolean
}

/**
 * Start the 1Hz suspend-until-time sweeper.  The first tick fires
 * synchronously to flush any wake-ups whose timestamp already passed
 * before the sweeper started.
 */
export function startSuspendSweeper(options: SweeperOptions = {}): SweeperHandle {
  const intervalMs = options.intervalMs ?? getSweeperIntervalMs()
  const promoter = options.promoter ?? defaultWakePromoter

  let intervalHandle: ReturnType<typeof setInterval> | null = null
  let stopped = false

  async function tick(): Promise<SweepResult> {
    if (stopped) return { promoted: [], orphaned: [] }
    const result = await sweepWakeQueue(promoter)
    if (options.onTick) {
      try {
        options.onTick(result)
      } catch (err) {
        log.warn('Sweeper onTick callback threw (ignored)', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return result
  }

  // Fire first tick immediately for past-due entries.
  void tick()

  intervalHandle = setInterval(() => {
    void tick()
  }, intervalMs)
  // Don't keep the process alive on the sweeper alone.
  intervalHandle.unref()

  return {
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
