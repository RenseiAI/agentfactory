# @donmai/architectural-intelligence

> **DEPRECATED.** This package is deprecated. The architectural-intelligence
> layer is being reimplemented natively in Go inside the `donmai` binary, and
> this TypeScript package has no live runtime consumer. It is preserved (not
> removed) for OSS continuity because downstream npm consumers may pin it, but
> it will receive no further feature work and will be removed in a future major.
> New work should target the native `donmai arch` surface.

System-level synthesis of patterns, conventions, decisions, and drift across a codebase.

Part of the [Donmai](https://github.com/RenseiAI/donmai-libraries) toolchain.

## What it does

Architectural Intelligence observes a codebase's evolution and synthesizes structured knowledge about it:

- **Patterns** — recurring structural shapes (e.g. "all routes export a `POST` handler that calls `requireOrgAccess`")
- **Conventions** — agreed-upon norms (e.g. "tests live next to source as `*.test.ts`")
- **Decisions** — recorded architectural choices (e.g. "auth uses WorkOS, not Auth0")
- **Deviations** — places the codebase departs from its own patterns/conventions/decisions
- **Drift** — quantified deviation pressure that crosses a threshold and warrants intervention

The package ships:

| Capability | Entry points |
|---|---|
| Single-tenant local store | `SqliteArchitecturalIntelligence` |
| Multi-tenant store (injected Postgres handle) | `PostgresArchitecturalIntelligence`, `adapterFromPostgresJs` |
| Observation pipeline | `runObservationPass`, `attachPipelineSubscribers`, `readDiffObservations` |
| Synthesis prompts (versioned registry) | `promptRegistry`, `currentPrompt`, `versionedPrompt` |
| Eval / A/B test harness | `evaluatePrompt`, `compareABPrompts` |
| Drift detection | `assessChange`, `resolveDriftGatePolicy`, `evaluateGate` |
| Workflow verb registration | `registerArchitectureVerbs`, `ASSESS_CHANGE_VERB` |

## Installation

```bash
pnpm add @donmai/architectural-intelligence
```

Node >= 22 required.

## Quick start

```ts
import {
  SqliteArchitecturalIntelligence,
  runObservationPass,
  assessChange,
} from '@donmai/architectural-intelligence'

// 1. Open or create the per-tenant store
const store = new SqliteArchitecturalIntelligence({ dbPath: '.donmai/arch.db' })

// 2. Run an observation pass over the change set
const result = await runObservationPass({
  store,
  changeRef: { sha: 'abc123', baseSha: 'main', files: [/* PrDiff entries */] },
})

// 3. Gate on drift — block the merge / open a review issue when the threshold trips
const drift = await assessChange({ store, changeRef: result.changeRef })
if (drift.driftScore > drift.policy.maxDrift) {
  // surface the deviations to the agent or human reviewer
}
```

## Workflow verb integration

For platform consumers that drive Donmai through the workflow engine, register the `assess-change` verb:

```ts
import { registerArchitectureVerbs } from '@donmai/architectural-intelligence'

registerArchitectureVerbs(verbRegistry)
```

The verb accepts a `changeRef` input and emits an `assessment` output (drift score + flagged deviations) that downstream workflow nodes can branch on.

## Multi-tenant deployments (Postgres + RLS)

`PostgresArchitecturalIntelligence` is designed for SaaS deployments where many tenants share a database. It enforces tenant isolation at two layers:

1. **Application layer.** Every read includes `WHERE org_id = $orgId`; every write stamps `org_id` on the row.
2. **Database layer (recommended).** When the consumer applies the shipped RLS DDL, the SDK additionally wraps each operation in a transaction that runs `SET LOCAL rensei.current_org_id = '<orgId>'` so Postgres row-level security policies enforce isolation as defence-in-depth.

### Wiring transactions

Provide a `transaction` runner on your adapter. The reference postgres-js helper already does this — `adapterFromPostgresJs(sql)` plumbs through `sql.begin(...)` and JSONB parameter unboxing.

```ts
import postgres from 'postgres'
import { adapterFromPostgresJs, PostgresArchitecturalIntelligence } from '@donmai/architectural-intelligence'

const sql = postgres(process.env.DATABASE_URL!)
const arch = new PostgresArchitecturalIntelligence({
  db: adapterFromPostgresJs(sql),
  orgId: ctx.orgId,
  projectId: ctx.projectId,
})
```

When the adapter does not expose `transaction`, the SDK falls back to plain queries — app-level scoping still applies, but database-level RLS is skipped.

### RLS DDL exemplar

Apply this DDL once per database (via your migration tool of choice — drizzle, dbmate, sqitch, etc.). The SDK does NOT run DDL itself.

```sql
-- Multi-tenant RLS for @donmai/architectural-intelligence
ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_nodes  ENABLE ROW LEVEL SECURITY;

-- FORCE so the table owner is not exempt — a misconfigured connection
-- string can't accidentally bypass tenant isolation.
ALTER TABLE observations FORCE ROW LEVEL SECURITY;
ALTER TABLE graph_nodes  FORCE ROW LEVEL SECURITY;

CREATE POLICY arch_intel_observations_tenant_isolation ON observations
  USING (org_id = current_setting('rensei.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('rensei.current_org_id', true)::uuid);

CREATE POLICY arch_intel_graph_nodes_tenant_isolation ON graph_nodes
  USING (org_id = current_setting('rensei.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('rensei.current_org_id', true)::uuid);
```

A literal copy of this DDL is exported from the package as `RLS_DDL_EXAMPLE` and the GUC name is exported as `RLS_ORG_ID_SETTING` so consumers can reference both without typos.

Requirements:

- The application database role must NOT have `BYPASSRLS`. Superusers and `BYPASSRLS` roles ignore policies; create a least-privilege app role.
- Admin/migration tooling that needs to operate cross-tenant should use a separate role configured with `BYPASSRLS` and document the carve-out in your runbook.
- `SET LOCAL` is used (not `SET`) so the GUC scope dies at `COMMIT`/`ROLLBACK` and does not leak to the next checked-out connection from a pool.

## Status

**Deprecated.** No live runtime consumer remains — the architectural-intelligence
layer is moving to a native Go implementation inside the `donmai` binary. This
package is kept published for OSS continuity and downstream pins only; expect no
further feature work.

## License

MIT — see [LICENSE](./LICENSE).
