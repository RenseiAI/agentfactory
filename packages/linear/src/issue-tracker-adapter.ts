/**
 * Linear Issue Tracker Adapter
 *
 * Implements the platform-agnostic IssueTrackerClient interface
 * by wrapping LinearAgentClient and AgentSession.
 *
 * Types are defined locally (structurally identical to core) to avoid
 * a compile-time dependency on @donmai/core.
 */

import { LinearAgentClient, createLinearAgentClient } from './agent-client.js'
import { AgentSession, createAgentSession } from './agent-session.js'
import { buildCompletionComments, resolveSDKLabelNames } from './utils.js'
import type { AgentWorkType } from './types.js'
import {
  STATUS_WORK_TYPE_MAP,
  WORK_TYPE_START_STATUS,
  WORK_TYPE_COMPLETE_STATUS,
  WORK_TYPE_FAIL_STATUS,
  TERMINAL_STATUSES,
  WORK_TYPES_REQUIRING_WORKTREE,
} from './types.js'

// ---------------------------------------------------------------------------
// Platform-agnostic types (structurally identical to @donmai/core)
// Defined locally to avoid circular dependency: core -> linear -> core
// ---------------------------------------------------------------------------

/** Platform-agnostic issue representation. */
export interface IssueTrackerIssue {
  id: string
  identifier: string
  title: string
  description?: string
  url: string
  priority: number
  status?: string
  labels: string[]
  teamName?: string
  projectName?: string
  /** Parent issue ID, if this issue is a sub-issue. */
  parentId?: string
}

/** Configuration for creating an issue tracker session. */
export interface SessionConfig {
  issueId: string
  sessionId: string
  autoTransition?: boolean
}

/** Platform-agnostic session for streaming agent activities. */
export interface IssueTrackerSession {
  emitThought(content: string, ephemeral?: boolean): Promise<void>
  emitAction(tool: string, input: Record<string, unknown>, ephemeral?: boolean, toolCategory?: string): Promise<void>
  emitToolResult(tool: string, output: string, ephemeral?: boolean): Promise<void>
  emitResponse(content: string): Promise<void>
  emitError(error: Error): Promise<void>
  reportEnvironmentIssue(
    title: string,
    description: string,
    options?: unknown
  ): Promise<{ id: string; identifier: string; url: string } | null>
  setPullRequestUrl(url: string): Promise<void>
  addExternalUrl(url: { url: string; label: string }): Promise<void>
  complete(): Promise<void>
}

/** Comment chunk returned by buildCompletionComments. */
export interface CommentChunk {
  body: string
  partNumber: number
  totalParts: number
}

/** Platform-agnostic issue tracker client. */
export interface IssueTrackerClient {
  getIssue(idOrIdentifier: string): Promise<IssueTrackerIssue>
  isParentIssue(issueId: string): Promise<boolean>
  isChildIssue(issueId: string): Promise<boolean>
  createComment(issueId: string, body: string): Promise<{ id: string }>
  updateIssueStatus(issueId: string, status: string): Promise<void>
  unassignIssue(issueId: string): Promise<void>
  queryIssues(options: {
    project?: string
    status?: string
    maxResults?: number
  }): Promise<IssueTrackerIssue[]>
  getProjectRepositoryUrl(projectName: string): Promise<string | null>
  createSession(config: SessionConfig): IssueTrackerSession
  buildCompletionComments(
    resultMessage: string,
    planItems: unknown[],
    sessionId: string | null
  ): CommentChunk[]
}

/** Maps between workflow statuses and agent work types. */
export interface WorkTypeStatusMappings {
  statusToWorkType: Record<string, AgentWorkType>
  workTypeStartStatus: Record<AgentWorkType, string | null>
  workTypeCompleteStatus: Record<AgentWorkType, string | null>
  workTypeFailStatus: Record<AgentWorkType, string | null>
  terminalStatuses: readonly string[]
  workTypesRequiringWorktree: ReadonlySet<AgentWorkType>
}

/**
 * Wraps a Linear AgentSession to implement IssueTrackerSession.
 */
class LinearIssueTrackerSession implements IssueTrackerSession {
  constructor(private readonly session: AgentSession) {}

  async emitThought(content: string, ephemeral?: boolean): Promise<void> {
    await this.session.emitThought(content, ephemeral)
  }

  async emitAction(tool: string, input: Record<string, unknown>, ephemeral?: boolean, toolCategory?: string): Promise<void> {
    await this.session.emitAction(tool, input, ephemeral, toolCategory as import('@donmai/core').ToolCategory | undefined)
  }

  async emitToolResult(tool: string, output: string, ephemeral?: boolean): Promise<void> {
    await this.session.emitToolResult(tool, output, ephemeral)
  }

  async emitResponse(content: string): Promise<void> {
    await this.session.emitResponse(content)
  }

  async emitError(error: Error): Promise<void> {
    await this.session.emitError(error)
  }

  async reportEnvironmentIssue(
    title: string,
    description: string,
    options?: unknown
  ): Promise<{ id: string; identifier: string; url: string } | null> {
    return this.session.reportEnvironmentIssue(title, description, options as any)
  }

  async setPullRequestUrl(url: string): Promise<void> {
    await this.session.setPullRequestUrl(url)
  }

  async addExternalUrl(url: { url: string; label: string }): Promise<void> {
    await this.session.addExternalUrl(url.label, url.url)
  }

  async complete(): Promise<void> {
    await this.session.complete()
  }
}

/**
 * Implements IssueTrackerClient by wrapping LinearAgentClient.
 * Injected into the orchestrator at construction time.
 */
export class LinearIssueTrackerClient implements IssueTrackerClient {
  readonly linearClient: LinearAgentClient

  constructor(config: { apiKey: string }) {
    this.linearClient = createLinearAgentClient({ apiKey: config.apiKey })
  }

  async getIssue(idOrIdentifier: string): Promise<IssueTrackerIssue> {
    const issue = await this.linearClient.getIssue(idOrIdentifier)
    const state = await issue.state
    const team = await issue.team
    const project = await issue.project
    const labels = await issue.labels()

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? undefined,
      url: issue.url,
      priority: issue.priority,
      status: state?.name,
      labels: await resolveSDKLabelNames(labels.nodes),
      teamName: team?.key,
      projectName: project?.name,
    }
  }

  async isParentIssue(issueId: string): Promise<boolean> {
    return this.linearClient.isParentIssue(issueId)
  }

  async isChildIssue(issueId: string): Promise<boolean> {
    return this.linearClient.isChildIssue(issueId)
  }

  async createComment(issueId: string, body: string): Promise<{ id: string }> {
    const comment = await this.linearClient.createComment(issueId, body)
    return { id: comment.id }
  }

  async updateIssueStatus(issueId: string, status: string): Promise<void> {
    await this.linearClient.updateIssueStatus(issueId, status as any)
  }

  async unassignIssue(issueId: string): Promise<void> {
    await this.linearClient.unassignIssue(issueId)
  }

  async queryIssues(options: {
    project?: string
    status?: string
    maxResults?: number
  }): Promise<IssueTrackerIssue[]> {
    const filter: Record<string, unknown> = {}

    if (options.status) {
      filter.state = { name: { eqIgnoreCase: options.status } }
    }

    if (options.project) {
      const projects = await this.linearClient.linearClient.projects({
        filter: { name: { eqIgnoreCase: options.project } },
      })
      if (projects.nodes.length > 0) {
        filter.project = { id: { eq: projects.nodes[0].id } }
      }
    }

    const issues = await this.linearClient.linearClient.issues({
      filter,
      first: options.maxResults ?? 50,
    })

    const results: IssueTrackerIssue[] = []
    for (const issue of issues.nodes) {
      const state = await issue.state
      const team = await issue.team
      const project = await issue.project
      const labels = await issue.labels()
      const parent = await issue.parent

      results.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? undefined,
        url: issue.url,
        priority: issue.priority,
        status: state?.name,
        labels: await resolveSDKLabelNames(labels.nodes),
        teamName: team?.key,
        projectName: project?.name,
        parentId: parent?.id,
      })
    }

    return results
  }

  async getProjectRepositoryUrl(projectName: string): Promise<string | null> {
    const projects = await this.linearClient.linearClient.projects({
      filter: { name: { eqIgnoreCase: projectName } },
    })
    if (projects.nodes.length === 0) return null

    // Use the LinearAgentClient's method if available
    try {
      return await this.linearClient.getProjectRepositoryUrl(projects.nodes[0].id)
    } catch {
      return null
    }
  }

  createSession(config: SessionConfig): IssueTrackerSession {
    const session = createAgentSession({
      // Pass the LinearAgentClient wrapper, NOT its `.linearClient` getter
      // (the raw @linear/sdk client). AgentSession calls wrapper-only methods
      // like getIssue()/updateIssueStatus(); the raw SDK client only exposes
      // issue()/issues()/etc., so `.linearClient` here caused a runtime
      // "this.client.getIssue is not a function" crash on session start.
      client: this.linearClient,
      issueId: config.issueId,
      sessionId: config.sessionId,
      autoTransition: config.autoTransition ?? false,
    })
    return new LinearIssueTrackerSession(session)
  }

  buildCompletionComments(
    resultMessage: string,
    planItems: unknown[],
    sessionId: string | null
  ): CommentChunk[] {
    return buildCompletionComments(
      resultMessage,
      planItems as Array<{ state: string; title: string }>,
      sessionId
    )
  }
}

/**
 * Create the default Linear status mappings.
 * These map between Linear workflow statuses and agent work types.
 */
export function createLinearStatusMappings(): WorkTypeStatusMappings {
  return {
    statusToWorkType: STATUS_WORK_TYPE_MAP,
    workTypeStartStatus: WORK_TYPE_START_STATUS,
    workTypeCompleteStatus: WORK_TYPE_COMPLETE_STATUS,
    workTypeFailStatus: WORK_TYPE_FAIL_STATUS,
    terminalStatuses: TERMINAL_STATUSES,
    workTypesRequiringWorktree: WORK_TYPES_REQUIRING_WORKTREE,
  }
}
