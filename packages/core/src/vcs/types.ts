/**
 * VersionControlProvider — VCS abstraction interface
 *
 * Architecture reference: donmai-architecture/008-version-control-providers.md
 *
 * Design:
 * - Required verbs (clone, recordChange, push, pull) every provider must implement.
 * - Optional verbs (openProposal, mergeProposal, enqueueForMerge, resolveConflict, attest)
 *   are gated by capabilities. Calling an unsupported verb throws with a clear error.
 * - Capabilities are declared up-front (flat struct) so the scheduler can reason about
 *   candidates without loading the implementation.
 * - MergeResult is a discriminated union: clean | auto-resolved | conflict.
 *   auto-resolved MUST be surfaced (never swallowed silently) — it carries
 *   Atomic's headline value and is audit-chain evidence.
 */

import type { Provider, VersionControlProviderCapabilities } from '../providers/base.js'

// Re-export capabilities type for convenience
export type { VersionControlProviderCapabilities } from '../providers/base.js'

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

export interface Workspace {
  readonly id: string
  readonly providerId: string
  /** Local working-copy path */
  readonly path: string
  /** Commit / patch-set / object version */
  readonly headRef: string
}

export interface CloneOpts {
  /** Target ref (branch/tag/SHA) to check out after cloning */
  ref?: string
  /** Shallow clone depth (git) */
  depth?: number
  /** Whether to only clone a single branch */
  singleBranch?: boolean
}

export interface CellChange {
  /** Cell address (e.g. "A1", "Sheet1!B3") */
  address: string
  /** New cell value */
  value: unknown
}

export interface KitProviderId {
  id: string
  version: string
}

export interface WorkareaSnapshotRef {
  ref: string
  providerId: string
}

export interface SessionAttestation {
  agentId: string
  modelRef: { provider: string; model: string }
  sessionId: string
  kitIds: KitProviderId[]
  workareaSnapshotRef?: WorkareaSnapshotRef
  reviewerHints?: string[]
  startedAt: Date
  /** Signing identity (keypair URL / DID), when supported */
  signedBy?: string
}

export interface ChangeRequest {
  /** Commit message or equivalent */
  message: string
  /** Paths for content-based VCS (git, atomic, s3) */
  paths: string[]
  /** Cell-level updates for structured content (sheet rows, Notion) */
  cells?: CellChange[]
  /** Optional provenance metadata attached to the change */
  attestation?: SessionAttestation
}

export interface ChangeRef {
  /** Commit SHA / patch ID / object version / row revision */
  ref: string
  /** ISO timestamp of the recorded change */
  recordedAt: string
  /** Human-readable summary */
  summary?: string
}

export interface PushTarget {
  /** Remote name (git) or equivalent */
  remote: string
  /** Branch / ref to push to */
  ref: string
}

export interface PullSource {
  /** Remote name (git) or equivalent */
  remote: string
  /** Branch / ref to pull from */
  ref: string
}

export interface ProposalOpts {
  title: string
  body: string
  /** Base branch to merge the proposal into */
  baseRef: string
  reviewers?: string[]
  labels?: string[]
}

export interface ProposalRef {
  /** Provider-specific identifier (PR number, MR IID, etc.) */
  id: string
  /** Human-readable URL */
  url?: string
  /** Current state */
  state: 'open' | 'merged' | 'closed'
}

export type MergeStrategy =
  | 'auto'             // provider-default
  | 'three-way-text'   // git-style merge
  | 'rebase'
  | 'squash'
  | 'patch-theory'     // Atomic
  | 'last-write-wins'  // S3-style
  | 'cell-merge'       // structured content

export interface MergeQueueOpts {
  /** Labels that must be present to enqueue */
  requiredLabels?: string[]
  /** Priority within the queue */
  priority?: number
}

export interface QueueTicket {
  /** Provider-specific queue ticket identifier */
  id: string
  /** Queue position at time of enqueue (1-based) */
  position?: number
  /** ISO timestamp when enqueued */
  enqueuedAt: string
}

export interface Conflict {
  /** Relative path within the workspace */
  filePath: string
  /** Conflict detail (diff output, etc.) */
  detail?: string
}

export interface AutoResolution {
  /** Path that was auto-resolved */
  filePath: string
  /** Strategy used (e.g., 'patch-theory', 'three-way') */
  strategy: string
}

export interface Resolution {
  /** Resolved content to apply */
  content: string
  /** Strategy used */
  strategy: MergeStrategy
}

// ---------------------------------------------------------------------------
// Discriminated union results
// ---------------------------------------------------------------------------

/**
 * Result of a push operation.
 *
 * `pushed` — the push succeeded; ref is the new remote HEAD.
 * `rejected` — the push was rejected by the remote.
 *   - non-fast-forward: force push or rebase is needed
 *   - auth: authentication / authorization failure
 *   - policy: rejected by a branch protection rule or policy hook
 */
export type PushResult =
  | { kind: 'pushed'; ref: ChangeRef }
  | { kind: 'rejected'; reason: 'non-fast-forward' | 'auth' | 'policy'; details?: string }

/**
 * Result of a merge or pull operation.
 *
 * `clean` — no overlapping changes; fast-forward or trivial merge.
 * `auto-resolved` — provider resolved conflicts automatically (Atomic headline path).
 *   MUST be surfaced to the caller — never swallowed silently.
 * `conflict` — human or agent intervention is required.
 */
export type VCSMergeResult =
  | { kind: 'clean' }
  | { kind: 'auto-resolved'; resolutions: AutoResolution[] }
  | { kind: 'conflict'; conflicts: Conflict[] }

export interface AttestationRef {
  /** Provider-specific attestation identifier */
  id: string
  /** How attestation was stored: 'commit-trailer' | 'native' | 'object-metadata' */
  storageKind: 'commit-trailer' | 'native' | 'object-metadata'
  /** ISO timestamp */
  attestedAt: string
}

// ---------------------------------------------------------------------------
// VersionControlProvider interface
// ---------------------------------------------------------------------------

/**
 * VersionControlProvider — the VCS family interface.
 *
 * Extends the unified Provider<'vcs'> base contract. Required verbs must be
 * implemented by every provider. Optional verbs are gated by capabilities:
 * calling an unsupported verb MUST throw `UnsupportedOperationError`.
 *
 * Capability gating convention:
 *   - openProposal / mergeProposal ← capabilities.hasPullRequests
 *   - enqueueForMerge              ← capabilities.hasMergeQueue
 *   - resolveConflict              ← consumer checks conflicts[].length > 0
 *   - attest                       ← capabilities.supportsAttest (first-class
 *                                    verb declaration; consumed by the sigstore).
 *                                    Every shipped adapter declares supportsAttest: true
 *                                    — git fakes via trailers, S3 via metadata, Atomic
 *                                    uses native Ed25519. Minimal community adapters
 *                                    MAY declare false to opt out.
 *
 * Usage pattern:
 * ```ts
 * if (!provider.capabilities.hasMergeQueue) {
 *   // Commutative VCS — pushes commute by construction. Skip queue.
 *   return await provider.mergeProposal!(ref, 'auto')
 * }
 * const ticket = await provider.enqueueForMerge!(ref, opts)
 * ```
 */
export interface VersionControlProvider extends Provider<'vcs'> {
  // Override capabilities type to the concrete VCS shape
  readonly capabilities: VersionControlProviderCapabilities

  // ─── Required verbs (every provider) ──────────────────────────────────────

  /**
   * Materialize a working copy at dst. The workarea provider calls this during
   * acquire(); orchestrator code rarely calls it directly.
   */
  clone(uri: string, dst: string, opts?: CloneOpts): Promise<Workspace>

  /**
   * Record a change. Wraps "stage + commit" for git, "record" for Atomic,
   * "PUT object" for S3-versioned, "row update" for structured content.
   */
  recordChange(ws: Workspace, change: ChangeRequest): Promise<ChangeRef>

  /**
   * Push local changes to a remote.
   *
   * For commutative VCS (Atomic), pushes always succeed against an unstable
   * trunk. For git, push may fail with `kind: 'rejected'` and the caller
   * falls back to merge-queue or rebase.
   */
  push(ws: Workspace, target: PushTarget): Promise<PushResult>

  /**
   * Pull remote changes into the local working copy.
   * Returns a VCSMergeResult indicating whether conflicts arose.
   */
  pull(ws: Workspace, source: PullSource): Promise<VCSMergeResult>

  // ─── Optional verbs (gated by capabilities) ────────────────────────────────

  /**
   * Open a proposal for review/merge.
   *
   * Gate: capabilities.hasPullRequests === true
   * Throws UnsupportedOperationError otherwise.
   */
  openProposal?(ws: Workspace, opts: ProposalOpts): Promise<ProposalRef>

  /**
   * Merge a proposal. Strategy depends on provider capabilities and
   * proposal-level options.
   *
   * Gate: capabilities.hasPullRequests === true
   * Throws UnsupportedOperationError otherwise.
   */
  mergeProposal?(ref: ProposalRef, strategy: MergeStrategy): Promise<VCSMergeResult>

  /**
   * Enqueue a proposal for serialized merge.
   *
   * Only meaningful for providers where simultaneous merges to trunk can
   * conflict — i.e., NOT for commutative VCS (Atomic) where concurrent
   * pushes commute by construction.
   *
   * Gate: capabilities.hasMergeQueue === true
   * Throws UnsupportedOperationError otherwise.
   */
  enqueueForMerge?(ref: ProposalRef, opts: MergeQueueOpts): Promise<QueueTicket>

  /**
   * Resolve a conflict raised by a prior merge attempt.
   */
  resolveConflict?(c: Conflict, resolution: Resolution): Promise<void>

  /**
   * Attest a change with provenance metadata (model, agent, session, kit set).
   *
   * For git: emits commit trailers (X-Rensei-*).
   * For Atomic: uses native Ed25519 + session attestation.
   * For S3: writes object metadata.
   *
   * Gate: capabilities.supportsAttest. First-class verb on every
   * shipped adapter. provenanceNative additionally indicates whether the
   * attestation is native (Atomic) or faked via trailers/metadata (git, S3).
   *
   * Consumed by the sigstore manifest signing work — providers declaring
   * supportsAttest: true are eligible for the SLSA-attested signing pipeline.
   */
  attest?(ws: Workspace, sessionMetadata: SessionAttestation): Promise<AttestationRef>
}

// ---------------------------------------------------------------------------
// UnsupportedOperationError
// ---------------------------------------------------------------------------

/**
 * Thrown when a capability-gated optional verb is called on a provider that
 * does not support that capability.
 *
 * Includes the capability flag name and provider id so callers can log
 * a structured diagnostic without string-parsing.
 */
export class UnsupportedOperationError extends Error {
  readonly capability: keyof VersionControlProviderCapabilities
  readonly providerId: string

  constructor(
    capability: keyof VersionControlProviderCapabilities,
    providerId: string,
    message?: string,
  ) {
    super(
      message ??
        `Provider '${providerId}' does not support capability '${capability}'. ` +
        `Check provider.capabilities.${capability} before calling this verb.`,
    )
    this.name = 'UnsupportedOperationError'
    this.capability = capability
    this.providerId = providerId
  }
}

// ---------------------------------------------------------------------------
// Helper: assertCapability
// ---------------------------------------------------------------------------

/**
 * Assert that a provider declares the given boolean capability as true.
 *
 * Throws UnsupportedOperationError if the capability is false/undefined.
 * Use this at the top of every capability-gated optional verb:
 *
 * ```ts
 * async enqueueForMerge(ref, opts) {
 *   assertCapability(this.capabilities, 'hasMergeQueue', this.manifest.id)
 *   // ... implementation
 * }
 * ```
 */
export function assertCapability(
  capabilities: VersionControlProviderCapabilities,
  capability: keyof VersionControlProviderCapabilities,
  providerId: string,
): void {
  if (!capabilities[capability]) {
    throw new UnsupportedOperationError(capability, providerId)
  }
}
