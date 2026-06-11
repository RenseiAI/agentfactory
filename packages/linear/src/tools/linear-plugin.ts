/**
 * Linear Tool Plugin
 *
 * Exposes all Linear CLI commands as typed, in-process agent tools.
 * Agents call these directly instead of shelling out to `pnpm af-linear`.
 *
 * Moved from packages/core/src/tools/plugins/linear.ts to keep
 * Linear-specific tool code in the Linear package.
 */

import { z } from 'zod'
import { tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { runLinear } from './linear-runner.js'

// ---------------------------------------------------------------------------
// Tool plugin types (structurally identical to @donmai/core)
// Defined locally to avoid compile-time dependency on core.
// ---------------------------------------------------------------------------

/** A plugin that contributes agent tools from CLI functionality */
export interface ToolPlugin {
  name: string
  description: string
  createTools(context: ToolPluginContext): SdkMcpToolDefinition<any>[]
}

/** Context passed to plugins during tool creation */
export interface ToolPluginContext {
  env: Record<string, string>
  cwd: string
}

function makeTools(apiKey?: string, teamName?: string, proxyUrl?: string, proxyAuthToken?: string): SdkMcpToolDefinition<any>[] {
  async function run(command: string, args: Record<string, string | string[] | boolean> = {}, positionalArgs: string[] = []) {
    try {
      const result = await runLinear({ command, args, positionalArgs, apiKey, proxyUrl, proxyAuthToken })
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.output, null, 2) }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      }
    }
  }

  return [
    tool(
      'af_linear_get_issue',
      'Get a Linear issue by ID or identifier',
      { issue_id: z.string().describe('Issue ID or identifier (e.g., ABC-123)') },
      async (args) => run('get-issue', {}, [args.issue_id])
    ),

    tool(
      'af_linear_create_issue',
      'Create a new Linear issue',
      {
        title: z.string().describe('Issue title'),
        team: z.string().optional().describe('Team name (defaults to LINEAR_TEAM_NAME env var)'),
        description: z.string().optional().describe('Issue description (markdown)'),
        project: z.string().optional().describe('Project name'),
        labels: z.array(z.string()).optional().describe('Label names'),
        state: z.string().optional().describe('Initial state (e.g. "Backlog")'),
        parent_id: z.string().optional().describe('Parent issue ID for sub-issues'),
      },
      async (args) => {
        const cliArgs: Record<string, string | string[] | boolean> = {
          title: args.title,
        }
        const team = args.team ?? teamName
        if (team) cliArgs.team = team
        if (args.description) cliArgs.description = args.description
        if (args.project) cliArgs.project = args.project
        if (args.labels) cliArgs.labels = args.labels
        if (args.state) cliArgs.state = args.state
        if (args.parent_id) cliArgs.parentId = args.parent_id
        return run('create-issue', cliArgs)
      }
    ),

    tool(
      'af_linear_update_issue',
      'Update an existing Linear issue',
      {
        issue_id: z.string().describe('Issue ID or identifier'),
        title: z.string().optional().describe('New title'),
        description: z.string().optional().describe('New description (markdown)'),
        state: z.string().optional().describe('New state (e.g. "In Progress", "Done")'),
        labels: z.array(z.string()).optional().describe('Label names to set'),
        parent_id: z.string().optional().describe('Parent issue ID or identifier to reparent under. Pass "null" to remove parent.'),
      },
      async (args) => {
        const cliArgs: Record<string, string | string[] | boolean> = {}
        if (args.title) cliArgs.title = args.title
        if (args.description) cliArgs.description = args.description
        if (args.state) cliArgs.state = args.state
        if (args.labels) cliArgs.labels = args.labels
        if (args.parent_id !== undefined) cliArgs.parentId = args.parent_id
        return run('update-issue', cliArgs, [args.issue_id])
      }
    ),

    tool(
      'af_linear_list_comments',
      'List comments on a Linear issue',
      { issue_id: z.string().describe('Issue ID or identifier') },
      async (args) => run('list-comments', {}, [args.issue_id])
    ),

    tool(
      'af_linear_create_comment',
      'Add a comment to a Linear issue',
      {
        issue_id: z.string().describe('Issue ID or identifier'),
        body: z.string().describe('Comment text (markdown)'),
      },
      async (args) => run('create-comment', { body: args.body }, [args.issue_id])
    ),

    tool(
      'af_linear_add_relation',
      'Add a relation between two Linear issues',
      {
        issue_id: z.string().describe('Source issue ID or identifier'),
        related_issue_id: z.string().describe('Related issue ID or identifier'),
        type: z.enum(['related', 'blocks', 'duplicate']).describe('Relation type'),
      },
      async (args) => run('add-relation', { type: args.type }, [args.issue_id, args.related_issue_id])
    ),

    tool(
      'af_linear_list_relations',
      'List relations for a Linear issue',
      { issue_id: z.string().describe('Issue ID or identifier') },
      async (args) => run('list-relations', {}, [args.issue_id])
    ),

    tool(
      'af_linear_remove_relation',
      'Remove a relation between Linear issues',
      { relation_id: z.string().describe('Relation ID to remove') },
      async (args) => run('remove-relation', {}, [args.relation_id])
    ),

    tool(
      'af_linear_list_sub_issues',
      'List sub-issues of a parent Linear issue with dependency graph',
      { issue_id: z.string().describe('Parent issue ID or identifier') },
      async (args) => run('list-sub-issues', {}, [args.issue_id])
    ),

    tool(
      'af_linear_list_sub_issue_statuses',
      'List status of all sub-issues for a parent issue',
      { issue_id: z.string().describe('Parent issue ID or identifier') },
      async (args) => run('list-sub-issue-statuses', {}, [args.issue_id])
    ),

    tool(
      'af_linear_update_sub_issue',
      'Update a sub-issue state and optionally add a comment',
      {
        issue_id: z.string().describe('Sub-issue ID or identifier'),
        state: z.string().optional().describe('New state (e.g. "Started", "Finished")'),
        comment: z.string().optional().describe('Comment to add'),
      },
      async (args) => {
        const cliArgs: Record<string, string | string[] | boolean> = {}
        if (args.state) cliArgs.state = args.state
        if (args.comment) cliArgs.comment = args.comment
        return run('update-sub-issue', cliArgs, [args.issue_id])
      }
    ),

    tool(
      'af_linear_check_blocked',
      'Check if a Linear issue is blocked by other issues',
      { issue_id: z.string().describe('Issue ID or identifier') },
      async (args) => run('check-blocked', {}, [args.issue_id])
    ),

    tool(
      'af_linear_list_backlog_issues',
      'List all backlog issues for a project',
      { project: z.string().describe('Project name') },
      async (args) => run('list-backlog-issues', { project: args.project })
    ),

    tool(
      'af_linear_list_unblocked_backlog',
      'List unblocked backlog issues for a project (sorted by priority)',
      { project: z.string().describe('Project name') },
      async (args) => run('list-unblocked-backlog', { project: args.project })
    ),

    tool(
      'af_linear_check_deployment',
      'Check deployment status of a pull request',
      {
        pr_number: z.number().describe('Pull request number'),
        format: z.enum(['json', 'markdown']).optional().describe('Output format (default: json)'),
      },
      async (args) => run('check-deployment', args.format ? { format: args.format } : {}, [String(args.pr_number)])
    ),

    tool(
      'af_linear_list_issues',
      'List Linear issues with filters (project, status, label, priority, assignee)',
      {
        project: z.string().optional().describe('Filter by project name'),
        status: z.string().optional().describe('Filter by status (Icebox, Backlog, Started, Finished, etc.)'),
        label: z.string().optional().describe('Filter by label name'),
        priority: z.number().optional().describe('Filter by priority (1=Urgent, 2=High, 3=Medium, 4=Low)'),
        assignee: z.string().optional().describe('Filter by assignee (name, email, or "me")'),
        team: z.string().optional().describe('Filter by team name'),
        limit: z.number().optional().describe('Max results (default 50)'),
        order_by: z.enum(['createdAt', 'updatedAt']).optional().describe('Sort order'),
        query: z.string().optional().describe('Search title/description text'),
      },
      async (args) => {
        const cliArgs: Record<string, string | string[] | boolean> = {}
        if (args.project) cliArgs.project = args.project
        if (args.status) cliArgs.status = args.status
        if (args.label) cliArgs.label = args.label
        if (args.priority != null) cliArgs.priority = String(args.priority)
        if (args.assignee) cliArgs.assignee = args.assignee
        if (args.team) cliArgs.team = args.team
        else if (teamName) cliArgs.team = teamName
        if (args.limit != null) cliArgs.limit = String(args.limit)
        if (args.order_by) cliArgs['order-by'] = args.order_by
        if (args.query) cliArgs.query = args.query
        return run('list-issues', cliArgs)
      }
    ),

    tool(
      'af_linear_create_blocker',
      'Create a human-needed blocker issue linked to a source issue',
      {
        source_issue_id: z.string().describe('Source issue ID or identifier that is blocked'),
        title: z.string().describe('What the human needs to do'),
        description: z.string().optional().describe('Detailed steps for the human'),
        team: z.string().optional().describe('Team name (defaults to source issue team)'),
        project: z.string().optional().describe('Project name (defaults to source issue project)'),
        assignee: z.string().optional().describe('Assignee name or email'),
      },
      async (args) => {
        const cliArgs: Record<string, string | string[] | boolean> = {
          title: args.title,
        }
        if (args.description) cliArgs.description = args.description
        if (args.team) cliArgs.team = args.team
        if (args.project) cliArgs.project = args.project
        if (args.assignee) cliArgs.assignee = args.assignee
        return run('create-blocker', cliArgs, [args.source_issue_id])
      }
    ),
  ]
}

export const linearPlugin: ToolPlugin = {
  name: 'af-linear',
  description: 'Linear project management operations',
  createTools(context: ToolPluginContext): SdkMcpToolDefinition<any>[] {
    const apiKey = context.env.LINEAR_API_KEY
    const proxyUrl = context.env.AGENTFACTORY_API_URL || context.env.WORKER_API_URL
    const proxyAuthToken = context.env.WORKER_AUTH_TOKEN || context.env.WORKER_API_KEY

    if (!apiKey && !(proxyUrl && proxyAuthToken)) {
      return []
    }

    return makeTools(apiKey, context.env.LINEAR_TEAM_NAME, proxyUrl, proxyAuthToken)
  },
}
