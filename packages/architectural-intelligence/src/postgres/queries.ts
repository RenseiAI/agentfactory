/**
 * Read-path queries for the Postgres backend.
 *
 * Multi-tenant model: every read filters by `(org_id, project_id)` at the
 * application layer. RLS at the Postgres session level is deferred to a
 * follow-up (FU-2 in `runs/2026-05-18-MASTER-foundation-too-PLAN.md`); the
 * deferral is operational, not architectural — the column shape and
 * SDK contract already accommodate RLS.
 *
 * Read source: `graph_nodes` table. The `observations` table is the raw
 * ingest layer; SDK consumers reading the synthesised view of patterns /
 * conventions / decisions / deviations read from `graph_nodes`.
 */

import type {
  ArchQuerySpec,
  ArchView,
  ArchitecturalPattern,
  Convention,
  Decision,
  Citation,
} from '../types.js'
import { CITATION_CONFIDENCE_RANK, effectiveRepos } from '../types.js'
import type { PostgresDbAdapter } from './adapter.js'
import {
  type GraphNodeRow,
  rowToPattern,
  rowToConvention,
  rowToDecision,
} from './mappers.js'

const ARCH_KINDS: ReadonlyArray<'pattern' | 'convention' | 'decision' | 'deviation'> = [
  'pattern',
  'convention',
  'decision',
  'deviation',
]

/**
 * SELECT clause used by every read — keeps the column→camelCase mapping
 * in one place so callers don't drift.
 */
const SELECT_GRAPH_NODE_COLUMNS = `
  id,
  name,
  type,
  description,
  properties,
  importance_weight AS "importanceWeight",
  org_id AS "orgId",
  project_id AS "projectId",
  repo,
  source_observation_id AS "sourceObservationId",
  source_session_id AS "sourceSessionId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

/**
 * Implementation of `ArchitecturalIntelligence.query()` against Postgres.
 *
 * @param db        - injected adapter
 * @param orgId     - tenant scoping (required)
 * @param projectId - optional project scoping (when undefined, queries
 *                    the entire org's project corpus; SDK convention is
 *                    to require projectId at the spec level — this kept
 *                    permissive for org-wide synthesis)
 * @param spec      - SDK query spec; `paths`, `includeActiveDrift`, etc.
 */
export async function queryArchView(
  db: PostgresDbAdapter,
  orgId: string,
  projectId: string | undefined,
  spec: ArchQuerySpec,
): Promise<ArchView> {
  // Full repo-scoped synthesis: when the spec names repos, narrow the corpus
  // to graph_nodes tagged with a matching `repo`. Empty → whole project/org
  // corpus (backward-compatible).
  const repos = effectiveRepos(spec)
  const rows = await fetchGraphNodes(
    db,
    orgId,
    projectId,
    ARCH_KINDS as readonly string[],
    repos,
  )

  const patterns: ArchitecturalPattern[] = []
  const conventions: Convention[] = []
  const decisions: Decision[] = []

  for (const row of rows) {
    switch (row.type) {
      case 'pattern':
        patterns.push(rowToPattern(row))
        break
      case 'convention':
        conventions.push(rowToConvention(row))
        break
      case 'decision': {
        const decision = rowToDecision(row)
        if (decision.status === 'active') decisions.push(decision)
        break
      }
      // deviations are handled via the drift report path
    }
  }

  // Optional path narrowing — pattern locations only.
  const filteredPatterns =
    spec.paths && spec.paths.length > 0
      ? patterns.filter((p) =>
          p.locations.some((l) =>
            spec.paths!.some((q) => l.path.includes(q) || q.includes(l.path)),
          ),
        )
      : patterns

  // Citations: union across the three node kinds, dedup by id, rank by
  // confidence (authored first). Matches the sqlite impl's contract.
  const citations: Citation[] = []
  for (const p of filteredPatterns) citations.push(...p.citations)
  for (const c of conventions) citations.push(...c.citations)
  for (const d of decisions) citations.push(...d.citations)
  citations.sort(
    (a, b) =>
      CITATION_CONFIDENCE_RANK[b.confidence] - CITATION_CONFIDENCE_RANK[a.confidence],
  )

  const view: ArchView = {
    patterns: filteredPatterns,
    conventions,
    decisions,
    citations: dedupeCitations(citations),
    scope: spec.scope,
    retrievedAt: new Date(),
  }

  if (spec.includeActiveDrift) {
    // Placeholder — drift detection lives in drift.ts and is
    // adapter-agnostic; surfacing it here would require a ModelAdapter
    // injection that's out-of-scope for the data-layer impl. Consumers
    // requesting drift call `assess()` separately, mirroring how the
    // sqlite impl handles it.
    view.drift = {
      change: { repository: '', kind: 'branch', branch: 'unknown' },
      deviations: [],
      reinforced: [],
      hasCriticalDrift: false,
      summary:
        'Drift detection not surfaced inside query(). Call assess(change, ...) ' +
        'with a model adapter for a real drift report.',
      assessedAt: new Date(),
    }
  }

  return view
}

/**
 * Fetch deviation rows for `getArchDrift`-style queries.
 *
 * Currently unused by `query()` itself (deviations don't flow through
 * `ArchView.drift`); exposed for synthesize() and future drift-only API
 * shapes.
 */
export async function fetchDeviationRows(
  db: PostgresDbAdapter,
  orgId: string,
  projectId: string | undefined,
): Promise<GraphNodeRow[]> {
  return fetchGraphNodes(db, orgId, projectId, ['deviation'])
}

/**
 * Core read primitive — scoped fetch of graph_nodes rows by kind set.
 *
 * @param repos Optional per-repo corpus filter (full repo-scoped synthesis).
 *   When non-empty, restricts to rows whose `repo` column matches one of the
 *   values. Empty / omitted → whole project/org corpus (backward-compatible);
 *   repo-untagged rows are returned in that case.
 */
export async function fetchGraphNodes(
  db: PostgresDbAdapter,
  orgId: string,
  projectId: string | undefined,
  kinds: readonly string[],
  repos: readonly string[] = [],
): Promise<GraphNodeRow[]> {
  // Postgres ANY ($1::text[]) parameter for the kind set; org_id at $2;
  // optional project_id and repo filter follow as positional params.
  const params: unknown[] = [Array.from(kinds), orgId]
  let where = `WHERE type = ANY ($1::text[]) AND org_id = $2`
  if (projectId !== undefined) {
    params.push(projectId)
    where += ` AND project_id = $${params.length}`
  }
  if (repos.length > 0) {
    params.push(Array.from(repos))
    where += ` AND repo = ANY ($${params.length}::text[])`
  }

  const text = `
    SELECT ${SELECT_GRAPH_NODE_COLUMNS}
    FROM graph_nodes
    ${where}
    ORDER BY importance_weight DESC, updated_at DESC
  `

  return db.query<GraphNodeRow>(text, params)
}

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>()
  const out: Citation[] = []
  for (const c of citations) {
    if (seen.has(c.id)) continue
    seen.add(c.id)
    out.push(c)
  }
  return out
}
