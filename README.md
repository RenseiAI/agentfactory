> **AgentFactory became Donmai.** The runtime that powered AgentFactory now ships as [Donmai](https://github.com/RenseiAI/donmai), a Go binary with a persistent daemon, durable execution graph, and MCP-native tooling. If you arrived here from a github.com/RenseiAI/agentfactory link, the canonical project is at [github.com/RenseiAI/donmai](https://github.com/RenseiAI/donmai); docs and install instructions are at [donmai.dev](https://donmai.dev).
>
> **Deprecation notice:** The `@donmai/*` npm packages in this repository are deprecated as of 2026-06-11. No further versions will be published. The capabilities they exposed are now part of the `donmai` binary directly.

# Donmai

[![npm version](https://img.shields.io/npm/v/@donmai/core)](https://www.npmjs.com/package/@donmai/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Linear](https://img.shields.io/badge/Linear-Integrated-5E6AD2?logo=linear)](https://linear.app)
[![Built with Donmai](https://raw.githubusercontent.com/RenseiAI/donmai-libraries/main/docs/assets/badge-built-with-dark.svg)](https://github.com/RenseiAI/donmai-libraries)

**The open-source coding-agent fleet runtime. Multi-agent fleet management for coding agents.**

Donmai turns your issue backlog into shipped code. It orchestrates a fleet of coding agents (Claude, Codex, Spring AI, or any A2A-compatible agent) through an automated pipeline: development, QA, and acceptance, like an assembly line for software.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| **[@donmai/core](./packages/core)** | `@donmai/core` | Core orchestrator, provider abstraction, crash recovery |
| **[@donmai/plugin-linear](./packages/linear)** | `@donmai/plugin-linear` | Linear issue tracker integration |
| **[@donmai/server](./packages/server)** | `@donmai/server` | Redis work queue, session storage, worker pool |
| **[@donmai/cli](./packages/cli)** | `@donmai/cli` | CLI tools: orchestrator, workers, Linear CLI (`af-linear`) |
| **[@donmai/nextjs](./packages/nextjs)** | `@donmai/nextjs` | Next.js route handlers, webhook processor, middleware |
| **[@donmai/dashboard](./packages/dashboard)** | `@donmai/dashboard` | Fleet management dashboard UI |
| **[@donmai/mcp-server](./packages/mcp-server)** | `@donmai/mcp-server` | MCP server exposing fleet capabilities to external clients |
| **[@donmai/code-intelligence](./packages/code-intelligence)** | `@donmai/code-intelligence` | Tree-sitter AST parsing, BM25 search, incremental indexing |
| **[@donmai/create-app](./packages/create-app)** | `@donmai/create-app` | Project scaffolding tool |

## Quick Start

### One-click deploy (fastest)

Deploy the dashboard with a single click — no local setup required:

| Platform | Deploy | Redis |
|----------|--------|-------|
| **Vercel** | [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FRenseiAI%2Fdonmai-libraries%2Ftree%2Fmain%2Ftemplates%2Fdashboard&project-name=donmai-dashboard&env=LINEAR_ACCESS_TOKEN,LINEAR_WEBHOOK_SECRET,REDIS_URL&envDescription=Environment%20variables%20needed%20for%20Donmai%20Dashboard&envLink=https%3A%2F%2Fgithub.com%2FRenseiAI%2Fdonmai-libraries%2Ftree%2Fmain%2Ftemplates%2Fdashboard%23environment-variables) | Add [Vercel KV](https://vercel.com/docs/storage/vercel-kv) or [Upstash](https://upstash.com/) after deploy |
| **Railway** | [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/A7hIuF?referralCode=MwgIWL) | Bundled automatically |

> See the [dashboard template](https://github.com/RenseiAI/donmai-libraries/tree/main/templates/dashboard) for full setup instructions.

### Create a new project (recommended for customization)

```bash
npx @donmai/create-app my-agent

cd my-agent
cp .env.example .env.local    # Fill in LINEAR_ACCESS_TOKEN
pnpm install && pnpm dev      # Start webhook server
pnpm worker                   # Start local worker (in another terminal)
```

### Webhook Server (Next.js)

For production use, Donmai provides a webhook server that receives Linear events and dispatches agents:

```typescript
// src/lib/config.ts
import { createAllRoutes, createDefaultLinearClientResolver } from '@donmai/nextjs'

export const routes = createAllRoutes({
  linearClient: createDefaultLinearClientResolver(),
})
```

```typescript
// src/app/webhook/route.ts
import { routes } from '@/lib/config'
export const POST = routes.webhook.POST
export const GET = routes.webhook.GET
```

### Spawn an agent on a single issue

```typescript
import { createOrchestrator } from '@donmai/core'

const orchestrator = createOrchestrator({
  maxConcurrent: 3,
  // Default: '../{repoName}.wt/' (sibling directory)
})

// Process a single issue
await orchestrator.spawnAgentForIssue('PROJ-123')
await orchestrator.waitForAll()
```

### Process your entire backlog

```typescript
const orchestrator = createOrchestrator({
  project: 'MyProject',
  maxConcurrent: 3,
})

const result = await orchestrator.run()
console.log(`Spawned ${result.agents.length} agents`)

await orchestrator.waitForAll()
```

### Use the CLI

```bash
# Process backlog issues from a project
npx af-orchestrator --project MyProject --max 3

# Process a single issue
npx af-orchestrator --single PROJ-123

# Preview what would be processed
npx af-orchestrator --project MyProject --dry-run
```

### Linear CLI

The TypeScript `af-linear` binary has been replaced by a Go port. On the Rensei platform use `rensei linear`; in OSS environments (agentfactory-tui only) use `af linear`. Both expose the same subcommand surface and authenticate through the active rensei session (or `LINEAR_API_KEY` env var).

```bash
# Get issue details
rensei linear get-issue PROJ-123

# List backlog issues for a project
rensei linear list-backlog-issues --project "MyProject"

# Update issue status
rensei linear update-issue PROJ-123 --state "Finished"

# Create a comment
rensei linear create-comment PROJ-123 --body "Work complete"
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Orchestrator                     │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐   │
│  │  Agent 1   │  │  Agent 2   │  │  Agent 3   │   │
│  │ (Claude)   │  │ (Codex)    │  │ (Claude)   │   │
│  │ DEV: #123  │  │ QA: #120   │  │ DEV: #125  │   │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘   │
│        │              │              │           │
│  ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐   │
│  │ Worktree   │  │ Worktree   │  │ Worktree   │   │
│  │ repo.wt/   │  │ repo.wt/   │  │ repo.wt/   │   │
│  │  #123      │  │  #120      │  │  #125      │   │
│  └───────────┘  └───────────┘  └───────────┘   │
└─────────────────────────────────────────────────┘
         │                    │
    ┌────┴────┐         ┌────┴────┐
    │ Linear  │         │  Git    │
    │  API    │         │  Repo   │
    └─────────┘         └─────────┘
```

### Provider Abstraction

Donmai supports multiple coding agent providers through a unified interface:

```typescript
interface AgentProvider {
  readonly name: 'claude' | 'codex' | 'amp' | 'spring-ai' | 'a2a'
  spawn(config: AgentSpawnConfig): AgentHandle
  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle
}

interface AgentHandle {
  sessionId: string | null
  stream: AsyncIterable<AgentEvent>
  injectMessage(text: string): Promise<void>
  stop(): Promise<void>
}
```

Spring AI support means enterprise Java teams can orchestrate Spring AI-based agents in the same fleet as Claude and Codex agents, with the same pipeline, governance, and cost tracking.

Provider is selected via a 9-tier resolution cascade — issue labels, mentions, config file, environment variables, and a hardcoded fallback:

```bash
AGENT_PROVIDER=claude            # Global default
AGENT_PROVIDER_QA=codex          # Per-work-type override
AGENT_PROVIDER_SOCIAL=spring-ai  # Per-project override
```

You can also select providers dynamically:
- **Issue labels:** Add `provider:codex` to a Linear issue
- **Mentions:** Include "use codex" or "@codex" in the agent prompt
- **Config file:** Set `providers.byWorkType` or `providers.byProject` in `.donmai/config.yaml`

### Intelligent Routing (MAB)

When multiple providers are available, Donmai can learn which provider works best for each work type using Thompson Sampling (Multi-Armed Bandit):

```yaml
# .donmai/config.yaml
routing:
  enabled: true
  explorationRate: 0.1          # 10% exploration
  windowSize: 100               # Observation window
  discountFactor: 0.99          # Discount older observations
  minObservationsForExploit: 5  # Min data before exploiting
```

The routing engine tracks task completion, PR creation, QA pass rates, cost, and wall-clock time per (provider, workType) pair. It builds Beta distribution posteriors and samples to balance exploration vs. exploitation. MAB routing slots in at tier 5 of the resolution cascade — after explicit human overrides and config, before env var fallbacks.

### Agent-to-Agent Protocol (A2A)

Donmai implements the [A2A protocol](https://a2a-protocol.org) (v0.3.0), operating as both client and server.

- **Client mode:** Invoke remote A2A agents (Spring AI or any A2A-compliant agent) as part of an orchestrated fleet. Route specific work types to external agents via environment config.
- **Server mode:** Expose fleet capabilities via `/.well-known/agent-card.json` discovery and JSON-RPC task submission. Any A2A-aware tool can submit work to the fleet.

This enables mixed fleets across languages, frameworks, and infrastructure with no coupling.

### MCP Server

Fleet capabilities are exposed as an [MCP server](https://modelcontextprotocol.io). Any MCP-aware client (Claude Desktop, Spring AI apps, IDE agents) can interact with the fleet.

**Tools:**

| Tool | Description |
|------|-------------|
| `submit-task` | Submit a new task to the fleet |
| `get-task-status` | Check status of a running task |
| `list-fleet` | List active agents and their assignments |
| `get-cost-report` | Retrieve cost tracking data |
| `stop-agent` | Stop a running agent |
| `forward-prompt` | Send a prompt to a specific agent |

**Resources:**

| URI | Description |
|-----|-------------|
| `fleet://agents` | Current fleet state |
| `fleet://issues/{id}` | Issue progress details |
| `fleet://logs/{id}` | Agent execution logs |

Transport: Streamable HTTP for remote access, STDIO for local CLI.

### Spring AI Bench

Donmai agents can be evaluated through [Spring AI Bench](https://github.com/spring-ai-community/spring-ai-bench). The multi-agent pipeline (dev, QA, acceptance) improves benchmark reliability over single-agent runs.

### Work Types

Issues flow through work stations based on their status:

| Status | Work Type | Agent Role |
|--------|-----------|------------|
| — | `research` | Discovery and analysis phase |
| — | `backlog-creation` | Create issues from research findings |
| Backlog | `development` | Implement the feature/fix |
| Started | `inflight` | Continue in-progress work |
| Finished | `qa` | Validate implementation |
| Delivered | `acceptance` | Final acceptance testing |
| Rejected | `refinement` | Address feedback |
| — | `merge` | Handle PR merge operations |
| — | `security` | Security scanning (SAST, dependency audit) |

**Coordination types** (for parent issues with sub-issues):

| Work Type | Agent Role |
|-----------|------------|
| `coordination` | Orchestrate parallel sub-issue development |
| `inflight-coordination` | Coordinate in-flight sub-issues |
| `qa-coordination` | Run QA across all sub-issues |
| `acceptance-coordination` | Validate and merge all sub-issues |
| `refinement-coordination` | Coordinate refinement of sub-issues |

### Crash Recovery

Donmai includes built-in crash recovery:

1. **Heartbeat monitoring** — agents send periodic health signals
2. **State persistence** — session state saved to `.agent/` directory
3. **Automatic resume** — crashed agents are detected and restarted
4. **Recovery limits** — configurable max recovery attempts

### Inactivity Timeout

Agents are monitored for inactivity:

```typescript
const orchestrator = createOrchestrator({
  inactivityTimeoutMs: 300000,    // 5 minutes default
  maxSessionTimeoutMs: 7200000,   // 2 hour hard cap
  workTypeTimeouts: {
    qa: { inactivityTimeoutMs: 600000 },  // QA gets 10 min
  },
})
```

### Merge Queue

Donmai includes a built-in merge queue that automatically rebases and merges agent PRs:

```yaml
# .donmai/config.yaml
mergeQueue:
  enabled: true
  provider: local           # local, github-native, mergify, trunk
  strategy: rebase          # rebase, merge, squash
  autoMerge: true           # Auto-add approved PRs
  testCommand: "pnpm test"  # Run after rebase
  mergiraf: true            # Syntax-aware conflict resolution
  concurrency: 2            # Parallel merge operations (default: 1)
  escalation:
    onConflict: reassign    # reassign, notify, park
    onTestFailure: notify   # notify, park, retry
```

The local provider handles the full rebase-test-merge cycle within the orchestrator. External providers (GitHub-native, Mergify, Trunk) delegate to their respective services. The merge queue CLI (`af-merge-queue`) provides status, list, retry, skip, pause, and resume commands.

### Code Intelligence

The `@donmai/code-intelligence` package provides 6 core tools for codebase navigation (plus 3 optional file reservation tools for parallel agent safety):

| Tool | Description |
|------|-------------|
| `af_code_search_code` | Full-text search with BM25 ranking |
| `af_code_search_symbols` | Find functions, classes, interfaces by name |
| `af_code_get_repo_map` | PageRank-based repository overview |
| `af_code_find_type_usages` | Find all usages of a type (switch cases, mappings, imports) |
| `af_code_validate_cross_deps` | Validate cross-package dependencies |
| `af_code_check_duplicate` | Detect duplicate or near-duplicate code |

These tools are available as in-process MCP tools (Claude provider) or via the `af-code` CLI. They support TypeScript, JavaScript, Python, Go, and Rust. See [Code Intelligence](./docs/code-intelligence.md) for details.

### Quality Gates

Quality gates prevent regressions by capturing metrics before agents start and verifying them after:

```yaml
quality:
  baselineEnabled: true     # Capture test counts, typecheck/lint errors from main
  ratchetEnabled: true      # Block PRs that regress metrics
  boyscoutRule: true        # Instruct agents to leave code better than found
  tddWorkflow: true         # Include TDD workflow in agent prompts
```

See [Quality Gates](./docs/quality-gates.md) for baseline capture, ratchet enforcement, and CI integration.

### Workflow Governor Top-of-Funnel

The Workflow Governor supports automated top-of-funnel phases before development begins:

- **Research** — agents analyze requirements, explore the codebase, and produce findings
- **Backlog creation** — agents transform research findings into structured Linear issues with acceptance criteria

These phases are triggered by the governor's workflow strategy. The governor checks `isResearchCompleted()` and `isBacklogCreationCompleted()` before dispatching development work, ensuring issues are well-defined before agents start coding.

## Distributed Workers

For teams that need horizontal scaling, Donmai supports a distributed worker pool:

```
┌────────────────┐     ┌─────────┐     ┌────────────────┐
│  Webhook Server │────▶│  Redis  │◀────│  Worker Node 1  │
│  (receives      │     │  Queue  │     │  (claims work)  │
│   issues)       │     │         │     └────────────────┘
└────────────────┘     │         │     ┌────────────────┐
                       │         │◀────│  Worker Node 2  │
                       │         │     │  (claims work)  │
                       └─────────┘     └────────────────┘
```

This requires the `@donmai/server` package and a Redis instance.

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_ACCESS_TOKEN` | Yes | Linear API key (used by Next.js webhook server) |
| `LINEAR_API_KEY` | Yes | Linear API key (used by CLI tools) |
| `AGENT_PROVIDER` | No | Default provider: `claude`, `codex`, `amp`, `spring-ai`, `a2a` (default: `claude`) |
| `LINEAR_TEAM_ID` | No | Linear team UUID |
| `REDIS_URL` | For distributed | Redis connection URL |

> **Note:** Set both `LINEAR_ACCESS_TOKEN` and `LINEAR_API_KEY` to the same value, or see [Configuration](./docs/configuration.md) for details.

### Repository Config (`.donmai/config.yaml`)

Declarative configuration for repository-level settings:

```yaml
apiVersion: v1
kind: RepositoryConfig
repository: github.com/yourorg/yourrepo

projectPaths:
  MyProject: "."
  Backend:
    path: "apps/api"
    packageManager: npm
    testCommand: "npm test"

providers:
  default: claude
  byWorkType: { qa: codex }

routing:
  enabled: true

mergeQueue:
  enabled: true
  provider: local

quality:
  baselineEnabled: true
  ratchetEnabled: true
```

See [Configuration](./docs/configuration.md) for the full reference.

### Orchestrator Config

```typescript
interface OrchestratorConfig {
  provider?: AgentProvider           // Agent provider instance
  maxConcurrent?: number             // Max concurrent agents (default: 3)
  project?: string                   // Project name filter
  worktreePath?: string              // Git worktree base path (default: '../{repoName}.wt/')
  linearApiKey?: string              // Linear API key
  autoTransition?: boolean           // Auto-update issue status (default: true)
  sandboxEnabled?: boolean           // Enable agent sandboxing (default: false)
  inactivityTimeoutMs?: number       // Inactivity timeout (default: 300000)
  maxSessionTimeoutMs?: number       // Hard session cap
  workTypeTimeouts?: Record<string, WorkTypeTimeoutConfig>
}
```

## Linear Integration

The `@donmai/plugin-linear` package provides:

- **Agent sessions** — lifecycle management with status transitions
- **Activity streaming** — thoughts, actions, and responses visible in Linear
- **Plan tracking** — task checklists with progress states
- **Work routing** — automatic work type detection from issue status
- **Sub-issue coordination** — dependency-aware parallel execution

```typescript
import { createLinearAgentClient, createAgentSession } from '@donmai/plugin-linear'

const client = createLinearAgentClient({ apiKey: process.env.LINEAR_API_KEY! })
const session = createAgentSession({
  client: client.linearClient,
  issueId: 'issue-uuid',
  autoTransition: true,
  workType: 'development',
})

await session.start()
await session.emitThought('Analyzing requirements...')
await session.complete('Feature implemented with tests')
```

### Setting Up Linear

**1. Create a Linear API Key**

Go to [Linear Settings > API](https://linear.app/settings/api) and create a **Personal API Key** (starts with `lin_api_`).

**2. Configure the Webhook**

In Linear Settings > API > Webhooks, create a webhook:

- **URL:** `https://your-app.example.com/webhook`
- **Events to subscribe:** `AgentSession` (created, updated, prompted) and `Issue` (updated)
- Copy the **Signing Secret** — this is your `LINEAR_WEBHOOK_SECRET`

The webhook signature is verified using HMAC-SHA256 via the `linear-signature` header. Verification is enforced in production and optional in development.

**3. Set Environment Variables**

| Variable | Required | Description |
|----------|----------|-------------|
| `LINEAR_ACCESS_TOKEN` | Yes | API key for the Next.js webhook server |
| `LINEAR_API_KEY` | Yes | API key for CLI tools (can be the same value as above) |
| `LINEAR_WEBHOOK_SECRET` | Production | Signing secret from your Linear webhook |
| `LINEAR_CLIENT_ID` | No | OAuth app client ID (multi-workspace only) |
| `LINEAR_CLIENT_SECRET` | No | OAuth app client secret (multi-workspace only) |
| `NEXT_PUBLIC_APP_URL` | No | App URL for OAuth redirects (default: `http://localhost:3000`) |
| `REDIS_URL` | Distributed mode | Redis connection URL for worker pool and OAuth token storage |

> **Tip:** `LINEAR_ACCESS_TOKEN` and `LINEAR_API_KEY` can be the same key. The server uses `LINEAR_ACCESS_TOKEN`; CLI tools use `LINEAR_API_KEY`.

For the full environment variable reference and OAuth setup, see the [Getting Started guide](./docs/getting-started.md) and [Configuration reference](./docs/configuration.md).

## Agent Definitions

Agent definitions tell coding agents how to behave at each stage of the pipeline. See [examples/agent-definitions](./examples/agent-definitions) for ready-to-use templates:

| Definition | Stage | What it does |
|-----------|-------|-------------|
| [developer.md](./examples/agent-definitions/developer.md) | Development | Implements features, fixes bugs, creates PRs |
| [qa-reviewer.md](./examples/agent-definitions/qa-reviewer.md) | QA | Validates implementation, runs tests |
| [coordinator.md](./examples/agent-definitions/coordinator.md) | Coordination | Orchestrates parallel sub-issues |
| [acceptance-handler.md](./examples/agent-definitions/acceptance-handler.md) | Acceptance | Validates, merges PRs, cleans up |
| [backlog-writer.md](./examples/agent-definitions/backlog-writer.md) | Planning | Transforms plans into Linear issues |

Place your definitions in `.claude/agents/` at the root of your repository. Customize them for your stack — add your test commands, framework patterns, and deployment checks.

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run type checking
pnpm typecheck

# Run tests
pnpm test
```

## Built with Donmai

Donmai powers real products in production:

| Project                                                | What it does                              |
|--------------------------------------------------------|-------------------------------------------|
| [Supaku Family](https://family.supaku.com)             | Privacy focused Personal CRM              |
| [Recoil Engine](https://github.com/supaku/RecoilEngine)| Adding Mac Metal support to BAR           |

Building with Donmai? Add the badge to your project and [share it in Discussions](https://github.com/RenseiAI/donmai-libraries/discussions).

## Badge

If you're building with Donmai, add the badge to your README:

<!-- Dark badge (default) -->
[![Built with Donmai](https://raw.githubusercontent.com/RenseiAI/donmai-libraries/main/docs/assets/badge-built-with.svg)](https://github.com/RenseiAI/donmai-libraries)

<!-- Light badge (for dark READMEs) -->
[![Built with Donmai](https://raw.githubusercontent.com/RenseiAI/donmai-libraries/main/docs/assets/badge-built-with-light.svg)](https://github.com/RenseiAI/donmai-libraries)

Or use HTML for GitHub theme-switching (auto light/dark):

```html
<a href="https://github.com/RenseiAI/donmai-libraries">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/RenseiAI/donmai-libraries/main/docs/assets/badge-built-with-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/RenseiAI/donmai-libraries/main/docs/assets/badge-built-with-light.svg">
    <img alt="Built with Donmai" src="https://raw.githubusercontent.com/RenseiAI/donmai-libraries/main/docs/assets/badge-built-with.svg">
  </picture>
</a>
```

## Migrating from the legacy Node CLI

If you are upgrading from `@donmai/cli` (the Node/TypeScript binaries), see the [migration guide](./docs/migration-from-legacy-cli.md) for:

- A full table mapping each legacy binary (`af-orchestrator`, `af-linear`, `af-analyze-logs`, `af-cleanup`, `af-queue-admin`, `af-merge-queue`, `af-code`, `af-arch`, and more) to its Go `af` equivalent
- Side-by-side flag comparisons for the most-used commands
- Per-binary deprecation notice templates for your CHANGELOG
- The difference between `af` (single-user OSS) and `rensei` (platform-aware)

## License

MIT - see [LICENSE](./LICENSE)

---

Built by [Rensei AI](https://rensei.ai)
