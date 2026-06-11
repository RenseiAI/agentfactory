/**
 * Local Merge Queue Adapter
 *
 * Self-hosted merge queue that uses the built-in merge worker + Redis storage
 * instead of an external service like GitHub's merge queue. This is the default
 * provider — it works with any GitHub repository without requiring GitHub's
 * paid merge queue feature.
 *
 * The adapter handles queue management (enqueue/dequeue/status). The merge worker
 * (merge-worker.ts) handles the actual rebase → resolve → test → merge pipeline.
 *
 * PR eligibility is checked via `gh pr view` CLI (no GraphQL needed).
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import type { MergeQueueAdapter, MergeQueueStatus } from '../types.js'

const execAsync = promisify(exec)

/** Timeout for gh CLI calls */
const GH_CLI_TIMEOUT = 15_000

// ---------------------------------------------------------------------------
// Storage interface (injected to avoid coupling to server package)
// ---------------------------------------------------------------------------

export interface LocalMergeQueueStorage {
  enqueue(entry: {
    repoId: string
    prNumber: number
    prUrl: string
    issueIdentifier: string
    priority: number
    sourceBranch: string
    targetBranch: string
  }): Promise<void>

  dequeue(repoId: string): Promise<{ prNumber: number } | null>

  /** Get queue depth for a repo */
  getQueueDepth(repoId: string): Promise<number>

  /** Check if a PR is already in the queue */
  isEnqueued(repoId: string, prNumber: number): Promise<boolean>

  /** Get position of a PR in the queue (1-based), or null if not queued */
  getPosition(repoId: string, prNumber: number): Promise<number | null>

  /** Remove a specific PR from the queue */
  remove(repoId: string, prNumber: number): Promise<void>

  /** Get failed/blocked status for a PR */
  getFailedReason(repoId: string, prNumber: number): Promise<string | null>
  getBlockedReason(repoId: string, prNumber: number): Promise<string | null>

  /** Peek all queued entries without removing (for conflict graph building) */
  peekAll(repoId: string): Promise<Array<{ prNumber: number; sourceBranch: string }>>

  /** Atomically dequeue multiple PRs for parallel processing */
  dequeueBatch(repoId: string, prNumbers: number[]): Promise<Array<{ prNumber: number }>>
}

/**
 * Pull a Linear-style issue identifier (e.g. "ABC-1153", "ABC-42") out of a
 * branch name or PR title. Returns null if no match.
 *
 * Matches:
 *   - "ABC-1153" (bare branch)
 *   - "ABC-1153: short title" (PR title prefix)
 *   - "feature/ABC-1153-cedar-stuff" (branch with prefix)
 *   - "ren-1153" (lowercase, normalized to upper)
 *
 * Exported for testing.
 */
export function extractIssueIdentifier(input: string): string | null {
  if (!input) return null
  // ALPHA-DIGITS pattern, anchored to word boundary so "v1.2.3-rc4" doesn't match
  const m = input.match(/\b([A-Za-z]{2,10})-(\d+)\b/)
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class LocalMergeQueueAdapter implements MergeQueueAdapter {
  readonly name = 'local' as const

  constructor(private storage: LocalMergeQueueStorage) {}

  /**
   * Check if a PR is eligible for the local merge queue.
   * Uses `gh pr view` to verify PR is open. Does NOT require the PR to be
   * conflict-free — the merge worker handles rebasing.
   */
  async canEnqueue(owner: string, repo: string, prNumber: number): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        `gh pr view ${prNumber} --repo ${owner}/${repo} --json state,headRefName`,
        { timeout: GH_CLI_TIMEOUT },
      )
      const pr = JSON.parse(stdout)
      // PR must be open
      return pr.state === 'OPEN'
    } catch {
      return false
    }
  }

  /**
   * Add a PR to the local merge queue.
   * The merge worker will pick it up and process it (rebase, test, merge).
   */
  async enqueue(owner: string, repo: string, prNumber: number): Promise<MergeQueueStatus> {
    const repoId = `${owner}/${repo}`

    // Check if already enqueued
    const alreadyQueued = await this.storage.isEnqueued(repoId, prNumber)
    if (alreadyQueued) {
      return this.getStatus(owner, repo, prNumber)
    }

    // Fetch PR details for the queue entry
    let sourceBranch = `pr-${prNumber}`
    let prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`
    let prTitle = ''
    try {
      const { stdout } = await execAsync(
        `gh pr view ${prNumber} --repo ${owner}/${repo} --json headRefName,url,title`,
        { timeout: GH_CLI_TIMEOUT },
      )
      const pr = JSON.parse(stdout)
      sourceBranch = pr.headRefName ?? sourceBranch
      prUrl = pr.url ?? prUrl
      prTitle = typeof pr.title === 'string' ? pr.title : ''
    } catch {
      // Fall back to defaults
    }

    await this.storage.enqueue({
      repoId,
      prNumber,
      prUrl,
      // Resolve the originating issue identifier so the merge worker can
      // bubble results back to the right ticket. Convention: agents create
      // branches and PR titles prefixed with the issue identifier
      // (e.g., branch "ABC-1153", title "ABC-1153: Cedar-Gated …").
      // Falls back to PR-N when neither yields a parseable identifier.
      issueIdentifier:
        extractIssueIdentifier(sourceBranch) ??
        extractIssueIdentifier(prTitle) ??
        `PR-${prNumber}`,
      priority: 3, // Default priority; orchestrator can override
      sourceBranch,
      targetBranch: 'main',
    })

    return this.getStatus(owner, repo, prNumber)
  }

  /**
   * Get the status of a PR in the local merge queue.
   */
  async getStatus(owner: string, repo: string, prNumber: number): Promise<MergeQueueStatus> {
    const repoId = `${owner}/${repo}`

    // Check if in queue
    const position = await this.storage.getPosition(repoId, prNumber)
    if (position !== null) {
      return {
        state: position === 1 ? 'merging' : 'queued',
        position,
        checksStatus: [],
      }
    }

    // Check if failed
    const failedReason = await this.storage.getFailedReason(repoId, prNumber)
    if (failedReason) {
      return {
        state: 'failed',
        failureReason: failedReason,
        checksStatus: [],
      }
    }

    // Check if blocked (conflict)
    const blockedReason = await this.storage.getBlockedReason(repoId, prNumber)
    if (blockedReason) {
      return {
        state: 'blocked',
        failureReason: blockedReason,
        checksStatus: [],
      }
    }

    // Check if PR was already merged
    try {
      const { stdout } = await execAsync(
        `gh pr view ${prNumber} --repo ${owner}/${repo} --json state`,
        { timeout: GH_CLI_TIMEOUT },
      )
      const pr = JSON.parse(stdout)
      if (pr.state === 'MERGED') {
        return { state: 'merged', checksStatus: [] }
      }
    } catch {
      // Fall through to not-queued
    }

    return { state: 'not-queued', checksStatus: [] }
  }

  /**
   * Remove a PR from the local merge queue.
   */
  async dequeue(owner: string, repo: string, prNumber: number): Promise<void> {
    const repoId = `${owner}/${repo}`
    await this.storage.remove(repoId, prNumber)
  }

  /**
   * Local merge queue is always available (no external service dependency).
   */
  async isEnabled(_owner: string, _repo: string): Promise<boolean> {
    return true
  }
}
