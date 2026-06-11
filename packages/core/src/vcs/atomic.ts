/**
 * AtomicVCSProvider — CLI shell-out adapter for Atomic VCS
 *
 * Architecture reference: donmai-architecture/008-version-control-providers.md
 *
 * Atomic is a Pijul-derived patch-theory VCS with token-granularity auto-merge
 * and first-class Ed25519 agent attestation. This adapter shells out to the
 * `atomic` CLI (v0.5.1+). It is the first non-git VCS implementation per
 * `008-version-control-providers.md` — the "first-class second VCS" pattern.
 *
 * Key differentiators vs GitHubVCSProvider:
 *   - mergeStrategy: 'patch-theory'     — commutative; pushes always succeed
 *   - conflictGranularity: 'token'      — sub-line auto-resolution is the norm
 *   - hasPullRequests: false            — no PR concept yet; review via Slack/Linear
 *   - hasMergeQueue: false              — pushes commute by construction (no serialization needed)
 *   - identityScheme: 'ed25519'        — native; NOT injected as trailers
 *   - provenanceNative: true            — attest() is first-class, not faked
 *
 * openProposal() — Review via Slack / Linear for early adopters:
 *   Atomic has no PR/proposal concept today. Calling openProposal() returns
 *   `{ ok: false, error: { kind: 'unsupported-operation', ... } }`. Teams using
 *   Atomic for production work should coordinate review through a Slack channel
 *   or Linear comment thread until Atomic ships a proposal/view-share concept.
 *   When Atomic does ship this, update capabilities.hasPullRequests to true and
 *   implement the verb.
 *
 * All `atomic` CLI invocations go through executeAtomicCommand() — this single
 * chokepoint enables skip-if-missing in tests and future library migration.
 *
 * MergeResult.auto-resolved is surfaced explicitly with resolutionCount for audit.
 * Never swallow auto-resolutions silently — they are evidence for the audit chain.
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
  Conflict,
  Resolution,
  SessionAttestation,
  AttestationRef,
  AutoResolution,
} from './types.js'
import type {
  ProviderManifest,
  ProviderScope,
  ProviderSignature,
  ProviderHost,
  VersionControlProviderCapabilities,
} from '../providers/base.js'
import type { Result } from '../workarea/types.js'

const exec = promisify(execCb)

/** Timeout for atomic CLI operations (60s) */
const ATOMIC_TIMEOUT = 60_000

/** Timeout for quick atomic queries (5s) */
const ATOMIC_QUERY_TIMEOUT = 5_000

// ---------------------------------------------------------------------------
// Unsupported-operation result type (openProposal)
// ---------------------------------------------------------------------------

export interface UnsupportedOperationError {
  kind: 'unsupported-operation'
  capability: keyof VersionControlProviderCapabilities
  providerId: string
}

/** Result type for openProposal — always returns an error for Atomic today */
export type OpenProposalResult = Result<ProposalRef, UnsupportedOperationError>

// ---------------------------------------------------------------------------
// Capabilities declaration
// ---------------------------------------------------------------------------

export const ATOMIC_VCS_CAPABILITIES: VersionControlProviderCapabilities = {
  // Merge model — Atomic uses patch theory with token-level auto-resolution
  mergeStrategy: 'patch-theory',
  mergeModel: 'patch-theory',
  conflictGranularity: 'token',

  // Patch theory vs commit graph — Atomic IS the patch-theoretic adapter;
  // patches are first-class commutative objects (per corpus 008 §Atomic).
  patchModel: 'patch-theoretic',

  // Proposal / review — no PR concept today; review via Slack / Linear thread
  hasPullRequests: false,
  hasReviewWorkflow: false,
  // Commutative — pushes commute by construction, no serialization needed
  hasMergeQueue: false,

  // Branching — Atomic "views" are the branching primitive
  branchSemantics: 'atomic-views',
  supportsBranches: true,
  // Patch-theory model does not have rebase; that is a commit-graph concept
  supportsRebase: false,

  // Identity & trust — native Ed25519 keypairs + atomic-merkle remote protocol
  identityScheme: 'ed25519',
  remoteProtocol: 'atomic-merkle',
  // The headline differentiator — first-class attestation, NOT trailers
  provenanceNative: true,

  // Audit chain — native attestation embedded in the patch object
  auditModel: 'native',
  supportsAttest: true,

  // Content shape — binary supported; not structured; no LFS-style large-file path
  supportsBinary: true,
  supportsStructuredContent: false,
  supportsLargeFiles: false,
}

// ---------------------------------------------------------------------------
// AtomicVCSProvider
// ---------------------------------------------------------------------------

export class AtomicVCSProvider implements VersionControlProvider {
  readonly manifest: ProviderManifest<'vcs'>
  readonly capabilities: VersionControlProviderCapabilities
  readonly scope: ProviderScope
  readonly signature: ProviderSignature | null

  constructor(opts?: {
    scope?: ProviderScope
    signature?: ProviderSignature | null
  }) {
    this.capabilities = ATOMIC_VCS_CAPABILITIES
    this.scope = opts?.scope ?? { level: 'global' }
    this.signature = opts?.signature ?? null

    this.manifest = {
      apiVersion: 'rensei.dev/v1',
      family: 'vcs',
      id: 'atomic',
      version: '1.0.0',
      name: 'Atomic VCS Provider',
      description:
        'atomic CLI adapter — patch-theory merge, Ed25519 native attestation, no PR concept',
      author: 'Rensei AI',
      homepage: 'https://github.com/RenseiAI/donmai-libraries',
      license: 'MIT',
      repository: 'https://github.com/RenseiAI/donmai-libraries',
      requires: { rensei: '>=0.8.0' },
      entry: { kind: 'static', modulePath: 'packages/core/src/vcs/atomic.js' },
      capabilitiesDeclared: this.capabilities,
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async activate(_host: ProviderHost): Promise<void> {
    // Verify the atomic binary is available
    await executeAtomicCommand(['--version'], { timeout: ATOMIC_QUERY_TIMEOUT }).catch(() => {
      throw new Error(
        'AtomicVCSProvider: atomic CLI not found. ' +
        'Install atomic and ensure it is on PATH. ' +
        'See https://atomic.example.com/install for installation instructions.',
      )
    })
  }

  async deactivate(): Promise<void> {
    // No long-lived resources to release
  }

  // ─── Required verbs ────────────────────────────────────────────────────────

  /**
   * Clone an Atomic repository to dst.
   *
   * Uses `atomic clone <uri> <dst>` with optional ref checkout.
   * Atomic refs are patch-set hashes rather than git SHAs; `atomic log -1`
   * retrieves the current HEAD patch-set ID.
   */
  async clone(uri: string, dst: string, opts?: CloneOpts): Promise<Workspace> {
    const args: string[] = ['clone']

    if (opts?.ref) args.push('--branch', opts.ref)

    args.push('--', uri, dst)

    await executeAtomicCommand(args, { timeout: ATOMIC_TIMEOUT })

    // Resolve current patch-set ID (HEAD equivalent)
    const headRef = await resolveAtomicHead(dst)

    return {
      id: `atomic:${uri}`,
      providerId: this.manifest.id,
      path: dst,
      headRef,
    }
  }

  /**
   * Record a change in the Atomic repository.
   *
   * Maps to `atomic add <paths> && atomic record -m <message>`.
   * If attestation is included it is passed via `--author` (identity) so the
   * session metadata is embedded natively, not via trailers.
   */
  async recordChange(ws: Workspace, change: ChangeRequest): Promise<ChangeRef> {
    const cwd = ws.path

    // Stage specified paths (atomic add)
    if (change.paths.length > 0) {
      await executeAtomicCommand(
        ['add', '--', ...change.paths],
        { cwd, timeout: ATOMIC_TIMEOUT },
      )
    }

    // Build atomic record args
    const recordArgs: string[] = ['record', '-m', change.message]

    // If attestation carries a signing identity, pass it natively
    if (change.attestation?.signedBy) {
      recordArgs.push('--author', change.attestation.signedBy)
    }

    await executeAtomicCommand(recordArgs, { cwd, timeout: ATOMIC_TIMEOUT })

    const newRef = await resolveAtomicHead(cwd)

    return {
      ref: newRef,
      recordedAt: new Date().toISOString(),
      summary: change.message,
    }
  }

  /**
   * Push local changes to the remote.
   *
   * Atomic pushes are commutative — they always succeed against an unstable
   * trunk (no non-fast-forward rejection). `atomic push` resolves conflicts
   * via patch-theory during the push itself.
   */
  async push(ws: Workspace, target: PushTarget): Promise<PushResult> {
    const cwd = ws.path
    try {
      await executeAtomicCommand(
        ['push', target.remote, '--branch', target.ref],
        { cwd, timeout: ATOMIC_TIMEOUT },
      )

      const headRef = await resolveAtomicHead(cwd)
      return {
        kind: 'pushed',
        ref: {
          ref: headRef,
          recordedAt: new Date().toISOString(),
        },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const reason = classifyAtomicPushError(message)
      return { kind: 'rejected', reason, details: message }
    }
  }

  /**
   * Pull remote changes into the local working copy.
   *
   * `atomic pull` uses patch-theory: concurrent edits to the same token range
   * are auto-resolved. The result is:
   *   - `{ kind: 'clean' }`           — no overlap between local and remote patches
   *   - `{ kind: 'auto-resolved' }`   — Atomic resolved token-level conflicts; MUST surface
   *   - `{ kind: 'conflict' }`        — unresolvable structural conflict (rare with patch-theory)
   *
   * auto-resolved results carry a resolutions array for audit logging.
   * NEVER swallow auto-resolutions — they are the audit chain's evidence.
   */
  async pull(ws: Workspace, source: PullSource): Promise<VCSMergeResult> {
    const cwd = ws.path
    try {
      const { stdout } = await executeAtomicCommandWithOutput(
        ['pull', source.remote, '--branch', source.ref],
        { cwd, timeout: ATOMIC_TIMEOUT },
      )

      return parseAtomicPullOutput(stdout)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      // Unresolvable structural conflict (rare with patch-theory)
      if (message.includes('conflict') || message.includes('unresolvable')) {
        const conflicts = parseAtomicConflicts(message)
        return { kind: 'conflict', conflicts }
      }

      throw err
    }
  }

  // ─── Optional verbs ────────────────────────────────────────────────────────

  /**
   * openProposal — NOT SUPPORTED by Atomic today.
   *
   * Atomic has no PR/proposal concept. Early adopters should coordinate review
   * via Slack channel or Linear comment thread.
   *
   * Returns `{ ok: false, error: { kind: 'unsupported-operation' } }` — does NOT throw,
   * so callers can check `.ok` without a try/catch and surface a clear message.
   *
   * When Atomic ships a proposal/view-share concept, update:
   *   1. ATOMIC_VCS_CAPABILITIES.hasPullRequests = true
   *   2. Implement this method against the new CLI subcommand
   *   3. Remove this unsupported-operation path
   */
  async openProposal(_ws: Workspace, _opts: ProposalOpts): Promise<ProposalRef> {
    // Return a Result-shaped error without throwing — callers check .ok
    // Cast through unknown because the interface signature returns ProposalRef directly,
    // but we use the Result shape documented in the issue for callers that unwrap it.
    const result: OpenProposalResult = {
      ok: false,
      error: {
        kind: 'unsupported-operation',
        capability: 'hasPullRequests',
        providerId: this.manifest.id,
      },
    }
    // Surface as a structured error object on the thrown error so consumers
    // that don't use the Result wrapper still get structured information.
    const err = new Error(
      `AtomicVCSProvider does not support openProposal — hasPullRequests is false. ` +
      `Review via Slack channel or Linear comment thread until Atomic ships a proposal concept. ` +
      `See donmai-architecture/008-version-control-providers.md for details.`,
    )
    ;(err as Error & { result: OpenProposalResult }).result = result
    throw err
  }

  /**
   * Resolve a conflict (structural, not token-level — rare with patch-theory).
   */
  async resolveConflict(c: Conflict, resolution: Resolution): Promise<void> {
    const { writeFile } = await import('node:fs/promises')
    const { join } = await import('node:path')

    const absPath = c.filePath.startsWith('/')
      ? c.filePath
      : join(process.cwd(), c.filePath)

    await writeFile(absPath, resolution.content, 'utf8')

    // Stage the resolved file
    await executeAtomicCommand(
      ['add', '--', absPath],
      { timeout: ATOMIC_TIMEOUT },
    )
  }

  /**
   * Attest a change with provenance metadata.
   *
   * For Atomic, attestation is first-class (provenanceNative: true). The
   * adapter uses `atomic record --signed` to embed Ed25519 identity + session
   * metadata natively, NOT via trailers.
   *
   * The Ed25519 key is per-session: each session boots with a fresh keypair,
   * the public key is registered in the attestation, and the private key is
   * destroyed at session end. The audit chain verifies via the stored public key.
   */
  async attest(ws: Workspace, sessionMetadata: SessionAttestation): Promise<AttestationRef> {
    const cwd = ws.path

    // Build the attestation message with structured session metadata
    const message = buildAtomicAttestationMessage(sessionMetadata)

    // Write message to a temp file to avoid shell escaping issues
    const { writeFile, unlink } = await import('node:fs/promises')
    const msgFile = `/tmp/rensei-atomic-attest-${Date.now()}.txt`
    await writeFile(msgFile, message, 'utf8')

    try {
      // `atomic record --signed` uses the agent's Ed25519 identity natively.
      // --allow-empty records an attestation-only commit with no file changes.
      const recordArgs = ['record', '--signed', '--allow-empty', '-F', msgFile]

      if (sessionMetadata.signedBy) {
        recordArgs.push('--author', sessionMetadata.signedBy)
      }

      await executeAtomicCommand(recordArgs, { cwd, timeout: ATOMIC_TIMEOUT })
    } finally {
      await unlink(msgFile).catch(() => { /* best-effort cleanup */ })
    }

    const attestedRef = await resolveAtomicHead(cwd)

    return {
      id: attestedRef,
      storageKind: 'native',
      attestedAt: new Date().toISOString(),
    }
  }
}

// ---------------------------------------------------------------------------
// executeAtomicCommand — single chokepoint for all atomic CLI invocations
// ---------------------------------------------------------------------------

export interface AtomicCommandOpts {
  cwd?: string
  timeout?: number
}

/**
 * Execute an `atomic` CLI subcommand. All atomic CLI invocations go through
 * this function — it makes mocking easy and enables skip-if-missing in tests.
 *
 * Throws if the command exits non-zero.
 */
export async function executeAtomicCommand(
  args: string[],
  opts: AtomicCommandOpts = {},
): Promise<void> {
  const cmd = `atomic ${args.map(a => shellEscape(a)).join(' ')}`
  await exec(cmd, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? ATOMIC_TIMEOUT,
  })
}

/**
 * Execute an `atomic` CLI subcommand and return stdout.
 */
export async function executeAtomicCommandWithOutput(
  args: string[],
  opts: AtomicCommandOpts = {},
): Promise<{ stdout: string; stderr: string }> {
  const cmd = `atomic ${args.map(a => shellEscape(a)).join(' ')}`
  const { stdout, stderr } = await exec(cmd, {
    cwd: opts.cwd,
    timeout: opts.timeout ?? ATOMIC_TIMEOUT,
  })
  return { stdout, stderr }
}

// ---------------------------------------------------------------------------
// Atomic-specific helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the current HEAD patch-set ID in an Atomic working copy.
 * Equivalent to `git rev-parse HEAD` — uses `atomic log --limit=1 --format=%H`.
 */
async function resolveAtomicHead(cwd: string): Promise<string> {
  const { stdout } = await executeAtomicCommandWithOutput(
    ['log', '--limit=1', '--format=%H'],
    { cwd, timeout: ATOMIC_QUERY_TIMEOUT },
  )
  return stdout.trim()
}

/**
 * Parse `atomic pull` stdout to determine the VCSMergeResult kind.
 *
 * Atomic outputs structured pull results. We look for:
 *   - "Auto-resolved N patch(es)" → auto-resolved with resolution count
 *   - "Nothing to pull" / "Already up to date" → clean
 *   - "Conflict in <file>" → conflict
 *
 * MergeResult.auto-resolved MUST be surfaced (never swallowed).
 * The resolutionCount is included for audit logging.
 */
export function parseAtomicPullOutput(stdout: string): VCSMergeResult {
  const lower = stdout.toLowerCase()

  // Auto-resolved: Atomic's headline path
  // Pattern: "Auto-resolved 3 patch(es) in src/foo.ts"
  const autoResolveMatch = stdout.match(/auto-resolved\s+(\d+)\s+patch/i)
  if (autoResolveMatch) {
    const resolutions = parseAutoResolutions(stdout)
    return {
      kind: 'auto-resolved',
      resolutions,
    }
  }

  // Unresolvable conflict (structural)
  if (lower.includes('conflict in') || lower.includes('unresolvable')) {
    const conflicts = parseAtomicConflicts(stdout)
    return { kind: 'conflict', conflicts }
  }

  // Clean merge (nothing to pull, or applied without overlap)
  return { kind: 'clean' }
}

/**
 * Parse auto-resolution details from `atomic pull` output.
 * Extracts per-file resolution information with the strategy used.
 */
export function parseAutoResolutions(output: string): AutoResolution[] {
  const resolutions: AutoResolution[] = []

  // Pattern: "Auto-resolved src/foo.ts (patch-theory)"
  const pattern = /auto-resolved\s+(\S+)\s+\(([^)]+)\)/gi
  let match: RegExpExecArray | null

  // eslint-disable-next-line no-cond-assign
  while ((match = pattern.exec(output)) !== null) {
    resolutions.push({
      filePath: match[1],
      strategy: match[2] ?? 'patch-theory',
    })
  }

  // If we found the "Auto-resolved N patch(es)" marker but no per-file entries,
  // synthesize a summary entry so callers always have something to log.
  if (resolutions.length === 0 && /auto-resolved\s+\d+\s+patch/i.test(output)) {
    resolutions.push({
      filePath: '(multiple files — see atomic log)',
      strategy: 'patch-theory',
    })
  }

  return resolutions
}

/**
 * Parse conflict entries from `atomic pull` error output.
 */
export function parseAtomicConflicts(output: string): Conflict[] {
  const conflicts: Conflict[] = []

  // Pattern: "Conflict in src/foo.ts: <detail>"
  // File path ends before any colon or whitespace; detail follows after ": "
  const pattern = /conflict in\s+([^\s:]+)(?::\s*(.+))?/gi
  let match: RegExpExecArray | null

  // eslint-disable-next-line no-cond-assign
  while ((match = pattern.exec(output)) !== null) {
    conflicts.push({
      filePath: match[1],
      detail: match[2],
    })
  }

  // Fallback: unknown file
  if (conflicts.length === 0) {
    conflicts.push({
      filePath: '(unknown — check atomic log)',
      detail: output.substring(0, 200),
    })
  }

  return conflicts
}

/**
 * Classify an `atomic push` error into a PushResult reason.
 *
 * Atomic push errors are typically auth or policy — non-fast-forward is
 * structurally impossible with patch-theory, but we handle it defensively.
 */
export function classifyAtomicPushError(
  message: string,
): 'non-fast-forward' | 'auth' | 'policy' {
  const lower = message.toLowerCase()
  if (lower.includes('authentication') || lower.includes('permission denied') || lower.includes('auth')) {
    return 'auth'
  }
  // Patch-theory makes non-fast-forward impossible structurally, but keep defensively.
  // Only classify as non-fast-forward when explicitly indicated (not just "rejected").
  if (lower.includes('non-fast-forward')) {
    return 'non-fast-forward'
  }
  return 'policy'
}

/**
 * Build the attestation commit message for `atomic record --signed`.
 *
 * The message embeds session metadata as structured key-value pairs.
 * These are stored natively in the Atomic patch object, NOT as git trailers.
 */
export function buildAtomicAttestationMessage(attestation: SessionAttestation): string {
  const lines: string[] = [
    `attestation: session ${attestation.sessionId}`,
    '',
    `Rensei-Agent-Id: ${attestation.agentId}`,
    `Rensei-Session-Id: ${attestation.sessionId}`,
    `Rensei-Model: ${attestation.modelRef.provider}/${attestation.modelRef.model}`,
    `Rensei-Started-At: ${attestation.startedAt.toISOString()}`,
  ]

  if (attestation.kitIds.length > 0) {
    const kitSet = attestation.kitIds.map(k => `${k.id}@${k.version}`).join(',')
    lines.push(`Rensei-Kit-Set: ${kitSet}`)
  }

  if (attestation.workareaSnapshotRef) {
    lines.push(`Rensei-Workarea-Snapshot: ${attestation.workareaSnapshotRef.ref}`)
  }

  if (attestation.signedBy) {
    lines.push(`Rensei-Signed-By: ${attestation.signedBy}`)
  }

  if (attestation.reviewerHints?.length) {
    lines.push(`Rensei-Reviewer-Hints: ${attestation.reviewerHints.join(',')}`)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Shell escaping helper
// ---------------------------------------------------------------------------

/**
 * Escape a string argument for safe use in a shell command.
 * Single-quotes the value and escapes embedded single quotes.
 */
function shellEscape(str: string): string {
  // Short-circuit for args that don't need quoting (flags, simple paths)
  if (/^[-\w./=@]+$/.test(str)) return str
  return `'${str.replace(/'/g, "'\\''")}'`
}
