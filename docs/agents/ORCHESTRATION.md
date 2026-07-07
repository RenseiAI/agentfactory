# Orchestrator, repository scoping, and route sync

Routed from `AGENTS.md`. How the orchestrator is invoked, how
`.donmai/config.yaml` scopes it, and how deployment repos sync routes after
package bumps.

## Orchestrator usage

```bash
pnpm af-orchestrator --project ProjectName              # process backlog issues
pnpm af-orchestrator --single ISSUE-123                 # process a single issue
pnpm af-orchestrator --project ProjectName --dry-run    # preview, no execution
pnpm af-orchestrator --project ProjectName --max 2      # custom concurrency
pnpm af-orchestrator --project ProjectName --repo github.com/RenseiAI/donmai-libraries
pnpm af-orchestrator --project MyProject --templates /path/to/templates
```

Prompts come from the workflow-template system (`docs/templates.md`; built-in
defaults in `packages/core/src/templates/defaults/`, overridable per project
via `.donmai/templates/`).

## Repository-scoped orchestration — `.donmai/config.yaml`

Checked into each repository to define allowed projects and repository
identity (`kind: RepositoryConfig`):

```yaml
# Single-project repo
apiVersion: v1
kind: RepositoryConfig
repository: github.com/RenseiAI/donmai-libraries
allowedProjects:
  - Agent

# Monorepo with path scoping
apiVersion: v1
kind: RepositoryConfig
repository: github.com/example/monorepo
projectPaths:
  Social: apps/social                    # string shorthand (Node.js default)
  Family iOS:                            # object form with per-project overrides
    path: apps/family-ios
    packageManager: none
    buildCommand: "make build"
    testCommand: "make test"
    validateCommand: "make build"
sharedPaths:
  - packages/ui
```

- `repository`: git remote URL pattern, validated at startup against
  `git remote get-url origin`.
- `allowedProjects`: only issues from these Linear projects are processed.
- `projectPaths`: maps project names to a root directory (string shorthand) or
  a full config object `{ path, packageManager?, buildCommand?, testCommand?,
  validateCommand? }`. Mutually exclusive with `allowedProjects`; when set,
  allowed projects derive from the keys. Per-project overrides beat repo-wide
  defaults.
- `sharedPaths`: directories any project's agent may modify (only used with
  `projectPaths`).

### Validation layers

1. `OrchestratorConfig.repository` — validates the git remote at constructor
   time and before spawning agents.
2. CLI `--repo` flag — passes the repository from the command line.
3. `.donmai/config.yaml` — auto-loaded at startup; filters issues by
   `allowedProjects` or `projectPaths` keys.
4. Template partial `{{> partials/repo-validation}}` — agents verify the git
   remote before any push.
5. Template partial `{{> partials/path-scoping}}` — agents verify file changes
   stay within project scope.
6. Linear project metadata — cross-references the project repo link with the
   config.

## Route sync (deployment repos)

After upgrading published packages, a consuming deployment's `src/app/` may
lack newly added routes. `af-sync-routes` generates missing route files from
the manifest:

```bash
pnpm af-sync-routes --dry-run   # preview what would be created
pnpm af-sync-routes             # create missing API route files
pnpm af-sync-routes --pages     # also sync dashboard page files
```

- Never overwrites existing files.
- Pages are opt-in via `--pages` (API routes sync by default).
- Use `--app-dir <path>` for a non-standard app directory.
