/**
 * A2A (Agent-to-Agent) Client Provider
 *
 * Invokes external A2A-compliant agents over HTTP using the Google A2A protocol.
 * Uses JSON-RPC 2.0 for requests and SSE streaming for responses.
 *
 * A2A Protocol overview:
 *   - Agent discovery via GET /.well-known/agent-card.json
 *   - Task creation via POST /a2a with JSON-RPC method "message/send" or "message/stream"
 *   - Task lifecycle: submitted → working → completed/failed/canceled
 *   - Input-required is a paused state requesting user input
 *   - SSE events: TaskStatusUpdateEvent, TaskArtifactUpdateEvent
 *
 * Env vars:
 *   A2A_AGENT_URL           — base URL of the A2A agent (e.g., https://agent.example.com)
 *   A2A_AGENT_URL_{WORKTYPE} — work-type-specific override (e.g., A2A_AGENT_URL_RESEARCH)
 *   A2A_API_KEY             — API key for authentication (sent as x-api-key header)
 *   A2A_BEARER_TOKEN        — Bearer token for authentication (sent as Authorization header)
 */

import { randomUUID } from 'crypto'
import type {
  AgentProvider,
  AgentSpawnConfig,
  AgentHandle,
  AgentEvent,
} from './types.js'

// ---------------------------------------------------------------------------
// A2A Protocol Types
// ---------------------------------------------------------------------------

/** A2A message part: plain text */
export interface A2aTextPart {
  /** Part type discriminator */
  type: 'text'
  /** The text content */
  text: string
}

/** A2A message part: file (inline or by URI) */
export interface A2aFilePart {
  /** Part type discriminator */
  type: 'file'
  /** File metadata */
  file: {
    /** File name */
    name?: string
    /** MIME type */
    mimeType?: string
    /** Base64-encoded file content (mutually exclusive with uri) */
    bytes?: string
    /** URI to the file (mutually exclusive with bytes) */
    uri?: string
  }
}

/** A2A message part: structured data */
export interface A2aDataPart {
  /** Part type discriminator */
  type: 'data'
  /** Arbitrary structured data */
  data: Record<string, unknown>
}

/** Union of all A2A message part types */
export type A2aPart = A2aTextPart | A2aFilePart | A2aDataPart

/** A2A message with role and content parts */
export interface A2aMessage {
  /** The role of the message sender */
  role: 'user' | 'agent'
  /** Content parts of the message */
  parts: A2aPart[]
  /** Optional metadata */
  metadata?: Record<string, unknown>
}

/** Task status values in the A2A protocol */
export type A2aTaskStatus =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'

/** A2A task status object */
export interface A2aTaskStatusObject {
  /** Current task state */
  state: A2aTaskStatus
  /** Optional message associated with the status */
  message?: A2aMessage
  /** Timestamp of the status update */
  timestamp?: string
}

/** A2A artifact produced by the agent */
export interface A2aArtifact {
  /** Artifact name */
  name?: string
  /** Artifact description */
  description?: string
  /** Content parts of the artifact */
  parts: A2aPart[]
  /** Artifact index (for ordering) */
  index?: number
  /** Whether this is the last chunk of a streaming artifact */
  lastChunk?: boolean
  /** Optional metadata */
  metadata?: Record<string, unknown>
}

/** A2A task object */
export interface A2aTask {
  /** Task identifier */
  id: string
  /** Session identifier for multi-turn conversations */
  sessionId?: string
  /** Current task status */
  status: A2aTaskStatusObject
  /** Messages exchanged in the task */
  messages?: A2aMessage[]
  /** Artifacts produced by the agent */
  artifacts?: A2aArtifact[]
  /** Optional metadata */
  metadata?: Record<string, unknown>
}

/** SSE event: task status update */
export interface A2aTaskStatusUpdateEvent {
  /** Event type discriminator */
  type: 'TaskStatusUpdate'
  /** Task ID */
  id: string
  /** Session ID */
  sessionId?: string
  /** Updated status */
  status: A2aTaskStatusObject
  /** Whether this is the final event */
  final?: boolean
}

/** SSE event: task artifact update */
export interface A2aTaskArtifactUpdateEvent {
  /** Event type discriminator */
  type: 'TaskArtifactUpdate'
  /** Task ID */
  id: string
  /** Session ID */
  sessionId?: string
  /** The artifact being updated */
  artifact: A2aArtifact
}

/** Union of all A2A SSE task event types */
export type A2aTaskEvent = A2aTaskStatusUpdateEvent | A2aTaskArtifactUpdateEvent

/**
 * A2A Agent Card — describes the agent's capabilities and metadata.
 * Fetched from GET {baseUrl}/.well-known/agent-card.json
 */
export interface A2aAgentCard {
  /** Agent name */
  name: string
  /** Human-readable description */
  description?: string
  /** Base URL of the agent */
  url: string
  /** Agent version */
  version?: string
  /** Skills the agent supports */
  skills?: A2aAgentSkill[]
  /** Authentication schemes supported */
  authSchemes?: A2aAuthScheme[]
  /** Agent capabilities */
  capabilities?: A2aAgentCapabilities
  /** Optional metadata */
  metadata?: Record<string, unknown>
}

/** A2A agent skill descriptor */
export interface A2aAgentSkill {
  /** Skill identifier */
  id: string
  /** Human-readable name */
  name: string
  /** Description of the skill */
  description?: string
  /** Input content types */
  inputContentTypes?: string[]
  /** Output content types */
  outputContentTypes?: string[]
}

/** A2A authentication scheme */
export interface A2aAuthScheme {
  /** Auth scheme type (e.g., "apiKey", "bearer", "oauth2") */
  type: string
  /** Additional scheme-specific configuration */
  [key: string]: unknown
}

/** A2A agent capabilities */
export interface A2aAgentCapabilities {
  /** Whether the agent supports SSE streaming */
  streaming?: boolean
  /** Whether the agent supports push notifications */
  pushNotifications?: boolean
  /** Whether the agent supports multi-turn conversations */
  multiTurn?: boolean
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 Types
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 request */
export interface A2aJsonRpcRequest {
  /** JSON-RPC version — always "2.0" */
  jsonrpc: '2.0'
  /** Request identifier */
  id: string
  /** Method name */
  method: string
  /** Method parameters */
  params: Record<string, unknown>
}

/** JSON-RPC 2.0 success response */
export interface A2aJsonRpcResponse {
  /** JSON-RPC version — always "2.0" */
  jsonrpc: '2.0'
  /** Request identifier (matches request) */
  id: string
  /** Result payload */
  result?: unknown
  /** Error payload */
  error?: A2aJsonRpcError
}

/** JSON-RPC 2.0 error object */
export interface A2aJsonRpcError {
  /** Error code */
  code: number
  /** Error message */
  message: string
  /** Optional error data */
  data?: unknown
}

// ---------------------------------------------------------------------------
// Agent Card Discovery
// ---------------------------------------------------------------------------

/**
 * Fetch and parse the A2A Agent Card from the well-known endpoint.
 *
 * @param baseUrl - Base URL of the A2A agent (e.g., "https://agent.example.com")
 * @returns Parsed agent card
 * @throws Error if the fetch fails or the response is not valid JSON
 */
export async function fetchAgentCard(baseUrl: string): Promise<A2aAgentCard> {
  const url = `${baseUrl.replace(/\/+$/, '')}/.well-known/agent-card.json`

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  })

  if (!response.ok) {
    throw new Error(
      `Failed to fetch A2A agent card from ${url}: ${response.status} ${response.statusText}`
    )
  }

  const card = (await response.json()) as A2aAgentCard

  if (!card.name || !card.url) {
    throw new Error(
      `Invalid A2A agent card from ${url}: missing required fields "name" and/or "url"`
    )
  }

  return card
}

// ---------------------------------------------------------------------------
// Event Mapping (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Mutable state tracked across A2A task events for a single session.
 * Passed into mapA2aTaskEvent to accumulate session-level data.
 */
export interface A2aEventMapperState {
  /** Session ID from the A2A task */
  sessionId: string | null
  /** Task ID from the A2A task */
  taskId: string | null
  /** Accumulated input tokens */
  totalInputTokens: number
  /** Accumulated output tokens */
  totalOutputTokens: number
  /** Number of turns/interactions */
  turnCount: number
}

/**
 * Extract text content from an array of A2A parts.
 * Concatenates all text parts, includes data parts as JSON, and notes file parts.
 */
function extractTextFromParts(parts: A2aPart[]): string {
  const texts: string[] = []

  for (const part of parts) {
    switch (part.type) {
      case 'text':
        texts.push(part.text)
        break
      case 'data':
        texts.push(JSON.stringify(part.data))
        break
      case 'file':
        texts.push(`[File: ${part.file.name ?? part.file.uri ?? 'unnamed'}]`)
        break
    }
  }

  return texts.join('\n')
}

/**
 * Map a single A2A task event to one or more normalized AgentEvents.
 * Exported for unit testing — the AgentHandle uses this internally.
 *
 * @param event - The A2A SSE task event
 * @param state - Mutable state accumulator for the session
 * @returns Array of normalized AgentEvent objects
 */
export function mapA2aTaskEvent(
  event: A2aTaskEvent,
  state: A2aEventMapperState,
): AgentEvent[] {
  switch (event.type) {
    case 'TaskStatusUpdate': {
      // Track task and session IDs
      if (event.id && !state.taskId) {
        state.taskId = event.id
      }
      if (event.sessionId && !state.sessionId) {
        state.sessionId = event.sessionId
      }

      const status = event.status

      switch (status.state) {
        case 'submitted': {
          // Task has been created — emit init event
          const sessionId = event.sessionId ?? event.id
          state.sessionId = sessionId
          state.taskId = event.id
          return [{
            type: 'init',
            sessionId,
            raw: event,
          }]
        }

        case 'working': {
          state.turnCount++
          const events: AgentEvent[] = []

          // If there is a message with the status, emit the text
          if (status.message && status.message.parts.length > 0) {
            const text = extractTextFromParts(status.message.parts)
            if (text) {
              events.push({
                type: 'assistant_text',
                text,
                raw: event,
              })
            }
          }

          // If no message content, emit a system event noting work is in progress
          if (events.length === 0) {
            events.push({
              type: 'system',
              subtype: 'working',
              message: `Task ${event.id} is working (turn ${state.turnCount})`,
              raw: event,
            })
          }

          return events
        }

        case 'input-required': {
          const message = status.message
            ? extractTextFromParts(status.message.parts)
            : 'Agent requires additional input'

          return [{
            type: 'system',
            subtype: 'input_required',
            message,
            raw: event,
          }]
        }

        case 'completed': {
          const message = status.message
            ? extractTextFromParts(status.message.parts)
            : undefined

          return [{
            type: 'result',
            success: true,
            message,
            cost: {
              inputTokens: state.totalInputTokens || undefined,
              outputTokens: state.totalOutputTokens || undefined,
              numTurns: state.turnCount || undefined,
            },
            raw: event,
          }]
        }

        case 'failed': {
          const errorMessage = status.message
            ? extractTextFromParts(status.message.parts)
            : 'Task failed'

          return [{
            type: 'result',
            success: false,
            errors: [errorMessage],
            errorSubtype: 'task_failed',
            raw: event,
          }]
        }

        case 'canceled': {
          const cancelMessage = status.message
            ? extractTextFromParts(status.message.parts)
            : 'Task canceled'

          return [{
            type: 'result',
            success: false,
            errors: [cancelMessage],
            errorSubtype: 'canceled',
            raw: event,
          }]
        }

        default:
          return [{
            type: 'system',
            subtype: 'unknown',
            message: `Unknown A2A task status: ${(status as { state: string }).state}`,
            raw: event,
          }]
      }
    }

    case 'TaskArtifactUpdate': {
      // Track task and session IDs
      if (event.id && !state.taskId) {
        state.taskId = event.id
      }
      if (event.sessionId && !state.sessionId) {
        state.sessionId = event.sessionId
      }

      const artifact = event.artifact
      const text = extractTextFromParts(artifact.parts)

      return [{
        type: 'assistant_text',
        text: text || `[Artifact: ${artifact.name ?? 'unnamed'}]`,
        raw: event,
      }]
    }

    default:
      return [{
        type: 'system',
        subtype: 'unknown',
        message: `Unhandled A2A event type: ${(event as { type: string }).type}`,
        raw: event,
      }]
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class A2aProvider implements AgentProvider {
  readonly name = 'a2a' as const
  readonly capabilities = {
    supportsMessageInjection: true,
    supportsSessionResume: true,
    supportsToolPlugins: false,
    needsBaseInstructions: false,
    needsPermissionConfig: false,
    supportsCodeIntelligenceEnforcement: false,
    emitsSubagentEvents: false,
    // A2A is a remote-agent transport; the local dispatch path
    // doesn't translate reasoning-effort hints to a peer-side knob today.
    supportsReasoningEffort: false,
    humanLabel: 'A2A',
  } as const

  spawn(config: AgentSpawnConfig): AgentHandle {
    return this.createHandle(config)
  }

  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle {
    return this.createHandle(config, sessionId)
  }

  private createHandle(config: AgentSpawnConfig, resumeSessionId?: string): AgentHandle {
    const abortController = config.abortController

    // Resolve the A2A agent URL — check work-type-specific env vars first
    const agentUrl = resolveAgentUrl(config.env)
    if (!agentUrl) {
      return new A2aAgentHandle({
        agentUrl: '',
        abortController,
        initError: 'A2A_AGENT_URL environment variable is not set. ' +
          'Set A2A_AGENT_URL or A2A_AGENT_URL_{WORKTYPE} to the base URL of the A2A agent.',
      })
    }

    // Resolve authentication headers
    const authHeaders = resolveAuthHeaders(config.env)

    // Build the initial JSON-RPC params
    const messageParams: Record<string, unknown> = {
      message: {
        role: 'user',
        parts: [{ type: 'text', text: config.prompt }],
      } satisfies A2aMessage,
    }

    // If resuming, include the existing session/task ID
    if (resumeSessionId) {
      messageParams.sessionId = resumeSessionId
    }

    return new A2aAgentHandle({
      agentUrl,
      abortController,
      authHeaders,
      initialParams: messageParams,
      resumeSessionId: resumeSessionId ?? null,
    })
  }
}

// ---------------------------------------------------------------------------
// AgentHandle implementation
// ---------------------------------------------------------------------------

interface A2aAgentHandleOptions {
  agentUrl: string
  abortController: AbortController
  authHeaders?: Record<string, string>
  initialParams?: Record<string, unknown>
  resumeSessionId?: string | null
  initError?: string
}

class A2aAgentHandle implements AgentHandle {
  sessionId: string | null = null
  private readonly agentUrl: string
  private readonly abortController: AbortController
  private readonly authHeaders: Record<string, string>
  private readonly initialParams?: Record<string, unknown>
  private readonly initError?: string
  private readonly mapperState: A2aEventMapperState = {
    sessionId: null,
    taskId: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turnCount: 0,
  }

  constructor(options: A2aAgentHandleOptions) {
    this.agentUrl = options.agentUrl
    this.abortController = options.abortController
    this.authHeaders = options.authHeaders ?? {}
    this.initialParams = options.initialParams
    this.initError = options.initError

    if (options.resumeSessionId) {
      this.sessionId = options.resumeSessionId
      this.mapperState.sessionId = options.resumeSessionId
    }
  }

  get stream(): AsyncIterable<AgentEvent> {
    return this.createEventStream()
  }

  async injectMessage(text: string): Promise<void> {
    const params: Record<string, unknown> = {
      message: {
        role: 'user',
        parts: [{ type: 'text', text }],
      } satisfies A2aMessage,
    }

    // Include session/task IDs if we have them
    if (this.mapperState.sessionId) {
      params.sessionId = this.mapperState.sessionId
    }
    if (this.mapperState.taskId) {
      params.taskId = this.mapperState.taskId
    }

    await this.sendJsonRpc('message/send', params)
  }

  async stop(): Promise<void> {
    // Send cancel request if we have a task ID
    if (this.mapperState.taskId) {
      try {
        await this.sendJsonRpc('tasks/cancel', {
          id: this.mapperState.taskId,
        })
      } catch {
        // Best-effort cancellation — ignore errors
      }
    }

    this.abortController.abort()
  }

  /**
   * Send a JSON-RPC 2.0 request to the A2A agent endpoint.
   */
  private async sendJsonRpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Response> {
    const rpcUrl = `${this.agentUrl.replace(/\/+$/, '')}/a2a`

    const request: A2aJsonRpcRequest = {
      jsonrpc: '2.0',
      id: randomUUID(),
      method,
      params,
    }

    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream, application/json',
        ...this.authHeaders,
      },
      body: JSON.stringify(request),
      signal: this.abortController.signal,
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(
        `A2A JSON-RPC request failed: ${response.status} ${response.statusText}` +
        (body ? ` — ${body}` : '')
      )
    }

    return response
  }

  /**
   * Create the async event stream by sending the initial request and parsing
   * either SSE (for message/stream) or JSON (for message/send) response.
   */
  private async *createEventStream(): AsyncGenerator<AgentEvent> {
    // Handle init-time errors (e.g., missing agent URL)
    if (this.initError) {
      yield {
        type: 'error',
        message: this.initError,
        raw: null,
      }
      yield {
        type: 'result',
        success: false,
        errors: [this.initError],
        errorSubtype: 'configuration_error',
        raw: null,
      }
      return
    }

    if (!this.initialParams) {
      yield {
        type: 'error',
        message: 'No initial message params configured',
        raw: null,
      }
      return
    }

    let response: Response
    let useStreaming = true

    try {
      // Try streaming first (message/stream)
      response = await this.sendJsonRpc('message/stream', this.initialParams)
    } catch (err) {
      if (this.abortController.signal.aborted) {
        yield {
          type: 'result',
          success: false,
          errors: ['Request aborted'],
          errorSubtype: 'aborted',
          raw: null,
        }
        return
      }

      // Fall back to non-streaming (message/send)
      try {
        response = await this.sendJsonRpc('message/send', this.initialParams)
        useStreaming = false
      } catch (sendErr) {
        if (this.abortController.signal.aborted) {
          yield {
            type: 'result',
            success: false,
            errors: ['Request aborted'],
            errorSubtype: 'aborted',
            raw: null,
          }
          return
        }

        const errorMessage = sendErr instanceof Error
          ? sendErr.message
          : 'Failed to connect to A2A agent'

        yield {
          type: 'error',
          message: errorMessage,
          raw: sendErr,
        }
        yield {
          type: 'result',
          success: false,
          errors: [errorMessage],
          errorSubtype: 'connection_error',
          raw: null,
        }
        return
      }
    }

    const contentType = response.headers.get('content-type') ?? ''

    if (useStreaming && contentType.includes('text/event-stream')) {
      // Parse SSE stream
      yield* this.parseSSEStream(response)
    } else {
      // Parse single JSON response
      yield* this.parseSingleResponse(response)
    }
  }

  /**
   * Parse an SSE event stream from the response body.
   * Each SSE event has an optional `event:` field and a `data:` field with JSON.
   */
  private async *parseSSEStream(response: Response): AsyncGenerator<AgentEvent> {
    const body = response.body
    if (!body) {
      yield {
        type: 'error',
        message: 'A2A response has no body',
        raw: null,
      }
      return
    }

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEventType = ''
    let currentData = ''
    let hasResult = false

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process complete lines
        const lines = buffer.split('\n')
        // Keep the last potentially incomplete line in the buffer
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEventType = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            currentData = line.slice(5).trim()
          } else if (line === '' && currentData) {
            // Empty line signals end of SSE event
            let taskEvent: A2aTaskEvent
            try {
              const parsed = JSON.parse(currentData) as Record<string, unknown>
              // Use the event type from the SSE `event:` field if present,
              // otherwise use the `type` field from the JSON data
              if (currentEventType) {
                parsed.type = currentEventType
              }
              taskEvent = parsed as unknown as A2aTaskEvent
            } catch {
              // Non-JSON SSE data — emit as system event
              yield {
                type: 'system',
                subtype: 'raw_output',
                message: currentData,
                raw: currentData,
              }
              currentEventType = ''
              currentData = ''
              continue
            }

            const mapped = mapA2aTaskEvent(taskEvent, this.mapperState)
            for (const agentEvent of mapped) {
              if (agentEvent.type === 'init') {
                this.sessionId = this.mapperState.sessionId
              }
              if (agentEvent.type === 'result') {
                hasResult = true
              }
              yield agentEvent
            }

            currentEventType = ''
            currentData = ''
          }
        }
      }

      // Process any remaining data in the buffer
      if (currentData) {
        try {
          const parsed = JSON.parse(currentData) as Record<string, unknown>
          if (currentEventType) {
            parsed.type = currentEventType
          }
          const taskEvent = parsed as unknown as A2aTaskEvent

          const mapped = mapA2aTaskEvent(taskEvent, this.mapperState)
          for (const agentEvent of mapped) {
            if (agentEvent.type === 'init') {
              this.sessionId = this.mapperState.sessionId
            }
            if (agentEvent.type === 'result') {
              hasResult = true
            }
            yield agentEvent
          }
        } catch {
          // Ignore trailing non-JSON data
        }
      }
    } catch (err) {
      if (this.abortController.signal.aborted) {
        if (!hasResult) {
          yield {
            type: 'result',
            success: false,
            errors: ['Stream aborted'],
            errorSubtype: 'aborted',
            raw: null,
          }
        }
        return
      }

      const errorMessage = err instanceof Error ? err.message : 'SSE stream error'
      yield {
        type: 'error',
        message: errorMessage,
        raw: err,
      }
      if (!hasResult) {
        yield {
          type: 'result',
          success: false,
          errors: [errorMessage],
          errorSubtype: 'stream_error',
          raw: null,
        }
      }
    } finally {
      reader.releaseLock()
    }

    // If we never got a result event, synthesize a success (stream ended cleanly)
    if (!hasResult) {
      yield {
        type: 'result',
        success: true,
        cost: {
          inputTokens: this.mapperState.totalInputTokens || undefined,
          outputTokens: this.mapperState.totalOutputTokens || undefined,
          numTurns: this.mapperState.turnCount || undefined,
        },
        raw: { streamEnded: true },
      }
    }
  }

  /**
   * Parse a single JSON response (non-streaming message/send).
   * The response contains a complete A2A Task object.
   */
  private async *parseSingleResponse(response: Response): AsyncGenerator<AgentEvent> {
    let body: string
    try {
      body = await response.text()
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to read response body'
      yield {
        type: 'error',
        message: errorMessage,
        raw: err,
      }
      yield {
        type: 'result',
        success: false,
        errors: [errorMessage],
        errorSubtype: 'response_error',
        raw: null,
      }
      return
    }

    let rpcResponse: A2aJsonRpcResponse
    try {
      rpcResponse = JSON.parse(body) as A2aJsonRpcResponse
    } catch {
      yield {
        type: 'error',
        message: `Invalid JSON response from A2A agent: ${body.slice(0, 200)}`,
        raw: body,
      }
      yield {
        type: 'result',
        success: false,
        errors: ['Invalid JSON response from A2A agent'],
        errorSubtype: 'parse_error',
        raw: null,
      }
      return
    }

    // Check for JSON-RPC error
    if (rpcResponse.error) {
      yield {
        type: 'error',
        message: rpcResponse.error.message,
        code: String(rpcResponse.error.code),
        raw: rpcResponse.error,
      }
      yield {
        type: 'result',
        success: false,
        errors: [rpcResponse.error.message],
        errorSubtype: 'jsonrpc_error',
        raw: rpcResponse,
      }
      return
    }

    // Parse the result as an A2A Task
    const task = rpcResponse.result as A2aTask | undefined
    if (!task) {
      yield {
        type: 'error',
        message: 'A2A response has no result',
        raw: rpcResponse,
      }
      yield {
        type: 'result',
        success: false,
        errors: ['A2A response has no result'],
        errorSubtype: 'empty_result',
        raw: rpcResponse,
      }
      return
    }

    // Set session/task IDs
    this.mapperState.taskId = task.id
    this.mapperState.sessionId = task.sessionId ?? task.id
    this.sessionId = this.mapperState.sessionId

    // Emit init event
    yield {
      type: 'init',
      sessionId: this.mapperState.sessionId!,
      raw: task,
    }

    // Emit artifact text if present
    if (task.artifacts) {
      for (const artifact of task.artifacts) {
        const text = extractTextFromParts(artifact.parts)
        if (text) {
          yield {
            type: 'assistant_text',
            text,
            raw: artifact,
          }
        }
      }
    }

    // Emit status message text if present
    if (task.status.message && task.status.message.parts.length > 0) {
      const statusText = extractTextFromParts(task.status.message.parts)
      if (statusText) {
        yield {
          type: 'assistant_text',
          text: statusText,
          raw: task.status,
        }
      }
    }

    // Emit final result based on task status
    switch (task.status.state) {
      case 'completed':
        yield {
          type: 'result',
          success: true,
          message: task.artifacts
            ? extractTextFromParts(task.artifacts[task.artifacts.length - 1].parts)
            : undefined,
          cost: {
            inputTokens: this.mapperState.totalInputTokens || undefined,
            outputTokens: this.mapperState.totalOutputTokens || undefined,
            numTurns: this.mapperState.turnCount || undefined,
          },
          raw: task,
        }
        break

      case 'failed':
        yield {
          type: 'result',
          success: false,
          errors: [task.status.message
            ? extractTextFromParts(task.status.message.parts)
            : 'Task failed'],
          errorSubtype: 'task_failed',
          raw: task,
        }
        break

      case 'canceled':
        yield {
          type: 'result',
          success: false,
          errors: [task.status.message
            ? extractTextFromParts(task.status.message.parts)
            : 'Task canceled'],
          errorSubtype: 'canceled',
          raw: task,
        }
        break

      case 'input-required':
        yield {
          type: 'system',
          subtype: 'input_required',
          message: task.status.message
            ? extractTextFromParts(task.status.message.parts)
            : 'Agent requires additional input',
          raw: task,
        }
        break

      default:
        // For submitted/working states, emit as system event
        yield {
          type: 'result',
          success: true,
          cost: {
            inputTokens: this.mapperState.totalInputTokens || undefined,
            outputTokens: this.mapperState.totalOutputTokens || undefined,
            numTurns: this.mapperState.turnCount || undefined,
          },
          raw: task,
        }
        break
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the A2A agent URL from environment variables.
 * Checks work-type-specific overrides first, then falls back to the base URL.
 *
 * Resolution order:
 *   1. A2A_AGENT_URL_{WORKTYPE} from config.env
 *   2. A2A_AGENT_URL from config.env
 *   3. A2A_AGENT_URL_{WORKTYPE} from process.env
 *   4. A2A_AGENT_URL from process.env
 */
function resolveAgentUrl(env: Record<string, string>): string | undefined {
  // Check for work-type-specific URL in config env
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('A2A_AGENT_URL_') && value) {
      return value
    }
  }

  // Check base URL in config env
  if (env.A2A_AGENT_URL) {
    return env.A2A_AGENT_URL
  }

  // Check process.env for work-type-specific
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('A2A_AGENT_URL_') && value) {
      return value
    }
  }

  // Check process.env base URL
  return process.env.A2A_AGENT_URL
}

/**
 * Resolve authentication headers from environment variables.
 * Supports API key and bearer token authentication.
 */
function resolveAuthHeaders(env: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {}

  // API key auth
  const apiKey = env.A2A_API_KEY || process.env.A2A_API_KEY
  if (apiKey) {
    headers['x-api-key'] = apiKey
  }

  // Bearer token auth
  const bearerToken = env.A2A_BEARER_TOKEN || process.env.A2A_BEARER_TOKEN
  if (bearerToken) {
    headers['Authorization'] = `Bearer ${bearerToken}`
  }

  return headers
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new A2A provider instance.
 */
export function createA2aProvider(): A2aProvider {
  return new A2aProvider()
}
