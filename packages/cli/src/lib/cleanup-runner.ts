/**
 * Cleanup Runner -- Programmatic API for the worktree cleanup CLI.
 *
 * Exports `runCleanup()` so worktree cleanup can be invoked from code
 * without going through process.argv / process.env / process.exit.
 */

import { execSync } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { resolve, basename } from 'path'

/** Delay between worktree removals (ms) to let IDEs process filesystem events. */
const IDE_SETTLE_DELAY_MS = 1500

/**
 * Reserved directory names inside the worktree root that are NOT agent worktrees.
 * These are infrastructure directories used by internal subsystems.
 */
const RESERVED_WORKTREE_DIRS = new Set([
  '.patches',
])

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CleanupRunnerConfig {
  /** Show what would be cleaned up without removing (default: false) */
  dryRun?: boolean
  /** Force removal even if worktree appears active (default: false) */
  force?: boolean
  /** Custom worktrees directory (default: ../{repoName}.wt) */
  worktreePath?: string
  /** Git root for default worktree path (default: auto-detect) */
  gitRoot?: string
  /** Skip worktree cleanup (default: false) */
  skipWorktrees?: boolean
  /** Skip branch cleanup (default: false) */
  skipBranches?: boolean
}

export interface WorktreeCleanupResult {
  scanned: number
  orphaned: number
  cleaned: number
  skipped: number
  errors: Array<{ path: string; error: string }>
}

export interface CleanupResult extends WorktreeCleanupResult {
  branches: BranchCleanupResult
}

export interface BranchCleanupResult {
  scanned: number
  deleted: number
  errors: Array<{ branch: string; error: string }>
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CleanupOptions {
  dryRun: boolean
  force: boolean
  worktreePath: string
}

interface WorktreeInfo {
  path: string
  branch: string
  isOrphaned: boolean
  reason?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getGitRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return process.cwd()
  }
}

/**
 * Get list of git worktrees from 'git worktree list'
 */
function getGitWorktrees(): Map<string, string> {
  const worktrees = new Map<string, string>()

  try {
    const output = execSync('git worktree list --porcelain', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let currentPath = ''
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        currentPath = line.substring(9)
      } else if (line.startsWith('branch ')) {
        const branch = line.substring(7).replace('refs/heads/', '')
        worktrees.set(currentPath, branch)
      }
    }
  } catch (error) {
    console.error('Failed to list git worktrees:', error)
  }

  return worktrees
}

/**
 * Check if a git branch exists
 */
function branchExists(branchName: string): boolean {
  try {
    execSync(`git show-ref --verify --quiet refs/heads/${branchName}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Check if any processes (IDEs, language servers, etc.) have files open in a
 * directory.  Uses `lsof` on macOS/Linux.  Returns a deduplicated list of
 * process command names so the caller can warn the user.
 */
function getProcessesUsingPath(dirPath: string): string[] {
  try {
    // lsof +D is recursive but can be slow on large trees.
    // We use a short timeout and suppress errors — if it fails, we treat the
    // path as free (better to over-delete than hang forever).
    const output = execSync(`lsof +D "${dirPath}" 2>/dev/null || true`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    })
    if (!output.trim()) return []

    const commands = new Set<string>()
    for (const line of output.split('\n').slice(1)) {
      const cmd = line.split(/\s+/)[0]
      if (cmd) commands.add(cmd)
    }
    return [...commands]
  } catch {
    return []
  }
}

/**
 * Sleep synchronously for the given number of milliseconds.
 */
function sleepSync(ms: number): void {
  execSync(`sleep ${(ms / 1000).toFixed(1)}`, { stdio: 'pipe' })
}

/**
 * Scan the worktrees directory and identify orphaned worktrees
 */
function scanWorktrees(options: CleanupOptions): WorktreeInfo[] {
  const worktreesDir = resolve(options.worktreePath)
  const result: WorktreeInfo[] = []

  if (!existsSync(worktreesDir)) {
    console.log(`Worktrees directory not found: ${worktreesDir}`)
    return result
  }

  const gitWorktrees = getGitWorktrees()
  const entries = readdirSync(worktreesDir)

  for (const entry of entries) {
    // Skip reserved infrastructure directories (merge queue, patches, etc.)
    if (RESERVED_WORKTREE_DIRS.has(entry)) {
      continue
    }

    const entryPath = resolve(worktreesDir, entry)

    try {
      if (!statSync(entryPath).isDirectory()) {
        continue
      }
    } catch {
      continue
    }

    const info: WorktreeInfo = {
      path: entryPath,
      branch: entry,
      isOrphaned: false,
    }

    const isKnownWorktree = gitWorktrees.has(entryPath)
    const branchName = isKnownWorktree ? gitWorktrees.get(entryPath)! : entry

    if (options.force) {
      info.isOrphaned = true
      info.reason = 'force cleanup requested'
    } else if (!isKnownWorktree) {
      info.isOrphaned = true
      info.reason = 'not registered with git worktree'
    } else if (!branchExists(branchName)) {
      info.isOrphaned = true
      info.reason = `branch '${branchName}' no longer exists`
    }

    result.push(info)
  }

  return result
}

/**
 * Remove a single worktree with safety checks.
 *
 * SAFETY: Refuses to remove paths where .git is a directory (main working tree)
 * to prevent catastrophic data loss.
 *
 * IDE SAFETY: Detects processes (VS Code, Cursor, etc.) with open file handles
 * in the worktree.  When detected and `force` is false, the removal is skipped
 * to prevent IDE crashes caused by sudden workspace root deletion.
 */
function removeWorktree(
  worktreePath: string,
  force?: boolean,
): { success: boolean; skipped?: boolean; error?: string } {
  // Safety check: never remove the main working tree
  try {
    const gitPath = resolve(worktreePath, '.git')
    if (existsSync(gitPath) && statSync(gitPath).isDirectory()) {
      return {
        success: false,
        error: `SAFETY: ${worktreePath} is the main working tree (.git is a directory). Refusing to remove.`,
      }
    }
  } catch {
    // If we can't check, err on the side of caution
    return { success: false, error: `SAFETY: Could not verify ${worktreePath} is not the main working tree.` }
  }

  // IDE safety: check for processes with open file handles in this worktree
  const processes = getProcessesUsingPath(worktreePath)
  if (processes.length > 0 && !force) {
    return {
      success: false,
      skipped: true,
      error: `IDE/process still open: ${processes.join(', ')}. Use --force to remove anyway.`,
    }
  }
  if (processes.length > 0) {
    console.log(`\n    warning: ${processes.join(', ')} has files open — forcing removal`)
  }

  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return { success: true }
  } catch {
    try {
      execSync(`rm -rf "${worktreePath}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return { success: true }
    } catch (rmError) {
      return {
        success: false,
        error: rmError instanceof Error ? rmError.message : String(rmError),
      }
    }
  }
}

/**
 * Core cleanup logic
 */
function cleanup(options: CleanupOptions): WorktreeCleanupResult {
  const result: WorktreeCleanupResult = {
    scanned: 0,
    orphaned: 0,
    cleaned: 0,
    skipped: 0,
    errors: [],
  }

  console.log('Scanning worktrees...\n')

  const worktrees = scanWorktrees(options)
  result.scanned = worktrees.length

  if (worktrees.length === 0) {
    console.log('No worktrees found.\n')
    return result
  }

  console.log(`Found ${worktrees.length} worktree(s) in ${options.worktreePath}/\n`)

  for (const wt of worktrees) {
    const status = wt.isOrphaned ? '  orphaned' : '    active'
    const reason = wt.reason ? ` (${wt.reason})` : ''
    console.log(`  ${status}: ${basename(wt.path)}${reason}`)
  }
  console.log('')

  const orphaned = worktrees.filter((wt) => wt.isOrphaned)
  result.orphaned = orphaned.length

  if (orphaned.length === 0) {
    console.log('No orphaned worktrees to clean up.\n')
    return result
  }

  if (options.dryRun) {
    console.log(`[DRY RUN] Would clean up ${orphaned.length} orphaned worktree(s):\n`)
    for (const wt of orphaned) {
      const procs = getProcessesUsingPath(wt.path)
      const procNote = procs.length > 0 ? ` [open: ${procs.join(', ')}]` : ''
      console.log(`  Would remove: ${wt.path}${procNote}`)
    }
    console.log('')
    return result
  }

  console.log(`Cleaning up ${orphaned.length} orphaned worktree(s)...\n`)

  let removedCount = 0
  for (const wt of orphaned) {
    // Settle between removals so IDE file watchers can process previous
    // deletion events without being overwhelmed.
    if (removedCount > 0) {
      sleepSync(IDE_SETTLE_DELAY_MS)
    }

    process.stdout.write(`  Removing ${basename(wt.path)}... `)
    const removal = removeWorktree(wt.path, options.force)

    if (removal.success) {
      console.log('done')
      result.cleaned++
      removedCount++
    } else if (removal.skipped) {
      console.log(`SKIPPED: ${removal.error}`)
      result.skipped++
    } else {
      console.log(`FAILED: ${removal.error}`)
      result.errors.push({ path: wt.path, error: removal.error || 'Unknown error' })
    }
  }
  console.log('')

  try {
    execSync('git worktree prune', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    console.log('Pruned git worktree metadata.\n')
  } catch {
    // Ignore prune errors
  }

  return result
}

// ---------------------------------------------------------------------------
// Branch cleanup
// ---------------------------------------------------------------------------

/**
 * Get the current branch name (to avoid deleting it).
 */
function getCurrentBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return ''
  }
}

/**
 * Get branches that have been merged into the given base branch.
 */
function getMergedBranches(baseBranch: string): string[] {
  try {
    const output = execSync(`git branch --merged ${baseBranch}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return output
      .split('\n')
      .map((line) => line.replace(/^[*+]?\s+/, '').trim())
      .filter((b) => b && b !== baseBranch)
  } catch {
    return []
  }
}

/**
 * Get local branches whose remote tracking branch is gone.
 */
function getGoneBranches(): string[] {
  try {
    // Fetch prune first so we have up-to-date remote state
    execSync('git fetch --prune 2>/dev/null || true', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    })

    const output = execSync('git branch -vv', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const gone: string[] = []
    for (const line of output.split('\n')) {
      // Match lines like "  SUP-123  abc1234 [origin/SUP-123: gone] commit msg"
      if (/\[.*: gone\]/.test(line)) {
        const branch = line.replace(/^\*?\s+/, '').split(/\s+/)[0]
        if (branch) gone.push(branch)
      }
    }
    return gone
  } catch {
    return []
  }
}

/**
 * Clean up stale local branches.
 *
 * Default: deletes branches merged into main.
 * With force: also deletes branches whose remote tracking branch is gone.
 */
function cleanupBranches(options: CleanupOptions): BranchCleanupResult {
  const result: BranchCleanupResult = {
    scanned: 0,
    deleted: 0,
    errors: [],
  }

  // Prune stale worktree metadata first so that branches from prunable
  // worktrees (e.g. research agents) are no longer locked.
  try {
    execSync('git worktree prune', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    // Ignore prune errors
  }

  console.log('Scanning local branches...\n')

  const currentBranch = getCurrentBranch()

  // Determine the base branch (main or master)
  const baseBranch = branchExists('main') ? 'main' : branchExists('master') ? 'master' : ''
  if (!baseBranch) {
    console.log('Could not determine base branch (main/master). Skipping branch cleanup.\n')
    return result
  }

  // Collect branches to delete
  const toDelete = new Set<string>()
  const mergedBranches = getMergedBranches(baseBranch)
  for (const b of mergedBranches) {
    toDelete.add(b)
  }

  if (options.force) {
    const goneBranches = getGoneBranches()
    for (const b of goneBranches) {
      toDelete.add(b)
    }
  }

  // Never delete base branch or current branch
  toDelete.delete(baseBranch)
  toDelete.delete(currentBranch)

  result.scanned = toDelete.size

  if (toDelete.size === 0) {
    console.log('No stale branches found.\n')
    return result
  }

  const merged = new Set(mergedBranches)
  const sorted = [...toDelete].sort()

  for (const branch of sorted) {
    const isMerged = merged.has(branch)
    const reason = isMerged ? 'merged' : 'remote gone'

    if (options.dryRun) {
      console.log(`  Would delete: ${branch} (${reason})`)
      continue
    }

    // Use -d for merged, -D for gone (unmerged)
    const flag = isMerged ? '-d' : '-D'
    try {
      execSync(`git branch ${flag} "${branch}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      console.log(`  deleted: ${branch} (${reason})`)
      result.deleted++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  FAILED: ${branch} — ${msg}`)
      result.errors.push({ branch, error: msg })
    }
  }

  console.log('')
  return result
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function runCleanup(config?: CleanupRunnerConfig): CleanupResult {
  const gitRoot = config?.gitRoot ?? getGitRoot()

  const defaultWorktreePath = resolve(gitRoot, '..', basename(gitRoot) + '.wt')
  const options: CleanupOptions = {
    dryRun: config?.dryRun ?? false,
    force: config?.force ?? false,
    worktreePath: config?.worktreePath ?? defaultWorktreePath,
  }

  // Also scan legacy .worktrees/ location during migration period
  const legacyPath = resolve(gitRoot, '.worktrees')
  const hasLegacyWorktrees = !config?.worktreePath && existsSync(legacyPath)
  if (hasLegacyWorktrees) {
    console.log(`\nNote: Found worktrees at legacy location ${legacyPath}`)
    console.log('  Run "af-migrate-worktrees" to move them to the new default location.\n')
  }

  let worktreeResult: WorktreeCleanupResult
  if (config?.skipWorktrees) {
    worktreeResult = { scanned: 0, orphaned: 0, cleaned: 0, skipped: 0, errors: [] as Array<{ path: string; error: string }> }
  } else {
    worktreeResult = cleanup(options)

    // Merge results from legacy .worktrees/ location if it exists
    if (hasLegacyWorktrees) {
      const legacyOptions: CleanupOptions = { ...options, worktreePath: legacyPath }
      const legacyResult = cleanup(legacyOptions)
      worktreeResult.scanned += legacyResult.scanned
      worktreeResult.orphaned += legacyResult.orphaned
      worktreeResult.cleaned += legacyResult.cleaned
      worktreeResult.skipped += legacyResult.skipped
      worktreeResult.errors.push(...legacyResult.errors)
    }
  }

  const branchResult = config?.skipBranches
    ? { scanned: 0, deleted: 0, errors: [] as Array<{ branch: string; error: string }> }
    : cleanupBranches(options)

  return { ...worktreeResult, branches: branchResult }
}
