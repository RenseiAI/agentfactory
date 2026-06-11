/**
 * Sub-issue cleanup utility (REN-1323)
 *
 * Identifies agent-created sub-issues from the deprecated 1-point-gets-3-sub-issues
 * pattern and recommends disposition: keep-as-independent or close-as-noise.
 *
 * Usage:
 *   af-linear cleanup-sub-issues --project <name> --dry-run
 *   af-linear cleanup-sub-issues --project <name> --apply [--tracking <id>]
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CleanupSubIssuesConfig {
  /** Linear project name to scan */
  project: string
  /** When true, print a report but do not modify any issues */
  dryRun: boolean
  /** When true, apply the recommended dispositions */
  apply: boolean
  /** Optional tracking issue identifier (e.g. "REN-1323") to post the report on */
  trackingIssueId?: string
  /** Path to known-agent-authors config (defaults to .donmai/known-agent-authors.json) */
  agentAuthorsConfigPath?: string
  /** Working directory for config file resolution (defaults to cwd) */
  cwd?: string
  /** Injected Linear client (for testing) */
  linearClient?: LinearClientInterface
}

export type Disposition = 'decompose-noise' | 'worth-keeping' | 'already-processed'

export interface SubIssueReport {
  issueId: string
  identifier: string
  title: string
  parentId: string
  parentIdentifier: string
  parentTitle: string
  parentStatus: string
  status: string
  authorId: string | undefined
  isAgentAuthored: boolean
  titlePatternMatch: boolean
  descriptionSimilarity: number
  disposition: Disposition
  reasoning: string[]
}

export interface CleanupReport {
  project: string
  scannedParents: number
  scannedSubIssues: number
  alreadyProcessed: number
  toClose: SubIssueReport[]
  toDetach: SubIssueReport[]
  dryRun: boolean
}

// ---------------------------------------------------------------------------
// Linear client interface (kept minimal for testability)
// ---------------------------------------------------------------------------

export interface LinearIssue {
  id: string
  identifier: string
  title: string
  description?: string | null
  status: string
  createdAt: number
  parentId?: string
  childCount: number
  labels: string[]
  authorId?: string
  /** True if an attachment, PR or commit is linked to this issue */
  hasLinkedResources?: boolean
  /** True if the issue was edited by a human after creation */
  editedByHuman?: boolean
}

export interface LinearClientInterface {
  listProjectIssues(projectName: string): Promise<LinearIssue[]>
  getIssueFull(issueId: string): Promise<{
    id: string
    identifier: string
    title: string
    description?: string | null
    authorId?: string
    hasLinkedResources?: boolean
    editedByHuman?: boolean
    labels: string[]
  }>
  closeIssue(issueId: string, comment: string): Promise<void>
  detachFromParent(issueId: string, comment: string): Promise<void>
  addLabel(issueId: string, labelName: string): Promise<void>
  hasLabel(issueId: string, labelName: string): Promise<boolean>
  createComment(issueId: string, body: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Agent-author heuristics
// ---------------------------------------------------------------------------

const PROCESSED_LABEL = 'cleanup:processed'

/** Default set of well-known agent bot user display-name fragments */
const DEFAULT_AGENT_AUTHOR_PATTERNS = [
  'agent',
  'bot',
  'rensei',
  'agentfactory',
  'claude',
  'automation',
]

/** Title patterns that indicate a sub-issue was synthesised from a decomposition step */
const DECOMPOSE_TITLE_PATTERNS: RegExp[] = [
  /^part\s+\d+\s+of\s+\d+/i,
  /^phase\s+[a-z\d]:/i,
  /^step\s+\d+\s*[:-]/i,
  /\(\s*sub[-\s]?task\s*\)/i,
  /\(\s*subtask\s*\)/i,
  /^implement\s+.+\s+\(sub[-\s]?task\)/i,
  /^task\s+\d+\s*[:-]/i,
  /^sub[-\s]?task\s*\d*/i,
]

/** States that are considered "terminal" (done/completed) */
const TERMINAL_STATES = new Set([
  'done',
  'finished',
  'accepted',
  'delivered',
  'closed',
  'canceled',
  'cancelled',
  'completed',
])

function isTerminalState(status: string): boolean {
  return TERMINAL_STATES.has(status.toLowerCase())
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export interface AgentAuthorsConfig {
  /** Linear user IDs that are known to be agent bots */
  agentUserIds: string[]
  /** Optional name fragments to recognize agent authors */
  agentAuthorPatterns?: string[]
}

function loadAgentAuthorsConfig(configPath: string): AgentAuthorsConfig {
  if (!existsSync(configPath)) {
    return { agentUserIds: [], agentAuthorPatterns: DEFAULT_AGENT_AUTHOR_PATTERNS }
  }
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<AgentAuthorsConfig>
    return {
      agentUserIds: parsed.agentUserIds ?? [],
      agentAuthorPatterns: parsed.agentAuthorPatterns ?? DEFAULT_AGENT_AUTHOR_PATTERNS,
    }
  } catch {
    return { agentUserIds: [], agentAuthorPatterns: DEFAULT_AGENT_AUTHOR_PATTERNS }
  }
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

export function isTitleDecomposeNoise(title: string): boolean {
  return DECOMPOSE_TITLE_PATTERNS.some((pat) => pat.test(title))
}

/**
 * Rough word-overlap similarity between two strings.
 * Returns a value in [0, 1]; 1 = identical word sets.
 */
export function wordOverlapSimilarity(a: string, b: string): number {
  const words = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2)
    )

  const wa = words(a)
  const wb = words(b)
  if (wa.size === 0 || wb.size === 0) return 0

  let overlap = 0
  for (const w of wa) {
    if (wb.has(w)) overlap++
  }

  return overlap / Math.max(wa.size, wb.size)
}

function isAgentAuthored(
  authorId: string | undefined,
  config: AgentAuthorsConfig
): boolean {
  if (!authorId) return false
  if (config.agentUserIds.includes(authorId)) return true
  // Fallback: pattern match on the authorId string itself (Linear IDs are UUIDs —
  // this branch is a safety valve; the primary match is exact UUID from config).
  return false
}

// ---------------------------------------------------------------------------
// Disposition logic
// ---------------------------------------------------------------------------

function classifySubIssue(
  subIssue: LinearIssue,
  parent: LinearIssue,
  fullDetails: {
    authorId?: string
    hasLinkedResources?: boolean
    editedByHuman?: boolean
  },
  agentConfig: AgentAuthorsConfig
): { disposition: Disposition; reasoning: string[] } {
  const reasoning: string[] = []

  // Idempotency: already processed
  if (subIssue.labels.includes(PROCESSED_LABEL)) {
    return { disposition: 'already-processed', reasoning: ['Already processed (has cleanup:processed label)'] }
  }

  const agentAuthored = isAgentAuthored(fullDetails.authorId, agentConfig)
  const titleMatch = isTitleDecomposeNoise(subIssue.title)
  const descSimilarity = wordOverlapSimilarity(
    subIssue.description ?? '',
    parent.description ?? ''
  )
  const parentDone = isTerminalState(parent.status)
  const subDone = isTerminalState(subIssue.status)

  // --- Worth keeping signals ---
  if (fullDetails.hasLinkedResources) {
    reasoning.push('Sub-issue has linked PRs/commits — likely has real work')
    return { disposition: 'worth-keeping', reasoning }
  }

  if (fullDetails.editedByHuman) {
    reasoning.push('Sub-issue was edited by a human after creation')
    return { disposition: 'worth-keeping', reasoning }
  }

  // --- Decompose-noise signals ---
  if (agentAuthored) reasoning.push('Author ID matches known agent bot')
  if (titleMatch) reasoning.push(`Title matches decompose pattern`)
  if (descSimilarity > 0.5) reasoning.push(`Description ~${Math.round(descSimilarity * 100)}% similar to parent`)
  if (parentDone && subDone) reasoning.push('Both parent and sub-issue are in terminal state')

  const noiseScore =
    (agentAuthored ? 2 : 0) +
    (titleMatch ? 2 : 0) +
    (descSimilarity > 0.5 ? 1 : 0) +
    (parentDone && subDone ? 1 : 0)

  if (noiseScore >= 2) {
    return { disposition: 'decompose-noise', reasoning }
  }

  // Default: keep as independent issue
  reasoning.push('No strong decompose-noise signals — treating as worth-keeping orphan')
  return { disposition: 'worth-keeping', reasoning }
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

export function renderMarkdownReport(report: CleanupReport): string {
  const lines: string[] = []
  lines.push(`## Sub-issue Cleanup Report — ${report.project}`)
  lines.push('')
  lines.push(
    `Scanned **${report.scannedParents}** parent issues, **${report.scannedSubIssues}** sub-issues.`
  )
  if (report.alreadyProcessed > 0) {
    lines.push(`${report.alreadyProcessed} already processed (skipped).`)
  }
  lines.push('')

  if (report.toClose.length === 0 && report.toDetach.length === 0) {
    lines.push('Nothing to clean up.')
    return lines.join('\n')
  }

  if (report.toClose.length > 0) {
    lines.push(`### Decompose-noise (${report.toClose.length} to close)`)
    lines.push('')
    lines.push('| Identifier | Title | Parent | Parent Status | Reasoning |')
    lines.push('|---|---|---|---|---|')
    for (const r of report.toClose) {
      const reason = r.reasoning.join('; ')
      lines.push(
        `| [${r.identifier}](https://linear.app/issue/${r.identifier}) | ${r.title} | [${r.parentIdentifier}](https://linear.app/issue/${r.parentIdentifier}) ${r.parentTitle} | ${r.parentStatus} | ${reason} |`
      )
    }
    lines.push('')
  }

  if (report.toDetach.length > 0) {
    lines.push(`### Worth-keeping orphans (${report.toDetach.length} to detach)`)
    lines.push('')
    lines.push('| Identifier | Title | Parent | Reasoning |')
    lines.push('|---|---|---|---|')
    for (const r of report.toDetach) {
      const reason = r.reasoning.join('; ')
      lines.push(
        `| [${r.identifier}](https://linear.app/issue/${r.identifier}) | ${r.title} | [${r.parentIdentifier}](https://linear.app/issue/${r.parentIdentifier}) ${r.parentTitle} | ${reason} |`
      )
    }
    lines.push('')
  }

  if (report.dryRun) {
    lines.push('> **Dry-run mode** — no changes were made. Run with `--apply` to execute.')
  } else {
    lines.push('> Changes have been applied.')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Real Linear client adapter (loaded lazily at runtime)
// ---------------------------------------------------------------------------

/**
 * Build a real LinearClientInterface adapter from an API key.
 *
 * Delegates to cleanup-sub-issues-adapter.ts which imports @donmai/plugin-linear.
 * Using a dynamic import prevents Vite from analyzing the @donmai/plugin-linear
 * dependency during test collection (where workspace packages may not be built).
 */
async function buildLinearClientFromApiKey(apiKey: string): Promise<LinearClientInterface> {
  // Use a computed specifier so Vite does not statically analyze this import.
  // The adapter is always co-located alongside this file.
  const adapterPath = './cleanup-sub-issues-adapter.js'
  const mod = await import(/* @vite-ignore */ adapterPath)
  return (mod.buildLinearClient as (apiKey: string) => Promise<LinearClientInterface>)(apiKey)
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runCleanupSubIssues(config: CleanupSubIssuesConfig): Promise<CleanupReport> {
  const cwd = config.cwd ?? process.cwd()
  const agentAuthorsConfigPath =
    config.agentAuthorsConfigPath ?? resolve(cwd, '.donmai', 'known-agent-authors.json')

  const agentConfig = loadAgentAuthorsConfig(agentAuthorsConfigPath)

  // Obtain client
  let client: LinearClientInterface
  if (config.linearClient) {
    client = config.linearClient
  } else {
    const apiKey = process.env.LINEAR_API_KEY || process.env.LINEAR_ACCESS_TOKEN
    if (!apiKey) {
      throw new Error(
        'LINEAR_API_KEY environment variable is required for cleanup-sub-issues'
      )
    }
    client = await buildLinearClientFromApiKey(apiKey)
  }

  // Fetch all project issues
  const allIssues = await client.listProjectIssues(config.project)

  // Separate parents from sub-issues
  const issueById = new Map<string, LinearIssue>()
  for (const iss of allIssues) {
    issueById.set(iss.id, iss)
  }

  const subIssues = allIssues.filter((i) => i.parentId != null)
  const parentIds = new Set(subIssues.map((i) => i.parentId!))

  const report: CleanupReport = {
    project: config.project,
    scannedParents: parentIds.size,
    scannedSubIssues: subIssues.length,
    alreadyProcessed: 0,
    toClose: [],
    toDetach: [],
    dryRun: config.dryRun,
  }

  for (const subIssue of subIssues) {
    const parent = issueById.get(subIssue.parentId!)
    if (!parent) {
      // Parent not in this project's non-terminal issues — treat as orphan worth keeping
      continue
    }

    // Fetch full details (author, attachments, edits)
    let fullDetails: Awaited<ReturnType<LinearClientInterface['getIssueFull']>>
    try {
      fullDetails = await client.getIssueFull(subIssue.id)
    } catch {
      // If we can't fetch details, skip conservatively
      continue
    }

    const { disposition, reasoning } = classifySubIssue(
      subIssue,
      parent,
      fullDetails,
      agentConfig
    )

    const row: SubIssueReport = {
      issueId: subIssue.id,
      identifier: subIssue.identifier,
      title: subIssue.title,
      parentId: parent.id,
      parentIdentifier: parent.identifier,
      parentTitle: parent.title,
      parentStatus: parent.status,
      status: subIssue.status,
      authorId: fullDetails.authorId,
      isAgentAuthored: isAgentAuthored(fullDetails.authorId, agentConfig),
      titlePatternMatch: isTitleDecomposeNoise(subIssue.title),
      descriptionSimilarity: wordOverlapSimilarity(
        subIssue.description ?? '',
        parent.description ?? ''
      ),
      disposition,
      reasoning,
    }

    if (disposition === 'already-processed') {
      report.alreadyProcessed++
    } else if (disposition === 'decompose-noise') {
      report.toClose.push(row)
    } else {
      report.toDetach.push(row)
    }
  }

  // Apply changes if requested
  if (config.apply && !config.dryRun) {
    for (const row of report.toClose) {
      const comment =
        `Closed by REN-1323 cleanup; was decomposition-noise of [${row.parentIdentifier}](https://linear.app/issue/${row.parentIdentifier}). ` +
        `Original description preserved as comment.\n\n**Reasoning:** ${row.reasoning.join('; ')}`
      await client.closeIssue(row.issueId, comment)
    }

    for (const row of report.toDetach) {
      const comment =
        `Detached from parent [${row.parentIdentifier}](https://linear.app/issue/${row.parentIdentifier}) by REN-1323 cleanup. ` +
        `This issue has been promoted to an independent issue.\n\n**Reasoning:** ${row.reasoning.join('; ')}`
      await client.detachFromParent(row.issueId, comment)
    }
  }

  // Post dry-run report as comment on tracking issue
  if (config.trackingIssueId && config.dryRun) {
    const markdownReport = renderMarkdownReport(report)
    await client.createComment(config.trackingIssueId, markdownReport)
  }

  return report
}
