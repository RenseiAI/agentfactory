/**
 * InstrumentedProvider<F> — base class that wires hook-event emission into
 * every Provider<F> lifecycle method.
 *
 * Architecture reference: donmai-architecture/002-provider-base-contract.md §Lifecycle hooks
 *
 * Usage:
 *   class MySandboxProvider extends InstrumentedProvider<'sandbox'> {
 *     protected async _activate(host: ProviderHost): Promise<void> { ... }
 *     protected async _deactivate(): Promise<void> { ... }
 *   }
 *
 * Family-specific implementations override _activate/_deactivate/_invokeVerb
 * rather than the public methods. The public activate/deactivate/invokeVerb
 * methods emit the appropriate hook events and delegate to the protected
 * methods.
 *
 * NOTE: The public Provider<F> interface from base.ts is NOT modified.
 * This class is an optional convenience base that implementations can extend.
 * The hook event contract from base.ts is stable.
 */

import type {
  Provider,
  ProviderFamily,
  ProviderManifest,
  ProviderCapabilities,
  ProviderScope,
  ProviderSignature,
  ProviderHost,
  ProviderRef,
  ProviderHealth,
  ProviderHookEvent,
} from '../providers/base.js'
import { globalHookBus, type HookBus } from './hooks.js'

// ---------------------------------------------------------------------------
// InstrumentedProvider<F>
// ---------------------------------------------------------------------------

/**
 * Abstract base class for instrumented providers.
 *
 * Subclasses implement the protected _activate/_deactivate methods.
 * The public activate/deactivate methods emit lifecycle hook events
 * automatically before and after the call.
 */
export abstract class InstrumentedProvider<F extends ProviderFamily>
  implements Provider<F>
{
  abstract readonly manifest: ProviderManifest<F>
  abstract readonly capabilities: ProviderCapabilities<F>
  abstract readonly scope: ProviderScope
  readonly signature: ProviderSignature | null = null

  /**
   * The bus to emit hook events to. Defaults to globalHookBus.
   * Override in tests by injecting a different bus via the constructor.
   */
  protected readonly _bus: HookBus

  constructor(bus: HookBus = globalHookBus) {
    this._bus = bus
  }

  /** Derived ref from the manifest (convenience). */
  protected get _ref(): ProviderRef {
    return {
      family: this.manifest.family,
      id: this.manifest.id,
      version: this.manifest.version,
    }
  }

  // -------------------------------------------------------------------------
  // Public lifecycle methods — emit hooks, delegate to protected overrides
  // -------------------------------------------------------------------------

  /**
   * Activate this provider. Emits pre-activate, then calls _activate(),
   * then emits post-activate with the measured duration.
   * If _activate() throws, the error propagates (no post-activate is emitted).
   */
  async activate(host: ProviderHost): Promise<void> {
    const ref = this._ref
    await this._bus.emit({ kind: 'pre-activate', provider: ref } satisfies ProviderHookEvent)
    const t0 = Date.now()
    await this._activate(host)
    const durationMs = Date.now() - t0
    await this._bus.emit({ kind: 'post-activate', provider: ref, durationMs } satisfies ProviderHookEvent)
  }

  /**
   * Deactivate this provider. Emits pre-deactivate, then calls _deactivate(),
   * then emits post-deactivate.
   * If _deactivate() throws, the error propagates (no post-deactivate is emitted).
   */
  async deactivate(reason = 'host-requested'): Promise<void> {
    const ref = this._ref
    await this._bus.emit({ kind: 'pre-deactivate', provider: ref, reason } satisfies ProviderHookEvent)
    await this._deactivate()
    await this._bus.emit({ kind: 'post-deactivate', provider: ref } satisfies ProviderHookEvent)
  }

  /**
   * Invoke a named verb with instrumentation.
   * Emits pre-verb, calls the verb fn, emits post-verb or verb-error.
   *
   * Subclasses call this wrapper around their family-specific verbs:
   *   async provision(spec: SandboxSpec) {
   *     return this.invokeVerb('provision', spec, (s) => this._provision(s))
   *   }
   */
  protected async invokeVerb<TArgs, TResult>(
    verb: string,
    args: TArgs,
    fn: (args: TArgs) => Promise<TResult>,
  ): Promise<TResult> {
    const ref = this._ref
    await this._bus.emit({ kind: 'pre-verb', provider: ref, verb, args } satisfies ProviderHookEvent)
    const t0 = Date.now()
    try {
      const result = await fn(args)
      const durationMs = Date.now() - t0
      await this._bus.emit({
        kind: 'post-verb',
        provider: ref,
        verb,
        result,
        durationMs,
      } satisfies ProviderHookEvent)
      return result
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      await this._bus.emit({
        kind: 'verb-error',
        provider: ref,
        verb,
        error: err,
      } satisfies ProviderHookEvent)
      throw error
    }
  }

  /**
   * Report a capability mismatch (declared vs observed).
   * Emits a capability-mismatch hook event.
   */
  protected async reportCapabilityMismatch(
    declared: unknown,
    observed: unknown,
  ): Promise<void> {
    await this._bus.emit({
      kind: 'capability-mismatch',
      provider: this._ref,
      declared,
      observed,
    } satisfies ProviderHookEvent)
  }

  /**
   * Optional health check. Subclasses override _health().
   */
  async health(): Promise<ProviderHealth> {
    return this._health()
  }

  // -------------------------------------------------------------------------
  // Protected abstract / override points for subclasses
  // -------------------------------------------------------------------------

  /** Implement activation logic here. Called between pre/post-activate events. */
  protected abstract _activate(host: ProviderHost): Promise<void>

  /** Implement deactivation logic here. Called between pre/post-deactivate events. */
  protected abstract _deactivate(): Promise<void>

  /** Override for custom health checks. Default returns 'ready'. */
  protected async _health(): Promise<ProviderHealth> {
    return { status: 'ready' }
  }
}
