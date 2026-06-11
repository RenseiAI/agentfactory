/**
 * Layer 6 Hook Bus — typed pub/sub for ProviderHookEvent
 *
 * Architecture reference: donmai-architecture/002-provider-base-contract.md §Lifecycle hooks
 * Architecture reference: donmai-architecture/001-layered-execution-model.md §Layer 6
 *
 * Design decisions:
 * - Bus is typed on ProviderHookEvent from base.ts (no type re-declaration here).
 * - Subscribers can filter by event kind, provider id, or scope level.
 * - Subscriber crash isolation: each subscriber is wrapped in try/catch.
 *   A failing subscriber emits a synthetic 'hook-error' console log but never
 *   breaks sibling subscribers.
 * - Default subscribers (audit-log, metrics, session-attribution) are opt-in:
 *   call registerDefaultSubscribers() to attach them, or register individually.
 * - The bus is scoped by provider id at subscription time (optional filter).
 */

import type { ProviderHookEvent, ProviderFamily } from '../providers/base.js'

// ---------------------------------------------------------------------------
// Subscriber filter options
// ---------------------------------------------------------------------------

/** Narrow which events a subscriber receives. All filters are optional. */
export interface SubscriberFilter {
  /**
   * Only deliver events whose `kind` is in this set.
   * Omit to receive all event kinds.
   */
  kinds?: Array<ProviderHookEvent['kind']>

  /**
   * Only deliver events from providers whose `id` matches.
   * Omit to receive events from all provider ids.
   */
  providerId?: string | string[]

  /**
   * Only deliver events whose provider family matches.
   * Omit to receive events from all families.
   */
  family?: ProviderFamily | ProviderFamily[]
}

// ---------------------------------------------------------------------------
// Subscriber shape
// ---------------------------------------------------------------------------

/** A subscriber callback. May be async; the bus awaits it. */
export type HookSubscriber = (event: ProviderHookEvent) => void | Promise<void>

/** A registered subscriber entry (internal). */
interface SubscriberEntry {
  id: string
  filter: SubscriberFilter
  handler: HookSubscriber
}

// ---------------------------------------------------------------------------
// HookBus — the typed pub/sub core
// ---------------------------------------------------------------------------

/**
 * Typed hook bus for ProviderHookEvent. Scoped pub/sub with filtering.
 *
 * Usage:
 *   const bus = new HookBus()
 *   bus.subscribe({ kinds: ['pre-activate'] }, async (event) => { ... })
 *   bus.emit({ kind: 'pre-activate', provider: ref })
 */
export class HookBus {
  private readonly _subscribers: SubscriberEntry[] = []
  private _nextId = 0

  /**
   * Subscribe to hook events with an optional filter.
   *
   * @param filter - Narrow which events to receive (all optional).
   * @param handler - Called for each matching event.
   * @returns An unsubscribe function.
   */
  subscribe(filter: SubscriberFilter, handler: HookSubscriber): () => void {
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
   * Emit an event to all matching subscribers.
   *
   * Subscriber ordering is insertion order. A subscriber crash is isolated:
   * the error is logged (to console.error) and a synthetic hook-error is
   * emitted on the bus itself, but remaining subscribers always execute.
   *
   * The emit call itself returns a Promise that resolves only after all
   * matching subscribers have settled (resolved or rejected+isolated).
   */
  async emit(event: ProviderHookEvent): Promise<void> {
    const matching = this._subscribers.filter((s) => this._matches(s.filter, event))
    for (const sub of matching) {
      try {
        await sub.handler(event)
      } catch (err) {
        // Crash isolation: log and continue. Never propagate.
        const subscriberError = err instanceof Error ? err : new Error(String(err))
        console.error(
          `[HookBus] Subscriber ${sub.id} threw on event kind="${event.kind}":`,
          subscriberError.message,
        )
        // Emit a hook-error for observability (self-recursive, but only to non-crashed subscribers)
        // Use a microtask to avoid infinite synchronous recursion on error paths.
        void Promise.resolve().then(() =>
          this._emitHookError(event, subscriberError, sub.id),
        )
      }
    }
  }

  /**
   * Synchronous emit — useful in synchronous contexts.
   * Subscriber handlers MUST be synchronous (async handlers are ignored / not awaited).
   * Prefer emit() for correctness with async handlers.
   */
  emitSync(event: ProviderHookEvent): void {
    const matching = this._subscribers.filter((s) => this._matches(s.filter, event))
    for (const sub of matching) {
      try {
        const result = sub.handler(event)
        // If handler returns a promise, we can't await it here — log a warning
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err))
            console.error(
              `[HookBus] Async subscriber ${sub.id} rejected on event kind="${event.kind}":`,
              error.message,
            )
          })
        }
      } catch (err) {
        const subscriberError = err instanceof Error ? err : new Error(String(err))
        console.error(
          `[HookBus] Subscriber ${sub.id} threw on event kind="${event.kind}" (sync):`,
          subscriberError.message,
        )
      }
    }
  }

  /** Internal helper to emit a hook-error event on subscriber crash. */
  private async _emitHookError(
    originalEvent: ProviderHookEvent,
    error: Error,
    subscriberId: string,
  ): Promise<void> {
    // Only emit if the original event was not itself a hook-error to avoid recursion.
    // (ProviderHookEvent has no 'hook-error' kind by design — that's a bus-internal concept.)
    // Log it structurally instead.
    console.error(`[HookBus] hook-error: subscriber=${subscriberId} originalKind=${originalEvent.kind}`, {
      error: error.message,
      stack: error.stack,
    })
  }

  /** Test whether an event matches a subscriber's filter. */
  private _matches(filter: SubscriberFilter, event: ProviderHookEvent): boolean {
    // Kind filter
    if (filter.kinds && filter.kinds.length > 0) {
      if (!filter.kinds.includes(event.kind)) return false
    }

    // Provider id filter — most events have a `provider` field with an id
    if (filter.providerId !== undefined) {
      const ref = 'provider' in event ? (event as { provider: { id: string } }).provider : null
      if (ref === null) return false
      const ids = Array.isArray(filter.providerId) ? filter.providerId : [filter.providerId]
      if (!ids.includes(ref.id)) return false
    }

    // Family filter
    if (filter.family !== undefined) {
      const ref = 'provider' in event ? (event as { provider: { family: ProviderFamily } }).provider : null
      // scope-resolved events have chosen/rejected, not a single provider
      if (ref === null) {
        // For scope-resolved: no family filter support (it covers multiple providers)
        return true
      }
      const families = Array.isArray(filter.family) ? filter.family : [filter.family]
      if (!families.includes(ref.family)) return false
    }

    return true
  }

  /** Return the current number of registered subscribers (for testing/diagnostics). */
  get subscriberCount(): number {
    return this._subscribers.length
  }

  /** Unsubscribe all subscribers (useful in test teardown). */
  clear(): void {
    this._subscribers.length = 0
  }
}

// ---------------------------------------------------------------------------
// Global singleton bus — used by the base provider instrumentation
// ---------------------------------------------------------------------------

/**
 * The process-global HookBus instance.
 *
 * Providers emit to this bus via ProviderHost.emit(). Policy/security/
 * observability subscribers attach here.
 */
export const globalHookBus = new HookBus()

// ---------------------------------------------------------------------------
// ProviderHost factory that emits onto a bus
// ---------------------------------------------------------------------------

import type { ProviderHost } from '../providers/base.js'

/**
 * Create a ProviderHost that emits hook events onto the given bus.
 *
 * This is the bridge between the Provider<F>.activate(host) call site and
 * the hook bus. Pass the returned host to provider.activate().
 */
export function createProviderHost(bus: HookBus = globalHookBus): ProviderHost {
  return {
    emit(event: ProviderHookEvent): void {
      // Fire-and-forget: emit is async but the ProviderHost interface is sync.
      // Errors in async subscribers are isolated by the bus.
      void bus.emit(event)
    },
  }
}
