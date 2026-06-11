/**
 * Session-attribution subscriber — tags hook events with session metadata.
 *
 * Architecture reference: donmai-architecture/002-provider-base-contract.md §Lifecycle hooks
 *
 * Purpose:
 *   Every hook event that touches a provider is correlated with the active
 *   session (LINEAR_SESSION_ID, LINEAR_ISSUE_ID, LINEAR_WORK_TYPE, etc.).
 *   The subscriber writes structured attribution records to a configurable
 *   sink (default: in-memory store, optionally NDJSON or custom sink).
 *
 * Session context is read from:
 *   - Environment variables (LINEAR_SESSION_ID, LINEAR_ISSUE_ID, etc.)
 *   - An explicit SessionContext object passed at registration time.
 *   - A context resolver function (dynamic sessions).
 *
 * The subscriber is opt-in: call registerSessionAttributionSubscriber(bus) to attach.
 */

import type { ProviderHookEvent } from '../../providers/base.js'
import type { HookBus, SubscriberFilter } from '../hooks.js'

// ---------------------------------------------------------------------------
// SessionContext — the metadata that gets attached to events
// ---------------------------------------------------------------------------

/**
 * Session metadata read from the environment or provided explicitly.
 *
 * Named HookSessionContext to avoid collision with orchestrator's SessionContext.
 */
export interface HookSessionContext {
  /** LINEAR_SESSION_ID or equivalent unique session identifier. */
  sessionId: string | undefined
  /** LINEAR_ISSUE_ID — the issue being worked on. */
  issueId: string | undefined
  /** LINEAR_WORK_TYPE — development, qa, acceptance, etc. */
  workType: string | undefined
  /** LINEAR_TEAM_NAME — the Linear team name. */
  teamName: string | undefined
  /** Any additional custom tags. */
  tags?: Record<string, string>
}

/** Resolve the current session context. */
export type HookSessionContextResolver = () => HookSessionContext

/** Read HookSessionContext from standard environment variables. */
export function readSessionContextFromEnv(): HookSessionContext {
  return {
    sessionId: process.env.LINEAR_SESSION_ID,
    issueId: process.env.LINEAR_ISSUE_ID,
    workType: process.env.LINEAR_WORK_TYPE,
    teamName: process.env.LINEAR_TEAM_NAME,
  }
}

// ---------------------------------------------------------------------------
// AttributionRecord — what the subscriber writes
// ---------------------------------------------------------------------------

export interface AttributionRecord {
  ts: string
  kind: ProviderHookEvent['kind']
  provider?: { id: string; family: string; version: string }
  session: HookSessionContext
}

// ---------------------------------------------------------------------------
// Attribution sink
// ---------------------------------------------------------------------------

/** A sink that receives attribution records. */
export interface AttributionSink {
  write(record: AttributionRecord): void | Promise<void>
}

/** In-memory attribution sink (for testing and introspection). */
export class InMemoryAttributionSink implements AttributionSink {
  readonly records: AttributionRecord[] = []

  write(record: AttributionRecord): void {
    this.records.push(record)
  }

  /** Clear all recorded attribution records. */
  clear(): void {
    this.records.length = 0
  }
}

/** No-op attribution sink — discards all records. */
export class NoopAttributionSink implements AttributionSink {
  write(_record: AttributionRecord): void {}
}

// ---------------------------------------------------------------------------
// Event → AttributionRecord
// ---------------------------------------------------------------------------

function eventToAttribution(
  event: ProviderHookEvent,
  session: HookSessionContext,
): AttributionRecord {
  const ts = new Date().toISOString()

  // Agent-tool-use events (added 2026-05-12) carry their own sessionId on the
  // event payload — this is authoritative for cross-process providers that
  // can't rely on the host process's env vars (the Go daemon emits via a
  // platform-side bridge whose env doesn't match the runner's). Prefer the
  // event-borne sessionId when present.
  const effectiveSession: HookSessionContext =
    'sessionId' in event && typeof event.sessionId === 'string' && event.sessionId
      ? { ...session, sessionId: event.sessionId }
      : session

  const record: AttributionRecord = { ts, kind: event.kind, session: effectiveSession }

  if ('provider' in event && event.provider) {
    record.provider = {
      id: event.provider.id,
      family: event.provider.family,
      version: event.provider.version,
    }
  }

  return record
}

// ---------------------------------------------------------------------------
// Subscriber registration
// ---------------------------------------------------------------------------

export interface SessionAttributionSubscriberOptions {
  /**
   * How to resolve the current session context.
   * - Pass a HookSessionContext object for a static session.
   * - Pass a function for a dynamic resolver (called per event).
   * - Omit to read from env vars each time.
   */
  context?: HookSessionContext | HookSessionContextResolver

  /**
   * Where to write attribution records.
   * Defaults to InMemoryAttributionSink (records accessible via .sink.records).
   */
  sink?: AttributionSink

  /**
   * Event filter. Defaults to all events.
   */
  filter?: SubscriberFilter

  /**
   * Only write attribution records when a session is active
   * (i.e., sessionId is defined). Default: false (always write).
   */
  requireSession?: boolean
}

export interface SessionAttributionSubscriberHandle {
  /** Call to detach the subscriber from the bus. */
  unsubscribe: () => void
  /** The sink being written to (cast as InMemoryAttributionSink for inspection). */
  sink: AttributionSink
}

/**
 * Register the session-attribution subscriber on the given bus.
 * Returns a handle with an unsubscribe function and a reference to the sink.
 *
 * @example
 * import { globalHookBus } from '../hooks.js'
 * import { registerSessionAttributionSubscriber } from './session-attribution.js'
 *
 * const { unsubscribe, sink } = registerSessionAttributionSubscriber(globalHookBus)
 * // sink is an InMemoryAttributionSink — inspect sink.records for attribution data
 */
export function registerSessionAttributionSubscriber(
  bus: HookBus,
  options: SessionAttributionSubscriberOptions = {},
): SessionAttributionSubscriberHandle {
  const sink = options.sink ?? new InMemoryAttributionSink()
  const filter = options.filter ?? {}
  const requireSession = options.requireSession ?? false

  const resolver: HookSessionContextResolver =
    typeof options.context === 'function'
      ? options.context
      : options.context
      ? () => options.context as HookSessionContext
      : readSessionContextFromEnv

  const unsubscribe = bus.subscribe(filter, async (event) => {
    const session = resolver()
    if (requireSession && !session.sessionId) return
    const record = eventToAttribution(event, session)
    await sink.write(record)
  })

  return { unsubscribe, sink }
}
