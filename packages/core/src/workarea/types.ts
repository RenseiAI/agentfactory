/**
 * Workarea — Structured Result types for git-worktree operations
 *
 * Discriminated unions so callers can handle expected failures without
 * catching exceptions.  The pattern mirrors Rust's Result<T, E>:
 *
 *   const r = addWorktree(repo, 'main', '/tmp/wt')
 *   if (!r.ok) {
 *     // r.error is typed — exhaustive switch possible
 *   }
 */

// ---------------------------------------------------------------------------
// Core Result<T, E>
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

// Convenience helpers

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

export function err<E>(error: E): { ok: false; error: E } {
  return { ok: false, error }
}

// ---------------------------------------------------------------------------
// addWorktree
// ---------------------------------------------------------------------------

/**
 * Expected failure modes for addWorktree().
 *
 * - `branch-exists`   — the branch already exists; pass an existing branch to
 *                       the underlying add call to check it out instead.
 * - `path-exists`     — the target directory already exists on disk.
 * - `protected-path`  — the path is the main repo root, inside
 *                       `donmai-architecture/`, or under `runs/`.
 * - `git-error`       — git returned a non-zero exit code for another reason.
 */
export type AddWorktreeError =
  | 'branch-exists'
  | 'path-exists'
  | 'protected-path'
  | 'git-error'

export interface AddWorktreeValue {
  /** Absolute, resolved path of the newly-created worktree. */
  path: string
  /** The ref (branch/commit) that was checked out. */
  ref: string
}

export type AddWorktreeResult = Result<AddWorktreeValue, AddWorktreeError>

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

/**
 * Expected failure modes for removeWorktree().
 *
 * - `not-found`       — the path does not exist; treated as a no-op by
 *                       callers that want idempotency.
 * - `protected-path`  — same protection as addWorktree.
 * - `git-error`       — git returned a non-zero exit code.
 */
export type RemoveWorktreeError =
  | 'not-found'
  | 'protected-path'
  | 'git-error'

export type RemoveWorktreeResult = Result<void, RemoveWorktreeError>

// ---------------------------------------------------------------------------
// listWorktrees
// ---------------------------------------------------------------------------

export interface WorktreeEntry {
  /** Absolute path to the worktree directory. */
  path: string
  /** HEAD commit hash (40-char SHA). */
  head: string
  /** Checked-out branch name, or null for a detached HEAD. */
  branch: string | null
  /** True when this entry is the main (primary) working tree. */
  isMain: boolean
}

/**
 * Expected failure modes for listWorktrees().
 *
 * - `git-error` — git returned a non-zero exit code.
 */
export type ListWorktreesError = 'git-error'

export type ListWorktreesResult = Result<WorktreeEntry[], ListWorktreesError>

// ---------------------------------------------------------------------------
// cleanWorktree
// ---------------------------------------------------------------------------

/**
 * What cleanWorktree() removed.
 */
export interface CleanWorktreeValue {
  /** Paths deleted during the clean operation. */
  removed: string[]
}

/**
 * Expected failure modes for cleanWorktree().
 *
 * - `not-found`       — path does not exist.
 * - `protected-path`  — path is main repo root, donmai-architecture, or runs/.
 * - `invalid-worktree`— path exists but is not a valid git worktree.
 * - `git-error`       — git clean / checkout returned a non-zero exit code.
 */
export type CleanWorktreeError =
  | 'not-found'
  | 'protected-path'
  | 'invalid-worktree'
  | 'git-error'

export type CleanWorktreeResult = Result<CleanWorktreeValue, CleanWorktreeError>

// ---------------------------------------------------------------------------
// WorkareaProvider types
// ---------------------------------------------------------------------------

import type { Provider, ProviderScope } from '../providers/base.js'

export type { Provider, ProviderScope }

/** Opaque workarea identifier — provider-namespaced. */
export type WorkareaId = string

/** SHA-256 hex string over lockfile + canonical config files. */
export type CleanStateChecksum = string

/** Source specification for what code the workarea should contain. */
export interface WorkareaSource {
  /** Git repository URL or local path. */
  repository: string
  /** Branch, tag, or commit SHA to check out. */
  ref: string
  /** Optional sparse-checkout paths (future). */
  paths?: string[]
}

/** Toolchain version demands (semver ranges). */
export interface ToolchainDemand {
  node?: string
  java?: string
  python?: string
  rust?: string
  go?: string
  ruby?: string
  [key: string]: string | undefined
}

/**
 * Specification the caller passes to acquire().
 * The provider resolves the fastest path that satisfies the determinism guarantee.
 */
export interface WorkareaSpec {
  source: WorkareaSource
  toolchain?: ToolchainDemand
  os?: 'linux' | 'macos' | 'windows'
  arch?: 'x86_64' | 'arm64' | 'wasm32'
  fromSnapshot?: WorkareaSnapshotRef
  mode?: 'exclusive' | 'shared'
  parentWorkareaId?: WorkareaId
  sessionId: string
  scope: ProviderScope
}

/**
 * A workarea handle returned by acquire().
 * The cleanStateChecksum represents the known-deterministic state the provider
 * established before returning.
 */
export interface Workarea {
  readonly id: WorkareaId
  readonly path: string
  readonly providerId: string
  readonly ref: string
  readonly cleanStateChecksum: CleanStateChecksum
  readonly toolchain: Record<string, string>
  readonly acquired: Date
  readonly mode: 'exclusive' | 'shared'
  readonly parent?: WorkareaId
}

/**
 * How the caller intends to release the workarea.
 *
 * - `destroy`          — tear down completely (git worktree remove)
 * - `return-to-pool`   — scoped clean and mark ready for reuse
 * - `pause`            — local provider has no pause primitive; degrades to return-to-pool
 * - `archive`          — cold storage (future: tar to configurable location)
 */
export type ReleaseMode =
  | { kind: 'destroy' }
  | { kind: 'return-to-pool' }
  | { kind: 'pause' }
  | { kind: 'archive'; label?: string }

/** Opaque snapshot reference. Provider-internal; not portable across providers. */
export interface WorkareaSnapshotRef {
  providerId: string
  snapshotId: string
  capturedAt: Date
}

/** Pool member states (local-pool.ts). */
export type WorkareaPoolMemberStatus =
  | 'warming'    // git worktree add + pnpm install in progress
  | 'ready'      // clean, deps installed, available
  | 'acquired'   // in use by a session
  | 'releasing'  // scoped clean in progress
  | 'invalid'    // lockfile changed or staleness exceeded
  | 'retired'    // slated for destruction

/** One member of the local pool. */
export interface WorkareaPoolMember {
  id: WorkareaId
  path: string
  repository: string
  ref: string
  toolchainKey: string
  status: WorkareaPoolMemberStatus
  cleanStateChecksum: CleanStateChecksum
  acquiredAt?: Date
  createdAt: Date
  lastUsedAt?: Date
}

/**
 * WorkareaProvider<F> — the typed interface callers program against.
 *
 * Extends Provider<'workarea'> so the scheduler can activate/deactivate it
 * through the same base-contract lifecycle.
 */
export interface WorkareaProvider extends Provider<'workarea'> {
  /**
   * Return a workarea in a known-deterministic state.
   * Fast path: warm pool member + scoped clean.
   * Slow path: git worktree add + toolchain install + pnpm install.
   */
  acquire(spec: WorkareaSpec): Promise<Workarea>

  /**
   * Return the workarea to the provider.
   * `pause` is not supported locally and degrades to `return-to-pool`.
   */
  release(workarea: Workarea, mode: ReleaseMode): Promise<void>

  /**
   * Snapshot a workarea (optional — only available when capabilities.supportsSnapshot is true).
   */
  snapshot?(workarea: Workarea, label?: string): Promise<WorkareaSnapshotRef>
}
