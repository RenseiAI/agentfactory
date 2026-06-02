/**
 * Gemini Agent Provider
 *
 * First-class provider for Google Gemini (replaces the gemini→A2aProvider
 * stopgap from before the Gemini-first-class program).
 *
 * ---------------------------------------------------------------------------
 * Execution model — READ THIS BEFORE EXTENDING
 * ---------------------------------------------------------------------------
 * The PRODUCTION Gemini executor is the Go native runner in
 * `donmai/provider/gemini` (package `github.com/RenseiAI/donmai`). That runner
 * owns the full agentic loop: a multi-turn `generateContent` conversation with
 * native function-calling, a session-local tool executor (Bash/Read/Edit/Write)
 * that runs the model's `functionCall`s in-box, `thinkingConfig`-based
 * reasoning-effort, per-Spawn credential resolution, and post-completion
 * steering. The daemon spawns `donmai agent run` for each claimed session and
 * builds its runner.Registry there.
 *
 * This TypeScript layer is NOT a second Gemini execution engine. The TS
 * monorepo carries NO Gemini/Google SDK dependency (no `@google/genai`, no
 * `generativelanguage` client) by design — re-implementing the agentic loop in
 * TS would duplicate and inevitably diverge from the Go runner that actually
 * ships. The TS providers exist as the orchestration / routing / capability-
 * metadata surface:
 *   - `createProvider()` + the resolution cascade pick a provider name.
 *   - `selectProvider()` / `updatePosterior()` learn cross-provider routing.
 *   - `provider.capabilities` lets the orchestrator choose an exit-gate
 *     strategy and lets surfaces (Topology view, dashboards) render the
 *     provider honestly.
 *
 * Accordingly this provider:
 *   1. Declares capabilities that MIRROR the Go runner's `Capabilities()` so
 *      the orchestrator reasons correctly (REN-1245 capability-discrepancy
 *      detection compares declared vs observed; lying here would trip it).
 *   2. Does NOT masquerade as A2A. The previous stopgap returned an
 *      `A2aProvider` for `name === 'gemini'`, which silently spoke the A2A
 *      JSON-RPC protocol against `A2A_AGENT_URL` — wrong protocol, wrong
 *      capabilities (A2A declares `supportsReasoningEffort: false`), and a
 *      `name` of `'a2a'`. That is now replaced by this honest provider.
 *   3. Delegates `spawn()` / `resume()` with a clear, actionable error that
 *      points callers at the Go native runner rather than pretending to
 *      execute in-process. If/when a TS-side Gemini transport is introduced
 *      (e.g. a thin client that dials the Go runner, or a `@google/genai`
 *      dependency is added), wire it in `createHandle()` — the capability
 *      surface and routing wiring already treat Gemini as first-class.
 *
 * Reasoning-effort: `effortToGeminiOptions()` (config/effort.ts) maps our
 * EffortLevel ladder onto Gemini's `thinkingBudget`. The Go runner additionally
 * uses `thinking_level` for the 3.x model family; the TS metadata only needs to
 * declare that effort is honored (`supportsReasoningEffort: true`).
 */

import type {
  AgentProvider,
  AgentSpawnConfig,
  AgentHandle,
  AgentEvent,
} from './types.js'
import { effortToGeminiOptions } from '../config/effort.js'

/**
 * Map an AgentSpawnConfig's normalized effort to the Gemini reasoning knob.
 *
 * Exported for unit testing and so any future in-process transport can reuse
 * the exact same mapping the metadata advertises. Returns `undefined` when no
 * effort is set (the runner then uses the model-family default), mirroring the
 * Go runner's behaviour of only emitting `thinkingConfig` when an effort is
 * present on the Spec.
 */
export function resolveGeminiThinkingBudget(
  config: Pick<AgentSpawnConfig, 'effort'>,
): { thinkingBudget: number } | undefined {
  if (!config.effort) return undefined
  return effortToGeminiOptions(config.effort)
}

/**
 * Error emitted when `spawn()`/`resume()` are called on the TS GeminiProvider.
 *
 * The TS layer is metadata/routing-only for Gemini; the Go native runner is the
 * executor. This is a distinct subtype (not a bare `Error`) so callers can
 * detect the delegation boundary programmatically rather than string-matching.
 */
export class GeminiDelegatedExecutionError extends Error {
  readonly code = 'gemini_delegated_execution' as const
  constructor() {
    super(
      'Gemini execution is owned by the Go native runner (donmai/provider/gemini), ' +
        'not the TypeScript provider layer. The TS GeminiProvider supplies routing ' +
        'and capability metadata only — it does not run an agentic loop in-process. ' +
        'Sessions are executed via `donmai agent run` (the daemon-spawned worker builds ' +
        'the runner.Registry with the native Gemini provider). If you need a TS-side ' +
        'transport, add it to GeminiProvider.createHandle() in gemini-provider.ts.',
    )
    this.name = 'GeminiDelegatedExecutionError'
  }
}

/**
 * Gemini provider.
 *
 * Capabilities mirror the Go native runner's `Capabilities()` matrix
 * (donmai/provider/gemini/gemini.go):
 *   - supportsMessageInjection: true  — runner appends a user turn + re-drives
 *   - supportsSessionResume:    false — stateless REST endpoint (best-effort fold only)
 *   - supportsToolPlugins:      true  — native Bash/Read/Edit/Write functionCalls run in-box
 *   - supportsReasoningEffort:  true  — effort → thinkingConfig (thinkingBudget / thinking_level)
 *   - emitsSubagentEvents:      false — no Anthropic-style Task sub-agent stream
 *   - supportsCodeIntelligenceEnforcement: false
 *
 * supportsMcp is intentionally absent: there is NO in-box MCP client. The Go
 * runner declares `AcceptsMcpServerSpec: false`; `mcp__*` calls are not routed.
 * The TS AgentProviderCapabilities interface has no `supportsMcp` flag, and
 * `supportsToolPlugins` here means the NATIVE tool surface (not stdio MCP) — the
 * same meaning the Go runner documents. We therefore neither set a (non-existent)
 * `supportsMcp: false` field nor imply MCP support via toolPermissionFormat.
 */
export class GeminiProvider implements AgentProvider {
  readonly name = 'gemini' as const
  readonly capabilities = {
    // Runner appends a user turn to the maintained contents history and
    // re-drives the loop — no subprocess, no resume needed for steering.
    supportsMessageInjection: true,
    // Gemini's generateContent REST endpoint is stateless; the Go runner
    // declares SupportsSessionResume=false (resume is best-effort prompt-fold).
    supportsSessionResume: false,
    // Native tool surface: the session-local executor runs Bash/Read/Edit/Write
    // functionCalls in-box. This is NOT stdio MCP — there is no in-box MCP
    // client (Go runner: AcceptsMcpServerSpec=false). Matches the Go runner's
    // SupportsToolPlugins=true semantics (native tools, not MCP plugins).
    supportsToolPlugins: true,
    needsBaseInstructions: false,
    needsPermissionConfig: false,
    supportsCodeIntelligenceEnforcement: false,
    emitsSubagentEvents: false,
    // Effort maps to thinkingConfig — see effortToGeminiOptions / the Go
    // runner's thinkingConfigFor (thinking_level for 3.x, thinkingBudget for 2.5).
    supportsReasoningEffort: true,
    // No Claude-style permission grammar. Gemini gates tools via
    // toolConfig.functionCallingConfig.mode, not a pattern list, so we leave
    // toolPermissionFormat unset (it is optional and there is no 'gemini'
    // member in the ToolPermissionFormat union — adding one would imply a
    // Claude-grammar translation that does not exist).
    humanLabel: 'Gemini',
  } as const

  spawn(config: AgentSpawnConfig): AgentHandle {
    return this.createHandle(config)
  }

  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle {
    return this.createHandle(config, sessionId)
  }

  /**
   * Build a handle for a Gemini session.
   *
   * The TS layer does not execute Gemini agents (the Go native runner does —
   * see the file header). The handle therefore surfaces a single error event
   * and a terminal failure result that points operators at the real executor,
   * rather than silently producing no output or pretending to be A2A. The
   * effort→thinkingBudget mapping is computed here (and validated by tests) so
   * the delegation boundary is honest about what it would forward.
   */
  private createHandle(config: AgentSpawnConfig, _resumeSessionId?: string): AgentHandle {
    // Compute (but do not consume) the reasoning-effort mapping so the
    // metadata surface stays exercised and a future in-process transport has
    // the resolved knob ready. Side-effect-free.
    void resolveGeminiThinkingBudget(config)
    return new GeminiAgentHandle(config.abortController)
  }
}

/**
 * AgentHandle for Gemini sessions in the TS layer.
 *
 * Because execution is delegated to the Go native runner, this handle does not
 * open a network connection or spawn a child process. Its stream emits one
 * error event followed by a terminal failure result so the orchestrator's
 * post-session backstop sees an explicit, attributable outcome instead of a
 * silent no-op.
 */
class GeminiAgentHandle implements AgentHandle {
  sessionId: string | null = null
  private readonly abortController: AbortController

  constructor(abortController: AbortController) {
    this.abortController = abortController
  }

  get stream(): AsyncIterable<AgentEvent> {
    return this.createEventStream()
  }

  async injectMessage(_text: string): Promise<void> {
    // No in-process session to steer — the Go runner owns injection.
    throw new GeminiDelegatedExecutionError()
  }

  async stop(): Promise<void> {
    this.abortController.abort()
  }

  private async *createEventStream(): AsyncGenerator<AgentEvent> {
    const err = new GeminiDelegatedExecutionError()
    yield {
      type: 'error',
      message: err.message,
      code: err.code,
      raw: err,
    }
    yield {
      type: 'result',
      success: false,
      errors: [err.message],
      errorSubtype: err.code,
      raw: err,
    }
  }
}

/**
 * Create a new Gemini provider instance.
 */
export function createGeminiProvider(): GeminiProvider {
  return new GeminiProvider()
}
