import {
  LinearClient,
  AgentActivitySignal as LinearAgentActivitySignal,
  IssueRelationType as LinearIssueRelationType,
} from '@linear/sdk'
import type { Issue, Comment } from '@linear/sdk'
import type {
  LinearAgentClientConfig,
  LinearApiQuota,
  LinearWorkflowStatus,
  StatusMapping,
  RetryConfig,
  AgentActivityCreateInput,
  AgentActivityResult,
  AgentSessionUpdateInput,
  AgentSessionUpdateResult,
  AgentSessionCreateOnIssueInput,
  AgentSessionCreateResult,
  IssueRelationCreateInput,
  IssueRelationResult,
  IssueRelationBatchResult,
  IssueRelationInfo,
  IssueRelationsResult,
  IssueRelationType,
  SubIssueGraphNode,
  SubIssueGraph,
  SubIssueStatus,
  RateLimiterStrategy,
  CircuitBreakerStrategy,
} from './types.js'
import { LinearApiError, LinearStatusTransitionError } from './errors.js'
import { withRetry, DEFAULT_RETRY_CONFIG } from './retry.js'
import { TokenBucket, extractRetryAfterMs } from './rate-limiter.js'
import { CircuitBreaker } from './circuit-breaker.js'
import { resolveGraphQLLabelNames } from './utils.js'

/**
 * Core Linear Agent Client
 * Wraps @linear/sdk with retry logic and helper methods
 */
export class LinearAgentClient {
  private readonly client: LinearClient
  private readonly retryConfig: Required<RetryConfig>
  private readonly rateLimiter: RateLimiterStrategy
  private readonly circuitBreaker: CircuitBreakerStrategy
  private readonly onApiResponse?: (quota: LinearApiQuota) => void
  private statusCache: Map<string, StatusMapping> = new Map()
  private _apiCallCount = 0

  constructor(config: LinearAgentClientConfig) {
    this.client = new LinearClient({
      apiKey: config.apiKey,
      ...(config.baseUrl && { apiUrl: config.baseUrl }),
    })
    this.retryConfig = {
      ...DEFAULT_RETRY_CONFIG,
      ...config.retry,
    }
    this.rateLimiter = config.rateLimiterStrategy ?? new TokenBucket(config.rateLimit)
    this.circuitBreaker = config.circuitBreakerStrategy ?? new CircuitBreaker(config.circuitBreaker)
    this.onApiResponse = config.onApiResponse
  }

  /** Number of successful API calls since last reset */
  get apiCallCount(): number {
    return this._apiCallCount
  }

  /** Reset the API call counter (typically called at the start of each scan) */
  resetApiCallCount(): void {
    this._apiCallCount = 0
  }

  /**
   * Get the underlying LinearClient instance
   */
  get linearClient(): LinearClient {
    return this.client
  }

  /**
   * Execute an operation with circuit breaker, rate limiting, and retry logic.
   *
   * Order of operations:
   * 1. Check circuit breaker — if open, throw CircuitOpenError (zero quota consumed)
   * 2. Acquire rate limit token
   * 3. Execute the operation
   * 4. On success: record success on circuit breaker
   * 5. On auth error: record failure on circuit breaker (may trip it)
   * 6. On retryable error: retry with exponential backoff
   */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(
      async () => {
        // Check circuit breaker BEFORE acquiring a rate limit token
        const canProceed = await this.circuitBreaker.canProceed()
        if (!canProceed) {
          // Create a descriptive error; if the breaker is a CircuitBreaker instance, use its helper
          const breaker = this.circuitBreaker as CircuitBreaker & { createOpenError?: () => Error }
          if (typeof breaker.createOpenError === 'function') {
            throw breaker.createOpenError()
          }
          throw new LinearApiError('Circuit breaker is open — API calls blocked', 503)
        }

        await this.rateLimiter.acquire()

        try {
          const result = await fn()
          // Record success to close/reset the circuit
          await this.circuitBreaker.recordSuccess()
          this._apiCallCount++
          return result
        } catch (error) {
          // Check if this is an auth error that should trip the circuit
          if (this.circuitBreaker.isAuthError(error)) {
            const statusCode = extractAuthStatusCode(error)
            await this.circuitBreaker.recordAuthFailure(statusCode)
            const msg = error instanceof Error ? error.message : String(error)
            console.warn(
              `[LinearAgentClient] Auth error detected (status ${statusCode}), circuit breaker notified: ${msg}`
            )
          }
          throw error
        }
      },
      {
        config: this.retryConfig,
        getRetryAfterMs: extractRetryAfterMs,
        onRateLimited: (retryAfterMs) => {
          const seconds = retryAfterMs / 1000
          console.warn(
            `[LinearAgentClient] Rate limited by Linear API, backing off ${seconds}s`
          )
          this.rateLimiter.penalize(seconds)
        },
        onRetry: ({ attempt, delay }) => {
          console.log(
            `[LinearAgentClient] Retry attempt ${attempt + 1}/${this.retryConfig.maxRetries}, ` +
              `waiting ${delay}ms`
          )
        },
      }
    )
  }

  /**
   * Fetch an issue by ID or identifier (e.g., "ABC-50")
   */
  async getIssue(issueIdOrIdentifier: string): Promise<Issue> {
    return this.withRetry(async () => {
      const issue = await this.client.issue(issueIdOrIdentifier)
      if (!issue) {
        throw new LinearApiError(
          `Issue not found: ${issueIdOrIdentifier}`,
          404
        )
      }
      return issue
    })
  }

  /**
   * Update an issue's properties
   */
  async updateIssue(
    issueId: string,
    data: {
      title?: string
      description?: string
      stateId?: string
      assigneeId?: string | null
      priority?: number
      labelIds?: string[]
      parentId?: string | null
    }
  ): Promise<Issue> {
    return this.withRetry(async () => {
      const payload = await this.client.updateIssue(issueId, data)
      if (!payload.success) {
        throw new LinearApiError(`Failed to update issue: ${issueId}`, 400, payload)
      }
      return this.client.issue(issueId)
    })
  }

  /**
   * Remove the assignee from an issue (unassign)
   * Used when agent completes work to enable clean handoff visibility
   */
  async unassignIssue(issueId: string): Promise<Issue> {
    return this.withRetry(async () => {
      // Linear SDK expects null to clear assignee
      const payload = await this.client.updateIssue(issueId, {
        assigneeId: null,
      })
      if (!payload.success) {
        throw new LinearApiError(`Failed to unassign issue: ${issueId}`, 400, payload)
      }
      return this.client.issue(issueId)
    })
  }

  /**
   * Get workflow states for a team (cached)
   */
  async getTeamStatuses(teamId: string): Promise<StatusMapping> {
    if (this.statusCache.has(teamId)) {
      return this.statusCache.get(teamId)!
    }

    return this.withRetry(async () => {
      const team = await this.client.team(teamId)
      const states = await team.states()

      const mapping: StatusMapping = {}
      for (const state of states.nodes) {
        mapping[state.name] = state.id
      }

      this.statusCache.set(teamId, mapping)
      return mapping
    })
  }

  /**
   * Update issue status by name (e.g., "Started", "Finished")
   */
  async updateIssueStatus(
    issueId: string,
    statusName: LinearWorkflowStatus
  ): Promise<Issue> {
    return this.withRetry(async () => {
      const issue = await this.client.issue(issueId)
      const team = await issue.team

      if (!team) {
        throw new LinearApiError(`Cannot find team for issue: ${issueId}`, 400)
      }

      const statuses = await this.getTeamStatuses(team.id)
      const stateId = statuses[statusName]

      if (!stateId) {
        const currentState = await issue.state
        throw new LinearStatusTransitionError(
          `Status "${statusName}" not found in team "${team.name}"`,
          issueId,
          currentState?.name ?? 'unknown',
          statusName
        )
      }

      return this.updateIssue(issueId, { stateId })
    })
  }

  /**
   * Create a comment on an issue
   */
  async createComment(issueId: string, body: string): Promise<Comment> {
    return this.withRetry(async () => {
      const payload = await this.client.createComment({
        issueId,
        body,
      })

      if (!payload.success) {
        throw new LinearApiError(
          `Failed to create comment on issue: ${issueId}`,
          400,
          payload
        )
      }

      const comment = await payload.comment
      if (!comment) {
        throw new LinearApiError(
          `Comment created but not returned for issue: ${issueId}`,
          500
        )
      }

      return comment
    })
  }

  /**
   * Get comments for an issue
   */
  async getIssueComments(issueId: string): Promise<Comment[]> {
    return this.withRetry(async () => {
      const issue = await this.client.issue(issueId)
      const comments = await issue.comments()
      return comments.nodes
    })
  }

  /**
   * Create a new issue
   */
  async createIssue(input: {
    title: string
    description?: string
    teamId: string
    projectId?: string
    stateId?: string
    labelIds?: string[]
    parentId?: string
    priority?: number
  }): Promise<Issue> {
    return this.withRetry(async () => {
      const payload = await this.client.createIssue(input)

      if (!payload.success) {
        throw new LinearApiError(
          `Failed to create issue: ${input.title}`,
          400,
          payload
        )
      }

      const issue = await payload.issue
      if (!issue) {
        throw new LinearApiError(
          `Issue created but not returned: ${input.title}`,
          500
        )
      }

      return issue
    })
  }

  /**
   * Get the authenticated user (the agent)
   */
  async getViewer() {
    return this.withRetry(() => this.client.viewer)
  }

  /**
   * Get a team by ID, key, or display name
   */
  async getTeam(teamIdOrKeyOrName: string) {
    return this.withRetry(async () => {
      try {
        return await this.client.team(teamIdOrKeyOrName)
      } catch {
        // Fallback: search by display name
        const teams = await this.client.teams({
          filter: { name: { eqIgnoreCase: teamIdOrKeyOrName } },
        })
        if (teams.nodes.length === 0) {
          throw new Error(`Team not found: "${teamIdOrKeyOrName}"`)
        }
        return teams.nodes[0]
      }
    })
  }

  /**
   * Get all issue labels in the workspace.
   * Returns a flat array of { id, name } objects.
   */
  async issueLabels(): Promise<Array<{ id: string; name: string }>> {
    return this.withRetry(async () => {
      const result = await this.client.issueLabels({ first: 250 })
      return result.nodes.map((l) => ({ id: l.id, name: l.name }))
    })
  }

  /**
   * Get members of a team by team ID.
   * Returns a flat array of { id, name, email } objects.
   */
  async teamMembers(teamId: string): Promise<Array<{ id: string; name: string; email?: string }>> {
    return this.withRetry(async () => {
      const team = await this.client.team(teamId)
      const members = await team.members()
      return members.nodes.map((m) => ({ id: m.id, name: m.name, email: m.email }))
    })
  }

  /**
   * Create an agent activity using the native Linear Agent API
   *
   * @param input - The activity input containing session ID, content, and options
   * @returns Result indicating success and the created activity ID
   */
  async createAgentActivity(
    input: AgentActivityCreateInput
  ): Promise<AgentActivityResult> {
    return this.withRetry(async () => {
      const signalMap: Record<string, LinearAgentActivitySignal> = {
        auth: LinearAgentActivitySignal.Auth,
        continue: LinearAgentActivitySignal.Continue,
        select: LinearAgentActivitySignal.Select,
        stop: LinearAgentActivitySignal.Stop,
      }

      const payload = await this.client.createAgentActivity({
        agentSessionId: input.agentSessionId,
        content: input.content,
        ephemeral: input.ephemeral,
        id: input.id,
        signal: input.signal ? signalMap[input.signal] : undefined,
      })

      if (!payload.success) {
        throw new LinearApiError(
          `Failed to create agent activity for session: ${input.agentSessionId}`,
          400,
          payload
        )
      }

      const activity = await payload.agentActivity
      return {
        success: true,
        activityId: activity?.id,
      }
    })
  }

  /**
   * Update an agent session
   *
   * Use this to set the externalUrl (linking to agent dashboard/logs)
   * within 10 seconds of receiving a webhook to avoid appearing unresponsive.
   *
   * @param input - The session update input containing sessionId and updates
   * @returns Result indicating success and the session ID
   */
  async updateAgentSession(
    input: AgentSessionUpdateInput
  ): Promise<AgentSessionUpdateResult> {
    return this.withRetry(async () => {
      const payload = await this.client.updateAgentSession(input.sessionId, {
        externalUrls: input.externalUrls,
        externalLink: input.externalLink,
        plan: input.plan,
      })

      if (!payload.success) {
        throw new LinearApiError(
          `Failed to update agent session: ${input.sessionId}`,
          400,
          payload
        )
      }

      const session = await payload.agentSession
      return {
        success: true,
        sessionId: session?.id,
      }
    })
  }

  /**
   * Create an agent session on an issue
   *
   * Use this to programmatically create a Linear AgentSession when status transitions
   * occur without explicit agent mention/delegation (e.g., Icebox -> Backlog).
   *
   * This enables the Linear Agent Session UI to show real-time activities even when
   * the agent work is triggered by status changes rather than user mentions.
   *
   * @param input - The session creation input containing issueId and optional external URLs
   * @returns Result indicating success and the created session ID
   */
  async createAgentSessionOnIssue(
    input: AgentSessionCreateOnIssueInput
  ): Promise<AgentSessionCreateResult> {
    return this.withRetry(async () => {
      const payload = await this.client.agentSessionCreateOnIssue({
        issueId: input.issueId,
        externalUrls: input.externalUrls,
        externalLink: input.externalLink,
      })

      if (!payload.success) {
        throw new LinearApiError(
          `Failed to create agent session on issue: ${input.issueId}`,
          400,
          payload
        )
      }

      const session = await payload.agentSession
      return {
        success: true,
        sessionId: session?.id,
      }
    })
  }

  // ============================================================================
  // ISSUE RELATION METHODS
  // ============================================================================

  /**
   * Create a relation between two issues
   *
   * @param input - The relation input containing issue IDs and relation type
   * @returns Result indicating success and the created relation ID
   *
   * Relation types:
   * - 'related': General association between issues
   * - 'blocks': Source issue blocks the related issue from progressing
   * - 'duplicate': Source issue is a duplicate of the related issue
   */
  async createIssueRelation(
    input: IssueRelationCreateInput
  ): Promise<IssueRelationResult> {
    return this.withRetry(async () => {
      // Map our string type to the SDK's enum
      const typeMap: Record<IssueRelationType, LinearIssueRelationType> = {
        related: LinearIssueRelationType.Related,
        blocks: LinearIssueRelationType.Blocks,
        duplicate: LinearIssueRelationType.Duplicate,
      }

      const payload = await this.client.createIssueRelation({
        issueId: input.issueId,
        relatedIssueId: input.relatedIssueId,
        type: typeMap[input.type],
      })

      if (!payload.success) {
        throw new LinearApiError(
          `Failed to create issue relation: ${input.issueId} -> ${input.relatedIssueId}`,
          400,
          payload
        )
      }

      const relation = await payload.issueRelation
      return {
        success: true,
        relationId: relation?.id,
      }
    })
  }

  /**
   * Create multiple relations from a source issue to multiple target issues
   *
   * @param input - Batch input containing source issue, target issues, and relation type
   * @returns Batch result with successful relation IDs and any errors
   */
  async createIssueRelationsBatch(input: {
    sourceIssueId: string
    targetIssueIds: string[]
    type: IssueRelationType
  }): Promise<IssueRelationBatchResult> {
    const relationIds: string[] = []
    const errors: Array<{ targetIssueId: string; error: string }> = []

    for (const targetIssueId of input.targetIssueIds) {
      try {
        const result = await this.createIssueRelation({
          issueId: input.sourceIssueId,
          relatedIssueId: targetIssueId,
          type: input.type,
        })
        if (result.relationId) {
          relationIds.push(result.relationId)
        }
      } catch (error) {
        errors.push({
          targetIssueId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return {
      success: errors.length === 0,
      relationIds,
      errors,
    }
  }

  /**
   * Get all relations for an issue (both outgoing and incoming)
   *
   * Uses a single raw GraphQL query instead of N+1 lazy-loaded SDK calls.
   *
   * @param issueId - The issue ID or identifier (e.g., "ABC-123")
   * @returns Relations result with both directions of relationships
   */
  async getIssueRelations(issueId: string): Promise<IssueRelationsResult> {
    const canProceed = await this.circuitBreaker.canProceed()
    if (!canProceed) {
      const breaker = this.circuitBreaker as CircuitBreaker & { createOpenError?: () => Error }
      if (typeof breaker.createOpenError === 'function') {
        throw breaker.createOpenError()
      }
      throw new LinearApiError('Circuit breaker is open — API calls blocked', 503)
    }

    await this.rateLimiter.acquire()

    const query = `
      query IssueRelations($id: String!) {
        issue(id: $id) {
          id
          identifier
          relations(first: 50) {
            nodes {
              id
              type
              createdAt
              relatedIssue { id identifier }
            }
          }
          inverseRelations(first: 50) {
            nodes {
              id
              type
              createdAt
              issue { id identifier }
            }
          }
        }
      }
    `

    try {
      const result = await (this.client as unknown as { client: RawGraphQLClient }).client.rawRequest(query, { id: issueId })

      await this.circuitBreaker.recordSuccess()
      this._apiCallCount++

      const quota = extractQuotaFromHeaders(result.headers)
      if (quota) this.onApiResponse?.(quota)

      const data = result.data as {
        issue: {
          id: string
          identifier: string
          relations: {
            nodes: Array<{
              id: string
              type: string
              createdAt: string
              relatedIssue: { id: string; identifier: string } | null
            }>
          }
          inverseRelations: {
            nodes: Array<{
              id: string
              type: string
              createdAt: string
              issue: { id: string; identifier: string } | null
            }>
          }
        } | null
      }

      if (!data.issue) {
        throw new LinearApiError(`Issue not found: ${issueId}`, 404)
      }

      const relations: IssueRelationInfo[] = data.issue.relations.nodes.map((rel) => ({
        id: rel.id,
        type: rel.type,
        issueId: data.issue!.id,
        issueIdentifier: data.issue!.identifier,
        relatedIssueId: rel.relatedIssue?.id ?? '',
        relatedIssueIdentifier: rel.relatedIssue?.identifier,
        createdAt: new Date(rel.createdAt),
      }))

      const inverseRelations: IssueRelationInfo[] = data.issue.inverseRelations.nodes.map((rel) => ({
        id: rel.id,
        type: rel.type,
        issueId: rel.issue?.id ?? '',
        issueIdentifier: rel.issue?.identifier,
        relatedIssueId: data.issue!.id,
        relatedIssueIdentifier: data.issue!.identifier,
        createdAt: new Date(rel.createdAt),
      }))

      return { relations, inverseRelations }
    } catch (error) {
      if (this.circuitBreaker.isAuthError(error)) {
        const statusCode = extractAuthStatusCode(error)
        await this.circuitBreaker.recordAuthFailure(statusCode)
      }
      throw error
    }
  }

  /**
   * Delete an issue relation
   *
   * @param relationId - The relation ID to delete
   * @returns Result indicating success
   */
  async deleteIssueRelation(relationId: string): Promise<{ success: boolean }> {
    return this.withRetry(async () => {
      const payload = await this.client.deleteIssueRelation(relationId)

      if (!payload.success) {
        throw new LinearApiError(
          `Failed to delete issue relation: ${relationId}`,
          400,
          payload
        )
      }

      return { success: true }
    })
  }

  // ============================================================================
  // SUB-ISSUE METHODS (for coordination work type)
  // ============================================================================

  /**
   * Fetch all child issues (sub-issues) of a parent issue
   *
   * @param issueIdOrIdentifier - The parent issue ID or identifier (e.g., "ABC-100")
   * @returns Array of child issues
   */
  async getSubIssues(issueIdOrIdentifier: string): Promise<Issue[]> {
    return this.withRetry(async () => {
      const parentIssue = await this.client.issue(issueIdOrIdentifier)
      if (!parentIssue) {
        throw new LinearApiError(
          `Issue not found: ${issueIdOrIdentifier}`,
          404
        )
      }

      const children = await parentIssue.children()
      return children.nodes
    })
  }

  /**
   * Check if an issue has a parent (is a child/sub-issue)
   *
   * @param issueIdOrIdentifier - The issue ID or identifier
   * @returns True if the issue has a parent issue
   */
  async isChildIssue(issueIdOrIdentifier: string): Promise<boolean> {
    return this.withRetry(async () => {
      const issue = await this.client.issue(issueIdOrIdentifier)
      if (!issue) {
        throw new LinearApiError(
          `Issue not found: ${issueIdOrIdentifier}`,
          404
        )
      }

      const parent = await issue.parent
      return parent != null
    })
  }

  /**
   * Fetch all non-terminal issues in a project using a single GraphQL query.
   *
   * Replaces the N+1 pattern of fetching issues then lazy-loading state/labels/parent/project
   * for each one. Returns pre-resolved data suitable for GovernorIssue construction.
   *
   * @param project - Linear project name
   * @returns Array of issue data with childCount for parent detection
   */
  async listProjectIssues(project: string): Promise<
    Array<{
      id: string
      identifier: string
      title: string
      description?: string
      status: string
      labels: string[]
      createdAt: number
      parentId?: string
      project?: string
      childCount: number
    }>
  > {
    // Check circuit breaker before consuming rate limit token
    const canProceed = await this.circuitBreaker.canProceed()
    if (!canProceed) {
      const breaker = this.circuitBreaker as CircuitBreaker & { createOpenError?: () => Error }
      if (typeof breaker.createOpenError === 'function') {
        throw breaker.createOpenError()
      }
      throw new LinearApiError('Circuit breaker is open — API calls blocked', 503)
    }

    await this.rateLimiter.acquire()

    const query = `
      query ListProjectIssues($filter: IssueFilter!) {
        issues(filter: $filter, first: 250) {
          nodes {
            id
            identifier
            title
            description
            createdAt
            state { name }
            labels { nodes { name parent { name isGroup } } }
            parent { id }
            project { name }
            children { nodes { id } }
          }
        }
      }
    `

    const terminalStatuses = ['Accepted', 'Canceled', 'Duplicate']

    try {
      const result = await (this.client as unknown as { client: RawGraphQLClient }).client.rawRequest(query, {
        filter: {
          project: { name: { eq: project } },
          state: { name: { nin: terminalStatuses } },
        },
      })

      // Record success on circuit breaker
      await this.circuitBreaker.recordSuccess()
      this._apiCallCount++

      // Extract and report quota
      const quota = extractQuotaFromHeaders(result.headers)
      if (quota) this.onApiResponse?.(quota)

      const data = result.data as {
        issues: {
          nodes: Array<{
            id: string
            identifier: string
            title: string
            description?: string | null
            createdAt: string
            state: { name: string } | null
            labels: { nodes: Array<{ name: string; parent?: { name: string; isGroup: boolean } | null }> }
            parent: { id: string } | null
            project: { name: string } | null
            children: { nodes: Array<{ id: string }> }
          }>
        }
      }

      return data.issues.nodes.map((node) => ({
        id: node.id,
        identifier: node.identifier,
        title: node.title,
        description: node.description ?? undefined,
        status: node.state?.name ?? 'Backlog',
        labels: resolveGraphQLLabelNames(node.labels.nodes),
        createdAt: new Date(node.createdAt).getTime(),
        parentId: node.parent?.id ?? undefined,
        project: node.project?.name ?? undefined,
        childCount: node.children.nodes.length,
      }))
    } catch (error) {
      if (this.circuitBreaker.isAuthError(error)) {
        const statusCode = extractAuthStatusCode(error)
        await this.circuitBreaker.recordAuthFailure(statusCode)
      }
      throw error
    }
  }

  /**
   * Check if an issue has child issues (is a parent issue)
   *
   * @param issueIdOrIdentifier - The issue ID or identifier
   * @returns True if the issue has at least one child issue
   */
  async isParentIssue(issueIdOrIdentifier: string): Promise<boolean> {
    return this.withRetry(async () => {
      const issue = await this.client.issue(issueIdOrIdentifier)
      if (!issue) {
        throw new LinearApiError(
          `Issue not found: ${issueIdOrIdentifier}`,
          404
        )
      }

      const children = await issue.children()
      return children.nodes.length > 0
    })
  }

  /**
   * Check if any sub-issues have been worked on (moved beyond unworked states).
   *
   * Used to decide whether to use acceptance-coordination (for parent issues
   * whose sub-issues were actually worked) vs regular acceptance (for parent
   * issues with only unworked sub-issues).
   *
   * @param issueId - The parent issue ID or identifier
   * @returns True if at least one sub-issue has moved beyond Backlog/Icebox/Triage
   */
  async hasWorkedSubIssues(issueId: string): Promise<boolean> {
    const statuses = await this.getSubIssueStatuses(issueId)
    const unworkedStates = new Set(['Backlog', 'Icebox', 'Triage'])
    return statuses.some(s => !unworkedStates.has(s.status))
  }

  /**
   * Get lightweight sub-issue statuses (no blocking relations)
   *
   * Uses a single raw GraphQL query instead of N+1 lazy-loaded SDK calls.
   * Returns identifier, title, and status for each sub-issue.
   * Used by QA and acceptance agents to validate sub-issue completion
   * without the overhead of fetching the full dependency graph.
   *
   * @param issueIdOrIdentifier - The parent issue ID or identifier
   * @returns Array of sub-issue statuses
   */
  async getSubIssueStatuses(issueIdOrIdentifier: string): Promise<SubIssueStatus[]> {
    const canProceed = await this.circuitBreaker.canProceed()
    if (!canProceed) {
      const breaker = this.circuitBreaker as CircuitBreaker & { createOpenError?: () => Error }
      if (typeof breaker.createOpenError === 'function') {
        throw breaker.createOpenError()
      }
      throw new LinearApiError('Circuit breaker is open — API calls blocked', 503)
    }

    await this.rateLimiter.acquire()

    const query = `
      query SubIssueStatuses($id: String!) {
        issue(id: $id) {
          children(first: 50) {
            nodes {
              identifier
              title
              state { name }
            }
          }
        }
      }
    `

    try {
      const result = await (this.client as unknown as { client: RawGraphQLClient }).client.rawRequest(query, { id: issueIdOrIdentifier })

      await this.circuitBreaker.recordSuccess()
      this._apiCallCount++

      const quota = extractQuotaFromHeaders(result.headers)
      if (quota) this.onApiResponse?.(quota)

      const data = result.data as {
        issue: {
          children: {
            nodes: Array<{
              identifier: string
              title: string
              state: { name: string } | null
            }>
          }
        } | null
      }

      if (!data.issue) {
        throw new LinearApiError(
          `Issue not found: ${issueIdOrIdentifier}`,
          404
        )
      }

      return data.issue.children.nodes.map((child) => ({
        identifier: child.identifier,
        title: child.title,
        status: child.state?.name ?? 'Unknown',
      }))
    } catch (error) {
      if (this.circuitBreaker.isAuthError(error)) {
        const statusCode = extractAuthStatusCode(error)
        await this.circuitBreaker.recordAuthFailure(statusCode)
      }
      throw error
    }
  }

  /**
   * Get the repository URL associated with a project via its links or description
   *
   * Checks project links for a link with label matching 'Repository' or 'GitHub'
   * (case-insensitive). Falls back to parsing the project description for a
   * "Repository: <url>" pattern.
   *
   * @param projectId - The project ID
   * @returns The repository URL if found, null otherwise
   */
  async getProjectRepositoryUrl(projectId: string): Promise<string | null> {
    return this.withRetry(async () => {
      const project = await this.client.project(projectId)

      // Check project external links for a Repository/GitHub link
      const links = await project.externalLinks()
      for (const link of links.nodes) {
        if (link.label && /^(repository|github)$/i.test(link.label)) {
          return link.url
        }
      }

      // Fallback: check project description for Repository: pattern
      if (project.description) {
        const match = project.description.match(/Repository:\s*([\S]+)/i)
        if (match) {
          return match[1]
        }
      }

      return null
    })
  }

  /**
   * Get sub-issues with their blocking relations for dependency graph building
   *
   * Uses a single raw GraphQL query instead of N+1 lazy-loaded SDK calls.
   * Previous implementation made 2 + 4N + M API calls (where N = children,
   * M = total relations). This version makes exactly 1 API call.
   *
   * Builds a complete dependency graph of a parent issue's children, including
   * which sub-issues block which other sub-issues. This is used by the coordinator
   * agent to determine execution order.
   *
   * @param issueIdOrIdentifier - The parent issue ID or identifier
   * @returns The sub-issue dependency graph
   */
  async getSubIssueGraph(issueIdOrIdentifier: string): Promise<SubIssueGraph> {
    const canProceed = await this.circuitBreaker.canProceed()
    if (!canProceed) {
      const breaker = this.circuitBreaker as CircuitBreaker & { createOpenError?: () => Error }
      if (typeof breaker.createOpenError === 'function') {
        throw breaker.createOpenError()
      }
      throw new LinearApiError('Circuit breaker is open — API calls blocked', 503)
    }

    await this.rateLimiter.acquire()

    const query = `
      query SubIssueGraph($id: String!) {
        issue(id: $id) {
          id
          identifier
          children(first: 50) {
            nodes {
              id
              identifier
              title
              description
              priority
              url
              state { name }
              labels(first: 20) { nodes { name parent { name isGroup } } }
              relations(first: 50) {
                nodes {
                  type
                  relatedIssue { id identifier }
                }
              }
              inverseRelations(first: 50) {
                nodes {
                  type
                  issue { id identifier }
                }
              }
            }
          }
        }
      }
    `

    try {
      const result = await (this.client as unknown as { client: RawGraphQLClient }).client.rawRequest(query, { id: issueIdOrIdentifier })

      await this.circuitBreaker.recordSuccess()
      this._apiCallCount++

      const quota = extractQuotaFromHeaders(result.headers)
      if (quota) this.onApiResponse?.(quota)

      const data = result.data as {
        issue: {
          id: string
          identifier: string
          children: {
            nodes: Array<{
              id: string
              identifier: string
              title: string
              description: string | null
              priority: number
              url: string
              state: { name: string } | null
              labels: { nodes: Array<{ name: string; parent?: { name: string; isGroup: boolean } | null }> }
              relations: {
                nodes: Array<{
                  type: string
                  relatedIssue: { id: string; identifier: string } | null
                }>
              }
              inverseRelations: {
                nodes: Array<{
                  type: string
                  issue: { id: string; identifier: string } | null
                }>
              }
            }>
          }
        } | null
      }

      if (!data.issue) {
        throw new LinearApiError(
          `Issue not found: ${issueIdOrIdentifier}`,
          404
        )
      }

      const parentIssue = data.issue
      const subIssueIds = new Set(parentIssue.children.nodes.map((c) => c.id))

      const graphNodes: SubIssueGraphNode[] = parentIssue.children.nodes.map((child) => {
        const blockedBy: string[] = []
        const blocks: string[] = []

        // Inverse relations: other issues blocking this one
        for (const rel of child.inverseRelations.nodes) {
          if (rel.type === 'blocks' && rel.issue && subIssueIds.has(rel.issue.id)) {
            blockedBy.push(rel.issue.identifier)
          }
        }

        // Outgoing relations: this issue blocking others
        for (const rel of child.relations.nodes) {
          if (rel.type === 'blocks' && rel.relatedIssue && subIssueIds.has(rel.relatedIssue.id)) {
            blocks.push(rel.relatedIssue.identifier)
          }
        }

        return {
          issue: {
            id: child.id,
            identifier: child.identifier,
            title: child.title,
            description: child.description ?? undefined,
            status: child.state?.name,
            priority: child.priority,
            labels: resolveGraphQLLabelNames(child.labels.nodes),
            url: child.url,
          },
          blockedBy,
          blocks,
        }
      })

      return {
        parentId: parentIssue.id,
        parentIdentifier: parentIssue.identifier,
        subIssues: graphNodes,
      }
    } catch (error) {
      if (this.circuitBreaker.isAuthError(error)) {
        const statusCode = extractAuthStatusCode(error)
        await this.circuitBreaker.recordAuthFailure(statusCode)
      }
      throw error
    }
  }
}

/**
 * Create a configured LinearAgentClient instance
 */
export function createLinearAgentClient(
  config: LinearAgentClientConfig
): LinearAgentClient {
  return new LinearAgentClient(config)
}

// ---------------------------------------------------------------------------
// Raw GraphQL client type
// ---------------------------------------------------------------------------

/**
 * Type for the inner GraphQL client used by rawRequest calls.
 * The response may include headers from the Linear API.
 */
type RawGraphQLClient = {
  rawRequest: (
    query: string,
    variables: Record<string, unknown>,
  ) => Promise<{ data: unknown; headers?: Headers | Map<string, string> }>
}

/**
 * Extract quota information from Linear API response headers.
 */
function extractQuotaFromHeaders(
  headers?: Headers | Map<string, string>,
): LinearApiQuota | undefined {
  if (!headers) return undefined

  const get = (key: string): string | undefined | null => {
    if (headers instanceof Map) return headers.get(key) ?? undefined
    if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(key)
    return undefined
  }

  const requestsRemaining = get('x-ratelimit-requests-remaining')
  const requestsLimit = get('x-ratelimit-requests-limit')
  const complexityRemaining = get('x-ratelimit-complexity-remaining')
  const complexityLimit = get('x-ratelimit-complexity-limit')
  const resetSeconds = get('x-ratelimit-requests-reset')

  // Only return if we got at least one header
  if (!requestsRemaining && !complexityRemaining) return undefined

  return {
    requestsRemaining: requestsRemaining ? parseInt(requestsRemaining, 10) : undefined,
    requestsLimit: requestsLimit ? parseInt(requestsLimit, 10) : undefined,
    complexityRemaining: complexityRemaining ? parseInt(complexityRemaining, 10) : undefined,
    complexityLimit: complexityLimit ? parseInt(complexityLimit, 10) : undefined,
    resetSeconds: resetSeconds ? parseInt(resetSeconds, 10) : undefined,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract HTTP status code from an error for circuit breaker recording.
 */
function extractAuthStatusCode(error: unknown): number {
  if (typeof error !== 'object' || error === null) return 0
  const err = error as Record<string, unknown>
  if (typeof err.status === 'number') return err.status
  if (typeof err.statusCode === 'number') return err.statusCode
  const response = err.response as Record<string, unknown> | undefined
  if (response) {
    if (typeof response.status === 'number') return response.status
    if (typeof response.statusCode === 'number') return response.statusCode
  }
  // Default to 400 for auth errors detected by message pattern
  return 400
}
