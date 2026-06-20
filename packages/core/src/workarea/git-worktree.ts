/**
 * Workarea — Git worktree management
 *
 * Plain functions for creating, validating, and removing git worktrees.
 * Extracted from orchestrator.ts to scaffold the WorkareaProvider
 * interface described in 003-workarea-provider.md.
 *
 * These are intentionally plain functions (not yet behind the WorkareaProvider
 * contract) so they can be consumed by the orchestrator today and migrated to the
 * provider interface incrementally.
 *
 * Public typed API:
 *   addWorktree(repo, ref, path)  → AddWorktreeResult
 *   removeWorktree(path)          → RemoveWorktreeResult   (typed overload)
 *   listWorktrees(cwd?)           → ListWorktreesResult
 *   cleanWorktree(path)           → CleanWorktreeResult
 */

import { execSync } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { resolve, dirname, basename, isAbsolute } from 'path'
import {
  ok,
  err,
} from './types.js'
import type {
  AddWorktreeResult,
  RemoveWorktreeResult,
  ListWorktreesResult,
  CleanWorktreeResult,
  WorktreeEntry,
} from './types.js'
import {
  isBranchConflictError as isBranchConflictErrorShared,
  parseConflictingWorktreePath as parseConflictingWorktreePathShared,
} from './branch-conflict.js'
import {
  checkRecovery,
  initializeAgentDir,
  getHeartbeatTimeoutFromEnv,
} from '../orchestrator/state-recovery.js'
import type { AgentWorkType } from '../orchestrator/work-types.js'
import { getLockFileName } from '../package-manager.js'
import type { PackageManager } from '../package-manager.js'
import type { QualityConfig } from '../orchestrator/quality-baseline.js'

// ---------------------------------------------------------------------------
// Types re-exported for callers
// ---------------------------------------------------------------------------

/**
 * Result of checking for incomplete work in a worktree
 */
export interface IncompleteWorkCheck {
  hasIncompleteWork: boolean
  reason?: 'uncommitted_changes' | 'unpushed_commits'
  details?: string
}

/**
 * Check result for pushed work without a PR
 */
export interface PushedWorkCheck {
  hasPushedWork: boolean
  branch?: string
  details?: string
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Find the repo root from a starting directory.
 * Accepts both real .git directories (main repos) and .git files (worktrees).
 */
export function findRepoRoot(startDir: string): string | null {
  let currentDir = startDir
  let prevDir = ''

  while (currentDir !== prevDir) {
    const gitPath = resolve(currentDir, '.git')
    if (existsSync(gitPath)) {
      return currentDir
    }
    prevDir = currentDir
    currentDir = dirname(currentDir)
  }

  return null
}

/**
 * Resolve the main repo root from any path — works for both regular repos
 * and worktrees. For worktrees, follows the .git file's gitdir reference
 * back to the main .git directory.
 */
export function resolveMainRepoRoot(startDir: string): string | null {
  let currentDir = startDir
  let prevDir = ''

  while (currentDir !== prevDir) {
    const gitPath = resolve(currentDir, '.git')
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath)
        if (stat.isDirectory()) {
          // Real .git directory — this is the main repo root
          return currentDir
        }
        // .git file — worktree reference: "gitdir: /path/to/main/.git/worktrees/BRANCH"
        const content = readFileSync(gitPath, 'utf-8').trim()
        if (content.startsWith('gitdir:')) {
          const gitdir = content.replace('gitdir:', '').trim()
          const resolved = isAbsolute(gitdir) ? gitdir : resolve(currentDir, gitdir)
          // Walk up from worktrees/BRANCH → .git → repo root
          let candidate = resolved
          while (candidate !== dirname(candidate)) {
            candidate = dirname(candidate)
            if (basename(candidate) === '.git') {
              try {
                if (statSync(candidate).isDirectory()) {
                  return dirname(candidate)
                }
              } catch {
                // continue walking up
              }
            }
          }
        }
      } catch {
        // If we can't read/stat .git, treat it as the repo root
        return currentDir
      }
    }
    prevDir = currentDir
    currentDir = dirname(currentDir)
  }

  return null
}

/**
 * Resolve a worktree path template into an absolute path.
 *
 * Supports template variables:
 * - `{repoName}` → basename of the git repo root directory
 * - `{branch}` → the worktree branch/identifier name
 *
 * Relative paths are resolved against the git repo root.
 */
export function resolveWorktreePath(
  template: string,
  gitRoot: string,
  branch?: string,
): string {
  const repoName = basename(gitRoot)
  let resolved = template.replace(/\{repoName\}/g, repoName)
  if (branch !== undefined) {
    resolved = resolved.replace(/\{branch\}/g, branch)
  }
  return resolve(gitRoot, resolved)
}

// ---------------------------------------------------------------------------
// Incomplete-work checks
// ---------------------------------------------------------------------------

/**
 * Check if a worktree has uncommitted changes or unpushed commits
 */
export function checkForIncompleteWork(worktreePath: string): IncompleteWorkCheck {
  try {
    const statusOutput = execSync('git status --porcelain', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()

    if (statusOutput.length > 0) {
      const changedFiles = statusOutput.split('\n').length
      return {
        hasIncompleteWork: true,
        reason: 'uncommitted_changes',
        details: `${changedFiles} file(s) with uncommitted changes`,
      }
    }

    try {
      const trackingBranch = execSync('git rev-parse --abbrev-ref @{u}', {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim()

      const unpushedOutput = execSync(`git rev-list --count ${trackingBranch}..HEAD`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim()

      const unpushedCount = parseInt(unpushedOutput, 10)
      if (unpushedCount > 0) {
        return {
          hasIncompleteWork: true,
          reason: 'unpushed_commits',
          details: `${unpushedCount} commit(s) not pushed to ${trackingBranch}`,
        }
      }
    } catch {
      try {
        const logOutput = execSync('git log --oneline -1', {
          cwd: worktreePath,
          encoding: 'utf-8',
          timeout: 10000,
        }).trim()

        if (logOutput.length > 0) {
          const currentBranch = execSync('git branch --show-current', {
            cwd: worktreePath,
            encoding: 'utf-8',
            timeout: 10000,
          }).trim()

          const remoteRef = execSync(`git ls-remote --heads origin ${currentBranch}`, {
            cwd: worktreePath,
            encoding: 'utf-8',
            timeout: 10000,
          }).trim()

          if (remoteRef.length === 0) {
            return {
              hasIncompleteWork: true,
              reason: 'unpushed_commits',
              details: `Branch '${currentBranch}' has not been pushed to remote`,
            }
          }
        }
      } catch {
        // Empty repo or other issue — assume safe to clean
      }
    }

    return { hasIncompleteWork: false }
  } catch (error) {
    return {
      hasIncompleteWork: true,
      reason: 'uncommitted_changes',
      details: `Failed to check git status: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Check if a worktree branch has been pushed to remote with commits ahead of main
 * but no PR was created.
 */
export function checkForPushedWorkWithoutPR(worktreePath: string): PushedWorkCheck {
  try {
    const currentBranch = execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()

    if (currentBranch === 'main' || currentBranch === 'master') {
      return { hasPushedWork: false }
    }

    const aheadOutput = execSync(`git rev-list --count main..HEAD`, {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10000,
    }).trim()

    const aheadCount = parseInt(aheadOutput, 10)
    if (aheadCount === 0) {
      return { hasPushedWork: false }
    }

    try {
      const remoteRef = execSync(`git ls-remote --heads origin ${currentBranch}`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim()

      if (remoteRef.length > 0) {
        return {
          hasPushedWork: true,
          branch: currentBranch,
          details: `Branch \`${currentBranch}\` has ${aheadCount} commit(s) ahead of main and has been pushed to the remote, but no PR was detected.`,
        }
      }
    } catch {
      // ls-remote failed
    }

    return { hasPushedWork: false }
  } catch {
    return { hasPushedWork: false }
  }
}

// ---------------------------------------------------------------------------
// Map work type to worktree identifier suffix
// ---------------------------------------------------------------------------

const WORK_TYPE_SUFFIX: Record<AgentWorkType, string> = {
  research: 'RES',
  'backlog-creation': 'BC',
  'backlog-groomer': 'BG',
  development: 'DEV',
  inflight: 'INF',
  qa: 'QA',
  acceptance: 'AC',
  refinement: 'REF',
  'refinement-coordination': 'REF-COORD',
  merge: 'MRG',
  security: 'SEC',
  'outcome-auditor': 'OA',
  'improvement-loop': 'IMP',
  'ga-readiness': 'GA',
  'documentation-steward': 'DS',
  'operational-scanner-vercel': 'OSV',
  'operational-scanner-audit': 'OSA',
  'operational-scanner-ci': 'OSC',
}

/**
 * Generate a worktree identifier that includes the work type suffix.
 */
export function getWorktreeIdentifier(
  issueIdentifier: string,
  workType: AgentWorkType
): string {
  const suffix = WORK_TYPE_SUFFIX[workType]
  return `${issueIdentifier}-${suffix}`
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the full error message from an execSync error.
 */
function getExecSyncErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const parts: string[] = []
    if ('message' in error && typeof (error as { message: unknown }).message === 'string') {
      parts.push((error as { message: string }).message)
    }
    if ('stderr' in error && typeof (error as { stderr: unknown }).stderr === 'string') {
      parts.push((error as { stderr: string }).stderr)
    }
    if ('stdout' in error && typeof (error as { stdout: unknown }).stdout === 'string') {
      parts.push((error as { stdout: string }).stdout)
    }
    return parts.join('\n')
  }
  return String(error)
}

/**
 * Validate that a path is a valid git worktree.
 */
export function validateWorktree(worktreePath: string): { valid: boolean; reason?: string } {
  if (!existsSync(worktreePath)) {
    return { valid: false, reason: 'Directory does not exist' }
  }

  const gitPath = resolve(worktreePath, '.git')
  if (!existsSync(gitPath)) {
    return { valid: false, reason: 'Missing .git file' }
  }

  try {
    const stat = statSync(gitPath)
    if (stat.isDirectory()) {
      return { valid: false, reason: '.git is a directory, not a worktree reference' }
    }
    const content = readFileSync(gitPath, 'utf-8')
    if (!content.includes('gitdir:')) {
      return { valid: false, reason: '.git file missing gitdir reference' }
    }
  } catch {
    return { valid: false, reason: 'Cannot read .git file' }
  }

  return { valid: true }
}

/**
 * Check if a path is the main git working tree (not a worktree).
 */
export function isMainWorktree(targetPath: string, gitRoot: string): boolean {
  try {
    const gitPath = resolve(targetPath, '.git')
    if (!existsSync(gitPath)) return false
    const stat = statSync(gitPath)
    if (stat.isDirectory()) return true

    const output = execSync('git worktree list --porcelain', {
      stdio: 'pipe',
      encoding: 'utf-8',
      cwd: gitRoot,
    })
    const mainTreeMatch = output.match(/^worktree (.+)$/m)
    if (mainTreeMatch) {
      const mainTreePath = mainTreeMatch[1]
      return resolve(targetPath) === resolve(mainTreePath)
    }
  } catch {
    return true
  }
  return false
}

/**
 * Check if a path is inside the configured worktrees directory.
 */
export function isInsideWorktreesDir(targetPath: string, worktreePathTemplate: string, gitRoot: string): boolean {
  const worktreesDir = resolveWorktreePath(worktreePathTemplate, gitRoot)
  const normalizedTarget = resolve(targetPath)
  return normalizedTarget.startsWith(worktreesDir + '/')
}

// ---------------------------------------------------------------------------
// Conflict cleanup
// ---------------------------------------------------------------------------

/**
 * Attempt to clean up a stale worktree that is blocking branch creation.
 *
 * SAFETY: Never cleans up the main working tree. Only operates on paths
 * inside the configured worktrees directory.
 *
 * @returns true if the conflicting worktree was cleaned up
 */
export function tryCleanupConflictingWorktree(
  conflictPath: string,
  branchName: string,
  gitRoot: string,
  worktreePathTemplate: string,
  patchDirBase: string,
): boolean {
  if (isMainWorktree(conflictPath, gitRoot)) {
    console.warn(
      `SAFETY: Refusing to clean up ${conflictPath} — it is the main working tree. ` +
      `Branch '${branchName}' appears to be checked out in the main repo (e.g., via IDE). ` +
      `The agent will retry or skip this issue.`
    )
    return false
  }

  if (!isInsideWorktreesDir(conflictPath, worktreePathTemplate, gitRoot)) {
    console.warn(
      `SAFETY: Refusing to clean up ${conflictPath} — it is not inside the worktrees directory. ` +
      `Only paths inside '${resolveWorktreePath(worktreePathTemplate, gitRoot)}' can be auto-cleaned.`
    )
    return false
  }

  if (!existsSync(conflictPath)) {
    try {
      execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8', cwd: gitRoot })
      console.log(`Pruned stale worktree reference for branch ${branchName}`)
      return true
    } catch {
      return false
    }
  }

  // Preserved worktrees — save work as patch, then allow cleanup.
  const preservedMarker = resolve(conflictPath, '.agent', 'preserved.json')
  if (existsSync(preservedMarker)) {
    console.warn(
      `Preserved worktree detected at ${conflictPath}. ` +
      `Saving incomplete work as patch before cleanup to unblock branch '${branchName}'.`
    )
    try {
      const patchDir = resolve(patchDirBase, '.patches')
      if (!existsSync(patchDir)) {
        mkdirSync(patchDir, { recursive: true })
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const patchName = `${branchName}-preserved-${timestamp}.patch`
      const patchPath = resolve(patchDir, patchName)

      const diff = execSync('git diff HEAD', {
        cwd: conflictPath,
        encoding: 'utf-8',
        timeout: 10000,
      })
      if (diff.trim().length > 0) {
        writeFileSync(patchPath, diff)
        console.log(`Saved preserved worktree patch: ${patchPath}`)
      }

      const untrackedFiles = execSync(
        'git ls-files --others --exclude-standard',
        { cwd: conflictPath, encoding: 'utf-8', timeout: 10000 }
      ).trim()

      if (untrackedFiles.length > 0) {
        const untrackedPatchName = `${branchName}-preserved-${timestamp}-untracked.patch`
        const untrackedPatchPath = resolve(patchDir, untrackedPatchName)
        const untrackedDiff = execSync(
          'git diff --no-index /dev/null -- ' +
            untrackedFiles.split('\n').map(f => `"${f}"`).join(' ') +
            ' || true',
          { cwd: conflictPath, encoding: 'utf-8', timeout: 10000, shell: '/bin/bash' }
        )
        if (untrackedDiff.trim().length > 0) {
          writeFileSync(untrackedPatchPath, untrackedDiff)
          console.log(`Saved untracked files patch: ${untrackedPatchPath} (${untrackedFiles.split('\n').length} file(s))`)
        }
      }
    } catch (patchError) {
      console.warn(
        'Failed to save preserved worktree patch:',
        patchError instanceof Error ? patchError.message : String(patchError)
      )
    }
  }

  // Check if the agent in the conflicting worktree is still alive
  const recoveryInfo = checkRecovery(conflictPath, {
    heartbeatTimeoutMs: getHeartbeatTimeoutFromEnv(),
    maxRecoveryAttempts: 0,
  })

  if (recoveryInfo.agentAlive) {
    console.log(
      `Branch ${branchName} is held by a running agent at ${conflictPath} - cannot clean up`
    )
    return false
  }

  const incompleteCheck = checkForIncompleteWork(conflictPath)
  if (incompleteCheck.hasIncompleteWork) {
    try {
      const patchDir = resolve(patchDirBase, '.patches')
      if (!existsSync(patchDir)) {
        mkdirSync(patchDir, { recursive: true })
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const patchName = `${branchName}-${timestamp}.patch`
      const patchPath = resolve(patchDir, patchName)

      const diff = execSync('git diff HEAD', {
        cwd: conflictPath,
        encoding: 'utf-8',
        timeout: 10000,
      })
      if (diff.trim().length > 0) {
        writeFileSync(patchPath, diff)
        console.log(`Saved incomplete work patch: ${patchPath}`)
      }

      const untracked = execSync('git ls-files --others --exclude-standard', {
        cwd: conflictPath,
        encoding: 'utf-8',
        timeout: 10000,
      }).trim()
      if (untracked.length > 0) {
        const fullDiff = execSync('git diff HEAD -- . && git diff --no-index /dev/null $(git ls-files --others --exclude-standard) 2>/dev/null || true', {
          cwd: conflictPath,
          encoding: 'utf-8',
          timeout: 10000,
          shell: '/bin/bash',
        })
        if (fullDiff.trim().length > 0) {
          writeFileSync(patchPath, fullDiff)
          console.log(`Saved incomplete work patch (including untracked files): ${patchPath}`)
        }
      }
    } catch (patchError) {
      console.warn('Failed to save work patch before cleanup:', patchError instanceof Error ? patchError.message : String(patchError))
    }
  }

  console.log(
    `Cleaning up stale worktree at ${conflictPath} (agent no longer running) ` +
    `to unblock branch ${branchName}`
  )

  try {
    execSync(`git worktree remove "${conflictPath}" --force`, {
      stdio: 'pipe',
      encoding: 'utf-8',
      cwd: gitRoot,
    })
    console.log(`Removed stale worktree: ${conflictPath}`)
    return true
  } catch (removeError) {
    const removeMsg = removeError instanceof Error ? removeError.message : String(removeError)
    console.warn(`Failed to remove stale worktree ${conflictPath}:`, removeMsg)

    if (removeMsg.includes('is a main working tree')) {
      console.error(
        `SAFETY: git confirmed ${conflictPath} is the main working tree. Aborting cleanup.`
      )
      return false
    }

    try {
      execSync(`rm -rf "${conflictPath}"`, { stdio: 'pipe', encoding: 'utf-8' })
      execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8', cwd: gitRoot })
      console.log(`Force-removed stale worktree: ${conflictPath}`)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Handle a branch conflict error by attempting to clean up the stale worktree
 * and retrying, or throwing a retriable error.
 */
export function handleBranchConflict(
  errorMsg: string,
  branchName: string,
  gitRoot: string,
  worktreePathTemplate: string,
  patchDirBase: string,
): void {
  const conflictPath = parseConflictingWorktreePathShared(errorMsg)

  if (conflictPath) {
    const cleaned = tryCleanupConflictingWorktree(conflictPath, branchName, gitRoot, worktreePathTemplate, patchDirBase)
    if (cleaned) {
      return
    }
  }

  throw new Error(
    `Branch '${branchName}' is already checked out in another worktree. ` +
    `This may indicate another agent is still working on this issue.`
  )
}

// ---------------------------------------------------------------------------
// Worktree lifecycle
// ---------------------------------------------------------------------------

export interface CreateWorktreeOptions {
  /** Issue identifier, e.g. "ABC-294" */
  issueIdentifier: string
  workType: AgentWorkType
  /** Template such as '../{repoName}.wt' */
  worktreePathTemplate: string
  gitRoot: string
  /** Package manager (for dep bootstrapping) */
  packageManager?: string
  /** Whether mergiraf merge driver is disabled via config */
  mergeDriverDisabled?: boolean
  /** Capture quality baseline on creation */
  qualityBaselineEnabled?: boolean
  qualityConfig?: QualityConfig
  /** Called after successful creation to write helper scripts */
  onCreated?: (worktreePath: string) => void
}

/**
 * Create a git worktree for an issue with work type suffix.
 *
 * @returns Object containing worktreePath and worktreeIdentifier
 */
export function createWorktree(opts: CreateWorktreeOptions): { worktreePath: string; worktreeIdentifier: string } {
  const {
    issueIdentifier,
    workType,
    worktreePathTemplate,
    gitRoot,
    packageManager,
    mergeDriverDisabled,
    qualityBaselineEnabled,
    qualityConfig,
    onCreated,
  } = opts

  const worktreeIdentifier = getWorktreeIdentifier(issueIdentifier, workType)
  const worktreePath = resolve(resolveWorktreePath(worktreePathTemplate, gitRoot), worktreeIdentifier)
  const branchName = issueIdentifier

  const parentDir = resolveWorktreePath(worktreePathTemplate, gitRoot)
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true })
  }

  try {
    execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8', cwd: gitRoot })
  } catch {
    // Ignore prune errors
  }

  if (existsSync(worktreePath)) {
    const validation = validateWorktree(worktreePath)
    if (validation.valid) {
      console.log(`Worktree already exists: ${worktreePath}`)
      return { worktreePath, worktreeIdentifier }
    }

    console.log(`Removing invalid worktree: ${worktreePath} (${validation.reason})`)
    try {
      rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 })
    } catch (cleanupError) {
      throw new Error(
        `Failed to clean up invalid worktree at ${worktreePath}: ` +
        `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
      )
    }

    if (existsSync(worktreePath)) {
      throw new Error(`Failed to remove invalid worktree directory at ${worktreePath}`)
    }
  }

  console.log(`Creating worktree: ${worktreePath} (branch: ${branchName})`)

  let hasRemoteMain = false
  try {
    execSync('git fetch origin main', {
      stdio: 'pipe',
      encoding: 'utf-8',
      cwd: gitRoot,
      timeout: 30_000,
    })
    hasRemoteMain = true
  } catch {
    console.warn('Failed to fetch origin/main — proceeding with local main')
  }

  const baseBranch = hasRemoteMain ? 'origin/main' : 'main'

  const NON_COMMITTING_WORK_TYPES = new Set([
    'research', 'backlog-creation', 'refinement', 'refinement-coordination', 'security', 'outcome-auditor', 'ga-readiness',
    'backlog-groomer', 'improvement-loop', 'documentation-steward',
    'operational-scanner-vercel', 'operational-scanner-audit', 'operational-scanner-ci',
  ])

  if (NON_COMMITTING_WORK_TYPES.has(workType)) {
    execSync(`git worktree add --detach "${worktreePath}" ${baseBranch}`, {
      stdio: 'pipe',
      encoding: 'utf-8',
      cwd: gitRoot,
    })
    console.log(`Created detached worktree for ${workType}: ${worktreePath}`)
    return { worktreePath, worktreeIdentifier }
  }

  const patchDirBase = resolveWorktreePath(worktreePathTemplate, gitRoot)
  const MAX_CONFLICT_RETRIES = 1
  let conflictRetries = 0

  const attemptCreate = (): void => {
    try {
      execSync(`git worktree add "${worktreePath}" -b ${branchName} ${baseBranch}`, {
        stdio: 'pipe',
        encoding: 'utf-8',
        cwd: gitRoot,
      })
    } catch (error) {
      const errorMsg = getExecSyncErrorMessage(error)

      if (isBranchConflictErrorShared(errorMsg)) {
        if (conflictRetries < MAX_CONFLICT_RETRIES) {
          conflictRetries++
          handleBranchConflict(errorMsg, branchName, gitRoot, worktreePathTemplate, patchDirBase)
          console.log(`Retrying worktree creation after cleaning up stale worktree`)
          attemptCreate()
          return
        }
        throw new Error(
          `Branch '${branchName}' is already checked out in another worktree. ` +
          `This may indicate another agent is still working on this issue.`
        )
      }

      if (errorMsg.includes('already exists')) {
        try {
          execSync(`git worktree add "${worktreePath}" ${branchName}`, {
            stdio: 'pipe',
            encoding: 'utf-8',
            cwd: gitRoot,
          })

          const CODE_PRODUCING_TYPES = new Set([
            'development', 'inflight',
          ])
          if (CODE_PRODUCING_TYPES.has(workType)) {
            try {
              const aheadCount = execSync(
                `git -C "${worktreePath}" rev-list --count ${baseBranch}..HEAD`,
                { stdio: 'pipe', encoding: 'utf-8' }
              ).trim()
              if (aheadCount === '0') {
                execSync(`git -C "${worktreePath}" reset --hard ${baseBranch}`, {
                  stdio: 'pipe', encoding: 'utf-8',
                })
                console.log(`Reset stale branch ${branchName} to ${baseBranch} (was 0 commits ahead)`)
              }
            } catch {
              console.warn(`Failed to check/reset branch freshness for ${branchName}`)
            }
          }
        } catch (innerError) {
          const innerMsg = getExecSyncErrorMessage(innerError)

          if (isBranchConflictErrorShared(innerMsg)) {
            if (conflictRetries < MAX_CONFLICT_RETRIES) {
              conflictRetries++
              handleBranchConflict(innerMsg, branchName, gitRoot, worktreePathTemplate, patchDirBase)
              console.log(`Retrying worktree creation after cleaning up stale worktree`)
              attemptCreate()
              return
            }
            throw new Error(
              `Branch '${branchName}' is already checked out in another worktree. ` +
              `This may indicate another agent is still working on this issue.`
            )
          }

          throw innerError
        }
      } else {
        throw error
      }
    }
  }

  attemptCreate()

  const validation = validateWorktree(worktreePath)
  if (!validation.valid) {
    try {
      if (existsSync(worktreePath)) {
        execSync(`rm -rf "${worktreePath}"`, { stdio: 'pipe', encoding: 'utf-8' })
      }
      execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8', cwd: gitRoot })
    } catch {
      // Ignore cleanup errors
    }

    throw new Error(
      `Failed to create valid worktree at ${worktreePath}: ${validation.reason}. ` +
      `This may indicate a race condition with another agent.`
    )
  }

  console.log(`Worktree created successfully: ${worktreePath}`)

  // Clear stale stashes
  try {
    const stashList = execSync('git stash list', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
    if (stashList.length > 0) {
      const stashCount = stashList.split('\n').length
      execSync('git stash clear', {
        cwd: worktreePath,
        encoding: 'utf-8',
        timeout: 5000,
      })
      console.log(`Cleared ${stashCount} stale stash(es) to prevent cross-session contamination`)
    }
  } catch {
    // Non-fatal
  }

  // Initialize .agent/ directory for state persistence
  try {
    initializeAgentDir(worktreePath)
  } catch (initError) {
    console.warn(`Failed to initialize .agent/ directory: ${initError instanceof Error ? initError.message : String(initError)}`)
  }

  // Write helper scripts
  if (onCreated) {
    onCreated(worktreePath)
  }

  // Configure mergiraf merge driver if enabled
  if (!mergeDriverDisabled) {
    configureMergiraf(worktreePath)
  }

  // Bootstrap lockfile and package.json from origin/main
  bootstrapWorktreeDeps(worktreePath, packageManager ?? 'pnpm', gitRoot)

  // Quality baseline capture is handled by the caller after this function returns,
  // since it requires the captureQualityBaseline / saveBaseline helpers that live in
  // orchestrator/quality-baseline.ts and are not imported here to avoid a circular dep.
  // opts.qualityBaselineEnabled and opts.qualityConfig are kept in CreateWorktreeOptions
  // so callers can inspect them and run the baseline capture themselves.

  return { worktreePath, worktreeIdentifier }
}

/**
 * Clean up a git worktree.
 */
export function removeWorktree(
  worktreeIdentifier: string,
  worktreePathTemplate: string,
  gitRoot: string,
  deleteBranchName?: string,
): void {
  const worktreePath = resolve(resolveWorktreePath(worktreePathTemplate, gitRoot), worktreeIdentifier)

  if (existsSync(worktreePath)) {
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        stdio: 'pipe',
        encoding: 'utf-8',
        cwd: gitRoot,
      })
    } catch (error) {
      console.warn(`Failed to remove worktree via git, trying fallback:`, error)
      try {
        execSync(`rm -rf "${worktreePath}"`, { stdio: 'pipe', encoding: 'utf-8' })
        execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8', cwd: gitRoot })
      } catch (fallbackError) {
        console.warn(`Fallback worktree removal also failed:`, fallbackError)
      }
    }
  } else {
    try {
      execSync('git worktree prune', { stdio: 'pipe', encoding: 'utf-8', cwd: gitRoot })
    } catch {
      // Ignore
    }
  }

  // Clean up leftover directory shells
  if (existsSync(worktreePath)) {
    try {
      const entries = readdirSync(worktreePath).filter(e => e !== '.agent')
      if (entries.length === 0) {
        rmSync(worktreePath, { recursive: true, force: true })
      }
    } catch {
      // Best-effort cleanup
    }
  }

  if (deleteBranchName) {
    try {
      let hasUpstream = false
      try {
        execSync(`git rev-parse --abbrev-ref ${deleteBranchName}@{upstream}`, {
          stdio: 'pipe',
          encoding: 'utf-8',
          cwd: gitRoot,
        })
        hasUpstream = true
      } catch {
        hasUpstream = false
      }

      if (hasUpstream) {
        console.log(`Preserved branch ${deleteBranchName} (has remote upstream — dev work may still be in progress)`)
      } else {
        execSync(`git branch -D ${deleteBranchName}`, {
          stdio: 'pipe',
          encoding: 'utf-8',
          cwd: gitRoot,
        })
        console.log(`Deleted branch ${deleteBranchName} (non-code-producing work type, no upstream)`)
      }
    } catch {
      // Branch may not exist or may be in use — ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Bootstrap helpers
// ---------------------------------------------------------------------------

/**
 * Bootstrap worktree dependencies from origin/main.
 * Ensures the lockfile and root package.json in the worktree match the latest remote main.
 * No-op for packageManager 'none'.
 */
export function bootstrapWorktreeDeps(worktreePath: string, packageManager: string, gitRoot: string): void {
  const pm = packageManager as PackageManager
  if (pm === 'none') return

  const lockFile = getLockFileName(pm)
  if (!lockFile) return

  try {
    const originLockContent = execSync(`git show origin/main:${lockFile}`, {
      encoding: 'utf-8',
      cwd: gitRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    })
    writeFileSync(resolve(worktreePath, lockFile), originLockContent)
  } catch {
    // Lockfile may not exist on origin/main — skip
  }

  try {
    const originPkgContent = execSync('git show origin/main:package.json', {
      encoding: 'utf-8',
      cwd: gitRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    })
    writeFileSync(resolve(worktreePath, 'package.json'), originPkgContent)
  } catch {
    // Skip if not found
  }
}

/**
 * Configure mergiraf as the git merge driver in a worktree.
 * Falls back silently if mergiraf is not installed.
 */
export function configureMergiraf(worktreePath: string): void {
  try {
    execSync('which mergiraf', { stdio: 'pipe', encoding: 'utf-8' })
  } catch {
    console.log('mergiraf not found on PATH, using default git merge driver')
    return
  }

  try {
    execSync('git config extensions.worktreeConfig true', {
      stdio: 'pipe',
      encoding: 'utf-8',
      cwd: worktreePath,
    })

    execSync('git config --worktree merge.mergiraf.name "mergiraf"', {
      stdio: 'pipe',
      encoding: 'utf-8',
      cwd: worktreePath,
    })
    execSync(
      'git config --worktree merge.mergiraf.driver "mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P"',
      { stdio: 'pipe', encoding: 'utf-8', cwd: worktreePath },
    )

    const gitattributesPath = resolve(worktreePath, '.gitattributes')
    if (!existsSync(gitattributesPath)) {
      const content = [
        '# AST-aware merge driver (mergiraf) — worktree-local',
        '*.ts merge=mergiraf',
        '*.tsx merge=mergiraf',
        '*.js merge=mergiraf',
        '*.jsx merge=mergiraf',
        '*.json merge=mergiraf',
        '*.yaml merge=mergiraf',
        '*.yml merge=mergiraf',
        '*.py merge=mergiraf',
        '*.go merge=mergiraf',
        '*.rs merge=mergiraf',
        '*.java merge=mergiraf',
        '*.css merge=mergiraf',
        '*.html merge=mergiraf',
        '',
        '# Lock files — keep ours and regenerate',
        'pnpm-lock.yaml merge=ours',
        'package-lock.json merge=ours',
        'yarn.lock merge=ours',
        '',
      ].join('\n')
      writeFileSync(gitattributesPath, content, 'utf-8')
    }

    console.log(`mergiraf configured as merge driver in ${worktreePath}`)
  } catch (error) {
    console.warn(
      `Failed to configure mergiraf in worktree: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

// ---------------------------------------------------------------------------
// Typed public API
// ---------------------------------------------------------------------------

/**
 * Paths that must never be used as worktree targets.
 * Rejects: main repo root, anything inside donmai-architecture/, anything under runs/.
 */
function isProtectedPath(targetPath: string): boolean {
  const normalized = resolve(targetPath)

  // Guard: main repo root (has a real .git directory, not a worktree .git file)
  const gitPath = resolve(normalized, '.git')
  if (existsSync(gitPath)) {
    try {
      if (statSync(gitPath).isDirectory()) {
        return true
      }
    } catch {
      // Stat failed — treat as non-protected, git operations will fail later
    }
  }

  // Guard: inside donmai-architecture/
  const parts = normalized.replace(/\\/g, '/').split('/')
  if (parts.includes('donmai-architecture')) {
    return true
  }

  // Guard: under runs/ (top-level sibling or within any ancestor named "runs")
  if (parts.includes('runs')) {
    return true
  }

  return false
}

/**
 * Add a git worktree.
 *
 * @param repo - Absolute path to the main git repository (used as `cwd` for
 *               git commands).
 * @param ref  - Branch name or commit SHA to check out in the new worktree.
 *               If the branch does not yet exist, it will be created from
 *               HEAD.  Pass `--detach` semantics by prefixing the ref with
 *               `--detach ` (the caller is responsible for splitting args).
 *               For a clean API, pass a branch name and let addWorktree
 *               handle the `-b` / existing-branch distinction internally.
 * @param path - Absolute path where the worktree should be created.
 *
 * @returns AddWorktreeResult — ok on success, err with a typed error code on
 *          expected failure.
 */
export function addWorktree(repo: string, ref: string, path: string): AddWorktreeResult {
  const resolvedPath = resolve(path)
  const resolvedRepo = resolve(repo)

  if (isProtectedPath(resolvedPath)) {
    return err('protected-path')
  }

  // Idempotency: if the path already exists and is a valid worktree, succeed
  // immediately so that callers can call addWorktree safely on retry.
  if (existsSync(resolvedPath)) {
    const validation = validateWorktree(resolvedPath)
    if (validation.valid) {
      // Already a valid worktree — return ok (idempotent)
      return ok({ path: resolvedPath, ref })
    }
    return err('path-exists')
  }

  // Ensure parent directory exists
  const parentDir = dirname(resolvedPath)
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true })
  }

  // Check if branch already exists in this repo
  let branchExists = false
  try {
    execSync(`git rev-parse --verify refs/heads/${ref}`, {
      cwd: resolvedRepo,
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    branchExists = true
  } catch {
    branchExists = false
  }

  try {
    if (branchExists) {
      // Branch already exists — check it out (no -b flag)
      execSync(`git worktree add "${resolvedPath}" "${ref}"`, {
        cwd: resolvedRepo,
        stdio: 'pipe',
        encoding: 'utf-8',
      })
    } else {
      // Create new branch from HEAD
      execSync(`git worktree add -b "${ref}" "${resolvedPath}"`, {
        cwd: resolvedRepo,
        stdio: 'pipe',
        encoding: 'utf-8',
      })
    }
    return ok({ path: resolvedPath, ref })
  } catch (error) {
    const msg = getExecSyncErrorMessage(error)

    if (
      msg.includes('already exists') ||
      msg.includes('is already used by worktree') ||
      msg.includes('is already checked out at')
    ) {
      return err('branch-exists')
    }

    if (msg.includes('already exists') && msg.includes(resolvedPath)) {
      return err('path-exists')
    }

    return err('git-error')
  }
}

/**
 * Remove a git worktree by its absolute path.
 *
 * This is the typed variant of removeWorktree().  The existing overload that
 * accepts (identifier, template, gitRoot) is kept for backward compatibility
 * with orchestrator call sites; this new single-argument form is the clean
 * public API backing WorkareaProvider.release.
 *
 * @param path    - Absolute path of the worktree to remove.
 * @param gitRoot - Optional main repo root.  When omitted the function tries
 *                  to resolve it via resolveMainRepoRoot(path).
 *
 * @returns RemoveWorktreeResult — ok on success, err with a typed error code.
 */
export function removeWorktreePath(path: string, gitRoot?: string): RemoveWorktreeResult {
  const resolvedPath = resolve(path)

  if (isProtectedPath(resolvedPath)) {
    return err('protected-path')
  }

  if (!existsSync(resolvedPath)) {
    return err('not-found')
  }

  const root = gitRoot
    ? resolve(gitRoot)
    : (resolveMainRepoRoot(resolvedPath) ?? resolvedPath)

  try {
    execSync(`git worktree remove "${resolvedPath}" --force`, {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    return ok(undefined)
  } catch (removeError) {
    const removeMsg = getExecSyncErrorMessage(removeError)

    if (removeMsg.includes('is a main working tree')) {
      return err('protected-path')
    }

    // Fallback: rm -rf + prune
    try {
      rmSync(resolvedPath, { recursive: true, force: true })
      execSync('git worktree prune', { cwd: root, stdio: 'pipe', encoding: 'utf-8' })
      return ok(undefined)
    } catch {
      return err('git-error')
    }
  }
}

/**
 * List all git worktrees for the repository that contains `cwd`.
 *
 * Uses `git worktree list --porcelain` and parses the output into a typed
 * array.  The first entry is always the main working tree.
 *
 * @param cwd - Any path inside the git repository (defaults to process.cwd()).
 *
 * @returns ListWorktreesResult
 */
export function listWorktrees(cwd: string = process.cwd()): ListWorktreesResult {
  try {
    const raw = execSync('git worktree list --porcelain', {
      cwd: resolve(cwd),
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 10_000,
    })

    const entries: WorktreeEntry[] = []
    let current: Partial<WorktreeEntry> | null = null
    let isFirst = true

    for (const line of raw.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current && current.path !== undefined) {
          entries.push({
            path: current.path,
            head: current.head ?? '',
            branch: current.branch ?? null,
            isMain: current.isMain ?? false,
          })
        }
        current = { path: line.slice('worktree '.length).trim(), isMain: isFirst }
        isFirst = false
      } else if (line.startsWith('HEAD ') && current) {
        current.head = line.slice('HEAD '.length).trim()
      } else if (line.startsWith('branch ') && current) {
        // "branch refs/heads/main" → "main"
        current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
      } else if (line.trim() === 'detached' && current) {
        current.branch = null
      }
    }

    // Push final entry
    if (current && current.path !== undefined) {
      entries.push({
        path: current.path,
        head: current.head ?? '',
        branch: current.branch ?? null,
        isMain: current.isMain ?? false,
      })
    }

    return ok(entries)
  } catch {
    return err('git-error')
  }
}

/**
 * Clean a worktree by removing well-known artifact directories and resetting
 * tracked files to HEAD.  Useful for pool reuse (return-to-pool path in
 * WorkareaProvider).
 *
 * Removed artifact dirs: `.next`, `.turbo`, `dist`, `coverage`,
 * `node_modules/.cache`.
 *
 * @param path - Absolute path to the worktree to clean.
 *
 * @returns CleanWorktreeResult — value.removed lists the paths that were
 *          deleted.
 */
export function cleanWorktree(path: string): CleanWorktreeResult {
  const resolvedPath = resolve(path)

  if (isProtectedPath(resolvedPath)) {
    return err('protected-path')
  }

  if (!existsSync(resolvedPath)) {
    return err('not-found')
  }

  const validation = validateWorktree(resolvedPath)
  if (!validation.valid) {
    return err('invalid-worktree')
  }

  const ARTIFACT_DIRS = [
    '.next',
    '.turbo',
    'dist',
    'coverage',
    resolve(resolvedPath, 'node_modules', '.cache'),
  ]

  const removed: string[] = []

  for (const rel of ARTIFACT_DIRS) {
    const target = rel.startsWith('/') ? rel : resolve(resolvedPath, rel)
    if (existsSync(target)) {
      try {
        rmSync(target, { recursive: true, force: true })
        removed.push(target)
      } catch {
        // Best-effort — don't abort the whole clean for one dir
      }
    }
  }

  // Reset tracked files to HEAD
  try {
    execSync('git checkout -- .', {
      cwd: resolvedPath,
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 30_000,
    })
  } catch {
    return err('git-error')
  }

  return ok({ removed })
}
