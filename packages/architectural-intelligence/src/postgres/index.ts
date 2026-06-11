/**
 * PostgresArchitecturalIntelligence — Postgres backend for the
 * `ArchitecturalIntelligence` interface.
 *
 * Architecture references:
 *   - donmai-architecture/007-intelligence-services.md
 *     §"OSS vs SaaS responsibilities"
 *   - ADR-2026-05-18-arch-intel-continuous-learning.md §Decision §3
 *     "SDK is the data layer"
 *
 * Wiring shape (SDK adapter pattern):
 *   The SDK does NOT own its Postgres connection. The consumer constructs
 *   a `PostgresDbAdapter` (a small duck-typed surface satisfied by
 *   postgres-js, drizzle/postgres-js, or an in-memory test stub) and
 *   passes it in. This:
 *     - keeps the SDK orthogonal to driver / pool lifecycle
 *     - lets the consumer own RLS policy, transaction boundaries, and
 *       schema migrations
 *     - keeps the SDK's test suite hermetic (no testcontainers)
 *
 * Multi-tenant model:
 *   App-level org scoping. Every read filters by `org_id`; project
 *   filtering is optional but recommended. Full RLS at the Postgres
 *   session level is deferred to FU-2 in
 *   `runs/2026-05-18-MASTER-foundation-too-PLAN.md`.
 *
 * jsonb hygiene:
 *   Writes use `adapter.json(value)` for jsonb columns. NEVER
 *   `JSON.stringify(value)::jsonb` — that yields scalar strings and
 *   breaks downstream jsonb accessors. See platform memory
 *   `feedback_postgresjs_jsonb_string_double_encode.md`.
 */

import type {
  ArchitecturalIntelligence,
  ArchQuerySpec,
  ArchView,
  ArchObservation,
  ArchScope,
  ChangeRef,
  DriftReport,
} from '../types.js'
import type { PostgresDbAdapter } from './adapter.js'
import { RLS_ORG_ID_SETTING } from './adapter.js'
import { queryArchView } from './queries.js'
import { contributeObservation } from './contribute.js'

export type {
  PostgresDbAdapter,
  JsonbParam,
  DbRow,
  PostgresJsSqlShape,
  TransactionRunner,
} from './adapter.js'
export {
  adapterFromPostgresJs,
  isJsonbParam,
  RLS_DDL_EXAMPLE,
  RLS_ORG_ID_SETTING,
} from './adapter.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Configuration for `PostgresArchitecturalIntelligence`.
 *
 * `orgId` is required — every read and write scopes to a tenant. Cross-
 * tenant queries are an explicit operator operation outside the SDK's
 * remit.
 *
 * `projectId` is optional at the class level; consumers typically
 * construct one instance per session with the right scope. When omitted,
 * reads return the org's whole project corpus and writes default to the
 * `scope.projectId` carried by each observation.
 */
export interface PostgresArchConfig {
  /** The injected DB handle (see PostgresDbAdapter). */
  db: PostgresDbAdapter
  /** Tenant organisation id. Required. */
  orgId: string
  /** Optional project scoping. */
  projectId?: string
  /**
   * Optional agent attribution for observations contributed through this
   * instance. Defaults to 'arch-intel-sdk'.
   */
  agentId?: string
}

// ---------------------------------------------------------------------------
// PostgresArchitecturalIntelligence
// ---------------------------------------------------------------------------

/**
 * Postgres-backed `ArchitecturalIntelligence` implementation.
 *
 * Use when the consumer already has a Postgres handle (e.g. drizzle +
 * postgres-js) and wants the SDK to use it. The SDK does NOT manage the
 * connection — it borrows the handle and never closes it.
 */
export class PostgresArchitecturalIntelligence implements ArchitecturalIntelligence {
  private readonly _db: PostgresDbAdapter
  private readonly _orgId: string
  private readonly _projectId: string | undefined
  private readonly _agentId: string

  constructor(config: PostgresArchConfig) {
    if (!config.db) {
      throw new Error('PostgresArchitecturalIntelligence: `db` adapter is required')
    }
    if (!config.orgId) {
      throw new Error('PostgresArchitecturalIntelligence: `orgId` is required')
    }
    this._db = config.db
    this._orgId = config.orgId
    this._projectId = config.projectId
    this._agentId = config.agentId ?? 'arch-intel-sdk'
  }

  // -------------------------------------------------------------------------
  // query()
  // -------------------------------------------------------------------------

  async query(spec: ArchQuerySpec): Promise<ArchView> {
    // Prefer the spec's scope when it carries an explicit projectId; fall
    // back to the instance projectId for "org-wide" callers.
    const projectId = spec.scope.projectId ?? this._projectId
    return this.withTenantScope((tx) => queryArchView(tx, this._orgId, projectId, spec))
  }

  // -------------------------------------------------------------------------
  // contribute()
  // -------------------------------------------------------------------------

  async contribute(observation: ArchObservation): Promise<void> {
    const projectId = observation.scope.projectId ?? this._projectId
    if (!projectId) {
      throw new Error(
        'PostgresArchitecturalIntelligence.contribute: a projectId is required ' +
          '(provide one on observation.scope.projectId or on the SDK config).',
      )
    }
    await this.withTenantScope((tx) =>
      contributeObservation(
        tx,
        { orgId: this._orgId, projectId, agentId: this._agentId },
        observation,
      ),
    )
  }

  // -------------------------------------------------------------------------
  // RLS — tenant-scoped transaction wrapping
  // -------------------------------------------------------------------------

  /**
   * Run a body against a transaction-scoped adapter that has
   * `SET LOCAL rensei.current_org_id = '<orgId>'` applied. This gives the
   * SDK defence-in-depth: app-level `WHERE org_id = $orgId` (always on)
   * PLUS database-level RLS policies (when the consumer applies the DDL
   * shipped in `RLS_DDL_EXAMPLE`).
   *
   * When the adapter does NOT expose a `transaction` runner, the SDK
   * falls back to running the body against the plain adapter — RLS at
   * the DB level is skipped but app-level scoping still applies. This
   * keeps the SDK usable in development / single-tenant deployments and
   * in the in-memory test adapter.
   *
   * `SET LOCAL` is intentionally used (not `SET`) so the GUC scope dies
   * at COMMIT/ROLLBACK and does not leak to the next checked-out
   * connection from a pool.
   */
  private async withTenantScope<T>(
    body: (tx: PostgresDbAdapter) => Promise<T>,
  ): Promise<T> {
    const tx = this._db.transaction
    if (!tx) {
      // No transaction support — run against the plain adapter. App-level
      // org scoping still enforced by the WHERE clauses in queries.ts.
      return body(this._db)
    }
    return tx(async (scoped) => {
      // postgres-js refuses to bind GUC names as parameters, so the org
      // id is parametrised but the setting name is literal in the SQL.
      // The org id is a UUID generated server-side / validated by the
      // caller — no untrusted concatenation path here.
      await scoped.query(`SELECT set_config($1, $2, true)`, [
        RLS_ORG_ID_SETTING,
        this._orgId,
      ])
      return body(scoped)
    })
  }

  // -------------------------------------------------------------------------
  // synthesize()
  // -------------------------------------------------------------------------

  async synthesize(
    scope: ArchScope,
    format: 'markdown' | 'mermaid' | 'json',
  ): Promise<string> {
    const view = await this.query({
      workType: 'research',
      scope,
      includeActiveDrift: false,
    })

    if (format === 'json') {
      return JSON.stringify(view, null, 2)
    }

    if (format === 'mermaid') {
      const lines = ['graph TD']
      for (const p of view.patterns) {
        lines.push(`  P_${slugId(p.id)}["Pattern: ${escapeMermaid(p.title)}"]`)
      }
      for (const c of view.conventions) {
        lines.push(`  C_${slugId(c.id)}["Convention: ${escapeMermaid(c.title)}"]`)
      }
      for (const d of view.decisions) {
        lines.push(`  D_${slugId(d.id)}["Decision: ${escapeMermaid(d.title)}"]`)
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

  // -------------------------------------------------------------------------
  // assess()
  // -------------------------------------------------------------------------

  /**
   * Drift assessment requires a `ModelAdapter`; the data-layer impl does
   * not own one. This method returns an informational placeholder report
   * — callers needing real drift detection inject a `ModelAdapter` and
   * call `assessChange()` from `drift.js` against this instance.
   */
  async assess(change: ChangeRef): Promise<DriftReport> {
    return {
      change,
      deviations: [],
      reinforced: [],
      hasCriticalDrift: false,
      summary:
        'PostgresArchitecturalIntelligence.assess() is a placeholder. ' +
        'For real drift detection, call assessChange(this, modelAdapter, ...) ' +
        'from `@donmai/architectural-intelligence`.',
      assessedAt: new Date(),
    }
  }
}

// ---------------------------------------------------------------------------
// Mermaid helpers (mirrored from sqlite-impl)
// ---------------------------------------------------------------------------

function slugId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8)
}

function escapeMermaid(s: string): string {
  return s.replace(/"/g, "'")
}
