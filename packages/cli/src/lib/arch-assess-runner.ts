/**
 * Architectural Intelligence — CLI runner for `af-arch assess` (DEPRECATED)
 *
 * DEPRECATED: this runner backs the deprecated `af-arch` binary. The native Go
 * `donmai arch` command supersedes it. Retained as a thin shim for OSS
 * continuity; do not build new integrations against it.
 *
 * Architecture reference: the OSS architecture corpus
 * (donmai-architecture/007-intelligence-services.md) — Drift detection.
 *
 * Responsibilities:
 *   1. Parse and validate CLI arguments.
 *   2. Resolve the SQLite DB path.
 *   3. Instantiate SqliteArchitecturalIntelligence.
 *   4. Resolve ModelAdapter:
 *      - If ANTHROPIC_API_KEY is set, use a minimal Anthropic SDK adapter.
 *      - Otherwise, use a stub adapter that returns [] with a notice.
 *   5. Optionally fetch the PR diff from GitHub (when gh CLI is available and
 *      GITHUB_TOKEN / gh auth is configured).
 *   6. Run assessWithAdapter().
 *   7. Format and return the output.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import {
  SqliteArchitecturalIntelligence,
  resolveDriftGatePolicy,
  evaluateGate,
  type DriftGatePolicy,
} from '@donmai/architectural-intelligence'
import type { ModelAdapter } from '@donmai/architectural-intelligence'
import type { PrDiff } from '@donmai/architectural-intelligence'

// ---------------------------------------------------------------------------
// Input / Output
// ---------------------------------------------------------------------------

export interface ArchAssessInput {
  /** Full PR URL (e.g., https://github.com/org/repo/pull/123). */
  prUrl?: string
  /** Repository identifier (e.g., 'github.com/org/repo'). */
  repository?: string
  /** PR number within the repository. */
  prNumber?: number
  /** Gate policy override. Falls back to RENSEI_DRIFT_GATE env. */
  gatePolicy?: string
  /** Scope level for the baseline query. */
  scopeLevel?: 'project' | 'org' | 'tenant' | 'global'
  /** Project ID for scope. */
  projectId?: string
  /** Path to the SQLite DB file. */
  dbPath?: string
  /** Whether to format output as a human-readable summary. */
  summary?: boolean
  /** Working directory (for resolving relative paths). */
  cwd: string
}

export interface ArchAssessResult {
  /** Whether the gate policy was triggered. */
  gated: boolean
  /** Whether to output summary mode. */
  summary: boolean
  /** Human-readable summary text. */
  summaryText: string
  /** Full JSON output. */
  output: unknown
}

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

export function parseArchArgs(argv: string[]): {
  command: string | undefined
  prUrl: string | undefined
  args: Record<string, string | boolean>
} {
  const args: Record<string, string | boolean> = {}
  const positional: string[] = []
  let command: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        args[key] = next
        i++
      } else {
        args[key] = true
      }
    } else if (!command) {
      command = arg
    } else {
      positional.push(arg)
    }
  }

  // First positional after command is the PR URL
  const prUrl = positional[0]

  return { command, prUrl, args }
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runArchAssess(input: ArchAssessInput): Promise<ArchAssessResult> {
  // Resolve DB path
  const dbPath =
    input.dbPath ??
    process.env['RENSEI_ARCH_DB'] ??
    join(input.cwd, '.agentfactory', 'arch-intelligence', 'db.sqlite')

  // Instantiate the SQLite implementation
  const ai = new SqliteArchitecturalIntelligence({ dbPath })

  // Resolve ChangeRef
  const changeRef = _resolveChangeRef(input)

  // Resolve scope
  const scope = {
    level: input.scopeLevel ?? 'project',
    projectId: input.projectId,
  } as { level: 'project' | 'org' | 'tenant' | 'global'; projectId?: string }

  // Resolve gate policy
  const policyStr = input.gatePolicy ?? process.env['RENSEI_DRIFT_GATE']
  const gatePolicy: DriftGatePolicy = policyStr
    ? _parseGatePolicyString(policyStr)
    : resolveDriftGatePolicy()

  // Resolve model adapter
  const adapter = _resolveAdapter()

  // Optionally fetch PR diff
  let prDiff: PrDiff | undefined
  try {
    prDiff = await _fetchPrDiff(changeRef.repository ?? 'unknown', changeRef.prNumber ?? 0)
  } catch {
    // Diff fetch is best-effort; assessment still runs without it
    prDiff = undefined
  }

  // Run drift assessment
  const report = await ai.assessWithAdapter(changeRef, adapter, prDiff, scope)

  // Evaluate gate
  const gated = evaluateGate(report.deviations, gatePolicy)

  // Format output
  const output = {
    change: report.change,
    gated,
    hasCriticalDrift: report.hasCriticalDrift,
    deviationCount: report.deviations.length,
    bySeverity: {
      high: report.deviations.filter((d) => d.severity === 'high').length,
      medium: report.deviations.filter((d) => d.severity === 'medium').length,
      low: report.deviations.filter((d) => d.severity === 'low').length,
    },
    deviations: report.deviations.map((d) => ({
      id: d.id,
      title: d.title,
      description: d.description,
      severity: d.severity,
      status: d.status,
      deviatesFrom: d.deviatesFrom,
    })),
    reinforcedCount: report.reinforced.length,
    summary: report.summary,
    assessedAt: report.assessedAt.toISOString(),
    gatePolicy: policyStr ?? 'no-severity-high (default)',
    notices: _buildNotices(adapter, prDiff),
  }

  const summaryText = _buildSummaryText(output)

  ai.close()

  return {
    gated,
    summary: input.summary ?? false,
    summaryText,
    output,
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _resolveChangeRef(input: ArchAssessInput): {
  repository: string
  kind: 'pr'
  prNumber: number
  description?: string
} {
  if (input.prUrl) {
    const match = input.prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
    if (match) {
      return {
        repository: `github.com/${match[1]}`,
        kind: 'pr',
        prNumber: parseInt(match[2], 10),
        description: input.prUrl,
      }
    }
  }

  return {
    repository: input.repository ?? 'unknown',
    kind: 'pr',
    prNumber: input.prNumber ?? 0,
    description: input.prUrl,
  }
}

function _parseGatePolicyString(s: string): DriftGatePolicy {
  if (s === 'none') return 'none'
  if (s === 'no-severity-high') return 'no-severity-high'
  if (s === 'zero-deviations') return 'zero-deviations'
  if (s.startsWith('max:')) {
    const n = parseInt(s.slice(4), 10)
    if (!isNaN(n) && n >= 0) return { maxCount: n }
  }
  return 'no-severity-high'
}

/** Resolve a ModelAdapter based on available credentials. */
function _resolveAdapter(): ModelAdapter & { _kind: string } {
  const apiKey = process.env['ANTHROPIC_API_KEY']

  if (apiKey) {
    // Minimal Anthropic SDK adapter.
    // This is a thin wrapper — the full adapter with prompt caching will ship
    // in a follow-up issue once the Anthropic SDK is a peer dependency of this
    // package. For now we shell out via dynamic import to avoid adding the
    // Anthropic SDK as a hard dependency on the CLI's architectural-intelligence
    // integration.
    return {
      _kind: 'anthropic',
      async complete(systemPrompt: string, userPrompt: string): Promise<string> {
        try {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore — @anthropic-ai/sdk is an optional runtime dep; types not declared
          const { Anthropic } = await import('@anthropic-ai/sdk') as { Anthropic: new (opts: { apiKey: string }) => { messages: { create: (opts: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> } } }
          const client = new Anthropic({ apiKey })
          const response = await client.messages.create({
            model: 'claude-haiku-4-5',
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
          })
          const block = response.content[0]
          if (block && block.type === 'text') return block.text
          return '[]'
        } catch (err) {
          // Graceful degradation: if the SDK call fails, return empty result
          console.error('[arch-assess] Anthropic API call failed:', err instanceof Error ? err.message : err)
          return '[]'
        }
      },
    }
  }

  // No API key — stub adapter returns empty array with a notice in the output
  return {
    _kind: 'stub',
    async complete(): Promise<string> {
      return '[]'
    },
  }
}

/**
 * Fetch a PR diff via the `gh` CLI.
 * Returns undefined if gh is not available or the call fails.
 */
async function _fetchPrDiff(repository: string, prNumber: number): Promise<PrDiff | undefined> {
  if (prNumber === 0) return undefined

  // Check if gh is available
  try {
    execSync('gh --version', { stdio: 'ignore' })
  } catch {
    return undefined
  }

  try {
    // Fetch PR metadata as JSON
    const metaJson = execSync(
      `gh pr view ${prNumber} --repo ${repository.replace('github.com/', '')} --json title,body,files`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const meta = JSON.parse(metaJson) as {
      title: string
      body: string
      files: Array<{ path: string; additions: number; deletions: number }>
    }

    // Fetch the diff
    const diffText = execSync(
      `gh pr diff ${prNumber} --repo ${repository.replace('github.com/', '')}`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    )

    // Parse diff into per-file patches
    const files = _parseDiffIntoFiles(diffText, meta.files)

    return {
      repository,
      prNumber,
      title: meta.title,
      body: meta.body ?? '',
      files,
    }
  } catch {
    return undefined
  }
}

/** Parse a unified diff string into per-file patches. */
function _parseDiffIntoFiles(
  diffText: string,
  fileList: Array<{ path: string }>,
): PrDiff['files'] {
  const files: PrDiff['files'] = []
  const sections = diffText.split(/^diff --git /m).filter(Boolean)

  const knownPaths = new Set(fileList.map((f) => f.path))

  for (const section of sections) {
    const firstLine = section.split('\n')[0]
    // "a/path/to/file b/path/to/file"
    const match = firstLine.match(/a\/(.*?) b\//)
    if (!match) continue
    const filePath = match[1]

    if (!knownPaths.has(filePath) && knownPaths.size > 0) continue

    const patch = section.slice(firstLine.length).trim()
    const added = diffText.includes(`--- /dev/null\n+++ b/${filePath}`)

    files.push({ path: filePath, patch, added })
  }

  return files
}

/** Build human-readable notices for the output. */
function _buildNotices(
  adapter: { _kind: string },
  prDiff: PrDiff | undefined,
): string[] {
  const notices: string[] = []

  if (adapter._kind === 'stub') {
    notices.push(
      'ANTHROPIC_API_KEY is not set. Running without live LLM drift detection. ' +
        'Set ANTHROPIC_API_KEY to enable real deviation analysis.',
    )
  }

  if (!prDiff) {
    notices.push(
      'No PR diff available. Assessment ran against the baseline only (no change signals). ' +
        'Install the GitHub CLI (gh) and authenticate to enable diff-based detection.',
    )
  }

  return notices
}

/** Build a human-readable summary text for --summary mode. */
function _buildSummaryText(output: Record<string, unknown>): string {
  const lines: string[] = [
    '=== Architectural Drift Assessment ===',
    '',
    `Change:        ${String(output['change'] ? (output['change'] as { repository?: string; prNumber?: number }).repository + ' PR #' + (output['change'] as { repository?: string; prNumber?: number }).prNumber : 'unknown')}`,
    `Gate status:   ${output['gated'] ? 'BLOCKED' : 'CLEAN'}`,
    `Critical drift: ${output['hasCriticalDrift'] ? 'YES' : 'NO'}`,
    `Deviations:    ${output['deviationCount']} total`,
    '',
    `Summary: ${output['summary']}`,
  ]

  const deviations = output['deviations'] as Array<{ title: string; severity: string; description: string }> | undefined
  if (deviations && deviations.length > 0) {
    lines.push('', 'Deviations:')
    for (const d of deviations) {
      lines.push(`  [${d.severity.toUpperCase()}] ${d.title}`)
      lines.push(`         ${d.description}`)
    }
  }

  const notices = output['notices'] as string[] | undefined
  if (notices && notices.length > 0) {
    lines.push('', 'Notices:')
    for (const n of notices) {
      lines.push(`  - ${n}`)
    }
  }

  return lines.join('\n')
}
