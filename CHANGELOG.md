# Changelog

## Unreleased

### Fixes

- **Atomic session claim/start transitions (target v0.9.14)** —
  `@donmai/server` now advances worker-owned session lifecycle rows with one
  conditional Redis mutation. A claim can only bind a pending row, while start
  requires the same worker and an existing claim timestamp, preserves that
  timestamp exactly, and refuses stale pending snapshots instead of writing a
  running row with missing claim evidence. The bundled Next.js status handler
  now uses this transition even when a worker omits its worktree path and
  returns a conflict before later running-only effects when start is refused.

- **Cleanup mutation executor (target v0.9.13)** — `@donmai/server` cleanup
  callbacks can now wrap each complete orphan, zombie, stranded-session, and
  issue-lock mutation sequence in one awaited generic executor. Existing
  `beforeMutation` integrations remain supported as a fallback, while executor
  refusal or pre-entry failure leaves storage untouched and post-entry failure
  propagates for durable reconciliation.

- **Stranded per-dispatch session rows** — Orphan cleanup now terminal-marks per-dispatch Redis session rows (rows written under their own key whose stored `trackerSessionId` was patched to a shared tracker session) under their OWN key once the tracker-keyed session is terminal or missing. Previously every lifecycle write keyed off `trackerSessionId`, so such rows stranded as phantom queued/parked sessions forever and the zombie sweep re-queued the shared tracker session on every cleanup pass (infinite re-queue → pop → drop churn). Session reads now expose the row's own id as `rowSessionId`, and the public sessions API hashes it for the public session id so N rows aliasing one tracker session no longer render as N duplicates of the same id.

### Deprecations

- **`af-arch` binary (`@donmai/cli`)** — Deprecated in favour of the native Go `donmai arch` command. The shim still runs but now emits a runtime deprecation notice on stderr; it will be removed in a future release. Use `donmai arch assess <pr-url>` instead — the `assess` subcommand, all flags, and the JSON output are preserved. See [`docs/migration-from-legacy-cli.md`](./docs/migration-from-legacy-cli.md) for the migration path.

- **`@donmai/architectural-intelligence` package** — Deprecated. The architectural-intelligence layer is being reimplemented natively in Go inside the `donmai` binary, and the package has no live runtime consumer. It is preserved (not hard-deleted) for OSS continuity because downstream npm consumers may pin it; it will be removed in a future major. New work should target the Go `donmai arch` surface.

- **`@renseiai/daemon` package** — Deprecated in favour of the Go daemon shipped inside the `af` / `rensei` binary. Use `rensei daemon run` (or `af daemon run`) as the long-running entry point. The Node package is preserved at version 0.1.0 for OSS continuity and will be removed in cycle 6 after the CI smoke harness has soaked for 7 consecutive nights. See [`docs/migration-from-legacy-cli.md`](./docs/migration-from-legacy-cli.md#daemon--renseiaidaemon-→-af-daemon--rensei-daemon) for the migration path.

## v0.8.59

### Fixes

- **Merge queue duplicate-dequeue race** — Close the duplicate-dequeue race on already-merged PRs, preventing redundant merge attempts when a PR has already landed.

- **Provider inference from dispatchModel** — Orchestrator now infers provider from `dispatchModel`, hardens the merge queue, and tightens the scope completion audit.

- **Validation exit hard-fail** — Coordination and development workflows now hard-fail on non-zero validation exits, ensuring agents can't silently skip past failed typechecks or tests.

## v0.8.58

### Fixes

- **Codex sandbox writableRoots** — Include worktree gitdir in Codex sandbox `writableRoots`, fixing git operations that failed in sandboxed worktree environments.

## v0.8.57

### Fixes

- **Codex elicitation hang** — Respond to elicitation and unknown server requests instead of hanging, preventing Codex sessions from stalling on interactive prompts.

- **Quality baseline vitest parsing** — Fix test count parsing under pnpm 10 + vitest 4, where output format changes broke the quality baseline parser.

- **Merge queue label cleanup** — Remove `approved-for-merge` label on successful merge too, not just on failure, keeping label state consistent.

## v0.8.56

### Fixes

- **Fleet shutdown hang** — Fix Ctrl+C hanging on the worker fleet shutdown path, ensuring clean process termination.

## v0.8.55

### Fixes

- **Merge queue worktree reset** — Reset worktree state before every `prepare()` call, ensuring a clean starting point and preventing stale state from prior merge attempts from causing failures.

## v0.8.54

### Fixes

- **Merge queue worktree locks** — Use detached-HEAD checkouts in merge prepare so the operation survives worktree lock contention.

- **Merge queue label poller storage** — Route sidecar label poller storage through the existing bridge, fixing state persistence for label-driven merge triggers.

## v0.8.53

### Features

- **Merge queue result bubbling** — Merge results now bubble back to Linear issues; Accepted status is deferred until the merge actually lands, preventing premature status promotion.

### Fixes

- **Merge queue acceptance handoff** — Wire acceptance-to-queue handoff, tighten the merge contract, and remove dead merge template.

- **Merge queue proxy resolution** — Sidecar now resolves the proxy issue tracker for coordinator-routed deployments, fixing merge queue failures in proxied environments.

### Docs

- Document profile-based provider/model configuration system.

## v0.8.52

### Fixes

- **Codex QA hardening** — Ship templates to Codex agents, fix duplicate and missing events in the event stream, and coalesce log output for cleaner session traces.

## v0.8.51

### Features

- **Production-ready Codex support** — Template merge for Codex provider, persistence directives, and app-server as default mode. Codex agents now receive properly merged workflow templates with tool permissions and partials.

## v0.8.50

### Features

- **Steering-via-resume** — Orchestrator now attempts to steer agents via session resume before falling back to backstop auto-commit, giving agents a chance to self-correct missing outputs.

### Fixes

- **State recovery cross-issue guard** — `checkRecovery` now guards against cross-issue state contamination, preventing stale recovery data from one issue affecting another.

- **Backstop artifact exclusion** — Backstop now uses path-based exclusion that correctly filters build artifacts and `.agent/` directories, and caps staged file count to prevent oversized auto-commits.

## v0.8.49

### Fixes

- **Linear session forwarding** — Use `providerSessionId` for Linear forwarding when available, fixing session routing for proxied provider sessions.

## v0.8.48

### Features

- **Profile-based config system** — Added provider/model/effort configuration bundles, allowing named profiles to set agent provider, model, and effort level in a single config switch.

## v0.8.47

### Fixes

- **Codex exec stdin hang** — Close stdin on codex exec spawn to prevent "Reading additional input" hang that blocked agent sessions.

- **Codex exec early death detection** — Added early process death detection for codex exec provider, preventing silent failures when the process exits unexpectedly.

- **Codex exec stream hang** — Prevent codex exec mode stream hang when process exits without producing stdout output.

### Chores

- Updated Turborepo configuration.

## v0.8.46

### Features

- **Scope completion enforcement** — New `scope-completion-audit` partial forces agents to self-audit against the issue description before committing. Agents can no longer defer in-scope requirements to "follow-up" comments and emit `WORK_RESULT:passed`. The work-result marker now includes a scope attestation contract. Coordination templates add scope coverage verification ensuring sub-issue deliverables cover the full parent issue.

- **Agent Memory Foundation (OSS Phase 1)** — Session memory partial and persistence layer for agent context across retries.

- **A2A Server Foundation (OSS Phase 1)** — Agent-to-Agent protocol server scaffolding.

### Fixes

- **Sub-agent model config now works** — The `models.subAgent` config (e.g., `claude-sonnet-4-6`) was resolved but never passed to coordination sub-agents. The `task-lifecycle` partial now emits a mandatory `model` parameter on every Agent tool call. Full model IDs are mapped to Claude Code's required short aliases (`sonnet`/`opus`/`haiku`) via new `toAgentToolModelAlias()` utility.

- **Push+PR instructions in fallback prompts** — The legacy `generatePromptForWorkType()` fallback (used when template registry is unavailable) was missing push and PR creation instructions for `development` and `inflight` work types, causing the session backstop to fire on every session.

- **Bare @mention prompt generation** — Session-prompted handler now generates proper work prompts for bare @mentions without explicit commands.

### Docs

- Added WorkflowRegistry and Transition Engine to architecture docs.

## v0.8.45

### Features

- **Proxy client retry logic** — `ProxyIssueTrackerClient` now retries transient network errors (`fetch failed`, `ECONNREFUSED`, `ETIMEDOUT`, etc.) and server 5xx/429 responses with exponential backoff (3 retries, 1s→2s→4s). Previously a single network blip during the ~4 minute quality baseline window would kill the entire agent session. The direct `LinearAgentClient` already had this resilience via `withRetry`; the proxy client now uses the same mechanism.

- **Autonomous agent system prompt** — Replaced the interactive system prompt with autonomous agent instructions for headless operation.

## v0.8.44

### Features

- **Configurable git author identity and API-driven deploy support** — Agents can now use custom git author name/email via configuration, and deploy operations can be triggered through the platform API.

### Fixes

- **Millisecond timestamps in session-storage** — Session timestamps (`createdAt`, `updatedAt`, `claimedAt`, `queuedAt`) were stored in seconds (`Math.floor(Date.now() / 1000)`) while consumers (orphan cleanup, health probes, phase metrics) compared them against `Date.now()` in milliseconds. The 1000x magnitude mismatch made every session appear ~54 years old, causing orphan cleanup to systematically re-queue active sessions on every sweep. This produced repeated agent invocations and duplicate work on the same issue. All session-storage timestamps now use `Date.now()` (milliseconds) to match consumers.

- **Worktree refresh hard-resets on `/clear`** — The refresh-worktree hook now performs a hard reset when triggered by `/clear`, ensuring pristine state for new conversations.

## v0.8.43

### Fixes

- **Worktree path resolution when orchestrator runs from a linked worktree** — `gitRoot` in the orchestrator constructor used `findRepoRoot()` which matches `.git` files (worktrees) as well as `.git` directories (main repos). When `process.cwd()` is a linked worktree, `gitRoot` resolved to the worktree path instead of the main repo root, causing `resolveWorktreePath` to compute wrong sibling directories. `git worktree add` then ran with incorrect cwd, producing directories with only `.agent/artifacts.json` and no actual worktree. Agents fell back to the parent process's working directory, causing cross-session file contamination. Fixed by using `resolveMainRepoRoot()` first, which follows the `.git` file's `gitdir:` reference back to the main repo.

- **Fleet output staircase formatting** — Use explicit `\r\n` line endings in fleet worker output to prevent staircase formatting in terminals.

## v0.8.42

### Fixes

- **Agent work loss prevention** — Ban `git stash` in all agent templates (stashes are repo-scoped and leak across worktrees, causing index corruption). Backstop auto-commit now handles conflicted index state by running `git reset HEAD` before staging. Preserved worktree patch backup now captures untracked files via `git diff --no-index`. Stale stashes are cleared when creating worktrees.

- **Duplicate session prevention** — Workers now detect session ownership loss within 5 seconds and stop the duplicate agent. Session ownership transfers complete before updating the worker ID during re-registration, eliminating the race window where in-flight API calls used a mismatched worker ID.

- **Fleet output formatting** — Worker subprocess output is sanitized to strip `\r` (carriage returns from spinners) and ANSI cursor-position sequences before re-printing with the `[W##]` prefix, fixing garbled/misaligned log output.

- **False coordination dispatch** — Prevented coordination dispatch when an issue has no sub-issues.

- **Monorepo warning noise** — Silenced spurious monorepo detection warnings for single-repo projects.

- **Credential leak in logs** — Removed verbose spawn log that leaked env vars and credentials.

- **LINEAR_API_KEY warning** — Downgraded to info level for platform-delegated setups where the key is intentionally absent.

### Docs

- Comprehensive documentation update across 8 files including file reservation tools, config gaps, and CLI commands.

## v0.8.41

### Fixes

- **Critical: Claude Code spawn failure (exit code 9)** — The `ClaudeProvider.spawnClaudeCodeProcess` override was using `process.execPath` (Node.js binary) to spawn Claude Code with CLI-specific flags (`--output-format`, `--input-format`, etc.). Node.js does not recognize these flags and immediately exits with code 9 ("bad option"). This broke when upstream Claude Code transitioned from a Node.js package to a native binary — the SDK stopped including a JS entry point in the spawn args, leaving only CLI flags that Node.js cannot parse. Now uses `spawnOptions.command` provided by the SDK, which points to the SDK's bundled platform-specific Claude binary (`claude-agent-sdk-darwin-arm64/claude`). All agents on affected systems were failing instantly on spawn.

- **Diagnostic stderr capture** — `spawnClaudeCodeProcess` now captures stderr and logs it alongside non-zero exit codes for faster future debugging.

## v0.8.40

(Superseded by v0.8.41 — incomplete fix for the spawn failure)

## v0.8.39

### Features

- **Parallel merge queue** — New `MergePool` replaces the single-instance `MergeWorker` when `mergeQueue.concurrency > 1`. Uses a `ConflictGraph` (greedy graph coloring) to find independent sets of non-conflicting PRs that can rebase and test concurrently. Includes `buildFileManifest()` for per-PR file change lists, `peekAll()`/`dequeueBatch()` storage methods, and falls back to the original sequential worker when concurrency is 1.

- **Conflict predictor and main tracker** — `ConflictPredictor` checks open PRs for file overlap before spawning development agents, injecting a `{{conflictWarning}}` into the template context. `MainTracker` monitors `origin/main` for new commits and identifies which active agents have overlapping file changes.

### Fixes

- **Stale branches from icebox phase** — Research, backlog-creation, refinement, and security work types now use `git worktree add --detach` instead of creating named branches. Previously, branches created during icebox (days before development) persisted and were reused by development without rebasing, causing agents to work on stale code. Branches for non-code work types are also deleted on cleanup.

- **Stale branch reset on development start** — When `createWorktree()` encounters an existing branch with zero unique commits (leftover from a prior phase), it now resets to current `origin/main` instead of using the stale base.

- **QA hard-fail on merge conflicts unconditionally** — Removed the `{{#if mergeQueueEnabled}}` exemption that let QA pass conflicting PRs as "informational only." Merge conflicts now always fail QA, preventing wasted acceptance sessions on PRs that will predictably fail at merge time.

- **File reservation instructions for agents** — `af_code_reserve_files` tool (and CLI equivalent) now documented in the `code-intelligence-instructions` partial. Previously the tool existed in the plugin but no template mentioned it.

- **Session file reservation cleanup** — Added `releaseAllSessionFiles()` to the `FileReservationDelegate` interface and proxy adapter. Orchestrator now releases all file reservations on agent completion, preventing stale reservations from blocking other agents.

- **Pre-development rebase instruction** — Development template now includes a mandatory `git fetch origin main && git rebase origin/main` step before agents begin writing code.

## v0.8.38

### Features

- **Fine-grained model selection** — New 9-level resolution cascade for controlling which model each agent uses: platform dispatch → issue label (`model:<id>`) → config `models.byWorkType` → config `models.byProject` → env `AGENT_MODEL_{WORKTYPE}` → env `AGENT_MODEL_{PROJECT}` → config `models.default` → env `AGENT_MODEL` → provider default. Sub-agent model controlled separately via `QueuedWork.subAgentModel`, config `models.subAgent`, or `AGENT_SUB_MODEL`. Claude provider now passes the resolved model to the SDK `query()` options (previously silently ignored). Template context exposes `{{model}}` and `{{subAgentModel}}` for coordinator sub-agent control.

- **Capability-driven provider dispatch** — `AgentProviderCapabilities` expanded with `supportsToolPlugins`, `needsBaseInstructions`, `needsPermissionConfig`, `supportsCodeIntelligenceEnforcement`, and `toolPermissionFormat`. Orchestrator now uses capability flags instead of hardcoded provider name checks, enabling new providers to opt into features declaratively.

- **Shared safety rules module** — Destructive command deny patterns (rm root, worktree management, hard reset, force push, branch switching) extracted from `claude-provider.ts` and `codex-approval-bridge.ts` into `safety-rules.ts`. Single source of truth — adding a pattern automatically enforces it across all providers. Includes `buildSafetyInstructions()` for providers that need natural-language safety rules.

### Chores

- **Remove TUI package** — Deleted the Go-based `packages/tui` terminal UI and associated `af-status` CLI command. Functionality superseded by the dashboard.

## v0.8.37

### Features

- **HTTP proxy adapter for file reservation** — Platform-managed workers without direct Redis access can now use file reservation through the platform API proxy. Decision tree: Redis (OSS) → platform API proxy (SaaS) → disabled. Adds `createProxyFileReservationDelegate()` in core, with worker-runner fallback and stdio-server-entry env var reconstruction.

## v0.8.36

### Features

- **File reservation system for parallel agents** — Per-file mutex coordination (Redis SET NX) prevents merge conflicts when multiple agents work in separate git worktrees. Includes per-session file index, TTL-based expiration with refresh for crash recovery, and bulk release on session end. Exposed to agents via `af_code_reserve_files` / `af_code_check_reservation` tools through the code-intelligence plugin. The merge worker clears reservations after successful merge. Server, orchestrator, CLI worker, and code-intelligence plugin all wired up.

## v0.8.35

### Fixes

- **Add autonomous operation instructions to coordination templates** — `acceptance-coordination`, `qa-coordination`, and `refinement-coordination` templates were missing the `AUTONOMOUS OPERATION` prompt block, allowing agents to output conversational questions instead of making headless decisions. Aligns with the pattern already in `coordination` and `inflight-coordination` templates.

- **Add list-issues, check-blocked, list-unblocked-backlog to proxy mode** — These three Linear CLI commands were unsupported in proxy mode, causing failures when agents operate without a direct `LINEAR_API_KEY`. Implements them using existing proxy client methods with client-side filtering.

## v0.8.34

### Features

- **Force code-intelligence tool adoption via `canUseTool` interception** — When `codeIntelligence.enforceUsage` is enabled in `.donmai/config.yaml`, the Claude provider denies Grep/Glob calls with a redirect message pointing agents to `af_code_*` tools. After the agent uses any code-intelligence tool, Grep/Glob are unlocked as fallback (configurable via `fallbackAfterAttempt`). Replaced the stateless `autonomousCanUseTool` const with a per-session `createAutonomousCanUseTool()` factory that tracks which code-intelligence categories have been attempted.

- **Code intelligence adoption telemetry** — The orchestrator now counts `af_code_*` vs Grep/Glob tool calls per session and logs the ratio at session end when the code-intelligence plugin is registered.

- **Worktree creation script for isolated Claude sessions** — Added `scripts/create-worktree.sh` to bootstrap interactive Claude sessions into isolated git worktrees at `../agentfactory.wt/<name>`. Updated `.vscode/agentfactory.code-workspace` to use worktrees for all Claude terminals (expanded from 2 to 4 sessions).

## v0.8.33

### Fixes

- **Propagate `AGENTFACTORY_API_URL` to agent environment** — The orchestrator now sets `AGENTFACTORY_API_URL` from `apiActivityConfig.baseUrl` in both the primary spawn and resume paths. Without this, agents in proxy mode had `WORKER_AUTH_TOKEN` but no API URL, causing the af-linear CLI and Linear tool plugin to fall back to direct `LinearAgentClient` which fails with 401.

## v0.8.32

### Fixes

- **Linear plugin creates tools in proxy mode** — `createTools()` now checks for `AGENTFACTORY_API_URL`/`WORKER_API_URL` and `WORKER_AUTH_TOKEN`/`WORKER_API_KEY` when `LINEAR_API_KEY` is absent. Fleet agents in proxy mode get Linear tools instead of zero, using the same `ProxyIssueTrackerClient` path that `runLinear()` already supports.

## v0.8.31

### Features

- **Framework-neutral worktree dependency bootstrap** — Extracted shared package-manager constants (`LOCK_FILES`, `INSTALL_COMMANDS`, `ADD_COMMANDS`) into `packages/core/src/package-manager.ts`. Worktrees now fetch `origin/main` before branching and bootstrap lockfile + `package.json` from the latest remote via `git show`. `syncDependencies`, `installDependencies`, `linkDependencies`, and `writeWorktreeHelpers` are now framework-neutral, using `packageManager` config instead of hardcoding pnpm. Added behind-drift detection (worktree vs `origin/main`). New `af-add-dep` CLI command for safe dependency addition in worktrees.

### Fixes

- **Propagate MCP tool servers to sub-agents via stdio transport** — The Claude provider used in-process MCP servers (`McpSdkServerConfigWithInstance`) which only work for the top-level agent — sub-agents spawned via the Agent tool couldn't see them. Switched all providers to use `createStdioServerConfigs()` uniformly. Stdio configs are serializable and propagate through the SDK's transport layer, making `af_code_*` tools available to sub-agents for the first time.

## v0.8.30

### Features

- **Gate code-intelligence prompt instructions on plugin availability** — The `code-intelligence-instructions` partial now renders only when the `af-code-intelligence` plugin is registered in the tool registry. Added `hasCodeIntelligence` to `TemplateContext`, set by checking `toolRegistry.getPlugins()` at prompt construction time. Previously the instructions rendered unconditionally, either describing MCP tools or CLI commands that might not exist.

## v0.8.29

### Features

- **Auto-emit structured context from tool results** — The orchestrator's event loop now emits structured context entries after successful tool completions via `ApiActivityEmitter.emitContext()`. Covers file reads (`currentFile`), writes/edits (`lastEditedFile`), searches (`lastSearch`), git commands (`lastGitOp`), directory changes (`workingDirectory`), and test runs (`lastTestRun`). Dashboards and TUIs can consume these key-value entries without parsing raw tool call content.

## v0.8.28

### Features

- **Context fields on activity emissions** — `ApiActivityEmitter` now supports optional `contextKey`/`contextValue` on the activity POST body. New `emitContext(key, value)` method for standalone context entries. `emitToolUse()` and `emitResponse()` accept an optional `context` parameter. Context-type activities are stored server-side but not forwarded to Linear.

### Fixes

- **Coordination WORK_RESULT marker in legacy prompts** — The `coordination` and `inflight-coordination` work types in `defaultGeneratePrompt()` were missing `WORK_RESULT_MARKER_INSTRUCTION`, causing agents to exit without the structured marker and blocking status promotion. The YAML templates already had it; the legacy prompt generator did not.
- **Backstop test alignment with git config identity** — The `auto-commits uncommitted changes` test was missing mock return values for the two `git config` calls added in v0.8.27, causing the mock sequence to shift and the PR creation assertion to fail.

## v0.8.27

### Fixes

- **Fix worktree setup for monorepo projects** — `findRepoRoot()` now accepts worktree `.git` files (not just directories). Added `resolveMainRepoRoot()` to follow worktree gitdir references back to the main repo. `linkDependencies()`, `syncDependencies()`, `loadAppEnvFiles()`, and `loadSettingsEnv()` now use the main repo root for `node_modules/`, `.env.local`, and `settings.local.json` that only exist in the main repo, not in worktrees.
- **`update-sub-issue` accepts `--status` as alias for `--state`** — Agents passing `--status Finished` no longer silently fail. Both the direct runner and proxy runner accept either flag. Also throws a usage error when neither `--state`/`--status` nor `--comment` is provided.
- **Backstop gates push and PR creation on commits existing** — The session backstop no longer pushes empty branches or creates PRs for branches with no commits ahead of main. `branch_pushed` checks `commitsPresent` before pushing, and `pr_url` checks both `commitsPresent` and `branchPushed` before creating a PR.

## v0.8.26

### Fixes

- **Cleanup script preserves merge queue directories** — `af-cleanup` no longer deletes `.patches` and `__merge-worker__` directories from the worktree root. These are merge queue infrastructure, not orphaned agent worktrees.

## v0.8.25

### Features

- **`issueLabels` and `teamMembers` proxy methods** — Added two new methods to the issue tracker proxy chain (`LinearAgentClient` → `ProxyIssueTrackerClient` → proxy handler). This closes the "Needs Human" label and assignee resolution gaps in `create-blocker` proxy mode. The proxy runner's `create-issue`, `update-issue`, and `create-blocker` commands now fully resolve label names → IDs and team member names/emails → assignee IDs via the proxy.

## v0.8.24

### Features

- **ProxyIssueTrackerAdapter for remote API workers** — When `LINEAR_API_KEY` is not set but `AGENTFACTORY_API_URL` is available, workers now use a `ProxyIssueTrackerAdapter` that routes issue tracker operations through the centralized API proxy instead of falling back to `NullIssueTrackerClient`. This enables work types that need to create/query issues (backlog-creation, coordination, qa-coordination) to function without direct Linear credentials.
- **af-linear CLI proxy mode** — The `af-linear` CLI now supports proxy mode when `LINEAR_API_KEY` is absent but `AGENTFACTORY_API_URL` and `WORKER_AUTH_TOKEN` are set. Supports core commands: `get-issue`, `create-issue`, `update-issue`, `create-comment`, `list-sub-issues`, `create-blocker`, and more. Name-to-ID resolution (team, project, state) is handled via proxy calls.
- **WORKER_AUTH_TOKEN passed to spawned agents** — The orchestrator now sets `WORKER_AUTH_TOKEN` in the agent environment from `apiActivityConfig.apiKey`, enabling spawned agents to authenticate to the proxy via the `af-linear` CLI.

## v0.8.23

### Features

- **Optional LINEAR_API_KEY for workers** — Workers can now start without `LINEAR_API_KEY`. When absent, a `NullIssueTrackerClient` provides stub data so the orchestrator functions normally, and all Linear operations are delegated to the platform API via the `ApiActivityEmitter`. Workers only need `WORKER_API_KEY` and `WORKER_API_URL` to operate in platform-delegated mode.

### Fixes

- **Guard event.message type before calling substring** — Prevent crash when `event.message` is not a string.
- **Codex recovery parity** — Graceful shutdown, orphan cleanup, and backstop safety improvements for Codex provider sessions.

## v0.8.22

### Features

- **Codex app-server schema alignment (v0.117.0)** — Fixed field name mismatches across config/batchWrite, thread/start, turn/start, turn/steer, and approval policy values. Codex agents now operate correctly in fleet mode.
- **Codex approval bridge** — Handle approval requests as JSON-RPC server requests (not notifications). Auto-approve safe commands, decline destructive patterns via the same safety rules as Claude.
- **Codex sandbox networking** — Enable `networkAccess: true` for workspace-write sandbox so agents can use `gh`, `curl`, `pnpm install`, etc.
- **Codex session lifecycle** — Autonomous agents emit result on turn/completed and end cleanly. Accumulated assistant text populates the result message for completion comments.
- **Codex reasoning observability** — Buffer and log reasoning events (`item/reasoning/textDelta`) for fleet logs. Persist reasoning to Linear sessions as non-ephemeral thoughts.
- **Linear grouped label support** — Reconstruct `group:value` format for Linear grouped labels (e.g., `provider:codex`). Enables per-issue provider routing via label dropdowns.
- **Codex model selection & cost tracking tests** — Comprehensive unit tests for App Server provider spawn, event mapping, and approval bridge.

### Fixes

- **Cross-provider recovery** — Track provider name in worktree state. Clear stale session ID when provider changes between recovery attempts (e.g., Claude → Codex).
- **Provider-agnostic stale session detection** — Match both Claude and Codex error patterns for resume failures.
- **ANSI escape code stripping** — Strip terminal color codes from Codex shell command output in event stream.
- **Agent message delta field** — Read `params.delta` (not `params.text`) for Codex agentMessage streaming events.

## v0.8.21

### Fixes

- **Republish `@donmai/code-intelligence`** — Tarball for v0.8.20 was missing on npm (ghost publish). Bumped all packages to v0.8.21 to work around npm's 24-hour republish restriction.

## v0.8.20

### Features

- **Local merge queue** — New `provider: 'local'` merge queue adapter that serializes merges through a Redis-backed worker without requiring GitHub's paid merge queue feature. Default for all repos with `mergeQueue.enabled: true`.
- **Merge worker fleet sidecar** — `af-worker-fleet` automatically starts a merge worker sidecar that polls the Redis queue and processes PRs (rebase → mergiraf → lock regen → test → merge). One per fleet, enforced by Redis lock.
- **QA no longer bypassed by merge queue** — Governor always routes `Finished → trigger-qa` regardless of merge queue config. QA validates functional correctness; merge worker handles git mechanics at merge time.
- **Merge-queue-aware QA/acceptance templates** — QA templates skip the merge conflict hard-fail rule when merge queue is enabled (conflicts handled by the merge worker). Acceptance templates label PRs `approved-for-merge` instead of merging directly.
- **`mergeQueueEnabled` template variable** — New Handlebars variable injected by the orchestrator, enabling templates to conditionally adjust behavior based on merge queue availability.
- **Codex instructions & permissions via App Server** — Codex agents receive system prompts and tool permissions through the App Server protocol (SUP-1734).
- **Codex MCP tool integration via App Server** — MCP tools forwarded to Codex agents through App Server events (SUP-1733).
- **Codex message injection via App Server** — Mid-session message injection for Codex agents via App Server turn/start (SUP-1732).
- **Quality gates** — Baseline-diff, quality ratchet, TDD workflow, and boy scout rule prevent agents from degrading codebase health.

### Fixes

- **Stale session recovery** — Fall back to fresh spawn when resume hits stale session instead of blocking indefinitely.
- **Coordination work result heuristics** — Broadened result parsing patterns and added missing result-sensitive work types.
- **Stale providerSessionId on work type change** — Clear stale session ID during recovery when work type changes mid-lifecycle.

## v0.8.19

### Features

- **Decision Engine → Workflow Engine migration** — Full rename across UI, API routes, database collections, and types (SUP-1756).
- **Codex App Server provider core** — New provider implementation for Codex via App Server JSON-RPC (SUP-1731).
- **Pagination and time-range filtering** — Routing decisions endpoint now supports cursor pagination and date range filters.
- **Phase-level cost aggregation endpoint** — New API endpoint for aggregating costs by workflow phase.

### Fixes

- **QA/acceptance agent crash leaves issues stuck in Started** — Auto-transition now handles `agent.status === 'failed'` for result-sensitive work types (qa, acceptance, coordination), transitioning to the fail status (Rejected) instead of silently stalling.
- **Stale providerSessionId blocks recovery indefinitely** — When resume fails with "No conversation found", the stale session ID is cleared from state so the next recovery attempt starts fresh. Guards against a race condition where a late init event re-persists the stale ID.
- **False positives in validate-cross-deps tool** — Eliminated spurious dependency violation warnings.
- **Agent forced foreground execution** — Agents now run in foreground mode to prevent premature detach.

## v0.8.18

### Features

- **Pre-push validation gate** — Development and coordination agents now run typecheck, build, and test before committing. Prevents pushing code that fails CI and wasting QA cycles.
- **Pre-push rebase step** — Agents rebase onto latest main before pushing to prevent merge conflict waste cycles where QA passes but acceptance fails on conflicts.
- **QA hard-fail on merge conflicts** — QA agents must check PR mergeability and fail immediately if conflicts exist, rather than passing with a caveat that predictably wastes an acceptance session.
- **Scope fencing in backlog writer** — Sub-issue descriptions now include explicit "DO NOT modify" constraints, cross-package dependency awareness, and exhaustive type coverage requirements to prevent out-of-scope breaking changes.
- **Blast radius analysis in research** — Research agents now trace type/union change impact, cross-package imports, API endpoint inventory, and existing patterns before writing issue descriptions.
- **Integration validation in coordination** — Coordinators run typecheck/build/test after all sub-agents finish but before creating the PR, catching integration failures between combined changes.
- **Code intelligence: type usage finder** — New `af_code_find_type_usages` tool (MCP + CLI) finds all switch/case statements, mapping objects, and usage sites for a union type. Prevents missed exhaustive checks when adding type members.
- **Code intelligence: cross-dep validator** — New `af_code_validate_cross_deps` tool (MCP + CLI) checks that cross-package imports have corresponding package.json dependency declarations.
- **GitHub Rulesets support** — Merge queue adapter detects merge queue via Branch Protection Rulesets (modern API) before falling back to legacy branch protection rules.
- **Emit structured security scan events** — New `agent.security-scan` event emitted from security station with severity breakdown, consumed via `GET /api/factory/events`.
- **Tool category classification** — Tool summary payloads include `toolCategory` field (security, testing, build, deploy, research, general) for dashboard section auto-population.

### Fixes

- **Auto-QA/acceptance race condition** — `markAgentWorked` now called when session transitions to `running` (not just `completed`), fixing a race where the orchestrator transitioned issue status before the worker recorded the tracking key, causing webhook handlers to skip QA/acceptance with `not_agent_worked`.
- **`af-linear update-issue --parentId`** — The `--parentId` flag is no longer silently ignored.
- **Security work type exhaustive coverage** — Added missing `case 'security':` to all switch statements across prompts.ts, orchestrator.ts, a2a-server.ts, and server types.

## v0.8.17

### Fixes

- **Backstop auto-commit for code-producing agents** — The session backstop now auto-commits uncommitted changes when agents exit without committing (model behavioral regression causing agents to post summary comments then exit before `git commit`). Scoped to code-producing work types only (development, inflight, coordination, inflight-coordination). Non-code work types (QA, refinement, research, acceptance, backlog-creation) are unaffected. The auto-commit enables the existing push + PR recovery to succeed end-to-end.

## v0.8.16

### Fixes

- **QA failure loop prevention** — QA failures now route to Rejected (not Backlog), leveraging the existing refinement handler and cycle escalation infrastructure instead of creating unescalatable dev→QA loops.
- **Force-push on feature branches** — Agents can now use `git push --force-with-lease` on feature branches when commit history has been rewritten (e.g., splitting commits per QA feedback). Bare `--force` and force-push to main/master remain blocked.
- **Backstop diverged history recovery** — The session backstop now detects non-fast-forward push failures and retries with `--force-with-lease` on feature branches, recovering from commit rewrites that previously left branches stuck.
- **False "work not persisted" warnings** — Non-code-producing work types (research, backlog-creation, QA, refinement, etc.) no longer trigger spurious "Agent completed but work was not persisted" warnings from bootstrapped `.agent/` files in their worktrees.
- **Stale worktree directory cleanup** — `removeWorktree()` now cleans up leftover directory shells containing only `.agent/` after git worktree removal.

## v0.8.15

### Fixes

- **Preserved worktree deadlock** — Preserved QA worktrees no longer permanently block branch reuse. Incomplete work is saved as a patch file before cleanup, preventing full work stoppages when development agents need the same branch.

## v0.8.14

### Features

- **Session exit gate** — Deterministic post-session validation with typed completion contracts per work type, post-session backstop that auto-pushes branches and auto-creates PRs when agents forget, and provider capability flags (`supportsMessageInjection`, `supportsSessionResume`) for future mid-session steering.
- **Agent bug backlog** — Refinement agents can now create improvement issues against the agent system itself when failures are caused by missing prompt instructions, tool gaps, or template deficiencies.

### Fixes

- **Auto-trigger env vars** — `ENABLE_AUTO_QA` and `ENABLE_AUTO_ACCEPTANCE` env vars now correctly wire up to governor auto-trigger configuration.
- **Worktree preservation** — Prevent worktree cleanup from destroying preserved work when `.agent/preserved.json` marker exists; fix `checkForIncompleteWork()` to check `git ls-remote` output length instead of relying on exception handling.
- **In-process MCP tool permissions** — Auto-allow in-process MCP tools (e.g., `af_linear_*`, `af_code_*`) for autonomous agents so they don't require interactive permission approval.

## v0.8.13

### Features

- **Code intelligence CLI (`af-code`)** — New CLI exposing code-intelligence tools (`search-symbols`, `get-repo-map`, `search-code`, `check-duplicate`) for Task sub-agents and non-MCP contexts. Coordinator sub-agents can now use `pnpm af-code` via Bash to explore codebases with BM25 search, PageRank repo maps, and duplicate detection.
- **Sequential merge queue (The Refinery)** — `MergeQueue` module with Redis sorted-set storage, pluggable merge strategies (rebase/merge/squash), mergiraf conflict resolution, lock-file regeneration, and CLI (`af merge-queue status/retry/skip`). Single merge worker processes completed PRs sequentially against latest main (SUP-1545).
- **Provider plugin type system** — `ProviderPlugin` interface with typed capabilities, trigger/action definitions, config schemas, and `NodeTypeRegistry` for plugin metadata storage (SUP-1511, SUP-1512).
- **Workflow definition v2 schema** — Triggers, providers, nodes, and cross-validation with a complete expression evaluator supporting dotted paths, operators, helpers, and templates (SUP-1513, SUP-1514).

### Fixes

- **Template CLI fallback instructions** — `code-intelligence-instructions` partial now provides CLI usage guidance when `useToolPlugins` is false, instead of rendering empty.
- **WorkflowTriggerDefinition rename** — Resolve export collision between workflow and provider plugin trigger types.
- **NodeTypeRegistry alignment** — Fix registry to use canonical SUP-1511 provider plugin interfaces.

## v0.8.12

### Features

- **Code intelligence template integration** — New `code-intelligence-instructions` partial added to all 16 workflow templates. Agents now receive guidance to use `af_code_*` tools (repo map, symbol search, code search, duplicate check) when exploring codebases.
- **Graceful degradation for code-intelligence** — `@donmai/code-intelligence` is now an optional dependency of the CLI. If not installed, the orchestrator/worker start normally without `af_code_*` tools.

### Chores

- **Documentation updates** — Added code-intelligence package to project structure tables and package listings across CLAUDE.md, CONTRIBUTING.md, README.md, SECURITY.md, and architecture docs.

## v0.8.11

### Features

- **Mergiraf setup CLI** — `af-setup mergiraf` configures the AST-aware merge driver for syntax-aware conflict resolution across agent worktrees (SUP-1544).
- **Mergiraf setup guide** — Documentation for installation, configuration, and AgentFactory integration.

### Fixes

- **Suppress dotenv v17 log spam** — Add `quiet: true` to all CLI entry points to silence ads/tips polluting agent-fleet output and log analysis.
- **Mergiraf docs corrections** — Fix incorrect CLI command names, remove non-existent `mergiraf register` subcommand, fix disable mechanism, remove unsupported `.cjs` extension, add missing `.mjs`.

### Chores

- **Add `af-setup` root script** — Expose setup CLI via `pnpm af-setup` for local development.

## v0.8.10

### Features

- **Worktree sibling directory layout** — Worktrees are now created in a sibling directory (`../{repoName}.wt/{branch}`) instead of inside the repo (`.worktrees/`), preventing VSCode/Cursor filesystem watcher crashes (SUP-1543).
- **Worktree migration CLI** — `pnpm af-migrate-worktrees` moves existing worktrees from `.worktrees/` to the new sibling layout and updates git references.

## v0.8.9

### Features

- **Workflow parallelism** — Fan-out, fan-in, and race strategies for parallel workflow execution (SUP-1231).
- **Fleet quotas** — Kueue-inspired per-project budgets with concurrent session limits, daily cost caps, and cohort-based capacity borrowing/lending (SUP-1235).
- **Self-learning routing** — Thompson Sampling multi-armed bandit for provider selection with Redis-backed posterior store (SUP-1236).
- **Code intelligence v1.1** — Dense vector embeddings with CCS hybrid fusion for improved code search (SUP-1241).
- **FOSSA integration** — SBOM generation for dependency tracking (SUP-1243).
- **Workflow gates** — Signal, timer, and webhook gate types with timeout support (SUP-1229).
- **Webhook gate endpoint** — HTTP handler for external gate signals with token persistence (SUP-1296).

### Fixes

- **Eliminate worker claim races** — Replace peek-then-claim model with ZPOPMIN-based atomic pop-and-claim. The poll handler now assigns work server-side, eliminating thundering herd contention across workers.
- **Add poll jitter** — Workers desynchronize with 0–40% random jitter on poll intervals, reducing simultaneous queue access.
- **Prevent coordinator early-exit** — Coordinators no longer exit prematurely when sub-agents are still running (SUP-1544).
- **Sub-issue race prevention** — Filter sub-issues from backlog queries and guard against independent pickup by workers (SUP-1544).
- **Fix routing-observation-store test types** — Resolve pre-existing TypeScript errors in mock return types.

### Tests

- **popAndClaimWork** — 5 tests covering atomic pop, empty queue, missing items, and error handling.
- **isChildIssue** — 2 tests for platform adapter delegation.
- **Early-exit detection** — Tests for new coordinator early-exit patterns.

### Chores

- **Anthropic SDK license review** — Marked as approved (SUP-1227).

## v0.8.8

### Features

- **Network API for remote workflow deployment** — `POST /api/workflows/deploy` endpoint with Redis-backed WorkflowStore, hot-reload via Redis pub/sub, and YAML/JSON content support (SUP-1492).
- **Inline `af status` command** — Quick fleet status checks from the CLI (SUP-1240).
- **Context window management** — Structured summarization with artifact tracking to keep agents within context limits (SUP-1242).
- **Expression evaluator and conditional routing** — Workflow branching with runtime expression evaluation (SUP-1228).
- **K8s-inspired filter/score scheduling pipeline** — Scheduler uses Kubernetes-style filter and score phases for issue dispatch (SUP-1234).
- **Merge queue support** — Provider-agnostic merge queue adapter interface, GitHub native implementation, merge work type with status mappings and template (SUP-1257, SUP-1259, SUP-1261, SUP-1263).
- **Mergiraf as default git merge driver** — Automatic semantic merge conflict resolution in agent worktrees (SUP-1254).
- **Agent inbox with Valkey Streams** — Stream-based message inbox for inter-agent communication (SUP-1232).
- **Command palette with fuzzy search** — Dashboard command palette with MCP tool actions and key triggers (SUP-1239).
- **Stuck agent NUDGE action** — Inject-message delivery for agents that appear stalled (SUP-1233).
- **Agent detail view with live activity streaming** — Dashboard view for monitoring individual agent sessions (SUP-1238).
- **Comprehensive test infrastructure for create-app** — Test suite for the project scaffolding CLI (SUP-1245).

### Fixes

- **Prevent code-producing agents from promoting without a PR** — Agents that push commits but exit before creating a PR are now caught: the orchestrator checks for branches ahead of main with no associated PR and blocks promotion with a diagnostic comment.
- **Scan all event types for PR URLs** — PR URL detection now covers `assistant_text` and `result` events in addition to `tool_result`, preventing missed PRs when the URL appears outside tool output.
- **Post-exit PR detection fallback** — After agent exit, the orchestrator runs `gh pr list --head <branch>` to catch PRs that were created but whose output wasn't captured during the session.
- **Add task-lifecycle partial** — Prevents coordinators from exiting early (SUP-1238).
- **Resolve QA failures** — Typecheck, adapter wiring, and test fixes (SUP-1237).
- **Add merge work type to template schema** — Template schema and prompt generator updated for merge workflows.

### Chores

- **Anthropic SDK license review** — Marked as approved (SUP-1227).

## v0.8.7

### Features

- **Add code-intelligence package** — New `@donmai/code-intelligence` package with regex-based symbol extraction (TypeScript, Python, Go, Rust), BM25 code search, incremental Merkle-tree indexing, PageRank repo maps, and xxHash64/SimHash memory deduplication. Registers four MCP tools for Claude agents.
- **Add inflight-coordination work type** — Parent issues already in Started status now receive an `inflight-coordination` workflow instead of being skipped, allowing the orchestrator to manage sub-agent dispatch mid-flight.
- **Add cleanup CLI with branch pruning** — `pnpm af-cleanup` now supports `--skip-worktrees` and `--skip-branches` flags, with merged/gone branch detection and IDE safety checks.

### Fixes

- **Fix release workflow for renamed plugin-linear package** — Release CI referenced the old `@renseiai/agentfactory-linear` name in 4 places; updated to `@renseiai/plugin-linear`.
- **Add code-intelligence to release pipeline** — `@donmai/code-intelligence` was missing from the release workflow's version bump and publish steps.
- **Prevent code-producing agents from completing without committing** — Agents that produce code changes but skip the commit step are now caught before marking work as complete.
- **Re-validate coordination upgrade when workType is provided** — `spawnAgentForIssue` now rechecks whether an issue should be upgraded to coordination even when an explicit work type is passed.
- **Remove plugin-linear compile-time dependency on core** — `@renseiai/plugin-linear` no longer imports from `@renseiai/agentfactory` at build time, fixing circular dependency issues.

### Chores

- **Gitignore .donmai/ directory** — Project-local `.donmai/` config and templates are now excluded from version control.

## v0.8.6

### Fixes

- **Add "QA Coordination Complete" heuristic to work result parser** — Agents that output "QA Coordination Complete" or "QA Complete" as inline text (without a structured `WORK_RESULT` marker) now correctly resolve as "passed", preventing issues from stalling in Finished status.

## v0.8.5

### Fixes

- **Fix infinite session dispatch loop on completed coordination issues** — When a qa-coordination agent completed without a structured `WORK_RESULT` marker (e.g., "already done"), the issue stayed in Finished and Linear auto-created new agent sessions indefinitely. The `session-created` webhook handler now enforces a total session hard cap (`MAX_TOTAL_SESSIONS`) and a per-issue dispatch counter, matching the guards already present in `issue-updated`.
- **Improve work result detection for "already done" agents** — Added heuristic patterns for `already done/complete`, `APPROVED FOR MERGE`, and `all checks passed` so no-op QA sessions correctly resolve as "passed" and trigger the Finished → Delivered transition.

### Features

- **Per-issue dispatch counter** — New `incrementDispatchCount`/`getDispatchCount`/`clearDispatchCount` functions track all session dispatches in a 4-hour sliding window, independent of workflow phase records. Both `session-created` and `issue-updated` handlers increment this counter on every dispatch.

## v0.8.4

### Fixes

- **Fix parent issues dispatched as development instead of coordination after refinement** — The orchestrator's `run()` method hardcoded work type to `'development'` for all backlog issues, ignoring whether the issue is a parent with sub-issues. Parent issues returning to Backlog after a refinement cycle now correctly resolve to `'coordination'`, loading the right template with post-refinement sub-agent dispatch instructions.

### Features

- **Multi-provider selection with per-spawn resolution** — Providers can now be configured per work type or per project via `AGENT_PROVIDER_{WORKTYPE}` and `AGENT_PROVIDER_{PROJECT}` environment variables with priority cascade.
- **Comprehensive test infrastructure** — Added 200+ new tests across all packages covering providers, templates, governor, orchestrator utilities, and more.

## v0.8.3

### Fixes

- **Clear stale parked work on status change** — Prevent QA-coordination loop by clearing parked work when issue status changes.
- **Require version input for workflow_dispatch releases** — Release workflow now validates version input before proceeding.

### Features

- **Per-project build command overrides** — `RepositoryConfig` supports per-project `buildCommand`, `testCommand`, and `validateCommand` overrides in object form within `projectPaths`.
- **iOS/Apple development support** — Native project agents can now handle iOS builds with platform-specific build system detection and safety checks.

## v0.8.2

### Fixes

- **Fix provenance verification failure** — `repository.url` in package.json used lowercase `renseiai` but GitHub org is `RenseiAI`. npm provenance verification requires exact case match.

## v0.8.1

### Features

- **Add MCP server to release pipeline** — `@renseiai/agentfactory-mcp-server` is now included in automated npm + GitHub Packages publishing with provenance attestation.
- **Add MCP server README** — Documents tools, transports, Claude Desktop configuration, and environment variables.

### Fixes

- **Fix npm publish warnings** — Normalize `repository.url` to `git+https://` format, remove unsupported `exports`/`main`/`types` from `publishConfig`, and strip `./` prefix from `bin` entry paths.
- **Re-add `--provenance` to release workflow** — OIDC Trusted Publishers are now configured for the `@renseiai` npm scope.

## v0.8.0

### Breaking

- **Org migration: `@supaku/*` → `@renseiai/*`** — All npm packages renamed from `@supaku/` to `@renseiai/` scope. GitHub repo transferred to `github.com/renseiai/agentfactory`. Domains updated: `supaku.com` → `rensei.ai`, `supaku.dev` → `rensei.dev`. Java namespace updated: `com.supaku` → `com.renseiai`. Old `@supaku/*` packages are deprecated on npm with migration instructions.

## v0.7.58

### Fixes

- **Add sub-issue guard to Backlog transition webhook handler** — The webhook handler for `→ Backlog` transitions checked `isParentIssue` to upgrade to coordination but never checked `isChildIssue` to skip sub-issues. When a coordinator (e.g., refinement-coordination) updated sub-issue statuses in Linear, the resulting webhooks dispatched each sub-issue as individual development work, consuming all workers. Added the same `isChildIssue` guard pattern already present in the Finished and Delivered handlers.

## v0.7.57

### Fixes

- **Block `git checkout` and `git switch` in Claude provider** — Agents running in the main repo directory (research, backlog-creation) could run `git checkout <branch>`, changing the IDE's checked-out branch. This caused cascading failures where subsequent agents couldn't create worktrees for the same branch. Added deny rules to `autonomousCanUseTool` in `claude-provider.ts`.
- **Isolate all work types in git worktrees** — Research, backlog-creation, refinement, and refinement-coordination agents previously ran from the main repo root (`process.cwd()`), giving them write access to the IDE's working tree. All work types now get isolated `.worktrees/` directories, eliminating the risk of agents mutating the main checkout.

## v0.7.56

### Fixes

- **Fix governor race condition causing duplicate QA dispatch (SUP-955)** — `hasActiveSession` did not include `'finalizing'` in active statuses, creating a window where the governor could re-evaluate an issue while its agent was still wrapping up. Added `'finalizing'` to prevent stale `issue-status-changed` events from triggering redundant work.
- **Fix coordination work result parsing when structured marker is absent (SUP-1059)** — Coordination agents that reported "Parent issue marked Finished in Linear" without a `<!-- WORK_RESULT:passed -->` marker were classified as `unknown`. Added heuristic pattern to detect this natural language confirmation.
- **Rewrite refinement templates as triage-only agents** — Refinement agents were attempting to implement fixes instead of triaging rejection feedback. Rewrote both `refinement.yaml` and `refinement-coordination.yaml` to be read-only triage agents that produce actionable fix instructions. Disallowed git, test, build, and file-edit tools. Removed refinement work types from `WORK_TYPES_REQUIRING_WORKTREE`.
- **Add missing `refinement-coordination` dashboard config** — The work type was missing from the dashboard display configuration.

## v0.7.55

### Fixes

- **Fix `refinement` not upgrading to `refinement-coordination` for parent issues** — The governor dispatch path (`governor-dependencies.ts`) and webhook session-created handler were missing the `refinement → refinement-coordination` parent-issue upgrade. Parent issues that failed QA-coordination and moved to Rejected would get a single-agent refinement instead of coordinated refinement, causing the agent to struggle with the sub-issue structure.

## v0.7.54

### Fixes

- **Fix typecheck errors for `refinement-coordination` in server, nextjs, and linear packages** — Added missing `refinement-coordination` entries to duplicated `AgentWorkType` union in `packages/server/src/types.ts`, A2A skill map, priority switch statements, and work type messages. Added `default` branches to priority functions to prevent TS2366 (missing return).

## v0.7.53

### Fixes

- **Fix qa-coordination fail status dead end** — QA coordination failures moved issues to `Started`, which the governor treated as "agent already working" — a dead end with no recovery path. Changed fail status from `Started` to `Rejected`, routing through the refinement workflow instead.

### Features

- **Add `refinement-coordination` work type** — Parent issues with sub-issues that fail QA or acceptance now get a coordination-aware refinement agent instead of a single-agent refinement that would struggle with the complexity. The refinement-coordination agent triages QA/acceptance failure feedback, moves only the failing sub-issues back to Backlog (leaving passing ones in Finished), and lets the orchestrator re-trigger coordination for targeted re-implementation.

## v0.7.52

### Fixes

- **Set maxTurns=200 for coordination and inflight agents** — Coordinators were hitting the Claude SDK's default ~30 turn limit before finishing sub-agent polling, causing premature exit with unknown work result. Added `maxTurns` to `AgentSpawnConfig` and threaded it through to the SDK's `query()` options. Coordination, QA-coordination, acceptance-coordination, and inflight work types now get 200 turns.

### Features

- **Add `--work-type` flag to orchestrator CLI** — Allows forcing a specific work type when using `--single` mode, bypassing auto-detection from issue status. Useful for re-running coordination work that would otherwise be detected as inflight.
- **Add Spring AI agent provider** — New provider for Spring AI-based agents (SUP-1038).

## v0.7.51

### Fixes

- **Add heuristic fallback patterns for coordination work types** — `parseWorkResult` now detects pass/fail from real agent output when the structured `<!-- WORK_RESULT -->` marker is missing. Adds patterns for `coordination` ("all X/X sub-issues completed", "Must Fix Before Merge"), `qa-coordination` ("Status: N Issues Found", "N Critical Issues (Block Merge)"), and `acceptance-coordination` ("Must Fix Before Merge"). Previously, missing markers caused `unknown` results that left issues stuck in Delivered, triggering infinite acceptance retry loops.
- **Strengthen WORK_RESULT marker instruction and move to end of all templates** — The work-result-marker partial now uses a prominent visual box and explicit "VERY LAST line" instruction. Moved from mid-prompt to the final position in all 10 templates that use it, so it's the last thing agents read before generating output.
- **Add READ-ONLY/GATE constraints and status manipulation guards to QA and acceptance templates** — QA templates now explicitly forbid code changes. Acceptance templates are marked as gates that must not fix issues. All result-sensitive templates prohibit `update-issue --state` to prevent agents from bypassing the orchestrator's state machine. Acceptance tool permissions tightened from `git push *` to `git push origin --delete *`.

## v0.7.50

### Fixes

- **Pass workflow context to coordination rework prompts via webhook path** — When QA-coordination failed and the dev coordination agent was re-triggered via webhook, it received a fresh prompt instead of the rework prompt. The failure context filter excluded the `coordination` work type from Started status, and `workflowContext` was never passed as the 4th argument to `generatePrompt`. Now the webhook handler includes coordination in the filter and passes `wfContext` through, so the rework mode prompt activates correctly.

## v0.7.49

### Fixes

- **Add READ-ONLY constraint to QA and acceptance prompts** — QA and acceptance agents (including coordination variants) now receive a `READ-ONLY ROLE` constraint that explicitly forbids modifying source code, config, or migration files. Agents must only read, validate, and report — if issues are found, they emit `WORK_RESULT:failed` instead of attempting fixes. Prevents QA agents from silently patching code and masking real bugs.
- **Expand qa-coordination and acceptance-coordination prompts with structured steps** — Both prompts now include numbered validation steps, PR selection guidance, and explicit pass/fail criteria with `WORK_RESULT` marker instructions, matching the detail level of their non-coordination counterparts.
- **Prevent acceptance re-trigger loop on failure** — When an acceptance agent fails or returns unknown result, `markAcceptanceCompleted` is now called to prevent the webhook orchestrator from immediately re-dispatching another acceptance agent for the same issue.

## v0.7.48

### Fixes

- **Coordination rework mode for QA retries** — When a coordinated parent issue fails QA and is retried, the coordinator now receives a specialized "REWORK MODE" prompt instead of the fresh coordination prompt. This prevents re-spawning sub-agents for already-complete work. The rework prompt instructs the agent to read QA failure comments, apply targeted fixes directly, push to the existing PR branch, and run full validation — addressing the SUP-994 scenario where coordinators saw all sub-issues as Finished and concluded "nothing to do."

## v0.7.47

### Fixes

- **Wire WorkflowContext into governor prompt generation for retries** — When an issue failed QA and was retried, the governor dispatched agents with a vanilla prompt containing no failure context. The `WorkflowState` (cycle count, strategy, failure summary) was sitting in Redis but never passed to `generatePrompt`. Now `dispatchWork` fetches workflow state via `getWorkflowState()` and passes it as `WorkflowContext` to `generatePrompt`, so retry agents see previous QA failures, cycle count, and escalation strategy in their prompt.
- **Emit response activity to close Linear agent sessions on completion** — Agent sessions now properly close in Linear's UI when work completes.

## v0.7.46

### Fixes

- **Fix coordination agent circular re-triggering on parent issues** — Three compounding bugs caused parent issues with sub-issues to cycle through 8+ agent sessions without progressing. (1) Coordination work type was not result-sensitive — the orchestrator auto-promoted to Finished on session completion regardless of whether sub-issues were actually done. Coordination now requires a `<!-- WORK_RESULT:passed -->` marker like QA/acceptance. (2) WORK_RESULT markers embedded in tool call inputs (e.g., `create-comment --body`) were invisible to the orchestrator's parser, causing "unknown result → no transition → re-trigger" loops. The stream loop now captures markers from tool inputs. (3) Added `{{> partials/work-result-marker}}` to the coordination template so agents are instructed to emit the marker.
- **Add circuit breaker for runaway agent sessions** — New `MAX_SESSION_ATTEMPTS` guard (default: 3) in the governor decision engine prevents issues from cycling through agents indefinitely. If an issue has had 3+ completed sessions without reaching a terminal status, the governor stops dispatching and the issue requires manual intervention.

## v0.7.45

### Features

- **`af-agent` CLI for managing running agent sessions** — New command with five subcommands: `stop` (sets session to stopped in Redis, worker aborts within ~5s), `chat` (queues a pending prompt injected into the running Claude session), `status` (shows session details), `reconnect` (creates a fresh Linear agent session and re-associates Redis state), and `list`/`ls` (shows active sessions with duration and cost, `--all` for completed/failed).

### Fixes

- **Backlog-writer creates issues in Icebox instead of Backlog** — Built-in prompts in three locations (defaults/prompts.ts, orchestrator.ts, backlog-creation.yaml) told the backlog-writer agent to create issues in Backlog status, causing the governor to immediately dispatch dev agents before human review. All prompt sources now consistently use Icebox. The agent definition in downstream repos already specified Icebox, but the agentfactory built-in prompts overrode it.

## v0.7.44

### Fixes

- **Fix ZodError in autonomous agent permission handling** — Claude Code 2.1.70 requires `updatedInput` in `PermissionResult` allow responses, but `autonomousCanUseTool` returned `{ behavior: 'allow' }` without it. Added `updatedInput: input` to all allow returns to satisfy the stricter Zod validation.

## v0.7.43

### Features

- **Register CLI commands as in-process agent tools** — New `ToolPlugin` system exposes Linear CLI commands as typed, Zod-validated tools for Claude agents. Instead of shelling out to `pnpm af-linear`, agents call `af_linear_get_issue`, `af_linear_create_comment`, etc. directly — no subprocess overhead, no arg string construction, no stdout parsing. Uses the Claude Agent SDK's `createSdkMcpServer()` for in-process MCP tool registration (the only extension mechanism for adding custom tools to Claude Code). Non-Claude providers continue using the Bash-based CLI unchanged.
- **Tool plugin architecture for future integrations** — `ToolPlugin` interface and `ToolRegistry` enable adding new tool sets (Asana, deployment, framework-specific) with minimal boilerplate. Each plugin provides a name and a `createTools()` function returning SDK tool definitions.

### Chores

- **Move `runLinear()` from CLI to core** — The canonical Linear runner now lives in `packages/core/src/tools/linear-runner.ts`. The CLI re-exports from core, ensuring both CLI and tool plugin use the same code path.
- **Document tool plugin system** — Updated `docs/providers.md`, `docs/architecture.md`, `CONTRIBUTING.md`, and `CLAUDE.md` with MCP integration rationale, plugin authoring guide, and architecture diagrams.

## v0.7.42

### Fixes

- **Fix infinite loop when qa-coordination fails on parent issues** — QA coordination failure sent parent issues to `Backlog`, which triggered development coordination. The coordinator saw all sub-issues already `Finished` and immediately promoted back to `Finished`, restarting the QA cycle indefinitely. Changed `qa-coordination` fail status to `Started` instead, which keeps the issue visible without re-triggering the coordination loop.
- **Fix `getVersion()` returning "unknown" in compiled output** — Version resolution now works correctly in bundled builds.
- **Disable filesystem hooks for autonomous SDK agents** — Prevents permission failures when agents run headless.

### Features

- **Add cost tooltip and all-time total to dashboard** — Fleet management dashboard now shows per-session cost breakdowns and cumulative totals.

## v0.7.41

### Fixes

- **Route parent issues to coordination work type** — The Governor's `dispatchWork` mapped `trigger-development` → `development` regardless of whether the issue had sub-issues, so parent issues were treated as single development tasks instead of using the coordinator. Now `dispatchWork` checks the `parentIssueIds` cache and upgrades to `coordination`/`qa-coordination`/`acceptance-coordination` for parent issues. Added the same check to `spawnAgentForIssue` and `forwardPrompt` auto-detect paths for defense in depth.
- **Fix Bash permission failures for autonomous agents** — The `allowedTools` list only included command-specific prefixes (`pnpm`, `git`, `gh`, etc.) but missed common shell commands (`cd`, `pwd`, `ls`, `cat`, `find`, `mkdir`, etc.). Headless agents can't prompt for permission, so unlisted commands silently failed. Added ~25 common shell builtins and utilities.
- **Hard-block Linear MCP tools for autonomous agents** — The `canUseTool` callback denied Linear MCP tools but agents still called them successfully, suggesting the callback raced with MCP execution. Added all Linear MCP tool names to `disallowedTools` for a hard SDK-level block that prevents the tools from being callable.

## v0.7.40

### Fixes

- **Block Linear MCP tools for autonomous agents** — Agents were discovering Linear MCP tools via `ToolSearch` and calling them instead of using `pnpm af-linear` CLI, causing permission errors and data dumps into issue comments. The `autonomousCanUseTool` handler now denies `mcp__*Linear__*` tools with a redirect message to the CLI.
- **Fix noisy/misleading agent startup logs** — Show "spawning" instead of "PID: undefined" in `onAgentStart` (PID arrives asynchronously after process spawn). Switched dotenv from `config()` to `parse()` to eliminate tip spam on stdout. Downgraded `settings.local.json` warnings to debug level (file may exist without `env` key, which is not an error).

## v0.7.39

### Fixes

- **Fix orphan cleanup deadlock with issue locks** — When a worker is disrupted (e.g., tmux kill), orphan cleanup detected the stale session but failed to re-dispatch it because the issue lock (SET NX, 2h TTL) was still held by the same session. Work got parked instead of queued, and the stale-lock cleanup skipped it because the session was reset to `pending` (not terminal). Now orphan cleanup releases the issue lock before re-dispatching, and the stale-lock cleanup also treats `pending` as a stale lock status.
- **Fix cross-project work routing after orphan recovery** — Orphan and zombie cleanup omitted `projectName` when reconstructing `QueuedWork` for re-dispatch. The poll filter treated untagged work as "any worker can take it", allowing workers from the wrong repository to claim issues from other projects. Now `projectName` is preserved from session state during re-queue.
- **Add server-side project validation at claim time** — The claim endpoint (`POST /api/sessions/{id}/claim`) now validates that the claiming worker's project list includes the work item's `projectName`. If mismatched, the claim is rejected and work is requeued. Previously the poll filter was the only routing gate with no server-side enforcement.
- **Tighten poll filter for project-scoped workers** — Project-filtered workers now only see work explicitly tagged with their projects. Previously, untagged work (`!w.projectName`) was accepted by any worker, bypassing project routing.
- **Fix triple-dispatch duplication in event-bridge mode** — Prevented duplicate agent dispatches when events arrived via both webhook and polling simultaneously.

### Features

- **Add gitleaks pre-commit hook** for local secret scanning
- **Add dotenvx pre-commit hook** to block `.env` commits

## v0.7.38

### Fixes

- **IDE-safe worktree cleanup** — Worktree removal now detects processes (VS Code, Cursor, language servers) with open file handles via `lsof`. When detected without `--force`, the worktree is skipped instead of removed, preventing IDE crashes from sudden workspace deletion. Added `skipped` counter to `CleanupResult`, inter-removal settle delay (1.5s) for IDE file watchers, and removed redundant `git worktree prune` calls.

## v0.7.37

### Features

- **Skip worktree creation for non-code work types** — Research and backlog-creation agents no longer create git worktrees, branches, or `.agent/` state directories. These agents run from the main repo root with `cwd` set to `process.cwd()`, eliminating startup latency, branch pollution, and `fatal: no upstream` log noise. Added `WORK_TYPES_REQUIRING_WORKTREE` constant to `@renseiai/plugin-linear` for the 8 code-producing work types. Made `worktreeIdentifier` and `worktreePath` optional on `AgentProcess`, `SpawnAgentOptions`, and `SpawnAgentWithResumeOptions`. All state persistence, recovery checks, and worktree cleanup are automatically skipped when these fields are undefined.

## v0.7.36

### Fixes

- **Fix governor re-dispatching work for issues with active agents** — `getSessionStateByIssue()` returned the first Redis key match for an issue, regardless of session status. When multiple sessions existed (one running + several failed from prior claim attempts), a failed session could be found first, causing `hasActiveSession()` to return false. The governor then re-dispatched every scan cycle, creating duplicate queue entries that workers claimed and failed on ("Agent already running"). Now `getSessionStateByIssue()` scans all matching sessions and prefers active ones (running/claimed/pending) over inactive ones.
- **Use issue-lock dispatch in governor** — Governor's `dispatchWork()` called `queueWork()` directly, bypassing the issue-lock system. Multiple dispatches for the same issue all entered the global queue unserialized. Now uses `issueLockDispatchWork()` which acquires an atomic issue lock before queueing; if the issue is already locked, work is parked and auto-promoted when the lock is released.

## v0.7.35

### Fixes

- **Skip work for issues in terminal status (Accepted/Canceled/Duplicate)** — The governor queues work based on issue status at scan time, but by the time the worker picks up the item, the issue may have already moved to a terminal status. The orchestrator spawned agents anyway, causing issues like SUP-866 to get QA'd after already being Accepted. Added terminal status guards in `spawnAgentForIssue` (throws) and `forwardPrompt` (returns early with `reason: 'terminal_status'`).

### Features

- **Configurable build/test commands in agent frontmatter and repository config** (#15)

## v0.7.34

### Fixes

- **Fix QA infinite loop caused by rigid work result heuristics** — QA agents output verdicts like `**PASS**`, `Verdict: PASS`, `Status: **PASS**` but all heuristic patterns required a `QA` prefix (e.g., `QA Result: Pass`). Every QA run returned `unknown`, the orchestrator never transitioned the issue, and the work queue re-dispatched it endlessly. Made `QA` prefix optional, added bold markdown support (`**PASS**`/`**FAIL**`), and added standalone bold verdict patterns. Added 11 regression tests from real SUP-867 agent output.

## v0.7.33

### Fixes

- **Fix preserved worktrees blocking branch reuse** — When a worktree was preserved due to incomplete work, its heartbeat file remained on disk, causing the conflict handler to falsely detect a live agent for 30 seconds. This blocked subsequent agents from creating worktrees on the same branch, exhausting all 3 retries. Now the heartbeat file is deleted when a worktree is preserved (both completed and failed paths). Additionally, the conflict handler now saves a `.patch` file to `.worktrees/.patches/` before force-removing stale worktrees with incomplete work, preventing data loss.

## v0.7.32

### Fixes

- **Fix worktree cleanup deleting unpushed work for QA/acceptance agents** — The `checkForIncompleteWork()` safety check was gated behind `isDevelopmentWork`, so QA and acceptance agents' worktrees were cleaned up without verifying commits were pushed. This caused completed work to vanish when the worktree was removed with `--force`. Removed the work-type gate so the safety check applies to all completed agents, matching the already-correct failed-agent cleanup path.

## v0.7.31

### Fixes

- **Fix governor creating dead Linear sessions on every dispatch** — The governor resolved the OAuth token once at startup and held a static `LinearAgentClient` for the entire process lifetime. When the token expired or was missing, every `createAgentSessionOnIssue()` call failed and all sessions received a `governor-` prefixed fallback ID, causing all worker activity/progress forwarding to Linear to silently fail. Changed to a lazy resolver that re-reads the token from Redis on each dispatch, auto-refreshes when needed, and only creates a new client when the token actually changes.

## v0.7.30

### Features

- **Enable agents to add new dependencies in worktrees** — Agents can now install packages they need (e.g., `stripe`) instead of getting stuck in a loop. The orchestrator writes `.agent/add-dep.sh` into each worktree during setup, which safely removes symlinked `node_modules` and runs `pnpm add` with the `ORCHESTRATOR_INSTALL=1` guard bypass. Updated dependency-instructions partial, renseiai CLAUDE.md, and the preinstall guard error message to direct agents to the helper script.

## v0.7.29

### Fixes

- **Prevent worktree node_modules from corrupting main repo** — Replaced directory-level symlinks with real directories containing per-entry symlinks. Previously, if an agent ran `pnpm install` in a worktree, pnpm would follow the top-level symlink and write into the main repo's `node_modules`. Now each entry is individually symlinked, so a rogue install only destroys the worktree's links. Also sets `ORCHESTRATOR_INSTALL=1` env var to bypass the preinstall guard when the orchestrator intentionally runs pnpm install as a fallback.

## v0.7.28

### Fixes

- **Prevent runaway agent loops (SUP-855 post-mortem)** — Six fixes to stop multi-session spirals:
  - Count `unknown` work results as failures so the 4-cycle escalation ladder fires correctly
  - Increase cooldown TTLs from 10 seconds to 5 minutes to prevent immediate re-triggering
  - Add per-issue hard cap of 8 total sessions with automatic escalation comment
  - Harden QA templates to hard-fail on build/typecheck errors instead of rationalizing them
  - Skip acceptance-coordination when sub-issues were never actually worked
  - Add 30-minute post-acceptance lock to prevent re-triggering after merge

## v0.7.27

### Fixes

- **Prevent QA state loop caused by agents manually changing issue status** — QA coordination agents were bypassing the orchestrator by calling `pnpm af-linear update-issue --state` directly, creating a Finished→Backlog→Started→Finished loop. Added explicit "never manually change status" instruction to the `work-result-marker` partial (included in all QA/acceptance templates) and reinforced in coordination templates.
- **Route QA failures to Backlog instead of Rejected** — Changed `WORK_TYPE_FAIL_STATUS` for `qa` and `qa-coordination` from `Rejected` to `Backlog`, so failed QA issues go directly back to the developer/coordinator with failure context instead of requiring a refinement intermediary. Updated the webhook handler to accept `Finished→Backlog` as a valid retry path with circuit breaker checks.
- **Detect coordination-style QA output in work result parser** — Added heuristic patterns for `Overall Result: FAIL`, `Roll-Up Verdict: FAIL`, and `Parent QA verdict: FAIL` (and PASS counterparts) so the orchestrator correctly detects pass/fail from QA coordination agents even without the structured marker.

## v0.7.26

### Fixes

- **Fix Linear CLI team resolution (name vs key)** — The orchestrator passed the team display name (e.g., "Rensei") as `LINEAR_TEAM_NAME`, but the Linear SDK's `team()` method only accepts team keys ("SUP") or UUIDs. Agents wasted many turns reverse-engineering the correct key. Now passes `team?.key` instead of `team?.name` in all three orchestrator locations and the `createBlocker` CLI fallback.
- **Make `getTeam()` resilient to display names** — `AgentClient.getTeam()` now falls back to a name search when key/ID lookup fails, so agents manually passing `--team "Rensei"` also work.

## v0.7.25

### Fixes

- **Fix governor version display showing "vunknown"** — `getVersion()` resolved `package.json` one directory level too shallow from the compiled `dist/src/` output, landing in `dist/` instead of the package root. Fixed path to go up two levels.
- **Eliminate per-issue isParentIssue API calls burning Linear quota** — The `parentIssueIds` cache only tracked parent issues, so every non-parent issue (the majority) fell through to an individual API call. With 128 issues in a single project scanned every 60s, this easily exceeded the 5,000 req/hr limit. Added a `scannedIssueIds` set so issues already seen in the batch query return immediately without an API fallback.
- **Wire onScanComplete callback in continuous governor mode** — `WorkflowGovernor.start()` discarded `scanOnce()` results in fire-and-forget mode, so `printScanSummary` with its colorized output and quota progress bars never rendered. Added `WorkflowGovernorCallbacks` to the governor constructor so the CLI receives scan results on every cycle.

## v0.7.24

### Fixes

- **Fix worktree symlink crash for missing apps** — `linkDependencies` now checks if the destination parent directory exists before creating per-workspace `node_modules` symlinks. When a branch doesn't contain all apps from `main` (e.g., `family-mobile` missing on a feature branch), the entry is skipped instead of throwing ENOENT and falling back to a full `pnpm install`.
- **Prevent `pnpm install` fallback from corrupting main repo** — `installDependencies` now removes any partial `node_modules` symlinks (root + per-workspace) before running `pnpm install`. Previously, the root `node_modules` symlink created by `linkDependencies` before the error would cause `pnpm install` to write through it into the main repo's `node_modules`, requiring the user to re-run `pnpm install` after agent work.
- **Release claim key on partial failure to prevent work queue deadlock** — When `claimWork()` succeeded at SETNX but a subsequent Redis operation threw, the claim key was left stuck for its full 1-hour TTL while the work item remained in the queue. All workers would then fail SETNX, causing infinite claim failures. Similarly, if the claim handler threw after removing the item from the queue, neither the claim key nor the work item was cleaned up.

## v0.7.23

### Features

- **Governor production logging** — New colorized, structured output for the governor CLI replacing plain `console.log`. Startup banner with version/config/integration status, per-scan summary with dispatched/skipped counts, and Linear API quota progress bars (request + complexity) with green/yellow/red thresholds.
- **API call counting for leak diagnosis** — `LinearAgentClient` now tracks per-scan API call counts (`apiCallCount`/`resetApiCallCount()`) and extracts quota headers via `onApiResponse` callback. Displayed alongside quota bars to help diagnose rate limit consumption.

### Fixes

- **Eliminate 2 redundant API calls per dispatch** — `dispatchWork` now receives the full `GovernorIssue` (already resolved during scan) instead of an `issueId` string. Removes the `getIssue()` + lazy project resolution calls that were re-fetching data already available from the scan query.
- **Consolidated rawRequest type** — Replaced 4 inline `this.client as unknown as { client: { rawRequest... } }` casts with a shared `RawGraphQLClient` type alias in `agent-client.ts`.

## v0.7.22

### Features

- **Monorepo path scoping for orchestrator** — New `projectPaths` and `sharedPaths` fields in `.donmai/config.yaml` allow mapping Linear projects to specific directories in a monorepo. Agents receive directory scoping instructions via `{{projectPath}}` and `{{sharedPaths}}` template variables, and a new `{{> partials/path-scoping}}` partial validates file changes at push time.

### Fixes

- **403 circuit breaker for ApiActivityEmitter** — When a session's ownership is transferred to another worker, the old worker's emitter now detects the 403 "owned by another worker" response, trips an `ownershipRevoked` circuit breaker, and stops all further activity/progress emission. Previously it would spam 403 errors for the entire agent lifetime. New `onOwnershipRevoked` callback allows the worker to request agent shutdown.
- **Reduce retry waste in agent spawn loop** — Reduced `MAX_SPAWN_RETRIES` from 6 to 3 (45s total instead of 90s). For "agent already running" errors, the retry loop now checks session ownership on the server before retrying — if another worker owns the session, it bails immediately instead of wasting API calls and dependency linking on each attempt.
- **Orphan cleanup grace period** — `findOrphanedSessions()` now skips sessions updated within the last 2 minutes (`ORPHAN_THRESHOLD_MS`), preventing the race condition where a worker re-registers with a new ID but hasn't transferred session ownership yet.
- **Increase worker TTL and heartbeat timeout** — `WORKER_TTL` increased from 120s to 300s, `HEARTBEAT_TIMEOUT` from 90s to 180s. The previous values were too tight — busy workers processing long agents could miss heartbeats, causing Redis key expiry, 404 errors, and re-registration cascades.
- **Use Node.js rmSync for worktree cleanup** — Replaced `execSync('rm -rf ...')` with `rmSync()` with `maxRetries: 3` and `retryDelay: 1000` for more resilient cleanup on mounted volumes and cross-platform compatibility.

## v0.7.21

### Fixes

- **Add WORK_RESULT marker instructions to coordination prompts** — The `qa-coordination` and `acceptance-coordination` work types were treated as result-sensitive by the orchestrator (requiring `<!-- WORK_RESULT:passed/failed -->` in the agent's final output), but neither prompt template included the structured result marker instructions. This caused the orchestrator to post a false "no structured result marker detected" warning even when the QA coordinator successfully moved the issue to Delivered. Fixed in both the hardcoded prompts (`orchestrator.ts`) and the YAML templates (`qa-coordination.yaml`, `acceptance-coordination.yaml`).

## v0.7.20

### Fixes

- **Strip Anthropic API keys from agent environments** — App `.env.local` files (e.g. `apps/social/.env.local`) may contain `ANTHROPIC_API_KEY` for runtime use. The orchestrator was loading these and passing them into Claude Code agent processes, causing Claude Code to switch from Max subscription billing to API-key billing. Added `AGENT_ENV_BLOCKLIST` that strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, and `OPENCLAW_GATEWAY_TOKEN` from all three env sources (`process.env`, app env files, and `settings.local.json`) before spawning agents. Applied to both `spawnAgent()` and `forwardPrompt()` code paths.
- **Governor skips sub-issues in all statuses** — Previously only skipped sub-issues in Backlog; now skips in all statuses to prevent double-dispatch.
- **Optimize N+1 GraphQL queries** — Reduced Linear API calls for sub-issue graph, relations, and status fetching from O(N) to O(1) using raw GraphQL queries with nested fields.
- **Skip Linear forwarding for governor-generated fake session IDs** — Prevents 404 errors when the governor creates synthetic sessions for internal use.
- **Record all auth failures in circuit breaker** — Circuit breaker now records auth failures regardless of HTTP status code, improving detection of degraded Linear API states.

### Chores

- Aligned all package versions to 0.7.20 across the monorepo.

## v0.7.19

### Features

- **Circuit breaker for Linear API** — New `CircuitBreaker` class in `@renseiai/plugin-linear` with closed→open→half-open state machine and exponential backoff. Detects auth errors (400/401/403), GraphQL `RATELIMITED` responses, and error message patterns. Integrated into `LinearAgentClient.withRetry()` — checks circuit before acquiring a rate limit token, so no quota is consumed when the circuit is open.
- **Pluggable rate limiter & circuit breaker strategies** — New `RateLimiterStrategy` and `CircuitBreakerStrategy` interfaces allow swapping in-memory defaults for Redis-backed implementations. `LinearAgentClient` accepts optional strategy overrides via config.
- **Redis-backed shared rate limiter** — New `RedisTokenBucket` in `@renseiai/agentfactory-server` uses atomic Lua scripts to share a single token bucket across all processes (dashboard, governor, agents). Key: `linear:rate-limit:{workspaceId}`.
- **Redis-backed shared circuit breaker** — New `RedisCircuitBreaker` in `@renseiai/agentfactory-server` shares circuit state across processes via Redis. Supports exponential backoff on reset timeout.
- **Linear quota tracker** — New `QuotaTracker` in `@renseiai/agentfactory-server` reads and stores Linear's `X-RateLimit-Requests-Remaining` and `X-RateLimit-Complexity-Remaining` headers in Redis for proactive throttling. Warns when quota drops below threshold.
- **Centralized issue tracker proxy** — New `POST /api/issue-tracker-proxy` endpoint in `@donmai/nextjs` acts as a single gateway for all Linear API calls. Agents, governors, and CLI tools call this endpoint instead of Linear directly, centralizing rate limiting, circuit breaking, and OAuth token management. Includes a health endpoint at `GET /api/issue-tracker-proxy`.
- **Platform-agnostic proxy types** — New `IssueTrackerMethod`, `SerializedIssue`, `SerializedComment`, `ProxyRequest`, and `ProxyResponse` types in `@renseiai/plugin-linear` are Linear-agnostic, enabling future issue tracker backends without changing consumer code.
- **Proxy client** — New `ProxyIssueTrackerClient` in `@renseiai/plugin-linear` is a drop-in replacement that routes all calls through the dashboard proxy. Activated when `AGENTFACTORY_API_URL` env var is set.

### Fixes

- **Removed harmful OAuth fallback** — The Linear client resolver no longer falls back to a personal API key when OAuth token lookup fails. Personal API keys cannot call Agent API endpoints (`createAgentActivity`, etc.), so the fallback guaranteed 400 errors that wasted rate limit quota.
- **Workspace client caching** — The Linear client resolver now caches workspace clients with a 5-minute TTL, so all requests within the dashboard process share one client (and one token bucket + circuit breaker) per workspace.
- **Governor uses Redis strategies** — When `REDIS_URL` is available, the governor injects `RedisTokenBucket` and `RedisCircuitBreaker` into its Linear clients for coordinated rate limiting across processes.

### Tests

- Circuit breaker unit tests (23 tests) — state transitions, auth error detection, GraphQL RATELIMITED detection, exponential backoff, half-open probe, reset, diagnostics.
- Updated manifest route count (24→25) and create-app template parity for the new proxy route.

### Chores

- Aligned all package versions to 0.7.19 across the monorepo.

## v0.7.18

### Fixes

- **Governor uses OAuth tokens from Redis for Linear Agent API** — The governor now resolves OAuth access tokens from Redis at startup and uses them for `createAgentSessionOnIssue`, fixing "Failed to post to Linear" errors caused by using a personal API key for the Agent API. Falls back to personal API key when no OAuth token is available.
- **Governor stores `organizationId` on session state** — Workers can now resolve the correct OAuth token for progress/activity posting since the workspace ID is persisted alongside the session.
- **Governor includes `prompt` in queued work items** — Agents receive work-type-specific prompts instead of generic fallbacks, improving agent behavior on pickup.

### Chores

- Aligned all package versions to 0.7.18 across the monorepo.

## v0.7.17

### Fixes

- **Governor skips sub-issues in Backlog** — The decision engine now checks `parentId` and skips sub-issues, dispatching only top-level and parent issues. This prevents invisible backlog sprawl when sub-issues are in Backlog but their parent is still in Icebox.
- **Backlog-writer creates sub-issues in Icebox** — Sub-issues are now created with `--state "Icebox"` to match their parent. The user promotes the parent to Backlog when ready and sub-issues follow via Linear's built-in behavior. Independent issues still default to Backlog.

### Tests

- Added decision engine tests for sub-issue skip behavior and precedence over `enableAutoDevelopment`.

### Chores

- Aligned all package versions to 0.7.17 across the monorepo.

## v0.7.16

### Fixes

- **Governor `GOVERNOR_PROJECTS` env var** — The governor CLI now reads `GOVERNOR_PROJECTS` (comma-separated) as a fallback when no `--project` flags are provided. Aligns with `worker` and `worker-fleet` CLIs which already support env var defaults via `WORKER_PROJECTS`.

### Chores

- Aligned all package versions to 0.7.16 across the monorepo.

## v0.7.15

### Features

- **`af-sync-routes` CLI command** — New command that auto-generates missing `route.ts` and `page.tsx` files in consumer projects after upgrading `@renseiai` packages. Reads from a central route manifest in `@renseiai/agentfactory` and creates only missing files (never overwrites). Use `--pages` to also sync dashboard pages, `--dry-run` to preview. Available as `af-sync-routes` binary and `@donmai/cli/sync-routes` subpath export.
- **Route manifest** — New `ROUTE_MANIFEST` in `@renseiai/agentfactory` defines all 24 API routes and 5 dashboard pages as structured data. Includes `generateRouteContent()` and `generatePageContent()` generators that produce output identical to the `create-app` templates.

### Tests

- Manifest unit tests (14 tests) — validates entry counts, path patterns, method accessors, and content generation.
- Manifest / create-app parity tests (6 tests) — ensures the manifest stays in sync with `create-app` templates.
- Sync routes runner tests (8 tests) — file creation, no-overwrite safety, dry-run, error handling, and page sync.

### Chores

- Excluded `__tests__` directories from tsc build in core and cli packages.
- Aligned all package versions to 0.7.15 across the monorepo.

## v0.7.14

### Features

- **Linear API rate limiter** — New `TokenBucket` rate limiter in `@renseiai/plugin-linear` proactively throttles requests below Linear's ~100 req/min limit. Uses a token bucket algorithm (80 burst capacity, 1.5 tokens/sec refill). All `LinearAgentClient` API calls now pass through the rate limiter with automatic backpressure. Includes `Retry-After` header parsing for 429 responses.
- **Auto-detect app URL on Vercel** — `getAppUrl()` and OAuth callback in `@donmai/nextjs` now fall back to `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL` when `NEXT_PUBLIC_APP_URL` is not set. Removes the need to manually configure app URL on Vercel deployments.
- **One-click deploy buttons** — Vercel and Railway deploy buttons are now fully functional across all READMEs. Vercel deploys from the monorepo subdirectory (`agentfactory/tree/main/templates/dashboard`), eliminating the need for a separate template repository. Railway deploy uses a published template with bundled Redis.

### Fixes

- **Dashboard template Tailwind v4 build** — The dashboard template imported the `@renseiai/agentfactory-dashboard` v3 stylesheet which used `@apply border-border`, failing under Tailwind v4. Converted all dashboard styles to v4-native `@theme` declarations and removed the v3 import.
- **`vercel.json` schema validation** — Removed invalid `env` block that used object format (`{description, required}`) instead of Vercel's expected string values. Env vars are prompted via the deploy button URL parameter instead.
- **Retry improvements** — Retry logic now handles `429 Too Many Requests` with `Retry-After` header parsing, and distinguishes retryable status codes (429, 500, 502, 503, 504) from non-retryable ones.
- **Governor dependencies cleanup** — Simplified `governor-dependencies.ts` in the CLI package, removing redundant wiring.

### Docs

- **Workflow Governor documentation** — Added comprehensive Governor docs across all packages.

### Chores

- Updated dashboard template dependency versions to 0.7.14.
- Added `next-env.d.ts` to template `.gitignore`.
- Aligned all package versions to 0.7.14 across the monorepo.

## v0.7.13

### Fixes

- **Terminal state guard on AgentSession** — `AgentSession.start()` and `AgentSession.complete()` now check the issue's current status before auto-transitioning. If the issue is in a terminal state (Accepted, Canceled, Duplicate), the transition is refused with a warning. This prevents stale or rogue sessions from pulling completed issues back into active workflow states.

## v0.7.12

### Fixes

- **Governor dispatch loop** — `dispatchWork()` now calls `storeSessionState()` before `queueWork()`, so `hasActiveSession()` correctly returns true on subsequent poll sweeps. Previously, the governor would re-dispatch the same issue every poll cycle because no session was registered in Redis.
- **Worker claim failures** — Workers could never claim governor-dispatched work because `claimSession()` requires a pending session in Redis. The session is now registered before the queue entry, eliminating the race window.
- **Phase completion signal** — When research or backlog-creation sessions complete, `markPhaseCompleted()` is now called in the session status handler. This prevents the governor from re-dispatching top-of-funnel work for the same issue after each poll sweep.
- **Project name on dispatched work** — Governor-dispatched queue items now include `projectName`, enabling correct worker routing across multi-project deployments.

### Changes

- **Icebox auto-triggers default to off** — `enableAutoResearch` and `enableAutoBacklogCreation` now default to `false`. The Icebox is a space for ideation and iterative refinement via @ mentions; automated research/backlog-creation is opt-in via `--auto-research` / `--auto-backlog-creation` CLI flags. The governor's default scope is Backlog → development, Finished → QA, Delivered → acceptance.

## v0.7.11

### Features

- **Hybrid Event+Poll Governor** — `EventDrivenGovernor` wraps the existing decision engine with a real-time event loop (via `GovernorEventBus`) plus a periodic poll safety net (default 5 min), both feeding through `EventDeduplicator` to avoid duplicate processing
- **PlatformAdapter pattern** — New `PlatformAdapter` interface in core with `LinearPlatformAdapter` implementation that normalizes Linear webhooks into `GovernorEvent`s and scans projects for non-terminal issues
- **Webhook-to-Governor bridge** — `governorMode` config (`direct` | `event-bridge` | `governor-only`) lets deployments opt in incrementally; webhooks publish status-change events to the bus alongside or instead of direct dispatch
- **Real GovernorDependencies** — CLI governor now wires all 10 dependency callbacks to Linear SDK + Redis (sessions, cooldowns, overrides, workflow state, phase tracking, work dispatch) with stub fallback when env vars aren't set
- **Redis Streams event bus** — `RedisEventBus` with consumer groups, MAXLEN trimming, and pending message re-delivery; `RedisEventDeduplicator` using SETNX with TTL
- **`--mode event-driven|poll-only` CLI flag** — `af-governor` now supports event-driven mode with `InMemoryEventBus` for single-process usage

### Chores

- Aligned all package versions to 0.7.11 across the monorepo.

## v0.7.10

### Features

- **Workflow Governor** — Autonomous lifecycle management with human-in-the-loop. Replaces manual @mention-driven triggers with a deterministic state machine that surfaces high-value decision points for human input. Includes:
  - **WorkSchedulingFrontend interface** with AbstractStatus (8 statuses, 16 methods) for frontend-agnostic work scheduling
  - **LinearFrontendAdapter** wrapping LinearAgentClient through the abstract interface
  - **Governor scan loop** — Polling-based scheduler with configurable intervals, decision engine, and priority-aware dispatch
  - **Human touchpoint system** — Structured override directives (HOLD, RESUME, SKIP QA, DECOMPOSE, REASSIGN, PRIORITY) with configurable timeouts
  - **Auto top-of-funnel** — Automatic research and backlog-creation for Icebox issues based on description quality heuristics
  - **Strategy-aware template selection** — Escalation-driven template resolution (normal → context-enriched → decompose → escalate-human)
  - **`af-governor` CLI** — New binary entry point for running the Governor scan loop
  - **PM curation workflow documentation** — Docs for PM interaction with the top-of-funnel pipeline

### Improvements

- **Workflow state machine and QA loop circuit breaker** — Added `WorkflowState` tracking and escalation ladder for QA cycles
- **YAML-based workflow template system** — Agent prompts driven by YAML templates with Handlebars interpolation, overridable per project

### Chores

- Aligned all package versions to 0.7.10 across the monorepo.

## v0.7.9

### Features

- **`LINEAR_TEAM_NAME` env var for CLI** — `pnpm af-linear create-issue` now falls back to the `LINEAR_TEAM_NAME` environment variable when `--team` is omitted. The orchestrator auto-sets this from the issue's team context, so agents no longer waste turns discovering the team name. Explicit `--team` always wins. Added `getDefaultTeamName()` to `@renseiai/plugin-linear` constants.
- **Server-level project filtering** — `@renseiai/agentfactory-server` supports project filtering at the server level for multi-project deployments.
- **Improved WORK_RESULT marker handling** — QA and acceptance agent prompts now have better `<!-- WORK_RESULT:passed/failed -->` marker instructions and handling.

### Fixes

- **`qa-coordination` and `acceptance-coordination` priority order** — Fixed work type priority ordering to include `qa-coordination` and `acceptance-coordination` in the correct position.

### Chores

- Aligned all package versions to 0.7.9 across the monorepo.

## v0.7.8

### Chores

- **Standardize Linear CLI command references** — Replaced all `pnpm linear` references with `pnpm af-linear` across documentation, agent definitions, orchestrator prompts, and templates. The `af-linear` binary name is the canonical invocation since v0.7.6; the old `pnpm linear` script alias was an internal-only convenience that didn't work in consumer projects or worktrees.
- Renamed root `package.json` script from `linear` to `af-linear` for consistency.
- Aligned all package versions to 0.7.8 across the monorepo.

## v0.7.7

### Fixes

- **Fix autonomous agent permissions in worktrees** — Agents spawned by the orchestrator in git worktrees were unable to run `pnpm af-linear` and other Bash commands because they received unanswerable permission prompts in headless mode. Two compounding issues:
  1. **Wrong `allowedTools` pattern format** — `Bash(pnpm *)` (space) doesn't match; Claude Code uses `Bash(prefix:glob)` syntax with a colon separator. Fixed to `Bash(pnpm:*)`.
  2. **Filesystem hooks unreliable in worktrees** — The auto-approve hook (`.claude/hooks/auto-approve.js`) loaded via `settingSources: ['project']` may not resolve correctly when `.git` is a file (worktree) instead of a directory. Added a programmatic `canUseTool` callback as a reliable in-process fallback that doesn't depend on filesystem hook resolution.

### Features

- **`create-blocker` command** — New `af-linear create-blocker` / `pnpm af-linear create-blocker` command for creating human-needed blocker issues that block the source issue.

### Improvements

- **Expanded `allowedTools` coverage** — Autonomous agents now pre-approve `npm`, `tsx`, `python3`, `python`, `curl`, `turbo`, `tsc`, `vitest`, `jest`, and `claude` in addition to the existing `pnpm`, `git`, `gh`, `node`, `npx`.
- **WORK_RESULT marker instruction** — QA and acceptance agent prompts now include explicit instructions for the `<!-- WORK_RESULT:passed/failed -->` marker.

### Chores

- Aligned all package versions to 0.7.7 across the monorepo.

## v0.7.6

### Features

- **`af-linear` CLI** — Promoted the Linear CLI to a published binary in `@donmai/cli`. All 15 commands (`get-issue`, `create-issue`, `update-issue`, `list-comments`, `create-comment`, `list-backlog-issues`, `list-unblocked-backlog`, `check-blocked`, `add-relation`, `list-relations`, `remove-relation`, `list-sub-issues`, `list-sub-issue-statuses`, `update-sub-issue`, `check-deployment`) are now available via `npx af-linear` or `pnpm af-linear` after installing `@donmai/cli`. Previously, the Linear CLI only existed as an internal script in `packages/core/` and consumers had to bundle their own copy.
- **`@donmai/cli/linear` subpath export** — `runLinear()` and `parseLinearArgs()` are available as a programmatic API for building custom CLI wrappers.
- **`create-agentfactory-app` improvements** — Scaffolded projects now include `pnpm af-linear` out of the box (via `af-linear`), a `.claude/CLAUDE.md` with Linear CLI reference, and an enhanced developer agent definition with Linear status update workflows.

### Chores

- `@donmai/cli` is now a required dependency for all scaffolded projects (not just when `includeCli` is selected).
- Deprecated `packages/core/src/linear-cli.ts` in favor of the CLI package.
- Aligned all package versions to 0.7.6 across the monorepo.

## v0.7.5

### Fixes

- **Fix Redis WRONGTYPE error in expired lock cleanup** — `cleanupExpiredLocksWithPendingWork()` scanned `issue:pending:*` which matched both sorted sets (`issue:pending:{id}`) and hashes (`issue:pending:items:{id}`). Running `ZCARD` on a hash key caused a recurring `WRONGTYPE` error in production. Added the same colon-guard already present in `cleanupStaleLocksWithIdleWorkers`.

### Chores

- Aligned all package versions to 0.7.5 across the monorepo.

## v0.7.4

### Fixes

- **Auto-allow bash commands for autonomous agents in worktrees** — Agents spawned in git worktrees couldn't run `pnpm af-linear` or other bash commands because `settings.local.json` and the auto-approve hook weren't accessible from the worktree CWD. The Claude provider now passes `allowedTools` to the SDK so `pnpm`, `git`, `gh`, `node`, and `npx` commands are auto-approved for autonomous agents without relying on filesystem settings. Added optional `allowedTools` field to `AgentSpawnConfig` for custom overrides.
- **Linear CLI loads `.env.local` credentials automatically** — `pnpm af-linear` commands no longer require `LINEAR_API_KEY` to be exported in the shell. The CLI now loads `.env` and `.env.local` via dotenv at startup.

### Chores

- Aligned all package versions to 0.7.4 across the monorepo.

## v0.7.3

### Fixes

- **`create-agentfactory-app` scaffold overhaul** — Fixed multiple issues that caused scaffolded projects to fail at build time or crash on deployment:
  - **Edge Runtime middleware crash** — Changed middleware import from `@donmai/nextjs` (main barrel, pulls in Node.js-only deps like ioredis) to `@donmai/nextjs/middleware` (Edge-compatible subpath). Without this fix, every Vercel deployment crashes with `MIDDLEWARE_INVOCATION_FAILED` / `charCodeAt` errors.
  - **Tailwind v3 → v4** — Replaced deprecated Tailwind v3 setup (`tailwind.config.ts` + `postcss.config.js` + autoprefixer) with Tailwind v4 CSS-based config (`postcss.config.mjs` + `@tailwindcss/postcss`). Updated `globals.css` from `@tailwind` directives to `@import "tailwindcss"` + `@source`.
  - **CLI orchestrator missing `linearApiKey`** — `runOrchestrator()` requires `linearApiKey` but the scaffold omitted it, causing a TypeScript error.
  - **CLI cleanup called `.catch()` on sync return** — `runCleanup()` returns `CleanupResult` synchronously, not a Promise. The scaffold treated it as async.
  - **CLI worker/worker-fleet missing signal handling** — Added `AbortController` for graceful SIGINT/SIGTERM shutdown, environment variable fallbacks for `WORKER_CAPACITY`/`WORKER_PROJECTS`/`WORKER_FLEET_SIZE`, and full argument parsing.
  - **Stale dependency versions** — Bumped all `@renseiai/agentfactory-*` deps from `^0.4.0` to `^0.7.2`, Next.js from `^15.3.0` to `^16.1.0`.
  - **Removed `/dashboard` from middleware matcher** — The dashboard lives at `/`, not `/dashboard`.

### Chores

- Aligned all package versions to 0.7.3 across the monorepo.

## v0.7.2

### Critical Fix

- **Prevent catastrophic main worktree destruction** — Fixed a critical bug where the stale worktree cleanup logic could `rm -rf` the main repository when a branch was checked out in the main working tree (e.g., via IDE). When the orchestrator encountered a branch conflict with the main tree, it incorrectly identified it as a "stale worktree" and attempted destructive cleanup, destroying all source files, `.git`, `.env.local`, and other untracked files.

  Three layered safety guards added to `tryCleanupConflictingWorktree()`:
  1. **`isMainWorktree()` check** — Detects the main working tree by verifying `.git` is a directory (not a worktree file), cross-checked with `git worktree list --porcelain`. Errs on the side of caution if undetermined.
  2. **`isInsideWorktreesDir()` check** — Ensures the conflict path is inside `.worktrees/` before any cleanup is attempted. Paths outside the worktrees directory are never touched.
  3. **`"is a main working tree"` error guard** — If `git worktree remove --force` itself reports the path is the main tree, the `rm -rf` fallback is now blocked instead of being used as escalation.

  Additionally, `removeWorktree()` in the CLI cleanup-runner now validates the target is not the main working tree before proceeding.

## v0.7.1

### Features

- **Worktree dependency symlinks** — Replaced `preInstallDependencies()` with `linkDependencies()` in the orchestrator. Symlinks `node_modules` from the main repo into worktrees instead of running `pnpm install`, making worktree setup near-instant vs 10+ minutes on cross-volume setups. Falls back to `pnpm install` if symlinking fails.

## v0.7.0

### Features

- **Linear CLI restored** — Ported the full Linear CLI entry point (`pnpm af-linear`) from the renseiai repo. Provides 16 subcommands (`get-issue`, `create-issue`, `update-issue`, `create-comment`, `list-comments`, `add-relation`, `list-relations`, `remove-relation`, `list-sub-issues`, `list-sub-issue-statuses`, `update-sub-issue`, `check-blocked`, `list-backlog-issues`, `list-unblocked-backlog`, `check-deployment`) wrapping `@renseiai/plugin-linear`. Runs via `node --import tsx` so it works in worktrees without a build step.
- **CLAUDE.md project instructions** — Added root-level `CLAUDE.md` with Linear CLI reference, autonomous mode detection, project structure, worktree lifecycle rules, and explicit prohibition of Linear MCP tools.
- **Agent definitions** — Added full agent definitions to `examples/agent-definitions/` for backlog-writer, developer, qa-reviewer, coordinator, and acceptance-handler. Each includes Linear CLI instructions and MCP prohibition.
- **Orchestrator CLI guidance** — All 10 work types in `generatePromptForWorkType()` now include explicit instructions to use `pnpm af-linear` instead of MCP tools.

### Fixes

- **Linear DEFAULT_TEAM_ID** — Resolved empty `DEFAULT_TEAM_ID` caused by ESM import hoisting.
- **Dashboard clickable links** — Styled issue identifiers as clickable links on fleet and pipeline pages.

### Chores

- Added `worker-fleet` and `analyze-logs` root scripts.
- Added "Built with AgentFactory" badge system and README badge.
- Resized badges to 20px to match shields.io standard.
- Fleet-runner changes.
- Consolidated backlog-writer to `examples/`, gitignored `.claude/`.
