/**
 * Merge Worker — Single-Instance Processor
 *
 * Implements the core rebase -> resolve conflicts -> regenerate lock files -> test -> merge loop.
 * Acquires a Redis lock to ensure only one worker processes a given repository's queue at a time.
 * Uses heartbeat to extend the lock TTL while processing, and supports graceful shutdown.
 *
 * All external dependencies (storage, redis) are injected via MergeWorkerDeps for testability.
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import { createMergeStrategy } from './strategies/index.js'
import { ConflictResolver } from './conflict-resolver.js'
import { LockFileRegeneration } from './lock-file-regeneration.js'
import type { MergeContext } from './strategies/types.js'
import type { ConflictResolverConfig } from './conflict-resolver.js'
import type { PackageManager } from './lock-file-regeneration.js'
import type { IssueTrackerClient } from '../orchestrator/issue-tracker-client.js'
import {
  loadQualityRatchet,
  checkQualityRatchet,
  updateQualityRatchet,
  formatRatchetResult,
} from '../orchestrator/quality-ratchet.js'
import { captureQualityBaseline, type QualityConfig } from '../orchestrator/quality-baseline.js'
import type { VersionControlProvider, ProposalRef, MergeQueueOpts, VCSMergeResult } from '../vcs/types.js'

const exec = promisify(execCb)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MergeWorkerConfig {
  repoId: string
  repoPath: string
  strategy: 'rebase' | 'merge' | 'squash'
  testCommand: string
  testTimeout: number
  lockFileRegenerate: boolean
  mergiraf: boolean
  pollInterval: number
  maxRetries: number
  escalation: {
    onConflict: 'reassign' | 'notify' | 'park'
    onTestFailure: 'notify' | 'park' | 'retry'
  }
  deleteBranchOnMerge: boolean
  packageManager: PackageManager
  remote: string // default 'origin'
  targetBranch: string // default 'main'
  /**
   * Status names the worker uses when bubbling merge results back to the
   * issue tracker. Defaults match Linear conventions ('Accepted'/'Rejected')
   * and only matter when `deps.issueTracker` is supplied.
   */
  acceptedStatus?: string
  rejectedStatus?: string
  /**
   * In-process backoffs (ms) used when a strategy's prepare() returns
   * `retryable: true`. The worker sleeps each value in order, retrying
   * prepare() between sleeps; if all retries are exhausted the PR falls
   * through to the normal error path.
   *
   * This path is defense-in-depth — the strategies use detached checkouts
   * so the branch-conflict error that originally motivated this retry loop
   * shouldn't surface in the first place. Kept here so any future transient
   * condition (including the same conflict reappearing through a different
   * codepath) degrades gracefully.
   *
   * Default: [5000, 15000, 30000] — ~50s total budget, tuned so the worker
   * doesn't stall the rest of the queue too long on a pathological case.
   */
  retryablePrepareBackoffsMs?: number[]
  /**
   * Maximum time (ms) the worker waits for GitHub to mark a PR as MERGED
   * after `strategy.finalize()` fast-forwards the target branch. Once the
   * PR transitions to MERGED, the worker proceeds to delete the source
   * branch. If the timeout elapses without the transition, the worker
   * deletes the branch anyway and logs a warning — the PR will show
   * CLOSED-not-merged in that case.
   *
   * Default: 30_000 (30s). Lowered in tests to keep them fast.
   */
  mergeRecordedTimeoutMs?: number
  /**
   * Lifetime (seconds) of the local "recently merged" marker written to
   * Redis on every successful merge. Pre-flight consults this marker
   * before the GitHub `getPRState` call — present means a previous run
   * already merged this PR and the duplicate dequeue should `noop`.
   *
   * The marker exists because GitHub's PR-state propagation can lag the
   * actual merge by a few seconds; during that window pre-flight sees
   * `state: OPEN` and would otherwise fall through to `prepare()`, which
   * then fails on the just-deleted source branch and bubbles a spurious
   * Rejected status. The local marker is authoritative and not subject
   * to that race.
   *
   * Default: 600 (10 min). Long enough to cover any plausible duplicate
   * dequeue; short enough that the key set doesn't grow unbounded.
   */
  recentlyMergedTtlSeconds?: number
}

/** Default in-process backoffs for retryable prepare failures. */
export const DEFAULT_RETRYABLE_PREPARE_BACKOFFS_MS = [5_000, 15_000, 30_000] as const

/** Default lifetime of the local "recently merged" marker (10 minutes). */
export const DEFAULT_RECENTLY_MERGED_TTL_SECONDS = 600

/**
 * Redis key tracking PRs whose merge already succeeded in this repo. The
 * worker writes it on every `merged` outcome and consults it in pre-flight
 * before the GitHub `getPRState` call.
 *
 * Exported so other queue components (e.g., the bubble-up backstop) can
 * agree on the key shape without depending on the worker class.
 */
export function recentlyMergedKey(repoId: string, prNumber: number): string {
  return `merge:completed:${repoId}:${prNumber}`
}

export interface MergeWorkerDeps {
  storage: {
    dequeue(repoId: string): Promise<any | null>
    markCompleted(repoId: string, prNumber: number): Promise<void>
    markFailed(repoId: string, prNumber: number, reason: string): Promise<void>
    markBlocked(repoId: string, prNumber: number, reason: string): Promise<void>
    /** Peek all queued entries without removing (used by MergePool) */
    peekAll(repoId: string): Promise<Array<{ prNumber: number; sourceBranch: string }>>
    /** Atomically dequeue multiple PRs for parallel processing (used by MergePool) */
    dequeueBatch(repoId: string, prNumbers: number[]): Promise<Array<{ prNumber: number }>>
  }
  redis: {
    setNX(key: string, value: string, ttlSeconds?: number): Promise<boolean>
    del(key: string): Promise<void>
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    expire(key: string, seconds: number): Promise<void>
  }
  /** Optional file reservation checker for pre-merge conflict detection */
  fileReservation?: {
    checkFileConflicts(
      repoId: string,
      sessionId: string,
      filePaths: string[],
    ): Promise<Array<{ filePath: string; heldBy: { sessionId: string } }>>
  }
  /**
   * Optional issue tracker. When supplied, merge results bubble back to the
   * originating issue: success posts a comment + transitions to Accepted;
   * conflict / test-failure / error posts a comment + transitions to
   * Rejected (which triggers the existing refinement flow).
   *
   * When absent, the worker behaves as before — failure reasons land in
   * Redis and a human running `af merge-queue status` is the only consumer.
   * This keeps the worker usable in non-Linear contexts and makes tests
   * trivial to set up.
   */
  issueTracker?: IssueTrackerClient
  /**
   * Optional PR labeler. When supplied, the worker removes the
   * `approved-for-merge` label from PRs that reach a terminal failure
   * state (conflict / test-failure / error). Without this, the sidecar's
   * label poller sees the label on the next tick and re-enqueues the same
   * PR, producing a `markFailed → poller re-enqueues → dequeue → markFailed`
   * hot loop that burns Redis traffic and hammers GitHub.
   *
   * Implementations are best-effort; failures are logged but do not crash
   * the worker loop. The refinement cycle is expected to re-add the label
   * when a subsequent acceptance run passes.
   *
   * Optional `getPRState` provides a pre-flight check before processing.
   * The sidecar's label poller can enqueue the same PR multiple times
   * across ticks (the label removal that prevents this only happens
   * AFTER the first dequeue). Without this check, the worker dequeues a
   * stale entry, can't fetch the just-deleted source branch, returns
   * `error`, and bubbles a spurious Rejected status to a PR that
   * actually merged cleanly. With the check, duplicate entries no-op
   * silently — the queue advances without re-running the bubble-up.
   */
  prLabeler?: {
    removeApprovedForMergeLabel(prNumber: number): Promise<void>
    getPRState?(prNumber: number): Promise<PRState | null>
  }
  /**
   * Optional VCS provider. When supplied, the merge-queue uses the provider's
   * capability flags to gate serialization logic:
   *
   *   - `capabilities.hasMergeQueue = true`  → standard queue serialization (git path)
   *   - `capabilities.hasMergeQueue = false` → commutative VCS path (Atomic); the
   *     worker calls `provider.mergeProposal()` directly without queuing.
   *
   * When absent, the worker behaves as before — git semantics are assumed and
   * the existing rebase/test/push pipeline runs unconditionally. This preserves
   * backward compatibility for callers that do not configure a VCS provider.
   *
   * See: donmai-architecture/008-version-control-providers.md §Merge queue logic
   */
  vcsProvider?: VersionControlProvider
}

/** Subset of GitHub PR state used for pre-flight skip detection. */
export interface PRState {
  /** GitHub PR state. CLOSED with `mergedAt` set means merged. */
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  /** ISO timestamp when the PR merged, or null if never merged. */
  mergedAt: string | null
}

export interface MergeProcessResult {
  prNumber: number
  /**
   * `noop` is set when a pre-flight check determines the PR is already
   * handled (merged or closed) and the queue entry is stale. The worker
   * pops it from storage but skips the issue bubble-up and label removal
   * (both already done by the original processing run). Distinct from
   * `merged` to avoid double-posting `✅ Merged` on duplicate entries.
   */
  status: 'merged' | 'noop' | 'conflict' | 'test-failure' | 'error'
  message?: string
}

/**
 * Build the Linear comment body for a merge result. Exported for testing.
 */
export function formatMergeResultComment(
  kind: 'merged' | 'conflict' | 'test-failure' | 'error',
  prUrl: string,
  detail?: string,
): string {
  switch (kind) {
    case 'merged':
      return [
        '## ✅ Merged by the merge queue',
        '',
        `${prUrl}`,
        '',
        detail ? `> ${detail}` : '',
      ].filter(Boolean).join('\n')

    case 'conflict':
      return [
        '## ⛔ Merge conflict — sending to refinement',
        '',
        `${prUrl}`,
        '',
        'The merge queue could not resolve conflicts automatically.',
        detail ? `\n${codeBlock(detail)}` : '',
      ].filter(Boolean).join('\n')

    case 'test-failure':
      return [
        '## ❌ Tests failed during merge — sending to refinement',
        '',
        `${prUrl}`,
        '',
        'The merge queue rebased the branch onto latest main and re-ran the test suite. The tests failed against the rebased code, indicating a real conflict between this PR and changes already on main.',
        detail ? `\n${codeBlock(detail)}` : '',
      ].filter(Boolean).join('\n')

    case 'error':
      return [
        '## ⚠️ Merge queue error — sending to refinement',
        '',
        `${prUrl}`,
        '',
        'An unexpected error occurred while processing this PR through the merge queue.',
        detail ? `\n${codeBlock(detail)}` : '',
      ].filter(Boolean).join('\n')
  }
}

/** Wrap a string in a fenced code block, truncating very long output. */
function codeBlock(s: string): string {
  const MAX = 4000
  const truncated = s.length > MAX ? s.slice(0, MAX) + '\n…(truncated)' : s
  return '```\n' + truncated + '\n```'
}

// ---------------------------------------------------------------------------
// VCS capability-gated merge helper (008-version-control-providers.md)
// ---------------------------------------------------------------------------

/**
 * Safely merge a proposal via the VCS provider, branching on whether push
 * serialization is required.
 *
 * Per 008 §Merge queue logic — gated, not hard-wired:
 *
 *   - `hasMergeQueue = false` → commutative VCS (Atomic). Pushes commute by
 *     construction; the worker calls `mergeProposal()` directly.
 *   - `hasMergeQueue = true`  → git-shaped. Serialization is required; the
 *     caller is responsible for the queue (this function just calls
 *     `enqueueForMerge`).
 *
 * Returns a VCSMergeResult. `auto-resolved` MUST be surfaced to callers —
 * never silently treated as `clean`.
 *
 * When `provider` is not supplied, returns null (caller falls back to the
 * existing git rebase pipeline).
 *
 * @internal Exported for unit-testing the capability-gated path.
 */
export async function mergeProposalSafely(
  provider: VersionControlProvider | undefined,
  ref: ProposalRef,
  queueOpts?: MergeQueueOpts,
): Promise<VCSMergeResult | null> {
  if (!provider) return null

  if (!provider.capabilities.hasMergeQueue) {
    // Commutative VCS — pushes commute by construction (Atomic path).
    // Call mergeProposal directly without queue serialization.
    if (!provider.mergeProposal) {
      // Provider declared hasPullRequests = false — commutative VCS with no PR concept.
      // The push itself is the merge; nothing to do here.
      return { kind: 'clean' }
    }
    return await provider.mergeProposal(ref, 'auto')
  }

  // Git-shaped VCS — enqueue for serialized merge.
  if (!provider.enqueueForMerge) {
    // Provider declared hasMergeQueue = true but didn't implement enqueueForMerge.
    // This is a capability mismatch; fall back to direct merge.
    if (!provider.mergeProposal) return { kind: 'clean' }
    return await provider.mergeProposal(ref, 'auto')
  }

  // Enqueue — the caller is responsible for polling the ticket to completion.
  await provider.enqueueForMerge(ref, queueOpts ?? {})
  // Return clean to indicate the PR was successfully queued.
  // The actual merge result will be determined by the queue processing.
  return { kind: 'clean' }
}

// ---------------------------------------------------------------------------
// MergeWorker
// ---------------------------------------------------------------------------

export class MergeWorker {
  private running = false
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private config: MergeWorkerConfig,
    private deps: MergeWorkerDeps,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the merge worker. Acquires a lock, then loops processing the queue.
   */
  async start(signal?: AbortSignal): Promise<void> {
    // Acquire single-instance lock
    const lockKey = `merge:lock:${this.config.repoId}`
    const acquired = await this.deps.redis.setNX(lockKey, 'worker', 300) // 5 min TTL
    if (!acquired) {
      throw new Error(`Another merge worker is already running for repo ${this.config.repoId}`)
    }

    this.running = true
    this.startHeartbeat(lockKey)

    try {
      while (this.running && !(signal?.aborted)) {
        // Check if paused
        const paused = await this.deps.redis.get(`merge:paused:${this.config.repoId}`)
        if (paused) {
          await this.sleep(this.config.pollInterval, signal)
          continue
        }

        // Try to dequeue next PR
        const entry = await this.deps.storage.dequeue(this.config.repoId)
        if (!entry) {
          // Queue empty — poll interval wait
          await this.sleep(this.config.pollInterval, signal)
          continue
        }

        // Process the PR
        const result = await this.processEntry(entry)

        // Handle result — Redis storage marking AND issue-tracker bubble-up.
        // The two are independent: storage state is for the CLI; the bubble-up
        // is the source of truth for downstream agents (refinement on Rejected,
        // termination on Accepted). Either side failing must not block the
        // queue from advancing.
        switch (result.status) {
          case 'merged':
            await this.deps.storage.markCompleted(this.config.repoId, result.prNumber)
            // Local "recently merged" marker, written before bubble-up so a
            // duplicate dequeue racing the bubble sees it. GitHub-independent
            // — closes the residual window where `getPRState` still reports
            // OPEN because the PR-state transition hasn't propagated yet.
            await this.markRecentlyMerged(result.prNumber)
            await this.bubbleResultToIssue(entry, result, 'merged')
            // Remove the label even on success: GitHub's PR-state update is
            // async, so `gh pr list --state open --label approved-for-merge`
            // can still include the just-merged PR for ~10s afterwards.
            // Without this, the label poller re-enqueues the PR, the worker
            // tries to fetch the already-deleted source branch, and marks
            // it failed — bubbling a spurious Rejected status to Linear for
            // a PR that actually merged cleanly.
            //
            // Pre-flight `getPRState` blocks the duplicate from re-running
            // the merge work, but the label still has to come off so we
            // don't accumulate stale queue entries.
            await this.removeApprovedForMergeLabel(result.prNumber)
            break
          case 'noop':
            // Stale duplicate entry — original run already merged + bubbled
            // + removed the label. Silently complete to advance the queue.
            await this.deps.storage.markCompleted(this.config.repoId, result.prNumber)
            break
          case 'conflict':
            await this.deps.storage.markBlocked(this.config.repoId, result.prNumber, result.message ?? 'Merge conflict')
            await this.bubbleResultToIssue(entry, result, 'conflict')
            await this.removeApprovedForMergeLabel(result.prNumber)
            break
          case 'test-failure': {
            const action = this.config.escalation.onTestFailure
            if (action === 'park') {
              await this.deps.storage.markBlocked(this.config.repoId, result.prNumber, result.message ?? 'Tests failed')
            } else {
              await this.deps.storage.markFailed(this.config.repoId, result.prNumber, result.message ?? 'Tests failed')
            }
            // Park demotes the issue too — it's still a "merge didn't happen"
            // signal to refinement, even if we may auto-retry later.
            await this.bubbleResultToIssue(entry, result, 'test-failure')
            await this.removeApprovedForMergeLabel(result.prNumber)
            break
          }
          case 'error':
            await this.deps.storage.markFailed(this.config.repoId, result.prNumber, result.message ?? 'Unknown error')
            await this.bubbleResultToIssue(entry, result, 'error')
            await this.removeApprovedForMergeLabel(result.prNumber)
            break
        }
      }
    } finally {
      // Graceful shutdown — release lock
      this.stopHeartbeat()
      await this.deps.redis.del(lockKey)
      this.running = false
    }
  }

  /**
   * Stop the merge worker gracefully (finishes current merge before stopping).
   */
  stop(): void {
    this.running = false
  }

  /**
   * Process a single queue entry: rebase -> resolve conflicts -> regenerate lock files -> test -> merge
   */
  async processEntry(entry: {
    prNumber: number
    sourceBranch: string
    targetBranch?: string
    issueIdentifier?: string
    prUrl?: string
  }): Promise<MergeProcessResult> {
    const strategy = createMergeStrategy(this.config.strategy)
    const conflictResolver = new ConflictResolver({
      mergirafEnabled: this.config.mergiraf,
      escalationStrategy: this.config.escalation.onConflict,
    } satisfies ConflictResolverConfig)
    const lockFileHandler = new LockFileRegeneration()

    const ctx: MergeContext = {
      repoPath: this.config.repoPath,
      worktreePath: this.config.repoPath, // In production, would use a dedicated worktree
      sourceBranch: entry.sourceBranch,
      targetBranch: entry.targetBranch ?? this.config.targetBranch,
      prNumber: entry.prNumber,
      remote: this.config.remote,
    }

    try {
      // 0. Pre-flight: skip if the PR is already merged or closed.
      //
      // The label poller can enqueue the same PR across multiple ticks before
      // the worker has a chance to remove the `approved-for-merge` label.
      // Once the first dequeue merges + deletes the source branch, every
      // subsequent dequeue would crash in `prepare()` with "couldn't find
      // remote ref" and bubble a spurious Rejected status to the issue —
      // exactly the failure mode that took out.
      //
      // We treat any non-OPEN state as already-handled and short-circuit
      // with `noop` so the queue advances without re-running bubble-up.
      // No-op when `getPRState` is unwired — keeps non-GitHub deployments
      // working as before.
      //
      // 0a. Local marker first. The success path writes
      // `merge:completed:<repo>:<pr>` to Redis with a short TTL. This is
      // authoritative regardless of GitHub's PR-state propagation, which
      // can lag the merge by several seconds and let a duplicate dequeue
      // pass the `getPRState` check below.
      try {
        const marker = await this.deps.redis.get(
          recentlyMergedKey(this.config.repoId, entry.prNumber),
        )
        if (marker) {
          return {
            prNumber: entry.prNumber,
            status: 'noop',
            message: 'PR already merged (local marker)',
          }
        }
      } catch {
        // Best-effort. A Redis blip here just falls through to the
        // GitHub-side check, which is the previous behavior.
      }
      if (this.deps.prLabeler?.getPRState) {
        try {
          const prState = await this.deps.prLabeler.getPRState(entry.prNumber)
          if (prState && prState.state !== 'OPEN') {
            return {
              prNumber: entry.prNumber,
              status: 'noop',
              message: `PR already ${prState.state.toLowerCase()}${prState.mergedAt ? ` (merged at ${prState.mergedAt})` : ''}`,
            }
          }
        } catch {
          // Pre-flight is best-effort. If the API call fails, fall through
          // and let the strategies handle it — better to risk one spurious
          // failure than to skip a PR that actually needed processing.
        }
      }

      // 1. Prepare: fetch latest main.
      //
      // Transient prepare failures (strategy returns `retryable: true` — e.g.,
      // an acceptance agent's `<ISSUE>-AC` worktree still holds the branch
      // during handoff) are retried in-process with backoff before surfacing
      // to the issue as a hard failure. The strategies' detached checkouts
      // should prevent this from ever being hit in practice, but we keep the
      // retry loop as defense-in-depth — the alternative (dead-ending every
      // PR that loses the teardown race) is much worse than briefly stalling
      // the queue.
      const backoffs =
        this.config.retryablePrepareBackoffsMs ?? [...DEFAULT_RETRYABLE_PREPARE_BACKOFFS_MS]
      let prepareResult = await strategy.prepare(ctx)
      for (let i = 0; !prepareResult.success && prepareResult.retryable && i < backoffs.length; i++) {
        console.log(
          `[merge-worker] prepare returned retryable error for PR #${entry.prNumber}: ${prepareResult.error}. ` +
          `Retrying in ${backoffs[i]}ms (attempt ${i + 2}/${backoffs.length + 1})`,
        )
        await this.sleep(backoffs[i])
        prepareResult = await strategy.prepare(ctx)
      }
      if (!prepareResult.success) {
        // The strategy detected that the source branch no longer exists on
        // the remote — almost always because a previous successful merge
        // for this PR already deleted it. Treat as `noop` so the queue
        // advances quietly instead of bubbling Rejected on a PR that
        // actually merged cleanly. (belt-and-braces with the
        // local marker check above — covers the case where the marker has
        // expired or was lost across worker restarts.)
        if (prepareResult.alreadyMerged) {
          return {
            prNumber: entry.prNumber,
            status: 'noop',
            message: 'Source branch missing on remote (already merged)',
          }
        }
        return { prNumber: entry.prNumber, status: 'error', message: `Prepare failed: ${prepareResult.error}` }
      }

      // 1.5 Optional: check if modified files are reserved by active sessions
      if (this.deps.fileReservation) {
        try {
          const { stdout } = await exec(
            `git diff --name-only ${ctx.remote}/${ctx.targetBranch}...${ctx.sourceBranch}`,
            { cwd: ctx.repoPath },
          )
          const modifiedFiles = stdout.trim().split('\n').filter(Boolean)
          if (modifiedFiles.length > 0) {
            const conflicts = await this.deps.fileReservation.checkFileConflicts(
              this.config.repoId,
              `merge-worker-${entry.prNumber}`,
              modifiedFiles,
            )
            if (conflicts.length > 0) {
              const conflictList = conflicts.map(c => `${c.filePath} (held by ${c.heldBy.sessionId})`).join(', ')
              return {
                prNumber: entry.prNumber,
                status: 'conflict',
                message: `Files reserved by active sessions: ${conflictList}`,
              }
            }
          }
        } catch {
          // File reservation check is best-effort; don't block merge on check failure
        }
      }

      // 2. Execute merge strategy (rebase/merge/squash)
      const mergeResult = await strategy.execute(ctx)

      // 3. Handle conflicts
      if (mergeResult.status === 'conflict') {
        const resolution = await conflictResolver.resolve({
          repoPath: ctx.repoPath,
          worktreePath: ctx.worktreePath,
          sourceBranch: ctx.sourceBranch,
          targetBranch: ctx.targetBranch,
          prNumber: ctx.prNumber,
          issueIdentifier: entry.issueIdentifier ?? `PR-${entry.prNumber}`,
          conflictFiles: mergeResult.conflictFiles ?? [],
          conflictDetails: mergeResult.conflictDetails,
        })

        if (resolution.status !== 'resolved') {
          return {
            prNumber: entry.prNumber,
            status: 'conflict',
            message: resolution.message ?? `Unresolved conflicts in: ${(resolution.unresolvedFiles ?? []).join(', ')}`,
          }
        }
      } else if (mergeResult.status === 'error') {
        return { prNumber: entry.prNumber, status: 'error', message: mergeResult.error ?? 'Merge strategy failed' }
      }

      // 4. Regenerate lock files if configured
      if (lockFileHandler.shouldRegenerate(this.config.packageManager, this.config.lockFileRegenerate)) {
        const regenResult = await lockFileHandler.regenerate(ctx.worktreePath, this.config.packageManager)
        if (!regenResult.success) {
          return { prNumber: entry.prNumber, status: 'error', message: `Lock file regeneration failed: ${regenResult.error}` }
        }
      }

      // 5. Run test suite
      const testResult = await this.runTests(ctx.worktreePath)
      if (!testResult.passed) {
        return { prNumber: entry.prNumber, status: 'test-failure', message: testResult.output }
      }

      // 5.5. Quality ratchet check (if ratchet file exists)
      const ratchet = loadQualityRatchet(ctx.worktreePath)
      if (ratchet) {
        const qualityConfig: QualityConfig = {
          testCommand: this.config.testCommand,
          packageManager: this.config.packageManager as string,
        }
        const current = captureQualityBaseline(ctx.worktreePath, qualityConfig)
        if (current.tests.parseError) {
          // Log loudly — the ratchet's testCount threshold is being skipped
          // for this PR. Silent would hide degradations; failing the PR
          // would block merges for reasons orthogonal to code quality.
          console.warn(
            `[merge-worker] Quality baseline could not parse test counts for PR #${entry.prNumber}: ${current.tests.parseError}. Skipping testCount threshold.`,
          )
        }
        const ratchetResult = checkQualityRatchet(ratchet, current)
        if (!ratchetResult.passed) {
          return {
            prNumber: entry.prNumber,
            status: 'test-failure',
            message: `Quality ratchet violated: ${formatRatchetResult(ratchetResult)}`,
          }
        }

        // Tighten ratchet if metrics improved (will be included in the merge)
        const updated = updateQualityRatchet(
          ctx.worktreePath,
          current,
          entry.issueIdentifier ?? `PR-${entry.prNumber}`,
        )
        if (updated) {
          try {
            await exec(
              'git add .donmai/quality-ratchet.json && git commit -m "chore: tighten quality ratchet"',
              { cwd: ctx.worktreePath },
            )
          } catch {
            // Ratchet update commit is best-effort
          }
        }
      }

      // 6. Finalize: push and merge
      await strategy.finalize(ctx)

      // 6.5. Wait for GitHub to record the merge before deleting the branch.
      //
      // The rebase strategy fast-forwards `main` on the remote via
      // `git push <rebasedSha>:main`. GitHub auto-detects this push as a
      // merge of any open PR whose HEAD is in the new `main` history and
      // transitions the PR to MERGED with `mergedAt` set. If we delete the
      // source branch before that detection runs, GitHub processes the
      // branch-delete first and closes the PR with `state: CLOSED,
      // mergedAt: null` — `git log main` then looks like a series of
      // direct-to-main commits with no associated PR (the prior
      // failure mode).
      //
      // Polling getPRState until the PR is MERGED is a defensive sleep
      // that closes that race. Best-effort: if the API call isn't wired
      // (non-GitHub deployments) or polling times out, fall through to
      // the unconditional delete — worst case the PR shows CLOSED instead
      // of MERGED, no other harm.
      await this.waitForPRMergeRecorded(entry.prNumber)

      // 7. Delete branch if configured
      if (this.config.deleteBranchOnMerge) {
        try {
          await exec(`git push ${this.config.remote} --delete ${entry.sourceBranch}`, {
            cwd: ctx.worktreePath,
          })
        } catch {
          // Branch deletion failure is non-fatal
        }
      }

      return { prNumber: entry.prNumber, status: 'merged' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { prNumber: entry.prNumber, status: 'error', message }
    }
  }

  // ---------------------------------------------------------------------------
  // Issue tracker bubble-up
  // ---------------------------------------------------------------------------

  /**
   * Bubble a merge result back to the originating issue: comment + status
   * transition. Best-effort — never throws back to the queue loop. The
   * status transition is the source of truth (comment is for humans).
   *
   * No-op when:
   *   - deps.issueTracker is not configured (worker runs in
   *     non-tracker contexts, e.g., OSS users without Linear)
   *   - the queue entry has no usable issueIdentifier (anonymous PRs
   *     enqueued via CLI rather than from an issue-driven flow)
   *
   * Status mapping:
   *   - 'merged'        → acceptedStatus  (default 'Accepted')
   *   - 'conflict'      → rejectedStatus  (default 'Rejected') — refinement picks up
   *   - 'test-failure'  → rejectedStatus
   *   - 'error'         → rejectedStatus
   */
  private async bubbleResultToIssue(
    entry: { issueIdentifier?: string; prUrl?: string; prNumber: number },
    result: MergeProcessResult,
    kind: 'merged' | 'conflict' | 'test-failure' | 'error',
  ): Promise<void> {
    const tracker = this.deps.issueTracker
    if (!tracker) return

    // Skip anonymous queue entries — `PR-N` placeholder means we never
    // resolved a real issue identifier at enqueue time. Logging the
    // outcome to a fake ticket would be worse than silence.
    const id = entry.issueIdentifier
    if (!id || /^PR-\d+$/.test(id)) return

    const acceptedStatus = this.config.acceptedStatus ?? 'Accepted'
    const rejectedStatus = this.config.rejectedStatus ?? 'Rejected'
    const targetStatus = kind === 'merged' ? acceptedStatus : rejectedStatus

    const prUrl = entry.prUrl ?? `PR #${entry.prNumber}`
    const body = formatMergeResultComment(kind, prUrl, result.message)

    let issueId: string
    try {
      const issue = await tracker.getIssue(id)
      issueId = issue.id
    } catch (err) {
      // Issue may have been archived or the tracker is unreachable.
      // Don't crash the queue — log to stderr and move on.
      console.error(`[merge-worker] Failed to resolve issue ${id} for bubble-up:`, err instanceof Error ? err.message : err)
      return
    }

    // Comment first (best-effort), then status transition. Either failing
    // is logged but not re-thrown — the queue must keep advancing.
    try {
      await tracker.createComment(issueId, body)
    } catch (err) {
      console.error(`[merge-worker] Failed to post merge-result comment to ${id}:`, err instanceof Error ? err.message : err)
    }

    try {
      await tracker.updateIssueStatus(issueId, targetStatus)
    } catch (err) {
      console.error(`[merge-worker] Failed to transition ${id} → ${targetStatus}:`, err instanceof Error ? err.message : err)
    }
  }

  /**
   * Write the local "recently merged" marker so duplicate dequeues short-
   * circuit in pre-flight regardless of GitHub's PR-state propagation.
   *
   * Best-effort — a Redis write failure here doesn't fail the merge (it
   * already happened). Worst case the duplicate falls through to the
   * GitHub-state pre-flight or to `prepare()`, which now also detects
   * the missing-remote-ref error and treats it as `noop`.
   */
  private async markRecentlyMerged(prNumber: number): Promise<void> {
    const ttl = this.config.recentlyMergedTtlSeconds ?? DEFAULT_RECENTLY_MERGED_TTL_SECONDS
    try {
      await this.deps.redis.setNX(
        recentlyMergedKey(this.config.repoId, prNumber),
        String(Date.now()),
        ttl,
      )
    } catch (err) {
      console.warn(
        `[merge-worker] Failed to write recently-merged marker for PR #${prNumber}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * Poll GitHub until the PR is recorded as MERGED, with a short timeout.
   *
   * Closes the race between (a) the rebase strategy's fast-forward push to
   * `main` and (b) our subsequent branch deletion. GitHub auto-detects the
   * merge from the push to base; deleting the source branch before that
   * detection lands closes the PR with `mergedAt: null`. Waiting for the
   * MERGED transition first lets the merge metadata be recorded properly.
   *
   * Best-effort: returns silently when getPRState isn't wired, when the
   * call fails, or when the timeout elapses. Worst case the PR shows
   * CLOSED-not-merged — the same outcome as before this change.
   */
  private async waitForPRMergeRecorded(prNumber: number): Promise<void> {
    const getPRState = this.deps.prLabeler?.getPRState
    if (!getPRState) return

    const timeoutMs = this.config.mergeRecordedTimeoutMs ?? 30_000
    const deadline = Date.now() + timeoutMs
    const intervalMs = 500
    while (Date.now() < deadline) {
      try {
        const state = await getPRState(prNumber)
        if (state?.state === 'MERGED') return
      } catch {
        // Treat API errors as "not yet" and keep polling within the budget.
      }
      await this.sleep(intervalMs)
    }
    console.warn(
      `[merge-worker] PR #${prNumber}: GitHub did not record the merge within ` +
      `${timeoutMs}ms after fast-forward push. Branch will be deleted regardless; ` +
      `PR may show CLOSED instead of MERGED.`,
    )
  }

  /**
   * Remove the `approved-for-merge` label from a PR that reached a terminal
   * failure state. Without this, the sidecar's label poller re-enqueues the
   * same PR on its next tick and the queue hot-loops between `markFailed`
   * and re-enqueue.
   *
   * No-op when no `prLabeler` is wired (non-GitHub deployments). The
   * refinement cycle re-adds the label when a later acceptance run passes.
   */
  private async removeApprovedForMergeLabel(prNumber: number): Promise<void> {
    if (!this.deps.prLabeler) return
    try {
      await this.deps.prLabeler.removeApprovedForMergeLabel(prNumber)
    } catch (err) {
      console.error(
        `[merge-worker] Failed to remove approved-for-merge label from PR #${prNumber}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async runTests(worktreePath: string): Promise<{ passed: boolean; output: string }> {
    try {
      const { stdout, stderr } = await exec(this.config.testCommand, {
        cwd: worktreePath,
        timeout: this.config.testTimeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      })
      return { passed: true, output: stdout + stderr }
    } catch (error) {
      const message = error instanceof Error ? (error as any).stdout ?? error.message : String(error)
      return { passed: false, output: message }
    }
  }

  private startHeartbeat(lockKey: string): void {
    // Extend lock TTL every 60 seconds
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.deps.redis.expire(lockKey, 300)
      } catch {
        // Heartbeat failure — will be handled by TTL expiry
      }
    }, 60_000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }
}
