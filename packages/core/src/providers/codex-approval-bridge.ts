/**
 * Codex Approval Bridge
 *
 * Evaluates Codex App Server `requestApproval` events against deny patterns
 * ported from Claude's `autonomousCanUseTool` callback (claude-provider.ts:33-112).
 *
 * When the Codex App Server's `approvalPolicy` is set to `'onRequest'`, every
 * tool execution flows through this bridge. The bridge auto-approves safe commands
 * and declines destructive patterns — giving Codex the same safety guardrails as Claude
 * without requiring human interaction.
 *
 * Architecture:
 *   App Server emits → requestApproval notification
 *   Approval Bridge evaluates → deny patterns + permission config
 *   Bridge responds → accept | decline | acceptForSession
 */

import type { CodexPermissionConfig } from '../templates/adapters.js'
import { evaluateCommandSafety, SAFETY_DENY_PATTERNS } from './safety-rules.js'
export type { SafetyDenyPattern } from './safety-rules.js'

// Re-export for backward compatibility — existing consumers may import from here
export { SAFETY_DENY_PATTERNS }

// ---------------------------------------------------------------------------
// Approval Decision
// ---------------------------------------------------------------------------

export interface ApprovalDecision {
  action: 'accept' | 'decline' | 'acceptForSession'
  reason?: string
}

// ---------------------------------------------------------------------------
// Command Approval
// ---------------------------------------------------------------------------

/**
 * Evaluate a shell command against safety deny patterns and optional
 * template-level permission patterns.
 *
 * Evaluation order:
 *   1. Safety deny patterns (always checked first, cannot be overridden)
 *   2. Template deny patterns (from `tools.disallow`)
 *   3. Template allow patterns (from `tools.allow`, if present)
 *   4. Default: acceptForSession
 */
export function evaluateCommandApproval(
  command: string,
  permissionConfig?: CodexPermissionConfig,
): ApprovalDecision {
  const cmd = command.trim()
  if (!cmd) return { action: 'acceptForSession' }

  // --- Shared safety deny patterns (always enforced) ---
  const safety = evaluateCommandSafety(cmd)
  if (safety.denied) {
    return { action: 'decline', reason: safety.reason }
  }

  // --- Template deny patterns (from tools.disallow) ---
  if (permissionConfig?.deniedCommandPatterns) {
    for (const { pattern, reason } of permissionConfig.deniedCommandPatterns) {
      if (pattern.test(cmd)) {
        return { action: 'decline', reason }
      }
    }
  }

  // --- Template allow patterns (from tools.allow) ---
  // If allow patterns are defined, only matching commands are accepted.
  // Commands that don't match any allow pattern are declined.
  if (permissionConfig?.allowedCommandPatterns && permissionConfig.allowedCommandPatterns.length > 0) {
    for (const pattern of permissionConfig.allowedCommandPatterns) {
      if (pattern.test(cmd)) {
        return { action: 'acceptForSession' }
      }
    }
    return { action: 'decline', reason: 'command not in allowed list' }
  }

  // Default: accept for session (auto-approve for remainder of session)
  return { action: 'acceptForSession' }
}

// ---------------------------------------------------------------------------
// File Change Approval
// ---------------------------------------------------------------------------

/**
 * Evaluate a file change (write/edit) against safety rules and optional
 * template-level permissions.
 */
export function evaluateFileChangeApproval(
  filePath: string,
  cwd: string,
  permissionConfig?: CodexPermissionConfig,
): ApprovalDecision {
  // Block writes outside worktree root
  if (!filePath.startsWith(cwd)) {
    return { action: 'decline', reason: 'file change outside worktree blocked' }
  }

  // Block .git directory modifications
  if (/\/\.git(\/|$)/.test(filePath)) {
    return { action: 'decline', reason: '.git directory modification blocked' }
  }

  // Template-level file permission restrictions
  if (permissionConfig) {
    if (!permissionConfig.allowFileEdits && filePath !== cwd) {
      return { action: 'decline', reason: 'file edits blocked by template' }
    }
    if (!permissionConfig.allowFileWrites && filePath !== cwd) {
      return { action: 'decline', reason: 'file writes blocked by template' }
    }
  }

  return { action: 'acceptForSession' }
}

/** @deprecated Use SafetyDenyPattern from safety-rules.ts */
type DenyPattern = import('./safety-rules.js').SafetyDenyPattern
export type { DenyPattern }
