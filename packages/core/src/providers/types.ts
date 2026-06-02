/**
 * Agent Provider Interface
 *
 * Abstracts the underlying agent SDK (Claude, Codex, Amp, etc.)
 * so the orchestrator is provider-agnostic.
 *
 * All three providers follow the same pattern:
 * 1. Initialize with config + working directory
 * 2. Send a prompt
 * 3. Iterate over a stream of events
 * 4. Get a final result with cost/token data
 */

// ---------------------------------------------------------------------------
// SandboxProviderCapabilities — typed capability matrix for sandbox providers
//
// Architecture reference: rensei-architecture/004-sandbox-capability-matrix.md
//
// Every sandbox provider declares this struct so the scheduler can reason
// about capability flags without loading provider implementations.
//
// IMPORTANT: All fields must be primitives or arrays (flat struct) — the
// base-contract validator (base.ts isFlatCapabilities) enforces no nested
// objects. This keeps the scheduler's flag-index efficient.
// ---------------------------------------------------------------------------

/**
 * Typed capability matrix for sandbox providers.
 *
 * The cross-provider scheduler (orchestrator/scheduler.ts) filters and scores
 * candidates based on these flags. Providers declare this at construction time;
 * the host verifies at activation that runtime behavior matches (capability
 * discrepancy detection per 002-provider-base-contract.md).
 *
 * All fields are primitives or string arrays — no nested objects (flat constraint
 * from base-contract validator isFlatCapabilities).
 */
export interface SandboxProviderCapabilities {
  // --- Transport -------------------------------------------------------
  /**
   * How the orchestrator communicates with the worker process.
   * - dial-in: orchestrator calls into a hosted sandbox exec endpoint
   * - dial-out: worker boots and registers with the orchestrator
   * - either: both supported; scheduler picks based on network topology
   */
  transportModel: 'dial-in' | 'dial-out' | 'either'

  // --- Snapshot / pause-resume primitives ------------------------------
  /**
   * Whether the provider supports filesystem-only snapshots.
   * Required for WorkareaProvider pairing that needs release(pause).
   */
  supportsFsSnapshot: boolean

  /**
   * Whether the provider supports full memory+FS pause/resume.
   * E2B (~1s), Modal (preview). Enables $0-compute paused sessions.
   */
  supportsPauseResume: boolean

  // --- Capacity & scheduling -------------------------------------------
  /**
   * Whether the provider can answer real-time capacity queries.
   * Providers returning false trigger optimistic provisioning + retry-on-rejection.
   */
  supportsCapacityQuery: boolean

  /**
   * Hard ceiling on concurrent sessions; null means unbounded (cloud-burst).
   */
  maxConcurrent: number | null

  /**
   * Maximum wall-clock session duration in seconds; null means unlimited.
   */
  maxSessionDurationSeconds: number | null

  // --- Geography -------------------------------------------------------
  /**
   * ISO region codes this provider can serve. ['*'] means any region.
   * The scheduler checks spec.region against this list.
   */
  regions: string[]

  // --- Platform (OS + CPU architecture) --------------------------------
  /**
   * Operating systems supported. Critical for toolchain compatibility:
   * a Rust toolchain for darwin/arm64 is not the same as linux/x86_64.
   */
  os: ('linux' | 'macos' | 'windows')[]

  /**
   * CPU architectures supported.
   */
  arch: ('x86_64' | 'arm64' | 'wasm32')[]

  // --- Cost shape ------------------------------------------------------
  /**
   * Whether idle (non-running) sessions accrue cost.
   * - zero: no cost when not running (paused E2B, local, Docker)
   * - storage-only: small storage cost only (Daytona archived)
   * - metered: continuous charge even when idle (reserved K8s nodes, Modal warm)
   */
  idleCostModel: 'zero' | 'storage-only' | 'metered'

  /**
   * How active running time is billed.
   * - wall-clock: every second running (E2B)
   * - active-cpu: only CPU not in I/O wait (Vercel) — favors I/O-heavy agent work
   * - invocation: per-call, Lambda-style
   * - fixed: bring-your-own-hardware (local, self-hosted K8s/Docker)
   */
  billingModel: 'wall-clock' | 'active-cpu' | 'invocation' | 'fixed'

  // --- Resource ceilings -----------------------------------------------
  /**
   * Maximum vCPU per session; null if not bounded by the provider (host-limited).
   */
  maxVCpu: number | null

  /**
   * Maximum RAM per session in MiB; null if host-limited.
   */
  maxMemoryMb: number | null

  /**
   * Whether the provider can provision GPU-attached sessions.
   */
  supportsGpu: boolean

  // --- Network ---------------------------------------------------------
  /**
   * Whether tenants can supply a custom network policy (allowlists, deny-all, etc.).
   */
  supportsCustomNetworkPolicy: boolean

  /**
   * Default egress posture for new sessions.
   */
  egressDefault: 'allow-all' | 'deny-all' | 'allowlist'

  // --- A2A / federated work -------------------------------------------
  /**
   * When true, this provider represents a remote agent over the A2A protocol.
   * Provisioning is a no-op; the handle's execUrl is the A2A peer's endpoint.
   */
  isA2ARemote: boolean
}

/**
 * Human-readable labels for every SandboxProviderCapabilities flag.
 *
 * Co-located plain-language strings so TUIs and dashboards can render
 * meaningful descriptions without re-encoding semantics. Schedulers use the
 * typed values above; surfaces consume these labels.
 *
 * Architecture reference: 002-provider-base-contract.md §Capabilities
 */
export const SandboxCapabilityLabels = {
  transportModel: {
    'dial-in': 'Orchestrator dials in (managed sandbox)',
    'dial-out': 'Worker dials out to orchestrator (substrate / fleet)',
    'either': 'Both dial-in and dial-out supported',
  },
  supportsFsSnapshot: {
    true: 'Filesystem snapshots supported',
    false: 'No filesystem snapshot support',
  },
  supportsPauseResume: {
    true: 'Memory + FS pause/resume supported (enables $0-compute paused sessions)',
    false: 'No pause/resume support',
  },
  supportsCapacityQuery: {
    true: 'Real-time capacity reporting available',
    false: 'Capacity opaque — scheduler uses optimistic provisioning',
  },
  idleCostModel: {
    'zero': 'No cost when idle (paused or stopped)',
    'storage-only': 'Storage-only cost when idle (archived workspace)',
    'metered': 'Continuous metered charge even while idle',
  },
  billingModel: {
    'wall-clock': 'Billed for every second the session is running',
    'active-cpu': 'Billed only for active CPU (I/O wait is free — favors agent workloads)',
    'invocation': 'Per-invocation pricing (Lambda-style)',
    'fixed': 'Bring-your-own-hardware — no per-use cost',
  },
  supportsGpu: {
    true: 'GPU-attached sessions available',
    false: 'CPU-only sessions',
  },
  supportsCustomNetworkPolicy: {
    true: 'Custom network policy (allowlists, deny-all egress) supported',
    false: 'Network policy is provider-default only',
  },
  egressDefault: {
    'allow-all': 'All outbound traffic allowed by default',
    'deny-all': 'All outbound traffic denied by default',
    'allowlist': 'Allowlist-only egress by default',
  },
  isA2ARemote: {
    true: 'Remote agent over A2A protocol — provisioning is a no-op',
    false: 'Local/cloud-hosted compute',
  },
} as const

/** Supported agent provider names */
export type AgentProviderName = 'claude' | 'codex' | 'amp' | 'spring-ai' | 'a2a'

/**
 * Agent Provider
 *
 * Each provider implements spawn/resume to create an AgentHandle
 * that streams normalized AgentEvents.
 */
/**
 * Provider capability flags.
 *
 * The orchestrator uses these to choose the right exit-gate strategy
 * without try-catching on unsupported operations:
 * - Providers with `supportsMessageInjection` get mid-session stop hooks
 * - All providers get the post-session backstop (provider-agnostic)
 * - Providers with `supportsSessionResume` get stop → resume as fallback
 */
export type ToolPermissionFormat = 'claude' | 'codex' | 'spring-ai'

export interface AgentProviderCapabilities {
  /** Whether injectMessage() works (stateful providers: Claude, A2A) */
  supportsMessageInjection: boolean
  /** Whether resume() can continue a prior session */
  supportsSessionResume: boolean
  /** Provider can use MCP tool plugins delivered via stdio servers (af_linear_*, af_code_*) */
  supportsToolPlugins?: boolean
  /** Provider needs persistent base instructions via AgentSpawnConfig.baseInstructions */
  needsBaseInstructions?: boolean
  /** Provider needs structured permission config via AgentSpawnConfig.permissionConfig */
  needsPermissionConfig?: boolean
  /** Provider supports canUseTool-style code intelligence enforcement */
  supportsCodeIntelligenceEnforcement?: boolean
  /** Tool permission format this provider uses (default: 'claude') */
  toolPermissionFormat?: ToolPermissionFormat
  /**
   * Whether the provider emits Anthropic-style subagent events (e.g. Task tool
   * progress events). Used by the Topology view to decide whether to render
   * the subagent event stream. Only true for the Claude provider because the
   * Anthropic Task tool fires provider-specific sub-agent lifecycle events.
   * Codex and Spring AI have no equivalent emission today.
   */
  emitsSubagentEvents: boolean
  /**
   * REN-1245: whether the provider honors the per-step `effort` value on
   * AgentSpawnConfig (`low | medium | high | xhigh`). When true, the dispatch
   * path forwards the value to the provider's native reasoning-effort knob
   * (Claude: `effort` option; Codex/OpenAI: `model_reasoning_effort` /
   * `reasoningEffort`; Gemini: `thinkingBudget`). When false, the dispatch
   * path drops the value and emits a `capability-mismatch` hook event on the
   * Layer 6 bus so observers can flag silently-ignored cost-control hints.
   *
   * Optional for backwards compatibility — providers that omit it are treated
   * as not supporting reasoning effort (conservative default).
   */
  supportsReasoningEffort?: boolean
  /**
   * Human-readable label for this provider family. Used in UI and log
   * messages where the raw provider name ('spring-ai') is not user-friendly.
   * Companion to the AgentRuntimeProvider alias for corpus documentation.
   */
  humanLabel?: string
}

/**
 * Human-readable label registry for every AgentRuntimeProvider family.
 * Keyed by AgentProviderName. Populated by each provider's declared
 * capabilities.humanLabel; this map is the single source of truth for
 * display names used in the Topology view and log messages.
 */
export const AGENT_RUNTIME_PROVIDER_HUMAN_LABELS: Readonly<Record<AgentProviderName, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  amp: 'Amp',
  'spring-ai': 'Spring AI',
  a2a: 'A2A',
} as const

export interface AgentProvider {
  /** Provider identifier */
  readonly name: AgentProviderName

  /** Provider capability flags for orchestrator routing */
  readonly capabilities: AgentProviderCapabilities

  /** Spawn a new agent session */
  spawn(config: AgentSpawnConfig): AgentHandle

  /** Resume a previously interrupted session */
  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle

  /**
   * Gracefully shut down provider resources (e.g., long-lived child processes).
   * Called by the orchestrator on fleet shutdown. Optional — providers with
   * per-agent child processes (Claude) don't need this.
   */
  shutdown?(): Promise<void>
}

/**
 * AgentRuntimeProvider — corpus alias for AgentProvider.
 *
 * ADR-2026-04-27 introduces "AgentRuntimeProvider" as the 8th plugin-family
 * name in the corpus (documentation, architecture diagrams, Linear labels).
 * The implementation type stays AgentProvider. This alias lets callers use
 * the new corpus name in type annotations without a breaking rename.
 *
 * @example
 *   // Both are equivalent; prefer AgentRuntimeProvider in new code per ADR.
 *   const p: AgentRuntimeProvider = new ClaudeProvider()
 *   const q: AgentProvider        = new ClaudeProvider()
 */
export type AgentRuntimeProvider = AgentProvider

/**
 * Configuration passed to a provider when spawning an agent.
 * Provider implementations translate these to SDK-specific options.
 */
export interface AgentSpawnConfig {
  /** The prompt/instruction for the agent */
  prompt: string
  /** Working directory for the agent */
  cwd: string
  /** Environment variables to pass to the agent process */
  env: Record<string, string>
  /** AbortController for cancellation support */
  abortController: AbortController
  /** Whether agent runs in autonomous mode (no user input) */
  autonomous: boolean
  /** Sandbox level for filesystem/network restrictions */
  sandboxEnabled: boolean
  /**
   * Codex-specific sandbox level override. When set, takes precedence over sandboxEnabled.
   * Maps to Codex sandbox policies: readOnly, workspaceWrite, dangerFullAccess.
   */
  sandboxLevel?: 'read-only' | 'workspace-write' | 'full-access'
  /**
   * Tools to auto-allow without prompting for permission.
   * Uses Claude Code permission pattern format: 'Bash(prefix:glob)'.
   * Examples: 'Bash(pnpm:*)', 'Bash(git commit:*)'.
   * When omitted the provider may supply defaults for autonomous agents.
   */
  allowedTools?: string[]
  /**
   * Callback to capture PID when the agent process is spawned.
   * Providers call this once the underlying process is created.
   */
  onProcessSpawned?: (pid: number | undefined) => void
  /**
   * Fully-qualified MCP tool names (e.g. 'mcp__af-code-intelligence__af_code_get_repo_map').
   * Added to the allowedTools list so autonomous agents can use MCP tools.
   */
  mcpToolNames?: string[]
  /**
   * Maximum number of agentic turns (API round-trips) before stopping.
   * Coordinators need more turns than standard agents since they poll sub-agent status.
   * When omitted, the provider's default applies.
   */
  maxTurns?: number
  /**
   * Stdio MCP server configurations for Codex provider (SUP-1744).
   * Created by ToolRegistry.createStdioServerConfigs() from registered plugins.
   * Passed to Codex app-server via config/batchWrite so it can spawn and
   * connect to these tool servers.
   */
  mcpStdioServers?: Array<{
    name: string
    command: string
    args: string[]
    env?: Record<string, string>
  }>
  /**
   * Persistent system instructions for Codex App Server (SUP-1746).
   * Passed via `instructions` on `thread/start`. Contains safety rules,
   * project instructions (AGENTS.md), and work-type context.
   * Separate from `prompt` which contains only the task-specific directive.
   */
  baseInstructions?: string
  /**
   * Structured permission config for Codex approval bridge (SUP-1748).
   * Translates template `tools.allow` / `tools.disallow` into patterns
   * consumed by the approval bridge for runtime tool evaluation.
   */
  permissionConfig?: import('../templates/adapters.js').CodexPermissionConfig
  /**
   * Code intelligence enforcement config.
   * When set, the provider's canUseTool callback redirects Grep/Glob
   * calls to af_code_* tools until the agent has attempted code intelligence.
   */
  codeIntelligenceEnforcement?: {
    enforceUsage: boolean
    fallbackAfterAttempt: boolean
  }
  /**
   * Custom instructions to append to the system prompt.
   * Sourced from RepositoryConfig.systemPrompt (append + byWorkType merged).
   * Appended after standard instruction sections and before AGENTS.md/CLAUDE.md.
   */
  systemPromptAppend?: string
  /**
   * Model identifier to use for the agent session.
   * When omitted, the provider resolves the model from environment variables or defaults.
   */
  model?: string
  /**
   * Normalized effort level for reasoning depth.
   * Providers map this to their specific mechanism:
   * - Claude: effort level string
   * - Codex/OpenAI: reasoning_effort
   * - Gemini: thinkingBudget
   */
  effort?: import('../config/profiles.js').EffortLevel
  /**
   * Provider-specific configuration from the matched profile block.
   * Contains settings like { serviceTier: 'fast' } for OpenAI or
   * { speed: 'fast' } for Anthropic.
   */
  providerConfig?: Record<string, unknown>
  /**
   * Provider name for sub-agents when different from the parent agent's provider.
   * Used by coordination templates to instruct sub-agents.
   */
  subAgentProvider?: import('../providers/index.js').AgentProviderName
}

/**
 * Handle to a running agent session.
 * Returned by AgentProvider.spawn() and AgentProvider.resume().
 */
export interface AgentHandle {
  /** Provider-specific session/thread ID (available after init event) */
  sessionId: string | null
  /** Async iterable stream of normalized events */
  stream: AsyncIterable<AgentEvent>
  /**
   * Inject a follow-up user message into the running session.
   * Used for user prompts without restarting the agent.
   */
  injectMessage(text: string): Promise<void>
  /**
   * Stop the agent. Delegates to the provider's abort mechanism.
   */
  stop(): Promise<void>
}

/**
 * Normalized agent event.
 * Each provider maps its native events to this common format.
 */
export type AgentEvent =
  | AgentInitEvent
  | AgentSystemEvent
  | AgentAssistantTextEvent
  | AgentToolUseEvent
  | AgentToolResultEvent
  | AgentToolProgressEvent
  | AgentResultEvent
  | AgentErrorEvent

/** Agent initialized — contains session ID for resume */
export interface AgentInitEvent {
  type: 'init'
  sessionId: string
  raw: unknown
}

/** System-level event (status changes, compaction, etc.) */
export interface AgentSystemEvent {
  type: 'system'
  subtype: string
  message?: string
  raw: unknown
}

/** Assistant text output */
export interface AgentAssistantTextEvent {
  type: 'assistant_text'
  text: string
  raw: unknown
}

/** Agent is invoking a tool */
export interface AgentToolUseEvent {
  type: 'tool_use'
  toolName: string
  toolUseId?: string
  input: Record<string, unknown>
  toolCategory?: import('../tools/tool-category.js').ToolCategory
  raw: unknown
}

/** Tool execution result */
export interface AgentToolResultEvent {
  type: 'tool_result'
  toolName?: string
  toolUseId?: string
  content: string
  isError: boolean
  raw: unknown
}

/** Tool execution progress update */
export interface AgentToolProgressEvent {
  type: 'tool_progress'
  toolName: string
  elapsedSeconds: number
  raw: unknown
}

/** Final result — agent has finished */
export interface AgentResultEvent {
  type: 'result'
  success: boolean
  /** Completion message (only on success) */
  message?: string
  /** Error messages (only on failure) */
  errors?: string[]
  /** Error subtype from the provider (e.g., 'error_during_execution', 'error_max_turns') */
  errorSubtype?: string
  /** Cost/usage data */
  cost?: AgentCostData
  raw: unknown
}

/** Error event */
export interface AgentErrorEvent {
  type: 'error'
  message: string
  code?: string
  raw: unknown
}

/** Cost and token usage data */
export interface AgentCostData {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  totalCostUsd?: number
  numTurns?: number
}
