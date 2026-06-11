/**
 * Dispatcher — work-queue routing and capability-based provider selection
 *
 * Extracted from orchestrator.ts.  Contains:
 *   - Work-type detection and coordination-variant upgrade logic
 *   - Provider/model/profile resolution for a spawn context
 *   - Shell-command classification helpers used by the event loop
 *   - Session-output tracking signal classifier
 *
 * The AgentOrchestrator imports these helpers so its own body stays focused
 * on the session lifecycle and dispatch loop.
 */

import type { AgentWorkType } from './work-types.js'

// ---------------------------------------------------------------------------
// Work-type detection
// ---------------------------------------------------------------------------

/**
 * Map work type to worktree identifier suffix.
 * This prevents different work types from using the same worktree directory.
 */
export const WORK_TYPE_SUFFIX: Record<AgentWorkType, string> = {
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
 * Detect the appropriate work type for an issue based on its status.
 * Parent and leaf issues use the same work type — coordinator behavior
 * is decided at runtime by the agent based on sub-issue presence.
 */
export function detectWorkType(
  statusName: string,
  _isParent: boolean,
  statusToWorkType?: Record<string, AgentWorkType>
): AgentWorkType {
  const mapping = statusToWorkType ?? {}
  const workType: AgentWorkType = mapping[statusName] ?? 'development'
  console.log(`Auto-detected work type: ${workType} (from status: ${statusName})`)

  return workType
}

// ---------------------------------------------------------------------------
// Acceptance-transition guard
// ---------------------------------------------------------------------------

/**
 * Decide whether a passing acceptance session should DEFER its
 * Delivered → Accepted promotion to the merge worker.
 *
 * Returns false when:
 *   - no merge queue adapter is configured (acceptance merges directly)
 *   - work type is not acceptance
 */
export function shouldDeferAcceptanceTransition(
  workType: AgentWorkType,
  hasMergeQueueAdapter: boolean,
): boolean {
  if (!hasMergeQueueAdapter) return false
  return workType === 'acceptance'
}

// ---------------------------------------------------------------------------
// Shell-command classifiers (used by the event-stream loop)
// ---------------------------------------------------------------------------

/**
 * Pull the actual shell command string out of a tool_use input shape.
 * Codex emits `{ command: string }`, but different providers may wrap it
 * differently (e.g., `{ cmd: [...] }`). Returns undefined when the shape
 * doesn't contain a parseable command.
 */
export function extractShellCommand(input: unknown): string | undefined {
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.command === 'string') return obj.command
    if (Array.isArray(obj.command)) {
      return obj.command.filter((p): p is string => typeof p === 'string').join(' ')
    }
    if (typeof obj.cmd === 'string') return obj.cmd
  }
  return undefined
}

/**
 * Pattern matcher for "legacy grep/glob" shell commands. Used by the code
 * intelligence adoption counter so shell-based search (rg, grep, find, sed -n
 * for reading files, ls recursively) is attributed the same way Claude's
 * native Grep/Glob tools are.
 */
export function isGrepGlobShellCommand(command: string): boolean {
  const stripped = command.replace(
    /^\s*(?:\/[^\s]+\/)?(?:ba|z)?sh\s+-(?:l?c|c)\s+['"]?/i,
    '',
  )
  const firstTokens = stripped
    .split(/[;&|]|\n/)
    .map(s => s.trim().split(/\s+/)[0])
    .filter(Boolean)

  const LEGACY_SEARCH_COMMANDS = new Set([
    'rg', 'ripgrep',
    'grep', 'egrep', 'fgrep',
    'find', 'fd',
    'ack',
    'ag',
    'sed',
  ])

  return firstTokens.some(tok => LEGACY_SEARCH_COMMANDS.has(tok))
}

// ---------------------------------------------------------------------------
// Tool-error classification (used by provider event handling)
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate tool-related errors (not API or resource limit errors).
 */
const TOOL_ERROR_PATTERNS = [
  /sandbox/i,
  /not allowed/i,
  /operation not permitted/i,
  /permission denied/i,
  /EACCES/,
  /access denied/i,
  /ENOENT/,
  /no such file or directory/i,
  /file not found/i,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /connection refused/i,
  /network error/i,
  /command failed/i,
  /exited with code/i,
  /tool.*error/i,
  /tool.*failed/i,
  /is_error.*true/i,
]

/**
 * Check if an error message is related to tool execution
 * (vs API errors, resource limits, etc.)
 */
export function isToolRelatedError(error: string): boolean {
  return TOOL_ERROR_PATTERNS.some((pattern) => pattern.test(error))
}

/**
 * Extract tool name from an error message if present.
 */
export function extractToolNameFromError(error: string): string {
  const patterns = [
    /Tool\s+["']?(\w+)["']?/i,
    /(\w+)\s+tool.*(?:error|failed)/i,
    /Failed to (?:run|execute|call)\s+["']?(\w+)["']?/i,
  ]

  for (const pattern of patterns) {
    const match = error.match(pattern)
    if (match && match[1]) {
      return match[1]
    }
  }

  return 'unknown'
}

// ---------------------------------------------------------------------------
// MentionContext merge helper
// ---------------------------------------------------------------------------

/**
 * Merge a caller-supplied `customPrompt` with any explicit `mentionContext`
 * into a single string suitable for injection into the template registry's
 * `mentionContext` slot.
 *
 * Returns `undefined` when neither input is a non-empty string.
 */
export function mergeMentionContext(
  mentionContext: string | undefined,
  customPrompt: string | undefined,
): string | undefined {
  const parts = [mentionContext, customPrompt]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined
}
