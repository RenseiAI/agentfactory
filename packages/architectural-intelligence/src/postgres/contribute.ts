/**
 * Write path — `contribute(observation)`.
 *
 * Strategy:
 *   1. INSERT into `observations` (raw ingest). Uses the platform's
 *      Wave2-B1 schema: `kind`, `payload`, `org_id`, `project_id`,
 *      `agent_id`, `content`, `content_hash`, `metadata`, `source`.
 *   2. Materialize the observation into a typed `graph_nodes` row
 *      (pattern / convention / decision / deviation). This mirrors the
 *      sqlite impl's direct-materialization path — the full synthesis
 *      pipeline (clustering / dedup) will replace it later.
 *
 * Multi-tenant: writes always carry `(org_id, project_id)`; the SDK never
 * writes a row that another tenant could read.
 *
 * jsonb hygiene: payloads are written via `adapter.json(...)` (the
 * adapter's canonical jsonb-boxing entry point). NEVER use
 * `JSON.stringify(...)::jsonb` — that yields scalar strings, breaking
 * downstream jsonb queries. See platform memory
 * `feedback_postgresjs_jsonb_string_double_encode.md`.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { ArchObservation } from '../types.js'
import type { PostgresDbAdapter } from './adapter.js'

/**
 * Configuration used at the call site — the SDK class injects these.
 */
export interface ContributeContext {
  /** Tenant org id (required by schema NOT NULL constraints). */
  orgId: string
  /** Tenant project id (required by schema NOT NULL constraints). */
  projectId: string
  /**
   * Agent id attribution for the observation row. Optional — when the
   * observation originates from an inferred source (e.g. nightly batch),
   * a synthetic id like `arch-intel-sdk` keeps the FK shape happy.
   */
  agentId?: string
}

/**
 * Implementation of `ArchitecturalIntelligence.contribute()` against
 * Postgres.
 */
export async function contributeObservation(
  db: PostgresDbAdapter,
  ctx: ContributeContext,
  observation: ArchObservation,
): Promise<void> {
  const observationId = randomUUID()
  const orgId = observation.scope.orgId ?? ctx.orgId
  const projectId = observation.scope.projectId ?? ctx.projectId
  const agentId = ctx.agentId ?? 'arch-intel-sdk'
  // Full repo-scoped synthesis: the optional repo tag is persisted to the
  // `repo` column on both observations and graph_nodes so reads can filter by
  // repo (see queries.ts). NULL when the observation is project/org-scoped
  // only (backward-compatible).
  //
  // PREREQUISITE: the consumer's `observations` and `graph_nodes` tables MUST
  // carry a nullable `repo TEXT` column. The SDK does not run DDL; consumers
  // ship the column via their own migration tooling (mirrors the RLS DDL
  // exemplar pattern). When repo is unset everywhere this column receives
  // NULL on every write.
  const repo = observation.scope.repo ?? null

  const payloadString =
    typeof observation.payload === 'string'
      ? observation.payload
      : JSON.stringify(observation.payload)

  // Content stays human-readable; payload is the SDK canonical column.
  // We seed both because the platform schema requires both NOT NULL.
  const content = payloadString
  const contentHash = sha256(content)

  // metadata jsonb carries SDK source attribution + auxiliary signal.
  const metadata = {
    kind: observation.kind,
    confidence: observation.confidence,
    source: observation.source,
    scope: observation.scope,
  }

  // Step 1 — INSERT observations row. ON CONFLICT against the dedup
  // index keeps re-ingestion idempotent without surfacing a failure.
  await db.query(
    `
    INSERT INTO observations (
      id, org_id, project_id, agent_id,
      content, content_hash,
      kind, payload,
      source, weight, metadata, repo
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (org_id, project_id, agent_id, content_hash)
    DO UPDATE SET weight = observations.weight + 1, updated_at = NOW()
    `,
    [
      observationId,
      orgId,
      projectId,
      agentId,
      content,
      contentHash,
      observation.kind,
      payloadString,
      observation.source.authoredDoc ? 'explicit' : 'auto',
      '1.0',
      db.json(metadata),
      repo,
    ],
  )

  // Step 2 — Materialize into graph_nodes. One row per observation;
  // future clustering will dedupe synonyms.
  const nodeId = randomUUID()
  const { name, description, properties } = projectGraphNode(observation)

  await db.query(
    `
    INSERT INTO graph_nodes (
      id, name, type, description, properties,
      importance_weight, feedback_weight,
      org_id, project_id,
      source_observation_id, source_session_id,
      repo,
      created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5,
      $6, $7,
      $8, $9,
      $10, $11,
      $12,
      NOW(), NOW()
    )
    `,
    [
      nodeId,
      name,
      observation.kind,
      description,
      db.json(properties),
      observation.confidence,
      0.5,
      orgId,
      projectId,
      observationId,
      observation.source.sessionId ?? null,
      repo,
    ],
  )
}

/**
 * Project an `ArchObservation` into `(name, description, properties)`
 * for the graph_nodes row.
 *
 * The payload shape is intentionally permissive — observations come from
 * many extractors (PR-merge, session-end, kit-shipped) and not all carry
 * every field. We extract a reasonable name/description; everything else
 * lands in properties.
 */
function projectGraphNode(observation: ArchObservation): {
  name: string
  description: string
  properties: Record<string, unknown>
} {
  const payload =
    typeof observation.payload === 'object' && observation.payload !== null
      ? (observation.payload as Record<string, unknown>)
      : { raw: observation.payload }

  const name =
    typeof payload['title'] === 'string'
      ? (payload['title'] as string)
      : defaultTitle(observation.kind)
  const description =
    typeof payload['description'] === 'string' ? (payload['description'] as string) : ''

  // Properties is the bag-of-attrs: everything from payload that isn't
  // the headline name/description, plus source attribution.
  const properties: Record<string, unknown> = {
    ...payload,
    source: observation.source,
    confidence: observation.confidence,
  }
  // Authored marker for conventions — preserves the sqlite impl's
  // authored=1 column semantics in the jsonb properties.
  if (observation.source.authoredDoc) {
    properties['authored'] = true
  }

  return { name, description, properties }
}

function defaultTitle(kind: ArchObservation['kind']): string {
  switch (kind) {
    case 'pattern':
      return 'Untitled pattern'
    case 'convention':
      return 'Untitled convention'
    case 'decision':
      return 'Untitled decision'
    case 'deviation':
      return 'Untitled deviation'
  }
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}
