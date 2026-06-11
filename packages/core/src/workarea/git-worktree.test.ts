/**
 * Tests for the typed git-worktree public API (REN-1285)
 *
 * Each test suite spins up a temporary git repo so the real repo is never
 * touched.  Suites are isolated — no shared state.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { tmpdir } from 'os'

/** Resolve symlinks so macOS /var → /private/var comparisons work. */
function realpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
import {
  addWorktree,
  cleanWorktree,
  listWorktrees,
  removeWorktreePath,
} from './git-worktree.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix = 'af-wt-test-'): string {
  const dir = resolve(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Initialise a minimal git repo with a single commit so worktrees can be
 * added.  Returns the absolute path to the repo root.
 */
function initRepo(dir: string): string {
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  writeFileSync(resolve(dir, 'README.md'), '# test repo\n')
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' })
  execSync('git commit -m "init"', { cwd: dir, stdio: 'pipe' })
  return dir
}

// ---------------------------------------------------------------------------
// Test contexts (one repo per suite)
// ---------------------------------------------------------------------------

describe('addWorktree + removeWorktreePath: add-then-remove', () => {
  let repo: string
  let wtRoot: string

  beforeEach(() => {
    repo = makeTmpDir('af-repo-')
    initRepo(repo)
    wtRoot = makeTmpDir('af-wt-')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(wtRoot, { recursive: true, force: true })
  })

  it('adds a worktree and reports the path', () => {
    const wtPath = resolve(wtRoot, 'my-branch')
    const result = addWorktree(repo, 'my-branch', wtPath)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.path).toBe(wtPath)
    expect(result.value.ref).toBe('my-branch')
    expect(existsSync(wtPath)).toBe(true)
  })

  it('removes the worktree after adding it', () => {
    const wtPath = resolve(wtRoot, 'rm-branch')
    const addResult = addWorktree(repo, 'rm-branch', wtPath)
    expect(addResult.ok).toBe(true)

    const removeResult = removeWorktreePath(wtPath, repo)
    expect(removeResult.ok).toBe(true)
    expect(existsSync(wtPath)).toBe(false)
  })

  it('removeWorktreePath returns not-found for a path that does not exist', () => {
    const missing = resolve(wtRoot, 'does-not-exist')
    const result = removeWorktreePath(missing, repo)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('not-found')
  })
})

describe('addWorktree: double-add idempotency', () => {
  let repo: string
  let wtRoot: string

  beforeEach(() => {
    repo = makeTmpDir('af-repo-idem-')
    initRepo(repo)
    wtRoot = makeTmpDir('af-wt-idem-')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(wtRoot, { recursive: true, force: true })
  })

  it('returns ok on the second call when the worktree already exists', () => {
    const wtPath = resolve(wtRoot, 'idem-branch')

    const first = addWorktree(repo, 'idem-branch', wtPath)
    expect(first.ok).toBe(true)

    // Call again with the same path — should succeed (idempotent)
    const second = addWorktree(repo, 'idem-branch', wtPath)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.value.path).toBe(wtPath)
  })

  it('returns path-exists when the directory exists but is not a valid worktree', () => {
    const wtPath = resolve(wtRoot, 'not-a-wt')
    mkdirSync(wtPath, { recursive: true })
    // Directory exists but has no .git file → not a valid worktree

    const result = addWorktree(repo, 'some-branch', wtPath)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('path-exists')
  })
})

describe('cleanWorktree: clean of dirty worktree', () => {
  let repo: string
  let wtRoot: string
  let wtPath: string

  beforeEach(() => {
    repo = makeTmpDir('af-repo-clean-')
    initRepo(repo)
    wtRoot = makeTmpDir('af-wt-clean-')
    wtPath = resolve(wtRoot, 'clean-branch')
    const add = addWorktree(repo, 'clean-branch', wtPath)
    if (!add.ok) throw new Error(`addWorktree failed in beforeEach: ${add.error}`)
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(wtRoot, { recursive: true, force: true })
  })

  it('removes artifact directories from the worktree', () => {
    // Create artifact directories
    const nextDir = resolve(wtPath, '.next')
    const turboDir = resolve(wtPath, '.turbo')
    const distDir = resolve(wtPath, 'dist')
    mkdirSync(nextDir, { recursive: true })
    mkdirSync(turboDir, { recursive: true })
    mkdirSync(distDir, { recursive: true })

    const result = cleanWorktree(wtPath)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(existsSync(nextDir)).toBe(false)
    expect(existsSync(turboDir)).toBe(false)
    expect(existsSync(distDir)).toBe(false)
    // removed list should contain the three dirs
    expect(result.value.removed.length).toBeGreaterThanOrEqual(3)
  })

  it('restores a modified tracked file to HEAD', () => {
    const readmePath = resolve(wtPath, 'README.md')
    writeFileSync(readmePath, '# dirtied\n')

    const result = cleanWorktree(wtPath)
    expect(result.ok).toBe(true)

    // File should be back to original content
    const content = readFileSync(readmePath, 'utf-8')
    expect(content).not.toContain('dirtied')
  })

  it('returns not-found for a path that does not exist', () => {
    const missing = resolve(wtRoot, 'ghost')
    const result = cleanWorktree(missing)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('not-found')
  })

  it('returns invalid-worktree for a plain directory that is not a worktree', () => {
    const plain = resolve(wtRoot, 'plain-dir')
    mkdirSync(plain, { recursive: true })

    const result = cleanWorktree(plain)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('invalid-worktree')
  })
})

describe('addWorktree / removeWorktreePath / cleanWorktree: error on protected paths', () => {
  let repo: string
  let wtRoot: string

  beforeEach(() => {
    repo = makeTmpDir('af-repo-guard-')
    initRepo(repo)
    wtRoot = makeTmpDir('af-wt-guard-')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(wtRoot, { recursive: true, force: true })
  })

  it('addWorktree rejects a path inside donmai-architecture/', () => {
    const protected_ = resolve(tmpdir(), 'donmai-architecture', 'sub')
    const result = addWorktree(repo, 'some-branch', protected_)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('protected-path')
  })

  it('addWorktree rejects a path under runs/', () => {
    const protected_ = resolve(tmpdir(), 'runs', '2026-04-27-foundation', 'sub')
    const result = addWorktree(repo, 'some-branch', protected_)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('protected-path')
  })

  it('addWorktree rejects the main repo root itself', () => {
    // repo has a real .git directory → must be treated as protected
    const result = addWorktree(repo, 'some-branch', repo)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('protected-path')
  })

  it('removeWorktreePath rejects a path inside donmai-architecture/', () => {
    const protected_ = resolve(tmpdir(), 'donmai-architecture', 'sub')
    const result = removeWorktreePath(protected_, repo)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('protected-path')
  })

  it('cleanWorktree rejects a path inside donmai-architecture/', () => {
    const protected_ = resolve(tmpdir(), 'donmai-architecture', 'sub')
    const result = cleanWorktree(protected_)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('protected-path')
  })

  it('cleanWorktree rejects a path under runs/', () => {
    const protected_ = resolve(tmpdir(), 'runs', '2026-04-27-session', 'sub')
    const result = cleanWorktree(protected_)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('protected-path')
  })
})

describe('listWorktrees', () => {
  let repo: string
  let wtRoot: string

  beforeEach(() => {
    repo = makeTmpDir('af-repo-list-')
    initRepo(repo)
    wtRoot = makeTmpDir('af-wt-list-')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(wtRoot, { recursive: true, force: true })
  })

  it('returns at least the main worktree', () => {
    const result = listWorktrees(repo)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.length).toBeGreaterThanOrEqual(1)
    const main = result.value.find(e => e.isMain)
    expect(main).toBeDefined()
    // Use realpath to handle macOS /var → /private/var symlink
    expect(realpath(main?.path ?? '')).toBe(realpath(resolve(repo)))
  })

  it('lists added worktrees', () => {
    const wtPath = resolve(wtRoot, 'list-branch')
    const add = addWorktree(repo, 'list-branch', wtPath)
    expect(add.ok).toBe(true)

    const result = listWorktrees(repo)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Use realpath to handle macOS /var → /private/var symlink
    const found = result.value.find(e => realpath(e.path) === realpath(wtPath))
    expect(found).toBeDefined()
    expect(found?.branch).toBe('list-branch')
    expect(found?.isMain).toBe(false)
  })
})
