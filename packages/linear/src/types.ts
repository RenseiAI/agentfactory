import type { LinearAgentClient } from './agent-client.js'
import type { ToolCategory } from '@donmai/core'

/**
 * AgentSession states as defined by Linear Agent SDK
 */
export type AgentSessionState =
  | 'pending'
  | 'active'
  | 'error'
  | 'awaitingInput'
  | 'complete'

/**
 * AgentActivity types as defined by Linear Agent API
 */
export type AgentActivityType =
  | 'thought'
  | 'action'
  | 'response'
  | 'elicitation'
  | 'error'
  | 'prompt'

/**
 * AgentActivity signals - modifiers that provide additional instructions
 * on how the activity should be interpreted
 */
export type AgentActivitySignal = 'auth' | 'continue' | 'select' | 'stop'

/**
 * Content for a thought activity - reasoning steps
 */
export interface ThoughtActivityContent {
  type: 'thought'
  body: string
}

/**
 * Content for an action activity - tool calls
 */
export interface ActionActivityContent {
  type: 'action'
  action: string
  parameter: string
  result?: string
  toolCategory?: ToolCategory
}

/**
 * Content for a response activity - final responses
 */
export interface ResponseActivityContent {
  type: 'response'
  body: string
}

/**
 * Content for an elicitation activity - asking for clarification
 */
export interface ElicitationActivityContent {
  type: 'elicitation'
  body: string
}

/**
 * Content for an error activity - error reporting
 */
export interface ErrorActivityContent {
  type: 'error'
  body: string
}

/**
 * Content for a prompt activity - prompts/instructions
 */
export interface PromptActivityContent {
  type: 'prompt'
  body: string
}

/**
 * Union type for all activity content types
 */
export type AgentActivityContentPayload =
  | ThoughtActivityContent
  | ActionActivityContent
  | ResponseActivityContent
  | ElicitationActivityContent
  | ErrorActivityContent
  | PromptActivityContent

/**
 * Input for creating an agent activity via the native Linear API
 */
export interface AgentActivityCreateInput {
  agentSessionId: string
  content: AgentActivityContentPayload
  ephemeral?: boolean
  id?: string
  signal?: AgentActivitySignal
}

/**
 * Result of creating an agent activity
 */
export interface AgentActivityResult {
  success: boolean
  activityId?: string
}

/**
 * Legacy activity content for backward compatibility
 * @deprecated Use AgentActivityContentPayload instead
 */
export interface AgentActivityContent {
  text: string
  metadata?: Record<string, unknown>
}

/**
 * Configuration for creating an agent activity (internal use)
 */
export interface CreateActivityOptions {
  type: AgentActivityType
  content: AgentActivityContent
  ephemeral?: boolean
  signals?: AgentSignals
}

/**
 * AgentPlan item states
 */
export type AgentPlanItemState =
  | 'pending'
  | 'inProgress'
  | 'completed'
  | 'canceled'

/**
 * Linear's native plan item status values
 * @see https://linear.app/developers/agents
 */
export type LinearPlanStatus = 'pending' | 'inProgress' | 'completed' | 'canceled'

/**
 * Linear's native plan item structure for agentSessionUpdate mutation
 * @see https://linear.app/developers/agents
 */
export interface LinearPlanItem {
  /** The task description */
  content: string
  /** Current status of the task */
  status: LinearPlanStatus
}

/**
 * A single item in the agent's plan (internal representation)
 * Supports nested children for more detailed task tracking
 */
export interface AgentPlanItem {
  id: string
  title: string
  state: AgentPlanItemState
  details?: string
  children?: AgentPlanItem[]
}

/**
 * Full agent plan structure (internal representation)
 */
export interface AgentPlan {
  items: AgentPlanItem[]
}

/**
 * Optional metadata for activity interpretation
 */
export interface AgentSignals {
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: unknown
  toolCategory?: ToolCategory
  error?: {
    message: string
    code?: string
    stack?: string
  }
  progress?: number
  [key: string]: unknown
}

// ============================================================================
// RATE LIMITER & CIRCUIT BREAKER STRATEGY INTERFACES
// ============================================================================

/**
 * Pluggable rate limiter strategy.
 *
 * The default in-memory TokenBucket implements this. Consumers can provide
 * a Redis-backed implementation for shared rate limiting across processes.
 */
export interface RateLimiterStrategy {
  acquire(): Promise<void>
  penalize(seconds: number): void | Promise<void>
}

/**
 * Pluggable circuit breaker strategy.
 *
 * The default in-memory CircuitBreaker implements this. Consumers can provide
 * a Redis-backed implementation for shared circuit state across processes.
 */
export interface CircuitBreakerStrategy {
  canProceed(): boolean | Promise<boolean>
  recordSuccess(): void | Promise<void>
  recordAuthFailure(statusCode?: number): void | Promise<void>
  isAuthError(error: unknown): boolean
  reset(): void | Promise<void>
}

/**
 * Configuration for the circuit breaker
 */
export interface CircuitBreakerConfig {
  /** Consecutive auth failures before opening (default: 2) */
  failureThreshold: number
  /** Milliseconds before half-open probe (default: 60_000) */
  resetTimeoutMs: number
  /** Maximum reset timeout after exponential backoff (default: 300_000) */
  maxResetTimeoutMs: number
  /** Backoff multiplier for reset timeout after probe failure (default: 2) */
  backoffMultiplier: number
  /** HTTP status codes that count as auth failures (default: [400, 401, 403]) */
  authErrorCodes: number[]
}

/**
 * Configuration for the Linear Agent Client
 */
/**
 * Quota information extracted from Linear API response headers.
 */
export interface LinearApiQuota {
  /** Remaining requests in the current window */
  requestsRemaining?: number
  /** Total request limit for the current window */
  requestsLimit?: number
  /** Remaining complexity points in the current window */
  complexityRemaining?: number
  /** Total complexity limit for the current window */
  complexityLimit?: number
  /** Seconds until the rate limit window resets */
  resetSeconds?: number
}

export interface LinearAgentClientConfig {
  apiKey: string
  baseUrl?: string
  retry?: RetryConfig
  /** Token bucket rate limiter configuration. Applied to all API calls. */
  rateLimit?: Partial<import('./rate-limiter.js').TokenBucketConfig>
  /** Circuit breaker configuration. */
  circuitBreaker?: Partial<CircuitBreakerConfig>
  /**
   * Injectable rate limiter strategy (e.g., Redis-backed).
   * When provided, replaces the default in-memory TokenBucket.
   */
  rateLimiterStrategy?: RateLimiterStrategy
  /**
   * Injectable circuit breaker strategy (e.g., Redis-backed).
   * When provided, replaces the default in-memory CircuitBreaker.
   */
  circuitBreakerStrategy?: CircuitBreakerStrategy
  /**
   * Optional callback invoked after each successful API response.
   * Receives quota information extracted from response headers.
   * Use this to track API consumption across scans.
   */
  onApiResponse?: (quota: LinearApiQuota) => void
}

/**
 * Retry configuration with exponential backoff
 */
export interface RetryConfig {
  maxRetries?: number
  initialDelayMs?: number
  backoffMultiplier?: number
  maxDelayMs?: number
  retryableStatusCodes?: number[]
}

/**
 * Standard Linear workflow states
 */
export type LinearWorkflowStatus =
  | 'Backlog'
  | 'Started'
  | 'Finished'
  | 'Delivered'
  | 'Accepted'
  | 'Rejected'
  | 'Canceled'

/**
 * Type of agent work being performed based on issue status
 *
 * | Issue Status | Work Type              | Agent Role                                    |
 * |--------------|------------------------|-----------------------------------------------|
 * | Icebox       | research               | Research/story-writer                         |
 * | Icebox       | backlog-creation       | Create backlog issues from research           |
 * | Backlog      | development            | Developer agents (spawns sub-agents when parent issue) |
 * | Started      | inflight               | Developer (resume/continue; spawns sub-agents when parent issue) |
 * | Finished     | qa                     | QA agents (spawns sub-agents when parent issue) |
 * | Delivered    | acceptance             | Acceptance testing (spawns sub-agents when parent issue) |
 * | Rejected     | refinement             | Refine and return to Backlog                  |
 * | Rejected     | refinement-coordination| Coordinate refinement across sub-issues       |
 *
 * Note: coordinator behavior (spawning sub-agents) is now a runtime concern
 * decided by the agent based on whether sub-issues exist, not a separate work type.
 */
export type AgentWorkType =
  | 'research'                    // Icebox: Flesh out story details, research
  | 'backlog-creation'            // Icebox: Create backlog issues from researched story
  | 'backlog-groomer'             // Icebox: PM agent — scan icebox, decide discard/refine/escalate-human (cron-triggered)
  | 'development'                 // Backlog: Implement the feature/fix (also coordinates sub-agents for parent issues)
  | 'inflight'                    // Started: Continue in-progress work (also resumes sub-agent coordination for parent issues)
  | 'qa'                          // Finished: Validate implementation (also coordinates QA sub-agents for parent issues)
  | 'acceptance'                  // Delivered: Final acceptance testing (also coordinates acceptance for parent issues)
  | 'refinement'                  // Rejected: Address feedback, prep for retry
  | 'refinement-coordination'     // Rejected: Coordinate refinement across sub-issues for parent issues
  | 'merge'                       // Merge queue: handle PR merge operations
  | 'security'                    // Security scanning: SAST, dependency audit
  | 'improvement-loop'            // PM Agent: identify systemic patterns, author meta-issues
  | 'outcome-auditor'             // PM agent: audit accepted issues for delivery gaps, author follow-up issues
  | 'ga-readiness'                // PM agent: assess feature GA readiness before production promotion
  | 'documentation-steward'       // PM agent: flag stale docs, identify undocumented surfaces, author refinement issues
  | 'operational-scanner-vercel'  // PM agent: scan Vercel for deploy failures, timeouts, cold-start regressions
  | 'operational-scanner-audit'   // PM agent: scan audit chains for anomalies per 006 Seam 6
  | 'operational-scanner-ci'      // PM agent: scan CI runs for flaky tests, slow steps, optimization opportunities

/**
 * Mapping from Linear issue status to agent work type
 */
export const STATUS_WORK_TYPE_MAP: Record<string, AgentWorkType> = {
  'Icebox': 'research',
  'Backlog': 'development',
  'Started': 'inflight',
  'Finished': 'qa',
  'Delivered': 'acceptance',
  'Rejected': 'refinement',
}

/**
 * Terminal statuses where no agent work is needed
 * Issues in these states are considered complete and should not be processed
 */
export const TERMINAL_STATUSES = ['Accepted', 'Canceled', 'Duplicate'] as const
export type TerminalStatus = typeof TERMINAL_STATUSES[number]

/**
 * Status to transition to when agent session STARTS
 * null means no transition on start
 */
export const WORK_TYPE_START_STATUS: Record<AgentWorkType, LinearWorkflowStatus | null> = {
  'research': null,          // No transition from Icebox on start
  'backlog-creation': null,  // No transition from Icebox on start
  'backlog-groomer': null,   // Cron-triggered; no status transition on start
  'development': 'Started',  // Backlog -> Started when agent begins
  'inflight': null,          // Already Started, no change
  'qa': null,                // Already Finished
  'acceptance': null,        // Already Delivered
  'refinement': null,        // Already Rejected
  'refinement-coordination': null, // Already Rejected
  'merge': null,            // Merge is triggered programmatically, no status transition
  'security': null,         // Security scanning: no status transition on start
  'improvement-loop': null,              // PM Agent: cron-triggered, no status transition on start
  'outcome-auditor': null,              // Outcome Auditor: cron/workflow-triggered, no status transition on start
  'ga-readiness': null,                 // GA-Readiness Assessor: manually/workflow-triggered, no status transition on start
  'documentation-steward': null,        // Documentation Steward: cron/workflow-triggered, no status transition on start
  'operational-scanner-vercel': null,   // Vercel scanner: cron/workflow-triggered, no status transition on start
  'operational-scanner-audit': null,    // Audit scanner: cron/workflow-triggered, no status transition on start
  'operational-scanner-ci': null,       // CI scanner: cron/workflow-triggered, no status transition on start
}

/**
 * Status to transition to when agent session COMPLETES successfully
 * null means no auto-transition on completion
 */
export const WORK_TYPE_COMPLETE_STATUS: Record<AgentWorkType, LinearWorkflowStatus | null> = {
  'research': null,          // No auto-transition, user moves to Backlog
  'backlog-creation': null,  // Issues created in Backlog, source stays in Icebox
  'backlog-groomer': null,   // Groomer labels the issue; scheduler drives next pass
  'development': 'Finished', // Started -> Finished when work done
  'inflight': 'Finished',    // Started -> Finished when work done
  'qa': 'Delivered',         // Finished -> Delivered on QA pass
  'acceptance': 'Accepted',  // Delivered -> Accepted on acceptance pass
  'refinement': 'Backlog',   // Rejected -> Backlog after refinement
  'refinement-coordination': 'Backlog', // Rejected -> Backlog after coordinated refinement (triggers development which re-runs failing sub-issues)
  'merge': null,            // Merge completion is handled by the merge queue adapter
  'security': 'Finished',   // Security scan complete
  'improvement-loop': null,              // PM Agent: no auto-transition; cron-triggered, stateless
  'outcome-auditor': null,              // Outcome Auditor: no auto-transition; tags issues with audit:clean/has-followups
  'ga-readiness': null,                 // GA-Readiness Assessor: no auto-transition; posts report comment, authors blockers
  'documentation-steward': null,        // Documentation Steward: no auto-transition; posts scan summary comment
  'operational-scanner-vercel': null,   // Vercel scanner: no auto-transition; authors bug-report issues
  'operational-scanner-audit': null,    // Audit scanner: no auto-transition; authors anomaly issues
  'operational-scanner-ci': null,       // CI scanner: no auto-transition; authors flaky/slow-test issues
}

/**
 * Status to transition to when agent work FAILS (e.g., QA rejected)
 * null means no auto-transition on failure (stays in current status)
 */
export const WORK_TYPE_FAIL_STATUS: Record<AgentWorkType, LinearWorkflowStatus | null> = {
  'research': null,
  'backlog-creation': null,
  'backlog-groomer': null,   // Groomer failure: no status transition; operator reviews log
  'development': null,
  'inflight': null,
  'qa': 'Rejected',             // QA failure -> Rejected (refinement handler analyzes failure context and dispatches targeted fixes)
  'acceptance': 'Rejected',    // Acceptance failure -> Rejected (rejection handler diagnoses next steps)
  'refinement': null,
  'refinement-coordination': null,
  'merge': null,            // Merge failure is handled by the merge queue adapter
  'security': null,         // Security scan failure: no status transition
  'improvement-loop': null,              // PM Agent: no status transition on failure
  'outcome-auditor': null,              // Outcome Auditor failure: no status transition
  'ga-readiness': null,                 // GA-Readiness Assessor failure: no status transition
  'documentation-steward': null,        // Documentation Steward failure: no status transition
  'operational-scanner-vercel': null,   // Vercel scanner failure: no status transition
  'operational-scanner-audit': null,    // Audit scanner failure: no status transition
  'operational-scanner-ci': null,       // CI scanner failure: no status transition
}

/**
 * Work types that require an isolated git worktree.
 * ALL work types now get worktrees to prevent agents from mutating the main
 * checkout (e.g., running `git checkout` in the IDE's working tree).
 */
export const WORK_TYPES_REQUIRING_WORKTREE: ReadonlySet<AgentWorkType> = new Set([
  'development',
  'inflight',
  'qa',
  'acceptance',
  'research',
  'backlog-creation',
  'backlog-groomer',
  'refinement',
  'refinement-coordination',
  'merge',
  'security',
  'outcome-auditor',
  'ga-readiness',
  'documentation-steward',
  'operational-scanner-vercel',
  'operational-scanner-audit',
  'operational-scanner-ci',
])

/**
 * Allowed statuses for each work type
 * Used to validate that an agent isn't assigned to an issue in the wrong status
 */
export const WORK_TYPE_ALLOWED_STATUSES: Record<AgentWorkType, string[]> = {
  'research': ['Icebox'],
  'backlog-creation': ['Icebox'],
  'backlog-groomer': ['Icebox'],  // Processes icebox issues on cron; triggered externally
  'development': ['Backlog'],
  'inflight': ['Started'],
  'qa': ['Finished'],
  'acceptance': ['Delivered'],
  'refinement': ['Rejected'],
  'refinement-coordination': ['Rejected'],
  'improvement-loop': [],              // PM Agent: cron-triggered, not status-gated
  'merge': ['Started', 'Finished'],    // Merge can be triggered on in-progress or completed PRs
  'security': ['Started', 'Finished'], // Security scan can be triggered on in-progress or completed work
  'outcome-auditor': ['Accepted'],     // Outcome Auditor runs on recently accepted issues
  'ga-readiness': [],                  // GA-Readiness Assessor: manually/workflow-triggered, not status-gated
  'documentation-steward': [],         // Documentation Steward: cron/workflow-triggered, not status-gated
  'operational-scanner-vercel': [],    // Vercel scanner: cron/workflow-triggered, not status-gated
  'operational-scanner-audit': [],     // Audit scanner: cron/workflow-triggered, not status-gated
  'operational-scanner-ci': [],        // CI scanner: cron/workflow-triggered, not status-gated
}

/**
 * Valid work types for each status (reverse of WORK_TYPE_ALLOWED_STATUSES)
 * Used to constrain keyword detection to only valid options for the current status
 *
 * For example:
 * - Icebox issues can use keywords to choose between 'research' and 'backlog-creation'
 * - Backlog issues only have 'development' as valid, so keywords won't change work type
 *   but could still provide agent specialization hints
 */
export const STATUS_VALID_WORK_TYPES: Record<string, AgentWorkType[]> = {
  'Icebox': ['research', 'backlog-creation', 'backlog-groomer'],
  'Backlog': ['development'],
  'Started': ['inflight', 'merge'],
  'Finished': ['qa'],
  'Delivered': ['acceptance'],
  'Rejected': ['refinement', 'refinement-coordination'],
}

/**
 * Get valid work types for a given status
 * Returns empty array if status is unknown
 */
export function getValidWorkTypesForStatus(status: string): AgentWorkType[] {
  return STATUS_VALID_WORK_TYPES[status] ?? []
}

/**
 * Result of work type validation
 */
export interface WorkTypeValidationResult {
  valid: boolean
  error?: string
}

/**
 * Validate that a work type is appropriate for an issue's current status
 *
 * @param workType - The work type being assigned
 * @param issueStatus - The current status of the issue
 * @returns Validation result with error message if invalid
 */
export function validateWorkTypeForStatus(
  workType: AgentWorkType,
  issueStatus: string
): WorkTypeValidationResult {
  const allowedStatuses = WORK_TYPE_ALLOWED_STATUSES[workType]

  if (!allowedStatuses.includes(issueStatus)) {
    return {
      valid: false,
      error: `Cannot assign ${workType} work to issue in ${issueStatus} status. Expected: ${allowedStatuses.join(', ')}`,
    }
  }

  return { valid: true }
}

/**
 * Mapping of status names to their Linear state IDs
 */
export interface StatusMapping {
  [statusName: string]: string
}

/**
 * Configuration for creating/managing an agent session
 */
export interface AgentSessionConfig {
  /**
   * The high-level LinearAgentClient wrapper — NOT the raw @linear/sdk
   * LinearClient. AgentSession relies on wrapper-only methods such as
   * getIssue(), updateIssueStatus(), createComment(), createAgentActivity()
   * and createAgentSessionOnIssue(), none of which exist on the raw SDK
   * client. Pass the wrapper (e.g. `createLinearAgentClient(...)`), not its
   * `.linearClient` getter.
   */
  client: LinearAgentClient
  issueId: string
  sessionId?: string
  autoTransition?: boolean
  /**
   * Type of work being performed.
   * - 'development': Normal development work (transitions to Started on start)
   * - 'qa': QA validation work (stays at Finished until QA passes, then Delivered)
   * Defaults to 'development'.
   */
  workType?: AgentWorkType
}

/**
 * Result of session operations
 */
export interface SessionOperationResult {
  success: boolean
  sessionId?: string
  error?: Error
}

/**
 * External URL associated with an agent session
 */
export interface AgentSessionExternalUrl {
  /** Label for the URL (e.g., "Dashboard", "Logs") */
  label: string
  /** The URL of the external resource */
  url: string
}

/**
 * Input for updating an agent session via the Linear API
 */
export interface AgentSessionUpdateInput {
  /** The agent session ID to update */
  sessionId: string
  /** External URLs linking to agent dashboard/logs */
  externalUrls?: AgentSessionExternalUrl[]
  /** External link URL (single, for backward compatibility) */
  externalLink?: string
  /** Plan array showing agent execution strategy (Linear's native format) */
  plan?: LinearPlanItem[]
}

/**
 * Result of updating an agent session
 */
export interface AgentSessionUpdateResult {
  success: boolean
  sessionId?: string
}

/**
 * Input for creating an agent session on an issue via the Linear API
 * @see https://linear.app/developers/agents
 */
export interface AgentSessionCreateOnIssueInput {
  /** The issue ID (UUID) or identifier (e.g., 'ABC-123') to create the session on */
  issueId: string
  /** External URLs linking to agent dashboard/logs */
  externalUrls?: AgentSessionExternalUrl[]
  /** External link URL (single, for backward compatibility) */
  externalLink?: string
}

/**
 * Result of creating an agent session on an issue
 */
export interface AgentSessionCreateResult {
  success: boolean
  /** The ID of the created agent session */
  sessionId?: string
}

/**
 * Linear issue relationship types
 * @see https://linear.app/developers/sdk
 */
export type IssueRelationType = 'related' | 'blocks' | 'duplicate'

/**
 * Input for creating an issue relation
 */
export interface IssueRelationCreateInput {
  issueId: string
  relatedIssueId: string
  type: IssueRelationType
}

/**
 * Result of creating/deleting an issue relation
 */
export interface IssueRelationResult {
  success: boolean
  relationId?: string
}

/**
 * Batch result for creating multiple relations
 */
export interface IssueRelationBatchResult {
  success: boolean
  relationIds: string[]
  errors: Array<{ targetIssueId: string; error: string }>
}

/**
 * Sub-issue with its blocking relations for dependency graph building
 */
export interface SubIssueGraphNode {
  issue: {
    id: string
    identifier: string
    title: string
    description?: string
    status?: string
    priority: number
    labels: string[]
    url: string
  }
  /** Identifiers of issues that block this sub-issue */
  blockedBy: string[]
  /** Identifiers of issues that this sub-issue blocks */
  blocks: string[]
}

/**
 * Result of getSubIssueGraph - the complete dependency graph for a parent issue
 */
export interface SubIssueGraph {
  parentId: string
  parentIdentifier: string
  subIssues: SubIssueGraphNode[]
}

/**
 * Lightweight sub-issue status info (no blocking relations)
 * Used by QA and acceptance agents to validate sub-issue completion
 */
export interface SubIssueStatus {
  identifier: string
  title: string
  status: string
}

/**
 * Representation of an issue relation
 */
export interface IssueRelationInfo {
  id: string
  type: string
  issueId: string
  issueIdentifier?: string
  relatedIssueId: string
  relatedIssueIdentifier?: string
  createdAt: Date
}

/**
 * Result of querying issue relations
 */
export interface IssueRelationsResult {
  relations: IssueRelationInfo[]
  inverseRelations: IssueRelationInfo[]
}
