/**
 * Agent Orchestrator Types
 */

import type { AgentWorkType, WorkTypeStatusMappings } from './work-types.js'
import type { AgentProvider, AgentProviderName } from '../providers/types.js'
import type { IssueTrackerClient } from './issue-tracker-client.js'
import type { ToolPlugin } from '../tools/types.js'
import type { DeployProvider } from '../deployment/types.js'

/**
 * Result of parsing an agent's output to determine pass/fail
 * Used for QA and acceptance work types to decide status transitions
 */
export type AgentWorkResult = 'passed' | 'failed' | 'unknown'

/**
 * Timeout configuration for a specific work type
 */
export interface WorkTypeTimeoutConfig {
  /** Inactivity timeout in milliseconds for this work type */
  inactivityTimeoutMs?: number
  /** Maximum session duration in milliseconds for this work type */
  maxSessionTimeoutMs?: number
}

export interface OrchestratorConfig {
  /** Agent provider instance. If not provided, resolved via AGENT_PROVIDER env var (default: claude) */
  provider?: AgentProvider
  /** Maximum concurrent agents (default: 3) */
  maxConcurrent?: number
  /** Project name to filter backlog issues */
  project?: string
  /** Base path template for git worktrees. Supports {repoName} and {branch} variables (default: '../{repoName}.wt') */
  worktreePath?: string
  /**
   * Linear API key (defaults to LINEAR_API_KEY env var).
   * @deprecated Use issueTrackerClient instead. Kept for backwards compatibility.
   */
  linearApiKey?: string
  /**
   * Platform-agnostic issue tracker client.
   * When provided, the orchestrator uses this instead of creating a Linear client from linearApiKey.
   */
  issueTrackerClient?: IssueTrackerClient
  /**
   * Status mapping configuration for the issue tracker.
   * Required when using issueTrackerClient. Defines how statuses map to work types.
   */
  statusMappings?: WorkTypeStatusMappings
  /**
   * Tool plugins to register with the orchestrator.
   * These are registered in addition to any built-in plugins.
   */
  toolPlugins?: ToolPlugin[]
  /** Whether to auto-transition issue status (default: true) */
  autoTransition?: boolean
  /**
   * Preserve worktree when PR creation fails for development work types (default: true).
   * When true, worktrees are kept if:
   * - Work type is 'development' or 'inflight' and no PR URL was detected
   * - There are uncommitted changes in the worktree
   * - There are unpushed commits on the branch
   * This prevents data loss when git push or PR creation fails.
   */
  preserveWorkOnPrFailure?: boolean
  /**
   * Enable sandbox mode for spawned agents (default: false).
   *
   * WARNING: Currently defaults to false due to known bugs in Claude Code's sandbox:
   * - https://github.com/anthropics/claude-code/issues/14162 (excludedCommands doesn't bypass network)
   * - https://github.com/anthropics/claude-code/issues/12150 (proxy set for excluded commands)
   *
   * Set to true to re-enable sandbox once these issues are fixed.
   */
  sandboxEnabled?: boolean
  /** Configuration for streaming activities to Linear */
  streamConfig?: OrchestratorStreamConfig
  /**
   * Configuration for proxying activities through the agent API.
   * When set, activities are sent to the API endpoint instead of directly to Linear.
   * This is required for remote workers because Linear's Agent API requires OAuth tokens.
   */
  apiActivityConfig?: {
    /** Base URL of the agent API (e.g., https://donmai.dev/dashboard) */
    baseUrl: string
    /** API authentication key for the worker */
    apiKey: string
    /** Worker ID for identification */
    workerId: string
  }
  /**
   * Inactivity timeout in milliseconds (default: 300000 = 5 minutes).
   * Agent is stopped if no activity for this duration.
   * Can be overridden per work type via workTypeTimeouts.
   */
  inactivityTimeoutMs?: number
  /**
   * Maximum session duration in milliseconds (default: unlimited).
   * Hard cap on total agent runtime regardless of activity.
   * Can be overridden per work type via workTypeTimeouts.
   */
  maxSessionTimeoutMs?: number
  /**
   * Per-work-type timeout overrides.
   * Different work types (e.g., QA, development) can have different thresholds.
   */
  workTypeTimeouts?: Partial<Record<AgentWorkType, WorkTypeTimeoutConfig>>
  /**
   * Path to a directory containing custom workflow template YAML files.
   * Templates in this directory override built-in defaults per work type.
   * Supports .donmai/templates/ convention.
   */
  templateDir?: string
  /**
   * Git remote URL pattern to validate against (e.g. 'github.com/RenseiAI/donmai-libraries').
   * When set, the orchestrator validates that the git remote origin contains this pattern
   * at startup and before spawning agents. Supports both HTTPS and SSH URL formats.
   */
  repository?: string
  /** Merge queue adapter for automated merge operations */
  mergeQueueAdapter?: import('../merge-queue/types.js').MergeQueueAdapter
  /** Storage backend for the local merge queue adapter (required when provider is 'local') */
  mergeQueueStorage?: import('../merge-queue/adapters/local.js').LocalMergeQueueStorage
  /**
   * File reservation delegate for per-file coordination across parallel sessions.
   * When provided, injected into ToolPluginContext so code-intelligence tools
   * can reserve/release files and check for conflicts.
   */
  fileReservation?: import('../tools/types.js').ToolPluginContext['fileReservation']
  /**
   * Optional deployment provider for checking deployment status.
   * When provided, enables deployment status checking for QA/acceptance workflows.
   */
  deployProvider?: DeployProvider
  /**
   * Architectural Intelligence instance for session-start context injection.
   * When provided, the orchestrator queries it at session start and injects the returned
   * ArchView into the `architecturalContext` template variable.
   * When omitted, architectural context injection is skipped gracefully.
   */
  architecturalIntelligence?: import('@donmai/architectural-intelligence').ArchitecturalIntelligence
  /**
   * Maximum tokens to devote to the architectural context section.
   * Defaults to 2000. Priority order: drift warnings > active issue patterns >
   * project-wide conventions > org-wide patterns.
   */
  architecturalContextMaxTokens?: number
}

export interface OrchestratorIssue {
  id: string
  identifier: string
  title: string
  description: string | undefined
  url: string
  priority: number
  labels: string[]
  /** Team key resolved from the issue (used to set LINEAR_TEAM_NAME env var) */
  teamName?: string
  /** Project name resolved from the issue (used for path scoping in monorepos) */
  projectName?: string
}

export interface AgentProcess {
  issueId: string
  identifier: string
  /** Worktree identifier includes work type suffix (e.g., "ABC-294-QA"). Undefined for non-code work types. */
  worktreeIdentifier?: string
  sessionId?: string
  /** Provider CLI session ID for resuming sessions with --resume */
  providerSessionId?: string
  /** Worktree path for code work types. Undefined for non-code work types (research, backlog-creation). */
  worktreePath?: string
  pid: number | undefined
  status: 'starting' | 'running' | 'completed' | 'failed' | 'stopped' | 'incomplete'
  startedAt: Date
  completedAt?: Date
  exitCode?: number
  error?: Error
  /** Type of work: 'development' or 'qa' */
  workType?: AgentWorkType
  /** GitHub PR URL if a pull request was created */
  pullRequestUrl?: string
  /** Full completion message from Claude (stored for comment posting) */
  resultMessage?: string
  /** Reason why work was marked incomplete (only set when status is 'incomplete') */
  incompleteReason?: 'no_pr_created' | 'uncommitted_changes' | 'unpushed_commits'
  /** Result of work for QA/acceptance agents (passed/failed/unknown) */
  workResult?: AgentWorkResult
  /** Reason why agent was stopped (only set when status is 'stopped') */
  stopReason?: 'user_request' | 'timeout'
  /** Last activity timestamp for inactivity timeout tracking */
  lastActivityAt: Date
  /** Provider name used to spawn this agent */
  providerName?: AgentProviderName
  /** Total cost in USD (accumulated from provider result events) */
  totalCostUsd?: number
  /** Total input tokens used */
  inputTokens?: number
  /** Total output tokens used */
  outputTokens?: number
  /**
   * True when the orchestrator's post-acceptance auto-enqueue successfully
   * handed the PR to the local merge queue. Feeds the acceptance completion
   * contract's `pr_merged_or_enqueued` check so a "passed" acceptance with
   * an unmerged, unqueued PR is treated as incomplete (regression).
   */
  prEnqueuedForMerge?: boolean
}

export interface OrchestratorEvents {
  onAgentStart?: (agent: AgentProcess) => void
  onAgentComplete?: (agent: AgentProcess) => void
  onAgentError?: (agent: AgentProcess, error: Error) => void
  onAgentStopped?: (agent: AgentProcess) => void
  /** Called when agent work is incomplete (no PR, uncommitted changes, etc.) */
  onAgentIncomplete?: (agent: AgentProcess) => void
  onIssueSelected?: (issue: OrchestratorIssue) => void
  /** Called when provider session ID is captured from init event */
  onProviderSessionId?: (sessionId: string, providerSessionId: string) => void | Promise<void>
  /** Called when an activity is emitted for an agent (used for timeout tracking) */
  onActivityEmitted?: (agent: AgentProcess, activityType: string) => void
}

export interface SpawnAgentOptions {
  issueId: string
  identifier: string
  /** Worktree identifier with work type suffix (e.g., "ABC-294-QA"). Undefined for non-code work types. */
  worktreeIdentifier?: string
  sessionId?: string
  /** Worktree path. Undefined for non-code work types (research, backlog-creation). */
  worktreePath?: string
  /** Enable streaming activities to Linear (default: true when sessionId is provided) */
  streamActivities?: boolean
  /** Type of work: determines prompt and agent routing (defaults to 'development') */
  workType?: AgentWorkType
  /** Custom prompt override. If not provided, generates prompt based on workType */
  prompt?: string
  /** Team key to set as LINEAR_TEAM_NAME env var for agents */
  teamName?: string
  /** Project name for path scoping in monorepos */
  projectName?: string
  /** Issue labels (used for provider resolution via "provider:<name>" labels and model resolution via "model:<id>" labels) */
  labels?: string[]
  /** Mention/prompt context text (used for provider resolution via "use <provider>" patterns) */
  mentionContext?: string
  /** Model override from platform dispatch (QueuedWork.model). Highest priority in model resolution cascade. */
  dispatchModel?: string
  /** Sub-agent model override from platform dispatch (QueuedWork.subAgentModel) */
  dispatchSubAgentModel?: string
  /**
   * Pre-built architectural context section.
   * Built by callers (spawnAgentForIssue, spawnAgentWithResume) via buildArchitecturalContext()
   * before calling spawnAgent, so the synchronous spawnAgent() can use it without awaiting.
   */
  architecturalContext?: string
}

export interface OrchestratorStreamConfig {
  /** Minimum interval between activities in ms (default: 500ms) */
  minInterval?: number
  /** Maximum length for tool outputs before truncation (default: 2000) */
  maxOutputLength?: number
  /** Whether to include timestamps in activities (default: false) */
  includeTimestamps?: boolean
}

export interface OrchestratorResult {
  success: boolean
  agents: AgentProcess[]
  errors: Array<{ issueId: string; error: Error }>
}

export interface StopAgentResult {
  stopped: boolean
  reason?: 'not_found' | 'already_stopped' | 'signal_failed'
  agent?: AgentProcess
}

export interface ForwardPromptResult {
  forwarded: boolean
  resumed: boolean
  /** True if message was injected into running session (no restart needed) */
  injected?: boolean
  reason?: 'not_found' | 'spawn_failed' | 'no_worktree' | 'terminal_status'
  agent?: AgentProcess
  error?: Error
}

export interface InjectMessageResult {
  /** True if message was successfully injected into running session */
  injected: boolean
  reason?: 'not_running' | 'no_query' | 'injection_failed'
  error?: Error
}

export interface SpawnAgentWithResumeOptions {
  issueId: string
  identifier: string
  /** Worktree identifier with work type suffix (e.g., "ABC-294-QA"). Undefined for non-code work types. */
  worktreeIdentifier?: string
  sessionId: string
  /** Worktree path. Undefined for non-code work types (research, backlog-creation). */
  worktreePath?: string
  prompt: string
  providerSessionId?: string
  /** Type of work: determines transitions and agent behavior (defaults to 'development') */
  workType?: AgentWorkType
  /** Team key to set as LINEAR_TEAM_NAME env var for agents */
  teamName?: string
  /** Project name for path scoping in monorepos */
  projectName?: string
  /** Issue labels (used for provider resolution via "provider:<name>" labels and model resolution via "model:<id>" labels) */
  labels?: string[]
  /** Mention/prompt context text (used for provider resolution via "use <provider>" patterns) */
  mentionContext?: string
  /** Model override from platform dispatch (QueuedWork.model). Highest priority in model resolution cascade. */
  dispatchModel?: string
  /** Sub-agent model override from platform dispatch (QueuedWork.subAgentModel) */
  dispatchSubAgentModel?: string
}
