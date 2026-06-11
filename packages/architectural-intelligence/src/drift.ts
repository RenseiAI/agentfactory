/**
 * Architectural Intelligence — drift detection implementation
 *
 * Architecture reference: rensei-architecture/007-intelligence-services.md
 * §"Architectural Intelligence" — Drift detection
 *
 * REN-1326: Implements `ArchitecturalIntelligence.assess(change) → DriftReport`.
 *
 * Algorithm:
 *   1. Read the change's diff via `PrDiff` (caller-provided; no live VCS calls).
 *   2. Extract raw observations from the diff using `readDiffObservations`.
 *   3. Query the existing architectural baseline (patterns, conventions, decisions)
 *      for the given scope via the `ArchitecturalIntelligence.query()` method.
 *   4. Build a `BaselineEntry[]` summary from the queried baseline.
 *   5. Run the deviation-detection prompt through the provided `ModelAdapter`.
 *   6. Parse and validate the output as `ArchObservation[]` (kind='deviation').
 *   7. Materialize deviations as `Deviation` typed nodes and store them
 *      via `ai.contribute()`.
 *   8. Return a structured `DriftReport`.
 *
 * Threshold gating:
 *   A `DriftGatePolicy` argument (or `DONMAI_DRIFT_GATE` env) decides what
 *   counts as "blocked":
 *     - 'none'           : never block (informational only)
 *     - 'no-severity-high': block when any deviation is severity='high'
 *     - 'zero-deviations' : block on any deviation
 *     - { maxCount: N }   : block when deviation count > N
 *
 * Design decisions:
 *   - This module has no hardcoded LLM calls — it accepts a `ModelAdapter`
 *     so tests can inject deterministic stubs (same pattern as eval.ts).
 *   - `assess()` is a pure function: it reads from the store, calls the adapter,
 *     and writes back via `ai.contribute()`. No side effects beyond that.
 *   - If the model adapter returns an empty array, the report is clean (no drift).
 *   - Authored citations always rank above inferred ones per 007 §"Strategic
 *     positioning". The drift engine never overrides authored architectural intent.
 */

import { randomUUID } from 'node:crypto'
import type {
  ArchitecturalIntelligence,
  ArchObservation,
  ArchScope,
  ChangeRef,
  Deviation,
  DriftReport,
} from './types.js'
import type { ModelAdapter } from './eval.js'
import type { PrDiff } from './diff-reader.js'
import { readDiffObservations } from './diff-reader.js'
import {
  buildUserPrompt,
  parseOutput,
  SYSTEM_PROMPT,
  type BaselineEntry,
} from './prompts/v1/deviation-detection.js'

// ---------------------------------------------------------------------------
// DriftGatePolicy — threshold configuration
// ---------------------------------------------------------------------------

/**
 * Controls what counts as "gated" (i.e., blocked) by the drift assessment.
 *
 * Tenant policy can be provided explicitly or read from `DONMAI_DRIFT_GATE`.
 *
 * Environment variable format (DONMAI_DRIFT_GATE):
 *   'none'             → never block
 *   'no-severity-high' → block on any severity='high' deviation
 *   'zero-deviations'  → block on any deviation
 *   'max:N'            → block when deviation count > N (e.g. 'max:3')
 */
export type DriftGatePolicy =
  | 'none'
  | 'no-severity-high'
  | 'zero-deviations'
  | { maxCount: number }

/**
 * Resolve the effective drift gate policy.
 *
 * Priority:
 *   1. Explicit `policy` argument.
 *   2. `DONMAI_DRIFT_GATE` environment variable.
 *   3. Default: 'no-severity-high'.
 */
export function resolveDriftGatePolicy(policy?: DriftGatePolicy): DriftGatePolicy {
  if (policy !== undefined) return policy

  const env = process.env['DONMAI_DRIFT_GATE']
  if (!env) return 'no-severity-high'

  if (env === 'none') return 'none'
  if (env === 'no-severity-high') return 'no-severity-high'
  if (env === 'zero-deviations') return 'zero-deviations'
  if (env.startsWith('max:')) {
    const n = parseInt(env.slice(4), 10)
    if (!isNaN(n) && n >= 0) return { maxCount: n }
  }

  return 'no-severity-high'
}

/**
 * Evaluate whether a set of deviations triggers the gate.
 *
 * @returns true if the gate would BLOCK the change; false if the change passes.
 */
export function evaluateGate(deviations: Deviation[], policy: DriftGatePolicy): boolean {
  if (policy === 'none') return false

  if (policy === 'zero-deviations') {
    return deviations.length > 0
  }

  if (policy === 'no-severity-high') {
    return deviations.some((d) => d.severity === 'high')
  }

  if (typeof policy === 'object' && 'maxCount' in policy) {
    return deviations.length > policy.maxCount
  }

  return false
}

// ---------------------------------------------------------------------------
// AssessInput — all inputs to the assess function
// ---------------------------------------------------------------------------

export interface AssessInput {
  /**
   * The VCS change reference being assessed.
   * Used to populate `DriftReport.change` and `Deviation.introducedBy`.
   */
  change: ChangeRef

  /**
   * The PR diff data. Caller-provided — no live VCS calls made here.
   * Use `readDiffObservations` to extract raw change signals.
   *
   * When `prDiff` is omitted, the assessment uses empty change observations
   * (still queries the baseline, but has no diff signals to compare against).
   */
  prDiff?: PrDiff

  /**
   * The scope to query the architectural baseline against.
   */
  scope: ArchScope

  /**
   * Optional project-level context hint for the LLM prompt.
   */
  projectContext?: string

  /**
   * Threshold gate policy. Falls back to `DONMAI_DRIFT_GATE` env or the
   * default policy ('no-severity-high').
   */
  gatePolicy?: DriftGatePolicy
}

// ---------------------------------------------------------------------------
// assessChange — main entry point
// ---------------------------------------------------------------------------

/**
 * Assess a change for architectural drift.
 *
 * Runs the deviation-detection prompt against the change's diff observations
 * and the existing architectural baseline. Returns a `DriftReport`.
 *
 * The `ai` parameter must be an `ArchitecturalIntelligence` instance that
 * provides `query()` (to load the baseline) and `contribute()` (to persist
 * new deviations into the graph).
 *
 * The `adapter` parameter is the LLM interface. In production inject an
 * Anthropic/OpenAI adapter; in tests inject a deterministic stub.
 *
 * @example
 * // Production usage
 * const report = await assessChange(sqliteAI, anthropicAdapter, {
 *   change: { repository: 'github.com/org/repo', kind: 'pr', prNumber: 123 },
 *   prDiff: { ...diff },
 *   scope: { level: 'project', projectId: 'my-project' },
 *   gatePolicy: 'no-severity-high',
 * })
 *
 * @example
 * // Test usage (stub adapter)
 * const report = await assessChange(sqliteAI, createFixedAdapter('[]'), {
 *   change: { repository: 'test-repo', kind: 'pr', prNumber: 1 },
 *   scope: { level: 'project' },
 * })
 */
export async function assessChange(
  ai: ArchitecturalIntelligence,
  adapter: ModelAdapter,
  input: AssessInput,
): Promise<DriftReport> {
  const { change, prDiff, scope, projectContext, gatePolicy } = input
  const policy = resolveDriftGatePolicy(gatePolicy)
  const assessedAt = new Date()

  // --- Step 1: Extract change observations from the PR diff ---
  const changeObservations: ArchObservation[] = prDiff
    ? readDiffObservations(prDiff, scope)
    : []

  // --- Step 2: Query the established baseline ---
  const archView = await ai.query({
    workType: 'qa',
    scope,
    includeActiveDrift: false,
  })

  // --- Step 3: Build baseline summary for the prompt ---
  const baseline: BaselineEntry[] = [
    ...archView.patterns.map((p) => ({
      kind: 'pattern' as const,
      id: p.id,
      title: p.title,
      description: p.description,
    })),
    ...archView.conventions.map((c) => ({
      kind: 'convention' as const,
      id: c.id,
      title: c.title,
      description: c.description,
    })),
    ...archView.decisions.map((d) => ({
      kind: 'decision' as const,
      id: d.id,
      title: d.title,
      description: `${d.title}: ${d.rationale} (chosen: ${d.chosen})`,
    })),
  ]

  // --- Step 4: If no baseline exists, cannot detect deviations ---
  if (baseline.length === 0) {
    return {
      change,
      deviations: [],
      reinforced: [],
      hasCriticalDrift: false,
      summary:
        'No established architectural baseline found for this scope. ' +
        'Contribute patterns, conventions, and decisions to enable drift detection.',
      assessedAt,
    }
  }

  // --- Step 5: Run deviation-detection prompt ---
  const systemPrompt = SYSTEM_PROMPT
  const userPrompt = buildUserPrompt({
    changeObservations,
    baseline,
    projectContext,
  })

  let rawOutput: string
  try {
    rawOutput = await adapter.complete(systemPrompt, userPrompt)
  } catch (err) {
    throw new Error(
      `[assessChange] Model adapter failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // --- Step 6: Parse and validate output ---
  let deviationObservations: ArchObservation[]
  try {
    deviationObservations = parseOutput(rawOutput)
  } catch (err) {
    throw new Error(
      `[assessChange] Failed to parse deviation-detection output: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // --- Step 7: Materialize deviations and contribute to the graph ---
  const now = assessedAt.toISOString()
  const deviations: Deviation[] = []

  for (const obs of deviationObservations) {
    const payload = obs.payload as Record<string, unknown>
    const deviatesFromRaw = payload['deviatesFrom'] as { kind: string; id: string }

    // Build a Deviation value object
    const deviation: Deviation = {
      id: randomUUID(),
      title: String(payload['title'] ?? 'Untitled deviation'),
      description: String(payload['description'] ?? ''),
      deviatesFrom: _buildDeviatesFrom(deviatesFromRaw),
      introducedBy: change,
      status: 'pending',
      severity: _coerceSeverity(String(payload['severity'] ?? 'medium')),
      citations: [],
      scope,
      createdAt: assessedAt,
      updatedAt: assessedAt,
    }

    deviations.push(deviation)

    // Persist via contribute() — the implementation materializes into the DB
    await ai.contribute({
      kind: 'deviation',
      payload: {
        title: deviation.title,
        description: deviation.description,
        deviatesFrom: deviation.deviatesFrom,
        status: 'pending',
        severity: deviation.severity,
      },
      source: {
        changeRef: change,
      },
      confidence: Math.min(obs.confidence, 0.95),
      scope,
    })

    void now // suppress lint: used by caller via assessedAt
  }

  // --- Step 8: Identify reinforced patterns ---
  // Patterns/conventions referenced in change observations but NOT in deviations
  // are considered reinforced (the change aligns with them).
  const deviatedIds = new Set(
    deviationObservations.map((obs) => {
      const p = obs.payload as Record<string, unknown>
      const df = p['deviatesFrom'] as { id?: string } | undefined
      return df?.id ?? ''
    }),
  )

  const reinforced: DriftReport['reinforced'] = []
  for (const p of archView.patterns) {
    if (!deviatedIds.has(p.id)) {
      reinforced.push({ kind: 'pattern', patternId: p.id })
    }
  }
  for (const c of archView.conventions) {
    if (!deviatedIds.has(c.id)) {
      reinforced.push({ kind: 'convention', conventionId: c.id })
    }
  }

  // --- Step 9: Build DriftReport ---
  const hasCriticalDrift = deviations.some((d) => d.severity === 'high')
  const gated = evaluateGate(deviations, policy)

  const summary = _buildSummary(deviations, hasCriticalDrift, gated, policy)

  return {
    change,
    deviations,
    reinforced,
    hasCriticalDrift,
    summary,
    assessedAt,
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _buildDeviatesFrom(raw: { kind: string; id: string }): Deviation['deviatesFrom'] {
  const kind = raw.kind
  const id = raw.id ?? ''

  if (kind === 'pattern') return { kind: 'pattern', patternId: id }
  if (kind === 'convention') return { kind: 'convention', conventionId: id }
  if (kind === 'decision') return { kind: 'decision', decisionId: id }

  // Fallback: treat as pattern
  return { kind: 'pattern', patternId: id }
}

function _coerceSeverity(s: string): Deviation['severity'] {
  if (s === 'high' || s === 'medium' || s === 'low') return s
  return 'medium'
}

function _buildSummary(
  deviations: Deviation[],
  hasCriticalDrift: boolean,
  gated: boolean,
  policy: DriftGatePolicy,
): string {
  if (deviations.length === 0) {
    return 'No architectural deviations detected. Change aligns with established patterns.'
  }

  const highCount = deviations.filter((d) => d.severity === 'high').length
  const medCount = deviations.filter((d) => d.severity === 'medium').length
  const lowCount = deviations.filter((d) => d.severity === 'low').length

  const parts: string[] = [
    `${deviations.length} deviation${deviations.length === 1 ? '' : 's'} detected` +
      (highCount > 0 ? ` (${highCount} high, ${medCount} medium, ${lowCount} low)` : '') +
      '.',
  ]

  if (hasCriticalDrift) {
    parts.push('Critical: high-severity deviations require architectural review.')
  }

  if (gated) {
    const policyDesc =
      policy === 'zero-deviations'
        ? 'zero-deviations policy'
        : policy === 'no-severity-high'
          ? 'no-severity-high policy'
          : typeof policy === 'object'
            ? `max-${policy.maxCount}-deviations policy`
            : 'policy'
    parts.push(`Change is BLOCKED by tenant ${policyDesc}.`)
  }

  return parts.join(' ')
}
