/**
 * Claude Agent Provider
 *
 * Wraps @anthropic-ai/claude-agent-sdk to implement the AgentProvider interface.
 * Translates Claude SDK's `query()` and `SDKMessage` stream into normalized AgentEvents.
 */

import { spawn } from 'child_process'
import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type Query,
  type CanUseTool,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentProvider,
  AgentSpawnConfig,
  AgentHandle,
  AgentEvent,
} from './types.js'
import { evaluateCommandSafety } from './safety-rules.js'
import { buildAutonomousSystemPrompt } from './autonomous-system-prompt.js'

/**
 * Code intelligence enforcement configuration.
 * Passed from the orchestrator via AgentSpawnConfig.
 */
export interface CodeIntelEnforcementConfig {
  enforceUsage: boolean
  fallbackAfterAttempt: boolean
}

/**
 * Extract the code-intelligence category from an MCP tool name.
 * e.g. 'mcp__af-code-intelligence__af_code_search_symbols' → 'search_symbols'
 */
function getCodeIntelCategory(toolName: string): string | null {
  if (!toolName.includes('af_code_')) return null
  const match = toolName.match(/af_code_(\w+)/)
  return match ? match[1] : null
}

/**
 * Factory that creates a per-session CanUseTool callback for autonomous agents.
 *
 * Filesystem-based hooks (.claude/hooks/auto-approve.js) may not load
 * correctly in git worktrees where .git is a file (not a directory),
 * because the SDK's project root resolution can fail to find .claude/.
 *
 * This callback acts as a reliable fallback — it evaluates permissions
 * in-process without filesystem dependencies.
 *
 * When code intelligence enforcement is configured, Grep and Glob calls
 * are denied with a redirect message until the agent has tried at least
 * one af_code_* tool. This forces agents to use the higher-quality
 * code-intelligence search tools before falling back to raw search.
 */
export function createAutonomousCanUseTool(enforcement?: CodeIntelEnforcementConfig): CanUseTool {
  // Per-session state: which code-intelligence categories have been attempted
  const codeIntelAttempted = new Set<string>()

  return async (toolName, input) => {
    // --- Code intelligence enforcement ---
    // Track af_code_* usage so fallback can be unlocked
    const category = getCodeIntelCategory(toolName)
    if (category) {
      codeIntelAttempted.add(category)
    }

    // Redirect Grep/Glob when enforcement is active and agent hasn't tried code-intel yet
    if (
      enforcement?.enforceUsage &&
      (toolName === 'Grep' || toolName === 'Glob')
    ) {
      const fallbackUnlocked = enforcement.fallbackAfterAttempt && codeIntelAttempted.size > 0
      if (!fallbackUnlocked) {
        return {
          behavior: 'deny',
          message: [
            `${toolName} is temporarily blocked. You have af_code_* tools available that provide better code intelligence.`,
            'Try one of these first:',
            '- mcp__af-code-intelligence__af_code_get_repo_map — Get a ranked map of important files',
            '- mcp__af-code-intelligence__af_code_search_symbols — Find symbol definitions (functions, classes, types)',
            '- mcp__af-code-intelligence__af_code_search_code — BM25 keyword search with code-aware tokenization',
            '',
            enforcement.fallbackAfterAttempt
              ? `After using any af_code_* tool, ${toolName} will be unlocked as a fallback.`
              : `${toolName} is disabled for this session. Use af_code_* tools instead.`,
          ].join('\n'),
        }
      }
    }

    // --- Existing permission logic ---

    // Read-only tools: always allow
    if (['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'].includes(toolName)) {
      return { behavior: 'allow', updatedInput: input }
    }

    // File write tools: always allow (permissionMode: 'acceptEdits' should
    // handle these, but be explicit as a safety net)
    if (['Write', 'Edit', 'NotebookEdit'].includes(toolName)) {
      return { behavior: 'allow', updatedInput: input }
    }

    // Agent tool: always force foreground execution.
    // Coordinators that spawn sub-agents with run_in_background=true exit
    // before sub-agents finish, orphaning work. Strip the flag so the Agent
    // tool blocks until the sub-agent completes.
    if (toolName === 'Agent') {
      if (input.run_in_background) {
        const { run_in_background: _, ...rest } = input
        return { behavior: 'allow', updatedInput: rest }
      }
      return { behavior: 'allow', updatedInput: input }
    }

    // Task management and planning
    if (['Task', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
         'EnterPlanMode', 'ExitPlanMode', 'Skill'].includes(toolName)) {
      return { behavior: 'allow', updatedInput: input }
    }

    // Bash: evaluate command safety via shared rules
    if (toolName === 'Bash') {
      const cmd = (typeof input.command === 'string' ? input.command : '').trim()
      if (!cmd) return { behavior: 'allow', updatedInput: input }

      const safety = evaluateCommandSafety(cmd)
      if (safety.denied) {
        return { behavior: 'deny', message: safety.reason ?? 'command blocked by safety rules' }
      }

      // Allow everything else — autonomous agents run in isolated worktrees
      // managed by the orchestrator, with guardrails at the process level.
      return { behavior: 'allow', updatedInput: input }
    }

    // MCP tools: block Linear (agents must use `rensei linear` CLI — or
    // `af linear` in OSS environments without the rensei binary)
    if (toolName.startsWith('mcp__') && toolName.includes('Linear')) {
      return {
        behavior: 'deny',
        message: 'Linear MCP tools are not available. Use `rensei linear` CLI (or `af linear` in OSS environments) instead. See CLAUDE.md for the full command reference.',
      }
    }

    // MCP tools: allow others (Vercel, Gmail, etc.)
    if (toolName.startsWith('mcp__')) {
      return { behavior: 'allow', updatedInput: input }
    }

    // Default: allow — autonomous agents should not be blocked by prompts
    return { behavior: 'allow', updatedInput: input }
  }
}

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const
  readonly capabilities = {
    supportsMessageInjection: true,
    supportsSessionResume: true,
    supportsToolPlugins: true,
    needsBaseInstructions: false,
    needsPermissionConfig: false,
    supportsCodeIntelligenceEnforcement: true,
    toolPermissionFormat: 'claude' as const,
    emitsSubagentEvents: true,
    // Claude SDK accepts `effort` directly (1:1 with our
    // EffortLevel ladder — see effortToClaudeOptions).
    supportsReasoningEffort: true,
    humanLabel: 'Claude',
  } as const

  spawn(config: AgentSpawnConfig): AgentHandle {
    return this.createHandle(config)
  }

  resume(sessionId: string, config: AgentSpawnConfig): AgentHandle {
    return this.createHandle(config, sessionId)
  }

  private createHandle(config: AgentSpawnConfig, resumeSessionId?: string): AgentHandle {
    const abortController = config.abortController

    // Default allowed tools for autonomous agents — ensures bash commands
    // are auto-approved without needing settings.local.json (which isn't
    // available in worktrees). The canUseTool callback handles deny-listing
    // destructive commands; allowedTools just needs to be permissive enough
    // that headless agents aren't blocked by missing permission prompts.
    // Format: Bash(prefix:glob) — colon separates prefix from wildcard.
    const defaultAllowedTools = config.autonomous
      ? [
          'Bash(pnpm:*)',
          'Bash(git:*)',
          'Bash(gh:*)',
          'Bash(node:*)',
          'Bash(npx:*)',
          'Bash(npm:*)',
          'Bash(tsx:*)',
          'Bash(python3:*)',
          'Bash(python:*)',
          'Bash(curl:*)',
          'Bash(turbo:*)',
          'Bash(tsc:*)',
          'Bash(vitest:*)',
          'Bash(jest:*)',
          'Bash(claude:*)',
          // Shell builtins and navigation — cd, pwd, echo, etc.
          'Bash(cd:*)',
          'Bash(pwd:*)',
          'Bash(echo:*)',
          'Bash(cat:*)',
          'Bash(ls:*)',
          'Bash(find:*)',
          'Bash(grep:*)',
          'Bash(rg:*)',
          'Bash(which:*)',
          'Bash(head:*)',
          'Bash(tail:*)',
          'Bash(wc:*)',
          'Bash(mkdir:*)',
          'Bash(cp:*)',
          'Bash(mv:*)',
          'Bash(touch:*)',
          'Bash(chmod:*)',
          'Bash(sed:*)',
          'Bash(awk:*)',
          'Bash(sort:*)',
          'Bash(uniq:*)',
          'Bash(diff:*)',
          'Bash(xargs:*)',
          'Bash(env:*)',
          'Bash(export:*)',
          'Bash(source:*)',
          'Bash(lsof:*)',
          // Non-Node project support: common build tools and shell scripts
          'Bash(make:*)',
          'Bash(cmake:*)',
          'Bash(cargo:*)',
          'Bash(rustc:*)',
          'Bash(go:*)',
          // iOS/Apple development tools
          'Bash(xcodebuild:*)',
          'Bash(xcrun:*)',
          'Bash(xcodegen:*)',
          'Bash(swift:*)',
          'Bash(swiftlint:*)',
          'Bash(bash:*)',
          'Bash(sh:*)',
          'Bash(./:*)',
          // In-process MCP tools from registered plugins (code intelligence, etc.)
          ...(config.mcpToolNames ?? []),
        ]
      : []

    // Convert stdio server configs to SDK McpStdioServerConfig format.
    // Stdio servers propagate to sub-agents (in-process servers don't).
    const mcpServers: Record<string, { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }> | undefined =
      config.mcpStdioServers && config.mcpStdioServers.length > 0
        ? Object.fromEntries(
            config.mcpStdioServers.map(s => [
              s.name,
              { type: 'stdio' as const, command: s.command, args: s.args, env: s.env },
            ])
          )
        : undefined

    const agentQuery = query({
      prompt: config.prompt,
      options: {
        cwd: config.cwd,
        env: config.env,
        abortController,
        mcpServers,
        maxTurns: config.maxTurns,
        ...(config.model ? { model: config.model } : {}),
        // Pass effort level to Claude SDK if configured (maps 1:1 to Claude's effort levels)
        ...(config.effort ? { effort: config.effort } : {}),
        allowedTools: config.allowedTools ?? defaultAllowedTools,
        // Programmatic permission handler for autonomous agents.
        // Filesystem hooks may not resolve in worktrees — this callback
        // ensures headless agents are never blocked by permission prompts.
        canUseTool: config.autonomous ? createAutonomousCanUseTool(config.codeIntelligenceEnforcement) : undefined,
        permissionMode: 'acceptEdits',
        disallowedTools: config.autonomous
          ? [
              'AskUserQuestion',
              // Block Linear MCP tools — agents must use `rensei linear` CLI.
              // disallowedTools is a hard block at the SDK level, more reliable
              // than canUseTool which may race with MCP tool execution.
              'mcp__claude_ai_Linear__get_issue',
              'mcp__claude_ai_Linear__list_issues',
              'mcp__claude_ai_Linear__save_issue',
              'mcp__claude_ai_Linear__create_comment',
              'mcp__claude_ai_Linear__list_comments',
              'mcp__claude_ai_Linear__get_issue_status',
              'mcp__claude_ai_Linear__list_issue_statuses',
              'mcp__claude_ai_Linear__create_issue_label',
              'mcp__claude_ai_Linear__list_issue_labels',
              'mcp__claude_ai_Linear__get_team',
              'mcp__claude_ai_Linear__list_teams',
              'mcp__claude_ai_Linear__get_user',
              'mcp__claude_ai_Linear__list_users',
              'mcp__claude_ai_Linear__get_project',
              'mcp__claude_ai_Linear__list_projects',
              'mcp__claude_ai_Linear__list_project_labels',
              'mcp__claude_ai_Linear__search_documentation',
              'mcp__claude_ai_Linear__get_document',
              'mcp__claude_ai_Linear__list_documents',
              'mcp__claude_ai_Linear__create_document',
              'mcp__claude_ai_Linear__update_document',
              'mcp__claude_ai_Linear__get_milestone',
              'mcp__claude_ai_Linear__list_milestones',
              'mcp__claude_ai_Linear__save_milestone',
              'mcp__claude_ai_Linear__save_project',
              'mcp__claude_ai_Linear__list_cycles',
              'mcp__claude_ai_Linear__get_attachment',
              'mcp__claude_ai_Linear__create_attachment',
              'mcp__claude_ai_Linear__delete_attachment',
              'mcp__claude_ai_Linear__extract_images',
            ]
          : [],
        settingSources: config.autonomous ? [] : ['project'],
        systemPrompt: config.autonomous
          ? buildAutonomousSystemPrompt({
              worktreePath: config.cwd,
              hasCodeIntelligence: (config.mcpToolNames ?? []).some(n => n.includes('af_code_')),
              codeIntelToolNames: config.mcpToolNames?.filter(n => n.includes('af_code_')),
              codeIntelEnforced: config.codeIntelligenceEnforcement?.enforceUsage ?? false,
              useToolPlugins: (config.mcpToolNames ?? []).length > 0,
              linearCli: 'rensei linear',
              systemPromptAppend: config.systemPromptAppend,
            })
          : { type: 'preset' as const, preset: 'claude_code' as const },
        resume: resumeSessionId,
        sandbox: config.sandboxEnabled
          ? {
              enabled: true,
              autoAllowBashIfSandboxed: true,
              excludedCommands: ['git', 'gh', 'pnpm', 'npm', 'npx', 'node', 'vercel'],
              network: {
                allowLocalBinding: true,
                allowAllUnixSockets: true,
                allowedDomains: ['*'],
              },
            }
          : { enabled: false },
        spawnClaudeCodeProcess: (spawnOptions) => {
          // Use the command provided by the SDK — it points to the bundled
          // Claude Code binary (e.g., claude-agent-sdk-darwin-arm64/claude).
          const claudePath = spawnOptions.command
          const args = spawnOptions.args || []
          const child = spawn(claudePath, args, {
            cwd: spawnOptions.cwd,
            env: spawnOptions.env,
            stdio: ['pipe', 'pipe', 'pipe'],
          })

          config.onProcessSpawned?.(child.pid)

          // Capture stderr for diagnostics on unexpected exits
          let stderrBuffer = ''
          child.stderr?.on('data', (data: Buffer) => {
            stderrBuffer += data.toString()
          })

          child.on('error', (err) => {
            console.error('[ClaudeProvider] Child process error:', err.message)
          })

          child.on('exit', (code, signal) => {
            if (code !== 0 && code !== null) {
              console.error(`[ClaudeProvider] Process exited with code ${code}${signal ? ` signal ${signal}` : ''}`)
              if (stderrBuffer.trim()) {
                console.error(`[ClaudeProvider] stderr: ${stderrBuffer.trim().substring(0, 2000)}`)
              }
            }
          })

          if (spawnOptions.signal) {
            const abortHandler = () => {
              child.kill('SIGTERM')
            }
            spawnOptions.signal.addEventListener('abort', abortHandler)
            child.once('exit', () => {
              spawnOptions.signal.removeEventListener('abort', abortHandler)
            })
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return child as any
        },
      },
    })

    return new ClaudeAgentHandle(agentQuery, abortController)
  }
}

/**
 * AgentHandle implementation wrapping a Claude SDK Query object.
 */
class ClaudeAgentHandle implements AgentHandle {
  sessionId: string | null = null
  private readonly agentQuery: Query
  private readonly abortController: AbortController

  constructor(agentQuery: Query, abortController: AbortController) {
    this.agentQuery = agentQuery
    this.abortController = abortController
  }

  get stream(): AsyncIterable<AgentEvent> {
    return this.createEventStream()
  }

  async injectMessage(text: string): Promise<void> {
    const sessionId = this.sessionId
    async function* userMessageGenerator(): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        message: {
          role: 'user',
          content: text,
        },
        parent_tool_use_id: null,
        session_id: sessionId || '',
      }
    }

    await this.agentQuery.streamInput(userMessageGenerator())
  }

  async stop(): Promise<void> {
    this.abortController.abort()
  }

  /**
   * Returns the underlying Query object for direct access if needed.
   * This is an escape hatch — prefer using the AgentHandle interface.
   */
  getRawQuery(): Query {
    return this.agentQuery
  }

  private async *createEventStream(): AsyncGenerator<AgentEvent> {
    for await (const message of this.agentQuery) {
      const events = this.mapSDKMessage(message)
      for (const event of events) {
        yield event
      }
    }
  }

  /**
   * Map a single SDKMessage to one or more AgentEvents.
   * Most messages map 1:1, but assistant messages with multiple content blocks
   * may produce multiple events.
   */
  private mapSDKMessage(message: SDKMessage): AgentEvent[] {
    switch (message.type) {
      case 'system':
        return this.mapSystemMessage(message)
      case 'user':
        return this.mapUserMessage(message)
      case 'assistant':
        return this.mapAssistantMessage(message)
      case 'result':
        return this.mapResultMessage(message)
      case 'tool_progress':
        return [{
          type: 'tool_progress',
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          raw: message,
        }]
      case 'stream_event':
        // Partial streaming — skip (high frequency, low value for orchestrator)
        return []
      case 'auth_status':
        if (message.error) {
          return [{
            type: 'error',
            message: message.error,
            raw: message,
          }]
        }
        return [{
          type: 'system',
          subtype: 'auth_status',
          message: message.isAuthenticating ? 'Authenticating...' : 'Authenticated',
          raw: message,
        }]
      default:
        return [{
          type: 'system',
          subtype: 'unknown',
          message: `Unhandled message type: ${(message as { type: string }).type}`,
          raw: message,
        }]
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapSystemMessage(message: any): AgentEvent[] {
    if (message.subtype === 'init') {
      this.sessionId = message.session_id
      return [{
        type: 'init',
        sessionId: message.session_id,
        raw: message,
      }]
    }

    return [{
      type: 'system',
      subtype: message.subtype ?? 'unknown',
      message: message.status ?? message.message,
      raw: message,
    }]
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapUserMessage(message: any): AgentEvent[] {
    const events: AgentEvent[] = []

    if (message.message?.content) {
      for (const block of message.message.content) {
        if (
          typeof block === 'object' &&
          block !== null &&
          'type' in block &&
          block.type === 'tool_result' &&
          'content' in block
        ) {
          events.push({
            type: 'tool_result',
            toolUseId: 'tool_use_id' in block ? String(block.tool_use_id) : undefined,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            isError: 'is_error' in block && block.is_error === true,
            raw: message,
          })
        }
      }
    }

    // If no tool results were extracted, emit as a generic system event
    if (events.length === 0) {
      events.push({
        type: 'system',
        subtype: 'user_message',
        raw: message,
      })
    }

    return events
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapAssistantMessage(message: any): AgentEvent[] {
    const events: AgentEvent[] = []

    if (message.message?.content) {
      for (const block of message.message.content) {
        if (block.type === 'text' && block.text) {
          events.push({
            type: 'assistant_text',
            text: block.text,
            raw: message,
          })
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'tool_use',
            toolName: block.name,
            toolUseId: block.id,
            input: block.input as Record<string, unknown>,
            raw: message,
          })
        }
      }
    }

    return events
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mapResultMessage(message: any): AgentEvent[] {
    if (message.subtype === 'success') {
      return [{
        type: 'result',
        success: true,
        message: message.result,
        cost: {
          totalCostUsd: message.total_cost_usd,
          numTurns: message.num_turns,
        },
        raw: message,
      }]
    }

    // Error result
    return [{
      type: 'result',
      success: false,
      errors: 'errors' in message && message.errors ? message.errors : [],
      errorSubtype: message.subtype,
      raw: message,
    }]
  }
}

/**
 * Create a new Claude provider instance
 */
export function createClaudeProvider(): ClaudeProvider {
  return new ClaudeProvider()
}
