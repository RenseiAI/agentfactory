# Linear CLI — the only sanctioned Linear surface

Routed from `AGENTS.md`. **Use the `linear` CLI subcommand for ALL Linear
operations. Do NOT use Linear MCP tools.**

The OSS Go binary ships the surface as `donmai linear …`; downstream
commercial binaries expose the identical subcommand surface under their own
name (the same subcommands, flags, and JSON-on-stdout contract — use whichever
binary is in PATH). The connected tracker credential is wired automatically;
agents never handle raw Linear API keys.

**Agents do not get interactive defaults:** seed the environment with the
explicit values you need — `LINEAR_TEAM_NAME` for `create-issue` — and pass
per-invocation flags (`--team`, `--project`, `--state`, `--labels`) yourself.

**Tool plugins (Claude provider only):** agents run via the orchestrator with
the Claude provider receive typed `af_linear_*` in-process MCP tools (e.g.
`af_linear_get_issue`, `af_linear_create_comment`) that call the same
`runLinear()` function — same behavior, no subprocess overhead. Other
providers and humans use the CLI below. See `docs/providers.md`.

## Commands

```bash
# Issue operations
donmai linear get-issue <id>
donmai linear create-issue --title "Title" --team "TeamName" [--description "..."] [--project "..."] [--labels "Label1,Label2"] [--state "Backlog"] [--parentId "..."]
donmai linear update-issue <id> [--title "..."] [--description "..."] [--state "..."] [--labels "..."] [--parentId "..."]

# Comments
donmai linear list-comments <issue-id>
donmai linear create-comment <issue-id> --body "Comment text"

# File-based flags (for long content that exceeds CLI arg limits):
# write the content to a temp file, then pass the path
donmai linear update-issue <id> --description-file /tmp/description.md
donmai linear create-issue --title "Title" --team "Team" --description-file /tmp/description.md
donmai linear create-comment <issue-id> --body-file /tmp/comment.md

# Relations
donmai linear add-relation <issue-id> <related-issue-id> --type <related|blocks|duplicate>
donmai linear list-relations <issue-id>
donmai linear remove-relation <relation-id>

# Sub-issues (for coordination)
donmai linear list-sub-issues <parent-issue-id>
donmai linear list-sub-issue-statuses <parent-issue-id>
donmai linear update-sub-issue <id> [--state "Finished"] [--comment "Done"]

# Issue listing (flexible filters)
donmai linear list-issues [--project "..."] [--state "..."] [--label "..."] [--priority 2] [--assignee "me"] [--team "..."] [--limit 50] [--order-by "createdAt"] [--query "search text"]

# Labels
donmai linear list-labels
donmai linear apply-label <issue-id>

# Blocking checks
donmai linear check-blocked <issue-id>
donmai linear list-backlog-issues --project "ProjectName"
donmai linear list-unblocked-backlog --project "ProjectName"

# Deployment
donmai linear check-deployment <pr-number> [--format json|markdown]

# Blocker creation
donmai linear create-blocker <source-issue-id> --title "Title" [--description "..."] [--team "..."] [--project "..."] [--assignee "user@email.com"]
```

## Key rules

- `--team` is REQUIRED for `create-issue` unless the `LINEAR_TEAM_NAME` env
  var is set (the orchestrator sets it automatically).
- Use `--state`, not `--status` (e.g. `--state "Backlog"`).
- Use label NAMES, not UUIDs (e.g. `--labels "Feature"`).
- `--labels` accepts comma-separated values: `--labels "Bug,Feature"`.
- All commands return JSON on stdout — capture the `id` field for subsequent
  operations.
- Use `--parentId` when creating sub-issues so coordinator orchestration can
  track them.
