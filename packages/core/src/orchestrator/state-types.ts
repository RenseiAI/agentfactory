/**
 * Worktree State Types
 *
 * Types for persisting agent state to the .agent/ directory within each worktree.
 * This enables crash recovery, heartbeat monitoring, and progress tracking.
 */

import type { AgentWorkType } from './work-types.js'
import type { AgentProviderName } from '../providers/index.js'

/**
 * Status of the agent's work in the worktree
 */
export type WorktreeStatus =
  | 'initializing' // Agent is starting up
  | 'running' // Agent is actively working
  | 'completing' // Agent is finishing up (e.g., committing, creating PR)
  | 'completed' // Agent finished successfully
  | 'failed' // Agent encountered an error
  | 'stopped' // Agent was stopped (by user request or timeout)

/**
 * Primary state file for the worktree
 * Stored at: .agent/state.json
 */
export interface WorktreeState {
  /** Linear issue ID (UUID) */
  issueId: string
  /** Human-readable issue identifier (e.g., ABC-123) */
  issueIdentifier: string
  /** Linear AgentSession ID (if available) */
  linearSessionId: string | null
  /** Provider CLI session ID for --resume (if available) */
  providerSessionId: string | null
  /** Name of the provider used for the session (e.g., 'claude', 'codex') */
  providerName?: AgentProviderName | null
  /** Type of work being performed */
  workType: AgentWorkType
  /** The prompt that was given to the agent */
  prompt: string
  /** Unix timestamp when work started */
  startedAt: number
  /** Current status of the work */
  status: WorktreeStatus
  /** Human-readable description of current activity */
  currentPhase: string | null
  /** Unix timestamp of last state update */
  lastUpdatedAt: number
  /** Number of times recovery has been attempted */
  recoveryAttempts: number
  /** Worker ID if running on a remote worker */
  workerId: string | null
  /** Process ID of the agent */
  pid: number | null
  /** Error message if status is 'failed' */
  errorMessage?: string
  /** PR URL if one was created */
  pullRequestUrl?: string
  /**
   * Claude Code Task List ID for intra-session task coordination
   * Format: {issueIdentifier}-{WORKTYPE} (e.g., "ABC-123-DEV")
   * Enables task persistence across crashes and subagent coordination
   */
  taskListId?: string
  /**
   * Version counter for coordinating summary freshness.
   * Incremented each time the StructuredSummary is updated.
   */
  summaryVersion?: number
}

/**
 * Activity type for heartbeat tracking
 */
export type HeartbeatActivityType =
  | 'tool_use' // Agent is using a tool
  | 'thinking' // Agent is processing/generating
  | 'waiting' // Agent is waiting for something (e.g., API response)
  | 'idle' // Agent appears idle (may indicate a problem)

/**
 * Heartbeat state file for liveness detection
 * Stored at: .agent/heartbeat.json
 * Updated every 10 seconds while the agent is running
 */
export interface HeartbeatState {
  /** Unix timestamp of this heartbeat */
  timestamp: number
  /** Process ID of the agent */
  pid: number
  /** Memory usage in megabytes */
  memoryUsageMB: number
  /** Uptime in seconds since agent started */
  uptime: number
  /** Type of last detected activity */
  lastActivityType: HeartbeatActivityType
  /** Unix timestamp of last activity */
  lastActivityTimestamp: number
  /** Total number of tool calls made so far */
  toolCallsCount: number
  /** Current operation being performed (if any) */
  currentOperation: string | null
}

/**
 * Todo item status (mirrors TodoWrite tool)
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

/**
 * Todo item (mirrors TodoWrite tool structure)
 */
export interface TodoItem {
  /** Task description (imperative form) */
  content: string
  /** Current status */
  status: TodoStatus
  /** Present continuous form for display */
  activeForm: string
}

/**
 * Persisted todo list state
 * Stored at: .agent/todos.json
 * Synced with TodoWrite tool calls
 */
export interface TodosState {
  /** Unix timestamp of last update */
  updatedAt: number
  /** Current todo items */
  items: TodoItem[]
}

/**
 * Progress log entry type
 */
export type ProgressEventType =
  | 'start' // Agent started
  | 'phase' // Phase/activity changed
  | 'tool' // Tool was called
  | 'error' // Error occurred
  | 'recovery' // Recovery attempt
  | 'complete' // Work completed
  | 'stop' // Agent stopped

/**
 * Progress log entry
 * Appended to: .agent/progress.log
 * Format: timestamp|event_type|details
 */
export interface ProgressLogEntry {
  /** Unix timestamp */
  timestamp: number
  /** Type of event */
  eventType: ProgressEventType
  /** Event details (JSON stringified if object) */
  details: string
}

/**
 * Result of checking for recoverable state in a worktree
 */
export interface RecoveryCheckResult {
  /** Whether recovery is possible */
  canRecover: boolean
  /** Whether an agent is currently alive (heartbeat fresh) */
  agentAlive: boolean
  /** The state if found */
  state?: WorktreeState
  /** The heartbeat if found */
  heartbeat?: HeartbeatState
  /** The todos if found */
  todos?: TodosState
  /** Reason why recovery is not possible */
  reason?: 'no_state' | 'agent_alive' | 'max_attempts' | 'invalid_state' | 'identifier_mismatch'
  /** Human-readable message */
  message: string
}

/**
 * Configuration for heartbeat writer
 */
export interface HeartbeatWriterConfig {
  /** Directory path to write heartbeat to */
  agentDir: string
  /** Process ID of the agent */
  pid: number
  /** Interval between heartbeats in milliseconds (default: 10000) */
  intervalMs?: number
  /** Start time of the agent (for uptime calculation) */
  startTime: number
}

/**
 * Configuration for progress logger
 */
export interface ProgressLoggerConfig {
  /** Directory path to write progress log to */
  agentDir: string
  /** Maximum log file size in bytes before rotation (default: 1MB) */
  maxSizeBytes?: number
}

// --- Context Window Management Types ---

/**
 * Schema version for forward compatibility of summary files
 */
export const SUMMARY_SCHEMA_VERSION = 1

/**
 * Action performed on a file during the session
 */
export type FileAction = 'read' | 'created' | 'modified' | 'deleted'

/**
 * Record of a file operation during the session
 */
export interface FileModification {
  /** Absolute or relative file path */
  path: string
  /** Type of operation performed */
  action: FileAction
  /** Why this file was touched */
  reason: string
  /** Unix timestamp of last modification */
  lastModifiedAt: number
}

/**
 * A decision made during the session with rationale
 */
export interface Decision {
  /** What was decided */
  description: string
  /** Why this choice was made */
  rationale: string
  /** What alternatives were rejected */
  alternatives?: string[]
  /** Unix timestamp when decision was made */
  madeAt: number
}

/**
 * Structured summary for context window management.
 * Persisted to .agent/summary.json for crash recovery and session resume.
 * Uses Factory.ai-style structured summarization with incremental compression.
 */
export interface StructuredSummary {
  /** Schema version for forward compatibility */
  schemaVersion: number
  /** What the agent is trying to accomplish */
  sessionIntent: string
  /** Files touched with action and reason */
  fileModifications: FileModification[]
  /** Choices made with rationale */
  decisionsMade: Decision[]
  /** Remaining planned work */
  nextSteps: string[]
  /** How many compression passes have occurred */
  compactionCount: number
  /** Unix timestamp of last compression */
  lastCompactedAt: number
  /** Approximate token count of this summary */
  tokenEstimate: number
}
