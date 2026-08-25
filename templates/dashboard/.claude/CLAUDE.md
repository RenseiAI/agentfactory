# agentfactory-dashboard

AgentFactory-powered project. Uses Linear for issue tracking.

## Linear CLI

Use `pnpm af-linear` (or `af-linear`) for ALL Linear operations. All commands return JSON to stdout.

```bash
# Issue operations
pnpm af-linear get-issue <id>
pnpm af-linear create-issue --title "Title" --team "YOUR_TEAM" [--description "..."] [--project "..."] [--labels "Label1,Label2"] [--state "Backlog"] [--parentId "..."]
pnpm af-linear update-issue <id> [--title "..."] [--description "..."] [--state "..."] [--labels "..."]

# Comments
pnpm af-linear list-comments <issue-id>
pnpm af-linear create-comment <issue-id> --body "Comment text"

# Relations
pnpm af-linear add-relation <issue-id> <related-issue-id> --type <related|blocks|duplicate>
pnpm af-linear list-relations <issue-id>
pnpm af-linear remove-relation <relation-id>

# Sub-issues
pnpm af-linear list-sub-issues <parent-issue-id>
pnpm af-linear list-sub-issue-statuses <parent-issue-id>
pnpm af-linear update-sub-issue <id> [--state "Finished"] [--comment "Done"]

# Backlog
pnpm af-linear check-blocked <issue-id>
pnpm af-linear list-backlog-issues --project "ProjectName"
pnpm af-linear list-unblocked-backlog --project "ProjectName"

# Deployment
pnpm af-linear check-deployment <pr-number> [--format json|markdown]
```

### Key Rules

- `--team` is always required for `create-issue`
- Use `--state` not `--status`
- Use label names not UUIDs
- `--labels` accepts comma-separated values
- All commands return JSON to stdout

## Environment

Requires `LINEAR_API_KEY` or `LINEAR_ACCESS_TOKEN` in `.env.local`.

## Build & Test

```bash
pnpm dev          # Start dev server
pnpm build        # Production build
pnpm typecheck    # Type-check
pnpm test         # Run tests
```
