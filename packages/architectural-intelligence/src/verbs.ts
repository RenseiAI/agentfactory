/**
 * Architectural Intelligence — workflow verb registration
 *
 * Architecture reference: rensei-architecture/007-intelligence-services.md
 * §"Cooperation with the rest of the architecture" — Workflow Engine
 * Architecture reference: rensei-architecture/016-workflow-engine.md §Verb registry
 * Architecture reference: rensei-architecture/015-plugin-spec.md §Workflow Verb registry
 *
 * REN-1326: Registers the `architecture.assess_change` workflow verb.
 *
 * Verb: `architecture.assess_change`
 *   kind:            action
 *   sideEffectClass: internal-only (reads VCS diff, writes to arch graph — no
 *                    external service side effects beyond what the tenant controls)
 *   description:     Run drift detection on a PR or commit. Returns a DriftReport.
 *
 * Usage in a custom QA workflow:
 *
 *   spec:
 *     steps:
 *       - id: assess_pr
 *         type: action
 *         config:
 *           action: architecture@1:architecture.assess_change
 *           provider: architecture
 *           prUrl: "{{ trigger.data.prUrl }}"
 *           gatePolicy: no-severity-high
 *         next: [handle_drift]
 *
 *       - id: handle_drift
 *         type: condition
 *         config:
 *           action: architecture@1:architecture.assess_change.has_critical_drift
 *         branches:
 *           yes: block_pr
 *           no: continue
 *
 * Design decisions:
 *   - Verb declarations in this module match the VerbDeclaration interface from
 *     core's manifest.ts. They are standalone type-compatible structs so the
 *     architectural-intelligence package stays zero-dependency on core.
 *   - The `registerArchitectureVerbs()` function accepts any PluginRegistry-
 *     compatible object, letting the host inject the real registry at startup.
 *   - The module also exports typed input/output schemas for workflow/v2
 *     compile-time validation (W1 in 016-workflow-engine.md).
 */

// ---------------------------------------------------------------------------
// VerbDeclaration — standalone re-declaration (zero-dep on core)
// ---------------------------------------------------------------------------

/**
 * Minimal re-declaration of VerbDeclaration from core's manifest.ts.
 * Structurally compatible — avoids introducing a runtime dependency on core.
 */
interface VerbDeclaration {
  id: string
  description?: string
  kind?: 'action' | 'condition' | 'trigger' | 'gate'
  sideEffectClass?: 'read-only' | 'external-write' | 'internal-only'
  deprecated?: boolean
}

/**
 * Minimal re-declaration of RegisteredVerb from core's registry.ts.
 */
interface RegisteredVerb {
  pluginId: string
  declaration: VerbDeclaration
  available: boolean
}

/**
 * Minimal interface of the PluginRegistry that this module needs.
 * Satisfied by PluginRegistry from core/src/plugins/registry.ts.
 */
export interface VerbRegistry {
  registerVerb(verb: RegisteredVerb): void
}

// ---------------------------------------------------------------------------
// Plugin identity
// ---------------------------------------------------------------------------

/**
 * The plugin id that owns architecture verbs.
 * In production this is set by the agentfactory plugin manifest.
 */
export const ARCHITECTURE_PLUGIN_ID = 'architecture' as const

// ---------------------------------------------------------------------------
// Verb: architecture.assess_change
// ---------------------------------------------------------------------------

/**
 * Input schema (plain TypeScript — used for documentation and test validation).
 *
 * In workflow/v2 this will be referenced via a JSON Schema file for compile-time
 * type compatibility checking (W1 from 016-workflow-engine.md).
 */
export interface AssessChangeVerbInput {
  /**
   * PR URL to assess (e.g., https://github.com/org/repo/pull/123).
   * Mutually exclusive with `prNumber` + `repository`.
   */
  prUrl?: string

  /** Repository identifier (e.g., 'github.com/org/repo'). */
  repository?: string

  /** PR number within the repository. */
  prNumber?: number

  /**
   * Drift gate policy override.
   * Defaults to DONMAI_DRIFT_GATE env or 'no-severity-high'.
   *   'none'             — never block
   *   'no-severity-high' — block on any high-severity deviation
   *   'zero-deviations'  — block on any deviation
   *   'max:N'            — block when deviation count > N
   */
  gatePolicy?: string

  /** Optional scope level override (defaults to 'project'). */
  scopeLevel?: 'project' | 'org' | 'tenant' | 'global'

  /** Optional project id for scope. */
  projectId?: string
}

/**
 * Output schema for `architecture.assess_change`.
 *
 * Returned by the verb action handler; surfaced to downstream workflow steps.
 */
export interface AssessChangeVerbOutput {
  /** Whether the gate policy was triggered (i.e., the change should be blocked). */
  gated: boolean

  /** Whether any high-severity deviations were found. */
  hasCriticalDrift: boolean

  /** Total number of deviations detected. */
  deviationCount: number

  /** Counts per severity level. */
  bySeverity: {
    high: number
    medium: number
    low: number
  }

  /** Human-readable summary. */
  summary: string

  /** ISO timestamp of the assessment. */
  assessedAt: string

  /** The full DriftReport as a JSON-serializable object. */
  report: unknown
}

/**
 * VerbDeclaration for `architecture.assess_change`.
 *
 * Conforms to VerbDeclaration in core/src/plugins/manifest.ts.
 */
export const ASSESS_CHANGE_VERB: VerbDeclaration = {
  id: 'architecture.assess_change',
  description:
    'Run architectural drift detection on a PR or commit. ' +
    'Compares the change against established architectural patterns, conventions, ' +
    'and decisions. Returns a DriftReport. Threshold-based gating blocks PRs ' +
    'per tenant policy (DONMAI_DRIFT_GATE or explicit gatePolicy input).',
  kind: 'action',
  sideEffectClass: 'internal-only',
}

/**
 * All verb declarations shipped by the architecture plugin.
 */
export const ARCHITECTURE_VERBS: VerbDeclaration[] = [ASSESS_CHANGE_VERB]

// ---------------------------------------------------------------------------
// registerArchitectureVerbs — entry point for the host
// ---------------------------------------------------------------------------

/**
 * Register all architecture workflow verbs into the host's verb registry.
 *
 * Call this at plugin startup (after the agentfactory plugin runtime loads
 * the architectural-intelligence package):
 *
 * @example
 * import { getDefaultRegistry } from '@donmai/core/plugins'
 * import { registerArchitectureVerbs } from '@donmai/architectural-intelligence/verbs'
 * registerArchitectureVerbs(getDefaultRegistry())
 *
 * @param registry  - The PluginRegistry instance (or any VerbRegistry-compatible object).
 * @param available - Whether verbs should be immediately available. Default: true.
 */
export function registerArchitectureVerbs(
  registry: VerbRegistry,
  available = true,
): void {
  for (const declaration of ARCHITECTURE_VERBS) {
    registry.registerVerb({
      pluginId: ARCHITECTURE_PLUGIN_ID,
      declaration,
      available,
    })
  }
}

// ---------------------------------------------------------------------------
// Verb action handler — callable by the workflow engine
// ---------------------------------------------------------------------------

import type { ArchitecturalIntelligence, ChangeRef } from './types.js'
import type { ModelAdapter } from './eval.js'
import { assessChange, resolveDriftGatePolicy, evaluateGate } from './drift.js'
import type { PrDiff } from './diff-reader.js'

/**
 * Handler options for the `architecture.assess_change` workflow verb.
 */
export interface AssessChangeHandlerOptions {
  /** The ArchitecturalIntelligence instance to query/contribute to. */
  ai: ArchitecturalIntelligence

  /** The model adapter for running the deviation-detection prompt. */
  adapter: ModelAdapter

  /**
   * Optional function to fetch a PR diff given a PR URL and/or number.
   * When provided, the handler uses it to populate `prDiff`.
   * When omitted, the assessment runs with empty change observations
   * (still detects baseline alignment but cannot detect PR-specific drift).
   */
  fetchPrDiff?: (input: { prUrl?: string; repository?: string; prNumber?: number }) => Promise<PrDiff | undefined>
}

/**
 * Execute the `architecture.assess_change` verb.
 *
 * This is the handler the workflow engine calls when a workflow step
 * invokes `architecture@1:architecture.assess_change`.
 *
 * @param input   - Verb input from the workflow step config.
 * @param options - Runtime dependencies (ai instance, adapter, optional diff fetcher).
 * @returns Verb output conforming to AssessChangeVerbOutput.
 */
export async function handleAssessChange(
  input: AssessChangeVerbInput,
  options: AssessChangeHandlerOptions,
): Promise<AssessChangeVerbOutput> {
  const { ai, adapter, fetchPrDiff } = options

  // Resolve ChangeRef from input
  const change: ChangeRef = _resolveChangeRef(input)

  // Resolve scope
  const scope = {
    level: (input.scopeLevel ?? 'project') as 'project' | 'org' | 'tenant' | 'global',
    projectId: input.projectId,
  }

  // Resolve gate policy
  const policyStr = input.gatePolicy ?? process.env['DONMAI_DRIFT_GATE']
  const gatePolicy = policyStr ? _parseGatePolicyString(policyStr) : undefined

  // Optionally fetch the PR diff
  let prDiff: PrDiff | undefined
  if (fetchPrDiff) {
    prDiff = await fetchPrDiff({
      prUrl: input.prUrl,
      repository: input.repository,
      prNumber: input.prNumber,
    })
  }

  // Run drift assessment
  const report = await assessChange(ai, adapter, {
    change,
    prDiff,
    scope,
    gatePolicy,
  })

  // Evaluate gate
  const effectivePolicy = resolveDriftGatePolicy(gatePolicy)
  const gated = evaluateGate(report.deviations, effectivePolicy)

  const bySeverity = {
    high: report.deviations.filter((d) => d.severity === 'high').length,
    medium: report.deviations.filter((d) => d.severity === 'medium').length,
    low: report.deviations.filter((d) => d.severity === 'low').length,
  }

  return {
    gated,
    hasCriticalDrift: report.hasCriticalDrift,
    deviationCount: report.deviations.length,
    bySeverity,
    summary: report.summary,
    assessedAt: report.assessedAt.toISOString(),
    report,
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _resolveChangeRef(input: AssessChangeVerbInput): ChangeRef {
  if (input.prUrl) {
    // Parse repository + prNumber from URL
    // Supports: https://github.com/org/repo/pull/123
    const match = input.prUrl.match(
      /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/,
    )
    if (match) {
      return {
        repository: `github.com/${match[1]}`,
        kind: 'pr',
        prNumber: parseInt(match[2], 10),
        description: input.prUrl,
      }
    }
  }

  if (input.repository && input.prNumber) {
    return {
      repository: input.repository,
      kind: 'pr',
      prNumber: input.prNumber,
    }
  }

  if (input.repository) {
    return {
      repository: input.repository,
      kind: 'branch',
      branch: 'unknown',
    }
  }

  return {
    repository: 'unknown',
    kind: 'pr',
    prNumber: 0,
    description: input.prUrl,
  }
}

function _parseGatePolicyString(s: string): import('./drift.js').DriftGatePolicy {
  if (s === 'none') return 'none'
  if (s === 'no-severity-high') return 'no-severity-high'
  if (s === 'zero-deviations') return 'zero-deviations'
  if (s.startsWith('max:')) {
    const n = parseInt(s.slice(4), 10)
    if (!isNaN(n) && n >= 0) return { maxCount: n }
  }
  return 'no-severity-high'
}
