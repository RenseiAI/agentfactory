import type { Issue } from '@linear/sdk'
import type { LinearAgentClient } from './agent-client.js'
import type {
  AgentSessionState,
  AgentSessionConfig,
  CreateActivityOptions,
  AgentPlan,
  AgentPlanItem,
  AgentPlanItemState,
  SessionOperationResult,
  AgentActivityContentPayload,
  AgentActivitySignal,
  AgentActivityResult,
  AgentWorkType,
  LinearPlanItem,
  LinearPlanStatus,
  IssueRelationResult,
  IssueRelationInfo,
  ActionActivityContent,
} from './types.js'
import type { ToolCategory } from '@donmai/core'
import {
  WORK_TYPE_START_STATUS,
  WORK_TYPE_COMPLETE_STATUS,
  WORK_TYPE_FAIL_STATUS,
  TERMINAL_STATUSES,
} from './types.js'
import {
  LinearSessionError,
  LinearActivityError,
  LinearPlanError,
} from './errors.js'
import { buildCompletionComments } from './utils.js'
import {
  getDefaultTeamId,
  LINEAR_PROJECTS,
  LINEAR_LABELS,
  type EnvironmentIssueType,
} from './constants.js'
import {
  parseCheckboxes,
  updateCheckboxes,
  type CheckboxItem,
  type CheckboxUpdate,
} from './checkbox-utils.js'

function generatePlanItemId(): string {
  return `plan-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

/**
 * Agent Session Handler
 * Manages the lifecycle of an agent working on a Linear issue
 */
export class AgentSession {
  private readonly client: LinearAgentClient
  private readonly issueId: string
  private readonly autoTransition: boolean
  private readonly workType: AgentWorkType

  private sessionId: string | null = null
  private state: AgentSessionState = 'pending'
  private currentPlan: AgentPlan = { items: [] }
  private issue: Issue | null = null
  private activityLog: Array<{
    type: string
    timestamp: Date
    content: string
  }> = []

  constructor(config: AgentSessionConfig) {
    this.client = config.client
    this.issueId = config.issueId
    this.sessionId = config.sessionId ?? null
    this.autoTransition = config.autoTransition ?? true
    this.workType = config.workType ?? 'development'
  }

  get currentState(): AgentSessionState {
    return this.state
  }

  get id(): string | null {
    return this.sessionId
  }

  get plan(): AgentPlan {
    return { ...this.currentPlan }
  }

  get activities(): Array<{ type: string; timestamp: Date; content: string }> {
    return [...this.activityLog]
  }

  /**
   * Add or update an external URL for the session
   * External URLs appear in the Linear issue view, linking to dashboards, logs, or PRs
   *
   * @param label - Display label for the URL (e.g., "Pull Request", "Logs")
   * @param url - The URL to link to
   */
  async addExternalUrl(label: string, url: string): Promise<void> {
    if (!this.sessionId) {
      throw new LinearSessionError(
        'Cannot add external URL without a session ID. Call start() first or provide sessionId in config.',
        undefined,
        this.issueId
      )
    }

    try {
      await this.client.updateAgentSession({
        sessionId: this.sessionId,
        externalUrls: [{ label, url }],
      })
    } catch (error) {
      throw new LinearSessionError(
        `Failed to add external URL: ${error instanceof Error ? error.message : 'Unknown error'}`,
        this.sessionId,
        this.issueId
      )
    }
  }

  /**
   * Set the pull request URL for this session
   * This unlocks additional PR-related features in Linear
   *
   * @param prUrl - The GitHub pull request URL
   * @see https://linear.app/developers/agents
   */
  async setPullRequestUrl(prUrl: string): Promise<void> {
    await this.addExternalUrl('Pull Request', prUrl)
  }

  /**
   * Start the agent session
   *
   * Transitions issue status based on work type:
   * - development: Backlog -> Started
   * - Other work types: No transition on start (issue stays in current status)
   */
  async start(): Promise<SessionOperationResult> {
    try {
      this.issue = await this.client.getIssue(this.issueId)

      if (!this.sessionId) {
        this.sessionId = `session-${this.issueId}-${Date.now()}`
      }

      this.state = 'active'

      // Transition based on work type — guard against terminal states
      const startStatus = WORK_TYPE_START_STATUS[this.workType]
      if (this.autoTransition && startStatus) {
        const currentState = await this.issue.state
        const currentStateName = currentState?.name
        if (currentStateName && TERMINAL_STATUSES.includes(currentStateName as typeof TERMINAL_STATUSES[number])) {
          console.warn(
            `[AgentSession] Refusing to transition issue ${this.issueId} from terminal state "${currentStateName}" to "${startStatus}"`
          )
        } else {
          await this.client.updateIssueStatus(this.issueId, startStatus)
        }
      }

      return { success: true, sessionId: this.sessionId }
    } catch (error) {
      this.state = 'error'
      throw new LinearSessionError(
        `Failed to start session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        this.sessionId ?? undefined,
        this.issueId
      )
    }
  }

  /**
   * Mark session as awaiting user input
   */
  async awaitInput(prompt: string): Promise<void> {
    this.state = 'awaitingInput'
    await this.emitActivity({
      type: 'response',
      content: { text: `Awaiting input: ${prompt}` },
    })
  }

  /**
   * Complete the session successfully
   *
   * Transitions issue status based on work type:
   * - development/inflight: Started -> Finished
   * - qa: Finished -> Delivered (only if workResult === 'passed')
   * - acceptance: Delivered -> Accepted (only if workResult === 'passed')
   * - refinement: Rejected -> Backlog
   * - research: No transition (user decides when to move to Backlog)
   *
   * @param summary - Optional completion summary to post as a comment
   * @param workResult - For QA/acceptance: 'passed' promotes, 'failed' transitions to fail status, undefined skips transition
   */
  async complete(summary?: string, workResult?: 'passed' | 'failed'): Promise<SessionOperationResult> {
    try {
      this.state = 'complete'

      this.currentPlan.items = this.currentPlan.items.map((item) => ({
        ...item,
        state:
          item.state === 'pending' || item.state === 'inProgress'
            ? ('completed' as AgentPlanItemState)
            : item.state,
      }))

      if (summary) {
        await this.postCompletionComment(summary)
      }

      // Sync all remaining description checkboxes to complete
      try {
        const checkboxes = await this.getDescriptionCheckboxes()
        const unchecked = checkboxes.filter((cb) => !cb.checked)
        if (unchecked.length > 0) {
          await this.updateDescriptionCheckboxes(
            unchecked.map((cb) => ({ textPattern: cb.text, checked: true }))
          )
        }
      } catch (error) {
        // Log but don't fail completion - checkbox sync is non-critical
        console.warn(
          '[AgentSession] Failed to sync description checkboxes on complete:',
          error instanceof Error ? error.message : String(error)
        )
      }

      // Transition based on work type — guard against terminal states
      if (this.autoTransition) {
        // Re-fetch current state to guard against transitioning out of terminal states
        let isTerminal = false
        try {
          const freshIssue = await this.client.getIssue(this.issueId)
          const currentState = await freshIssue.state
          const currentStateName = currentState?.name
          if (currentStateName && TERMINAL_STATUSES.includes(currentStateName as typeof TERMINAL_STATUSES[number])) {
            isTerminal = true
            console.warn(
              `[AgentSession] Refusing to transition issue ${this.issueId} from terminal state "${currentStateName}" on completion`
            )
          }
        } catch (err) {
          console.warn('[AgentSession] Failed to check terminal state before completion transition:', err)
        }

        if (!isTerminal) {
          const isResultSensitive = this.workType === 'qa' || this.workType === 'acceptance' || this.workType === 'development' || this.workType === 'inflight'

          if (isResultSensitive) {
            // For QA/acceptance: only transition if workResult is explicitly set
            if (workResult === 'passed') {
              const completeStatus = WORK_TYPE_COMPLETE_STATUS[this.workType]
              if (completeStatus) {
                await this.client.updateIssueStatus(this.issueId, completeStatus)
              }
            } else if (workResult === 'failed') {
              const failStatus = WORK_TYPE_FAIL_STATUS[this.workType]
              if (failStatus) {
                await this.client.updateIssueStatus(this.issueId, failStatus)
              }
            }
            // undefined workResult -> skip transition (safe default)
          } else {
            // Non-QA/acceptance: unchanged behavior
            const completeStatus = WORK_TYPE_COMPLETE_STATUS[this.workType]
            if (completeStatus) {
              await this.client.updateIssueStatus(this.issueId, completeStatus)
            }
          }
        }
      }

      return { success: true, sessionId: this.sessionId ?? undefined }
    } catch (error) {
      throw new LinearSessionError(
        `Failed to complete session: ${error instanceof Error ? error.message : 'Unknown error'}`,
        this.sessionId ?? undefined,
        this.issueId
      )
    }
  }

  /**
   * Mark session as failed
   * Emits an error activity (auto-generates comment) if session ID is available,
   * otherwise falls back to creating a comment directly.
   */
  async fail(errorMessage: string): Promise<SessionOperationResult> {
    try {
      this.state = 'error'

      this.currentPlan.items = this.currentPlan.items.map((item) => ({
        ...item,
        state:
          item.state === 'inProgress'
            ? ('canceled' as AgentPlanItemState)
            : item.state,
      }))

      // Use error activity if we have a session ID (auto-generates comment)
      // Otherwise fall back to direct comment
      if (this.sessionId) {
        await this.createActivity(
          {
            type: 'error',
            body: `**Agent Error**\n\n${errorMessage}\n\n---\n*Session ID: ${this.sessionId}*`,
          },
          false // not ephemeral - errors should persist
        )
      } else {
        await this.client.createComment(
          this.issueId,
          `## Agent Error\n\n${errorMessage}\n\n---\n*Session ID: ${this.sessionId}*`
        )
      }

      return { success: true, sessionId: this.sessionId ?? undefined }
    } catch (error) {
      throw new LinearSessionError(
        `Failed to mark session as failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        this.sessionId ?? undefined,
        this.issueId
      )
    }
  }

  /**
   * Emit a generic activity (legacy method for backward compatibility)
   * @deprecated Use createActivity for native Linear Agent API
   */
  async emitActivity(options: CreateActivityOptions): Promise<void> {
    try {
      this.activityLog.push({
        type: options.type,
        timestamp: new Date(),
        content: options.content.text,
      })

      if (!options.ephemeral && options.type === 'response') {
        await this.client.createComment(
          this.issueId,
          this.formatActivityAsComment(options)
        )
      }
    } catch (error) {
      throw new LinearActivityError(
        `Failed to emit activity: ${error instanceof Error ? error.message : 'Unknown error'}`,
        options.type,
        this.sessionId ?? undefined
      )
    }
  }

  /**
   * Create an activity using the native Linear Agent API
   *
   * @param content - The activity content payload
   * @param ephemeral - Whether the activity should disappear after the next activity
   * @param signal - Optional modifier for how the activity should be interpreted
   * @returns Result containing success status and activity ID
   */
  async createActivity(
    content: AgentActivityContentPayload,
    ephemeral = false,
    signal?: AgentActivitySignal
  ): Promise<AgentActivityResult> {
    if (!this.sessionId) {
      throw new LinearActivityError(
        'Cannot create activity without a session ID. Call start() first or provide sessionId in config.',
        content.type,
        undefined
      )
    }

    try {
      const contentText =
        content.type === 'action'
          ? `${content.action}: ${content.parameter}`
          : content.body

      this.activityLog.push({
        type: content.type,
        timestamp: new Date(),
        content: contentText,
      })

      const result = await this.client.createAgentActivity({
        agentSessionId: this.sessionId,
        content,
        ephemeral,
        signal,
      })

      return result
    } catch (error) {
      throw new LinearActivityError(
        `Failed to create activity: ${error instanceof Error ? error.message : 'Unknown error'}`,
        content.type,
        this.sessionId
      )
    }
  }

  /**
   * Emit a thought activity (persistent by default for visibility in Linear)
   */
  async emitThought(text: string, ephemeral = false): Promise<void> {
    if (this.sessionId) {
      await this.createActivity({ type: 'thought', body: text }, ephemeral)
    } else {
      await this.emitActivity({
        type: 'thought',
        content: { text },
        ephemeral,
      })
    }
  }

  /**
   * Emit an action activity (tool call)
   */
  async emitAction(
    toolName: string,
    input: Record<string, unknown>,
    ephemeral = true,
    toolCategory?: ToolCategory
  ): Promise<void> {
    if (this.sessionId) {
      await this.createActivity(
        {
          type: 'action',
          action: toolName,
          parameter: JSON.stringify(input),
          ...(toolCategory ? { toolCategory } : {}),
        } as ActionActivityContent,
        ephemeral
      )
    } else {
      await this.emitActivity({
        type: 'action',
        content: {
          text: `Calling ${toolName}`,
          metadata: { toolName, input },
        },
        ephemeral,
        signals: { toolName, toolInput: input, ...(toolCategory ? { toolCategory } : {}) },
      })
    }
  }

  /**
   * Emit a tool result activity
   */
  async emitToolResult(
    toolName: string,
    output: unknown,
    ephemeral = true
  ): Promise<void> {
    if (this.sessionId) {
      await this.createActivity(
        {
          type: 'action',
          action: toolName,
          parameter: 'result',
          result:
            typeof output === 'string' ? output : JSON.stringify(output, null, 2),
        },
        ephemeral
      )
    } else {
      await this.emitActivity({
        type: 'action',
        content: {
          text: `Result from ${toolName}`,
          metadata: { toolName, output },
        },
        ephemeral,
        signals: { toolName, toolOutput: output },
      })
    }
  }

  /**
   * Emit a response activity (persisted)
   */
  async emitResponse(text: string): Promise<void> {
    if (this.sessionId) {
      await this.createActivity({ type: 'response', body: text }, false)
    } else {
      await this.emitActivity({
        type: 'response',
        content: { text },
        ephemeral: false,
      })
    }
  }

  /**
   * Emit an error activity using native API
   */
  async emitError(error: Error): Promise<void> {
    if (this.sessionId) {
      await this.createActivity(
        {
          type: 'error',
          body: `**${error.name}**: ${error.message}${error.stack ? `\n\n\`\`\`\n${error.stack}\n\`\`\`` : ''}`,
        },
        false
      )
    } else {
      await this.emitActivity({
        type: 'response',
        content: {
          text: `Error: ${error.message}`,
          metadata: {
            errorName: error.name,
            errorStack: error.stack,
          },
        },
        ephemeral: false,
        signals: {
          error: {
            message: error.message,
            stack: error.stack,
          },
        },
      })
    }
  }

  /**
   * Emit an elicitation activity - asking for clarification from the user
   */
  async emitElicitation(
    text: string,
    ephemeral = false
  ): Promise<AgentActivityResult | void> {
    if (this.sessionId) {
      return this.createActivity({ type: 'elicitation', body: text }, ephemeral)
    } else {
      await this.emitActivity({
        type: 'response',
        content: { text: `Awaiting clarification: ${text}` },
        ephemeral,
      })
    }
  }

  /**
   * Emit a prompt activity - prompts/instructions for the user
   */
  async emitPrompt(
    text: string,
    ephemeral = false
  ): Promise<AgentActivityResult | void> {
    if (this.sessionId) {
      return this.createActivity({ type: 'prompt', body: text }, ephemeral)
    } else {
      await this.emitActivity({
        type: 'response',
        content: { text },
        ephemeral,
      })
    }
  }

  /**
   * Emit an authentication required activity
   * Shows an authentication prompt to the user with a link to authorize
   *
   * @param authUrl - The URL the user should visit to authenticate
   * @param providerName - Optional name of the auth provider (e.g., "GitHub", "Google")
   * @param body - Optional custom message body
   * @returns Activity result with ID
   *
   * @see https://linear.app/developers/agent-signals
   */
  async emitAuthRequired(
    authUrl: string,
    providerName?: string,
    body?: string
  ): Promise<AgentActivityResult> {
    if (!this.sessionId) {
      throw new LinearActivityError(
        'Cannot emit auth activity without a session ID. Call start() first or provide sessionId in config.',
        'elicitation',
        undefined
      )
    }

    const messageBody = body
      ?? `Authentication required${providerName ? ` with ${providerName}` : ''}. Please [click here](${authUrl}) to authorize.`

    return this.client.createAgentActivity({
      agentSessionId: this.sessionId,
      content: { type: 'elicitation', body: messageBody },
      ephemeral: false,
      signal: 'auth',
    })
  }

  /**
   * Emit a selection prompt activity
   * Shows a multiple choice selection to the user
   *
   * @param prompt - The question or prompt for the user
   * @param options - Array of option strings the user can select from
   * @returns Activity result with ID
   *
   * @see https://linear.app/developers/agent-signals
   */
  async emitSelect(
    prompt: string,
    options: string[]
  ): Promise<AgentActivityResult> {
    if (!this.sessionId) {
      throw new LinearActivityError(
        'Cannot emit select activity without a session ID. Call start() first or provide sessionId in config.',
        'elicitation',
        undefined
      )
    }

    // Format options as numbered list in the body
    const optionsList = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')
    const body = `${prompt}\n\n${optionsList}`

    return this.client.createAgentActivity({
      agentSessionId: this.sessionId,
      content: { type: 'elicitation', body },
      ephemeral: false,
      signal: 'select',
    })
  }

  /**
   * Report an environment issue for self-improvement.
   * Creates a bug in the Agent project backlog to track infrastructure improvements.
   *
   * This is a best-effort operation - failures are logged but don't propagate.
   *
   * @param title - Short description of the issue
   * @param description - Detailed explanation of what happened
   * @param context - Additional context about the issue
   * @returns The created issue, or null if creation failed
   */
  async reportEnvironmentIssue(
    title: string,
    description: string,
    context?: {
      issueType?: EnvironmentIssueType
      sourceIssueId?: string
      errorStack?: string
      additionalContext?: Record<string, unknown>
    }
  ): Promise<{ id: string; identifier: string; url: string } | null> {
    try {
      const fullDescription = `## Environment Issue Report

${description}

### Context

| Field | Value |
|-------|-------|
| Source Issue | ${context?.sourceIssueId ?? this.issueId} |
| Session ID | ${this.sessionId ?? 'N/A'} |
| Issue Type | ${context?.issueType ?? 'unknown'} |
| Timestamp | ${new Date().toISOString()} |

${context?.additionalContext ? `### Additional Details\n\n\`\`\`json\n${JSON.stringify(context.additionalContext, null, 2)}\n\`\`\`` : ''}

${context?.errorStack ? `### Error Stack\n\n\`\`\`\n${context.errorStack}\n\`\`\`` : ''}

---
*Auto-generated by agent self-improvement system*`

      const issue = await this.client.createIssue({
        title: `Bug: [Agent Environment] ${title}`,
        description: fullDescription,
        teamId: getDefaultTeamId(),
        projectId: LINEAR_PROJECTS.AGENT,
        labelIds: [LINEAR_LABELS.BUG],
      })

      return {
        id: issue.id,
        identifier: issue.identifier,
        url: issue.url,
      }
    } catch (error) {
      // Log but don't throw - this is a best-effort feature
      console.error(
        '[AgentSession] Failed to report environment issue:',
        error instanceof Error ? error.message : String(error)
      )
      return null
    }
  }

  /**
   * Report a human-needed blocker issue.
   * Creates an issue in Icebox with "Needs Human" label, linked as blocking the current issue.
   *
   * This is a best-effort operation - failures are logged but don't propagate.
   *
   * @param title - Short description of what the human needs to do
   * @param description - Detailed steps or context for the human
   * @param options - Optional overrides for project and assignee
   * @returns The created blocker issue, or null if creation failed
   */
  async reportHumanBlocker(
    title: string,
    description: string,
    options?: {
      projectId?: string
      assigneeId?: string
    }
  ): Promise<{ id: string; identifier: string; url: string } | null> {
    try {
      // Resolve project from source issue if not provided
      let projectId = options?.projectId
      if (!projectId) {
        if (!this.issue) {
          this.issue = await this.client.getIssue(this.issueId)
        }
        const project = await this.issue.project
        projectId = project?.id
      }

      const fullDescription = `${description}\n\n---\n*Source issue: ${this.issueId}*\n*Session ID: ${this.sessionId ?? 'N/A'}*\n*Auto-generated by agent blocker system*`

      // Get Icebox state for the team
      if (!this.issue) {
        this.issue = await this.client.getIssue(this.issueId)
      }
      const team = await this.issue.team
      let stateId: string | undefined
      if (team) {
        const statuses = await this.client.getTeamStatuses(team.id)
        stateId = statuses['Icebox']
      }

      const createInput: Parameters<LinearAgentClient['createIssue']>[0] = {
        title,
        description: fullDescription,
        teamId: team?.id ?? getDefaultTeamId(),
        labelIds: LINEAR_LABELS.NEEDS_HUMAN ? [LINEAR_LABELS.NEEDS_HUMAN] : [],
      }

      if (projectId) {
        createInput.projectId = projectId
      }
      if (stateId) {
        createInput.stateId = stateId
      }

      const blockerIssue = await this.client.createIssue(createInput)

      // Assign if requested (createIssue doesn't support assigneeId directly)
      if (options?.assigneeId) {
        await this.client.updateIssue(blockerIssue.id, {
          assigneeId: options.assigneeId,
        })
      }

      // Create blocking relation: blocker blocks source
      await this.client.createIssueRelation({
        issueId: blockerIssue.id,
        relatedIssueId: this.issueId,
        type: 'blocks',
      })

      // Post comment on source issue
      await this.client.createComment(
        this.issueId,
        `\u{1F6A7} Human blocker created: [${blockerIssue.identifier}](${blockerIssue.url}) — ${title}`
      )

      return {
        id: blockerIssue.id,
        identifier: blockerIssue.identifier,
        url: blockerIssue.url,
      }
    } catch (error) {
      console.error(
        '[AgentSession] Failed to report human blocker:',
        error instanceof Error ? error.message : String(error)
      )
      return null
    }
  }

  // ============================================================================
  // SUB-ISSUE SESSION METHODS (for coordination work type)
  // ============================================================================

  /**
   * Create an agent session on a sub-issue for activity reporting
   *
   * The coordinator uses this to emit activities to individual sub-issue threads,
   * making sub-agent progress visible on each sub-issue in Linear.
   *
   * @param subIssueId - The sub-issue ID (UUID) to create a session on
   * @returns The session ID for the sub-issue, or null if creation failed
   */
  async createSubIssueSession(subIssueId: string): Promise<string | null> {
    try {
      const result = await this.client.createAgentSessionOnIssue({
        issueId: subIssueId,
      })

      if (result.success && result.sessionId) {
        return result.sessionId
      }

      console.warn(
        `[AgentSession] Failed to create sub-issue session for ${subIssueId}:`,
        result
      )
      return null
    } catch (error) {
      console.warn(
        '[AgentSession] Error creating sub-issue session:',
        error instanceof Error ? error.message : String(error)
      )
      return null
    }
  }

  /**
   * Emit an activity to a sub-issue's agent session
   *
   * Used by the coordinator to report progress on individual sub-issues.
   * Falls back to creating a comment if the activity emission fails.
   *
   * @param subIssueSessionId - The agent session ID for the sub-issue
   * @param content - The activity content to emit
   * @param ephemeral - Whether the activity is ephemeral (default: false)
   */
  async emitSubIssueActivity(
    subIssueSessionId: string,
    content: AgentActivityContentPayload,
    ephemeral = false
  ): Promise<void> {
    try {
      await this.client.createAgentActivity({
        agentSessionId: subIssueSessionId,
        content,
        ephemeral,
      })
    } catch (error) {
      console.warn(
        '[AgentSession] Failed to emit sub-issue activity:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  // ============================================================================
  // DESCRIPTION CHECKBOX METHODS
  // ============================================================================

  /**
   * Get the current issue description
   * Refreshes the issue data from Linear if needed
   */
  async getDescription(): Promise<string | undefined> {
    if (!this.issue) {
      this.issue = await this.client.getIssue(this.issueId)
    }
    return this.issue?.description ?? undefined
  }

  /**
   * Parse checkboxes from the issue description
   *
   * @returns Array of checkbox items, or empty array if no description
   */
  async getDescriptionCheckboxes(): Promise<CheckboxItem[]> {
    const description = await this.getDescription()
    if (!description) return []
    return parseCheckboxes(description)
  }

  /**
   * Update checkboxes in the issue description
   *
   * @param updates - Array of updates to apply
   * @returns The updated issue, or null if no changes were made
   */
  async updateDescriptionCheckboxes(
    updates: CheckboxUpdate[]
  ): Promise<Issue | null> {
    const description = await this.getDescription()
    if (!description) return null

    const newDescription = updateCheckboxes(description, updates)
    if (newDescription === description) return null // No changes

    const updatedIssue = await this.client.updateIssue(this.issueId, {
      description: newDescription,
    })

    // Update local cache
    this.issue = updatedIssue
    return updatedIssue
  }

  /**
   * Mark a specific task as complete in the issue description
   *
   * @param textPattern - String or regex to match the task text
   * @returns The updated issue, or null if task not found
   */
  async completeDescriptionTask(
    textPattern: string | RegExp
  ): Promise<Issue | null> {
    return this.updateDescriptionCheckboxes([{ textPattern, checked: true }])
  }

  /**
   * Mark a specific task as incomplete in the issue description
   *
   * @param textPattern - String or regex to match the task text
   * @returns The updated issue, or null if task not found
   */
  async uncompleteDescriptionTask(
    textPattern: string | RegExp
  ): Promise<Issue | null> {
    return this.updateDescriptionCheckboxes([{ textPattern, checked: false }])
  }

  // ============================================================================
  // ISSUE RELATION CONVENIENCE METHODS
  // ============================================================================

  /**
   * Link this issue as related to another issue
   *
   * @param relatedIssueId - The issue ID or identifier to link to
   * @returns Result with relation ID, or null if relation already exists
   */
  async linkRelatedIssue(
    relatedIssueId: string
  ): Promise<IssueRelationResult | null> {
    // Check if relation already exists
    const existingRelations = await this.client.getIssueRelations(this.issueId)
    const alreadyLinked = existingRelations.relations.some(
      (r) =>
        r.type === 'related' &&
        (r.relatedIssueId === relatedIssueId ||
          r.relatedIssueIdentifier === relatedIssueId)
    )
    if (alreadyLinked) {
      return null // Already linked
    }

    return this.client.createIssueRelation({
      issueId: this.issueId,
      relatedIssueId,
      type: 'related',
    })
  }

  /**
   * Mark this issue as blocked by another issue
   *
   * @param blockingIssueId - The issue ID or identifier that blocks this one
   * @returns Result with relation ID, or null if relation already exists
   */
  async markAsBlockedBy(
    blockingIssueId: string
  ): Promise<IssueRelationResult | null> {
    // Check if relation already exists
    const existingRelations = await this.client.getIssueRelations(this.issueId)
    const alreadyBlocked = existingRelations.inverseRelations.some(
      (r) =>
        r.type === 'blocks' &&
        (r.issueId === blockingIssueId || r.issueIdentifier === blockingIssueId)
    )
    if (alreadyBlocked) {
      return null // Already blocked by this issue
    }

    // The blocking issue blocks this issue
    return this.client.createIssueRelation({
      issueId: blockingIssueId,
      relatedIssueId: this.issueId,
      type: 'blocks',
    })
  }

  /**
   * Mark this issue as blocking another issue
   *
   * @param blockedIssueId - The issue ID or identifier that this issue blocks
   * @returns Result with relation ID, or null if relation already exists
   */
  async markAsBlocking(
    blockedIssueId: string
  ): Promise<IssueRelationResult | null> {
    // Check if relation already exists
    const existingRelations = await this.client.getIssueRelations(this.issueId)
    const alreadyBlocking = existingRelations.relations.some(
      (r) =>
        r.type === 'blocks' &&
        (r.relatedIssueId === blockedIssueId ||
          r.relatedIssueIdentifier === blockedIssueId)
    )
    if (alreadyBlocking) {
      return null // Already blocking this issue
    }

    // This issue blocks the other issue
    return this.client.createIssueRelation({
      issueId: this.issueId,
      relatedIssueId: blockedIssueId,
      type: 'blocks',
    })
  }

  /**
   * Mark this issue as a duplicate of another issue
   *
   * @param originalIssueId - The original issue ID or identifier
   * @returns Result with relation ID, or null if relation already exists
   */
  async markAsDuplicateOf(
    originalIssueId: string
  ): Promise<IssueRelationResult | null> {
    // Check if relation already exists
    const existingRelations = await this.client.getIssueRelations(this.issueId)
    const alreadyDuplicate = existingRelations.relations.some(
      (r) =>
        r.type === 'duplicate' &&
        (r.relatedIssueId === originalIssueId ||
          r.relatedIssueIdentifier === originalIssueId)
    )
    if (alreadyDuplicate) {
      return null // Already marked as duplicate
    }

    // This issue is a duplicate of the original
    return this.client.createIssueRelation({
      issueId: this.issueId,
      relatedIssueId: originalIssueId,
      type: 'duplicate',
    })
  }

  /**
   * Get issues that are blocking this issue
   *
   * @returns Array of relation info for blocking issues
   */
  async getBlockers(): Promise<IssueRelationInfo[]> {
    const relations = await this.client.getIssueRelations(this.issueId)
    // Blockers are inverse relations where another issue blocks this one
    return relations.inverseRelations.filter((r) => r.type === 'blocks')
  }

  /**
   * Check if this issue is blocked by any other issues
   *
   * @returns True if blocked, false otherwise
   */
  async isBlocked(): Promise<boolean> {
    const blockers = await this.getBlockers()
    return blockers.length > 0
  }

  /**
   * Update the agent's plan (full replacement)
   *
   * Uses Linear's native agentSessionUpdate mutation to display the plan
   * as checkboxes in the Linear UI. Also maintains internal plan state
   * for checkbox sync and completion tracking.
   */
  async updatePlan(items: Omit<AgentPlanItem, 'id'>[]): Promise<void> {
    try {
      // Store internal plan with IDs for backward compatibility and checkbox sync
      this.currentPlan = {
        items: items.map((item) => ({
          ...item,
          id: generatePlanItemId(),
          children: item.children?.map((child) => ({
            ...child,
            id: generatePlanItemId(),
          })),
        })),
      }

      // Flatten the plan for Linear's native API (no nested children)
      const linearPlan: LinearPlanItem[] = this.flattenPlanItems(items)

      // Only update via API if we have a session ID
      if (this.sessionId) {
        await this.client.updateAgentSession({
          sessionId: this.sessionId,
          plan: linearPlan,
        })
      }
    } catch (error) {
      throw new LinearPlanError(
        `Failed to update plan: ${error instanceof Error ? error.message : 'Unknown error'}`,
        this.sessionId ?? undefined
      )
    }
  }

  /**
   * Flatten nested plan items into Linear's flat format
   * Converts: { title, state, children } -> { content, status }
   */
  private flattenPlanItems(items: Omit<AgentPlanItem, 'id'>[]): LinearPlanItem[] {
    const result: LinearPlanItem[] = []

    for (const item of items) {
      // Add parent item
      result.push({
        content: item.details ? `${item.title} - ${item.details}` : item.title,
        status: item.state as LinearPlanStatus,
      })

      // Add children as indented items (Linear shows as sub-tasks)
      if (item.children && item.children.length > 0) {
        for (const child of item.children) {
          result.push({
            content: child.details ? `  ${child.title} - ${child.details}` : `  ${child.title}`,
            status: child.state as LinearPlanStatus,
          })
        }
      }
    }

    return result
  }

  /**
   * Update a single plan item's state
   * Also updates the plan in Linear's native API and syncs description checkboxes
   */
  async updatePlanItemState(
    itemId: string,
    state: AgentPlanItemState
  ): Promise<void> {
    // Find the item to get its title for checkbox sync
    let itemTitle: string | undefined

    const updateItemState = (items: AgentPlanItem[]): AgentPlanItem[] => {
      return items.map((item) => {
        if (item.id === itemId) {
          itemTitle = item.title
          return { ...item, state }
        }
        if (item.children) {
          const updatedChildren = updateItemState(item.children)
          // Check if we found the item in children
          if (!itemTitle) {
            const foundChild = item.children.find((c) => c.id === itemId)
            if (foundChild) {
              itemTitle = foundChild.title
            }
          }
          return { ...item, children: updatedChildren }
        }
        return item
      })
    }

    this.currentPlan.items = updateItemState(this.currentPlan.items)

    // Push updated plan to Linear
    if (this.sessionId) {
      try {
        const linearPlan = this.flattenPlanItems(this.currentPlan.items)
        await this.client.updateAgentSession({
          sessionId: this.sessionId,
          plan: linearPlan,
        })
      } catch (error) {
        // Log but don't throw - individual state updates are non-critical
        console.warn(
          '[AgentSession] Failed to update plan state in Linear:',
          error instanceof Error ? error.message : String(error)
        )
      }
    }

    // Sync description checkboxes when plan item completes
    if (state === 'completed' && itemTitle) {
      try {
        await this.completeDescriptionTask(itemTitle)
      } catch (error) {
        // Log but don't throw - checkbox sync is non-critical
        console.warn(
          '[AgentSession] Failed to sync description checkbox:',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }

  /**
   * Create a plan item helper
   */
  createPlanItem(
    title: string,
    state: AgentPlanItemState = 'pending',
    details?: string
  ): Omit<AgentPlanItem, 'id'> {
    return { title, state, details }
  }

  private formatActivityAsComment(options: CreateActivityOptions): string {
    const typeEmoji: Record<string, string> = {
      thought: '\u{1F4AD}',
      action: '\u{26A1}',
      response: '\u{1F4AC}',
      elicitation: '\u{2753}',
      error: '\u{274C}',
      prompt: '\u{1F4DD}',
    }

    const emoji = typeEmoji[options.type] ?? '\u{1F4AC}'
    return `${emoji} **${options.type.charAt(0).toUpperCase() + options.type.slice(1)}**\n\n${options.content.text}`
  }

  private async postCompletionComment(summary: string): Promise<void> {
    const planItems = this.currentPlan.items.map((item) => ({
      state: item.state,
      title: item.title,
    }))

    const comments = buildCompletionComments(
      summary,
      planItems,
      this.sessionId
    )

    // Post comments sequentially to maintain order
    for (const chunk of comments) {
      try {
        await this.client.createComment(this.issueId, chunk.body)
        // Small delay between comments to ensure ordering
        if (chunk.partNumber < chunk.totalParts) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      } catch (error) {
        // Log and continue with remaining comments
        console.error(
          `[AgentSession] Failed to post completion comment part ${chunk.partNumber}/${chunk.totalParts}:`,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }
}

/**
 * Create a new agent session
 */
export function createAgentSession(config: AgentSessionConfig): AgentSession {
  return new AgentSession(config)
}
