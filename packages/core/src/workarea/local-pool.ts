/**
 * WorkareaProvider — local-pool implementation
 *
 * Implements WorkareaProvider<'workarea'> for the local-machine case.
 * Architecture reference: donmai-architecture/003-workarea-provider.md
 *
 * Acquire fast path (< 5s p95 when warm):
 *   1. Find a `ready` pool member matching (repository, toolchainKey).
 *   2. Fetch + checkout the requested ref if needed.
 *   3. Scoped clean: rm -rf .next .turbo node_modules/.cache dist coverage.
 *   4. Verify lockfile hasn't drifted; if it has, mark member invalid.
 *   5. Compute cleanStateChecksum (SHA-256 over lockfile + config files).
 *   6. Mark member `acquired`, return Workarea.
 *
 * Acquire slow path (cold / no match):
 *   1. git worktree add.
 *   2. pnpm install --frozen-lockfile.
 *   3. Compute cleanStateChecksum.
 *   4. Mark member `acquired`, return Workarea.
 *
 * Release modes:
 *   - destroy          → git worktree remove + pool entry removed.
 *   - return-to-pool   → scoped clean + mark ready.
 *   - pause            → degrades to return-to-pool with warn-level hook event.
 *   - archive          → (future) tar; currently degrades to return-to-pool with warning.
 *
 * Pool invalidation: fs.watch() on pnpm-lock.yaml (or the lock file for the
 * configured package manager). Any change marks all matching pool members `invalid`.
 *
 * Mutex: per (repository, toolchainKey) key via a simple promise-chained lock
 * so concurrent acquire() calls for the same key don't race.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
} from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import type { Provider, ProviderHost, ProviderManifest, ProviderScope, ProviderSignature } from '../providers/base.js'
import type { WorkareaProviderCapabilities } from '../providers/base.js'
import { globalHookBus } from '../observability/hooks.js'
import {
  addWorktree,
  cleanWorktree,
  removeWorktreePath,
} from './git-worktree.js'
import type {
  Workarea,
  WorkareaId,
  WorkareaPoolMember,
  WorkareaPoolMemberStatus,
  WorkareaProvider,
  WorkareaSpec,
  ReleaseMode,
  CleanStateChecksum,
  WorkareaSnapshotRef,
} from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Artifact directories removed on every acquire (scoped clean). */
const SCOPED_CLEAN_DIRS = [
  '.next',
  '.turbo',
  'dist',
  'coverage',
] as const

/** Subdirectory inside node_modules that is also cleaned. */
const NM_CACHE_SUBDIR = 'node_modules/.cache'

/**
 * Default pool capacity per (repository, toolchainKey) key.
 * A real fleet deployment would increase this; 3 is sufficient for tests.
 */
const DEFAULT_POOL_CAPACITY = 3

/** Default pool member staleness limit in milliseconds (24 hours). */
const DEFAULT_STALENESS_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Toolchain key derivation
// ---------------------------------------------------------------------------

/**
 * Derive a stable string key from a ToolchainDemand map.
 * Sorts keys so { node: '20', java: '17' } and { java: '17', node: '20' }
 * produce the same key.
 */
export function deriveToolchainKey(toolchain?: WorkareaSpec['toolchain']): string {
  if (!toolchain || Object.keys(toolchain).length === 0) return 'default'
  return Object.entries(toolchain)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}@${v ?? '*'}`)
    .join('+')
}

// ---------------------------------------------------------------------------
// cleanStateChecksum
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 cleanStateChecksum for a workarea.
 *
 * Covers:
 *   - The lockfile (pnpm-lock.yaml / package-lock.json / yarn.lock, whichever exists)
 *   - package.json at the root (engines field)
 *   - .nvmrc / .node-version if present (toolchain pins)
 *
 * Returns a 64-char lowercase hex string.
 * If the lockfile is absent, hashes an empty string (pool member will be
 * considered fresh; an absent lockfile is the project's own choice).
 */
export function computeCleanStateChecksum(workareaPath: string): CleanStateChecksum {
  const hash = createHash('sha256')

  const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock']
  for (const lf of LOCKFILES) {
    const p = resolvePath(workareaPath, lf)
    if (existsSync(p)) {
      hash.update(`lockfile:${lf}:`)
      hash.update(readFileSync(p))
      break // Only hash the first matching lockfile
    }
  }

  // Root package.json — engines field only (avoid noisy version bumps in other fields)
  const pkgPath = resolvePath(workareaPath, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const engines = parsed['engines']
      if (engines) {
        hash.update(`engines:${JSON.stringify(engines)}`)
      }
    } catch {
      // Malformed package.json — skip
    }
  }

  // Toolchain pin files
  const TOOLCHAIN_FILES = ['.nvmrc', '.node-version', '.tool-versions', '.python-version']
  for (const tf of TOOLCHAIN_FILES) {
    const p = resolvePath(workareaPath, tf)
    if (existsSync(p)) {
      hash.update(`${tf}:`)
      hash.update(readFileSync(p))
    }
  }

  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// Per-key mutex
// ---------------------------------------------------------------------------

/**
 * Simple async mutex — chains promises so that concurrent callers for the
 * same key serialize without spinning.
 */
class KeyedMutex {
  private _locks = new Map<string, Promise<void>>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this._locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((res) => { release = res })
    this._locks.set(key, prev.then(() => next))
    await prev
    try {
      return await fn()
    } finally {
      release()
      // Cleanup: if our promise is still registered, remove it
      if (this._locks.get(key) === next) {
        this._locks.delete(key)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LocalPoolWorkareaProvider
// ---------------------------------------------------------------------------

export interface LocalPoolConfig {
  /**
   * Root directory under which pool worktrees are created.
   * Defaults to `{gitRoot}/../{repoName}.wt/pool/`.
   */
  poolDir?: string

  /** Git repository root (used for git commands). */
  gitRoot: string

  /** Package manager used for dependency installs. Default: 'pnpm'. */
  packageManager?: 'pnpm' | 'npm' | 'yarn'

  /** Maximum pool size per (repository, toolchainKey) key. Default: 3. */
  poolCapacity?: number

  /** Max pool member age in ms. Default: 24h. */
  stalenessTtlMs?: number
}

/**
 * OSS reference implementation of WorkareaProvider for the local machine.
 *
 * Implements warm-pool acquire/release with scoped clean, lockfile-change
 * invalidation via fs.watch(), and the typed Result<T,E> error contract from
 * git-worktree.ts.
 */
export class LocalPoolWorkareaProvider implements WorkareaProvider {
  // Provider<'workarea'> identity
  readonly manifest: ProviderManifest<'workarea'> = {
    apiVersion: 'rensei.dev/v1',
    family: 'workarea',
    id: 'local-pool',
    version: '0.1.0',
    name: 'Local Pool WorkareaProvider',
    description: 'OSS reference impl — warm pool of git worktrees on the local filesystem',
    requires: { rensei: '>=0.8.0' },
    entry: { kind: 'static', modulePath: '@donmai/core/workarea/local-pool' },
    capabilitiesDeclared: {
      supportsSnapshot: false,
      supportsWarmPool: true,
      cleanStrategy: 'scoped-clean',
    },
  }

  readonly capabilities: WorkareaProviderCapabilities = {
    supportsSnapshot: false,
    supportsWarmPool: true,
    cleanStrategy: 'scoped-clean',
  }

  readonly scope: ProviderScope = {
    level: 'global',
  }

  readonly signature: ProviderSignature | null = null

  // Internal state
  private readonly _pool = new Map<string, WorkareaPoolMember>()
  private readonly _mutex = new KeyedMutex()
  private _host: ProviderHost | null = null
  private _watcherCleanup: (() => void) | null = null
  private _activated = false

  private readonly _gitRoot: string
  private readonly _poolDir: string
  private readonly _packageManager: 'pnpm' | 'npm' | 'yarn'
  private readonly _poolCapacity: number
  private readonly _stalenessTtlMs: number

  constructor(config: LocalPoolConfig) {
    this._gitRoot = resolvePath(config.gitRoot)
    this._poolDir = config.poolDir
      ? resolvePath(config.poolDir)
      : resolvePath(this._gitRoot, '..', `${_basename(this._gitRoot)}.wt`, 'pool')
    this._packageManager = config.packageManager ?? 'pnpm'
    this._poolCapacity = config.poolCapacity ?? DEFAULT_POOL_CAPACITY
    this._stalenessTtlMs = config.stalenessTtlMs ?? DEFAULT_STALENESS_MS
  }

  // ---------------------------------------------------------------------------
  // Provider<'workarea'> lifecycle
  // ---------------------------------------------------------------------------

  async activate(host: ProviderHost): Promise<void> {
    if (this._activated) return
    this._host = host
    this._activated = true

    if (!existsSync(this._poolDir)) {
      mkdirSync(this._poolDir, { recursive: true })
    }

    this._startLockfileWatcher()

    host.emit({
      kind: 'post-activate',
      provider: { family: 'workarea', id: 'local-pool', version: '0.1.0' },
      durationMs: 0,
    })
  }

  async deactivate(): Promise<void> {
    if (!this._activated) return
    this._activated = false
    if (this._watcherCleanup) {
      this._watcherCleanup()
      this._watcherCleanup = null
    }
    this._host?.emit({
      kind: 'post-deactivate',
      provider: { family: 'workarea', id: 'local-pool', version: '0.1.0' },
    })
    this._host = null
  }

  async health() {
    const poolSize = this._pool.size
    const ready = [...this._pool.values()].filter((m) => m.status === 'ready').length
    if (!existsSync(this._poolDir)) {
      return { status: 'degraded' as const, reason: `poolDir ${this._poolDir} does not exist` }
    }
    return {
      status: 'ready' as const,
      // embed diagnostic info in the reason string for easy debugging
      _diagnostics: { poolSize, ready },
    } as { status: 'ready' }
  }

  // ---------------------------------------------------------------------------
  // acquire() — fast path then slow path
  // ---------------------------------------------------------------------------

  async acquire(spec: WorkareaSpec): Promise<Workarea> {
    const key = _poolKey(spec.source.repository, spec.toolchain)

    return this._mutex.run(key, async () => {
      this._markStaleMembers()

      // Fast path: find a ready member
      const candidate = this._findReadyMember(key)

      if (candidate) {
        return this._acquireFastPath(candidate, spec)
      }

      // Slow path: create a new worktree
      return this._acquireSlowPath(spec, key)
    })
  }

  // ---------------------------------------------------------------------------
  // release()
  // ---------------------------------------------------------------------------

  async release(workarea: Workarea, mode: ReleaseMode): Promise<void> {
    const member = this._pool.get(workarea.id)

    if (mode.kind === 'pause') {
      // Local provider has no memory-pause primitive — degrade to return-to-pool
      this._host?.emit({
        kind: 'post-verb',
        provider: { family: 'workarea', id: 'local-pool', version: '0.1.0' },
        verb: 'release:pause-degraded',
        result: 'local-pool: pause requested, returning to pool',
        durationMs: 0,
      })
      // Log warn-level via globalHookBus
      void globalHookBus.emit({
        kind: 'post-verb',
        provider: { family: 'workarea', id: 'local-pool', version: '0.1.0' },
        verb: 'release:pause-degraded',
        result: `local-pool: pause requested for workarea ${workarea.id}, returning to pool`,
        durationMs: 0,
      })
      console.warn(`[local-pool] pause requested for workarea ${workarea.id} — degrading to return-to-pool`)
      return this.release(workarea, { kind: 'return-to-pool' })
    }

    if (mode.kind === 'archive') {
      // Future: tar to configurable location. For now, degrade to return-to-pool.
      console.warn(`[local-pool] archive not yet implemented for workarea ${workarea.id} — degrading to return-to-pool`)
      return this.release(workarea, { kind: 'return-to-pool' })
    }

    if (mode.kind === 'destroy') {
      if (member) {
        member.status = 'retired'
      }
      const r = removeWorktreePath(workarea.path, this._gitRoot)
      if (!r.ok && r.error !== 'not-found') {
        console.warn(`[local-pool] removeWorktreePath failed for ${workarea.path}: ${r.error}`)
      }
      if (member) {
        this._pool.delete(workarea.id)
      }
      return
    }

    // return-to-pool
    if (member) {
      member.status = 'releasing'
    }

    // Scoped clean
    const cleanResult = cleanWorktree(workarea.path)
    if (!cleanResult.ok) {
      console.warn(`[local-pool] cleanWorktree failed for ${workarea.path}: ${cleanResult.error}`)
      // Even on clean failure, mark ready so the pool can still use the slot
      // (next acquire will re-clean or invalidate)
    }

    if (member) {
      member.status = 'ready'
      member.lastUsedAt = new Date()
      delete member.acquiredAt
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: fast-path acquire
  // ---------------------------------------------------------------------------

  private async _acquireFastPath(member: WorkareaPoolMember, spec: WorkareaSpec): Promise<Workarea> {
    member.status = 'acquired'
    member.acquiredAt = new Date()
    const t0 = Date.now()

    try {
      // Step 1: Ensure ref is correct
      if (member.ref !== spec.source.ref) {
        try {
          execSync(`git fetch origin ${spec.source.ref}`, {
            cwd: member.path,
            stdio: 'pipe',
            encoding: 'utf-8',
            timeout: 30_000,
          })
          execSync(`git checkout ${spec.source.ref}`, {
            cwd: member.path,
            stdio: 'pipe',
            encoding: 'utf-8',
            timeout: 15_000,
          })
          member.ref = spec.source.ref
        } catch {
          // If checkout fails, fall back to slow path
          member.status = 'invalid'
          return this._acquireSlowPath(spec, _poolKey(spec.source.repository, spec.toolchain))
        }
      }

      // Step 2: Scoped clean — rm -rf .next .turbo node_modules/.cache dist coverage
      _scopedClean(member.path)

      // Step 3: Verify lockfile hasn't drifted
      const currentChecksum = computeCleanStateChecksum(member.path)
      if (
        member.cleanStateChecksum &&
        member.cleanStateChecksum !== currentChecksum &&
        member.cleanStateChecksum !== '' // Empty means never computed — skip check
      ) {
        // Lockfile drifted — mark invalid and fall through to slow path
        member.status = 'invalid'
        return this._acquireSlowPath(spec, _poolKey(spec.source.repository, spec.toolchain))
      }

      // Step 4: Compute (or recompute) cleanStateChecksum
      member.cleanStateChecksum = currentChecksum

      const durationMs = Date.now() - t0
      this._emitAcquireEvent(member, spec, 'pool-warm', durationMs)

      return _makeWorkarea(member, this.manifest.id)
    } catch (err) {
      member.status = 'invalid'
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: slow-path acquire
  // ---------------------------------------------------------------------------

  private async _acquireSlowPath(spec: WorkareaSpec, key: string): Promise<Workarea> {
    const t0 = Date.now()

    // Ensure pool dir exists
    if (!existsSync(this._poolDir)) {
      mkdirSync(this._poolDir, { recursive: true })
    }

    const memberId = randomUUID()
    const worktreePath = resolvePath(this._poolDir, `wa-${memberId.slice(0, 8)}`)

    // git worktree add
    const addResult = addWorktree(this._gitRoot, spec.source.ref, worktreePath)
    if (!addResult.ok) {
      throw new Error(`[local-pool] addWorktree failed: ${addResult.error}`)
    }

    // pnpm install --frozen-lockfile (or equivalent)
    _installDeps(worktreePath, this._packageManager)

    const checksum = computeCleanStateChecksum(worktreePath)

    // Determine which repository URL to store
    const repository = spec.source.repository

    const member: WorkareaPoolMember = {
      id: memberId,
      path: worktreePath,
      repository,
      ref: spec.source.ref,
      toolchainKey: deriveToolchainKey(spec.toolchain),
      status: 'acquired',
      cleanStateChecksum: checksum,
      createdAt: new Date(),
      acquiredAt: new Date(),
    }

    this._pool.set(memberId, member)

    const durationMs = Date.now() - t0
    const acquirePath: 'pool-fresh' | 'cold' = this._pool.size === 1 ? 'cold' : 'pool-fresh'
    this._emitAcquireEvent(member, spec, acquirePath, durationMs)

    return _makeWorkarea(member, this.manifest.id)
  }

  // ---------------------------------------------------------------------------
  // Internal: pool helpers
  // ---------------------------------------------------------------------------

  private _findReadyMember(key: string): WorkareaPoolMember | undefined {
    for (const member of this._pool.values()) {
      if (
        member.status === 'ready' &&
        `${member.repository}:${member.toolchainKey}` === key
      ) {
        return member
      }
    }
    return undefined
  }

  private _markStaleMembers(): void {
    const now = Date.now()
    for (const member of this._pool.values()) {
      if (member.status !== 'ready') continue
      const age = now - member.createdAt.getTime()
      if (age > this._stalenessTtlMs) {
        member.status = 'invalid'
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: lockfile watcher
  // ---------------------------------------------------------------------------

  private _startLockfileWatcher(): void {
    const WATCH_LOCK_FILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock']
    const watchers: ReturnType<typeof watch>[] = []

    for (const lf of WATCH_LOCK_FILES) {
      const lockPath = resolvePath(this._gitRoot, lf)
      if (!existsSync(lockPath)) continue

      try {
        const w = watch(lockPath, () => {
          // Mark all ready/acquired pool members invalid on lockfile change
          for (const member of this._pool.values()) {
            if (member.status === 'ready' || member.status === 'acquired') {
              member.status = 'invalid'
            }
          }
          console.log(`[local-pool] lockfile changed (${lf}) — all pool members invalidated`)
        })
        watchers.push(w)
      } catch {
        // Watcher setup can fail in sandboxed environments — non-fatal
      }
    }

    this._watcherCleanup = () => {
      for (const w of watchers) {
        try { w.close() } catch { /* ignore */ }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal: observability
  // ---------------------------------------------------------------------------

  private _emitAcquireEvent(
    member: WorkareaPoolMember,
    spec: WorkareaSpec,
    acquirePath: 'pool-warm' | 'pool-fresh' | 'cold',
    durationMs: number,
  ): void {
    const event = {
      workarea_id: member.id,
      session_id: spec.sessionId,
      provider_id: this.manifest.id,
      ref_requested: spec.source.ref,
      ref_actual: member.ref,
      toolchain_requested: spec.toolchain ?? {},
      toolchain_resolved: { key: member.toolchainKey },
      clean_state_checksum: member.cleanStateChecksum,
      acquire_path: acquirePath,
      acquire_duration_ms: durationMs,
    }
    this._host?.emit({
      kind: 'post-verb',
      provider: { family: 'workarea', id: 'local-pool', version: '0.1.0' },
      verb: 'acquire',
      result: event,
      durationMs,
    })
  }

  // ---------------------------------------------------------------------------
  // Test / diagnostic helpers (not part of the public interface)
  // ---------------------------------------------------------------------------

  /** Return a snapshot of pool members (shallow copy). */
  _getPoolSnapshot(): ReadonlyMap<string, Readonly<WorkareaPoolMember>> {
    return new Map(this._pool)
  }

  /** Forcibly mark all pool members invalid (for testing). */
  _invalidateAll(): void {
    for (const m of this._pool.values()) {
      m.status = 'invalid'
    }
  }

  /** Force-inject a pre-built pool member (for testing). */
  _injectMember(member: WorkareaPoolMember): void {
    this._pool.set(member.id, member)
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Derive the pool key from repository URL + toolchain demand.
 * Format: `<repository>:<toolchainKey>`.
 */
function _poolKey(repository: string, toolchain?: WorkareaSpec['toolchain']): string {
  return `${repository}:${deriveToolchainKey(toolchain)}`
}

/**
 * Map a pool member to an immutable Workarea handle.
 */
function _makeWorkarea(member: WorkareaPoolMember, providerId: string): Workarea {
  return {
    id: member.id,
    path: member.path,
    providerId,
    ref: member.ref,
    cleanStateChecksum: member.cleanStateChecksum,
    toolchain: { key: member.toolchainKey },
    acquired: member.acquiredAt ?? new Date(),
    mode: 'exclusive',
  }
}

/**
 * Run scoped clean in a worktree directory.
 * Removes .next, .turbo, dist, coverage, node_modules/.cache.
 * Best-effort — individual failures don't abort the clean.
 */
function _scopedClean(worktreePath: string): void {
  for (const dir of SCOPED_CLEAN_DIRS) {
    const target = resolvePath(worktreePath, dir)
    if (existsSync(target)) {
      try {
        rmSync(target, { recursive: true, force: true })
      } catch {
        // Best-effort
      }
    }
  }
  // node_modules/.cache
  const nmCache = resolvePath(worktreePath, NM_CACHE_SUBDIR)
  if (existsSync(nmCache)) {
    try {
      rmSync(nmCache, { recursive: true, force: true })
    } catch {
      // Best-effort
    }
  }
}

/**
 * Install dependencies using the configured package manager.
 * Runs pnpm/npm/yarn install --frozen-lockfile.
 */
function _installDeps(worktreePath: string, pm: 'pnpm' | 'npm' | 'yarn'): void {
  const cmd =
    pm === 'pnpm' ? 'pnpm install --frozen-lockfile' :
    pm === 'npm'  ? 'npm ci' :
                    'yarn install --frozen-lockfile'
  execSync(cmd, {
    cwd: worktreePath,
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 300_000, // 5 minutes
  })
}

/**
 * basename without depending on path.basename being tree-shakeable.
 */
function _basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p
}
