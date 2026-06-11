// ---------------------------------------------------------------------------
// Per-step reasoning-effort dispatch gate
//
// Workflow steps and agent configs declare a per-step reasoning-effort hint
// via `Profile.dispatch.effort` (`low | medium | high | xhigh`). The
// dispatch path threads that hint through `AgentSpawnConfig.effort`. Whether
// the value is actually forwarded to the underlying provider invocation
// depends on the provider's `capabilities.supportsReasoningEffort` flag:
//
//   * If true  → the dispatch path leaves the value on AgentSpawnConfig and
//                the provider translates it natively (Claude SDK `effort`,
//                Codex `model_reasoning_effort` / `reasoningEffort`, etc).
//
//   * If false → the dispatch path drops the value (so the provider runs at
//                its default effort) and emits a `capability-mismatch` hook
//                event on the Layer 6 bus so audit / cost subscribers can
//                flag silently-ignored cost-control hints.
//
// The capability flag lives on `AgentProviderCapabilities` (see
// `./types.ts`) per ADR-2026-04-28-sandbox-capabilities-in-types.md.
//
// Architecture references:
//   * donmai-architecture/001-layered-execution-model.md §Layer 6
//   * donmai-architecture/002-provider-base-contract.md §Capabilities
// ---------------------------------------------------------------------------

import type { EffortLevel } from '../config/profiles.js'
import type { HookBus } from '../observability/hooks.js'
import { globalHookBus } from '../observability/hooks.js'
import type { AgentProvider } from './types.js'
import type { ProviderRef } from './base.js'

/**
 * Result of consulting `applyReasoningEffort` — the effective effort to
 * forward to the provider, plus a flag indicating whether the requested
 * effort was dropped due to a capability gap.
 */
export interface ReasoningEffortDecision {
  /**
   * Effort to forward on AgentSpawnConfig.effort. Undefined means "no
   * override; provider uses its default effort". This is either the
   * caller-supplied value (when supported) or undefined (when the value
   * was requested but the provider doesn't support it).
   */
  effort?: EffortLevel
  /**
   * True when a non-undefined effort was requested but the provider did
   * not advertise `supportsReasoningEffort`. Useful for callers that want
   * to log or surface the drop alongside their own dispatch logs.
   */
  dropped: boolean
}

export interface ApplyReasoningEffortOptions {
  /**
   * Provider that will receive the spawn. Its `capabilities.supportsReasoningEffort`
   * gates whether the effort is forwarded.
   */
  provider: AgentProvider
  /**
   * Effort value resolved from the profile (`Profile.dispatch.effort`),
   * if any. `undefined` is the no-override case and never produces a
   * warning.
   */
  requestedEffort?: EffortLevel
  /**
   * Optional ProviderRef used as the `provider` field on the emitted
   * `capability-mismatch` hook event. When omitted a synthetic ref is
   * built from `provider.name` so the event still carries enough
   * attribution for subscribers to route it.
   */
  providerRef?: ProviderRef
  /**
   * Override the hook bus the warning is emitted on. Defaults to the
   * process-global bus. Tests inject a scoped bus to assert deliveries.
   */
  bus?: HookBus
}

/**
 * Build a synthetic ProviderRef from an AgentProvider for hook emission.
 * The legacy `AgentProvider` contract doesn't carry a manifest, so we
 * synthesise the family/version fields. Subscribers that care only about
 * the `id` (provider name) see the right thing; subscribers that filter on
 * family also get a stable value.
 */
function syntheticProviderRef(provider: AgentProvider): ProviderRef {
  return {
    family: 'agent-runtime',
    id: provider.name,
    // Synthetic ref — base provider contract has no version field. The
    // 'unknown' string is a stable sentinel that won't collide with real
    // semvers. ProviderRef.version is required by the type, so we must
    // supply something.
    version: '0.0.0-unknown',
  }
}

/**
 * Decide whether to forward a per-step reasoning-effort hint to the given
 * provider, dropping it (with a Layer 6 warning) when the provider does
 * not advertise `supportsReasoningEffort`.
 *
 * Behaviour matrix:
 *
 *   requestedEffort   capability flag           result
 *   ───────────────   ───────────────────────   ──────────────────────────
 *   undefined         (any)                     { effort: undefined,
 *                                                 dropped: false }
 *   defined           supportsReasoningEffort   { effort: requested,
 *                     === true                    dropped: false }
 *   defined           false / undefined         { effort: undefined,
 *                                                 dropped: true } +
 *                                               capability-mismatch hook
 *
 * The hook emit is fire-and-forget (we void the promise) — the bus
 * isolates subscriber crashes per the hook-bus contract, so a buggy subscriber cannot
 * block dispatch.
 */
export function applyReasoningEffort(
  opts: ApplyReasoningEffortOptions,
): ReasoningEffortDecision {
  const { provider, requestedEffort } = opts

  // No effort requested — never warn, never drop.
  if (requestedEffort === undefined) {
    return { effort: undefined, dropped: false }
  }

  const supports = provider.capabilities.supportsReasoningEffort === true

  if (supports) {
    return { effort: requestedEffort, dropped: false }
  }

  // Drop + warn. Emit on the Layer 6 hook bus so observability subscribers
  // (audit, cost, telemetry) can react to silently-ignored cost-control hints.
  const bus = opts.bus ?? globalHookBus
  const providerRef = opts.providerRef ?? syntheticProviderRef(provider)

  // The capability-mismatch event is the closest fit in the existing
  // ProviderHookEvent taxonomy: declared (no support) vs. observed (the
  // dispatch path attempted to forward an effort hint). Subscribers that
  // already attach to capability-mismatch (e.g. signing.ts capability
  // discrepancy detection) will see this event with a recognisable shape.
  void bus.emit({
    kind: 'capability-mismatch',
    provider: providerRef,
    declared: { supportsReasoningEffort: false },
    observed: {
      reasoningEffortRequested: requestedEffort,
      droppedReason:
        `Provider '${provider.name}' does not advertise ` +
        `supportsReasoningEffort; the requested effort hint ` +
        `'${requestedEffort}' was dropped from the dispatch.`,
    },
  })

  return { effort: undefined, dropped: true }
}
