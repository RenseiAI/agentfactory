/**
 * OpenAI Codex Agent Provider
 *
 * Unified Codex provider with two execution modes:
 *
 * 1. **App Server mode** (default):
 *    Uses a long-lived `codex app-server` process communicating via JSON-RPC 2.0
 *    over stdio. Supports multiple concurrent threads on a single process,
 *    mid-session message injection, and in-process tool plugins.
 *
 * 2. **Exec fallback mode** (opt-in, break-glass):
 *    Spawns the `codex` CLI as a child process and parses its JSONL event stream.
 *    Used for CI/CD environments, short-lived runs, or when app-server is
 *    unavailable. Also used as an automatic fallback when the app-server
 *    startup health probe fails.
 *
 * Mode selection:
 *   - Not set                 → App Server mode (DEFAULT since v0.9)
 *   - CODEX_USE_APP_SERVER=1  → App Server mode (explicit)
 *   - CODEX_USE_APP_SERVER=0  → Exec fallback mode (explicit opt-out)
 *   - providerConfig.useAppServer=true/false → Per-profile override
 *
 * Automatic fallback: if App Server mode is selected but the `codex app-server`
 * process fails to initialize within APP_SERVER_PROBE_TIMEOUT_MS, the spawn
 * transparently falls back to exec mode and logs the failure. This keeps the
 * fleet running even when a codex binary version ships a broken JSON-RPC
 * handshake.
 *
 * Exec CLI invocation patterns:
 *   New session:  codex exec --json --full-auto -C <cwd> "<prompt>"
 *   Resume:       codex exec resume --json --full-auto <session_id> "<prompt>"
 *
 * JSONL event types:
 *   thread.started  → init (sessionId)
 *   turn.started    → system (turn_started)
 *   turn.completed  → result (success, usage)
 *   turn.failed     → result (failure)
 *   item.*          → tool_use / tool_result / assistant_text / system
 *   error           → error
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import type {
  AgentProvider,
  AgentProviderCapabilities,
  AgentSpawnConfig,
  AgentHandle,
  AgentEvent,
} from './types.js'
import { CodexAppServerProvider, resolveCodexModel, calculateCostUsd } from './codex-app-server-provider.js'

/**
 * Timeout for the one-shot `codex app-server --help` binary probe used to
 * decide whether app-server mode is viable. 3s is long enough for a cold
 * binary start on overloaded CI, short enough that a hung probe doesn't
 * delay agent spawn noticeably.
 */
const APP_SERVER_PROBE_TIMEOUT_MS = 3000

// ---------------------------------------------------------------------------
// Codex JSONL event types (subset we care about)
// ---------------------------------------------------------------------------

interface CodexThreadStarted {
  type: 'thread.started'
  thread_id: string
}

interface CodexTurnStarted {
  type: 'turn.started'
}

interface CodexTurnCompleted {
  type: 'turn.completed'
  usage?: {
    input_tokens?: number
    cached_input_tokens?: number
    output_tokens?: number
  }
}

interface CodexTurnFailed {
  type: 'turn.failed'
  error?: { message?: string }
}

interface CodexItemEvent {
  type: 'item.started' | 'item.updated' | 'item.completed'
  item: CodexItem
}

interface CodexErrorEvent {
  type: 'error'
  message?: string
}

type CodexEvent =
  | CodexThreadStarted
  | CodexTurnStarted
  | CodexTurnCompleted
  | CodexTurnFailed
  | CodexItemEvent
  | CodexErrorEvent

// ---------------------------------------------------------------------------
// Codex item types (nested in item events)
// ---------------------------------------------------------------------------

interface CodexAgentMessage {
  id: string
  type: 'agent_message'
  text: string
}

interface CodexReasoning {
  id: string
  type: 'reasoning'
  text: string
}

interface CodexCommandExecution {
  id: string
  type: 'command_execution'
  command: string
  aggregated_output: string
  exit_code?: number
  status: 'in_progress' | 'completed' | 'failed' | 'declined'
}

interface CodexFileChange {
  id: string
  type: 'file_change'
  changes: Array<{ path: string; kind: string }>
  status: string
}

interface CodexMcpToolCall {
  id: string
  type: 'mcp_tool_call'
  server: string
  tool: string
  arguments: unknown
  result?: { content?: unknown[] }
  error?: { message?: string }
  status: string
}

interface CodexTodoList {
  id: string
  type: 'todo_list'
  items: Array<{ text: string; completed: boolean }>
}

interface CodexErrorItem {
  id: string
  type: 'error'
  message: string
}

type CodexItem =
  | CodexAgentMessage
  | CodexReasoning
  | CodexCommandExecution
  | CodexFileChange
  | CodexMcpToolCall
  | CodexTodoList
  | CodexErrorItem

/** Exported for testing */
export type { CodexEvent, CodexItem, CodexItemEvent }

// ---------------------------------------------------------------------------
// Event Mapping (exported for unit testing)
// ---------------------------------------------------------------------------

export interface CodexEventMapperState {
  sessionId: string | null
  model: string | null
  totalInputTokens: number
  totalOutputTokens: number
  totalCachedInputTokens: number
  turnCount: number
}

/**
 * Map a single Codex JSONL event to one or more normalized AgentEvents.
 * Exported for unit testing — the AgentHandle uses this internally.
 */
export function mapCodexEvent(
  event: CodexEvent,
  state: CodexEventMapperState,
): AgentEvent[] {
  switch (event.type) {
    case 'thread.started':
      state.sessionId = event.thread_id
      return [{
        type: 'init',
        sessionId: event.thread_id,
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
        state.totalCachedInputTokens += event.usage.cached_input_tokens ?? 0
      }
      return [{
        type: 'result',
        success: true,
        cost: {
          inputTokens: state.totalInputTokens || undefined,
          outputTokens: state.totalOutputTokens || undefined,
          cachedInputTokens: state.totalCachedInputTokens || undefined,
          totalCostUsd: calculateCostUsd(
            state.totalInputTokens,
            state.totalCachedInputTokens,
            state.totalOutputTokens,
            state.model ?? undefined,
          ),
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

    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      return mapCodexItemEvent(event)

    case 'error':
      return [{
        type: 'error',
        message: event.message ?? 'Unknown error',
        raw: event,
      }]

    default:
      return [{
        type: 'system',
        subtype: 'unknown',
        message: `Unhandled Codex event type: ${(event as { type: string }).type}`,
        raw: event,
      }]
  }
}

/**
 * Map a Codex item event to AgentEvents.
 * Exported for unit testing.
 */
export function mapCodexItemEvent(event: CodexItemEvent): AgentEvent[] {
  const item = event.item
  const eventType = event.type

  switch (item.type) {
    case 'agent_message':
      return [{
        type: 'assistant_text',
        text: item.text,
        raw: event,
      }]

    case 'reasoning':
      return [{
        type: 'system',
        subtype: 'reasoning',
        message: item.text,
        raw: event,
      }]

    case 'command_execution':
      if (eventType === 'item.started') {
        return [{
          type: 'tool_use',
          toolName: 'shell',
          toolUseId: item.id,
          input: { command: item.command },
          raw: event,
        }]
      }
      if (eventType === 'item.completed') {
        return [{
          type: 'tool_result',
          toolName: 'shell',
          toolUseId: item.id,
          content: item.aggregated_output || '',
          isError: item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0),
          raw: event,
        }]
      }
      return [{
        type: 'system',
        subtype: 'command_progress',
        message: `Command: ${item.command} (${item.status})`,
        raw: event,
      }]

    case 'file_change':
      return [{
        type: 'tool_result',
        toolName: 'file_change',
        toolUseId: item.id,
        content: item.changes.map((c) => `${c.kind}: ${c.path}`).join('\n'),
        isError: item.status === 'failed',
        raw: event,
      }]

    case 'mcp_tool_call':
      if (eventType === 'item.started') {
        return [{
          type: 'tool_use',
          toolName: `mcp:${item.server}/${item.tool}`,
          toolUseId: item.id,
          input: (item.arguments ?? {}) as Record<string, unknown>,
          raw: event,
        }]
      }
      if (eventType === 'item.completed') {
        const isError = item.status === 'failed' || !!item.error
        const content = item.error?.message
          ?? (item.result?.content ? JSON.stringify(item.result.content) : '')
        return [{
          type: 'tool_result',
          toolName: `mcp:${item.server}/${item.tool}`,
          toolUseId: item.id,
          content,
          isError,
          raw: event,
        }]
      }
      return []

    case 'todo_list':
      return [{
        type: 'system',
        subtype: 'todo_list',
        message: item.items.map((t) => `${t.completed ? '[x]' : '[ ]'} ${t.text}`).join('\n'),
        raw: event,
      }]

    case 'error':
      return [{
        type: 'error',
        message: item.message,
        raw: event,
      }]

    default:
      return [{
        type: 'system',
        subtype: 'unknown_item',
        message: `Unhandled Codex item type: ${(item as { type: string }).type}`,
        raw: event,
      }]
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Check whether App Server mode is enabled.
 *
 * App Server mode is ON by default. Callers explicitly opt out via:
 *   - providerConfig.useAppServer === false   (per-profile)
 *   - CODEX_USE_APP_SERVER=0 (or 'false')     (env var, global or per-spawn)
 *
 * Any other value, including an unset env var, keeps the default ON.
 * Exported for testing.
 */
export function isAppServerEnabled(config?: AgentSpawnConfig): boolean {
  // Per-profile providerConfig takes precedence
  if (config?.providerConfig?.useAppServer === true) return true
  if (config?.providerConfig?.useAppServer === false) return false
  const envVal = (config?.env?.CODEX_USE_APP_SERVER
    ?? process.env.CODEX_USE_APP_SERVER
    ?? '').toLowerCase()
  if (envVal === '0' || envVal === 'false') return false
  return true
}

export class CodexProvider implements AgentProvider {
  readonly name = 'codex' as const

  /**
   * Dynamic capabilities that reflect the actual runtime mode.
   * App Server mode supports message injection and tool plugins;
   * exec fallback mode does not.
   *
   * When App Server mode is selected but the probe hasn't run yet, report
   * app-server capabilities — the probe runs at first spawn, and the
   * orchestrator reads capabilities before that. If the probe later fails,
   * the actual spawn transparently falls back, but downstream features like
   * tool plugin registration will have already been configured for the
   * richer mode. This is a deliberate trade-off: over-report capabilities,
   * fall back gracefully at spawn time.
   */
  get capabilities(): AgentProviderCapabilities {
    // If probe has conclusively failed, report exec capabilities.
    if (this.appServerViable === false) {
      return {
        supportsMessageInjection: false,
        supportsSessionResume: true,
        supportsToolPlugins: false,
        needsBaseInstructions: false,
        needsPermissionConfig: false,
        supportsCodeIntelligenceEnforcement: false,
        emitsSubagentEvents: false,
        // exec mode forwards `effort` via
        // `--config model_reasoning_effort=...` (see createExecHandle).
        supportsReasoningEffort: true,
        humanLabel: 'Codex',
      }
    }
    if (this.appServerProvider || isAppServerEnabled()) {
      return {
        supportsMessageInjection: true,
        supportsSessionResume: true,
        supportsToolPlugins: true,
        needsBaseInstructions: true,
        needsPermissionConfig: true,
        supportsCodeIntelligenceEnforcement: false,
        toolPermissionFormat: 'codex' as const,
        emitsSubagentEvents: false,
        // app-server mode forwards `effort` via
        // `turnParams.reasoningEffort` (see codex-app-server-provider).
        supportsReasoningEffort: true,
        humanLabel: 'Codex',
      }
    }
    return {
      supportsMessageInjection: false,
      supportsSessionResume: true,
      supportsToolPlugins: false,
      needsBaseInstructions: false,
      needsPermissionConfig: false,
      supportsCodeIntelligenceEnforcement: false,
      emitsSubagentEvents: false,
      // default exec mode forwards `effort` via the Codex CLI
      // `--config model_reasoning_effort=...` flag.
      supportsReasoningEffort: true,
      humanLabel: 'Codex',
    }
  }

  /** App Server delegate — created lazily when App Server mode is enabled */
  private appServerProvider: CodexAppServerProvider | null = null

  /**
   * Cached result of the app-server binary probe.
   *   - undefined: probe hasn't run yet
   *   - true: `codex app-server --help` succeeded, app-server mode is viable
   *   - false: probe failed, always use exec fallback
   */
  private appServerViable: boolean | undefined = undefined

  spawn(config: AgentSpawnConfig): AgentHandle {
    if (this.shouldUseAppServer(config)) {
      return this.getAppServerProvider().spawn(config)
    }
    return this.createExecHandle(config)
  }

  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle {
    if (this.shouldUseAppServer(config)) {
      return this.getAppServerProvider().resume(sessionId, config)
    }
    return this.createExecHandle(config, sessionId)
  }

  /**
   * Decide whether to use app-server mode for this spawn.
   *
   * Composite logic:
   *   1. If the user has explicitly opted out (env or providerConfig), use exec.
   *   2. Otherwise, run the one-shot binary probe (if not already cached).
   *      Probe success → app-server. Probe failure → exec fallback.
   *
   * The probe is deliberately cheap: `codex app-server --help` with a short
   * timeout. Cached for the provider's lifetime so subsequent spawns skip it.
   */
  private shouldUseAppServer(config: AgentSpawnConfig): boolean {
    if (!isAppServerEnabled(config)) return false

    if (this.appServerViable === undefined) {
      this.appServerViable = this.probeAppServerAvailable(config)
      if (this.appServerViable) {
        console.error('[CodexProvider] App server probe succeeded — using app-server mode')
      } else {
        console.error('[CodexProvider] App server probe failed — falling back to exec mode for all codex spawns in this orchestrator lifecycle')
      }
    }
    return this.appServerViable
  }

  /**
   * Probe whether the `codex` binary supports the `app-server` subcommand.
   *
   * This is a lightweight viability check — it does NOT perform the full
   * JSON-RPC handshake. Handshake failures surface as stream errors during
   * actual sessions, which the orchestrator logs. The probe protects against
   * the common failure mode: an older or misconfigured codex binary that
   * doesn't ship app-server at all.
   *
   * Exposed as a protected method so tests can override it.
   */
  protected probeAppServerAvailable(config: AgentSpawnConfig): boolean {
    const codexBin = config.env?.CODEX_BIN || process.env.CODEX_BIN || 'codex'
    try {
      execFileSync(codexBin, ['app-server', '--help'], {
        stdio: 'ignore',
        timeout: APP_SERVER_PROBE_TIMEOUT_MS,
        env: { ...process.env, ...config.env },
      })
      return true
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      console.error(`[CodexProvider] App server probe error: ${detail}`)
      return false
    }
  }

  /**
   * Reset the cached probe result so the next spawn re-probes.
   * Useful for long-lived orchestrators that want to retry after a
   * codex binary upgrade without restarting the process.
   */
  resetProbeCache(): void {
    this.appServerViable = undefined
  }

  /**
   * Shut down the App Server process if running.
   * No-op if in exec fallback mode.
   */
  async shutdown(): Promise<void> {
    if (this.appServerProvider) {
      await this.appServerProvider.shutdown()
      this.appServerProvider = null
    }
  }

  private getAppServerProvider(): CodexAppServerProvider {
    if (!this.appServerProvider) {
      this.appServerProvider = new CodexAppServerProvider()
    }
    return this.appServerProvider
  }

  // -------------------------------------------------------------------------
  // Exec fallback mode (backward compatibility —)
  // -------------------------------------------------------------------------

  private createExecHandle(config: AgentSpawnConfig, resumeSessionId?: string): AgentHandle {
    const abortController = config.abortController

    // Resolve the codex binary — prefer CODEX_BIN env var, then fall back to 'codex'
    const codexBin = config.env.CODEX_BIN || process.env.CODEX_BIN || 'codex'

    // Build args
    const args: string[] = ['exec']

    if (resumeSessionId) {
      args.push('resume', '--json')
      // Sandbox and approval mode
      if (config.autonomous) {
        args.push('--full-auto')
      } else {
        args.push('--approval-mode', 'untrusted')
        if (config.sandboxLevel) {
          const cliSandboxMap: Record<string, string> = {
            'read-only':       'read-only',
            'workspace-write': 'workspace-write',
            'full-access':     'danger-full-access',
          }
          args.push('--sandbox', cliSandboxMap[config.sandboxLevel])
        } else if (config.sandboxEnabled) {
          args.push('--sandbox', 'workspace-write')
        }
      }
      const model = resolveCodexModel(config)
      if (model) args.push('--model', model)
      if (config.effort) {
        args.push('--config', `model_reasoning_effort="${config.effort}"`)
      }
      args.push(resumeSessionId)
      // Prompt is the final positional arg
      if (config.prompt) {
        args.push(config.prompt)
      }
    } else {
      args.push('--json')
      // Sandbox and approval mode
      if (config.autonomous) {
        // --full-auto sets sandbox=workspace-write + approval=on-request
        args.push('--full-auto')
      } else {
        args.push('--approval-mode', 'untrusted')
        if (config.sandboxLevel) {
          const cliSandboxMap: Record<string, string> = {
            'read-only':       'read-only',
            'workspace-write': 'workspace-write',
            'full-access':     'danger-full-access',
          }
          args.push('--sandbox', cliSandboxMap[config.sandboxLevel])
        } else if (config.sandboxEnabled) {
          args.push('--sandbox', 'workspace-write')
        }
      }
      const model = resolveCodexModel(config)
      if (model) args.push('--model', model)
      // Pass effort level as reasoning_effort config override
      if (config.effort) {
        args.push('--config', `model_reasoning_effort="${config.effort}"`)
      }
      // Working directory
      args.push('-C', config.cwd)
      // Prompt is the final positional arg
      args.push(config.prompt)
    }

    // Spawn the codex process
    const child = spawn(codexBin, args, {
      cwd: config.cwd,
      env: {
        ...process.env,
        ...config.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Log the resolved command for operator diagnostics
    const debugCmd = `${codexBin} ${args.join(' ')}`
    console.error(`[CodexProvider] Spawning: ${debugCmd.substring(0, 200)}${debugCmd.length > 200 ? '...' : ''}`)

    config.onProcessSpawned?.(child.pid)

    // Close stdin immediately — the prompt is passed as a positional arg.
    // Codex CLI detects piped stdin and tries to read additional input from it.
    // If we don't close it, the process hangs waiting for EOF on stdin.
    child.stdin?.end()

    // Wire up abort
    const abortHandler = () => {
      child.kill('SIGTERM')
    }
    abortController.signal.addEventListener('abort', abortHandler)
    child.once('exit', () => {
      abortController.signal.removeEventListener('abort', abortHandler)
    })

    child.on('error', (err) => {
      console.error('[CodexProvider] Child process error:', err.message)
      // Destroy stdout so the readline-based event stream terminates
      child.stdout?.destroy()
    })

    return new CodexAgentHandle(child, abortController, resolveCodexModel(config))
  }
}

// ---------------------------------------------------------------------------
// AgentHandle implementation
// ---------------------------------------------------------------------------

class CodexAgentHandle implements AgentHandle {
  sessionId: string | null = null
  private readonly child: ChildProcess
  private readonly abortController: AbortController
  private readonly mapperState: CodexEventMapperState = {
    sessionId: null,
    model: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    turnCount: 0,
  }

  constructor(child: ChildProcess, abortController: AbortController, model?: string) {
    this.child = child
    this.abortController = abortController
    if (model) this.mapperState.model = model
  }

  get stream(): AsyncIterable<AgentEvent> {
    return this.createEventStream()
  }

  async injectMessage(_text: string): Promise<void> {
    // Codex exec mode doesn't support mid-session message injection.
    // The prompt is provided at spawn time. Injection would require
    // stopping and resuming with a new prompt.
    throw new Error(
      'Codex provider does not support mid-session message injection. ' +
      'Stop and resume with a new prompt instead.'
    )
  }

  async stop(): Promise<void> {
    this.abortController.abort()
  }

  private async *createEventStream(): AsyncGenerator<AgentEvent> {
    const stdout = this.child.stdout
    if (!stdout) {
      yield {
        type: 'error',
        message: 'Codex process has no stdout',
        raw: null,
      }
      return
    }

    // Collect stderr for error reporting
    let stderr = ''
    this.child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    // Early death detection: if the process already exited before we start
    // reading, it died immediately (e.g., invalid model name, missing binary).
    // Give a brief moment for stderr to drain, then report the failure.
    if (this.child.exitCode !== null) {
      await new Promise(resolve => setTimeout(resolve, 100))
      yield {
        type: 'error',
        message: `Codex process exited immediately (code ${this.child.exitCode}): ${stderr.trim() || 'no error output'}`,
        raw: { exitCode: this.child.exitCode, stderr },
      }
      yield {
        type: 'result',
        success: false,
        errors: [stderr.trim() || `Codex process exited immediately with code ${this.child.exitCode}`],
        errorSubtype: 'spawn_failure',
        raw: { exitCode: this.child.exitCode, stderr },
      }
      return
    }

    // Parse JSONL lines from stdout
    const rl = createInterface({ input: stdout })
    let hasResult = false

    // Force-close readline when the process exits so `for await` terminates
    // even if the child never wrote to stdout (e.g., invalid model, binary crash).
    this.child.once('exit', () => {
      rl.close()
    })

    // Also handle spawn errors (e.g., binary not found) — the 'error' handler
    // in createExecHandle destroys stdout, but belt-and-suspenders here too.
    this.child.once('error', () => {
      rl.close()
    })

    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let event: CodexEvent
      try {
        event = JSON.parse(trimmed) as CodexEvent
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

      const mapped = mapCodexEvent(event, this.mapperState)
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
      if (this.child.exitCode !== null) {
        resolve(this.child.exitCode)
      } else {
        this.child.once('exit', (code) => resolve(code))
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
            cachedInputTokens: this.mapperState.totalCachedInputTokens || undefined,
            totalCostUsd: calculateCostUsd(
              this.mapperState.totalInputTokens,
              this.mapperState.totalCachedInputTokens,
              this.mapperState.totalOutputTokens,
              this.mapperState.model ?? undefined,
            ),
            numTurns: this.mapperState.turnCount || undefined,
          },
          raw: { exitCode },
        }
      } else {
        yield {
          type: 'result',
          success: false,
          errors: [stderr.trim() || `Codex process exited with code ${exitCode}`],
          errorSubtype: 'process_exit',
          raw: { exitCode, stderr },
        }
      }
    }
  }

}

/**
 * Create a new Codex provider instance
 */
export function createCodexProvider(): CodexProvider {
  return new CodexProvider()
}
