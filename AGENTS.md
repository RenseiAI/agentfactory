# donmai-libraries — the deprecating @donmai/* TypeScript monorepo (OSS-public)

> **DEPRECATING.** The legacy Node CLI execution binaries (`@donmai/cli`) are
> replaced by the Go binaries (`../donmai`), and the remaining `@donmai/*` TS
> libraries are losing their OSS-standalone consumer. Default for new work: do
> NOT extend this repo — server-side logic belongs in the commercial platform,
> client/runner logic in the Go binaries. A genuine OSS-standalone capability
> must be built Go-native, under its own ADR.

pnpm + Turborepo monorepo publishing `@donmai/*` packages to public npm. The
release workflow currently publishes six: `core`, `plugin-linear`, `server`,
`dashboard`, `mcp-server`, `architectural-intelligence` (list pinned in
`scripts/check-publish-surface.sh` + `.github/workflows/release.yml`); `cli`,
`nextjs`, `code-intelligence`, `create-app`, `daemon`, `kits`, `test-utils`,
and `spring-ai-bench` also live in-tree. Package code and the CHANGELOG still
say "AgentFactory" — that naming is historical; renaming it is out of scope.

## Operating context

- Governing corpus: `../donmai-architecture/` (public,
  `github.com/RenseiAI/donmai-architecture`). Read order:
  `001-layered-execution-model.md` → the layer doc(s) for your area
  (`002`–`008`, `011`, `013`–`016`) → open `ADR-*.md`. The corpus wins over
  code — but do NOT amend the corpus during implementation: post a
  `migration:needs-spec-decision` comment on the issue and continue with
  adjacent work. (From a worktree the sibling root is `../../<repo>`.)
- Worktrees are siblings: `../donmai-libraries.wt/{branch}` via
  `scripts/create-worktree.sh` (path template: `worktree.directory` in
  `.donmai/config.yaml`; `pnpm af-migrate-worktrees` moves legacy in-repo
  trees). A `SessionStart` hook runs `scripts/refresh-worktree.sh` on linked
  worktrees.
- ESM throughout: relative imports in `.ts` source need explicit `.js`
  extensions.
- `pnpm` scripts keep legacy `af-*` entry points (`af-orchestrator`,
  `af-linear`, `af-code`, `af-sync-routes`, …); the `@donmai/cli` → Go binary
  mapping lives in `docs/migration-from-legacy-cli.md`.

## Before you start — read in this order

| The moment you... | Read |
|---|---|
| start ANY task in this repo | this file, top to bottom (it is short) |
| see `LINEAR_SESSION_ID` in your environment | `docs/agents/AUTONOMOUS.md` — you are running headless |
| run any Linear operation | `docs/agents/LINEAR-CLI.md` (CLI only — never Linear MCP tools) |
| run the orchestrator, touch `.donmai/config.yaml`, or sync routes | `docs/agents/ORCHESTRATION.md` |
| change an agent prompt, workflow template, or partial | `docs/templates.md` + `packages/core/src/templates/defaults/` |
| touch quality gates, baselines, or the ratchet | `docs/quality-gates.md` |
| change what a work type must produce to count as done | `packages/core/src/orchestrator/completion-contracts.ts` + `docs/WORK_RESULT_MARKER.md` |
| edit `packages/*/README.md` or anything a tarball ships | §Boundary below, then run the hygiene grep |
| are about to write "done"/"fixed" or open a PR | Gates below + `../donmai-architecture/agents/PROTOCOL.md` §V |
| hit a failing test/build you did not predict | `../donmai-architecture/agents/PROTOCOL.md` §D |

When a row matches, read that doc before your next edit and follow it literally.

## Gates — "done" means these passed

```bash
pnpm build       # turbo run build — run before test (turbo's test task depends on it)
pnpm typecheck   # turbo run typecheck — the type gate; test does NOT type-check
pnpm test        # turbo run test — CI runs it with NODE_OPTIONS=--experimental-sqlite
```

There is no `pnpm lint` gate: no package in this monorepo ships a `lint`
script, and no eslint/biome config or dependency exists anywhere in the repo.
An empty `turbo run lint` pipeline previously exited 0 with "0 successful, 0
total" — a gate that looked green while checking nothing. Don't reintroduce
it without also wiring real lint config/deps for the packages it would cover.

CI (`.github/workflows/ci.yml`) additionally runs: gitleaks secret scan,
license-check (`license-checker-rseidelsohn --onlyAllow "$(cat
.license-allowlist)"`), a quality ratchet (reads `.donmai/quality-ratchet.json`
when present — test count, test failures, and typecheck errors may not
regress), and `bash scripts/check-publish-surface.sh` after build (no test
artifacts, no `RENSEI_`-prefixed env names, no private references in anything
`pnpm publish` would ship). Quote each gate's result line in your report.

## Iron rules

- Relative imports in `.ts` source carry explicit `.js` extensions (ESM
  resolution breaks without them).
- All Linear operations go through the `linear` CLI subcommand
  (`donmai linear …`) — never Linear MCP tools. `--state` not `--status`;
  label NAMES not UUIDs; `--labels` is comma-separated; `create-issue`
  requires `--team` or `LINEAR_TEAM_NAME`; capture the returned JSON `id`;
  `--parentId` creates sub-issues. Full surface: `docs/agents/LINEAR-CLI.md`.
- Dependencies are pre-installed by the orchestrator: run `pnpm install` only
  after a concrete missing-module error, synchronously, never in background.
- Read a file before writing it; on token-limit errors use Grep or Read with
  `offset`/`limit` instead of whole-file reads.
- `.donmai/config.yaml` (`kind: RepositoryConfig`) scopes orchestration —
  repository remote validation, `allowedProjects`/`projectPaths`, shared
  paths; details in `docs/agents/ORCHESTRATION.md`.
- New or changed behavior lands with tests in the same package; the CI
  ratchet blocks shrinking test counts.

## Boundary — every published package is world-readable

Everything in a package's `files` array (`README.md`, `LICENSE`, `dist/**`, …)
ships to public npm (and GitHub Packages) the moment a release is cut. Before
editing `packages/*/README.md` or anything a tarball ships, run exactly:

```bash
grep -nE 'REN-[0-9]|REN2-[0-9]|SUP-[0-9]|rensei-architecture|rensei-ops|RenseiAI/rensei' packages/*/README.md
```

Zero hits required. Also strip internal Slack/Notion/GDoc links, commit SHAs
pointing at private branches, and org-only contact info.
`scripts/check-publish-surface.sh` (after `pnpm build`) checks the exact
packed payload via `npm pack --dry-run`. Past releases shipped leaking
READMEs and needed re-publish patches; npm's version-history view keeps the
bad README forever.

## Gotchas

- The GitHub merge queue rejects `gh pr merge --auto` -> merge through the
  queue with plain `gh pr merge` instead.
- Turbo's `test` task depends on `build` — a broken build surfaces as a
  test-task failure; run `pnpm build` alone to isolate it (CI runs build
  before test explicitly).
- Optional `@donmai/code-intelligence`: agents get `af_code_*` in-process
  tools (or the `pnpm af-code` CLI); the index cache persists to
  `.donmai/code-index/` (gitignored). Reference: `docs/code-intelligence.md`.

## Hard stops

- NEVER add new capability to this repo by default -> instead: server logic
  goes to the commercial platform, client/runner logic to the Go binaries;
  OSS-standalone means Go-native plus its own ADR.
- NEVER run `git worktree remove/prune`, `git checkout`/`git switch` to
  another branch, `git reset --hard`, `git clean -fd`, `git restore .`, or
  touch the worktree's `.git` file -> instead: the orchestrator owns worktree
  lifecycle (rules in `docs/agents/AUTONOMOUS.md`).
- NEVER amend `../donmai-architecture` mid-implementation -> instead: post a
  `migration:needs-spec-decision` comment and continue with adjacent work.
- NEVER publish or edit publishable files that fail the hygiene grep or
  `check-publish-surface.sh` -> instead: strip the reference first.
- NEVER ask for user input when `LINEAR_SESSION_ID` is set -> instead: decide
  from the issue and existing patterns; document the assumption.
- NEVER make a failing gate pass by weakening it (skips, deleted tests,
  loosened asserts, ratchet edits) -> instead: quote the failure and propose
  the change.
