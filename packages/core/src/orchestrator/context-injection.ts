/**
 * Context Injection — Architectural Intelligence retrieval at session start
 *
 * Architecture reference: donmai-architecture/007-intelligence-services.md
 * §"Active context injection at session start"
 *
 * This is the Day-1-vs-Day-40 closure mechanic. The orchestrator calls
 * `buildArchitecturalContext()` before rendering the session prompt; the
 * returned string is injected into the `architecturalContext` template variable
 * which maps to the `{{> partials/architectural-context}}` partial.
 *
 * Token budget enforcement:
 *   Priority order: drift warnings > active issue patterns > project-wide
 *   conventions > org-wide patterns. Uses a 1-token ≈ 4-chars approximation
 *   to trim lower-priority content when the budget is exhausted.
 *
 * Session-end flush:
 *   `flushSessionObservations()` is called when a session terminates with
 *   WORK_RESULT:passed. A stub extractor returns [] for now; full extraction
 *   is.
 */

import type {
  ArchitecturalIntelligence,
  ArchQuerySpec,
  ArchView,
  ArchObservation,
  ArchScope,
  ArchitecturalPattern,
  Convention,
  Decision,
  Deviation,
} from '@donmai/architectural-intelligence'
import type { Logger } from '../logger.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ContextInjectionConfig {
  /** ArchitecturalIntelligence instance to query. When undefined, injection is skipped. */
  architecturalIntelligence?: ArchitecturalIntelligence
  /**
   * Maximum tokens to devote to the architectural-context section.
   * Defaults to 2000. Uses 1 token ≈ 4 chars approximation.
   */
  maxTokens?: number
}

const DEFAULT_MAX_TOKENS = 2000
const CHARS_PER_TOKEN = 4

// ---------------------------------------------------------------------------
// Session-start: build architectural context string
// ---------------------------------------------------------------------------

/**
 * Build the architectural context string for injection into the session prompt.
 *
 * Queries ArchitecturalIntelligence with the given spec and renders the
 * returned ArchView into a labeled Markdown section, trimmed to `maxTokens`.
 *
 * Returns `undefined` when:
 * - No AI instance is configured
 * - The query returns an empty view (no patterns, conventions, or decisions)
 * - The query throws (errors are swallowed; context injection is best-effort)
 */
export async function buildArchitecturalContext(
  spec: ArchQuerySpec,
  config: ContextInjectionConfig,
  log?: Logger,
): Promise<string | undefined> {
  if (!config.architecturalIntelligence) return undefined

  let view: ArchView
  try {
    view = await config.architecturalIntelligence.query({
      ...spec,
      maxTokens: spec.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
      includeActiveDrift: spec.includeActiveDrift ?? true,
    })
  } catch (err) {
    log?.warn('Architectural Intelligence query failed (non-fatal — context injection skipped)', {
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }

  return renderArchView(view, config.maxTokens ?? DEFAULT_MAX_TOKENS, log)
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render an ArchView into a labeled Markdown section, honoring the token budget.
 *
 * Priority order (higher-priority content is rendered first and protected from
 * trimming):
 *   1. Drift warnings (from view.drift.deviations, high-severity first)
 *   2. Active issue patterns (patterns narrowed to the queried issue/paths)
 *   3. Project-wide conventions
 *   4. Org-wide patterns
 *
 * Returns `undefined` if the view is entirely empty.
 */
export function renderArchView(
  view: ArchView,
  maxTokens: number,
  log?: Logger,
): string | undefined {
  const budget = maxTokens * CHARS_PER_TOKEN

  const sections: string[] = []

  // --- Priority 1: Drift warnings ---
  if (view.drift && view.drift.deviations.length > 0) {
    const driftSection = renderDriftWarnings(view.drift.deviations)
    if (driftSection) sections.push(driftSection)
  }

  // --- Priority 2: Active issue patterns (project-level scope) ---
  const projectPatterns = view.patterns.filter(p => p.scope.level === 'project')
  if (projectPatterns.length > 0) {
    const s = renderPatterns(projectPatterns, 'Active Patterns')
    if (s) sections.push(s)
  }

  // --- Priority 3: Project-wide conventions ---
  const projectConventions = view.conventions.filter(c => c.scope.level === 'project')
  if (projectConventions.length > 0) {
    const s = renderConventions(projectConventions, 'Project Conventions')
    if (s) sections.push(s)
  }

  // --- Priority 4: Org-wide patterns + conventions ---
  const orgPatterns = view.patterns.filter(p => p.scope.level === 'org' || p.scope.level === 'tenant' || p.scope.level === 'global')
  if (orgPatterns.length > 0) {
    const s = renderPatterns(orgPatterns, 'Org-wide Patterns')
    if (s) sections.push(s)
  }

  const orgConventions = view.conventions.filter(c => c.scope.level === 'org' || c.scope.level === 'tenant' || c.scope.level === 'global')
  if (orgConventions.length > 0) {
    const s = renderConventions(orgConventions, 'Org-wide Conventions')
    if (s) sections.push(s)
  }

  // Decisions apply at all levels
  if (view.decisions.length > 0) {
    const s = renderDecisions(view.decisions)
    if (s) sections.push(s)
  }

  if (sections.length === 0) return undefined

  // Apply token budget: keep high-priority sections first, trim at budget
  const trimmedSections = applyBudget(sections, budget, log)
  if (trimmedSections.length === 0) return undefined

  return [
    '## Architectural context',
    '',
    ...trimmedSections,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderDriftWarnings(deviations: Deviation[]): string | undefined {
  if (deviations.length === 0) return undefined

  // Sort: high > medium > low severity
  const sorted = [...deviations].sort((a, b) => {
    const rank = { high: 3, medium: 2, low: 1 } as Record<string, number>
    return (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0)
  })

  const lines: string[] = ['### Drift warnings', '']
  for (const d of sorted) {
    const badge = d.severity === 'high' ? '🔴 HIGH' : d.severity === 'medium' ? '🟡 MEDIUM' : '🟢 LOW'
    lines.push(`- **[${badge}] ${d.title}**: ${d.description}`)
  }
  return lines.join('\n')
}

function renderPatterns(patterns: ArchitecturalPattern[], heading: string): string | undefined {
  if (patterns.length === 0) return undefined

  const lines: string[] = [`### ${heading}`, '']
  for (const p of patterns) {
    lines.push(`- **${p.title}**: ${p.description}`)
    if (p.locations.length > 0) {
      const locs = p.locations.slice(0, 3).map(l => l.path).join(', ')
      lines.push(`  _(see: ${locs})_`)
    }
  }
  return lines.join('\n')
}

function renderConventions(conventions: Convention[], heading: string): string | undefined {
  if (conventions.length === 0) return undefined

  const lines: string[] = [`### ${heading}`, '']
  for (const c of conventions) {
    const authored = c.authored ? ' _(authored)_' : ''
    lines.push(`- **${c.title}**${authored}: ${c.description}`)
  }
  return lines.join('\n')
}

function renderDecisions(decisions: Decision[]): string | undefined {
  if (decisions.length === 0) return undefined

  const lines: string[] = ['### Architectural decisions', '']
  for (const d of decisions) {
    if (d.status !== 'active') continue
    lines.push(`- **${d.title}** → chosen: _${d.chosen}_. ${d.rationale}`)
  }
  if (lines.length === 2) return undefined // Only heading was added
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

/**
 * Trim sections to fit within the character budget.
 *
 * Sections are ordered by priority (drift first). We include as many
 * complete sections as fit; if the last section would overflow, we truncate
 * it with a `[...trimmed for token budget]` notice.
 */
function applyBudget(sections: string[], charBudget: number, log?: Logger): string[] {
  let remaining = charBudget
  const result: string[] = []

  for (const section of sections) {
    const len = section.length + 2 // +2 for the \n\n separator
    if (remaining <= 0) break

    if (len <= remaining) {
      result.push(section)
      remaining -= len
    } else {
      // Truncate the section to the remaining budget
      const truncated = section.slice(0, remaining - 40) + '\n\n_[...trimmed for token budget]_'
      result.push(truncated)
      remaining = 0
      log?.debug('Architectural context truncated for token budget', {
        originalLen: section.length,
        truncatedLen: truncated.length,
      })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Session-end flush
// ---------------------------------------------------------------------------

export interface SessionFlushInput {
  /** Issue ID (Linear / platform) */
  issueId: string
  /** Session identifier */
  sessionId: string
  /** Work type */
  workType: string
  /** Scope for the flushed observations */
  scope: ArchScope
  /** Whether the session ended with WORK_RESULT:passed */
  passed: boolean
}

/**
 * Flush new observations from a completed session into Architectural Intelligence.
 *
 * Called when a session terminates with WORK_RESULT:passed. The extractor is
 * a stub returning [] for now — full extraction is.
 *
 * Errors are swallowed; the flush is best-effort and must not block session cleanup.
 */
export async function flushSessionObservations(
  input: SessionFlushInput,
  config: ContextInjectionConfig,
  log?: Logger,
): Promise<void> {
  if (!config.architecturalIntelligence) return
  if (!input.passed) return

  let observations: ArchObservation[]
  try {
    observations = extractObservationsStub(input)
  } catch (err) {
    log?.warn('Observation extraction threw (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
    return
  }

  if (observations.length === 0) return

  for (const obs of observations) {
    try {
      await config.architecturalIntelligence.contribute(obs)
    } catch (err) {
      log?.warn('Failed to contribute observation to Architectural Intelligence (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
        kind: obs.kind,
      })
    }
  }

  log?.info('Architectural Intelligence observations flushed', {
    sessionId: input.sessionId,
    count: observations.length,
  })
}

/**
 * Stub observation extractor.
 *
 * Returns an empty array. Full extraction (parsing session diffs for new
 * patterns, conventions, decisions) is.
 */
export function extractObservationsStub(_input: SessionFlushInput): ArchObservation[] {
  // extract observations from session diff
  return []
}
