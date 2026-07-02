/**
 * A2A Callback Bridge
 *
 * Bridges external A2A requests into the AgentFactory work queue.
 * Implements the three A2A server callbacks:
 *
 * 1. onSendMessage — creates a QueuedWork item from an A2A message
 * 2. onGetTask    — maps A2A task ID → session → current status
 * 3. onCancelTask — cancels the running session for an A2A task
 *
 * Uses a simple in-memory bidirectional map for A2A task ID ↔ session ID.
 * The platform layer will replace this with persistent storage.
 */

import { randomUUID } from 'crypto'
import { queueWork } from './work-queue.js'
import { getSessionState, updateSessionStatus } from './session-storage.js'
import type { AgentSessionStatus } from './session-storage.js'
import type { QueuedWork } from './work-queue.js'
import type {
  A2aTask,
  A2aTaskStatus,
  A2aMessage,
} from './a2a-types.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[a2a-bridge] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[a2a-bridge] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[a2a-bridge] ${msg}`, data ? JSON.stringify(data) : ''),
}

// ---------------------------------------------------------------------------
// Task ID ↔ Session ID mapping (in-memory for OSS)
// ---------------------------------------------------------------------------

/**
 * Bidirectional map between A2A task IDs and AgentFactory session IDs.
 *
 * In-memory for OSS — platform replaces with persistent storage.
 */
export class A2aTaskMap {
  private taskToSession = new Map<string, string>()
  private sessionToTask = new Map<string, string>()
  private taskMessages = new Map<string, A2aMessage[]>()

  /** Create a mapping and return the generated A2A task ID */
  create(sessionId: string): string {
    // Check if session already has a task ID
    const existing = this.sessionToTask.get(sessionId)
    if (existing) return existing

    const taskId = `a2a-${randomUUID()}`
    this.taskToSession.set(taskId, sessionId)
    this.sessionToTask.set(sessionId, taskId)
    this.taskMessages.set(taskId, [])
    return taskId
  }

  /** Get session ID for a task */
  getSessionId(taskId: string): string | undefined {
    return this.taskToSession.get(taskId)
  }

  /** Get task ID for a session */
  getTaskId(sessionId: string): string | undefined {
    return this.sessionToTask.get(sessionId)
  }

  /** Store a message associated with a task */
  addMessage(taskId: string, message: A2aMessage): void {
    const messages = this.taskMessages.get(taskId) ?? []
    messages.push(message)
    this.taskMessages.set(taskId, messages)
  }

  /** Get all messages for a task */
  getMessages(taskId: string): A2aMessage[] {
    return this.taskMessages.get(taskId) ?? []
  }

  /** Remove a mapping */
  delete(taskId: string): void {
    const sessionId = this.taskToSession.get(taskId)
    if (sessionId) {
      this.sessionToTask.delete(sessionId)
    }
    this.taskToSession.delete(taskId)
    this.taskMessages.delete(taskId)
  }

  /** Get the number of tracked tasks (for monitoring) */
  get size(): number {
    return this.taskToSession.size
  }
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Map AgentFactory session status to A2A task status.
 *
 * AgentFactory statuses: pending, claimed, running, finalizing, completed, failed, stopped, timed_out
 * A2A statuses: submitted, working, input-required, completed, failed, canceled
 */
export function mapSessionStatusToA2a(status: AgentSessionStatus): A2aTaskStatus {
  switch (status) {
    case 'pending':
    case 'claimed':
      return 'submitted'
    case 'running':
    case 'finalizing':
      return 'working'
    case 'completed':
      return 'completed'
    case 'failed':
    case 'timed_out':
      return 'failed'
    case 'stopped':
      return 'canceled'
    default:
      return 'failed'
  }
}

// ---------------------------------------------------------------------------
// Bridge configuration
// ---------------------------------------------------------------------------

export interface A2aCallbackBridgeConfig {
  /**
   * Default issue ID to use for A2A-created work items.
   * In OSS mode, A2A messages don't have a corresponding Linear issue,
   * so we use a synthetic ID.
   */
  defaultIssueId?: string

  /**
   * Default issue identifier prefix for A2A-created work items.
   */
  defaultIssueIdentifier?: string

  /**
   * Default priority for A2A-created work items (1-5, lower = higher priority).
   * Defaults to 3.
   */
  defaultPriority?: number

  /**
   * Default project name for work queue routing.
   */
  projectName?: string
}

// ---------------------------------------------------------------------------
// Bridge factory
// ---------------------------------------------------------------------------

/**
 * Create A2A callback bridge functions that connect A2A protocol
 * operations to the AgentFactory work queue and session management.
 *
 * @param taskMap - Bidirectional task ID mapping (shared with SSE streaming)
 * @param config - Optional bridge configuration
 * @returns A2A handler callbacks ready for `createA2aRequestHandler`
 */
export function createA2aCallbackBridge(
  taskMap: A2aTaskMap,
  config: A2aCallbackBridgeConfig = {},
) {
  const {
    defaultIssueId = 'a2a-external',
    defaultIssueIdentifier = 'A2A',
    defaultPriority = 3,
    projectName,
  } = config

  /**
   * Handle an incoming A2A message by creating a work queue item.
   *
   * Extracts text from message parts to build a prompt string,
   * creates a QueuedWork item, and enqueues it.
   */
  async function onSendMessage(message: A2aMessage, taskId?: string): Promise<A2aTask> {
    // Extract text from message parts to use as prompt
    const textParts = message.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
    const prompt = textParts.join('\n') || 'A2A task request'

    let resolvedTaskId: string

    if (taskId) {
      // Follow-up message to existing task
      const sessionId = taskMap.getSessionId(taskId)
      if (!sessionId) {
        throw new Error(`Task not found: ${taskId}`)
      }
      resolvedTaskId = taskId
      taskMap.addMessage(taskId, message)
    } else {
      // New task — create session and queue work
      const sessionId = `a2a-session-${randomUUID()}`
      resolvedTaskId = taskMap.create(sessionId)

      const work: QueuedWork = {
        sessionId,
        issueId: defaultIssueId,
        issueIdentifier: `${defaultIssueIdentifier}-${resolvedTaskId.slice(4, 12)}`,
        priority: defaultPriority,
        queuedAt: Date.now(),
        prompt,
        workType: 'development',
        ...(projectName && { projectName }),
      }

      const queued = await queueWork(work)
      if (!queued) {
        throw new Error('Failed to queue work item')
      }

      taskMap.addMessage(resolvedTaskId, message)

      log.info('A2A task created', {
        taskId: resolvedTaskId,
        sessionId,
        promptLength: prompt.length,
      })
    }

    // Build the A2A task response
    const messages = taskMap.getMessages(resolvedTaskId)

    return {
      id: resolvedTaskId,
      status: 'submitted',
      messages,
      artifacts: [],
    }
  }

  /**
   * Retrieve the current state of an A2A task.
   *
   * Maps the task ID to a session ID, fetches the session state,
   * and converts the AgentFactory status to an A2A status.
   */
  async function onGetTask(taskId: string): Promise<A2aTask | null> {
    const sessionId = taskMap.getSessionId(taskId)
    if (!sessionId) {
      return null
    }

    const session = await getSessionState(sessionId)
    const messages = taskMap.getMessages(taskId)

    // If no session state found (maybe Redis is not configured),
    // return with the last known status
    const a2aStatus: A2aTaskStatus = session
      ? mapSessionStatusToA2a(session.status)
      : 'submitted'

    return {
      id: taskId,
      status: a2aStatus,
      messages,
      artifacts: [],
    }
  }

  /**
   * Cancel a running A2A task.
   *
   * Maps the task ID to a session ID and updates the session
   * status to 'stopped'.
   */
  async function onCancelTask(taskId: string): Promise<A2aTask | null> {
    const sessionId = taskMap.getSessionId(taskId)
    if (!sessionId) {
      return null
    }

    const session = await getSessionState(sessionId)
    if (session) {
      // Cannot cancel already-completed tasks
      if (session.status === 'completed' || session.status === 'failed' || session.status === 'timed_out') {
        throw new Error(`Cannot cancel task in ${session.status} state`)
      }

      await updateSessionStatus(sessionId, 'stopped')
    }

    const messages = taskMap.getMessages(taskId)

    log.info('A2A task canceled', { taskId, sessionId })

    return {
      id: taskId,
      status: 'canceled',
      messages,
      artifacts: [],
    }
  }

  return {
    onSendMessage,
    onGetTask,
    onCancelTask,
  }
}
