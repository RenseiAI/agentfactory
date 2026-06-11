/**
 * Architectural Intelligence — type vocabulary
 *
 * Architecture reference: donmai-architecture/007-intelligence-services.md
 * §Architectural Intelligence
 *
 * Design decisions:
 *
 * - `Citation.confidence` enforces the "authored intent > inferences"
 *   constraint. Authored citations (from CLAUDE.md, ADRs, explicit human
 *   docs) are always ranked above inferred ones at the query layer.
 *   The ordering is: 'authored' > 'inferred-high' > 'inferred-medium' >
 *   'inferred-low'. Implementations must never silently promote an inferred
 *   citation to authored confidence.
 *
 * - `ChangeRef` is a value object identifying a VCS change (commit, PR, etc.)
 *   without importing a provider-specific type. The architectural-intelligence
 *   package stays provider-orthogonal.
 *
 * - `ProviderScope` is re-declared here (not imported from @donmai/core)
 *   so the package remains a standalone OSS dep. Future alignment with core can
 *   happen once the package graduates from skeleton to full impl.
 *
 * - `WorkType` mirrors `AgentWorkType` from core (same string values) but is
 *   declared locally for the same provider-orthogonality reason.
 *
 * Observation pipeline, synthesis prompts, and drift detection logic are
 * out-of-scope for this skeleton.
 * The types here are the stable vocabulary those issues will target.
 */

// ---------------------------------------------------------------------------
// Scope + work type (local re-declarations for package independence)
// ---------------------------------------------------------------------------

/**
 * Four-level scope model matching core's ProviderScope.
 * Scoped so that project-level nodes are invisible at tenant scope unless
 * explicitly federated (RLS-enforced in the SaaS Postgres impl).
 *
 * Repo dimension (full repo-scoped synthesis):
 *   `repo` is an OPTIONAL refinement within a project/org scope. A project
 *   may aggregate multiple git repositories (a multi-repo "corpus"); tagging
 *   observations with the originating `repo` lets a query return synthesis
 *   for one repo's corpus rather than the whole project.
 *
 *   Backward compatibility: when `repo` is unset, behaviour is identical to
 *   the pre-repo-dimension SDK — writes carry no repo tag and reads return
 *   the full project/org corpus. Setting `repo` is purely additive.
 */
export interface ArchScope {
  level: 'project' | 'org' | 'tenant' | 'global'
  projectId?: string
  orgId?: string
  tenantId?: string
  /**
   * Optional repository identifier (e.g. "github.com/renseiai/platform").
   * When present on a contributed observation's scope, the observation is
   * tagged with this repo. When present on a query scope, the query narrows
   * to that repo's corpus. Unset → no repo tag / whole-project corpus.
   */
  repo?: string
}

/**
 * Work type that narrows retrieved architectural context.
 * Values mirror AgentWorkType from @donmai/core (core).
 */
export type WorkType =
  | 'research'
  | 'backlog-creation'
  | 'development'
  | 'inflight'
  | 'qa'
  | 'acceptance'
  | 'refinement'
  | 'refinement-coordination'
  | 'merge'
  | 'security'
  | string // extensible

// ---------------------------------------------------------------------------
// Citation — provenance chain for all architectural assertions
// ---------------------------------------------------------------------------

/**
 * Confidence levels for architectural citations.
 *
 * The "authored intent > inferences" constraint (007 §"Strategic positioning")
 * is enforced here. Implementations must rank citations in this order:
 *   authored > inferred-high > inferred-medium > inferred-low
 *
 * Authored sources: project-level CLAUDE.md, ADRs, explicit architectural docs.
 * Inferred sources: agent observations, PR analysis, code-pattern extraction.
 *
 * Inferences FILL GAPS and DETECT DRIFT. They never silently override authored
 * architectural intent. When an authored citation exists for a concept, an
 * inferred citation for the same concept is demoted to supplementary evidence.
 */
export type CitationConfidence =
  | 'authored'          // Human-authored doc (CLAUDE.md, ADR, explicit spec)
  | 'inferred-high'     // Strong inference from multiple converging signals
  | 'inferred-medium'   // Moderate inference from code patterns
  | 'inferred-low'      // Weak inference, speculative, needs validation

/** Numeric rank for comparison (higher = more authoritative). */
export const CITATION_CONFIDENCE_RANK: Record<CitationConfidence, number> = {
  'authored':          4,
  'inferred-high':     3,
  'inferred-medium':   2,
  'inferred-low':      1,
} as const

/**
 * Compute the effective set of repos a query is scoped to (full repo-scoped
 * synthesis). Unions `spec.scope.repo` (single-repo shorthand) with
 * `spec.repos` (explicit list), de-dups, and drops empties.
 *
 * Returns an empty array when no repo refinement is present — callers MUST
 * treat that as "whole project/org corpus" (backward-compatible default),
 * NOT as "match zero repos".
 *
 * Exported so all storage backends (sqlite, postgres) share one definition
 * of the repo-filter precedence rules.
 */
export function effectiveRepos(spec: ArchQuerySpec): string[] {
  const out = new Set<string>()
  if (typeof spec.scope.repo === 'string' && spec.scope.repo.length > 0) {
    out.add(spec.scope.repo)
  }
  if (Array.isArray(spec.repos)) {
    for (const r of spec.repos) {
      if (typeof r === 'string' && r.length > 0) out.add(r)
    }
  }
  return [...out]
}

/**
 * A citation traces an architectural assertion back to its origin.
 * Every `ArchitecturalPattern`, `Convention`, `Decision`, and `Deviation`
 * carries at least one citation.
 */
export interface Citation {
  /** Unique identifier for this citation record. */
  id: string

  /** Source of the claim. */
  source:
    | { kind: 'file'; path: string; lineStart?: number; lineEnd?: number }
    | { kind: 'session'; sessionId: string }
    | { kind: 'change'; changeRef: ChangeRef }
    | { kind: 'adr'; adrId: string; title?: string }
    | { kind: 'external'; url: string; title?: string }

  /** Confidence level — governs ranking priority. */
  confidence: CitationConfidence

  /** When this citation was recorded. */
  recordedAt: Date

  /** Human-readable excerpt or summary from the source. Optional. */
  excerpt?: string
}

// ---------------------------------------------------------------------------
// ChangeRef — provider-orthogonal VCS change reference
// ---------------------------------------------------------------------------

/**
 * Identifies a VCS change without coupling to a specific provider.
 * Used to cross-reference architectural nodes back to PRs/commits.
 *
 * A follow-up will wire the workarea observation seam; this type is the
 * declared contract that wiring targets.
 */
export interface ChangeRef {
  /** Repository URL (e.g., "github.com/renseiai/myapp"). */
  repository: string

  /**
   * The change kind determines which id fields are populated:
   * - 'commit': sha is present
   * - 'pr': prNumber is present
   * - 'branch': branch is present
   */
  kind: 'commit' | 'pr' | 'branch'

  /** Git commit SHA (kind='commit'). */
  sha?: string

  /** Pull request number (kind='pr'). */
  prNumber?: number

  /** Branch name (kind='branch'). */
  branch?: string

  /** Optional human-readable description (e.g., PR title). */
  description?: string
}

// ---------------------------------------------------------------------------
// ArchitecturalPattern
// ---------------------------------------------------------------------------

/**
 * A recurring structural or behavioral pattern observed across the codebase.
 *
 * Example: "Auth is centralized in lib/auth/middleware.ts — all routes delegate
 * to this middleware rather than implementing auth inline."
 */
export interface ArchitecturalPattern {
  id: string
  title: string
  description: string

  /**
   * Code regions where this pattern is observed.
   * Empty means pattern is conceptual / not tied to specific files.
   */
  locations: Array<{ path: string; role?: string }>

  /** Tags for grouping (e.g., 'auth', 'error-handling', 'routing'). */
  tags: string[]

  citations: Citation[]
  scope: ArchScope

  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// Convention
// ---------------------------------------------------------------------------

/**
 * A consistent practice the codebase follows across a domain.
 *
 * Example: "All API routes return Result<T, E> — never throw raw errors.
 * See packages/core/src/workarea/types.ts for the canonical definition."
 */
export interface Convention {
  id: string
  title: string
  description: string

  /**
   * Representative examples from the codebase (file paths + optional excerpts).
   */
  examples: Array<{ path: string; excerpt?: string }>

  /** Whether this convention is explicitly documented by humans (vs. inferred). */
  authored: boolean

  citations: Citation[]
  scope: ArchScope

  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * An architectural decision — a resolved trade-off with stated rationale.
 *
 * Example: "Drizzle was chosen over Prisma for edge-runtime support — see PR #142.
 * This decision is stable; re-litigating it without edge-runtime changing is drift."
 */
export interface Decision {
  id: string
  title: string

  /** The selected option. */
  chosen: string

  /** Alternatives that were evaluated and rejected. */
  alternatives: Array<{ option: string; rejectionReason?: string }>

  /** Rationale for the chosen option. */
  rationale: string

  /** Status of the decision. */
  status: 'active' | 'superseded' | 'deprecated'

  /**
   * If this decision supersedes an earlier one, points to the prior Decision id.
   */
  supersedes?: string

  citations: Citation[]
  scope: ArchScope

  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// Deviation
// ---------------------------------------------------------------------------

/**
 * A divergence from an established pattern, convention, or decision.
 *
 * Deviations may be:
 * - Intentional (team decided to evolve the convention for this area)
 * - Unintentional (oversight; should be aligned)
 * - Pending review (flagged but not yet triaged)
 *
 * The drift detection engine produces deviations; QA workflows surface them.
 */
export interface Deviation {
  id: string
  title: string
  description: string

  /** The established norm being deviated from. */
  deviatesFrom:
    | { kind: 'pattern'; patternId: string }
    | { kind: 'convention'; conventionId: string }
    | { kind: 'decision'; decisionId: string }

  /** The change that introduced this deviation. */
  introducedBy?: ChangeRef

  /** Triage status of the deviation. */
  status: 'pending' | 'intentional' | 'unintentional' | 'resolved'

  /**
   * Severity of the deviation (used by QA workflows to gate PRs).
   * 'high' = blocks PR; 'medium' = warning; 'low' = informational.
   */
  severity: 'high' | 'medium' | 'low'

  citations: Citation[]
  scope: ArchScope

  createdAt: Date
  updatedAt: Date
}

// ---------------------------------------------------------------------------
// DriftReport
// ---------------------------------------------------------------------------

/**
 * Result of `ArchitecturalIntelligence.assess(change)`.
 *
 * Reports whether a proposed or merged change diverges from established
 * architectural patterns and conventions.
 *
 * Deviations are separated by severity so QA workflows can gate on 'high'
 * deviations while surfacing 'low' ones as informational notes.
 */
export interface DriftReport {
  /** The change that was assessed. */
  change: ChangeRef

  /** New deviations introduced by this change. */
  deviations: Deviation[]

  /**
   * Patterns/conventions/decisions that are reinforced (positively) by this change.
   * Useful for positive feedback to agents.
   */
  reinforced: Array<
    | { kind: 'pattern'; patternId: string }
    | { kind: 'convention'; conventionId: string }
    | { kind: 'decision'; decisionId: string }
  >

  /** Whether this change introduces any high-severity deviations. */
  hasCriticalDrift: boolean

  /** Human-readable summary. */
  summary: string

  assessedAt: Date
}

// ---------------------------------------------------------------------------
// ArchView — the retrieval result surfaced at session start
// ---------------------------------------------------------------------------

/**
 * Retrieved architectural context for an agent session.
 *
 * Returned by `ArchitecturalIntelligence.query()`. Rendered into the agent
 * session prompt by the orchestrator.
 */
export interface ArchView {
  patterns: ArchitecturalPattern[]
  conventions: Convention[]
  decisions: Decision[]

  /**
   * All citations referenced by the above nodes.
   * Agents may use these to trace assertions back to source material.
   */
  citations: Citation[]

  /**
   * Current state of divergences in the queried region.
   * Only populated when `includeActiveDrift` is set in the query spec.
   */
  drift?: DriftReport

  /** Scope this view was retrieved for. */
  scope: ArchScope

  retrievedAt: Date
}

// ---------------------------------------------------------------------------
// ArchQuerySpec — query input
// ---------------------------------------------------------------------------

/**
 * Spec for `ArchitecturalIntelligence.query()`.
 *
 * `workType` narrows which architectural context is most relevant.
 * E.g., 'qa' retrieves deviation signals prominently; 'development'
 * retrieves active patterns and conventions for the touched paths.
 */
export interface ArchQuerySpec {
  workType: WorkType
  paths?: string[]
  issueId?: string
  scope: ArchScope
  maxTokens?: number
  includeActiveDrift?: boolean
  /**
   * Optional per-repo scoping refinement (full repo-scoped synthesis).
   *
   * When set, the query returns ONLY the architectural corpus for the named
   * repository/repositories — i.e. observations/nodes whose stored `repo`
   * tag matches one of these values. This is a TRUE corpus scope, distinct
   * from `paths` (which is a within-repo/within-project narrowing applied
   * on top of the corpus selection).
   *
   * Semantics:
   *   - `repos` unset (and `scope.repo` unset) → whole project/org corpus
   *     (backward-compatible default; repo-untagged rows are all returned).
   *   - `repos: ['github.com/acme/api']` → only that repo's corpus.
   *   - `repos: ['a', 'b']` → the union of both repos' corpora.
   *   - A single repo may also be expressed via `scope.repo`; when both are
   *     given, the effective filter is the union of `scope.repo` and `repos`.
   *
   * Composability with `paths`: `repos` selects which repo corpora are in
   * scope; `paths` then narrows within that selection. They are AND-ed.
   */
  repos?: string[]
}

// ---------------------------------------------------------------------------
// ArchObservation — write input
// ---------------------------------------------------------------------------

/**
 * An observation contributed to the architectural intelligence graph.
 *
 * Observations are the raw input; the synthesis pipeline refines
 * them into `ArchitecturalPattern`, `Convention`, `Decision`, and `Deviation`
 * nodes.
 *
 * The `confidence` field is a 0–1 float representing observation strength.
 * It maps to `CitationConfidence` in the storage layer:
 *   >= 0.9 → 'authored' (only when source is a human-authored doc)
 *   >= 0.7 → 'inferred-high'
 *   >= 0.4 → 'inferred-medium'
 *   <  0.4 → 'inferred-low'
 *
 * Repo tagging (full repo-scoped synthesis): set `scope.repo` to associate
 * the observation with a specific repository. Repo-tagged observations are
 * filterable via `ArchQuerySpec.repos` / `ArchQuerySpec.scope.repo`. Leaving
 * `scope.repo` unset keeps the observation project/org-scoped only
 * (backward-compatible).
 */
export interface ArchObservation {
  kind: 'pattern' | 'convention' | 'decision' | 'deviation'
  payload: unknown
  source: {
    sessionId?: string
    changeRef?: ChangeRef
    /** When produced by a kit's intelligence extractor. */
    extractorId?: string
    /**
     * When the source is a human-authored document (CLAUDE.md, ADR).
     * Setting this AND confidence >= 0.9 produces an 'authored' citation.
     */
    authoredDoc?: { path: string; kind: 'claude-md' | 'adr' | 'spec' }
  }
  /** 0..1 strength; see CitationConfidence mapping above. */
  confidence: number
  scope: ArchScope
}

// ---------------------------------------------------------------------------
// ArchitecturalIntelligence — the four-method interface contract
// ---------------------------------------------------------------------------

/**
 * The primary interface for the Architectural Intelligence service.
 *
 * Architecture reference: 007-intelligence-services.md §Contract
 *
 * Implementations:
 *   - `SqliteArchitecturalIntelligence` (this package) — single-tenant, local.
 *     Uses node:sqlite (Node 22+) with text-search. Placeholder for vector
 *     index; embeddings added in a follow-up.
 *   - `PostgresArchitecturalIntelligence` (stub) — multi-tenant SaaS.
 *     deferred to follow-up work; reuses Memory's RLS layer.
 *
 * Constraint (non-negotiable per 007 §"Strategic positioning"):
 *   Authored intent (CLAUDE.md, ADRs) is always higher-confidence than
 *   inferences. Inferences fill gaps and detect drift. They NEVER silently
 *   override authored architectural intent. The `Citation.confidence` field
 *   is the mechanical enforcement of this constraint.
 */
export interface ArchitecturalIntelligence {
  /**
   * Retrieve architectural context relevant to a session.
   *
   * Called automatically at session start by the orchestrator; agents may
   * also call it directly via MCP tools.
   *
   * Priority ordering for bounded context (maxTokens):
   *   drift warnings > active issue patterns > project-wide conventions > org-wide patterns
   *
   * Repo scoping: when `spec.repos` (or `spec.scope.repo`) is set, the
   * returned view is restricted to the named repositories' corpora. When
   * unset, the full project/org corpus is returned (backward-compatible).
   */
  query(spec: ArchQuerySpec): Promise<ArchView>

  /**
   * Contribute an observation to the architectural graph.
   *
   * Producers: PR merges, refactors, agent decisions, kit-shipped extractors.
   * The synthesis pipeline will later refine raw observations into
   * higher-level architectural nodes.
   */
  contribute(observation: ArchObservation): Promise<void>

  /**
   * Synthesize human-readable architectural documentation on request.
   *
   * The structured graph is the source-of-truth; this method renders it into
   * a requested format. Markdown: prose; Mermaid: diagrams; JSON: raw nodes.
   *
   * NOTE: This is a skeleton — the synthesis prompt is out-of-scope for
   *. The stub returns a placeholder string.
   */
  synthesize(scope: ArchScope, format: 'markdown' | 'mermaid' | 'json'): Promise<string>

  /**
   * Assess a change for architectural drift.
   *
   * Surfaces in QA workflows; used by agents during PR self-review.
   * High-severity deviations can block PRs per tenant policy.
   *
   * NOTE: This is a skeleton — the drift detection algorithm is out-of-scope
   * for. The stub returns an empty DriftReport.
   */
  assess(change: ChangeRef): Promise<DriftReport>
}
