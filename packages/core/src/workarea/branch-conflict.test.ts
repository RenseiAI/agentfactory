import { describe, it, expect } from 'vitest'
import {
  isBranchConflictError,
  parseConflictingWorktreePath,
} from './branch-conflict.js'

describe('isBranchConflictError', () => {
  it('matches the "is already used by worktree at" phrasing', () => {
    const msg = "Command failed: git checkout feature-x\nfatal: 'feature-x' is already used by worktree at '/Users/me/repo.wt/feature-x-AC'"
    expect(isBranchConflictError(msg)).toBe(true)
  })

  it('matches the "is already checked out at" phrasing', () => {
    const msg = "fatal: 'feature/x' is already checked out at '/home/u/repo/.worktrees/feature-x'"
    expect(isBranchConflictError(msg)).toBe(true)
  })

  it('returns false for unrelated git errors', () => {
    expect(isBranchConflictError('fatal: could not read from remote repository')).toBe(false)
    expect(isBranchConflictError('CONFLICT (content): Merge conflict in foo.ts')).toBe(false)
    expect(isBranchConflictError('error: pathspec "X" did not match any file(s) known to git')).toBe(false)
  })

  it('returns false for empty input', () => {
    expect(isBranchConflictError('')).toBe(false)
  })

  it('is case-sensitive — git always emits lowercase', () => {
    // If this ever flips, the downstream retry logic would stop firing. Lock
    // it in so a well-meaning refactor can't silently regress.
    expect(isBranchConflictError("'X' IS ALREADY USED BY WORKTREE AT '/p'")).toBe(false)
  })
})

describe('parseConflictingWorktreePath', () => {
  it('extracts the path from "used by worktree at" phrasing', () => {
    const msg = "fatal: 'feature-x' is already used by worktree at '/Users/me/repo.wt/feature-x-AC'"
    expect(parseConflictingWorktreePath(msg)).toBe('/Users/me/repo.wt/feature-x-AC')
  })

  it('extracts the path from "checked out at" phrasing', () => {
    const msg = "fatal: 'feature/x' is already checked out at '/home/u/.worktrees/feature-x'"
    expect(parseConflictingWorktreePath(msg)).toBe('/home/u/.worktrees/feature-x')
  })

  it('handles paths with spaces', () => {
    const msg = "fatal: 'X' is already used by worktree at '/Users/My User/repo/wt/X'"
    expect(parseConflictingWorktreePath(msg)).toBe('/Users/My User/repo/wt/X')
  })

  it('returns null for non-matching messages', () => {
    expect(parseConflictingWorktreePath('fatal: not a git repository')).toBeNull()
    expect(parseConflictingWorktreePath('')).toBeNull()
  })

  it('returns null when the path is unquoted', () => {
    // Shouldn't happen in real git output, but guard against loose matches.
    const msg = "is already used by worktree at /no/quotes/here"
    expect(parseConflictingWorktreePath(msg)).toBeNull()
  })
})
