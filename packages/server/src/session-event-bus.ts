/**
 * Session Event Bus
 *
 * Typed pub/sub for runtime session lifecycle events that the platform
 * mirror layer (agent_sessions.lastStepHeartbeat) and observability
 * subscribers consume.  Sibling of the per-step journal-event bus
 * shipped by earlier work, scoped to whole-session signals — heartbeats and
 * (future) cancel/recovery events from earlier work.
 *
 * Architecture references:
 *   - donmai-architecture/ADR-2026-04-29-long-running-runtime-substrate.md
 *     (commit 56f2bc6) — Decision 5 (heartbeat cadence), Decision 6
 *     (tenant-scoping JWT path), Decision 7 (hook event taxonomy lives in
 *     agentfactory-server).
 *   - Layer 6 hook bus (the pattern this module implements
 *     for session-scoped events).
 *
 * Design contract (mirrors the hook-bus contract):
 *   - Subscriber crashes are isolated per handler (try/catch + console.error).
 *     One bad subscriber MUST NOT break the others.
 *   - Filter on `kind` so the platform mirror can attach only to
 *     `session.heartbeat` and ignore everything else without paying the
 *     dispatch cost.
 *   - The bus is observability-grade: emit() returns Promise<void> but
 *     errors are swallowed inside emit().  Callers never see subscriber
 *     failures.
 */

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[session-event-bus] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[session-event-bus] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.error(`[session-event-bus] ${msg}`, data ? JSON.stringify(data) : ''),
}

// ---------------------------------------------------------------------------
// Event taxonomy
// ---------------------------------------------------------------------------

/**
 * `session.heartbeat` — emitted on the worker side every 15s while a
 * session has an in-flight step.  Subscribers (platform mirror,
 * observability dashboards) can detect drift by comparing `emittedAt` to
 * wall-clock and fire a `stuck` recovery flow when staleness exceeds
 * 60s (per ADR Decision 5).
 *
 * `workerId` is the agentfactory worker's registration id — the
 * platform-side governor uses it to disambiguate which worker is
 * responsible when multiple are processing different sessions.
 */
export type SessionLifecycleEvent =
  | {
      kind: 'session.heartbeat'
      sessionId: string
      workerId: string
      /** Unix ms — when the worker emitted this event */
      emittedAt: number
      /**
       * Currently executing step id, if known.  Useful for stale-step
       * forensics: a session may heartbeat but never advance, which is a
       * different signal from heartbeat-stale.
       */
      stepId?: string
    }
  | {
      kind: 'session.permission-denied'
      sessionId: string
      workerId: string
      emittedAt: number
      /**
       * Reason for the permission denial — e.g. `org-mismatch`,
       * `jwt-invalid`, `cedar-policy-block`.  Audit subscribers grade
       * these for downstream alerting.
       */
      reason: string
      /** Optional — the org claim from the JWT (only present on org-mismatch) */
      jobOrg?: string
      /** Optional — the org context the worker registered with */
      workerOrg?: string
    }
  /**
   * `session.cancel-requested` — a caller (UI, governor, parent agent) has
   * asked the runtime to wind this session down.  The agent observes this
   * between steps; the in-flight step completes by default unless the step
   * declared `interrupt: 'safe' | 'unsafe'` (per ADR Decision 4).  Layer 6
   * subscribers may surface the request in observability dashboards.
   */
  | {
      kind: 'session.cancel-requested'
      sessionId: string
      /** Unix ms — when the cancel was requested */
      requestedAt: number
      /** Optional — the principal that asked for the cancel. */
      requestedBy?: string
      /**
       * Optional — short reason string the caller passed in (free-form,
       * surfaced in UI / audit trails).
       */
      reason?: string
    }
  /**
   * `session.cancelled` — terminal hook event fired AFTER the in-flight
   * step has completed (or, for `interrupt: 'unsafe'`, after the worker
   * subprocess was killed).  Subscribers know the session won't make
   * forward progress without a new external trigger.
   */
  | {
      kind: 'session.cancelled'
      sessionId: string
      workerId: string
      /** Unix ms — when the cancel actually took effect (post-step). */
      cancelledAt: number
      /**
       * Last step that finished before the cancel took effect.  Useful
       * for resume-from-journal forensics: the next replay starts from
       * the journal entry whose `stepId` matches this value.
       */
      lastCompletedStepId?: string
      /**
       * `safe` (no-op or step finished naturally), `unsafe` (worker
       * subprocess was killed mid-step), or `cooperative` (default —
       * agent observed between steps and stopped cleanly).
       */
      mode: 'cooperative' | 'safe' | 'unsafe'
    }

export type SessionLifecycleEventKind = SessionLifecycleEvent['kind']

// ---------------------------------------------------------------------------
// Subscriber filter + handler
// ---------------------------------------------------------------------------

export interface SessionLifecycleEventFilter {
  /**
   * Only deliver events whose `kind` is in this set.  Omit to receive
   * every event the bus emits.
   */
  kinds?: SessionLifecycleEventKind[]
}

export type SessionLifecycleEventHandler = (event: SessionLifecycleEvent) => void | Promise<void>

interface SubscriberEntry {
  id: string
  filter: SessionLifecycleEventFilter
  handler: SessionLifecycleEventHandler
}

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

export class SessionEventBus {
  private readonly _subscribers: SubscriberEntry[] = []
  private _nextId = 0

  /**
   * Register a subscriber.  Returns an unsubscribe disposer.
   */
  subscribe(filter: SessionLifecycleEventFilter, handler: SessionLifecycleEventHandler): () => void {
    const id = String(this._nextId++)
    const entry: SubscriberEntry = { id, filter, handler }
    this._subscribers.push(entry)
    return () => this._unsubscribe(id)
  }

  private _unsubscribe(id: string): void {
    const idx = this._subscribers.findIndex((s) => s.id === id)
    if (idx !== -1) this._subscribers.splice(idx, 1)
  }

  /**
   * Emit an event.  Subscribers are awaited in registration order; a
   * crashing subscriber is isolated (logged + swallowed) so siblings
   * always run.  The promise resolves once every matching subscriber
   * has settled.
   */
  async emit(event: SessionLifecycleEvent): Promise<void> {
    const matching = this._subscribers.filter((s) => this._matches(s.filter, event))
    for (const sub of matching) {
      try {
        await sub.handler(event)
      } catch (err) {
        log.error('Subscriber threw', {
          subscriberId: sub.id,
          kind: event.kind,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /** Number of registered subscribers (test / diagnostics aid) */
  get subscriberCount(): number {
    return this._subscribers.length
  }

  /** Drop every subscriber (test teardown) */
  clear(): void {
    this._subscribers.length = 0
  }

  private _matches(filter: SessionLifecycleEventFilter, event: SessionLifecycleEvent): boolean {
    if (filter.kinds && filter.kinds.length > 0) {
      if (!filter.kinds.includes(event.kind)) return false
    }
    return true
  }
}

/**
 * The process-global session event bus.  Production wiring (the worker
 * runner in `@donmai/cli`) emits onto this bus; the
 * platform's `heartbeat-mirror.ts` subscribes to it via the
 * `attachHeartbeatMirror(bus)` helper.
 */
export const sessionEventBus = new SessionEventBus()
