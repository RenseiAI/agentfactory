/**
 * Codex App Server Provider
 *
 * Manages a long-lived `codex app-server` process communicating via JSON-RPC 2.0
 * over stdio. Supports multiple concurrent threads on a single process.
 *
 * Architecture:
 *   orchestrator → codex app-server (long-lived, one process)
 *                    ├── thread_1 (agent session A)
 *                    ├── thread_2 (agent session B)
 *                    └── thread_3 (agent session C)
 *
 * Falls back to `codex exec` CLI mode when app-server is unavailable.
 *
 * JSON-RPC 2.0 protocol (over stdio JSONL):
 *   1. initialize + initialized handshake
 *   2. thread/start or thread/resume
 *   3. turn/start with prompt
 *   4. Stream item/*, turn/*, thread/* notifications
 *   5. thread/unsubscribe on completion
 *
 * @see https://developers.openai.com/codex/app-server
 */

import { spawn, type ChildProcess } from 'child_process'
import { createInterface, type Interface } from 'readline'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'
import { homedir } from 'os'
import type {
  AgentProvider,
  AgentSpawnConfig,
  AgentHandle,
  AgentEvent,
} from './types.js'
import { classifyTool } from '../tools/tool-category.js'
import {
  evaluateCommandApproval,
  evaluateFileChangeApproval,
} from './codex-approval-bridge.js'

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  method: string
  id?: number
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

interface JsonRpcNotification {
  method: string
  params?: Record<string, unknown>
}

/** Server request: has both `id` (expects response) and `method` (like approvals) */
interface JsonRpcServerRequest {
  id: number | string
  method: string
  params?: Record<string, unknown>
}

type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest

function isServerRequest(msg: JsonRpcMessage): msg is JsonRpcServerRequest {
  return 'id' in msg && 'method' in msg
}

function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return 'id' in msg && !('method' in msg)
}

function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return 'method' in msg && !('id' in msg)
}

// ---------------------------------------------------------------------------
// MCP Server Status
// ---------------------------------------------------------------------------

/** Status of a registered MCP server as reported by mcpServerStatus/list */
export interface McpServerStatusResult {
  name: string
  status: 'connected' | 'connecting' | 'disconnected' | 'error'
  toolCount?: number
  error?: string
}

// ---------------------------------------------------------------------------
// App Server notification types
// ---------------------------------------------------------------------------

interface AppServerItem {
  id: string
  type: string
  text?: string
  summary?: string
  content?: string
  command?: string
  cwd?: string
  status?: string
  exitCode?: number
  durationMs?: number
  changes?: Array<{ path: string; kind: string }>
  server?: string
  tool?: string
  arguments?: unknown
  result?: { content?: unknown[] }
  error?: { message?: string }
  items?: Array<{ text: string; completed: boolean }>
  phase?: string
}

interface AppServerTurn {
  id: string
  status?: string
  /**
   * Usage tokens. Codex has historically used snake_case (`input_tokens`) but
   * newer app-server builds have shifted toward camelCase (`inputTokens`).
   * Both forms are accepted — see extractUsageTokens() for the normalization.
   */
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cached_input_tokens?: number
    inputTokens?: number
    outputTokens?: number
    cachedInputTokens?: number
  }
  error?: {
    message?: string
    codexErrorInfo?: string
    httpStatusCode?: number
  }
}

/**
 * Normalize a Codex app-server usage object across schema versions.
 * Returns plain numeric fields; defaults to 0 for missing values so
 * accumulation math is straightforward.
 *
 * Defends against:
 *   - snake_case (older codex): { input_tokens, output_tokens, cached_input_tokens }
 *   - camelCase (newer codex):  { inputTokens, outputTokens, cachedInputTokens }
 *   - Missing usage (some codex builds omit it on interrupted/short turns)
 */
function extractUsageTokens(usage: AppServerTurn['usage']): {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
} {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
  }
  return {
    inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
    outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
    cachedInputTokens: usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0,
  }
}

interface AppServerThread {
  id: string
  status?: string
}

// ---------------------------------------------------------------------------
// Codex model mapping
// ---------------------------------------------------------------------------

export const CODEX_MODEL_MAP: Record<string, string> = {
  'opus':   'gpt-5-codex',
  'sonnet': 'gpt-5.2-codex',
  'haiku':  'gpt-5.3-codex',
}

export const CODEX_DEFAULT_MODEL = 'gpt-5-codex'

export function resolveCodexModel(config: AgentSpawnConfig): string {
  if (config.model) return config.model
  const tier = config.env.CODEX_MODEL_TIER
  if (tier && CODEX_MODEL_MAP[tier]) return CODEX_MODEL_MAP[tier]
  if (config.env.CODEX_MODEL) return config.env.CODEX_MODEL
  return CODEX_DEFAULT_MODEL
}

// ---------------------------------------------------------------------------
// Codex pricing and cost calculation
// ---------------------------------------------------------------------------

/** Codex pricing per 1M tokens (USD). Update when pricing changes. */
export const CODEX_PRICING: Record<string, { input: number; cachedInput: number; output: number }> = {
  'gpt-5-codex':   { input: 2.00, cachedInput: 0.50, output: 8.00 },
  'gpt-5.2-codex': { input: 1.00, cachedInput: 0.25, output: 4.00 },
  'gpt-5.3-codex': { input: 0.50, cachedInput: 0.125, output: 2.00 },
}

export const CODEX_DEFAULT_PRICING = CODEX_PRICING['gpt-5-codex']

export function calculateCostUsd(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  model?: string,
): number {
  const pricing = (model && CODEX_PRICING[model]) || CODEX_DEFAULT_PRICING
  const freshInputTokens = Math.max(0, inputTokens - cachedInputTokens)
  return (
    (freshInputTokens / 1_000_000) * pricing.input +
    (cachedInputTokens / 1_000_000) * pricing.cachedInput +
    (outputTokens / 1_000_000) * pricing.output
  )
}

// ---------------------------------------------------------------------------
// App Server Process Manager
// ---------------------------------------------------------------------------

/** Pending JSON-RPC request awaiting a response */
interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Manages a single long-lived `codex app-server` process.
 *
 * Handles:
 * - Process spawning and stdio communication
 * - JSON-RPC 2.0 initialization handshake
 * - Request/response correlation
 * - Notification routing to thread subscribers
 * - Health monitoring and graceful shutdown
 */
export class AppServerProcessManager {
  private process: ChildProcess | null = null
  private readline: Interface | null = null
  private nextId = 1
  private pendingRequests = new Map<number, PendingRequest>()
  private initialized = false
  private shutdownPromise: Promise<void> | null = null

  /** Notification listeners keyed by threadId */
  private threadListeners = new Map<string, (notification: JsonRpcNotification) => void>()

  /** Global notification listeners (for notifications without a threadId) */
  private globalListeners = new Set<(notification: JsonRpcNotification) => void>()

  private readonly codexBin: string
  private readonly cwd: string
  private readonly env: Record<string, string>

  constructor(options: {
    codexBin?: string
    cwd: string
    env?: Record<string, string>
  }) {
    this.codexBin = options.codexBin || process.env.CODEX_BIN || 'codex'
    this.cwd = options.cwd
    this.env = options.env || {}
  }

  /**
   * Get the PID file path for tracking the app-server process.
   * Used for orphan detection on startup.
   */
  private static getPidFilePath(): string {
    const dir = join(homedir(), '.donmai')
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return join(dir, 'codex-app-server.pid')
  }

  /**
   * Kill any orphaned app-server process from a prior fleet run.
   * Called before starting a new process to prevent resource leaks.
   */
  private static killOrphanedProcess(): void {
    const pidFile = AppServerProcessManager.getPidFilePath()
    if (!existsSync(pidFile)) return

    try {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10)
      if (isNaN(pid)) {
        unlinkSync(pidFile)
        return
      }

      // Check if the process is alive
      try {
        process.kill(pid, 0) // signal 0 = check existence
      } catch {
        // Process is dead, just clean up the PID file
        unlinkSync(pidFile)
        return
      }

      // Process is alive — kill it
      console.error(`[CodexAppServer] Killing orphaned app-server process (PID ${pid})`)
      try {
        process.kill(pid, 'SIGTERM')
        // Give it a moment, then force kill
        setTimeout(() => {
          try {
            process.kill(pid, 0) // still alive?
            process.kill(pid, 'SIGKILL')
          } catch {
            // Already dead
          }
        }, 2000)
      } catch {
        // Kill failed, process may have already exited
      }
      unlinkSync(pidFile)
    } catch {
      // PID file read/delete failed — ignore
    }
  }

  /**
   * Write the current app-server PID to the PID file.
   */
  private writePidFile(): void {
    if (!this.process?.pid) return
    try {
      writeFileSync(AppServerProcessManager.getPidFilePath(), String(this.process.pid))
    } catch {
      // Best effort
    }
  }

  /**
   * Remove the PID file on shutdown.
   */
  private static removePidFile(): void {
    try {
      const pidFile = AppServerProcessManager.getPidFilePath()
      if (existsSync(pidFile)) {
        unlinkSync(pidFile)
      }
    } catch {
      // Best effort
    }
  }

  /**
   * Start the app-server process and complete the initialization handshake.
   * Idempotent — returns immediately if already initialized.
   * Kills any orphaned app-server from a prior fleet run before starting.
   */
  async start(): Promise<void> {
    if (this.initialized && this.process && !this.process.killed) {
      return
    }

    // Kill orphaned app-server from prior fleet run
    AppServerProcessManager.killOrphanedProcess()

    this.process = spawn(this.codexBin, ['app-server'], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Track PID for orphan detection on next startup
    this.writePidFile()

    this.readline = createInterface({ input: this.process.stdout! })

    // Parse incoming JSONL messages
    this.readline.on('line', (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return

      let msg: JsonRpcMessage
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage
      } catch {
        // Non-JSON output — ignore
        return
      }

      if (isServerRequest(msg)) {
        // Server requests have both `id` and `method` — Codex expects a response.
        // Approval requests (commandExecution/requestApproval, etc.) come as server requests.
        this.handleServerRequest(msg)
      } else if (isResponse(msg)) {
        this.handleResponse(msg)
      } else if (isNotification(msg)) {
        this.handleNotification(msg)
      }
    })

    // Handle process errors
    this.process.on('error', (err) => {
      console.error('[CodexAppServer] Process error:', err.message)
      this.rejectAllPending(new Error(`App server process error: ${err.message}`))
    })

    this.process.on('exit', (code, signal) => {
      // Shutdown-initiated exits are expected lifecycle, not errors.
      // Discriminate via shutdownPromise: if we asked the process to stop,
      // this.shutdownPromise is non-null before the exit event lands.
      const isShutdown = this.shutdownPromise !== null
      if (isShutdown) {
        console.error(`[CodexAppServer] Process shut down cleanly (signal=${signal ?? 'none'})`)
      } else {
        console.error(`[CodexAppServer] Process exited unexpectedly: code=${code} signal=${signal}`)
      }
      this.initialized = false
      this.rejectAllPending(new Error(`App server exited: code=${code} signal=${signal}`))
    })

    // Perform initialization handshake
    await this.initialize()

    // Discover available models (best effort — older servers may not support model/list)
    try {
      const models = await this.listModels()
      if (models.length > 0) {
        console.error(`[CodexAppServer] Available models: ${models.map(m => m.id).join(', ')}`)
      }
    } catch {
      console.error('[CodexAppServer] model/list not supported by this server version')
    }
  }

  /**
   * JSON-RPC 2.0 initialization handshake:
   * 1. Send `initialize` request
   * 2. Receive response
   * 3. Send `initialized` notification
   */
  private async initialize(): Promise<void> {
    // Step 1: Send initialize request
    await this.request('initialize', {
      clientInfo: {
        name: 'donmai',
        title: 'Donmai Orchestrator',
        version: '0.8.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    })

    // Step 2: Send initialized notification
    this.send({ method: 'initialized', params: {} })

    this.initialized = true
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async request(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
    if (!this.process || this.process.killed) {
      throw new Error('App server process is not running')
    }

    const id = this.nextId++
    const message: JsonRpcRequest = { method, id }
    if (params) message.params = params

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`JSON-RPC request timed out: ${method} (id=${id})`))
      }, timeoutMs)

      this.pendingRequests.set(id, { resolve, reject, timer })
      this.send(message)
    })
  }

  /**
   * Send a JSON-RPC message (request or notification) to the app-server.
   */
  private send(message: JsonRpcRequest): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('App server stdin is not writable')
    }
    this.process.stdin.write(JSON.stringify(message) + '\n')
  }

  /**
   * Handle an incoming JSON-RPC response.
   */
  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(response.id)
    if (!pending) return

    this.pendingRequests.delete(response.id)
    clearTimeout(pending.timer)

    if (response.error) {
      pending.reject(new Error(`JSON-RPC error (${response.error.code}): ${response.error.message}`))
    } else {
      pending.resolve(response.result)
    }
  }

  /**
   * Handle an incoming JSON-RPC server request (has both `id` and `method`).
   * Codex sends approval requests as server requests that expect a response.
   * Route to the thread listener (as a notification-like object) and store
   * the request ID so the handle can respond.
   */
  private handleServerRequest(request: JsonRpcServerRequest): void {
    const threadId = request.params?.threadId as string | undefined

    console.error(`[CodexAppServer] Server request: ${request.method} (id=${request.id}, thread=${threadId ?? 'none'})`)

    // Wrap as a notification-compatible object for the thread listener,
    // but include the id so the handle can respond.
    const notificationLike: JsonRpcNotification = {
      method: request.method,
      params: { ...request.params, _serverRequestId: request.id },
    }

    if (threadId) {
      const listener = this.threadListeners.get(threadId)
      if (listener) {
        listener(notificationLike)
        return
      }
    }

    // No thread listener — auto-accept to avoid hanging
    console.error(`[CodexAppServer] No thread listener for ${request.method} — auto-accepting`)
    this.respondToServerRequest(request.id, { decision: 'acceptForSession' })
  }

  /**
   * Send a JSON-RPC response to a server request.
   */
  respondToServerRequest(requestId: number | string, result: unknown): void {
    if (!this.process?.stdin?.writable) {
      console.error('[CodexAppServer] Cannot respond to server request: stdin not writable')
      return
    }
    console.error(`[CodexAppServer] Responding to server request ${requestId}: ${JSON.stringify(result)}`)
    const response = JSON.stringify({ jsonrpc: '2.0', id: requestId, result })
    this.process.stdin.write(response + '\n')
  }

  /**
   * Send a JSON-RPC error response to a server request.
   *
   * Used for server-request methods we don't know how to handle — we must
   * respond (with *something*) or Codex will hang the agent waiting for a
   * reply. A JSON-RPC error (code -32601 / Method not found) is the correct
   * signal: "the client does not implement this method."
   */
  respondToServerRequestWithError(
    requestId: number | string,
    code: number,
    message: string,
  ): void {
    if (!this.process?.stdin?.writable) {
      console.error('[CodexAppServer] Cannot respond to server request: stdin not writable')
      return
    }
    console.error(`[CodexAppServer] Responding to server request ${requestId} with error ${code}: ${message}`)
    const response = JSON.stringify({ jsonrpc: '2.0', id: requestId, error: { code, message } })
    this.process.stdin.write(response + '\n')
  }

  /**
   * Handle an incoming JSON-RPC notification.
   * Routes to the appropriate thread listener based on threadId in params.
   */
  private handleNotification(notification: JsonRpcNotification): void {
    const threadId = notification.params?.threadId as string | undefined

    if (threadId) {
      const listener = this.threadListeners.get(threadId)
      if (listener) {
        listener(notification)
        return
      }
    }

    // Dispatch to global listeners
    for (const listener of this.globalListeners) {
      listener(notification)
    }
  }

  /**
   * Subscribe to notifications for a specific thread.
   */
  subscribeThread(threadId: string, listener: (notification: JsonRpcNotification) => void): void {
    this.threadListeners.set(threadId, listener)
  }

  /**
   * Unsubscribe from notifications for a specific thread.
   */
  unsubscribeThread(threadId: string): void {
    this.threadListeners.delete(threadId)
  }

  /**
   * Check if the app-server process is alive and initialized.
   */
  isHealthy(): boolean {
    return this.initialized && !!this.process && !this.process.killed
  }

  /**
   * PID of the shared app-server process, or undefined if not started.
   * Multiple agent handles share this process — there is no per-session PID.
   */
  getProcessPid(): number | undefined {
    return this.process?.pid
  }

  // ─── MCP Server Configuration ──────────────────────────

  /** Whether MCP servers have been configured on this process */
  private mcpConfigured = false

  /**
   * Register MCP servers with the app-server via config/batchWrite.
   * Called once after initialization to tell Codex about the stdio
   * MCP tool servers (af-linear, af-code-intelligence, etc.).
   *
   * Uses the Codex app-server `config/batchWrite` JSON-RPC method
   * to register multiple MCP server configurations in a single call.
   */
  async configureMcpServers(
    servers: Array<{ name: string; command: string; args: string[]; env?: Record<string, string> }>,
  ): Promise<void> {
    if (!this.initialized || this.mcpConfigured) return
    if (servers.length === 0) return

    const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {}
    for (const server of servers) {
      mcpServers[server.name] = {
        command: server.command,
        args: server.args,
        env: server.env,
      }
    }

    try {
      await this.request('config/batchWrite', {
        edits: [
          { keyPath: 'mcpServers', mergeStrategy: 'replace', value: mcpServers },
        ],
      })
      this.mcpConfigured = true
      console.error(`[CodexAppServer] Configured ${servers.length} MCP servers: ${servers.map(s => s.name).join(', ')}`)
    } catch (err) {
      // config/batchWrite may not be supported in all Codex versions
      console.error(`[CodexAppServer] Failed to configure MCP servers: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Query MCP server health via mcpServerStatus/list.
   * Returns the status of all registered MCP servers.
   */
  async getMcpServerStatus(): Promise<McpServerStatusResult[]> {
    if (!this.initialized) return []

    try {
      const result = await this.request('mcpServerStatus/list') as {
        servers?: McpServerStatusResult[]
      }
      return result?.servers ?? []
    } catch {
      // mcpServerStatus/list may not be supported
      return []
    }
  }

  /**
   * Discover available models from the app-server via model/list.
   */
  async listModels(): Promise<Array<{ id: string; name?: string; capabilities?: Record<string, unknown> }>> {
    const result = await this.request('model/list', {}) as {
      models?: Array<{ id: string; name?: string; capabilities?: Record<string, unknown> }>
    }
    return result?.models ?? []
  }

  /**
   * Get the PID of the app-server process.
   */
  get pid(): number | undefined {
    return this.process?.pid
  }

  /**
   * Graceful shutdown: unsubscribe all threads, kill process.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise

    this.shutdownPromise = this.performShutdown()
    return this.shutdownPromise
  }

  private async performShutdown(): Promise<void> {
    this.initialized = false

    // Remove PID file before killing process
    AppServerProcessManager.removePidFile()

    // Clear all pending requests
    this.rejectAllPending(new Error('App server shutting down'))

    // Kill the process
    if (this.process && !this.process.killed) {
      const exitPromise = new Promise<void>((resolve) => {
        this.process!.once('exit', () => resolve())
        // Force kill after 5 seconds
        setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)
      })

      this.process.kill('SIGTERM')
      await exitPromise
    }

    this.readline?.close()
    this.threadListeners.clear()
    this.globalListeners.clear()
    this.process = null
    this.readline = null
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pendingRequests.delete(id)
    }
  }
}

// ---------------------------------------------------------------------------
// Event Mapping — App Server notifications → AgentEvent
// ---------------------------------------------------------------------------

export interface AppServerEventMapperState {
  sessionId: string | null
  model: string | null
  totalInputTokens: number
  totalOutputTokens: number
  totalCachedInputTokens: number
  turnCount: number
}

/**
 * Map an App Server notification to normalized AgentEvents.
 * Exported for unit testing.
 */
export function mapAppServerNotification(
  notification: JsonRpcNotification,
  state: AppServerEventMapperState,
): AgentEvent[] {
  const method = notification.method
  const params = notification.params ?? {}

  switch (method) {
    // --- Thread lifecycle ---
    case 'thread/started': {
      const thread = params.thread as AppServerThread | undefined
      if (thread?.id) {
        state.sessionId = thread.id
        return [{
          type: 'init',
          sessionId: thread.id,
          raw: notification,
        }]
      }
      return []
    }

    case 'thread/closed':
    case 'thread/status/changed':
      return [{
        type: 'system',
        subtype: method.replace(/\//g, '_'),
        message: `Thread ${method}: ${JSON.stringify(params)}`,
        raw: notification,
      }]

    // --- Turn lifecycle ---
    case 'turn/started': {
      state.turnCount++
      const turn = params.turn as AppServerTurn | undefined
      return [{
        type: 'system',
        subtype: 'turn_started',
        message: `Turn ${state.turnCount} started${turn?.id ? ` (${turn.id})` : ''}`,
        raw: notification,
      }]
    }

    case 'turn/completed': {
      const turn = params.turn as AppServerTurn | undefined
      const turnStatus = turn?.status ?? 'completed'

      // Accumulate usage. extractUsageTokens handles both snake_case and
      // camelCase shapes so cost accounting survives codex schema drift.
      const usageTokens = extractUsageTokens(turn?.usage)
      state.totalInputTokens += usageTokens.inputTokens
      state.totalOutputTokens += usageTokens.outputTokens
      state.totalCachedInputTokens += usageTokens.cachedInputTokens

      if (turnStatus === 'completed') {
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
          raw: notification,
        }]
      }

      if (turnStatus === 'failed') {
        return [{
          type: 'result',
          success: false,
          errors: [turn?.error?.message ?? 'Turn failed'],
          errorSubtype: turn?.error?.codexErrorInfo ?? 'turn_failed',
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
          raw: notification,
        }]
      }

      if (turnStatus === 'interrupted') {
        return [{
          type: 'result',
          success: false,
          errors: ['Turn was interrupted'],
          errorSubtype: 'interrupted',
          raw: notification,
        }]
      }

      return [{
        type: 'system',
        subtype: 'turn_completed',
        message: `Turn completed with status: ${turnStatus}`,
        raw: notification,
      }]
    }

    // --- Item lifecycle ---
    case 'item/started':
    case 'item/completed':
      return mapAppServerItemEvent(method, params)

    // --- Item deltas (streaming) ---
    case 'item/agentMessage/delta': {
      const text = (params.delta ?? params.text) as string | undefined
      if (text) {
        return [{
          type: 'assistant_text',
          text,
          raw: notification,
        }]
      }
      return []
    }

    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta': {
      const text = (params.text ?? params.delta) as string | undefined
      if (text) {
        return [{
          type: 'system',
          subtype: 'reasoning',
          message: text,
          raw: notification,
        }]
      }
      return []
    }

    case 'item/commandExecution/outputDelta':
      return [{
        type: 'system',
        subtype: 'command_progress',
        message: stripAnsi((params.delta ?? params.output) as string ?? ''),
        raw: notification,
      }]

    // --- Turn diff/plan ---
    case 'turn/diff/updated':
      return [{
        type: 'system',
        subtype: 'diff_updated',
        message: params.diff as string ?? '',
        raw: notification,
      }]

    case 'turn/plan/updated':
      return [{
        type: 'system',
        subtype: 'plan_updated',
        message: JSON.stringify(params.plan),
        raw: notification,
      }]

    default:
      return [{
        type: 'system',
        subtype: 'unknown',
        message: `Unhandled App Server notification: ${method}`,
        raw: notification,
      }]
  }
}

/**
 * Strip ANSI escape codes from text.
 * Codex shell commands produce raw terminal output with color codes,
 * cursor movement, etc. that pollute logs and activity tracking.
 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b[()][AB012]|\x1b\[[\d;]*m/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

/**
 * Map item/started and item/completed notifications to AgentEvents.
 * Exported for unit testing.
 */
export function mapAppServerItemEvent(
  method: string,
  params: Record<string, unknown>,
): AgentEvent[] {
  const item = params.item as AppServerItem | undefined
  if (!item) return []

  const isStarted = method === 'item/started'
  const isCompleted = method === 'item/completed'

  switch (item.type) {
    case 'agentMessage':
      if (isCompleted && item.text) {
        return [{
          type: 'assistant_text',
          text: item.text,
          raw: { method, params },
        }]
      }
      return []

    case 'reasoning':
      if (item.summary || item.content) {
        return [{
          type: 'system',
          subtype: 'reasoning',
          message: item.summary || item.content || '',
          raw: { method, params },
        }]
      }
      return []

    case 'commandExecution':
      if (isStarted) {
        return [{
          type: 'tool_use',
          toolName: 'shell',
          toolUseId: item.id,
          input: { command: item.command ?? '' },
          raw: { method, params },
        }]
      }
      if (isCompleted) {
        return [{
          type: 'tool_result',
          toolName: 'shell',
          toolUseId: item.id,
          content: stripAnsi(item.text ?? ''),
          isError: item.status === 'failed' || (item.exitCode !== undefined && item.exitCode !== 0),
          raw: { method, params },
        }]
      }
      return []

    case 'fileChange':
      if (isCompleted) {
        const changes = item.changes ?? []
        return [{
          type: 'tool_result',
          toolName: 'file_change',
          toolUseId: item.id,
          content: changes.map((c) => `${c.kind}: ${c.path}`).join('\n'),
          isError: item.status === 'failed',
          raw: { method, params },
        }]
      }
      return []

    case 'mcpToolCall': {
      // Normalize tool name to mcp__{server}__{tool} format
      // This matches the convention used by the Claude provider for
      // in-process MCP tools, enabling consistent tool tracking.
      const mcpToolName = normalizeMcpToolName(item.server, item.tool)

      if (isStarted) {
        return [{
          type: 'tool_use',
          toolName: mcpToolName,
          toolUseId: item.id,
          input: (item.arguments ?? {}) as Record<string, unknown>,
          toolCategory: classifyTool(mcpToolName),
          raw: { method, params },
        }]
      }
      if (isCompleted) {
        const isError = item.status === 'failed' || !!item.error
        const content = item.error?.message
          ?? (item.result?.content ? JSON.stringify(item.result.content) : '')
        return [{
          type: 'tool_result',
          toolName: mcpToolName,
          toolUseId: item.id,
          content,
          isError,
          raw: { method, params },
        }]
      }
      return []
    }

    case 'plan':
      return [{
        type: 'system',
        subtype: 'plan',
        message: item.text ?? '',
        raw: { method, params },
      }]

    case 'webSearch':
      return [{
        type: 'system',
        subtype: 'web_search',
        message: `Web search: ${item.text ?? ''}`,
        raw: { method, params },
      }]

    case 'contextCompaction':
      return [{
        type: 'system',
        subtype: 'context_compaction',
        message: 'Context history compacted',
        raw: { method, params },
      }]

    default:
      return [{
        type: 'system',
        subtype: 'unknown_item',
        message: `Unhandled App Server item type: ${item.type}`,
        raw: { method, params },
      }]
  }
}

// ---------------------------------------------------------------------------
// MCP tool name normalization
// ---------------------------------------------------------------------------

/**
 * Normalize Codex MCP tool names to the `mcp__{server}__{tool}` format
 * used by the orchestrator and Claude provider for consistent tool tracking.
 *
 * Codex reports MCP tools as `server` + `tool` (e.g., server='af-linear',
 * tool='af_linear_get_issue'). We normalize to 'mcp__af-linear__af_linear_get_issue'.
 */
export function normalizeMcpToolName(server?: string, tool?: string): string {
  if (server && tool) {
    return `mcp__${server}__${tool}`
  }
  // Fallback for missing server/tool
  return `mcp:${server ?? 'unknown'}/${tool ?? 'unknown'}`
}

// ---------------------------------------------------------------------------
// Resolve approval policy from AgentSpawnConfig
// ---------------------------------------------------------------------------

function resolveApprovalPolicy(config: AgentSpawnConfig): string {
  // Use 'on-request' for autonomous agents so all tool executions
  // flow through the approval bridge for safety evaluation. The bridge
  // auto-approves safe commands and declines destructive patterns.
  // Codex v0.117+ uses kebab-case: 'on-request' | 'untrusted' | 'on-failure' | 'never'
  if (config.autonomous) return 'on-request'
  return 'untrusted'
}

/**
 * Map AgentSpawnConfig sandbox settings to Codex App Server sandbox policy.
 *
 * Codex sandbox levels vs Claude sandbox:
 * | Feature               | Claude                  | Codex                          |
 * |-----------------------|-------------------------|--------------------------------|
 * | File write control    | Per-file glob patterns  | Workspace root only            |
 * | Network access        | Per-domain allow-lists  | All-or-nothing per level       |
 * | Tool-level permissions| Per-tool allow/deny     | Not supported (approval policy)|
 * | Custom writable paths | Multiple glob patterns  | Single writableRoots array     |
 * | Process isolation     | macOS sandbox-exec      | Docker/firewall container      |
 *
 * Key limitation: Codex cannot restrict writes to specific subdirectories within
 * the workspace or allow network access to specific domains. The mapping is intent-based:
 *   "safe browsing/analysis" → readOnly
 *   "normal development"     → workspaceWrite
 *   "install/deploy/admin"   → dangerFullAccess
 */
/**
 * If `cwd` is a linked git worktree, return additional roots that need to be
 * writable for git operations (`git add`, `git commit`, etc.) to succeed.
 *
 * A linked worktree's `.git` is a file (not a directory) containing
 * `gitdir: <abs-path>` pointing to `<main-repo>/.git/worktrees/<name>/`.
 * Git writes the worktree's index/HEAD/refs there, and shared objects to the
 * main `.git` (resolved via the `commondir` file). The codex `workspace-write`
 * sandbox only includes `cwd` by default, so commits fail with
 * `index.lock: Operation not permitted` unless we extend the writable roots.
 */
export function resolveWorktreeWritableRoots(cwd: string): string[] {
  try {
    const gitMarker = join(cwd, '.git')
    if (!existsSync(gitMarker) || !lstatSync(gitMarker).isFile()) return []

    const content = readFileSync(gitMarker, 'utf8').trim()
    const match = content.match(/^gitdir:\s*(.+)$/m)
    if (!match) return []

    const rawGitdir = match[1].trim()
    const gitdir = isAbsolute(rawGitdir) ? rawGitdir : resolve(cwd, rawGitdir)

    let commondir = dirname(dirname(gitdir))
    try {
      const rel = readFileSync(join(gitdir, 'commondir'), 'utf8').trim()
      if (rel) commondir = isAbsolute(rel) ? rel : resolve(gitdir, rel)
    } catch {
      // commondir file missing — fall back to dirname(dirname(gitdir))
    }

    return commondir ? [commondir] : []
  } catch {
    return []
  }
}

/**
 * Resolve sandbox policy as an object for turn/start (supports writableRoots).
 * Codex v0.117+ turn/start accepts: { type: 'workspaceWrite', writableRoots: [...] }
 *
 * Network access is enabled by default for agents because they need to run
 * commands like `gh`, `curl`, `pnpm install`, etc. The sandbox still restricts
 * file writes to the workspace root.
 */
export function resolveSandboxPolicy(config: AgentSpawnConfig): Record<string, unknown> | undefined {
  if (config.sandboxLevel) {
    switch (config.sandboxLevel) {
      case 'read-only':
        return { type: 'readOnly', networkAccess: true }
      case 'workspace-write':
        return {
          type: 'workspaceWrite',
          writableRoots: [config.cwd, ...resolveWorktreeWritableRoots(config.cwd)],
          networkAccess: true,
        }
      case 'full-access':
        return { type: 'dangerFullAccess' }
    }
  }

  // Fallback: boolean sandboxEnabled → workspaceWrite with network
  if (!config.sandboxEnabled) return undefined
  return {
    type: 'workspaceWrite',
    writableRoots: [config.cwd, ...resolveWorktreeWritableRoots(config.cwd)],
    networkAccess: true,
  }
}

/**
 * Resolve sandbox mode as a simple string for thread/start.
 * Codex v0.117+ thread/start accepts: 'read-only' | 'workspace-write' | 'danger-full-access'
 */
export function resolveSandboxMode(config: AgentSpawnConfig): string | undefined {
  if (config.sandboxLevel) {
    switch (config.sandboxLevel) {
      case 'read-only':
        return 'read-only'
      case 'workspace-write':
        return 'workspace-write'
      case 'full-access':
        return 'danger-full-access'
    }
  }

  // Fallback: boolean sandboxEnabled → workspace-write
  if (!config.sandboxEnabled) return undefined
  return 'workspace-write'
}

// ---------------------------------------------------------------------------
// Base Instructions Builder
// ---------------------------------------------------------------------------

/**
 * Build persistent base instructions for the Codex App Server `thread/start`.
 *
 * Assembles safety rules (mirroring `autonomousCanUseTool` deny patterns as
 * natural-language rules) and optional project-specific instructions loaded
 * from AGENTS.md or CLAUDE.md in the worktree root.
 */
function buildBaseInstructions(config: AgentSpawnConfig): string | undefined {
  // If explicit baseInstructions are provided (from orchestrator), use those
  if (config.baseInstructions) {
    return config.baseInstructions
  }

  // Otherwise, build safety-only instructions as a fallback
  const sections: string[] = []

  sections.push(`# Safety Rules

You are running in a donmai-managed worktree. Follow these rules strictly:

1. NEVER run: rm -rf / (or any rm of the filesystem root)
2. NEVER run: git worktree remove, git worktree prune
3. NEVER run: git reset --hard
4. NEVER run: git push --force (use --force-with-lease on feature branches if needed)
5. NEVER run: git checkout <branch>, git switch <branch> (do not change the checked-out branch)
6. NEVER modify files in the .git directory
7. Work only within the worktree directory: ${config.cwd}
8. Commit changes with descriptive messages before reporting completion`)

  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// AgentHandle for App Server threads
// ---------------------------------------------------------------------------

class AppServerAgentHandle implements AgentHandle {
  sessionId: string | null = null
  private readonly processManager: AppServerProcessManager
  private readonly config: AgentSpawnConfig
  private readonly resumeThreadId?: string
  private readonly mapperState: AppServerEventMapperState = {
    sessionId: null,
    model: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
    turnCount: 0,
  }
  private activeTurnId: string | null = null
  private notificationQueue: JsonRpcNotification[] = []
  private notificationResolve: (() => void) | null = null
  private streamEnded = false
  /** True while we're waiting for a possible injected turn between turns */
  private awaitingInjection = false
  /** Accumulated assistant text for the result message (completion comment) */
  private accumulatedText = ''

  constructor(
    processManager: AppServerProcessManager,
    config: AgentSpawnConfig,
    resumeThreadId?: string,
  ) {
    this.processManager = processManager
    this.config = config
    this.resumeThreadId = resumeThreadId
  }

  get stream(): AsyncIterable<AgentEvent> {
    return this.createEventStream()
  }

  async injectMessage(text: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error('No active session for message injection')
    }

    if (this.activeTurnId) {
      // Mid-turn injection: steer the active turn
      await this.steerTurn(text)
    } else {
      // Between-turn injection: start a new turn on the existing thread
      await this.startNewTurn(text)
    }
  }

  async stop(): Promise<void> {
    if (this.sessionId) {
      try {
        // Interrupt any active turn
        await this.processManager.request('turn/interrupt', {
          threadId: this.sessionId,
          turnId: 'current',
        }).catch(() => { /* turn may not be active */ })

        // Unsubscribe from the thread
        await this.processManager.request('thread/unsubscribe', {
          threadId: this.sessionId,
        }).catch(() => { /* best effort */ })
      } catch {
        // Best effort cleanup
      }

      this.processManager.unsubscribeThread(this.sessionId)
    }

    this.streamEnded = true
    this.notificationResolve?.()
  }

  /**
   * Steer an active turn with additional user input.
   * Sends a `turn/steer` JSON-RPC request to inject a message mid-turn.
   */
  private async steerTurn(text: string): Promise<void> {
    if (!this.sessionId || !this.activeTurnId) {
      throw new Error('No active turn to steer')
    }
    await this.processManager.request('turn/steer', {
      threadId: this.sessionId,
      expectedTurnId: this.activeTurnId,
      input: [{ type: 'text', text }],
    })
  }

  /**
   * Handle an approval request from the App Server.
   *
   * Evaluates the command or file change against deny patterns (ported from
   * Claude's `autonomousCanUseTool`) and template-level permissions, then
   * responds with accept/decline/acceptForSession via JSON-RPC.
   *
   * Returns a system event if the request was declined, for observability.
   */
  private handleApprovalRequest(notification: JsonRpcNotification): AgentEvent | null {
    const params = notification.params ?? {}
    // Server requests pass _serverRequestId; fall back to requestId for backwards compat
    const serverRequestId = params._serverRequestId as number | string | undefined
    const command = params.command as string | undefined
    const filePath = params.filePath as string | undefined

    let decision: import('./codex-approval-bridge.js').ApprovalDecision

    if (command !== undefined) {
      // Command execution approval
      decision = evaluateCommandApproval(command, this.config.permissionConfig)
    } else if (filePath !== undefined) {
      // File change approval
      decision = evaluateFileChangeApproval(filePath, this.config.cwd, this.config.permissionConfig)
    } else {
      // Unknown approval request — accept by default
      decision = { action: 'acceptForSession' }
    }

    // Respond to the server request with the approval decision.
    // Codex sends approval requests as JSON-RPC server requests (with `id`),
    // expecting a JSON-RPC response matching that id.
    if (serverRequestId != null) {
      this.processManager.respondToServerRequest(serverRequestId, {
        decision: decision.action,
      })
    }

    // Emit system event for declined approvals (observability)
    if (decision.action === 'decline') {
      const target = command ?? filePath ?? 'unknown'
      return {
        type: 'system',
        subtype: 'approval_denied',
        message: `Blocked: ${decision.reason} — ${command ? 'command' : 'file'}: ${target}`,
        raw: notification,
      }
    }

    return null
  }

  /**
   * Handle an MCP `elicitation/request` server request from Codex.
   *
   * The MCP spec lets a server ask the client for user input mid-tool-call
   * via `elicitation/create`; Codex forwards these as
   * `mcpServer/elicitation/request` server-requests. Our agents run
   * autonomously with no human to prompt, so we respond with
   * `{action: "cancel"}` per the MCP spec — this tells the MCP server to
   * abort the operation cleanly rather than hang indefinitely.
   *
   * Emits a system event for observability so operators can see which MCP
   * tool calls are producing unsatisfiable elicitation prompts.
   */
  private handleElicitationRequest(notification: JsonRpcNotification): AgentEvent | null {
    const params = notification.params ?? {}
    const serverRequestId = params._serverRequestId as number | string | undefined

    if (serverRequestId == null) {
      // Shouldn't happen — handleServerRequest stamps this on every
      // server request before queuing. Fall through without responding
      // rather than invent an id.
      return null
    }

    // MCP elicitation response shape: { action: "accept" | "decline" | "cancel", content? }
    this.processManager.respondToServerRequest(serverRequestId, { action: 'cancel' })

    // Best-effort context for the observer: which MCP tool was asking.
    const mcpServer = (params.mcpServer ?? params.server ?? 'unknown') as string
    const requestedSchema = params.requestedSchema ? ' (schema present)' : ''

    return {
      type: 'system',
      subtype: 'elicitation_cancelled',
      message: `Cancelled MCP elicitation from ${mcpServer}${requestedSchema} — autonomous mode has no user to prompt`,
      raw: notification,
    }
  }

  /**
   * Fallback for Codex server-request methods we don't explicitly handle.
   *
   * Every server request expects a response; failing to respond hangs the
   * agent until the orchestrator's inactivity timeout fires (300s default).
   * Respond with a JSON-RPC "Method not found" error so the Codex/MCP side
   * knows the client doesn't implement the method, and emit a system event
   * so operators can see which methods still need specific handlers.
   */
  private handleUnhandledServerRequest(notification: JsonRpcNotification): AgentEvent | null {
    const params = notification.params ?? {}
    const serverRequestId = params._serverRequestId as number | string | undefined

    if (serverRequestId == null) return null

    // JSON-RPC 2.0: -32601 = Method not found
    this.processManager.respondToServerRequestWithError(
      serverRequestId,
      -32601,
      `Client does not implement ${notification.method}`,
    )

    return {
      type: 'system',
      subtype: 'unhandled_server_request',
      message: `Declined unhandled Codex server request: ${notification.method}`,
      raw: notification,
    }
  }

  /**
   * Start a new turn on the existing thread with additional user input.
   * Used for between-turn injection when no turn is currently active.
   */
  private async startNewTurn(text: string): Promise<void> {
    if (!this.sessionId) {
      throw new Error('No active session to start new turn')
    }

    const turnParams: Record<string, unknown> = {
      threadId: this.sessionId,
      input: [{ type: 'text', text }],
      cwd: this.config.cwd,
      approvalPolicy: resolveApprovalPolicy(this.config),
    }

    turnParams.model = resolveCodexModel(this.config)

    const sandboxPolicy = resolveSandboxPolicy(this.config)
    if (sandboxPolicy) {
      turnParams.sandboxPolicy = sandboxPolicy
    }

    // Mark that we're no longer waiting between turns
    this.awaitingInjection = false

    await this.processManager.request('turn/start', turnParams)

    // Wake up the notification loop so it processes the new turn's events
    this.notificationResolve?.()
  }

  private async *createEventStream(): AsyncGenerator<AgentEvent> {
    try {
      // Ensure the app-server is running
      await this.processManager.start()

      // Report the shared process PID to the caller's onProcessSpawned
      // callback so diagnostics (e.g., worker "Agent spawned { pid }" logs,
      // heartbeat writers) have a real PID to reference. All agent handles
      // for this provider share the same PID.
      const sharedPid = this.processManager.getProcessPid()
      if (sharedPid !== undefined) {
        this.config.onProcessSpawned?.(sharedPid)
      }

      // Configure MCP servers if provided
      // This registers stdio MCP tool servers (af-linear, af-code-intelligence)
      // with the Codex app-server so it can discover and invoke them.
      if (this.config.mcpStdioServers && this.config.mcpStdioServers.length > 0) {
        await this.processManager.configureMcpServers(this.config.mcpStdioServers)
      }

      // Start or resume the thread
      let threadId: string

      if (this.resumeThreadId) {
        // Resume existing thread
        const result = await this.processManager.request('thread/resume', {
          threadId: this.resumeThreadId,
          personality: 'pragmatic',
        }) as { thread?: { id: string } }

        threadId = result?.thread?.id ?? this.resumeThreadId
      } else {
        // Start new thread
        const threadParams: Record<string, unknown> = {
          cwd: this.config.cwd,
          approvalPolicy: resolveApprovalPolicy(this.config),
          serviceName: 'donmai',
        }

        // Pass persistent system instructions via `baseInstructions` on thread/start.
        // Separates safety rules and project context from per-turn task input.
        const instructions = buildBaseInstructions(this.config)
        if (instructions) {
          threadParams.baseInstructions = instructions
        }

        threadParams.model = resolveCodexModel(this.config)

        // thread/start uses simple string sandbox mode (not object like turn/start)
        const sandboxMode = resolveSandboxMode(this.config)
        if (sandboxMode) {
          threadParams.sandbox = sandboxMode
        }

        const result = await this.processManager.request('thread/start', threadParams) as {
          thread?: { id: string }
        }

        threadId = result?.thread?.id ?? ''
        if (!threadId) {
          yield {
            type: 'error',
            message: 'Failed to start thread: no thread ID returned',
            raw: result,
          }
          return
        }
      }

      this.sessionId = threadId
      this.mapperState.sessionId = threadId
      this.mapperState.model = resolveCodexModel(this.config)

      // Subscribe to thread notifications
      this.processManager.subscribeThread(threadId, (notification) => {
        this.notificationQueue.push(notification)
        this.notificationResolve?.()
      })

      // Emit init event
      yield {
        type: 'init',
        sessionId: threadId,
        raw: { threadId },
      }

      // Start the turn with the prompt
      const turnInput: Array<{ type: string; text?: string }> = [
        { type: 'text', text: this.config.prompt },
      ]

      const turnParams: Record<string, unknown> = {
        threadId,
        input: turnInput,
        cwd: this.config.cwd,
        approvalPolicy: resolveApprovalPolicy(this.config),
      }

      turnParams.model = resolveCodexModel(this.config)

      // Pass effort level as reasoning effort (from profile config)
      if (this.config.effort) {
        turnParams.reasoningEffort = this.config.effort
      }

      const sandboxPolicy = resolveSandboxPolicy(this.config)
      if (sandboxPolicy) {
        turnParams.sandboxPolicy = sandboxPolicy
      }

      await this.processManager.request('turn/start', turnParams)

      // Stream notifications until explicitly stopped.
      // After a turn completes, we enter "awaiting injection" mode — the stream
      // stays alive to allow injectMessage() to start a new turn. The stream
      // only terminates when stop() is called or the process dies.
      //
      // turn/completed `result` events are intercepted and re-emitted as `system`
      // events so the orchestrator doesn't interpret them as the agent finishing.
      // A single `result` event is emitted when the stream actually ends.
      let lastTurnSuccess = true
      let lastTurnErrors: string[] | undefined
      // Tracks whether a `result` event was already yielded via the turn/completed
      // path (autonomous mode). Prevents the final synthesized result below from
      // double-emitting and causing a duplicate "Agent completed" log line.
      let resultEmitted = false
      // Coalesce reasoning deltas. Codex streams reasoning as many small tokens
      // (item/reasoning/textDelta), each of which becomes its own mapped event
      // and — without coalescing — its own CLI log line rendered with weird
      // character-by-character spacing ("  V  erified   on   branch..."). We
      // buffer consecutive reasoning text and yield a single combined event
      // on the next non-reasoning event or on buffer overflow.
      let reasoningBuffer = ''
      let reasoningRaw: unknown = null
      const REASONING_FLUSH_BYTES = 16 * 1024
      function flushReasoning(): AgentEvent | null {
        if (!reasoningBuffer) return null
        const event: AgentEvent = {
          type: 'system',
          subtype: 'reasoning',
          message: reasoningBuffer,
          raw: reasoningRaw,
        }
        reasoningBuffer = ''
        reasoningRaw = null
        return event
      }

      while (!this.streamEnded) {
        // Wait for notifications
        if (this.notificationQueue.length === 0) {
          await new Promise<void>((resolve) => {
            this.notificationResolve = resolve
            // Timeout to prevent hanging indefinitely
            setTimeout(resolve, 60000)
          })
          this.notificationResolve = null
        }

        // Drain the queue
        while (this.notificationQueue.length > 0) {
          const notification = this.notificationQueue.shift()!

          // Intercept approval requests before other processing.
          // Codex sends approvals as server requests with methods like:
          //   item/commandExecution/requestApproval, item/fileChange/requestApproval,
          //   item/permissions/requestApproval, applyPatchApproval, execCommandApproval
          if (notification.method.includes('pproval') || notification.method.includes('requestApproval')) {
            const deniedEvent = this.handleApprovalRequest(notification)
            if (deniedEvent) {
              yield deniedEvent
            }
            continue // Don't yield as a regular AgentEvent
          }

          // MCP elicitation requests (e.g. the Codex-bundled `codex_apps`
          // GitHub MCP server asking the user to confirm a label). The
          // autonomous agent has no human to prompt, so we cancel the
          // elicitation per the MCP spec. Without this handler, the server
          // request never gets a response → the MCP tool call hangs → the
          // agent hits the 300s inactivity timeout and gets killed.
          if (notification.method === 'mcpServer/elicitation/request') {
            const elicitationEvent = this.handleElicitationRequest(notification)
            if (elicitationEvent) {
              yield elicitationEvent
            }
            continue
          }

          // Defensive fallback: any other server request (identifiable by
          // the `_serverRequestId` we stamp in handleServerRequest) that we
          // don't have a specific handler for MUST get a response, or Codex
          // will hang the agent. Reply with a JSON-RPC "Method not found"
          // error so the MCP server knows we can't satisfy it, and emit a
          // system event so the unhandled method surfaces in the stream
          // and we can write a specific handler next time.
          if (notification.params && typeof notification.params === 'object' && '_serverRequestId' in notification.params) {
            const unhandledEvent = this.handleUnhandledServerRequest(notification)
            if (unhandledEvent) {
              yield unhandledEvent
            }
            continue
          }

          // Track active turn ID for mid-turn steering
          if (notification.method === 'turn/started') {
            const turn = notification.params?.turn as AppServerTurn | undefined
            if (turn?.id) {
              this.activeTurnId = turn.id
            }
            this.awaitingInjection = false
          } else if (notification.method === 'turn/completed') {
            this.activeTurnId = null
            // Enter awaiting-injection mode — the stream stays alive
            this.awaitingInjection = true
          }

          const events = mapAppServerNotification(notification, this.mapperState)

          for (const event of events) {
            // Coalesce reasoning deltas into a single combined event.
            // Accumulate until a non-reasoning event arrives, then flush.
            if (event.type === 'system' && event.subtype === 'reasoning' && typeof event.message === 'string') {
              reasoningBuffer += event.message
              reasoningRaw = event.raw
              // Flush proactively on buffer overflow to avoid unbounded memory.
              if (reasoningBuffer.length >= REASONING_FLUSH_BYTES) {
                const flushed = flushReasoning()
                if (flushed) yield flushed
              }
              continue
            }
            // About to yield a non-reasoning event — flush any pending reasoning first.
            const pending = flushReasoning()
            if (pending) yield pending

            // Intercept turn/completed result events.
            // In autonomous mode (fleet), emit the result directly to end the session.
            // In interactive mode, convert to system event to keep the stream alive
            // for potential message injection.
            // Accumulate assistant text for the result message / completion comment
            if (event.type === 'assistant_text' && event.text) {
              this.accumulatedText += event.text
            }

            if (event.type === 'result') {
              if (this.config.autonomous) {
                // Autonomous: emit result with accumulated text and end stream
                yield { ...event, message: this.accumulatedText.trim() || undefined }
                resultEmitted = true
                this.streamEnded = true
              } else {
                // Interactive: keep stream alive for injection
                lastTurnSuccess = event.success
                lastTurnErrors = event.errors
                yield {
                  type: 'system',
                  subtype: 'turn_result',
                  message: `Turn ${event.success ? 'succeeded' : 'failed'}${event.errors?.length ? ': ' + event.errors[0] : ''}`,
                  raw: event.raw,
                }
              }
            } else {
              yield event
            }
          }
        }
      }

      // Flush any trailing reasoning that hadn't been followed by a non-reasoning event.
      const trailingReasoning = flushReasoning()
      if (trailingReasoning) yield trailingReasoning

      // Cleanup: unsubscribe from the thread
      this.processManager.unsubscribeThread(threadId)
      try {
        await this.processManager.request('thread/unsubscribe', { threadId }).catch(() => {})
      } catch {
        // Best effort
      }

      // Emit the final result event when the stream ends (interactive mode / stop).
      // Skip if the autonomous path already yielded a result via turn/completed —
      // otherwise the orchestrator logs "Agent completed" twice.
      if (!resultEmitted) {
        yield {
          type: 'result',
          success: lastTurnSuccess,
          message: this.accumulatedText.trim() || undefined,
          errors: lastTurnErrors,
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
          raw: null,
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      yield {
        type: 'error',
        message: `App Server error: ${message}`,
        raw: err,
      }
      yield {
        type: 'result',
        success: false,
        errors: [message],
        errorSubtype: 'app_server_error',
        raw: err,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Codex App Server Provider
 *
 * Uses a long-lived `codex app-server` process with JSON-RPC 2.0 over stdio.
 * Falls back to `codex exec` CLI mode when CODEX_USE_APP_SERVER is not set
 * or when the app-server binary is unavailable.
 */
export class CodexAppServerProvider implements AgentProvider {
  readonly name = 'codex' as const
  readonly capabilities = {
    supportsMessageInjection: true,
    supportsSessionResume: true,
    supportsToolPlugins: true,
    needsBaseInstructions: true,
    needsPermissionConfig: true,
    supportsCodeIntelligenceEnforcement: false,
    toolPermissionFormat: 'codex' as const,
    emitsSubagentEvents: false,
    // app-server forwards `effort` to the Codex thread via
    // `turnParams.reasoningEffort` (see CodexAppServerThread.send).
    supportsReasoningEffort: true,
    humanLabel: 'Codex',
  } as const

  /** Shared process manager — one app-server process serves all threads */
  private processManager: AppServerProcessManager | null = null

  spawn(config: AgentSpawnConfig): AgentHandle {
    const pm = this.getOrCreateProcessManager(config)
    return new AppServerAgentHandle(pm, config)
  }

  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle {
    const pm = this.getOrCreateProcessManager(config)
    return new AppServerAgentHandle(pm, config, sessionId)
  }

  /**
   * Shut down the shared app-server process.
   * Called when the orchestrator is done with this provider.
   */
  async shutdown(): Promise<void> {
    if (this.processManager) {
      await this.processManager.shutdown()
      this.processManager = null
    }
  }

  private getOrCreateProcessManager(config: AgentSpawnConfig): AppServerProcessManager {
    if (this.processManager?.isHealthy()) {
      return this.processManager
    }

    this.processManager = new AppServerProcessManager({
      codexBin: config.env.CODEX_BIN || process.env.CODEX_BIN,
      cwd: config.cwd,
      env: config.env,
    })

    return this.processManager
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCodexAppServerProvider(): CodexAppServerProvider {
  return new CodexAppServerProvider()
}

/** Exported for testing */
export type { JsonRpcNotification, AppServerItem, AppServerTurn, AppServerThread }
