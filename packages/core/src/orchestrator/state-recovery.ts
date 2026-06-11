/**
 * State Recovery
 *
 * Detects and recovers agent state from the .agent/ directory.
 * Enables crash recovery and duplicate agent prevention.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { resolve } from 'path'
import type {
  WorktreeState,
  HeartbeatState,
  TodosState,
  RecoveryCheckResult,
  WorktreeStatus,
  StructuredSummary,
} from './state-types.js'
import type { AgentWorkType } from './work-types.js'

// Default heartbeat timeout: 30 seconds
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30000

// Default max recovery attempts
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 3

/**
 * Get the .agent directory path for a worktree
 */
export function getAgentDir(worktreePath: string): string {
  return resolve(worktreePath, '.agent')
}

/**
 * Get the path to the state.json file
 */
export function getStatePath(worktreePath: string): string {
  return resolve(getAgentDir(worktreePath), 'state.json')
}

/**
 * Get the path to the heartbeat.json file
 */
export function getHeartbeatPath(worktreePath: string): string {
  return resolve(getAgentDir(worktreePath), 'heartbeat.json')
}

/**
 * Get the path to the todos.json file
 */
export function getTodosPath(worktreePath: string): string {
  return resolve(getAgentDir(worktreePath), 'todos.json')
}

/**
 * Read and parse a JSON file safely
 */
function readJsonSafe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null
    const content = readFileSync(path, 'utf-8')
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

/**
 * Check if a heartbeat is fresh (agent is alive)
 */
export function isHeartbeatFresh(
  heartbeat: HeartbeatState | null,
  timeoutMs: number = DEFAULT_HEARTBEAT_TIMEOUT_MS
): boolean {
  if (!heartbeat) return false
  const age = Date.now() - heartbeat.timestamp
  return age < timeoutMs
}

/**
 * Read the current state from a worktree
 */
export function readWorktreeState(worktreePath: string): WorktreeState | null {
  return readJsonSafe<WorktreeState>(getStatePath(worktreePath))
}

/**
 * Read the current heartbeat from a worktree
 */
export function readHeartbeat(worktreePath: string): HeartbeatState | null {
  return readJsonSafe<HeartbeatState>(getHeartbeatPath(worktreePath))
}

/**
 * Read the current todos from a worktree
 */
export function readTodos(worktreePath: string): TodosState | null {
  return readJsonSafe<TodosState>(getTodosPath(worktreePath))
}

/**
 * Check if recovery is possible for a worktree
 *
 * When `expectedIdentifier` is provided, the state's `issueIdentifier` must
 * match. If it doesn't, recovery is refused with reason `identifier_mismatch`
 * — the worktree holds state from a different issue (e.g., a stale directory
 * reused across issues, or a worktree-path template change without a
 * migration). Call sites that intentionally inspect *another* issue's
 * worktree (e.g., the orchestrator's branch-conflict liveness check) must
 * omit this option.
 */
export function checkRecovery(
  worktreePath: string,
  options: {
    heartbeatTimeoutMs?: number
    maxRecoveryAttempts?: number
    /**
     * If set, require `state.issueIdentifier === expectedIdentifier`.
     * Mismatches return `canRecover: false, reason: 'identifier_mismatch'`.
     */
    expectedIdentifier?: string
  } = {}
): RecoveryCheckResult {
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
  const maxRecoveryAttempts = options.maxRecoveryAttempts ?? DEFAULT_MAX_RECOVERY_ATTEMPTS

  const agentDir = getAgentDir(worktreePath)

  // Check if .agent directory exists
  if (!existsSync(agentDir)) {
    return {
      canRecover: false,
      agentAlive: false,
      reason: 'no_state',
      message: 'No .agent directory found in worktree',
    }
  }

  // Read state
  const state = readWorktreeState(worktreePath)
  if (!state) {
    return {
      canRecover: false,
      agentAlive: false,
      reason: 'no_state',
      message: 'No state.json found in .agent directory',
    }
  }

  // Validate state
  if (!state.issueId || !state.issueIdentifier) {
    return {
      canRecover: false,
      agentAlive: false,
      state,
      reason: 'invalid_state',
      message: 'State is missing required fields (issueId, issueIdentifier)',
    }
  }

  // Identifier guard: refuse to recover state from a different issue. This
  // protects against stale worktrees reused across issues and path-template
  // changes without migration. Omitted `expectedIdentifier` disables the
  // guard — used by the conflict-check call site that intentionally looks
  // at another agent's worktree.
  if (options.expectedIdentifier && state.issueIdentifier !== options.expectedIdentifier) {
    return {
      canRecover: false,
      agentAlive: false,
      state,
      reason: 'identifier_mismatch',
      message: `Worktree state is for ${state.issueIdentifier} but caller expected ${options.expectedIdentifier} — refusing recovery`,
    }
  }

  // Read heartbeat
  const heartbeat = readHeartbeat(worktreePath)

  // Check if agent is alive
  if (isHeartbeatFresh(heartbeat, heartbeatTimeoutMs)) {
    return {
      canRecover: false,
      agentAlive: true,
      state,
      heartbeat: heartbeat!,
      reason: 'agent_alive',
      message: `Agent is still running (PID: ${heartbeat!.pid}, last heartbeat: ${new Date(heartbeat!.timestamp).toISOString()})`,
    }
  }

  // Check recovery attempts
  if (state.recoveryAttempts >= maxRecoveryAttempts) {
    return {
      canRecover: false,
      agentAlive: false,
      state,
      heartbeat: heartbeat ?? undefined,
      reason: 'max_attempts',
      message: `Maximum recovery attempts reached (${state.recoveryAttempts}/${maxRecoveryAttempts})`,
    }
  }

  // Recovery is possible
  const todos = readTodos(worktreePath)
  return {
    canRecover: true,
    agentAlive: false,
    state,
    heartbeat: heartbeat ?? undefined,
    todos: todos ?? undefined,
    message: `Recovery possible (attempt ${state.recoveryAttempts + 1}/${maxRecoveryAttempts})`,
  }
}

/**
 * Initialize the .agent directory for a worktree
 */
export function initializeAgentDir(worktreePath: string): void {
  const agentDir = getAgentDir(worktreePath)
  if (!existsSync(agentDir)) {
    mkdirSync(agentDir, { recursive: true })
  }
}

/**
 * Write the state.json file
 */
export function writeState(worktreePath: string, state: WorktreeState): void {
  const statePath = getStatePath(worktreePath)
  initializeAgentDir(worktreePath)
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

/**
 * Update specific fields in the state
 */
export function updateState(
  worktreePath: string,
  updates: Partial<WorktreeState>
): WorktreeState | null {
  const current = readWorktreeState(worktreePath)
  if (!current) return null

  const updated: WorktreeState = {
    ...current,
    ...updates,
    lastUpdatedAt: Date.now(),
  }
  writeState(worktreePath, updated)
  return updated
}

/**
 * Write the todos.json file
 */
export function writeTodos(worktreePath: string, todos: TodosState): void {
  const todosPath = getTodosPath(worktreePath)
  initializeAgentDir(worktreePath)
  writeFileSync(todosPath, JSON.stringify(todos, null, 2))
}

/**
 * Create initial state for a new agent
 */
export function createInitialState(options: {
  issueId: string
  issueIdentifier: string
  linearSessionId: string | null
  workType: AgentWorkType
  prompt: string
  workerId?: string | null
  pid?: number | null
}): WorktreeState {
  const now = Date.now()
  const taskListId = getTaskListId(options.issueIdentifier, options.workType)
  return {
    issueId: options.issueId,
    issueIdentifier: options.issueIdentifier,
    linearSessionId: options.linearSessionId,
    providerSessionId: null,
    workType: options.workType,
    prompt: options.prompt,
    startedAt: now,
    status: 'initializing',
    currentPhase: null,
    lastUpdatedAt: now,
    recoveryAttempts: 0,
    workerId: options.workerId ?? null,
    pid: options.pid ?? null,
    taskListId,
  }
}

/**
 * Generate the task list ID for a worktree (matches orchestrator format)
 *
 * @param issueIdentifier - Issue identifier (e.g., "ABC-123")
 * @param workType - Work type suffix (e.g., "development" -> "DEV")
 * @returns Task list ID (e.g., "ABC-123-DEV")
 */
export function getTaskListId(
  issueIdentifier: string,
  workType: AgentWorkType
): string {
  const suffixMap: Record<AgentWorkType, string> = {
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
  return `${issueIdentifier}-${suffixMap[workType]}`
}

/**
 * Build a recovery prompt for resuming crashed work
 */
export function buildRecoveryPrompt(
  state: WorktreeState,
  todos?: TodosState,
  contextSection?: string
): string {
  const lines: string[] = []

  // Inject structured summary context at the top (if available)
  if (contextSection) {
    lines.push(contextSection)
    lines.push('')
    lines.push('---')
    lines.push('You are resuming work on this task. The context above summarizes your progress so far.')
    lines.push('')
  }

  lines.push(`Resume work on ${state.issueIdentifier}.`)
  lines.push('')
  lines.push('RECOVERY CONTEXT:')
  lines.push(`- Previous work type: ${state.workType}`)
  lines.push(`- Last status: ${state.status}`)
  if (state.currentPhase) {
    lines.push(`- Last phase: ${state.currentPhase}`)
  }
  lines.push(`- Recovery attempt: ${state.recoveryAttempts + 1}`)

  // Include task list ID for Claude Code Tasks integration
  const taskListId = getTaskListId(state.issueIdentifier, state.workType)
  lines.push(`- Task list ID: ${taskListId}`)
  lines.push('')

  // Note about Claude Code Tasks persistence
  lines.push('TASK STATE:')
  lines.push(`Your task list is preserved at: ~/.claude/tasks/${taskListId}/`)
  lines.push('Use TaskList to see the current state of pending/completed tasks.')
  lines.push('')

  if (todos && todos.items.length > 0) {
    lines.push('PREVIOUS TODO LIST (legacy):')
    for (const item of todos.items) {
      const statusIcon =
        item.status === 'completed' ? '\u2713' :
        item.status === 'in_progress' ? '\u2192' : '\u25CB'
      lines.push(`  ${statusIcon} [${item.status}] ${item.content}`)
    }
    lines.push('')
  }

  lines.push('INSTRUCTIONS:')
  lines.push('1. Run TaskList to see any pending tasks from the previous session')
  lines.push('2. Check git status to see what has been done')
  lines.push('3. Review the codebase for any partial changes')
  lines.push('4. Continue from where the previous session left off')
  lines.push('5. If work appears complete, verify and create PR if needed')
  // Repeat key context at the end to mitigate "lost in the middle" phenomenon
  if (contextSection) {
    lines.push('')
    lines.push('KEY CONTEXT REMINDER:')
    lines.push(contextSection)
  }

  lines.push('')
  lines.push(`Original prompt: ${state.prompt}`)

  return lines.join('\n')
}

/**
 * Build a context injection string for session resume (non-crash).
 * Returns empty string if no context is available.
 * Uses neutral framing to avoid "context anxiety" (from prior research).
 */
export function buildResumeContext(contextSection: string): string {
  if (!contextSection) return ''

  const lines: string[] = []
  lines.push('Here is your session context:')
  lines.push('')
  lines.push(contextSection)

  return lines.join('\n')
}

/**
 * Parse environment variable for heartbeat timeout
 */
export function getHeartbeatTimeoutFromEnv(): number {
  const envValue = process.env.AGENT_HEARTBEAT_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_HEARTBEAT_TIMEOUT_MS
}

/**
 * Parse environment variable for max recovery attempts
 */
export function getMaxRecoveryAttemptsFromEnv(): number {
  const envValue = process.env.AGENT_MAX_RECOVERY_ATTEMPTS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_MAX_RECOVERY_ATTEMPTS
}

/**
 * Get the path to the summary.json file
 */
export function getSummaryPath(worktreePath: string): string {
  return resolve(getAgentDir(worktreePath), 'summary.json')
}

/**
 * Read the persisted structured summary from a worktree
 */
export function readSummary(worktreePath: string): StructuredSummary | null {
  return readJsonSafe<StructuredSummary>(getSummaryPath(worktreePath))
}

/**
 * Write the structured summary with atomic writes (write to temp, then rename).
 * This ensures the summary survives process crashes.
 */
export function writeSummary(worktreePath: string, summary: StructuredSummary): void {
  const summaryPath = getSummaryPath(worktreePath)
  initializeAgentDir(worktreePath)
  const tempPath = summaryPath + '.tmp'
  writeFileSync(tempPath, JSON.stringify(summary, null, 2))
  renameSync(tempPath, summaryPath)
}
