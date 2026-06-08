# @donmai/cli

CLI tools for [Donmai](https://github.com/RenseiAI/donmai-libraries). Run a local orchestrator, remote workers, worker fleets, and queue management.

## Deprecations

- **`af-arch`** — Deprecated in favour of the native Go `donmai arch` command.
  The shim still works and emits a runtime deprecation notice on stderr; it will
  be removed in a future release. Use `donmai arch assess <pr-url>` instead —
  the `assess` subcommand, all flags, and the JSON output are preserved. See
  [`docs/migration-from-legacy-cli.md`](../../docs/migration-from-legacy-cli.md)
  for the full legacy-binary mapping.

## Installation

```bash
# Global (CLI commands)
npm install -g @donmai/cli

# Local (programmatic runner functions)
npm install @donmai/cli
```

## CLI Commands

```bash
# Spawn agents on backlog issues
af-orchestrator --project MyProject --max 3

# Process a single issue
af-orchestrator --single PROJ-123

# Dry run — preview what would be processed
af-orchestrator --project MyProject --dry-run

# Start the Workflow Governor (event-driven + poll sweep)
af-governor --project MyProject --project OtherProject

# Governor: single scan and exit (for cron jobs)
af-governor --project MyProject --once

# Governor: poll-only mode (no event bus)
af-governor --project MyProject --mode poll-only

# Start a remote worker
af-worker --api-url https://your-app.vercel.app --api-key your-key

# Start a worker fleet (auto-detects CPU cores)
af-worker-fleet --api-url https://your-app.vercel.app --api-key your-key

# Clean up orphaned git worktrees
af-cleanup

# Queue management
af-queue-admin list
af-queue-admin drain

# Analyze agent session logs
af-analyze-logs --follow
```

### Governor

The Workflow Governor scans projects and decides what work to dispatch based on issue status, active sessions, cooldowns, and human overrides.

**Modes:**
- `event-driven` (default) — Listens to a GovernorEventBus for real-time webhook events, with a periodic poll sweep as safety net
- `poll-only` — Periodic scan loop only

**Options:**
```
--project <name>            Project to scan (repeatable)
--scan-interval <ms>        Poll interval (default: 60000 for poll-only, 300000 for event-driven)
--max-dispatches <n>        Max concurrent dispatches per scan (default: 3)
--mode <mode>               poll-only or event-driven (default: event-driven)
--once                      Single scan pass and exit
--no-auto-research          Disable Icebox → research
--no-auto-backlog-creation  Disable Icebox → backlog-creation
--no-auto-development       Disable Backlog → development
--no-auto-qa                Disable Finished → QA
--no-auto-acceptance        Disable Delivered → acceptance
```

When `LINEAR_API_KEY` and `REDIS_URL` are set, the governor uses real dependencies (Linear SDK + Redis). Without them, it falls back to stub dependencies for testing.

## Programmatic Usage

All CLI tools are available as importable functions via subpath exports:

```typescript
import { runOrchestrator } from '@donmai/cli/orchestrator'

await runOrchestrator({
  project: 'MyProject',
  max: 3,
  dryRun: false,
})
```

### Available Runner Functions

```typescript
import { runOrchestrator } from '@donmai/cli/orchestrator'
import { runWorker } from '@donmai/cli/worker'
import { runWorkerFleet } from '@donmai/cli/worker-fleet'
import { runCleanup } from '@donmai/cli/cleanup'
import { runQueueAdmin } from '@donmai/cli/queue-admin'
import { runLogAnalyzer } from '@donmai/cli/analyze-logs'
```

Each function accepts a config object and returns a Promise — use them to build thin wrappers with your own env loading and argument parsing.

## Environment Variables

| Variable | Used By | Description |
|----------|---------|-------------|
| `LINEAR_API_KEY` | orchestrator, governor | Linear API key |
| `REDIS_URL` | governor, queue-admin | Redis connection URL |
| `WORKER_API_URL` | worker, fleet | Webhook server URL |
| `WORKER_API_KEY` | worker, fleet | API key for authentication |

## Related Packages

| Package | Description |
|---------|-------------|
| [@donmai/core](https://www.npmjs.com/package/@donmai/core) | Core orchestrator |
| [@donmai/server](https://www.npmjs.com/package/@donmai/server) | Redis work queue |
| [@donmai/nextjs](https://www.npmjs.com/package/@donmai/nextjs) | Next.js webhook server |

## License

MIT
