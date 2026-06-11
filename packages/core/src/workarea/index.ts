/**
 * Workarea module — scaffolding for WorkareaProvider
 *
 * Exposes plain functions for git-worktree management and dependency linking.
 * These are consumed by the orchestrator today and will be migrated behind the
 * WorkareaProvider interface when follow-up work ships.
 *
 * Typed public API:
 *   addWorktree, removeWorktreePath, listWorktrees, cleanWorktree
 *   — each returns a structured Result type, no thrown errors for expected failures.
 */

export {
  // Path helpers
  findRepoRoot,
  resolveMainRepoRoot,
  resolveWorktreePath,
  // Worktree identifier
  getWorktreeIdentifier,
  // Incomplete work checks
  checkForIncompleteWork,
  checkForPushedWorkWithoutPR,
  // Worktree validation & lifecycle
  validateWorktree,
  isMainWorktree,
  isInsideWorktreesDir,
  tryCleanupConflictingWorktree,
  handleBranchConflict,
  createWorktree,
  removeWorktree,
  // Bootstrap helpers
  bootstrapWorktreeDeps,
  configureMergiraf,
  // Typed public API
  addWorktree,
  removeWorktreePath,
  listWorktrees,
  cleanWorktree,
} from './git-worktree.js'

export type {
  IncompleteWorkCheck,
  PushedWorkCheck,
  CreateWorktreeOptions,
} from './git-worktree.js'

// Result types
export {
  ok,
  err,
} from './types.js'

export type {
  Result,
  AddWorktreeError,
  AddWorktreeValue,
  AddWorktreeResult,
  RemoveWorktreeError,
  RemoveWorktreeResult,
  ListWorktreesError,
  ListWorktreesResult,
  CleanWorktreeError,
  CleanWorktreeValue,
  CleanWorktreeResult,
  WorktreeEntry,
} from './types.js'

export {
  // Symlink helpers
  safeSymlink,
  linkNodeModulesContents,
  removeWorktreeNodeModules,
  verifyDependencyLinks,
  installDependencies,
  linkDependencies,
  syncDependencies,
} from './dep-linker.js'

// WorkareaProvider local-pool implementation
export {
  LocalPoolWorkareaProvider,
  computeCleanStateChecksum,
  deriveToolchainKey,
} from './local-pool.js'

export type {
  LocalPoolConfig,
} from './local-pool.js'

// WorkareaProvider types
export type {
  WorkareaId,
  CleanStateChecksum,
  WorkareaSource,
  ToolchainDemand,
  WorkareaSpec,
  Workarea,
  ReleaseMode,
  WorkareaSnapshotRef,
  WorkareaPoolMemberStatus,
  WorkareaPoolMember,
  WorkareaProvider,
} from './types.js'
