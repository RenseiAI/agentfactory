#!/usr/bin/env node
/**
 * AgentFactory Linear CLI
 *
 * Thin wrapper around the linear runner.
 *
 * Usage:
 *   af-linear <command> [options]
 *
 * Commands:
 *   get-issue <id>              Get issue details
 *   create-issue                Create a new issue
 *   update-issue <id>           Update an existing issue
 *   list-comments <issueId>     List comments on an issue
 *   create-comment <issueId>    Create a comment on an issue
 *   list-issues                  List issues with flexible filters
 *   list-backlog-issues         List backlog issues for a project
 *   list-unblocked-backlog      List unblocked backlog issues
 *   check-blocked <id>          Check if an issue is blocked
 *   add-relation <id> <id>      Create relation between issues
 *   list-relations <id>         List relations for an issue
 *   remove-relation <id>        Remove a relation by ID
 *   list-sub-issues <id>        List sub-issues of a parent issue
 *   list-sub-issue-statuses <id> List sub-issue statuses (lightweight)
 *   update-sub-issue <id>       Update sub-issue status with comment
 *   check-deployment <PR>       Check Vercel deployment status for a PR
 *   create-blocker <source-id>  Create a human-needed blocker issue
 *   cleanup-sub-issues          Audit and clean up agent-created sub-issues
 *
 * Array Values:
 *   --labels accepts comma-separated: --labels "Bug,Feature"
 *   For values with commas, use JSON: --labels '["Bug", "UI, UX"]'
 *   Text fields (--description, --title, --body) preserve commas.
 *
 * Environment:
 *   LINEAR_API_KEY              Required API key for authentication
 */

import path from 'path'
import { config } from 'dotenv'

// Load environment variables from .env.local
config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true })

import { runLinear, parseLinearArgs } from './lib/linear-runner.js'
import { runCleanupSubIssues, renderMarkdownReport } from './cleanup-sub-issues.js'

function printHelp(): void {
  console.log(`
AgentFactory Linear CLI — Linear issue tracker operations

Usage:
  af-linear <command> [options]

Commands:
  get-issue <id>                Get issue details
  create-issue                  Create a new issue
  update-issue <id>             Update an existing issue
  list-comments <issueId>       List comments on an issue
  create-comment <issueId>      Create a comment on an issue
  list-issues                   List issues with flexible filters
  list-backlog-issues           List backlog issues for a project
  list-unblocked-backlog        List unblocked backlog issues
  check-blocked <id>            Check if an issue is blocked
  add-relation <id> <id>        Create relation between issues
  list-relations <id>           List relations for an issue
  remove-relation <id>          Remove a relation by ID
  list-sub-issues <id>          List sub-issues of a parent issue
  list-sub-issue-statuses <id>  List sub-issue statuses (lightweight)
  update-sub-issue <id>         Update sub-issue status with comment
  check-deployment <PR>         Check Vercel deployment status for a PR
  create-blocker <source-id>    Create a human-needed blocker issue
  cleanup-sub-issues            Audit and clean up agent-created sub-issues
  help                          Show this help message

Options:
  --help, -h                    Show this help message

cleanup-sub-issues Options:
  --project <name>              Linear project name to scan (required)
  --dry-run                     List issues with disposition recommendations (no changes)
  --apply                       Apply the recommended dispositions
  --tracking <id>               Post dry-run report as a comment on this issue ID
  --agent-authors-config <path> Path to .donmai/known-agent-authors.json

Array Values:
  --labels accepts comma-separated: --labels "Bug,Feature"
  For values with commas, use JSON: --labels '["Bug", "UI, UX"]'

Environment:
  LINEAR_API_KEY                Required API key for authentication
  LINEAR_ACCESS_TOKEN           Alternative to LINEAR_API_KEY

Examples:
  af-linear get-issue PROJ-123
  af-linear create-issue --title "Add auth" --team "Engineering" --project "Backend"
  af-linear update-issue PROJ-123 --state "Finished"
  af-linear list-backlog-issues --project "MyProject"
  af-linear check-deployment 42
  af-linear cleanup-sub-issues --project "Agent" --dry-run
  af-linear cleanup-sub-issues --project "Agent" --dry-run --tracking REN-1323
  af-linear cleanup-sub-issues --project "Agent" --apply
`)
}

async function main(): Promise<void> {
  const { command, args, positionalArgs } = parseLinearArgs(process.argv.slice(2))

  if (!command || command === 'help' || args['help'] || args['h']) {
    printHelp()
    return
  }

  // Handle cleanup-sub-issues separately — it has its own runner
  if (command === 'cleanup-sub-issues') {
    if (!args.project) {
      console.error('Error: --project <name> is required for cleanup-sub-issues')
      console.error('Usage: af-linear cleanup-sub-issues --project <name> [--dry-run | --apply] [--tracking <id>]')
      process.exit(1)
    }

    const isDryRun = !!args['dry-run']
    const isApply = !!args['apply']

    if (!isDryRun && !isApply) {
      console.error('Error: either --dry-run or --apply must be specified')
      console.error('Usage: af-linear cleanup-sub-issues --project <name> [--dry-run | --apply]')
      process.exit(1)
    }

    const report = await runCleanupSubIssues({
      project: args.project as string,
      dryRun: isDryRun,
      apply: isApply,
      trackingIssueId: args.tracking as string | undefined,
      agentAuthorsConfigPath: args['agent-authors-config'] as string | undefined,
    })

    // Print markdown report to stdout
    console.log(renderMarkdownReport(report))

    // Also print structured JSON summary
    console.log('\n---\n')
    console.log(JSON.stringify({
      project: report.project,
      scannedParents: report.scannedParents,
      scannedSubIssues: report.scannedSubIssues,
      alreadyProcessed: report.alreadyProcessed,
      toClose: report.toClose.length,
      toDetach: report.toDetach.length,
      dryRun: report.dryRun,
    }, null, 2))
    return
  }

  const apiKey = process.env.LINEAR_API_KEY || process.env.LINEAR_ACCESS_TOKEN

  const result = await runLinear({
    command,
    args,
    positionalArgs,
    apiKey,
    proxyUrl: process.env.AGENTFACTORY_API_URL,
    proxyAuthToken: process.env.WORKER_AUTH_TOKEN || process.env.WORKER_API_KEY,
  })

  // check-deployment with markdown format outputs a string, not JSON
  if (typeof result.output === 'string') {
    console.log(result.output)
  } else {
    console.log(JSON.stringify(result.output, null, 2))
  }

  // Exit with error code if deployment check failed
  if (
    command === 'check-deployment' &&
    typeof result.output === 'object' &&
    result.output !== null &&
    'anyFailed' in result.output &&
    (result.output as { anyFailed: boolean }).anyFailed
  ) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
