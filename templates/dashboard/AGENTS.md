# agentfactory-dashboard

AgentFactory-powered project. Uses Linear for issue tracking.
This file is used by OpenAI Codex agents (equivalent to .claude/CLAUDE.md for Claude agents).

## Linear CLI

Use `pnpm af-linear` for ALL Linear operations. All commands return JSON to stdout.

```bash
pnpm af-linear get-issue <id>
pnpm af-linear create-issue --title "Title" --team "YOUR_TEAM" [--description "..."]
pnpm af-linear update-issue <id> [--title "..."] [--description "..."] [--state "..."]
pnpm af-linear create-comment <issue-id> --body "Comment text"
```

### Key Rules

- `--team` is always required for `create-issue`
- Use `--state` not `--status`
- Use label names not UUIDs
- All commands return JSON to stdout

## Build & Test

```bash
pnpm dev          # Start dev server
pnpm build        # Production build
pnpm typecheck    # Type-check
pnpm test         # Run tests
```
