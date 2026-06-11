# Migration from `@donmai/cli` Legacy Binaries

> **Status:** In progress — most high-traffic binaries are already ported. See the tables below for the current state.

OSS users upgrading from the legacy Node/TypeScript `@donmai/cli` binaries to the Go `af` CLI should use this guide as their reference. The Go `af` binary ships as a single static executable with no Node.js runtime dependency.

---

## Why two binaries? `af` vs `rensei`

| Binary | Purpose | Who uses it |
|--------|---------|-------------|
| `af` | Open-source, single-user CLI. Orchestrates local agent fleets, interacts with Linear, inspects logs, manages worktrees. No platform account required — just a `LINEAR_API_KEY`. | Individual developers, self-hosters, OSS contributors |
| `rensei` | Platform-aware CLI for Rensei AI customers. Adds multi-workspace OAuth, tenant-scoped billing, RBAC, remote fleet management, and telemetry. Wraps `af` functionality and extends it. | Teams and orgs using the hosted Rensei platform |

Everything in `af` works without a `rensei` account. If you are self-hosting, `af` is all you need.

---

## Primary binary mapping

The binaries listed in `packages/cli/package.json` "bin" entries, in order of typical usage frequency:

| Legacy binary | Go equivalent | Status |
|---------------|--------------|--------|
| `af-orchestrator` | `af orchestrator` | Ported |
| `af-linear` | `af linear` | Ported |
| `af-analyze-logs` | `af logs analyze` | Ported |
| `af-cleanup` | `af admin cleanup` | Ported |
| `af-queue-admin` | `af admin queue` | Ported |
| `af-merge-queue` | `af admin merge-queue` | Ported |
| `af-code` | `af code` | Ported |
| `af-arch` | `af arch` | Ported |

## Auxiliary binary mapping

These binaries handle utility and migration tasks. They are less frequently used and some may remain Node-only for the near term.

| Legacy binary | Go equivalent | Status | Notes |
|---------------|--------------|--------|-------|
| `af-worker` | `af worker` | Not yet ported | Remote worker for distributed fleet; tracking issue pending |
| `af-worker-fleet` | `af worker fleet` | Not yet ported | Multi-worker process manager; tracking issue pending |
| `af-agent` | `af agent` | Not yet ported | Session management (list/stop/chat/reconnect); tracking issue pending |
| `af-governor` | `af governor` | Not yet ported | Workflow governor / top-of-funnel automation; tracking issue pending |
| `af-setup` | `af setup` | Not yet ported | Dev-tool configuration (mergiraf); tracking issue pending |
| `af-add-dep` | `af add-dep` | Not yet ported | Safe dependency install in agent worktrees; tracking issue pending |
| `af-sync-routes` | `af sync-routes` | Not yet ported | Next.js route-file generator from manifest; tracking issue pending |
| `af-migrate-worktrees` | _(migration complete — retire after run)_ | Out of scope | One-shot migration from `.worktrees/` to sibling-dir layout; no Go port planned |
| `af-migrate-config-to-kits` | _(migration complete — retire after run)_ | Out of scope | One-shot `.donmai/config.yaml` → `.donmai/kits/` migration; no Go port planned |
| `agentfactory` (root binary) | `af` | Ported | Top-level dispatcher; the `agentfactory` name is the legacy alias |
| `rensei-daemon` (from `@renseiai/daemon`) | `rensei daemon run` (and `af daemon run`) | Ported | Daemon runtime ported to Go. Single-binary OSS UX — no separate daemon binary. |

> **"Out of scope"** binaries are one-shot migration tools. Once the migration they perform has been applied to your repository, the binary itself is no longer needed. They will not be ported to Go.

---

## Side-by-side flag comparison

### Orchestrator

| Task | Legacy | Go `af` |
|------|--------|---------|
| Process a project backlog | `af-orchestrator --project MyProject` | `af orchestrator --project MyProject` |
| Process single issue | `af-orchestrator --single PROJ-123` | `af orchestrator --single PROJ-123` |
| Limit concurrency | `af-orchestrator --project P --max 5` | `af orchestrator --project P --max 5` |
| Dry run | `af-orchestrator --project P --dry-run` | `af orchestrator --project P --dry-run` |
| Custom templates | `af-orchestrator --templates ./tmpl` | `af orchestrator --templates ./tmpl` |
| Scope to repo | `af-orchestrator --repo github.com/org/repo` | `af orchestrator --repo github.com/org/repo` |
| Force work type | `af-orchestrator --single P-1 --work-type qa` | `af orchestrator --single P-1 --work-type qa` |

### Linear CLI

| Task | Legacy | Go `af` |
|------|--------|---------|
| Get issue | `af-linear get-issue PROJ-123` | `af linear get-issue PROJ-123` |
| Create issue | `af-linear create-issue --title "T" --team "X"` | `af linear create-issue --title "T" --team "X"` |
| Create comment | `af-linear create-comment PROJ-123 --body "msg"` | `af linear create-comment PROJ-123 --body "msg"` |
| List backlog | `af-linear list-backlog-issues --project P` | `af linear list-backlog-issues --project P` |
| Check deployment | `af-linear check-deployment 42` | `af linear check-deployment 42` |
| Create blocker | `af-linear create-blocker PROJ-1 --title "T"` | `af linear create-blocker PROJ-1 --title "T"` |

### Log analyzer

| Task | Legacy | Go `af` |
|------|--------|---------|
| Analyze a session | `af-analyze-logs --session <id>` | `af logs analyze --session <id>` |
| Watch mode | `af-analyze-logs --follow` | `af logs analyze --follow` |
| Dry run | `af-analyze-logs --dry-run` | `af logs analyze --dry-run` |
| Cleanup old logs | `af-analyze-logs --cleanup` | `af logs analyze --cleanup` |

### Admin: cleanup, queue, merge-queue

| Task | Legacy | Go `af` |
|------|--------|---------|
| Cleanup worktrees (dry) | `af-cleanup --dry-run` | `af admin cleanup --dry-run` |
| Force cleanup | `af-cleanup --force` | `af admin cleanup --force` |
| List work queue | `af-queue-admin list` | `af admin queue list` |
| Clear stale claims | `af-queue-admin clear-claims` | `af admin queue clear-claims` |
| Full state reset | `af-queue-admin reset` | `af admin queue reset` |
| Merge queue status | `af-merge-queue status` | `af admin merge-queue status` |
| Retry failed PR | `af-merge-queue retry 42` | `af admin merge-queue retry 42` |
| Pause queue | `af-merge-queue pause` | `af admin merge-queue pause` |

### Code intelligence

| Task | Legacy | Go `af` |
|------|--------|---------|
| Search symbols | `af-code search-symbols "MyFunc"` | `af code search-symbols "MyFunc"` |
| Repo map | `af-code get-repo-map` | `af code get-repo-map` |
| BM25 code search | `af-code search-code "query"` | `af code search-code "query"` |
| Duplicate check | `af-code check-duplicate --content-file /tmp/s.ts` | `af code check-duplicate --content-file /tmp/s.ts` |
| Type usages | `af-code find-type-usages "MyType"` | `af code find-type-usages "MyType"` |
| Validate cross-deps | `af-code validate-cross-deps` | `af code validate-cross-deps` |

### Architectural intelligence

| Task | Legacy | Go `af` |
|------|--------|---------|
| Assess PR drift | `af-arch assess <pr-url>` | `af arch assess <pr-url>` |
| Assess by repo+PR number | `af-arch assess --repository github.com/org/r --pr 42` | `af arch assess --repository github.com/org/r --pr 42` |

### Daemon (`@renseiai/daemon` → `af daemon` / `rensei daemon`)

The daemon is a long-running supervisor that registers one machine with the Rensei orchestrator and serves an HTTP control API on `127.0.0.1:7734`. It is now ported into the same Go binary as the rest of the CLI — the legacy `@renseiai/daemon` Node package is deprecated.

| Task | Legacy | Go `af` / `rensei` |
|------|--------|---------|
| Long-running entry point | `rensei-daemon start` | `rensei daemon run` (or `af daemon run`) |
| First-run wizard | `rensei-daemon setup` | `rensei daemon setup` |
| Show status | `rensei-daemon status` | `rensei daemon status` |
| Tail logs | _N/A_ | `rensei daemon logs --follow` |
| Trigger update | `rensei-daemon update` | `rensei daemon update` |
| Install service | `rensei-daemon install` | `rensei daemon install` |
| Uninstall service | `rensei-daemon uninstall` | `rensei daemon uninstall` |
| Health check | `rensei-daemon doctor` | `rensei daemon doctor` |
| Pause / resume | _N/A_ | `rensei daemon pause` / `rensei daemon resume` |
| Drain in-flight | _N/A_ | `rensei daemon drain --timeout 60` |
| Capacity stats | _N/A_ | `rensei daemon stats --pool` |
| Pool eviction | _N/A_ | `rensei daemon evict --repo <url> --older-than 24h` |
| Set capacity key | _N/A_ | `rensei daemon set capacity.poolMaxDiskGb 50` |

The launchd plist (macOS) and systemd unit (Linux) generated by `rensei daemon install` already register `<host-binary> daemon run` — there is no separate `rensei-daemon` binary path to chase. After upgrading the Go binary, no installer rerun is required: the registered service path keeps working.

The on-disk layout is preserved across the migration:

- `~/.rensei/daemon.yaml` — config (read by both Node and Go)
- `~/.rensei/daemon.jwt` — cached registration JWT
- `~/.rensei/daemon.log` — NDJSON log stream

The HTTP control API is wire-compatible with the old `afclient` HTTP client. Use `rensei daemon status --json` to inspect.

---

## Per-binary deprecation notice templates

Copy the relevant block into your `CHANGELOG.md` when retiring each binary.

### `af-orchestrator`

```markdown
### Deprecated: `af-orchestrator`

The `af-orchestrator` binary (from `@donmai/cli`) is deprecated
and will be removed in a future release. Use the Go `af orchestrator` command
instead — flags are identical.
```

### `af-linear`

```markdown
### Deprecated: `af-linear`

The `af-linear` binary (from `@donmai/cli`) is deprecated and
will be removed in a future release. Use `af linear` instead — all subcommands
and flags are preserved.
```

### `af-analyze-logs`

```markdown
### Deprecated: `af-analyze-logs`

The `af-analyze-logs` binary (from `@donmai/cli`) is deprecated.
Use `af logs analyze` instead. Note the subcommand path change: the top-level
`logs` group now houses all log-related commands.
```

### `af-cleanup`

```markdown
### Deprecated: `af-cleanup`

The `af-cleanup` binary (from `@donmai/cli`) is deprecated. Use
`af admin cleanup` instead — flags (`--dry-run`, `--force`, `--path`, etc.) are
preserved.
```

### `af-queue-admin`

```markdown
### Deprecated: `af-queue-admin`

The `af-queue-admin` binary (from `@donmai/cli`) is deprecated.
Use `af admin queue` instead — all subcommands (`list`, `sessions`, `workers`,
`clear-claims`, `clear-queue`, `reset`, `remove`) are preserved.
```

### `af-merge-queue`

```markdown
### Deprecated: `af-merge-queue`

The `af-merge-queue` binary (from `@donmai/cli`) is deprecated.
Use `af admin merge-queue` instead — subcommands (`status`, `list`, `retry`,
`skip`, `pause`, `resume`, `priority`) and flags are preserved.
```

### `af-code`

```markdown
### Deprecated: `af-code`

The `af-code` binary (from `@donmai/cli`) is deprecated. Use
`af code` instead — all subcommands and flags are preserved.
```

### `af-arch`

```markdown
### Deprecated: `af-arch`

The `af-arch` binary (from `@donmai/cli`) is deprecated. Use
`af arch` instead — the `assess` subcommand and all flags are preserved.
```

### `@renseiai/daemon` (rensei-daemon)

```markdown
### Deprecated: @renseiai/daemon

The `@renseiai/daemon` Node package and its `rensei-daemon` binary are deprecated.
The runtime is now in-process inside the af / rensei Go binary — use
`rensei daemon run` (or `af daemon run`) as the long-running entry point. The
Node package will remain at version 0.1.0 through cycle 5 for OSS continuity,
then be removed in cycle 6 once the CI smoke harness has soaked the Go daemon
for 7 consecutive nights.
```

---

## Installation

### Legacy (Node.js)

```bash
npm install -g @donmai/cli
# Provides: af-orchestrator, af-linear, af-analyze-logs, af-cleanup, ...
# Requires: Node.js >= 22
```

### Go `af` (recommended)

```bash
# macOS (Homebrew — when available)
brew install RenseiAI/tap/af

# Direct download (all platforms)
curl -sSfL https://github.com/RenseiAI/af/releases/latest/download/install.sh | sh

# After install
af --version
```

The Go binary is statically compiled — no Node.js, no `node_modules`, no pnpm.

> **macOS users**: starting with `af v0.2.2`, all darwin builds are signed with an Apple Developer ID Application certificate and notarized via Apple's `notarytool`. `brew install RenseiAI/tap/af` runs cleanly with **no Gatekeeper friction** — no popup, no System Settings → Privacy & Security clickthrough required. Verify with `spctl --assess --verbose /opt/homebrew/bin/af` (expects `accepted` + `source=Notarized Developer ID`). See `agentfactory-tui/RELEASING.md` § macOS signing for the signing pipeline detail.

---

## Environment variable compatibility

All environment variables used by the legacy CLI are honoured by `af`:

| Variable | Used by |
|----------|---------|
| `LINEAR_API_KEY` | `af orchestrator`, `af linear`, `af logs analyze`, `af governor` |
| `REDIS_URL` | `af admin queue`, `af admin merge-queue`, `af agent` |
| `WORKER_API_URL` | `af worker` |
| `WORKER_API_KEY` | `af worker` |
| `WORKER_PROJECTS` | `af worker`, `af worker fleet` |
| `ANTHROPIC_API_KEY` | `af arch` |
| `DONMAI_DRIFT_GATE` | `af arch` |
| `VOYAGE_AI_API_KEY` | `af code` (optional — enables vector embeddings) |
| `COHERE_API_KEY` | `af code` (optional — enables cross-encoder reranking) |
| `GOVERNOR_PROJECTS` | `af governor` |

---

## Related documentation

- [Getting Started](./getting-started.md)
- [Configuration reference](./configuration.md)
- [Providers](./providers.md)
- [Code Intelligence](./code-intelligence.md)
