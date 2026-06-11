/**
 * Spring AI Agent Provider
 *
 * Spawns a Spring AI agent JAR as a child process and parses its JSONL event
 * stream into normalized AgentEvents.
 *
 * CLI invocation patterns:
 *   New session:  java -jar <JAR> --prompt "<prompt>" --cwd <cwd> --json
 *   Resume:       java -jar <JAR> --resume <sessionId> --prompt "<prompt>" --cwd <cwd> --json
 *
 * JSONL event types:
 *   session.started   → init (sessionId)
 *   turn.started      → system (turn_started)
 *   turn.completed    → result (success, usage)
 *   turn.failed       → result (failure)
 *   tool.invocation   → tool_use
 *   tool.result       → tool_result
 *   assistant.message  → assistant_text
 *   error             → error
 */

import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import type {
  AgentProvider,
  AgentSpawnConfig,
  AgentHandle,
  AgentEvent,
} from './types.js'

// ---------------------------------------------------------------------------
// Spring AI JSONL event types
// ---------------------------------------------------------------------------

interface SpringAiSessionStarted {
  type: 'session.started'
  session_id: string
}

interface SpringAiTurnStarted {
  type: 'turn.started'
}

interface SpringAiTurnCompleted {
  type: 'turn.completed'
  usage?: {
    input_tokens?: number
    output_tokens?: number
    model?: string
  }
}

interface SpringAiTurnFailed {
  type: 'turn.failed'
  error?: { message?: string; code?: string }
}

interface SpringAiAssistantMessage {
  type: 'assistant.message'
  id?: string
  text: string
}

interface SpringAiToolInvocation {
  type: 'tool.invocation'
  id: string
  tool_name: string
  input: Record<string, unknown>
}

interface SpringAiToolResult {
  type: 'tool.result'
  id: string
  tool_name?: string
  content: string
  is_error: boolean
}

interface SpringAiErrorEvent {
  type: 'error'
  message?: string
  code?: string
}

export type SpringAiEvent =
  | SpringAiSessionStarted
  | SpringAiTurnStarted
  | SpringAiTurnCompleted
  | SpringAiTurnFailed
  | SpringAiAssistantMessage
  | SpringAiToolInvocation
  | SpringAiToolResult
  | SpringAiErrorEvent

// ---------------------------------------------------------------------------
// Event Mapping (exported for unit testing)
// ---------------------------------------------------------------------------

export interface SpringAiEventMapperState {
  sessionId: string | null
  totalInputTokens: number
  totalOutputTokens: number
  turnCount: number
}

/**
 * Map a single Spring AI JSONL event to one or more normalized AgentEvents.
 * Exported for unit testing — the AgentHandle uses this internally.
 */
export function mapSpringAiEvent(
  event: SpringAiEvent,
  state: SpringAiEventMapperState,
): AgentEvent[] {
  switch (event.type) {
    case 'session.started':
      state.sessionId = event.session_id
      return [{
        type: 'init',
        sessionId: event.session_id,
        raw: event,
      }]

    case 'turn.started':
      state.turnCount++
      return [{
        type: 'system',
        subtype: 'turn_started',
        message: `Turn ${state.turnCount} started`,
        raw: event,
      }]

    case 'turn.completed':
      if (event.usage) {
        state.totalInputTokens += event.usage.input_tokens ?? 0
        state.totalOutputTokens += event.usage.output_tokens ?? 0
      }
      return [{
        type: 'result',
        success: true,
        cost: {
          inputTokens: state.totalInputTokens || undefined,
          outputTokens: state.totalOutputTokens || undefined,
          numTurns: state.turnCount || undefined,
        },
        raw: event,
      }]

    case 'turn.failed':
      return [{
        type: 'result',
        success: false,
        errors: [event.error?.message ?? 'Turn failed'],
        errorSubtype: 'turn_failed',
        raw: event,
      }]

    case 'assistant.message':
      return [{
        type: 'assistant_text',
        text: event.text,
        raw: event,
      }]

    case 'tool.invocation':
      return [{
        type: 'tool_use',
        toolName: event.tool_name,
        toolUseId: event.id,
        input: event.input,
        raw: event,
      }]

    case 'tool.result':
      return [{
        type: 'tool_result',
        toolName: event.tool_name,
        toolUseId: event.id,
        content: event.content,
        isError: event.is_error,
        raw: event,
      }]

    case 'error':
      return [{
        type: 'error',
        message: event.message ?? 'Unknown error',
        code: event.code,
        raw: event,
      }]

    default:
      return [{
        type: 'system',
        subtype: 'unknown',
        message: `Unhandled Spring AI event type: ${(event as { type: string }).type}`,
        raw: event,
      }]
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class SpringAiProvider implements AgentProvider {
  readonly name = 'spring-ai' as const
  readonly capabilities = {
    supportsMessageInjection: false,
    supportsSessionResume: true,
    supportsToolPlugins: false,
    needsBaseInstructions: false,
    needsPermissionConfig: false,
    supportsCodeIntelligenceEnforcement: false,
    toolPermissionFormat: 'spring-ai' as const,
    emitsSubagentEvents: false,
    // Spring AI has no per-step reasoning-effort knob; the
    // dispatch path will drop the value and emit a Layer-6 warning.
    supportsReasoningEffort: false,
    humanLabel: 'Spring AI',
  } as const

  spawn(config: AgentSpawnConfig): AgentHandle {
    return this.createHandle(config)
  }

  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle {
    return this.createHandle(config, sessionId)
  }

  private createHandle(config: AgentSpawnConfig, resumeSessionId?: string): AgentHandle {
    const abortController = config.abortController

    // Resolve Java binary — prefer JAVA_BIN env var, then fall back to 'java'
    const javaBin = config.env.JAVA_BIN || process.env.JAVA_BIN || 'java'

    // Resolve the Spring AI agent JAR path
    const jarPath = config.env.SPRING_AI_AGENT_JAR || process.env.SPRING_AI_AGENT_JAR
    if (!jarPath) {
      return new SpringAiAgentHandle(null, abortController, 'SPRING_AI_AGENT_JAR environment variable is not set')
    }

    // Build args
    const args: string[] = ['-jar', jarPath]

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId)
    }

    args.push('--json')
    args.push('--cwd', config.cwd)

    if (config.autonomous) {
      args.push('--autonomous')
    }

    if (config.sandboxEnabled) {
      args.push('--sandbox')
    }

    // Prompt as final arg
    args.push('--prompt', config.prompt)

    // Spawn the Java process
    const child = spawn(javaBin, args, {
      cwd: config.cwd,
      env: {
        ...process.env,
        ...config.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    config.onProcessSpawned?.(child.pid)

    // Wire up abort
    const abortHandler = () => {
      child.kill('SIGTERM')
    }
    abortController.signal.addEventListener('abort', abortHandler)
    child.once('exit', () => {
      abortController.signal.removeEventListener('abort', abortHandler)
    })

    child.on('error', (err) => {
      console.error('[SpringAiProvider] Child process error:', err.message)
    })

    return new SpringAiAgentHandle(child, abortController)
  }
}

// ---------------------------------------------------------------------------
// AgentHandle implementation
// ---------------------------------------------------------------------------

class SpringAiAgentHandle implements AgentHandle {
  sessionId: string | null = null
  private readonly child: ChildProcess | null
  private readonly abortController: AbortController
  private readonly mapperState: SpringAiEventMapperState = {
    sessionId: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turnCount: 0,
  }
  private readonly initError?: string

  constructor(child: ChildProcess | null, abortController: AbortController, initError?: string) {
    this.child = child
    this.abortController = abortController
    this.initError = initError
  }

  get stream(): AsyncIterable<AgentEvent> {
    return this.createEventStream()
  }

  async injectMessage(_text: string): Promise<void> {
    // Spring AI CLI mode doesn't support mid-session message injection.
    // The prompt is provided at spawn time. Injection would require
    // stopping and resuming with a new prompt.
    throw new Error(
      'Spring AI provider does not support mid-session message injection. ' +
      'Stop and resume with a new prompt instead.'
    )
  }

  async stop(): Promise<void> {
    this.abortController.abort()
  }

  private async *createEventStream(): AsyncGenerator<AgentEvent> {
    // Handle init-time errors (e.g., missing JAR path)
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

    if (!this.child) {
      yield {
        type: 'error',
        message: 'Spring AI process was not created',
        raw: null,
      }
      return
    }

    const stdout = this.child.stdout
    if (!stdout) {
      yield {
        type: 'error',
        message: 'Spring AI process has no stdout',
        raw: null,
      }
      return
    }

    // Collect stderr for error reporting
    let stderr = ''
    this.child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    // Parse JSONL lines from stdout
    const rl = createInterface({ input: stdout })
    let hasResult = false

    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let event: SpringAiEvent
      try {
        event = JSON.parse(trimmed) as SpringAiEvent
      } catch {
        // Non-JSON output — emit as system event
        yield {
          type: 'system',
          subtype: 'raw_output',
          message: trimmed,
          raw: trimmed,
        }
        continue
      }

      const mapped = mapSpringAiEvent(event, this.mapperState)
      for (const agentEvent of mapped) {
        if (agentEvent.type === 'init') {
          this.sessionId = this.mapperState.sessionId
        }
        if (agentEvent.type === 'result') {
          hasResult = true
        }
        yield agentEvent
      }
    }

    // Wait for process exit
    const exitCode = await new Promise<number | null>((resolve) => {
      if (this.child!.exitCode !== null) {
        resolve(this.child!.exitCode)
      } else {
        this.child!.once('exit', (code) => resolve(code))
      }
    })

    // If we never got a result event, synthesize one from exit code
    if (!hasResult) {
      if (exitCode === 0) {
        yield {
          type: 'result',
          success: true,
          cost: {
            inputTokens: this.mapperState.totalInputTokens || undefined,
            outputTokens: this.mapperState.totalOutputTokens || undefined,
            numTurns: this.mapperState.turnCount || undefined,
          },
          raw: { exitCode },
        }
      } else {
        const errorMsg = stderr.trim() || `Spring AI process exited with code ${exitCode}`
        // Detect common errors
        const isJavaMissing = stderr.includes('java: not found') ||
          stderr.includes('JAVA_HOME') ||
          stderr.includes('No such file or directory')
        const isJarMissing = stderr.includes('Unable to access jarfile') ||
          stderr.includes('jarfile')

        yield {
          type: 'result',
          success: false,
          errors: [errorMsg],
          errorSubtype: isJavaMissing ? 'java_not_found'
            : isJarMissing ? 'jar_not_found'
            : 'process_exit',
          raw: { exitCode, stderr },
        }
      }
    }
  }
}

/**
 * Create a new Spring AI provider instance
 */
export function createSpringAiProvider(): SpringAiProvider {
  return new SpringAiProvider()
}
