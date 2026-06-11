/**
 * SqliteArchitecturalIntelligence — single-tenant local implementation
 *
 * Architecture reference: donmai-architecture/007-intelligence-services.md
 * §"OSS vs SaaS responsibilities" — OSS ships single-project synthesis with
 * sqlite + local storage.
 *
 * Storage layout (single SQLite database file):
 *   - `observations`  — raw `ArchObservation` rows (JSON payload)
 *   - `patterns`      — `ArchitecturalPattern` rows
 *   - `conventions`   — `Convention` rows
 *   - `decisions`     — `Decision` rows
 *   - `deviations`    — `Deviation` rows
 *   - `citations`     — `Citation` rows, FK'd to owning nodes
 *
 * Search strategy (skeleton):
 *   Text-search via SQL LIKE / INSTR — a placeholder for proper BM25 or
 *   vector-embedding search. Embeddings and BM25 are added in a follow-up
 *   issue. The storage schema is intentionally simple so the
 *   follow-up can upgrade it incrementally.
 *
 * Authored-intent constraint:
 *   `Citation.confidence = 'authored'` rows are always ranked above inferred
 *   rows by the query layer (ORDER BY confidence_rank DESC). This is the
 *   mechanical enforcement of 007 §"non-negotiable principles".
 *
 * node:sqlite (Node 22+) is used instead of better-sqlite3 because it is
 * available in the process and requires no native build. The API is
 * synchronous (same as better-sqlite3) so the async wrapper is trivial.
 */

import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
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
  DriftReport,
  Citation,
  CitationConfidence,
  ChangeRef,
} from './types.js'
import { CITATION_CONFIDENCE_RANK, effectiveRepos } from './types.js'
import type { ModelAdapter } from './eval.js'
import { assessChange } from './drift.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SqliteArchConfig {
  /**
   * Absolute path to the SQLite database file.
   * Defaults to `.donmai/arch-intelligence/db.sqlite`.
   */
  dbPath?: string
}

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

const SCHEMA_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS observations (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  confidence   REAL NOT NULL,
  scope_level  TEXT NOT NULL,
  scope_json   TEXT NOT NULL,
  source_json  TEXT NOT NULL,
  repo         TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS citations (
  id               TEXT PRIMARY KEY,
  owner_kind       TEXT NOT NULL,
  owner_id         TEXT NOT NULL,
  source_json      TEXT NOT NULL,
  confidence       TEXT NOT NULL,
  confidence_rank  INTEGER NOT NULL,
  recorded_at      TEXT NOT NULL,
  excerpt          TEXT
);

CREATE INDEX IF NOT EXISTS idx_citations_owner ON citations(owner_kind, owner_id);

CREATE TABLE IF NOT EXISTS patterns (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  locations    TEXT NOT NULL,
  tags         TEXT NOT NULL,
  scope_json   TEXT NOT NULL,
  repo         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conventions (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  examples     TEXT NOT NULL,
  authored     INTEGER NOT NULL DEFAULT 0,
  scope_json   TEXT NOT NULL,
  repo         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  chosen       TEXT NOT NULL,
  alternatives TEXT NOT NULL,
  rationale    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',
  supersedes   TEXT,
  scope_json   TEXT NOT NULL,
  repo         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deviations (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  deviates_from    TEXT NOT NULL,
  introduced_by    TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  severity         TEXT NOT NULL DEFAULT 'medium',
  scope_json       TEXT NOT NULL,
  repo             TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
`

/**
 * Additive, idempotent migration for databases created before the repo
 * dimension shipped. node:sqlite has no IF NOT EXISTS for ADD COLUMN, so we
 * probe the column list and only ALTER when the column is absent. Safe to run
 * on every construction — a no-op once the column exists.
 */
function ensureRepoColumns(db: DatabaseSync): void {
  for (const table of ['observations', 'patterns', 'conventions', 'decisions', 'deviations']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string
    }>
    if (!cols.some((c) => c.name === 'repo')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN repo TEXT`)
    }
  }
}

// ---------------------------------------------------------------------------
// Row types (internal)
// ---------------------------------------------------------------------------

interface CitationRow {
  id: string
  owner_kind: string
  owner_id: string
  source_json: string
  confidence: string
  confidence_rank: number
  recorded_at: string
  excerpt: string | null
}

interface PatternRow {
  id: string
  title: string
  description: string
  locations: string
  tags: string
  scope_json: string
  created_at: string
  updated_at: string
}

interface ConventionRow {
  id: string
  title: string
  description: string
  examples: string
  authored: number
  scope_json: string
  created_at: string
  updated_at: string
}

interface DecisionRow {
  id: string
  title: string
  chosen: string
  alternatives: string
  rationale: string
  status: string
  supersedes: string | null
  scope_json: string
  created_at: string
  updated_at: string
}

interface DeviationRow {
  id: string
  title: string
  description: string
  deviates_from: string
  introduced_by: string | null
  status: string
  severity: string
  scope_json: string
  created_at: string
  updated_at: string
}

// ---------------------------------------------------------------------------
// SqliteArchitecturalIntelligence
// ---------------------------------------------------------------------------

/**
 * Single-tenant, local SQLite implementation of ArchitecturalIntelligence.
 *
 * This is the OSS reference implementation. The SaaS Postgres implementation
 * shares the same interface; deployers choose which to instantiate.
 */
export class SqliteArchitecturalIntelligence implements ArchitecturalIntelligence {
  private readonly _db: DatabaseSync
  private _modelAdapter: ModelAdapter | undefined
  private readonly _defaultScope: ArchScope

  constructor(config: SqliteArchConfig = {}) {
    const dbPath = config.dbPath ?? '.donmai/arch-intelligence/db.sqlite'

    // Ensure parent directory exists
    const dir = dirname(dbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    this._db = new DatabaseSync(dbPath)
    this._db.exec(SCHEMA_DDL)
    ensureRepoColumns(this._db)

    this._defaultScope = { level: 'project' }
  }

  // ---------------------------------------------------------------------------
  // query()
  // ---------------------------------------------------------------------------

  async query(spec: ArchQuerySpec): Promise<ArchView> {
    const scope = spec.scope
    const scopeLevel = scope.level

    // Per-repo scoping (full repo-scoped synthesis). When the query names one
    // or more repos, restrict the corpus to rows tagged with a matching repo.
    // When no repos are named, the clause is empty and the whole project/org
    // corpus is returned (backward-compatible).
    const repos = effectiveRepos(spec)
    const repoClause =
      repos.length > 0
        ? ` AND repo IN (${repos.map(() => '?').join(', ')})`
        : ''

    // Retrieve patterns (text-search placeholder: all rows matching scope)
    // node:sqlite .all() returns Record<string, SQLOutputValue>[] — cast via unknown
    const patternRows = this._db.prepare(
      `SELECT * FROM patterns WHERE JSON_EXTRACT(scope_json, '$.level') = ?${repoClause} ORDER BY updated_at DESC`,
    ).all(scopeLevel, ...repos) as unknown as PatternRow[]

    // Optionally narrow to paths
    const filteredPatternRows = spec.paths && spec.paths.length > 0
      ? patternRows.filter((r) => {
          const locs = JSON.parse(r.locations) as Array<{ path: string }>
          return locs.some((l) =>
            spec.paths!.some((p) => l.path.includes(p) || p.includes(l.path)),
          )
        })
      : patternRows

    const patterns: ArchitecturalPattern[] = filteredPatternRows.map((r) =>
      this._rowToPattern(r),
    )

    // Retrieve conventions
    const conventionRows = this._db.prepare(
      `SELECT * FROM conventions WHERE JSON_EXTRACT(scope_json, '$.level') = ?${repoClause} ORDER BY authored DESC, updated_at DESC`,
    ).all(scopeLevel, ...repos) as unknown as ConventionRow[]

    const conventions: Convention[] = conventionRows.map((r) =>
      this._rowToConvention(r),
    )

    // Retrieve decisions (active only)
    const decisionRows = this._db.prepare(
      `SELECT * FROM decisions WHERE JSON_EXTRACT(scope_json, '$.level') = ? AND status = 'active'${repoClause} ORDER BY updated_at DESC`,
    ).all(scopeLevel, ...repos) as unknown as DecisionRow[]

    const decisions: Decision[] = decisionRows.map((r) =>
      this._rowToDecision(r),
    )

    // Collect all citations for returned nodes
    const allCitations: Citation[] = []
    for (const p of patterns) {
      allCitations.push(...this._loadCitations('pattern', p.id))
    }
    for (const c of conventions) {
      allCitations.push(...this._loadCitations('convention', c.id))
    }
    for (const d of decisions) {
      allCitations.push(...this._loadCitations('decision', d.id))
    }

    // Sort citations: authored first, then by confidence rank desc
    allCitations.sort(
      (a, b) =>
        CITATION_CONFIDENCE_RANK[b.confidence] - CITATION_CONFIDENCE_RANK[a.confidence],
    )

    const view: ArchView = {
      patterns,
      conventions,
      decisions,
      citations: _deduplicateCitations(allCitations),
      scope,
      retrievedAt: new Date(),
    }

    if (spec.includeActiveDrift) {
      // Drift report is a skeleton placeholder — deferred to follow-up work
      view.drift = _emptyDriftReport(scope)
    }

    return view
  }

  // ---------------------------------------------------------------------------
  // contribute()
  // ---------------------------------------------------------------------------

  async contribute(observation: ArchObservation): Promise<void> {
    const id = randomUUID()
    const now = new Date().toISOString()

    this._db.prepare(
      `INSERT INTO observations (id, kind, payload, confidence, scope_level, scope_json, source_json, repo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      observation.kind,
      JSON.stringify(observation.payload),
      observation.confidence,
      observation.scope.level,
      JSON.stringify(observation.scope),
      JSON.stringify(observation.source),
      observation.scope.repo ?? null,
      now,
    )

    // Materialize the observation into a typed architectural node.
    // This is a simplified direct-materialization path for the skeleton.
    // The full synthesis pipeline (prompts, clustering, dedup) is deferred
    // to follow-up work and will replace this direct path.
    switch (observation.kind) {
      case 'pattern':
        this._materializePattern(id, observation, now)
        break
      case 'convention':
        this._materializeConvention(id, observation, now)
        break
      case 'decision':
        this._materializeDecision(id, observation, now)
        break
      case 'deviation':
        this._materializeDeviation(id, observation, now)
        break
    }
  }

  // ---------------------------------------------------------------------------
  // synthesize()
  // ---------------------------------------------------------------------------

  async synthesize(scope: ArchScope, format: 'markdown' | 'mermaid' | 'json'): Promise<string> {
    // Skeleton placeholder — synthesis prompts are out-of-scope for.
    // The full synthesis implementation is deferred to.
    const view = await this.query({ workType: 'research', scope, includeActiveDrift: false })

    if (format === 'json') {
      return JSON.stringify(view, null, 2)
    }

    if (format === 'mermaid') {
      // Stub: return a minimal diagram skeleton
      const lines = ['graph TD']
      for (const p of view.patterns) {
        lines.push(`  P_${_slugId(p.id)}["Pattern: ${_escape(p.title)}"]`)
      }
      for (const c of view.conventions) {
        lines.push(`  C_${_slugId(c.id)}["Convention: ${_escape(c.title)}"]`)
      }
      return lines.join('\n')
    }

    // markdown
    const parts: string[] = [
      `# Architectural Overview`,
      ``,
      `> Auto-synthesized from the architectural intelligence graph.`,
      `> Authored citations rank above inferences. See Citation.confidence for provenance.`,
      ``,
    ]

    if (view.patterns.length > 0) {
      parts.push(`## Patterns`, '')
      for (const p of view.patterns) {
        parts.push(`### ${p.title}`, '', p.description, '')
      }
    }

    if (view.conventions.length > 0) {
      parts.push(`## Conventions`, '')
      for (const c of view.conventions) {
        parts.push(`### ${c.title}`, '', c.description, '')
      }
    }

    if (view.decisions.length > 0) {
      parts.push(`## Decisions`, '')
      for (const d of view.decisions) {
        parts.push(`### ${d.title}`, '', `**Chosen:** ${d.chosen}`, '', d.rationale, '')
      }
    }

    return parts.join('\n')
  }

  // ---------------------------------------------------------------------------
  // assess()
  // ---------------------------------------------------------------------------

  /**
   * Assess a change for architectural drift.
   *
   * Delegates to the `assessChange()` function in drift.ts, which
   * runs the deviation-detection prompt and returns a structured DriftReport.
   *
   * Requires a ModelAdapter. When called without one (e.g., from query() with
   * includeActiveDrift=true and no adapter provided), returns an empty report
   * with an informational message — the caller should inject an adapter via
   * assessWithAdapter().
   *
   * Use `assessWithAdapter()` for the full drift detection flow.
   */
  async assess(change: ChangeRef): Promise<DriftReport> {
    if (!this._modelAdapter) {
      // No adapter configured — return a minimal informational report.
      // Callers that need actual drift detection should use assessWithAdapter().
      return {
        change,
        deviations: [],
        reinforced: [],
        hasCriticalDrift: false,
        summary:
          'No model adapter configured. Call assessWithAdapter(change, adapter) ' +
          'for full drift detection. Set a default adapter via setModelAdapter().',
        assessedAt: new Date(),
      }
    }

    return assessChange(this, this._modelAdapter, { change, scope: this._defaultScope })
  }

  /**
   * Assess a change for architectural drift using a specific model adapter.
   *
   * This is the preferred entry point for ad-hoc assessment (e.g., CLI usage).
   * The `adapter` parameter is the LLM interface — inject a deterministic stub
   * in tests.
   *
   * @param change  - The VCS change reference to assess.
   * @param adapter - The model adapter (Anthropic SDK, stub, etc.).
   * @param prDiff  - Optional PR diff for diff-signal detection.
   * @param scope   - Scope to query the baseline against (defaults to project-level).
   */
  async assessWithAdapter(
    change: ChangeRef,
    adapter: ModelAdapter,
    prDiff?: import('./diff-reader.js').PrDiff,
    scope?: import('./types.js').ArchScope,
  ): Promise<DriftReport> {
    return assessChange(this, adapter, {
      change,
      prDiff,
      scope: scope ?? this._defaultScope,
    })
  }

  /**
   * Set a default model adapter for `assess()` calls that don't specify one.
   * Optional — only needed when assess() is called without an explicit adapter.
   */
  setModelAdapter(adapter: ModelAdapter): void {
    this._modelAdapter = adapter
  }

  // ---------------------------------------------------------------------------
  // Internal: materialization helpers
  // ---------------------------------------------------------------------------

  /**
   * Materialize a 'pattern' observation into the patterns table.
   * The observation payload is treated as Partial<ArchitecturalPattern>.
   */
  private _materializePattern(
    observationId: string,
    obs: ArchObservation,
    now: string,
  ): void {
    const payload = obs.payload as Partial<ArchitecturalPattern> & Record<string, unknown>
    const id = randomUUID()
    const title = String(payload['title'] ?? 'Untitled pattern')
    const description = String(payload['description'] ?? '')
    const locations = JSON.stringify(payload['locations'] ?? [])
    const tags = JSON.stringify(payload['tags'] ?? [])

    this._db.prepare(
      `INSERT INTO patterns (id, title, description, locations, tags, scope_json, repo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, title, description, locations, tags, JSON.stringify(obs.scope), obs.scope.repo ?? null, now, now)

    this._insertCitation('pattern', id, obs, observationId, now)
  }

  /**
   * Materialize a 'convention' observation into the conventions table.
   */
  private _materializeConvention(
    observationId: string,
    obs: ArchObservation,
    now: string,
  ): void {
    const payload = obs.payload as Partial<Convention> & Record<string, unknown>
    const id = randomUUID()
    const title = String(payload['title'] ?? 'Untitled convention')
    const description = String(payload['description'] ?? '')
    const examples = JSON.stringify(payload['examples'] ?? [])
    const authored = obs.source.authoredDoc ? 1 : 0

    this._db.prepare(
      `INSERT INTO conventions (id, title, description, examples, authored, scope_json, repo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, title, description, examples, authored, JSON.stringify(obs.scope), obs.scope.repo ?? null, now, now)

    this._insertCitation('convention', id, obs, observationId, now)
  }

  /**
   * Materialize a 'decision' observation into the decisions table.
   */
  private _materializeDecision(
    observationId: string,
    obs: ArchObservation,
    now: string,
  ): void {
    const payload = obs.payload as Partial<Decision> & Record<string, unknown>
    const id = randomUUID()
    const title = String(payload['title'] ?? 'Untitled decision')
    const chosen = String(payload['chosen'] ?? '')
    const alternatives = JSON.stringify(payload['alternatives'] ?? [])
    const rationale = String(payload['rationale'] ?? '')
    const status = String(payload['status'] ?? 'active')

    this._db.prepare(
      `INSERT INTO decisions (id, title, chosen, alternatives, rationale, status, scope_json, repo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, title, chosen, alternatives, rationale, status, JSON.stringify(obs.scope), obs.scope.repo ?? null, now, now)

    this._insertCitation('decision', id, obs, observationId, now)
  }

  /**
   * Materialize a 'deviation' observation into the deviations table.
   */
  private _materializeDeviation(
    observationId: string,
    obs: ArchObservation,
    now: string,
  ): void {
    const payload = obs.payload as Partial<Deviation> & Record<string, unknown>
    const id = randomUUID()
    const title = String(payload['title'] ?? 'Untitled deviation')
    const description = String(payload['description'] ?? '')
    const deviatesFrom = JSON.stringify(
      payload['deviatesFrom'] ?? { kind: 'pattern', patternId: 'unknown' },
    )
    const introducedBy = obs.source.changeRef
      ? JSON.stringify(obs.source.changeRef)
      : null
    const status = String(payload['status'] ?? 'pending')
    const severity = String(payload['severity'] ?? 'medium')

    this._db.prepare(
      `INSERT INTO deviations (id, title, description, deviates_from, introduced_by, status, severity, scope_json, repo, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, title, description, deviatesFrom, introducedBy,
      status, severity, JSON.stringify(obs.scope), obs.scope.repo ?? null, now, now,
    )

    this._insertCitation('deviation', id, obs, observationId, now)
  }

  /**
   * Insert a citation row for a newly materialized node.
   *
   * The confidence level is derived from the observation's numeric confidence
   * and whether the source is an authored document. The authored-intent
   * constraint is enforced here: only observations from authoredDoc sources
   * with confidence >= 0.9 receive 'authored' confidence.
   */
  private _insertCitation(
    ownerKind: string,
    ownerId: string,
    obs: ArchObservation,
    observationId: string,
    now: string,
  ): void {
    const confidence = _observationConfidenceToLevel(obs)
    const citationId = randomUUID()

    let sourceJson: string
    if (obs.source.authoredDoc) {
      sourceJson = JSON.stringify({
        kind: 'file',
        path: obs.source.authoredDoc.path,
      })
    } else if (obs.source.changeRef) {
      sourceJson = JSON.stringify({ kind: 'change', changeRef: obs.source.changeRef })
    } else if (obs.source.sessionId) {
      sourceJson = JSON.stringify({ kind: 'session', sessionId: obs.source.sessionId })
    } else {
      sourceJson = JSON.stringify({ kind: 'session', sessionId: observationId })
    }

    this._db.prepare(
      `INSERT INTO citations (id, owner_kind, owner_id, source_json, confidence, confidence_rank, recorded_at, excerpt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      citationId,
      ownerKind,
      ownerId,
      sourceJson,
      confidence,
      CITATION_CONFIDENCE_RANK[confidence],
      now,
    )
  }

  // ---------------------------------------------------------------------------
  // Internal: row → domain type helpers
  // ---------------------------------------------------------------------------

  private _rowToPattern(r: PatternRow): ArchitecturalPattern {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      locations: JSON.parse(r.locations) as Array<{ path: string; role?: string }>,
      tags: JSON.parse(r.tags) as string[],
      citations: this._loadCitations('pattern', r.id),
      scope: JSON.parse(r.scope_json) as ArchScope,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    }
  }

  private _rowToConvention(r: ConventionRow): Convention {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      examples: JSON.parse(r.examples) as Array<{ path: string; excerpt?: string }>,
      authored: r.authored === 1,
      citations: this._loadCitations('convention', r.id),
      scope: JSON.parse(r.scope_json) as ArchScope,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    }
  }

  private _rowToDecision(r: DecisionRow): Decision {
    return {
      id: r.id,
      title: r.title,
      chosen: r.chosen,
      alternatives: JSON.parse(r.alternatives) as Array<{ option: string; rejectionReason?: string }>,
      rationale: r.rationale,
      status: r.status as Decision['status'],
      supersedes: r.supersedes ?? undefined,
      citations: this._loadCitations('decision', r.id),
      scope: JSON.parse(r.scope_json) as ArchScope,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    }
  }

  private _rowToDeviation(r: DeviationRow): Deviation {
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      deviatesFrom: JSON.parse(r.deviates_from) as Deviation['deviatesFrom'],
      introducedBy: r.introduced_by ? JSON.parse(r.introduced_by) as ChangeRef : undefined,
      status: r.status as Deviation['status'],
      severity: r.severity as Deviation['severity'],
      citations: this._loadCitations('deviation', r.id),
      scope: JSON.parse(r.scope_json) as ArchScope,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    }
  }

  private _loadCitations(ownerKind: string, ownerId: string): Citation[] {
    const rows = this._db.prepare(
      `SELECT * FROM citations WHERE owner_kind = ? AND owner_id = ? ORDER BY confidence_rank DESC`,
    ).all(ownerKind, ownerId) as unknown as CitationRow[]

    return rows.map((r) => ({
      id: r.id,
      source: JSON.parse(r.source_json) as Citation['source'],
      confidence: r.confidence as CitationConfidence,
      recordedAt: new Date(r.recorded_at),
      excerpt: r.excerpt ?? undefined,
    }))
  }

  // ---------------------------------------------------------------------------
  // Test / diagnostic helpers
  // ---------------------------------------------------------------------------

  /**
   * Return all stored observations (for testing / diagnostics).
   */
  _getAllObservations(): Array<{
    id: string
    kind: string
    confidence: number
    scope_level: string
    created_at: string
  }> {
    return this._db.prepare(
      `SELECT id, kind, confidence, scope_level, created_at FROM observations ORDER BY created_at DESC`,
    ).all() as unknown as Array<{ id: string; kind: string; confidence: number; scope_level: string; created_at: string }>
  }

  /**
   * Return all stored deviations (for testing / diagnostics).
   */
  _getAllDeviations(): Deviation[] {
    const rows = this._db.prepare(
      `SELECT * FROM deviations ORDER BY created_at DESC`,
    ).all() as unknown as DeviationRow[]
    return rows.map((r) => this._rowToDeviation(r))
  }

  /**
   * Close the database connection.
   * Should be called after tests to release file locks.
   */
  close(): void {
    this._db.close()
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Map an observation's numeric confidence + authoredDoc flag to a
 * CitationConfidence level.
 *
 * The authored-intent constraint: only authored-doc sources with confidence
 * >= 0.9 receive 'authored'. All other sources are inferred.
 */
function _observationConfidenceToLevel(obs: ArchObservation): CitationConfidence {
  if (obs.source.authoredDoc && obs.confidence >= 0.9) return 'authored'
  if (obs.confidence >= 0.7) return 'inferred-high'
  if (obs.confidence >= 0.4) return 'inferred-medium'
  return 'inferred-low'
}

/**
 * De-duplicate citations by id (multiple nodes may reference the same citation source).
 */
function _deduplicateCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>()
  return citations.filter((c) => {
    if (seen.has(c.id)) return false
    seen.add(c.id)
    return true
  })
}

/**
 * Return an empty DriftReport (skeleton placeholder).
 */
function _emptyDriftReport(scope: ArchScope): DriftReport {
  return {
    change: { repository: '', kind: 'branch', branch: 'unknown' },
    deviations: [],
    reinforced: [],
    hasCriticalDrift: false,
    summary: 'Drift assessment not yet implemented.',
    assessedAt: new Date(),
  }
}

// Suppress unused warning
void _emptyDriftReport

/**
 * Produce a short slug from a UUID for use in mermaid node IDs.
 */
function _slugId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8)
}

/**
 * Escape double-quotes in mermaid labels.
 */
function _escape(s: string): string {
  return s.replace(/"/g, "'")
}
