/**
 * GitHubVCSProvider — OSS GitHub adapter
 *
 * Architecture reference: donmai-architecture/008-version-control-providers.md
 *
 * Implements VersionControlProvider using:
 *   - `git` CLI for clone, recordChange (stage+commit), push, pull
 *   - `gh` CLI for PR operations (openProposal, mergeProposal, enqueueForMerge)
 *
 * Provenance (attest) is faked via commit trailers:
 *   Co-Authored-By: <agent-name> <agent@rensei.dev>
 *   X-Rensei-Session-Id: <sessionId>
 *   X-Rensei-Kit-Set: spring/java@1.0.0,docker-compose@2.1.0
 *   X-Rensei-Workarea-Snapshot: <ref>
 *   X-Rensei-Model: anthropic/claude-opus-4-7
 *
 * For real Ed25519 signing (provenanceNative: true tenants) see.
 */

import { exec as execCb } from 'child_process'
import { promisify } from 'util'
import type {
  VersionControlProvider,
  Workspace,
  CloneOpts,
  ChangeRequest,
  ChangeRef,
  PushTarget,
  PushResult,
  PullSource,
  VCSMergeResult,
  ProposalOpts,
  ProposalRef,
  MergeStrategy,
  MergeQueueOpts,
  QueueTicket,
  Conflict,
  Resolution,
  SessionAttestation,
  AttestationRef,
} from './types.js'
import { assertCapability } from './types.js'
import type {
  ProviderManifest,
  ProviderScope,
  ProviderSignature,
  ProviderHost,
  VersionControlProviderCapabilities,
} from '../providers/base.js'

const exec = promisify(execCb)

/** Timeout for git CLI operations (60s) */
const GIT_TIMEOUT = 60_000

/** Timeout for gh CLI operations (30s) */
const GH_TIMEOUT = 30_000

// ---------------------------------------------------------------------------
// Capabilities declaration
// ---------------------------------------------------------------------------

export const GITHUB_VCS_CAPABILITIES: VersionControlProviderCapabilities = {
  // Merge model — git uses three-way text merge with line-level conflicts
  mergeStrategy: 'three-way-text',
  mergeModel: 'three-way-text',
  conflictGranularity: 'line',

  // Patch theory vs commit graph — git family uses a content-addressed DAG
  patchModel: 'commit-graph',

  // Proposal / review — GitHub has full PR + merge-queue support
  hasPullRequests: true,
  hasReviewWorkflow: true,
  hasMergeQueue: true,

  // Branching — standard git refs
  branchSemantics: 'git-branches',
  supportsBranches: true,
  supportsRebase: true,

  // Identity & trust — email-based author identity, smart-HTTP remote
  identityScheme: 'email',
  remoteProtocol: 'git-smart-http',
  provenanceNative: false,

  // Audit chain — git fakes attestation via commit trailers (X-Rensei-*)
  auditModel: 'commit-trailer',
  supportsAttest: true,

  // Content shape — supports binary (LFS for large files); not structured
  supportsBinary: true,
  supportsStructuredContent: false,
  supportsLargeFiles: false,
}

// ---------------------------------------------------------------------------
// GitHubVCSProvider
// ---------------------------------------------------------------------------

export class GitHubVCSProvider implements VersionControlProvider {
  readonly manifest: ProviderManifest<'vcs'>
  readonly capabilities: VersionControlProviderCapabilities
  readonly scope: ProviderScope
  readonly signature: ProviderSignature | null

  constructor(opts?: {
    scope?: ProviderScope
    signature?: ProviderSignature | null
    /** Override to signal hasMergeQueue = false for repos without GitHub merge queue enabled */
    hasMergeQueue?: boolean
  }) {
    this.capabilities = opts?.hasMergeQueue === false
      ? { ...GITHUB_VCS_CAPABILITIES, hasMergeQueue: false }
      : GITHUB_VCS_CAPABILITIES

    this.scope = opts?.scope ?? { level: 'global' }
    this.signature = opts?.signature ?? null

    this.manifest = {
      apiVersion: 'rensei.dev/v1',
      family: 'vcs',
      id: 'github',
      version: '1.0.0',
      name: 'GitHub VCS Provider',
      description: 'git + gh CLI adapter for GitHub repositories',
      author: 'Rensei AI',
      homepage: 'https://github.com/RenseiAI/donmai-libraries',
      license: 'MIT',
      repository: 'https://github.com/RenseiAI/donmai-libraries',
      requires: { rensei: '>=0.8.0' },
      entry: { kind: 'static', modulePath: 'packages/core/src/vcs/github.js' },
      capabilitiesDeclared: this.capabilities,
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async activate(_host: ProviderHost): Promise<void> {
    // Verify `git` and `gh` binaries are available
    await exec('git --version', { timeout: 5_000 }).catch(() => {
      throw new Error('GitHubVCSProvider: git CLI not found. Install git and ensure it is on PATH.')
    })
    // gh is only required for PR operations; don't block activation on its absence
    // (some deployments use pure git without GitHub PR integration)
  }

  async deactivate(): Promise<void> {
    // No long-lived resources to release
  }

  // ─── Required verbs ────────────────────────────────────────────────────────

  /**
   * Clone a repository to dst. Supports depth, ref, and singleBranch options.
   */
  async clone(uri: string, dst: string, opts?: CloneOpts): Promise<Workspace> {
    const parts: string[] = ['git', 'clone']

    if (opts?.depth) parts.push(`--depth=${opts.depth}`)
    if (opts?.singleBranch) parts.push('--single-branch')
    if (opts?.ref) parts.push(`--branch=${opts.ref}`)

    parts.push('--', uri, dst)

    await exec(parts.join(' '), { timeout: GIT_TIMEOUT })

    // Resolve HEAD ref after clone
    const { stdout: headRef } = await exec('git rev-parse HEAD', {
      cwd: dst,
      timeout: 5_000,
    })

    return {
      id: `github:${uri}`,
      providerId: this.manifest.id,
      path: dst,
      headRef: headRef.trim(),
    }
  }

  /**
   * Stage the given paths and create a commit.
   *
   * If an attestation is included, appends commit trailers so the provenance
   * metadata is recorded in git history.
   */
  async recordChange(ws: Workspace, change: ChangeRequest): Promise<ChangeRef> {
    const cwd = ws.path

    // Stage specified paths
    if (change.paths.length > 0) {
      const paths = change.paths.map(p => `"${p}"`).join(' ')
      await exec(`git add -- ${paths}`, { cwd, timeout: GIT_TIMEOUT })
    }

    // Build commit message with optional attestation trailers
    const message = change.attestation
      ? buildCommitMessageWithTrailers(change.message, change.attestation)
      : change.message

    // Escape the message for use with -m flag via a heredoc-like approach
    const msgFile = `/tmp/rensei-commit-msg-${Date.now()}.txt`
    const { writeFile, unlink } = await import('node:fs/promises')
    await writeFile(msgFile, message, 'utf8')

    try {
      await exec(`git commit -F "${msgFile}"`, { cwd, timeout: GIT_TIMEOUT })
    } finally {
      await unlink(msgFile).catch(() => { /* best-effort cleanup */ })
    }

    const { stdout: newSha } = await exec('git rev-parse HEAD', { cwd, timeout: 5_000 })
    const { stdout: logLine } = await exec('git log -1 --pretty=format:%s', { cwd, timeout: 5_000 })

    return {
      ref: newSha.trim(),
      recordedAt: new Date().toISOString(),
      summary: logLine.trim(),
    }
  }

  /**
   * Push a local ref to the remote.
   *
   * Returns `{ kind: 'pushed' }` on success or `{ kind: 'rejected' }` on
   * non-fast-forward, auth, or policy failure.
   */
  async push(ws: Workspace, target: PushTarget): Promise<PushResult> {
    const cwd = ws.path
    try {
      const { stdout: headSha } = await exec('git rev-parse HEAD', { cwd, timeout: 5_000 })
      await exec(
        `git push "${target.remote}" HEAD:"${target.ref}"`,
        { cwd, timeout: GIT_TIMEOUT },
      )
      return {
        kind: 'pushed',
        ref: {
          ref: headSha.trim(),
          recordedAt: new Date().toISOString(),
        },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const reason = classifyPushError(message)
      return { kind: 'rejected', reason, details: message }
    }
  }

  /**
   * Pull changes from a remote ref into the local working copy.
   *
   * Returns a VCSMergeResult. git does not auto-resolve — any conflict
   * is surfaced as `{ kind: 'conflict' }`.
   */
  async pull(ws: Workspace, source: PullSource): Promise<VCSMergeResult> {
    const cwd = ws.path
    try {
      await exec(
        `git pull "${source.remote}" "${source.ref}"`,
        { cwd, timeout: GIT_TIMEOUT },
      )
      return { kind: 'clean' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      // Check if git left merge conflict markers
      if (message.includes('CONFLICT') || message.includes('Automatic merge failed')) {
        const conflicts = await extractConflictFiles(cwd)
        return { kind: 'conflict', conflicts }
      }

      // Rethrow unexpected errors
      throw err
    }
  }

  // ─── Optional verbs ────────────────────────────────────────────────────────

  /**
   * Open a GitHub Pull Request using the `gh` CLI.
   *
   * Gate: capabilities.hasPullRequests
   */
  async openProposal(ws: Workspace, opts: ProposalOpts): Promise<ProposalRef> {
    assertCapability(this.capabilities, 'hasPullRequests', this.manifest.id)

    const args: string[] = [
      'gh', 'pr', 'create',
      '--base', opts.baseRef,
      '--title', shellEscape(opts.title),
      '--body', shellEscape(opts.body),
    ]

    if (opts.reviewers?.length) {
      args.push('--reviewer', opts.reviewers.join(','))
    }
    if (opts.labels?.length) {
      args.push('--label', opts.labels.join(','))
    }

    const { stdout } = await exec(args.join(' '), {
      cwd: ws.path,
      timeout: GH_TIMEOUT,
    })

    // `gh pr create` outputs the PR URL on stdout
    const url = stdout.trim()
    const prNumber = parsePRNumberFromUrl(url)

    return {
      id: String(prNumber),
      url,
      state: 'open',
    }
  }

  /**
   * Merge a GitHub Pull Request.
   *
   * Gate: capabilities.hasPullRequests
   */
  async mergeProposal(ref: ProposalRef, strategy: MergeStrategy): Promise<VCSMergeResult> {
    assertCapability(this.capabilities, 'hasPullRequests', this.manifest.id)

    const mergeFlag = githubMergeFlag(strategy)
    try {
      await exec(
        `gh pr merge ${ref.id} ${mergeFlag} --delete-branch`,
        { timeout: GH_TIMEOUT },
      )
      return { kind: 'clean' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('conflict') || message.includes('CONFLICT')) {
        return {
          kind: 'conflict',
          conflicts: [{ filePath: '(unknown — check PR diff)', detail: message }],
        }
      }
      throw err
    }
  }

  /**
   * Enqueue a PR for GitHub's native merge queue.
   *
   * Gate: capabilities.hasMergeQueue
   */
  async enqueueForMerge(ref: ProposalRef, _opts: MergeQueueOpts): Promise<QueueTicket> {
    assertCapability(this.capabilities, 'hasMergeQueue', this.manifest.id)

    const prId = await this.getPRNodeId(ref.id)

    const mutation = `
      mutation($prId: ID!) {
        enqueuePullRequest(input: { pullRequestId: $prId }) {
          mergeQueueEntry {
            state
            position
            enqueuedAt
          }
        }
      }
    `
    const result = await this.graphql<{
      enqueuePullRequest: {
        mergeQueueEntry: {
          state: string
          position: number
          enqueuedAt: string
        }
      }
    }>(mutation, { prId })

    const entry = result.enqueuePullRequest.mergeQueueEntry
    return {
      id: `${ref.id}:queue`,
      position: entry.position,
      enqueuedAt: entry.enqueuedAt ?? new Date().toISOString(),
    }
  }

  /**
   * Apply a resolution to a conflict in the working copy and stage it.
   */
  async resolveConflict(c: Conflict, resolution: Resolution): Promise<void> {
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')

    // Write the resolved content
    const absPath = join(c.filePath.startsWith('/') ? '' : '', c.filePath)
    await writeFile(absPath, resolution.content, 'utf8')
    await exec(`git add -- "${absPath}"`, { timeout: GIT_TIMEOUT })
  }

  /**
   * Attest a change with provenance metadata.
   *
   * For git: creates an empty attestation commit with all provenance trailers.
   * This stub uses Ed25519 signing scaffolding; real signing is.
   */
  async attest(ws: Workspace, sessionMetadata: SessionAttestation): Promise<AttestationRef> {
    const cwd = ws.path

    // Build the attestation commit message
    const trailers = buildAttestationTrailers(sessionMetadata)
    const message = `attestation: session ${sessionMetadata.sessionId}\n\n${trailers}`

    const msgFile = `/tmp/rensei-attest-${Date.now()}.txt`
    const { writeFile, unlink } = await import('node:fs/promises')
    await writeFile(msgFile, message, 'utf8')

    try {
      await exec(`git commit --allow-empty -F "${msgFile}"`, { cwd, timeout: GIT_TIMEOUT })
    } finally {
      await unlink(msgFile).catch(() => { /* best-effort */ })
    }

    const { stdout: sha } = await exec('git rev-parse HEAD', { cwd, timeout: 5_000 })

    return {
      id: sha.trim(),
      storageKind: 'commit-trailer',
      attestedAt: new Date().toISOString(),
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /** Get the GraphQL node ID for a PR */
  private async getPRNodeId(prNumber: string): Promise<string> {
    const query = `
      query($prNumber: Int!) {
        repository {
          pullRequest(number: $prNumber) {
            id
          }
        }
      }
    `
    const result = await this.graphql<{
      repository: { pullRequest: { id: string } }
    }>(query, { prNumber: parseInt(prNumber, 10) })
    return result.repository.pullRequest.id
  }

  /** Execute a GraphQL query/mutation via gh CLI */
  private async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const varsArgs = Object.entries(variables)
      .map(([key, value]) => {
        if (typeof value === 'number') return `-F ${key}=${value}`
        return `-f ${key}=${String(value)}`
      })
      .join(' ')

    const command = `gh api graphql -f query='${query.replace(/'/g, "'\\''")}' ${varsArgs}`
    const { stdout } = await exec(command, { timeout: GH_TIMEOUT })
    const response = JSON.parse(stdout)
    if (response.errors?.length) {
      throw new Error(response.errors.map((e: { message: string }) => e.message).join('; '))
    }
    return response.data as T
  }
}

// ---------------------------------------------------------------------------
// Commit trailer helpers
// ---------------------------------------------------------------------------

/**
 * Append Rensei provenance trailers to a commit message.
 *
 * Format from 008-version-control-providers.md:
 *   Co-Authored-By: <agent-name> <agent@rensei.dev>
 *   X-Rensei-Session-Id: <sessionId>
 *   X-Rensei-Kit-Set: spring/java@1.0.0,docker-compose@2.1.0
 *   X-Rensei-Workarea-Snapshot: <ref>
 *   X-Rensei-Model: anthropic/claude-opus-4-7
 */
export function buildCommitMessageWithTrailers(
  message: string,
  attestation: SessionAttestation,
): string {
  const trailers = buildAttestationTrailers(attestation)
  // Git trailer convention: blank line between subject/body and trailers
  const separator = message.endsWith('\n') ? '\n' : '\n\n'
  return message + separator + trailers
}

export function buildAttestationTrailers(attestation: SessionAttestation): string {
  const lines: string[] = []

  lines.push(`Co-Authored-By: ${attestation.agentId} <agent@rensei.dev>`)
  lines.push(`X-Rensei-Session-Id: ${attestation.sessionId}`)
  lines.push(`X-Rensei-Model: ${attestation.modelRef.provider}/${attestation.modelRef.model}`)

  if (attestation.kitIds.length > 0) {
    const kitSet = attestation.kitIds.map(k => `${k.id}@${k.version}`).join(',')
    lines.push(`X-Rensei-Kit-Set: ${kitSet}`)
  }

  if (attestation.workareaSnapshotRef) {
    lines.push(`X-Rensei-Workarea-Snapshot: ${attestation.workareaSnapshotRef.ref}`)
  }

  if (attestation.signedBy) {
    lines.push(`X-Rensei-Signed-By: ${attestation.signedBy}`)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Parse the PR number from a GitHub PR URL */
function parsePRNumberFromUrl(url: string): number {
  const m = url.match(/\/pull\/(\d+)/)
  if (!m) throw new Error(`Could not parse PR number from URL: ${url}`)
  return parseInt(m[1], 10)
}

/** Map MergeStrategy to gh CLI merge flag */
function githubMergeFlag(strategy: MergeStrategy): string {
  switch (strategy) {
    case 'rebase':       return '--rebase'
    case 'squash':       return '--squash'
    case 'auto':
    case 'three-way-text':
    default:             return '--merge'
  }
}

/** Classify a git push error into a PushResult reason */
function classifyPushError(message: string): 'non-fast-forward' | 'auth' | 'policy' {
  const lower = message.toLowerCase()
  // Check non-fast-forward first (git-specific patterns)
  if (lower.includes('non-fast-forward') || lower.includes('[rejected]')) {
    return 'non-fast-forward'
  }
  if (lower.includes('authentication') || lower.includes('permission denied') || lower.includes('auth')) {
    return 'auth'
  }
  return 'policy'
}

/** Escape a string for safe inclusion in a shell command with single quotes */
function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`
}

/**
 * Extract files with merge conflicts from the working copy.
 * Uses `git diff --name-only --diff-filter=U`.
 */
async function extractConflictFiles(cwd: string): Promise<Conflict[]> {
  try {
    const { stdout } = await exec('git diff --name-only --diff-filter=U', {
      cwd,
      timeout: 5_000,
    })
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(filePath => ({ filePath }))
  } catch {
    return []
  }
}
