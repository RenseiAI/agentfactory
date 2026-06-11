/**
 * Workarea — Dependency linking and synchronisation
 *
 * Plain functions for linking node_modules from a main repo into a worktree
 * and syncing lockfile drift.  Extracted from orchestrator.ts to
 * scaffold the WorkareaProvider interface.
 */

import { execSync } from 'child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { resolve } from 'path'
import { getLockFileName, getInstallCommand } from '../package-manager.js'
import type { PackageManager } from '../package-manager.js'
import { findRepoRoot, resolveMainRepoRoot } from './git-worktree.js'

// ---------------------------------------------------------------------------
// Symlink helpers
// ---------------------------------------------------------------------------

/**
 * Create or update a symlink atomically, handling EEXIST races.
 */
export function safeSymlink(src: string, dest: string): void {
  try {
    symlinkSync(src, dest)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      try {
        const existing = readlinkSync(dest)
        if (resolve(existing) === resolve(src)) return
      } catch {
        // Not a symlink or can't read — remove and retry
      }
      unlinkSync(dest)
      symlinkSync(src, dest)
    } else {
      throw error
    }
  }
}

/**
 * Create a real node_modules directory and symlink each entry from the source.
 *
 * Instead of symlinking the entire node_modules directory (which lets pnpm
 * resolve through the symlink and corrupt the original), we create a real
 * directory and symlink each entry individually.
 *
 * Supports incremental sync: if the destination already exists, only missing
 * or stale entries are updated.
 */
export function linkNodeModulesContents(
  srcNodeModules: string,
  destNodeModules: string,
  identifier: string
): void {
  mkdirSync(destNodeModules, { recursive: true })

  for (const entry of readdirSync(srcNodeModules)) {
    const srcEntry = resolve(srcNodeModules, entry)
    const destEntry = resolve(destNodeModules, entry)

    if (entry.startsWith('@')) {
      const stat = lstatSync(srcEntry)
      if (stat.isDirectory()) {
        mkdirSync(destEntry, { recursive: true })
        for (const scopedEntry of readdirSync(srcEntry)) {
          const srcScoped = resolve(srcEntry, scopedEntry)
          const destScoped = resolve(destEntry, scopedEntry)
          safeSymlink(srcScoped, destScoped)
        }
        continue
      }
    }

    safeSymlink(srcEntry, destEntry)
  }
}

// ---------------------------------------------------------------------------
// node_modules cleanup
// ---------------------------------------------------------------------------

/**
 * Remove all node_modules directories from a worktree (root + per-workspace).
 */
export function removeWorktreeNodeModules(worktreePath: string): void {
  const destRoot = resolve(worktreePath, 'node_modules')
  try {
    if (existsSync(destRoot)) {
      rmSync(destRoot, { recursive: true, force: true })
    }
  } catch {
    // Ignore cleanup errors
  }

  for (const subdir of ['apps', 'packages']) {
    const subPath = resolve(worktreePath, subdir)
    if (!existsSync(subPath)) continue
    try {
      for (const entry of readdirSync(subPath)) {
        const nm = resolve(subPath, entry, 'node_modules')
        if (existsSync(nm)) {
          rmSync(nm, { recursive: true, force: true })
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify that critical dependency symlinks are intact and resolvable.
 * Returns true if verification passes, false if re-linking is needed.
 */
export function verifyDependencyLinks(
  worktreePath: string,
  identifier: string,
  packageManager: string,
): boolean {
  const destRoot = resolve(worktreePath, 'node_modules')
  if (!existsSync(destRoot)) return false

  const sentinels = ['typescript']

  if ((packageManager ?? 'pnpm') === 'pnpm') {
    const repoRoot = findRepoRoot(worktreePath)
    if (repoRoot) {
      const pnpmMeta = resolve(repoRoot, 'node_modules', '.modules.yaml')
      if (existsSync(pnpmMeta)) {
        sentinels.push('.modules.yaml')
      }
    }
  }

  for (const pkg of sentinels) {
    const pkgPath = resolve(destRoot, pkg)
    if (!existsSync(pkgPath)) {
      console.warn(`[${identifier}] Verification: missing ${pkg}`)
      return false
    }
    try {
      statSync(pkgPath)
    } catch {
      console.warn(`[${identifier}] Verification: broken symlink for ${pkg}`)
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Install fallback
// ---------------------------------------------------------------------------

/**
 * Fallback: install dependencies via the configured package manager.
 * Only called when symlinking fails.
 */
export function installDependencies(
  worktreePath: string,
  identifier: string,
  packageManager: string,
): void {
  const pm = (packageManager ?? 'pnpm') as PackageManager
  if (pm === 'none') return

  const frozenCmd = getInstallCommand(pm, true)
  const baseCmd = getInstallCommand(pm, false)
  if (!baseCmd) return

  console.log(`[${identifier}] Installing dependencies via ${pm}...`)

  removeWorktreeNodeModules(worktreePath)

  const installEnv = { ...process.env, ORCHESTRATOR_INSTALL: '1' }

  try {
    execSync(`${frozenCmd ?? baseCmd} 2>&1`, {
      cwd: worktreePath,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 120_000,
      env: installEnv,
    })
    console.log(`[${identifier}] Dependencies installed successfully`)
  } catch {
    try {
      execSync(`${baseCmd} 2>&1`, {
        cwd: worktreePath,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 120_000,
        env: installEnv,
      })
      console.log(`[${identifier}] Dependencies installed (without frozen lockfile)`)
    } catch (retryError) {
      console.warn(
        `[${identifier}] Install failed (agent may retry):`,
        retryError instanceof Error ? retryError.message : String(retryError)
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

/**
 * Link dependencies from the main repo into a worktree via symlinks.
 *
 * Creates a REAL node_modules directory in the worktree and symlinks each
 * entry individually. Falls back to install if symlinking fails.
 *
 * For non-Node repos (packageManager 'none' or no node_modules), this is a no-op.
 */
export function linkDependencies(
  worktreePath: string,
  identifier: string,
  packageManager: string,
  gitRoot?: string,
): void {
  const pm = (packageManager ?? 'pnpm') as PackageManager
  if (pm === 'none') return

  const repoRoot = gitRoot ?? resolveMainRepoRoot(worktreePath) ?? findRepoRoot(worktreePath)
  if (!repoRoot) {
    console.warn(`[${identifier}] Could not find repo root, skipping dependency linking`)
    return
  }

  const mainNodeModules = resolve(repoRoot, 'node_modules')
  if (!existsSync(mainNodeModules)) {
    console.log(`[${identifier}] No node_modules in main repo, skipping dependency linking`)
    return
  }

  console.log(`[${identifier}] Linking dependencies from main repo...`)
  try {
    const destRoot = resolve(worktreePath, 'node_modules')
    linkNodeModulesContents(mainNodeModules, destRoot, identifier)

    let skipped = 0
    for (const subdir of ['apps', 'packages']) {
      const mainSubdir = resolve(repoRoot, subdir)
      if (!existsSync(mainSubdir)) continue

      for (const entry of readdirSync(mainSubdir)) {
        const src = resolve(mainSubdir, entry, 'node_modules')
        const destParent = resolve(worktreePath, subdir, entry)
        const dest = resolve(destParent, 'node_modules')

        if (!existsSync(src)) continue
        if (!existsSync(destParent)) {
          skipped++
          continue
        }

        linkNodeModulesContents(src, dest, identifier)
      }
    }

    for (const subdir of ['apps', 'packages']) {
      const wtSubdir = resolve(worktreePath, subdir)
      if (!existsSync(wtSubdir)) continue

      for (const entry of readdirSync(wtSubdir)) {
        const src = resolve(repoRoot, subdir, entry, 'node_modules')
        const dest = resolve(wtSubdir, entry, 'node_modules')

        if (!existsSync(src)) continue
        if (existsSync(dest)) continue

        linkNodeModulesContents(src, dest, identifier)
      }
    }

    if (skipped > 0) {
      console.log(
        `[${identifier}] Dependencies linked successfully (${skipped} workspace(s) skipped — not on this branch)`
      )
    } else {
      console.log(`[${identifier}] Dependencies linked successfully`)
    }

    if (!verifyDependencyLinks(worktreePath, identifier, pm)) {
      console.warn(`[${identifier}] Dependency verification failed — removing and re-linking`)
      removeWorktreeNodeModules(worktreePath)
      const retryDest = resolve(worktreePath, 'node_modules')
      linkNodeModulesContents(mainNodeModules, retryDest, identifier)

      if (!verifyDependencyLinks(worktreePath, identifier, pm)) {
        console.warn(`[${identifier}] Verification failed after retry — falling back to install`)
        installDependencies(worktreePath, identifier, pm)
      }
    }
  } catch (error) {
    console.warn(
      `[${identifier}] Symlink failed, falling back to install:`,
      error instanceof Error ? error.message : String(error)
    )
    installDependencies(worktreePath, identifier, pm)
  }
}

/**
 * Sync dependencies between worktree and main repo before linking.
 *
 * Detects lockfile drift (ahead or behind origin/main), syncs the main repo,
 * then links into the worktree.
 */
export function syncDependencies(
  worktreePath: string,
  identifier: string,
  packageManager: string,
  gitRoot?: string,
): void {
  const pm = (packageManager ?? 'pnpm') as PackageManager
  if (pm === 'none') return

  const repoRoot = gitRoot ?? resolveMainRepoRoot(worktreePath) ?? findRepoRoot(worktreePath)
  if (!repoRoot) {
    linkDependencies(worktreePath, identifier, pm, gitRoot)
    return
  }

  const lockFileName = getLockFileName(pm)
  if (!lockFileName) {
    linkDependencies(worktreePath, identifier, pm, gitRoot)
    return
  }

  const worktreeLock = resolve(worktreePath, lockFileName)
  const mainLock = resolve(repoRoot, lockFileName)
  const effectiveGitRoot = gitRoot ?? repoRoot

  let behindDrift = false
  try {
    const originLock = execSync(`git show origin/main:${lockFileName}`, {
      encoding: 'utf-8',
      cwd: effectiveGitRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    })
    if (existsSync(worktreeLock)) {
      const wtContent = readFileSync(worktreeLock, 'utf-8')
      if (wtContent !== originLock) {
        console.log(`[${identifier}] Lockfile behind origin/main — updating worktree`)
        writeFileSync(worktreeLock, originLock)
        behindDrift = true
      }
    }
  } catch {
    // git show failed — skip behind-drift check
  }

  let aheadDrift = false
  if (existsSync(worktreeLock) && existsSync(mainLock)) {
    try {
      const wtContent = readFileSync(worktreeLock, 'utf-8')
      const mainContent = readFileSync(mainLock, 'utf-8')
      aheadDrift = wtContent !== mainContent
    } catch {
      // If we can't read either file, proceed without sync
    }
  }

  if (aheadDrift || behindDrift) {
    const driftType = behindDrift && aheadDrift ? 'bidirectional' : behindDrift ? 'behind-main' : 'ahead-of-main'
    console.log(`[${identifier}] Lockfile drift detected (${driftType}) — syncing main repo dependencies`)
    try {
      copyFileSync(worktreeLock, mainLock)

      for (const subdir of ['', 'apps', 'packages']) {
        const wtDir = subdir ? resolve(worktreePath, subdir) : worktreePath
        const mainDir = subdir ? resolve(repoRoot, subdir) : repoRoot

        if (subdir && !existsSync(wtDir)) continue

        const entries = subdir ? readdirSync(wtDir) : ['']
        for (const entry of entries) {
          const wtPkg = resolve(wtDir, entry, 'package.json')
          const mainPkg = resolve(mainDir, entry, 'package.json')

          if (!existsSync(wtPkg) || !existsSync(mainPkg)) continue

          try {
            const wtPkgContent = readFileSync(wtPkg, 'utf-8')
            const mainPkgContent = readFileSync(mainPkg, 'utf-8')
            if (wtPkgContent !== mainPkgContent) {
              copyFileSync(wtPkg, mainPkg)
            }
          } catch {
            // Skip on error
          }
        }
      }

      installDependencies(repoRoot, identifier, pm)
    } catch (syncError) {
      console.warn(
        `[${identifier}] Failed to sync dependencies:`,
        syncError instanceof Error ? syncError.message : String(syncError)
      )
    }
  }

  linkDependencies(worktreePath, identifier, pm, gitRoot)
}
