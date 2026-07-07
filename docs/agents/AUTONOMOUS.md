# Autonomous operation — headless mode, exit gate, worktree rules

Routed from `AGENTS.md`. Applies whenever an agent runs via webhook or the
orchestrator.

## Detection

```typescript
const isAutonomous = !!process.env.LINEAR_SESSION_ID
```

## Behavior rules when `LINEAR_SESSION_ID` is set

1. **Never ask for user input** — `AskUserQuestion` is disabled. Decide from
   the issue description, existing code patterns, and best practices.
2. **Make reasonable assumptions** — pick the simplest solution, follow
   existing patterns, and document each assumption in code comments or the PR
   description.
3. **Complete the full workflow** — implement, run `pnpm test` and
   `pnpm typecheck`, create the PR, report status.
4. **Handle errors gracefully** — try alternatives; if blocked, post a Linear
   comment and mark the work failed.
5. **Never delete your own worktree** — see Worktree lifecycle below.
6. Spawn `Task` agents with `subagent_type=Explore` for research tasks.

## Session exit gate

The orchestrator wraps every agent session with deterministic post-session
validation so paid token work actually lands — an agent cannot silently exit
without producing its expected outputs.

1. **Completion contracts** define what each work type must produce
   (`packages/core/src/orchestrator/completion-contracts.ts`).
2. **Output tracking** monitors tool calls during the session (comments,
   issue updates, sub-issues).
3. **Post-session backstop** validates the contract and auto-recovers missing
   outputs (`packages/core/src/orchestrator/session-backstop.ts`).
4. **Diagnostic comments** are posted when gaps remain.

### Completion contracts by work type

| Work type | Required outputs |
|-----------|------------------|
| `development`, `inflight` | Commits on branch, branch pushed, PR created |
| `qa` | Work result (passed/failed), comment posted |
| `acceptance` | Work result (passed/failed) |
| `refinement` | Comment posted |
| `refinement-coordination` | Comment posted |
| `research` | Issue description updated |
| `backlog-creation` | Sub-issues created |
| `merge` | PR merged |

The QA/acceptance work-result format is `docs/WORK_RESULT_MARKER.md`.

### Backstop recovery

The backstop can automatically push unpushed branches, create PRs from pushed
branches that lack one, and detect PRs created but not captured in output.
Fields requiring agent judgment (`work_result`, `comment_posted`) cannot be
backstopped — the orchestrator posts a diagnostic comment and blocks status
promotion.

### Provider capabilities

| Provider | Message injection | Session resume | Exit-gate strategy |
|----------|-------------------|----------------|--------------------|
| Claude | Yes | Yes | Mid-session steering (future) + backstop |
| A2A | Yes | Yes | Mid-session steering (future) + backstop |
| Codex | No | Yes | Backstop + stop/resume fallback |
| Spring AI | No | Yes | Backstop + stop/resume fallback |

The backstop is provider-agnostic (operates on git/GitHub). Capability flags:
`packages/core/src/providers/types.ts` (`AgentProviderCapabilities`).

## Worktree lifecycle

Worktrees are created in a sibling directory: `../donmai-libraries.wt/{branch}`
(`../{repoName}.wt/{branch}`; avoids editor filesystem-watcher storms of the
old in-repo `.worktrees/` layout). The path is configurable via
`worktree.directory` in `.donmai/config.yaml` with `{repoName}` and `{branch}`
template variables. Migrate legacy layouts with `pnpm af-migrate-worktrees`.

The orchestrator owns worktree creation and cleanup. Agents:

1. NEVER run `git worktree remove` or `git worktree prune`.
2. NEVER run `git checkout` or `git switch` to a different branch.
3. NEVER run `git reset --hard`, `git clean -fd`, or `git restore .`.
4. NEVER delete or modify the `.git` file in the worktree root.
5. Only the orchestrator manages worktree lifecycle.

### Shared worktrees (coordination)

When multiple sub-agents run concurrently in one worktree: work only on files
relevant to your sub-issue; commit with descriptive messages before reporting
completion; prefix EVERY sub-agent prompt with
"SHARED WORKTREE — DO NOT MODIFY GIT STATE".

### Auto-refresh hook

`.claude/settings.json` registers a `SessionStart` hook running
`scripts/refresh-worktree.sh` — active only on linked worktrees, it
auto-rebases onto upstream and reinstalls deps when stale.

## Dependency installation

Dependencies are pre-installed by the orchestrator. Do NOT run `pnpm install`
unless you hit a specific missing-module error; if you must, run it
synchronously (never with `run_in_background`) and never wrap it in sleep or
polling loops.

## File operations

- Read a file before writing it (Claude Code enforces this; writes to unread
  files fail). Use Edit for targeted changes, Write for full rewrites.
- On "exceeds maximum allowed tokens": use Grep for patterns, Read with
  `offset`/`limit` to paginate, and never read auto-generated files whole.
