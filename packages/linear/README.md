# @donmai/plugin-linear

Linear issue tracker integration for [Donmai](https://github.com/RenseiAI/donmai-libraries). Provides the Linear API client, agent sessions, status transitions, activity streaming, and work type routing.

## Installation

```bash
npm install @donmai/plugin-linear
```

## Quick Start

### Linear Client

```typescript
import { createLinearAgentClient } from '@donmai/plugin-linear'

const client = createLinearAgentClient({ apiKey: process.env.LINEAR_API_KEY! })

const issue = await client.getIssue('PROJ-123')
await client.updateIssueStatus('PROJ-123', 'Started')
await client.createComment(issue.id, 'Work in progress...')
```

### Agent Sessions

Manage the lifecycle of an agent working on an issue:

```typescript
import { createAgentSession } from '@donmai/plugin-linear'

const session = createAgentSession({
  client: linearClient,
  issueId: 'issue-uuid',
  autoTransition: true,
  workType: 'development',
})

await session.start()                              // Status -> Started
await session.emitThought('Analyzing requirements...')
await session.updatePlan([
  { title: 'Read code', state: 'completed' },
  { title: 'Implement feature', state: 'inProgress' },
  { title: 'Write tests', state: 'pending' },
])
await session.complete('Feature implemented')      // Status -> Finished
```

### Work Type Routing

Issues are automatically routed to work types based on their Linear status:

| Status | Work Type | Agent Role |
|--------|-----------|------------|
| Backlog | `development` | Implement the feature/fix |
| Started | `inflight` | Continue in-progress work |
| Finished | `qa` | Validate implementation |
| Delivered | `acceptance` | Final acceptance testing |
| Rejected | `refinement` | Address feedback |

### Default Prompt Templates

Sensible defaults for new projects — override per work type as needed:

```typescript
import {
  defaultGeneratePrompt,
  defaultDetectWorkTypeFromPrompt,
  defaultGetPriority,
} from '@donmai/plugin-linear'
```

## Key Exports

- `LinearAgentClient` / `createLinearAgentClient` — Linear API client with retry logic
- `AgentSession` / `createAgentSession` — agent lifecycle management
- `defaultGeneratePrompt` — default prompt generation
- `defaultDetectWorkTypeFromPrompt` — work type detection from free text
- `defaultGetPriority` — priority mapping for work types
- Work type constants, error types, webhook event types

## Related Packages

| Package | Description |
|---------|-------------|
| [@donmai/core](https://www.npmjs.com/package/@donmai/core) | Core orchestrator |
| [@donmai/nextjs](https://www.npmjs.com/package/@donmai/nextjs) | Next.js webhook server |

## License

MIT
