/**
 * Deployment Status Checker
 *
 * Queries GitHub commit status API for Vercel deployment state.
 * Used to verify deployments before QA/acceptance work can proceed.
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// Re-export shared types from types.ts for backwards compatibility
export type {
  DeploymentStatus,
  DeploymentCheckResult,
  DeploymentCheckOptions,
  IssuePRInfo,
} from './types.js'

import type {
  DeploymentStatus,
  DeploymentCheckResult,
  DeploymentCheckOptions,
  IssuePRInfo,
} from './types.js'

import { VercelDeployProvider } from './vercel-provider.js'

const DEFAULT_OPTIONS: Required<DeploymentCheckOptions> = {
  owner: 'renseiai',
  repo: 'agentfactory',
  timeout: 30000,
}

/**
 * Parse Vercel app name from GitHub status context
 * Contexts look like: "Vercel – renseiai-social" or "Vercel"
 */
function parseAppName(context: string): string {
  // Extract app name after "Vercel – " or "Vercel - "
  const match = context.match(/Vercel\s*[–-]\s*(.+)/)
  if (match) {
    return match[1].trim()
  }
  // Fallback to just "Vercel" if no app name
  return context
}

/**
 * Check if a status description indicates a successful skip (monorepo optimization)
 * Vercel skips deployments for unchanged apps, which is treated as success
 */
function isSuccessfulSkip(description: string): boolean {
  return description.toLowerCase().includes('skipped') &&
         description.toLowerCase().includes('not affected')
}

/**
 * Map GitHub status state to our normalized state
 */
function normalizeState(
  state: string,
  description: string
): DeploymentStatus['state'] {
  // Handle successful skips as success
  if (isSuccessfulSkip(description)) {
    return 'success'
  }

  switch (state.toLowerCase()) {
    case 'success':
      return 'success'
    case 'pending':
      return 'pending'
    case 'failure':
      return 'failure'
    case 'error':
      return 'error'
    default:
      return 'pending'
  }
}

/**
 * Get the PR number for the current branch using gh CLI
 */
export async function getPRNumber(timeout: number = 30000): Promise<number | null> {
  try {
    const { stdout } = await execAsync(
      'gh pr list --head "$(git branch --show-current)" --json number -q ".[0].number"',
      { timeout }
    )
    const prNumber = parseInt(stdout.trim(), 10)
    return isNaN(prNumber) ? null : prNumber
  } catch {
    return null
  }
}

/**
 * Get the head commit SHA for a PR
 */
export async function getPRHeadSha(
  prNumber: number,
  options: DeploymentCheckOptions = {}
): Promise<string | null> {
  const { owner, repo, timeout } = { ...DEFAULT_OPTIONS, ...options }

  try {
    const { stdout } = await execAsync(
      `gh api repos/${owner}/${repo}/pulls/${prNumber} --jq '.head.sha'`,
      { timeout }
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** @deprecated Use VercelDeployProvider.checkDeployment() instead */
export async function checkDeploymentStatus(
  commitSha: string,
  options: DeploymentCheckOptions = {}
): Promise<DeploymentCheckResult> {
  const { owner, repo, timeout } = { ...DEFAULT_OPTIONS, ...options }

  const { stdout } = await execAsync(
    `gh api repos/${owner}/${repo}/commits/${commitSha}/status`,
    { timeout }
  )

  const response = JSON.parse(stdout)

  // Extract Vercel-related statuses
  const allStatuses: Array<{
    context: string
    state: string
    description: string
    target_url: string | null
  }> = response.statuses || []

  // Filter to only Vercel statuses
  const vercelStatuses = allStatuses.filter(
    (s) => s.context.toLowerCase().includes('vercel')
  )

  const deploymentStatuses: DeploymentStatus[] = vercelStatuses.map((s) => ({
    app: parseAppName(s.context),
    state: normalizeState(s.state, s.description || ''),
    description: s.description || '',
    targetUrl: s.target_url,
    context: s.context,
  }))

  // Calculate aggregate states
  const allSucceeded = deploymentStatuses.length > 0 &&
    deploymentStatuses.every((s) => s.state === 'success')
  const anyFailed = deploymentStatuses.some(
    (s) => s.state === 'failure' || s.state === 'error'
  )
  const anyPending = deploymentStatuses.some((s) => s.state === 'pending')

  return {
    allSucceeded,
    anyFailed,
    anyPending,
    statuses: deploymentStatuses,
    commitSha,
    overallState: response.state || 'unknown',
  }
}

/** @deprecated Use VercelDeployProvider.checkPRDeployment() instead */
export async function checkPRDeploymentStatus(
  prNumber: number,
  options: DeploymentCheckOptions = {}
): Promise<DeploymentCheckResult | null> {
  const commitSha = await getPRHeadSha(prNumber, options)
  if (!commitSha) {
    return null
  }
  return checkDeploymentStatus(commitSha, options)
}

/**
 * Format deployment check result for display
 */
export function formatDeploymentStatus(result: DeploymentCheckResult): string {
  const lines: string[] = []

  lines.push(`## Deployment Status Check`)
  lines.push(``)
  lines.push(`**Commit:** \`${result.commitSha.slice(0, 7)}\``)
  lines.push(`**Overall State:** ${result.overallState}`)
  lines.push(``)

  if (result.statuses.length === 0) {
    lines.push(`No Vercel deployments found for this commit.`)
    return lines.join('\n')
  }

  lines.push(`| App | State | Description |`)
  lines.push(`|-----|-------|-------------|`)

  for (const status of result.statuses) {
    const stateEmoji = {
      success: '✅',
      pending: '⏳',
      failure: '❌',
      error: '❌',
    }[status.state]

    const url = status.targetUrl
      ? `[${status.app}](${status.targetUrl})`
      : status.app

    lines.push(
      `| ${url} | ${stateEmoji} ${status.state} | ${status.description} |`
    )
  }

  lines.push(``)

  if (result.anyFailed) {
    lines.push(`### ❌ Deployment Failed`)
    lines.push(``)
    lines.push(`One or more Vercel deployments failed. QA/acceptance cannot proceed until deployments succeed.`)
  } else if (result.anyPending) {
    lines.push(`### ⏳ Deployment Pending`)
    lines.push(``)
    lines.push(`One or more Vercel deployments are still in progress.`)
  } else if (result.allSucceeded) {
    lines.push(`### ✅ All Deployments Succeeded`)
    lines.push(``)
    lines.push(`All Vercel deployments have completed successfully.`)
  }

  return lines.join('\n')
}

/**
 * Format failed deployments for a comment
 */
export function formatFailedDeployments(result: DeploymentCheckResult): string {
  const failed = result.statuses.filter(
    (s) => s.state === 'failure' || s.state === 'error'
  )

  if (failed.length === 0) {
    return 'No failed deployments.'
  }

  const lines: string[] = ['**Failed Deployments:**', '']

  for (const status of failed) {
    const url = status.targetUrl
      ? ` - [View logs](${status.targetUrl})`
      : ''
    lines.push(`- **${status.app}**: ${status.description}${url}`)
  }

  return lines.join('\n')
}

/**
 * Find open PRs associated with a Linear issue identifier
 * Searches for PRs with the issue identifier in the branch name or title
 *
 * @param issueIdentifier - The Linear issue identifier (e.g., "ABC-123")
 * @param options - Options for the search
 * @returns Array of matching PRs
 */
export async function findPRsForIssue(
  issueIdentifier: string,
  options: DeploymentCheckOptions = {}
): Promise<IssuePRInfo[]> {
  const { owner, repo, timeout } = { ...DEFAULT_OPTIONS, ...options }

  try {
    // Search for PRs with the issue identifier in branch name or title
    const { stdout } = await execAsync(
      `gh pr list --repo ${owner}/${repo} --state open --json number,headRefName,headRefOid,title,url --search "${issueIdentifier}"`,
      { timeout }
    )

    const prs = JSON.parse(stdout || '[]')

    // Filter to PRs that actually match the issue identifier
    const lowerIdentifier = issueIdentifier.toLowerCase()
    const matchingPRs = prs.filter((pr: { headRefName: string; title: string }) => {
      const branchMatch = pr.headRefName.toLowerCase().includes(lowerIdentifier)
      const titleMatch = pr.title.toLowerCase().includes(lowerIdentifier)
      return branchMatch || titleMatch
    })

    return matchingPRs.map(
      (pr: {
        number: number
        headRefOid: string
        headRefName: string
        title: string
        url: string
      }) => ({
        number: pr.number,
        headSha: pr.headRefOid,
        branch: pr.headRefName,
        title: pr.title,
        url: pr.url,
      })
    )
  } catch {
    return []
  }
}

/** @deprecated Use VercelDeployProvider.checkIssueDeployment() instead */
export async function checkIssueDeploymentStatus(
  issueIdentifier: string,
  options: DeploymentCheckOptions = {}
): Promise<(DeploymentCheckResult & { pr: IssuePRInfo }) | null> {
  const prs = await findPRsForIssue(issueIdentifier, options)

  if (prs.length === 0) {
    return null
  }

  // Use the first matching PR (most recent PRs are returned first by gh)
  const pr = prs[0]
  const result = await checkDeploymentStatus(pr.headSha, options)

  return {
    ...result,
    pr,
  }
}
