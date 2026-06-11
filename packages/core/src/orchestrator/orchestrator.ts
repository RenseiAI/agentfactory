/**
 * Agent Orchestrator
 * Spawns concurrent Claude agents to work on Linear backlog issues
 * Uses the Claude Agent SDK for programmatic control
 */

import { randomUUID } from 'crypto'
import { execSync } from 'child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { resolve, dirname, basename, isAbsolute } from 'path'
import { parse as parseDotenv } from 'dotenv'
import {
  type AgentProvider,
  type AgentHandle,
  type AgentEvent,
  type AgentSpawnConfig,
  createProvider,
  resolveProviderName,
  resolveProviderWithSource,
  resolveModelWithSource,
  resolveSubAgentModel,
  type AgentProviderName,
  type ProvidersConfig,
  type ModelsConfig,
} from '../providers/index.js'
import { buildSafetyInstructions } from '../providers/safety-rules.js'
import { buildBaseInstructionsFromShared } from '../providers/agent-instructions.js'
import {
  initializeAgentDir,
  writeState,
  updateState,
  writeTodos,
  createInitialState,
  checkRecovery,
  buildRecoveryPrompt,
  getHeartbeatTimeoutFromEnv,
  getMaxRecoveryAttemptsFromEnv,
} from './state-recovery.js'
import { createHeartbeatWriter, getHeartbeatIntervalFromEnv, type HeartbeatWriter } from './heartbeat-writer.js'
import { createProgressLogger, type ProgressLogger } from './progress-logger.js'
import { createSessionLogger, type SessionLogger } from './session-logger.js'
import { ContextManager } from './context-manager.js'
import { isSessionLoggingEnabled, isAutoAnalyzeEnabled, getLogAnalysisConfig } from './log-config.js'
import type { WorktreeState, TodosState, TodoItem } from './state-types.js'
import type { AgentWorkType, WorkTypeStatusMappings } from './work-types.js'
import type { IssueTrackerClient, IssueTrackerSession } from './issue-tracker-client.js'
import { parseWorkResult } from './parse-work-result.js'
import { parseSecurityScanOutput } from './security-scan-event.js'
import { runBackstop, formatBackstopComment, type SessionContext } from './session-backstop.js'
import {
  inspectGitStateForSteering,
  decideSteering,
  buildSteeringPrompt,
  runSteeringRetry,
} from './session-steering.js'
import {
  captureQualityBaseline,
  computeQualityDelta,
  formatQualityReport,
  saveBaseline,
  loadBaseline,
  type QualityConfig,
} from './quality-baseline.js'
import { createActivityEmitter, type ActivityEmitter } from './activity-emitter.js'
import { createApiActivityEmitter, type ApiActivityEmitter } from './api-activity-emitter.js'
import { createLogger, type Logger } from '../logger.js'
import { TemplateRegistry, CodexToolPermissionAdapter, createToolPermissionAdapter } from '../templates/index.js'
import { loadRepositoryConfig, getProjectConfig, getProjectPath, getProvidersConfig, getModelsConfig, getProfilesConfig, getDispatchConfig, resolveProfileForSpawn } from '../config/index.js'
import type { ProfileConfig, DispatchConfig, ResolvedProfile } from '../config/index.js'
import type { RepositoryConfig } from '../config/index.js'
import { ToolRegistry } from '../tools/index.js'
import type { ToolPlugin } from '../tools/index.js'
import type { TemplateContext } from '../templates/index.js'
import { getLockFileName, getInstallCommand, getAddCommand, type PackageManager } from '../package-manager.js'
import { createMergeQueueAdapter } from '../merge-queue/index.js'
import {
  isBranchConflictError as isBranchConflictErrorShared,
  parseConflictingWorktreePath as parseConflictingWorktreePathShared,
} from '../merge-queue/branch-conflict.js'
import type {
  OrchestratorConfig,
  OrchestratorIssue,
  AgentProcess,
  OrchestratorEvents,
  SpawnAgentOptions,
  OrchestratorResult,
  OrchestratorStreamConfig,
  StopAgentResult,
  ForwardPromptResult,
  InjectMessageResult,
  SpawnAgentWithResumeOptions,
} from './types.js'
import {
  loadSettingsEnv,
  loadAppEnvFiles,
  generatePromptForWorkType,
} from './spawn-helpers.js'
import {
  extractShellCommand,
  isGrepGlobShellCommand,
  isToolRelatedError,
  extractToolNameFromError,
  mergeMentionContext,
  shouldDeferAcceptanceTransition,
  detectWorkType as detectWorkTypeHelper,
  WORK_TYPE_SUFFIX,
} from './dispatcher.js'
import {
  findRepoRoot,
  resolveMainRepoRoot,
  resolveWorktreePath,
  checkForIncompleteWork,
  checkForPushedWorkWithoutPR,
  getWorktreeIdentifier,
  validateWorktree as workareaValidateWorktree,
  isMainWorktree as workareaIsMainWorktree,
  isInsideWorktreesDir as workareaIsInsideWorktreesDir,
  tryCleanupConflictingWorktree as workareaTryCleanupConflictingWorktree,
  handleBranchConflict as workareaHandleBranchConflict,
  createWorktree as workareaCreateWorktree,
  removeWorktree as workareaRemoveWorktree,
  bootstrapWorktreeDeps as workareaBootstrapWorktreeDeps,
  configureMergiraf as workareaConfigureMergiraf,
} from '../workarea/git-worktree.js'
import {
  linkDependencies as workareaLinkDependencies,
  syncDependencies as workareaSyncDependencies,
} from '../workarea/dep-linker.js'
import {
  buildArchitecturalContext,
  flushSessionObservations,
  type ContextInjectionConfig,
} from './context-injection.js'
import { shouldFlushObservations } from './session-supervisor.js'
import {
  processEventStream as processEventStreamImpl,
  handleAgentEvent as handleAgentEventImpl,
} from './event-processor.js'
import {
  spawnAgent as spawnAgentImpl,
  spawnAgentForIssue as spawnAgentForIssueImpl,
  spawnAgentWithResume as spawnAgentWithResumeImpl,
  attemptSessionSteering as attemptSessionSteeringImpl,
  createResumeWithFallbackHandle as createResumeWithFallbackHandleImpl,
} from './agent-spawner.js'
import type { ArchitecturalIntelligence } from '@donmai/architectural-intelligence'

// Default inactivity timeout: 5 minutes
const DEFAULT_INACTIVITY_TIMEOUT_MS = 300000
// Coordination inactivity timeout: 30 minutes.
// Coordinators spawn foreground sub-agents via the Agent tool. During sub-agent
// execution the parent event stream is silent (no tool_progress events), so the
// standard 5-minute inactivity timeout kills coordinators prematurely. 30 minutes
// gives sub-agents ample time to complete complex work.
const COORDINATION_INACTIVITY_TIMEOUT_MS = 1800000
// Default max session timeout: unlimited (undefined)
const DEFAULT_MAX_SESSION_TIMEOUT_MS: number | undefined = undefined

// Env vars that Claude Code interprets for authentication/routing. If these
// leak into agent processes from app .env.local files, Claude Code switches
// from Max subscription billing to API-key billing. Apps that need an
// Anthropic API key should use a namespaced name instead (e.g.
// MYAPP_ANTHROPIC_API_KEY) which won't be recognised by Claude Code.
const AGENT_ENV_BLOCKLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENCLAW_GATEWAY_TOKEN',
]

/**
 * Validate that the git remote origin URL contains the expected repository pattern.
 * Supports both HTTPS (github.com/org/repo) and SSH (git@github.com:org/repo) formats.
 *
 * @param expectedRepo - The expected repository pattern (e.g. 'github.com/RenseiAI/donmai-libraries')
 * @param cwd - Working directory to run git commands in
 * @throws Error if the git remote does not match the expected repository
 */
export function validateGitRemote(expectedRepo: string, cwd?: string): void {
  let remoteUrl: string
  try {
    remoteUrl = execSync('git remote get-url origin', {
      encoding: 'utf-8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    throw new Error(
      `Repository validation failed: could not get git remote URL. Expected '${expectedRepo}'.`
    )
  }

  // Normalize: convert SSH format (git@github.com:org/repo.git) to comparable form
  const normalizedRemote = remoteUrl
    .replace(/^git@([^:]+):/, '$1/')  // git@github.com:org/repo -> github.com/org/repo
    .replace(/^https?:\/\//, '')       // https://github.com/org/repo -> github.com/org/repo
    .replace(/\.git$/, '')             // remove trailing .git

  const normalizedExpected = expectedRepo
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')

  if (!normalizedRemote.includes(normalizedExpected)) {
    throw new Error(
      `Repository mismatch: expected '${expectedRepo}' but git remote is '${remoteUrl}'. Refusing to proceed.`
    )
  }
}

const DEFAULT_CONFIG: Required<Omit<OrchestratorConfig, 'linearApiKey' | 'project' | 'provider' | 'streamConfig' | 'apiActivityConfig' | 'workTypeTimeouts' | 'maxSessionTimeoutMs' | 'templateDir' | 'repository' | 'issueTrackerClient' | 'statusMappings' | 'toolPlugins' | 'mergeQueueAdapter' | 'mergeQueueStorage' | 'fileReservation' | 'deployProvider' | 'architecturalIntelligence' | 'architecturalContextMaxTokens'>> & {
  streamConfig: OrchestratorStreamConfig
  maxSessionTimeoutMs?: number
} = {
  maxConcurrent: 3,
  worktreePath: '../{repoName}.wt',
  autoTransition: true,
  // Preserve worktree when PR creation fails to prevent data loss
  preserveWorkOnPrFailure: true,
  // Sandbox disabled by default due to known bugs:
  // - https://github.com/anthropics/claude-code/issues/14162
  // - https://github.com/anthropics/claude-code/issues/12150
  sandboxEnabled: false,
  streamConfig: {
    minInterval: 500,
    maxOutputLength: 2000,
    includeTimestamps: false,
  },
  // Inactivity timeout: agent is stopped if no activity for this duration
  inactivityTimeoutMs: DEFAULT_INACTIVITY_TIMEOUT_MS,
  // Max session timeout: hard cap on runtime (unlimited by default)
  maxSessionTimeoutMs: DEFAULT_MAX_SESSION_TIMEOUT_MS,
}

// loadSettingsEnv, loadAppEnvFiles, generatePromptForWorkType imported from spawn-helpers.ts above (REN-1284)

// Re-exported from workarea/git-worktree.ts (REN-1284 decomposition)
// Keep identical signatures here so consumers don't break.
export {
  findRepoRoot,
  resolveMainRepoRoot,
  resolveWorktreePath,
} from '../workarea/git-worktree.js'

// Re-exported from workarea/git-worktree.ts (REN-1284 decomposition)
export type { IncompleteWorkCheck, PushedWorkCheck } from '../workarea/git-worktree.js'
export {
  checkForIncompleteWork,
  checkForPushedWorkWithoutPR,
} from '../workarea/git-worktree.js'

// Re-exported from dispatcher.ts (REN-1284 decomposition)
export {
  mergeMentionContext,
  shouldDeferAcceptanceTransition,
  extractShellCommand,
  isGrepGlobShellCommand,
} from './dispatcher.js'

// Re-exported from workarea/git-worktree.ts and dispatcher.ts (REN-1284 decomposition)
export { getWorktreeIdentifier } from '../workarea/git-worktree.js'
export { detectWorkType } from './dispatcher.js'

export class AgentOrchestrator {
  /** @internal */ readonly config: Required<Omit<OrchestratorConfig, 'project' | 'provider' | 'streamConfig' | 'apiActivityConfig' | 'workTypeTimeouts' | 'maxSessionTimeoutMs' | 'templateDir' | 'repository' | 'issueTrackerClient' | 'statusMappings' | 'toolPlugins' | 'mergeQueueAdapter' | 'mergeQueueStorage' | 'fileReservation' | 'deployProvider' | 'architecturalIntelligence' | 'architecturalContextMaxTokens'>> & {
    project?: string
    repository?: string
    streamConfig: OrchestratorStreamConfig
    apiActivityConfig?: OrchestratorConfig['apiActivityConfig']
    workTypeTimeouts?: OrchestratorConfig['workTypeTimeouts']
    maxSessionTimeoutMs?: number
    fileReservation?: OrchestratorConfig['fileReservation']
  }
  /** @internal */ readonly client: IssueTrackerClient
  /** @internal */ readonly statusMappings: WorkTypeStatusMappings
  /** @internal */ readonly events: OrchestratorEvents
  /** @internal */ readonly activeAgents: Map<string, AgentProcess> = new Map()
  /** @internal */ readonly agentHandles: Map<string, AgentHandle> = new Map()
  /** @internal */ provider: AgentProvider
  /** @internal */ readonly providerCache: Map<AgentProviderName, AgentProvider> = new Map()
  /** @internal */ configProviders?: ProvidersConfig
  /** @internal */ configModels?: ModelsConfig
  /** @internal */ profiles?: Record<string, ProfileConfig>
  /** @internal */ dispatchConfig?: DispatchConfig
  /** @internal */ readonly agentSessions: Map<string, IssueTrackerSession> = new Map()
  /** @internal */ readonly activityEmitters: Map<string, ActivityEmitter | ApiActivityEmitter> = new Map()
  // Track session ID to issue ID mapping for stop signal handling
  /** @internal */ readonly sessionToIssue: Map<string, string> = new Map()
  // Track AbortControllers for stopping agents
  /** @internal */ readonly abortControllers: Map<string, AbortController> = new Map()
  // Loggers per agent for structured output
  /** @internal */ readonly agentLoggers: Map<string, Logger> = new Map()
  // Heartbeat writers per agent for crash detection
  /** @internal */ readonly heartbeatWriters: Map<string, HeartbeatWriter> = new Map()
  // Progress loggers per agent for debugging
  /** @internal */ readonly progressLoggers: Map<string, ProgressLogger> = new Map()
  // Session loggers per agent for verbose analysis logging
  /** @internal */ readonly sessionLoggers: Map<string, SessionLogger> = new Map()
  /** @internal */ readonly contextManagers: Map<string, ContextManager> = new Map()
  // Session output flags for completion contract validation (keyed by issueId)
  /** @internal */ readonly sessionOutputFlags: Map<string, { commentPosted: boolean; issueUpdated: boolean; subIssuesCreated: boolean }> = new Map()
  // Stored spawn configs so the session-steering retry can resume with the same
  // model/effort/sandbox/env as the original session. Keyed by issueId.
  /** @internal */ readonly steeringSpawnConfigs: Map<string, AgentSpawnConfig> = new Map()
  // Buffered assistant text for batched logging (keyed by issueId)
  // Streaming providers (Codex) send one token per event — buffer and flush on sentence boundaries
  /** @internal */ readonly assistantTextBuffers: Map<string, { text: string; timer: ReturnType<typeof setTimeout> | null }> = new Map()
  /** Tracks pending tool_use events by issueId→toolUseId for context emission on tool_result */
  /** @internal */ readonly pendingToolCalls: Map<string, Map<string, { toolName: string; input: Record<string, unknown> }>> = new Map()
  // Flag to prevent promoting agents during fleet shutdown
  /** @internal */ shuttingDown = false
  // Template registry for configurable workflow prompts
  /** @internal */ readonly templateRegistry: TemplateRegistry | null
  // Allowlisted project names from .donmai/config.yaml
  /** @internal */ allowedProjects?: string[]
  // Full repository config from .donmai/config.yaml
  /** @internal */ repoConfig?: RepositoryConfig
  // Project-to-path mapping from .donmai/config.yaml (monorepo support)
  /** @internal */ projectPaths?: Record<string, string>
  // Shared paths from .donmai/config.yaml (monorepo support)
  /** @internal */ sharedPaths?: string[]
  // Linear CLI command from .donmai/config.yaml (non-Node project support)
  /** @internal */ linearCli?: string
  // Package manager from .donmai/config.yaml (non-Node project support)
  /** @internal */ packageManager?: string
  // Configurable build/test/validate commands from .donmai/config.yaml
  /** @internal */ buildCommand?: string
  /** @internal */ testCommand?: string
  /** @internal */ validateCommand?: string
  // Tool plugin registry for in-process agent tools
  /** @internal */ readonly toolRegistry: ToolRegistry
  // Merge queue adapter for automated merge operations (initialized from config or repo config)
  /** @internal */ mergeQueueAdapter?: import('../merge-queue/types.js').MergeQueueAdapter
  // Git repository root for running git commands (resolved from worktreePath or cwd)
  /** @internal */ readonly gitRoot: string
  // Architectural Intelligence for session-start context injection (REN-1316)
  /** @internal */ readonly contextInjectionConfig: ContextInjectionConfig

  constructor(config: OrchestratorConfig = {}, events: OrchestratorEvents = {}) {
    // Validate that an issue tracker client is available
    if (!config.issueTrackerClient) {
      const apiKey = config.linearApiKey ?? process.env.LINEAR_API_KEY
      if (!apiKey) {
        throw new Error('Either issueTrackerClient or LINEAR_API_KEY is required')
      }
    }

    // Parse timeout config from environment variables (can be overridden by config)
    const envInactivityTimeout = process.env.AGENT_INACTIVITY_TIMEOUT_MS
      ? parseInt(process.env.AGENT_INACTIVITY_TIMEOUT_MS, 10)
      : undefined
    const envMaxSessionTimeout = process.env.AGENT_MAX_SESSION_TIMEOUT_MS
      ? parseInt(process.env.AGENT_MAX_SESSION_TIMEOUT_MS, 10)
      : undefined

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      linearApiKey: config.linearApiKey ?? process.env.LINEAR_API_KEY ?? '',
      streamConfig: {
        ...DEFAULT_CONFIG.streamConfig,
        ...config.streamConfig,
      },
      apiActivityConfig: config.apiActivityConfig,
      workTypeTimeouts: config.workTypeTimeouts,
      // Config takes precedence over env vars, which take precedence over defaults
      inactivityTimeoutMs: config.inactivityTimeoutMs ?? envInactivityTimeout ?? DEFAULT_CONFIG.inactivityTimeoutMs,
      maxSessionTimeoutMs: config.maxSessionTimeoutMs ?? envMaxSessionTimeout ?? DEFAULT_CONFIG.maxSessionTimeoutMs,
    }
    // Resolve git root from cwd — use resolveMainRepoRoot first so that when the
    // orchestrator runs inside a linked worktree we follow the .git file back to
    // the main repo instead of treating the worktree itself as the repo root.
    this.gitRoot = resolveMainRepoRoot(process.cwd()) ?? findRepoRoot(process.cwd()) ?? process.cwd()

    // Validate git remote matches configured repository (if set)
    if (this.config.repository) {
      validateGitRemote(this.config.repository, this.gitRoot)
    }

    // Initialize Architectural Intelligence context injection config (REN-1316)
    this.contextInjectionConfig = {
      architecturalIntelligence: config.architecturalIntelligence,
      maxTokens: config.architecturalContextMaxTokens,
    }

    // Use injected client or fail (caller must provide one)
    this.client = config.issueTrackerClient!
    this.statusMappings = config.statusMappings!
    this.events = events

    // Initialize default agent provider — per-spawn resolution may override
    const providerName = resolveProviderName({ project: config.project })
    this.provider = config.provider ?? createProvider(providerName)
    this.providerCache.set(this.provider.name, this.provider)

    // Initialize template registry for configurable workflow prompts
    try {
      const templateDirs: string[] = []
      if (config.templateDir) {
        templateDirs.push(config.templateDir)
      }
      // Auto-detect .donmai/templates/ in target repo
      const projectTemplateDir = resolve(this.gitRoot, '.donmai', 'templates')
      if (existsSync(projectTemplateDir) && !templateDirs.includes(projectTemplateDir)) {
        templateDirs.push(projectTemplateDir)
      }
      this.templateRegistry = TemplateRegistry.create({
        templateDirs,
        useBuiltinDefaults: true,
        frontend: 'linear',
      })
      this.templateRegistry.setToolPermissionAdapter(createToolPermissionAdapter(this.provider.capabilities.toolPermissionFormat ?? 'claude'))
    } catch {
      // If template loading fails, fall back to hardcoded prompts
      this.templateRegistry = null
    }

    // Auto-load .donmai/config.yaml from repository root
    try {
      const repoRoot = this.gitRoot
      if (repoRoot) {
        const repoConfig = loadRepositoryConfig(repoRoot)
        if (repoConfig) {
          this.repoConfig = repoConfig
          // Use repository from config as fallback if not set in OrchestratorConfig
          if (!this.config.repository && repoConfig.repository) {
            this.config.repository = repoConfig.repository
            validateGitRemote(this.config.repository, this.gitRoot)
          }
          // Store allowedProjects for backlog filtering
          if (repoConfig.projectPaths) {
            // Resolve projectPaths to plain path strings (handles both string and object forms)
            this.projectPaths = Object.fromEntries(
              Object.entries(repoConfig.projectPaths).map(([name, value]) => [
                name,
                typeof value === 'string' ? value : value.path,
              ])
            )
            this.sharedPaths = repoConfig.sharedPaths
            this.allowedProjects = Object.keys(repoConfig.projectPaths)
          } else if (repoConfig.allowedProjects) {
            this.allowedProjects = repoConfig.allowedProjects
          }
          // Store non-Node project config (repo-wide defaults)
          if (repoConfig.linearCli) {
            this.linearCli = repoConfig.linearCli
          }
          if (repoConfig.packageManager) {
            this.packageManager = repoConfig.packageManager
          }
          // Store configurable build/test/validate commands (repo-wide defaults)
          if (repoConfig.buildCommand) {
            this.buildCommand = repoConfig.buildCommand
          }
          if (repoConfig.testCommand) {
            this.testCommand = repoConfig.testCommand
          }
          if (repoConfig.validateCommand) {
            this.validateCommand = repoConfig.validateCommand
          }
          // Apply worktree.directory from repo config if worktreePath was not explicitly set
          if (repoConfig.worktree?.directory && !config.worktreePath) {
            this.config.worktreePath = repoConfig.worktree.directory
          }
          // Profile-based config takes precedence over legacy providers/models
          const profilesConfig = getProfilesConfig(repoConfig)
          const dispatchCfg = getDispatchConfig(repoConfig)
          if (profilesConfig && dispatchCfg) {
            this.profiles = profilesConfig
            this.dispatchConfig = dispatchCfg
            // Legacy providers/models sections are silently ignored
          } else {
            // Legacy path: flat providers + models
            this.configProviders = getProvidersConfig(repoConfig)
            this.configModels = getModelsConfig(repoConfig)
          }

          // Initialize merge queue adapter from repository config
          if (repoConfig.mergeQueue?.enabled && !config.mergeQueueAdapter) {
            try {
              const provider = repoConfig.mergeQueue.provider ?? 'local'
              this.mergeQueueAdapter = createMergeQueueAdapter(provider, {
                storage: config.mergeQueueStorage,
              })
              console.log(`[orchestrator] Merge queue adapter initialized: ${provider}`)
            } catch (error) {
              console.warn(`[orchestrator] Failed to initialize merge queue adapter: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
      }
    } catch (err) {
      console.warn('[orchestrator] Failed to load .donmai/config.yaml:', err instanceof Error ? err.message : err)
    }

    // Warn if legacy .worktrees/ directory exists inside the repo
    const legacyWorktreePath = resolve(this.gitRoot, '.worktrees')
    if (existsSync(legacyWorktreePath)) {
      console.warn(
        '[orchestrator] Legacy .worktrees/ directory detected inside the repo. ' +
        'Run "af-migrate-worktrees" to move worktrees to the new sibling directory.'
      )
    }

    // Accept merge queue adapter passed directly via config (takes precedence over repo config)
    if (config.mergeQueueAdapter) {
      this.mergeQueueAdapter = config.mergeQueueAdapter
    }

    // Initialize tool plugin registry with injected plugins
    this.toolRegistry = new ToolRegistry()
    if (config.toolPlugins) {
      for (const plugin of config.toolPlugins) {
        this.toolRegistry.register(plugin)
      }
    }
  }

  /**
   * Update the last activity timestamp for an agent (for inactivity timeout tracking)
   * @param issueId - The issue ID of the agent
   * @param activityType - Optional description of the activity type
   */
  /**
   * Buffer assistant text and flush in batches for readable logging.
   * Streaming providers (Codex) emit one token per event — this buffers
   * and flushes after 500ms of silence or on sentence boundaries.
   */
  /** @internal */ bufferAssistantText(issueId: string, text: string, log: Logger | undefined): void {
    let buf = this.assistantTextBuffers.get(issueId)
    if (!buf) {
      buf = { text: '', timer: null }
      this.assistantTextBuffers.set(issueId, buf)
    }

    buf.text += text

    // Clear existing timer
    if (buf.timer) clearTimeout(buf.timer)

    // Flush after 500ms of silence
    buf.timer = setTimeout(() => {
      this.flushAssistantTextBuffer(issueId, log)
    }, 500)
  }

  /** @internal */ flushAssistantTextBuffer(issueId: string, log: Logger | undefined): void {
    const buf = this.assistantTextBuffers.get(issueId)
    if (!buf || !buf.text.trim()) return

    const text = buf.text.trim()
    if (text.length > 0) {
      log?.info('Agent', { text: text.substring(0, 300) })
    }

    buf.text = ''
    if (buf.timer) {
      clearTimeout(buf.timer)
      buf.timer = null
    }
  }

  /** @internal */ updateLastActivity(issueId: string, activityType: string = 'activity'): void {
    const agent = this.activeAgents.get(issueId)
    if (agent) {
      agent.lastActivityAt = new Date()
      this.events.onActivityEmitted?.(agent, activityType)
    }
  }

  /**
   * Get timeout configuration for a specific work type
   * @param workType - The work type to get timeout config for
   * @returns Timeout configuration with inactivity and max session values
   */
  /** @internal */ getTimeoutConfig(workType?: string): { inactivityTimeoutMs: number; maxSessionTimeoutMs?: number } {
    const baseConfig = {
      inactivityTimeoutMs: this.config.inactivityTimeoutMs,
      maxSessionTimeoutMs: this.config.maxSessionTimeoutMs,
    }

    // Apply work-type-specific overrides if configured
    if (workType && this.config.workTypeTimeouts?.[workType as keyof typeof this.config.workTypeTimeouts]) {
      const override = this.config.workTypeTimeouts[workType as keyof typeof this.config.workTypeTimeouts]
      return {
        inactivityTimeoutMs: override?.inactivityTimeoutMs ?? baseConfig.inactivityTimeoutMs,
        maxSessionTimeoutMs: override?.maxSessionTimeoutMs ?? baseConfig.maxSessionTimeoutMs,
      }
    }

    // Work types that spawn foreground sub-agents via the Agent tool may have
    // silent periods in the event stream while sub-agents run. Use a longer
    // inactivity timeout for all work types that may coordinate sub-agents,
    // unless the user has configured a per-work-type override above.
    const maySpawnSubAgents = workType === 'development' || workType === 'inflight'
      || workType === 'qa' || workType === 'acceptance'
      || workType === 'refinement-coordination'
    if (maySpawnSubAgents) {
      return {
        inactivityTimeoutMs: Math.max(baseConfig.inactivityTimeoutMs, COORDINATION_INACTIVITY_TIMEOUT_MS),
        maxSessionTimeoutMs: baseConfig.maxSessionTimeoutMs,
      }
    }

    return baseConfig
  }

  /**
   * Detect the appropriate work type for an issue based on its status.
   * Parent and leaf issues use the same work type — coordinator behavior
   * is decided at runtime by the agent based on sub-issue presence.
   */
  async detectWorkType(issueId: string, statusName: string): Promise<AgentWorkType> {
    return detectWorkTypeHelper(statusName, false, this.statusMappings.statusToWorkType)
  }

  /**
   * Get backlog issues for the configured project
   */
  async getBacklogIssues(limit?: number): Promise<OrchestratorIssue[]> {
    const maxIssues = limit ?? this.config.maxConcurrent

    // Cross-reference project repo metadata with config
    if (this.config.project && this.config.repository) {
      try {
        const projectRepoUrl = await this.client.getProjectRepositoryUrl(this.config.project)
        if (projectRepoUrl) {
          const normalizedProjectRepo = projectRepoUrl
            .replace(/^https?:\/\//, '')
            .replace(/\.git$/, '')
          const normalizedConfigRepo = this.config.repository
            .replace(/^https?:\/\//, '')
            .replace(/\.git$/, '')
          if (!normalizedProjectRepo.includes(normalizedConfigRepo) && !normalizedConfigRepo.includes(normalizedProjectRepo)) {
            console.warn(
              `Warning: Project '${this.config.project}' repository metadata '${projectRepoUrl}' ` +
              `does not match configured repository '${this.config.repository}'. Skipping issues.`
            )
            return []
          }
        }
      } catch (error) {
        // Non-fatal: log warning but continue if metadata check fails
        console.warn('Warning: Could not check project repository metadata:', error instanceof Error ? error.message : String(error))
      }
    }

    // Query issues using the abstract client
    const allIssues = await this.client.queryIssues({
      project: this.config.project,
      status: 'Backlog',
      maxResults: maxIssues * 2, // Fetch extra to account for filtering
    })

    const results: OrchestratorIssue[] = []
    for (const issue of allIssues) {
      if (results.length >= maxIssues) break

      // Skip sub-issues — coordinators manage their lifecycle, not the backlog scanner
      if (issue.parentId) {
        console.log(
          `[orchestrator] Skipping sub-issue ${issue.identifier} — managed by parent coordinator`
        )
        continue
      }

      // Filter by allowedProjects from .donmai/config.yaml
      if (this.allowedProjects && this.allowedProjects.length > 0) {
        if (!issue.projectName || !this.allowedProjects.includes(issue.projectName)) {
          console.warn(
            `[orchestrator] Skipping issue ${issue.identifier} — project "${issue.projectName ?? '(none)'}" is not in allowedProjects: [${this.allowedProjects.join(', ')}]`
          )
          continue
        }
      }

      results.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        url: issue.url,
        priority: issue.priority,
        labels: issue.labels,
        teamName: issue.teamName,
        projectName: issue.projectName,
      })
    }

    // Sort by priority (lower number = higher priority, 0 means no priority -> goes last)
    return results.sort((a, b) => {
      const aPriority = a.priority || 5
      const bPriority = b.priority || 5
      return aPriority - bPriority
    })
  }

  // Worktree lifecycle helpers \u2014 delegated to ../workarea/git-worktree.ts
  // (REN-1342 phase-2 decomposition).  These thin wrappers keep the existing
  // call surface inside this file while the canonical logic lives in workarea.

  /** @internal */ validateWorktree(worktreePath: string): { valid: boolean; reason?: string } {
    return workareaValidateWorktree(worktreePath)
  }

  /** @internal */ isBranchConflictError(errorMsg: string): boolean {
    return isBranchConflictErrorShared(errorMsg)
  }

  /** @internal */ parseConflictingWorktreePath(errorMsg: string): string | null {
    return parseConflictingWorktreePathShared(errorMsg)
  }

  /** @internal */ isMainWorktree(targetPath: string): boolean {
    return workareaIsMainWorktree(targetPath, this.gitRoot)
  }

  /** @internal */ isInsideWorktreesDir(targetPath: string): boolean {
    return workareaIsInsideWorktreesDir(targetPath, this.config.worktreePath, this.gitRoot)
  }

  /** @internal */ tryCleanupConflictingWorktree(conflictPath: string, branchName: string): boolean {
    return workareaTryCleanupConflictingWorktree(
      conflictPath,
      branchName,
      this.gitRoot,
      this.config.worktreePath,
      resolveWorktreePath(this.config.worktreePath, this.gitRoot),
    )
  }

  /** @internal */ handleBranchConflict(errorMsg: string, branchName: string): void {
    workareaHandleBranchConflict(
      errorMsg,
      branchName,
      this.gitRoot,
      this.config.worktreePath,
      resolveWorktreePath(this.config.worktreePath, this.gitRoot),
    )
  }


  /**
   * Create a git worktree for an issue with work type suffix.
   * Delegates to workarea/git-worktree.ts (REN-1342 phase-2 decomposition).
   *
   * @param issueIdentifier - Issue identifier (e.g., "SUP-294")
   * @param workType - Type of work being performed
   * @returns Object containing worktreePath and worktreeIdentifier
   */
  createWorktree(
    issueIdentifier: string,
    workType: AgentWorkType
  ): { worktreePath: string; worktreeIdentifier: string } {
    const result = workareaCreateWorktree({
      issueIdentifier,
      workType,
      worktreePathTemplate: this.config.worktreePath,
      gitRoot: this.gitRoot,
      packageManager: this.packageManager ?? 'pnpm',
      mergeDriverDisabled: this.repoConfig?.mergeDriver === 'default',
      onCreated: (worktreePath) => this.writeWorktreeHelpers(worktreePath),
    })

    // Capture quality baseline for delta checking (runs test/typecheck on main)
    if (this.isQualityBaselineEnabled()) {
      try {
        const qualityConfig = this.buildQualityConfig()
        const baseline = captureQualityBaseline(result.worktreePath, qualityConfig)
        saveBaseline(result.worktreePath, baseline)
        console.log(`Quality baseline captured: ${baseline.tests.total} tests, ${baseline.typecheck.errorCount} type errors, ${baseline.lint.errorCount} lint errors`)
      } catch (baselineError) {
        console.warn(`Failed to capture quality baseline: ${baselineError instanceof Error ? baselineError.message : String(baselineError)}`)
      }
    }

    return result
  }

  /**
   * Clean up a git worktree.
   * Delegates to workarea/git-worktree.ts (REN-1342 phase-2 decomposition).
   *
   * @param worktreeIdentifier - Worktree identifier with work type suffix (e.g., "SUP-294-QA")
   */
  removeWorktree(worktreeIdentifier: string, deleteBranchName?: string): void {
    workareaRemoveWorktree(worktreeIdentifier, this.config.worktreePath, this.gitRoot, deleteBranchName)
  }

  /**
   * Write helper scripts into the worktree's .agent/ directory.
   * Currently writes .agent/add-dep.sh for safe dependency addition.
   */
  /** @internal */ writeWorktreeHelpers(worktreePath: string): void {
    const pm = (this.packageManager ?? 'pnpm') as PackageManager
    if (pm === 'none') return

    const addCmd = getAddCommand(pm) ?? `${pm} add`
    const agentDir = resolve(worktreePath, '.agent')
    const scriptPath = resolve(agentDir, 'add-dep.sh')

    const script = `#!/bin/bash
# Safe dependency addition for agents in worktrees.
# Removes symlinked node_modules, then runs ${addCmd} with guard bypass.
# Usage: bash .agent/add-dep.sh <package> [--filter <workspace>]
set -e
if [ \$# -eq 0 ]; then
  echo "Usage: bash .agent/add-dep.sh <package> [--filter <workspace>]"
  exit 1
fi
echo "Cleaning symlinked node_modules..."
rm -rf node_modules
for subdir in apps packages; do
  [ -d "\$subdir" ] && find "\$subdir" -maxdepth 2 -name node_modules -type d -exec rm -rf {} + 2>/dev/null || true
done
echo "Installing: ${addCmd} \$@"
ORCHESTRATOR_INSTALL=1 exec ${addCmd} "\$@"
`

    try {
      if (!existsSync(agentDir)) {
        mkdirSync(agentDir, { recursive: true })
      }
      writeFileSync(scriptPath, script, { mode: 0o755 })
    } catch (error) {
      console.warn(
        `Failed to write worktree helper scripts: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /** Bootstrap worktree dependencies from origin/main. Delegates to workarea. */
  /** @internal */ bootstrapWorktreeDeps(worktreePath: string): void {
    workareaBootstrapWorktreeDeps(worktreePath, this.packageManager ?? 'pnpm', this.gitRoot)
  }

  /** Configure mergiraf merge driver. Delegates to workarea. */
  /** @internal */ configureMergiraf(worktreePath: string): void {
    if (this.repoConfig?.mergeDriver === 'default') return
    workareaConfigureMergiraf(worktreePath)
  }

  /**
   * Check if quality baseline capture is enabled via repository config.
   */
  /** @internal */ isQualityBaselineEnabled(): boolean {
    const quality = (this.repoConfig as Record<string, unknown> | null)?.quality as
      | { baselineEnabled?: boolean }
      | undefined
    return quality?.baselineEnabled ?? false
  }

  /**
   * Build quality config from orchestrator settings.
   */
  /** @internal */ buildQualityConfig(): QualityConfig {
    return {
      testCommand: this.testCommand,
      validateCommand: this.validateCommand,
      packageManager: this.packageManager ?? 'pnpm',
      timeoutMs: 120_000,
    }
  }

  /**
   * Load quality baseline from a worktree and convert to TemplateContext shape.
   */
  /** @internal */ loadQualityBaselineForContext(worktreePath?: string): {
    tests: { total: number; passed: number; failed: number }
    typecheckErrors: number
    lintErrors: number
  } | undefined {
    if (!worktreePath || !this.isQualityBaselineEnabled()) return undefined
    try {
      const baseline = loadBaseline(worktreePath)
      if (!baseline) return undefined
      return {
        tests: {
          total: baseline.tests.total,
          passed: baseline.tests.passed,
          failed: baseline.tests.failed,
        },
        typecheckErrors: baseline.typecheck.errorCount,
        lintErrors: baseline.lint.errorCount,
      }
    } catch {
      return undefined
    }
  }

  /**
   * Link dependencies from the main repo into a worktree via symlinks.
   * Delegates to workarea/dep-linker.ts (REN-1342 phase-2 decomposition).
   */
  linkDependencies(worktreePath: string, identifier: string): void {
    workareaLinkDependencies(worktreePath, identifier, this.packageManager ?? 'pnpm', this.gitRoot)
  }

  /**
   * Sync dependencies between worktree and main repo before linking.
   * Delegates to workarea/dep-linker.ts (REN-1342 phase-2 decomposition).
   */
  syncDependencies(worktreePath: string, identifier: string): void {
    workareaSyncDependencies(worktreePath, identifier, this.packageManager ?? 'pnpm', this.gitRoot)
  }

  /**
   * @deprecated Use linkDependencies() instead. This now delegates to linkDependencies.
   */
  preInstallDependencies(worktreePath: string, identifier: string): void {
    this.linkDependencies(worktreePath, identifier)
  }

  /**
   * Resolve the provider for a specific spawn, using the full priority cascade.
   * Returns a cached provider instance (creating one if needed) and the resolved name.
   */
  /**
   * Build base instructions for providers that need persistent system instructions.
   *
   * Uses shared instruction builders from agent-instructions.ts so all providers
   * (Claude, Codex, etc.) receive the same instruction content: autonomy preamble,
   * tool usage guidance, code editing philosophy, safety rules, git workflow,
   * code intelligence instructions, Linear tool instructions, and project instructions.
   */
  /** @internal */ buildBaseInstructions(options: {
    workType?: AgentWorkType
    worktreePath?: string
    hasCodeIntelligence?: boolean
    codeIntelEnforced?: boolean
    useToolPlugins?: boolean
  }): string {
    // Resolve systemPrompt append from RepositoryConfig
    const appendSections: string[] = []
    if (this.repoConfig?.systemPrompt?.append) {
      appendSections.push(this.repoConfig.systemPrompt.append.trim())
    }
    if (options.workType && this.repoConfig?.systemPrompt?.byWorkType?.[options.workType]) {
      appendSections.push(this.repoConfig.systemPrompt.byWorkType[options.workType].trim())
    }
    const systemPromptAppend = appendSections.length > 0 ? appendSections.join('\n\n') : undefined

    return buildBaseInstructionsFromShared(buildSafetyInstructions(), {
      worktreePath: options.worktreePath,
      hasCodeIntelligence: options.hasCodeIntelligence,
      codeIntelEnforced: options.codeIntelEnforced,
      useToolPlugins: options.useToolPlugins,
      linearCli: this.linearCli,
      systemPromptAppend,
    })
  }

  /**
   * Build structured permission config from template permissions.
   *
   * Translates abstract template `tools.allow` / `tools.disallow` into
   * structured regex patterns for providers with `needsPermissionConfig: true`.
   */
  /** @internal */ buildPermissionConfig(workType?: AgentWorkType): import('../templates/adapters.js').CodexPermissionConfig | undefined {
    if (!this.templateRegistry || !workType) return undefined

    const { allow, disallow } = this.templateRegistry.getRawToolPermissions(workType)
    if (allow.length === 0 && disallow.length === 0) return undefined

    const adapter = new CodexToolPermissionAdapter()
    return adapter.buildPermissionConfig(allow, disallow)
  }

  /** @internal */ resolveProviderForSpawn(context: {
    workType?: string
    projectName?: string
    labels?: string[]
    mentionContext?: string
    dispatchModel?: string
    dispatchSubAgentModel?: string
  }): { provider: AgentProvider; providerName: AgentProviderName; source: string; resolvedProfile?: ResolvedProfile } {
    // Profile-based path: resolve full profile (provider + model + effort + config)
    if (this.profiles && this.dispatchConfig) {
      const resolved = resolveProfileForSpawn({
        profiles: this.profiles,
        dispatch: this.dispatchConfig,
        workType: context.workType,
        project: context.projectName,
        labels: context.labels,
        mentionContext: context.mentionContext,
        dispatchModel: context.dispatchModel,
        dispatchSubAgentModel: context.dispatchSubAgentModel,
      })

      let provider = this.providerCache.get(resolved.provider)
      if (!provider) {
        provider = createProvider(resolved.provider)
        this.providerCache.set(resolved.provider, provider)
      }

      return { provider, providerName: resolved.provider, source: resolved.source, resolvedProfile: resolved }
    }

    // Legacy path: flat providers config
    const { name, source } = resolveProviderWithSource({
      project: context.projectName,
      workType: context.workType,
      labels: context.labels,
      mentionContext: context.mentionContext,
      configProviders: this.configProviders,
    })

    // Return cached instance or create a new one
    let provider = this.providerCache.get(name)
    if (!provider) {
      provider = createProvider(name)
      this.providerCache.set(name, provider)
    }

    return { provider, providerName: name, source }
  }

  /** @internal Body lives in agent-spawner.ts (REN-1342). */
  spawnAgent(options: SpawnAgentOptions): AgentProcess {
    return spawnAgentImpl.call(this, options)
  }

  /** @internal Event-stream loop. Body lives in event-processor.ts (REN-1342). */
  async processEventStream(
    issueId: string,
    identifier: string,
    sessionId: string | undefined,
    handle: AgentHandle,
    emitter: ActivityEmitter | ApiActivityEmitter | null,
    agent: AgentProcess
  ): Promise<void> {
    return processEventStreamImpl.call(this, issueId, identifier, sessionId, handle, emitter, agent)
  }

  /** @internal Per-event handler. Body lives in event-processor.ts (REN-1342). */
  async handleAgentEvent(
    issueId: string,
    sessionId: string | undefined,
    event: AgentEvent,
    emitter: ActivityEmitter | ApiActivityEmitter | null,
    agent: AgentProcess,
    handle: AgentHandle
  ): Promise<void> {
    return handleAgentEventImpl.call(this, issueId, sessionId, event, emitter, agent, handle)
  }

  /**
   * Extract GitHub PR URL from text (typically from gh pr create output)
   */
  /**
   * Track session output signals from tool calls for completion contract validation.
   * Detects when agents call Linear CLI or MCP tools that produce required outputs.
   */
  /** @internal */ trackSessionOutputSignal(issueId: string, toolName: string, input: Record<string, unknown>): void {
    let flags = this.sessionOutputFlags.get(issueId)
    if (!flags) {
      flags = { commentPosted: false, issueUpdated: false, subIssuesCreated: false }
      this.sessionOutputFlags.set(issueId, flags)
    }

    // Detect comment creation (CLI via Bash or MCP tool)
    if (
      toolName === 'af_linear_create_comment' ||
      toolName === 'mcp__af-linear__af_linear_create_comment'
    ) {
      flags.commentPosted = true
    }

    // Detect issue update (CLI via Bash or MCP tool)
    if (
      toolName === 'af_linear_update_issue' ||
      toolName === 'mcp__af-linear__af_linear_update_issue'
    ) {
      flags.issueUpdated = true
    }

    // Detect issue creation (CLI via Bash or MCP tool)
    if (
      toolName === 'af_linear_create_issue' ||
      toolName === 'mcp__af-linear__af_linear_create_issue'
    ) {
      flags.subIssuesCreated = true
    }

    // Detect Bash tool calls that invoke the Linear CLI
    if (toolName === 'Bash') {
      const command = typeof input?.command === 'string' ? input.command : ''
      if (command.includes('af-linear create-comment') || command.includes('af-linear create_comment')) {
        flags.commentPosted = true
      }
      if (command.includes('af-linear update-issue') || command.includes('af-linear update_issue')) {
        flags.issueUpdated = true
      }
      if (command.includes('af-linear create-issue') || command.includes('af-linear create_issue')) {
        flags.subIssuesCreated = true
      }
    }
  }

  /**
   * Emit structured context entries based on completed tool calls.
   * Fire-and-forget — errors are silently ignored.
   */
  /** @internal */ emitToolContext(
    emitter: ActivityEmitter | ApiActivityEmitter,
    toolName: string,
    input: Record<string, unknown>,
  ): void {
    // Only ApiActivityEmitter has emitContext
    if (!('emitContext' in emitter)) return
    const api = emitter as ApiActivityEmitter

    const filePath = input.file_path ?? input.path

    switch (toolName) {
      case 'Read':
      case 'View':
      case 'cat':
        if (filePath) api.emitContext('currentFile', String(filePath))
        break

      case 'Write':
      case 'Edit':
      case 'Create':
        if (filePath) api.emitContext('lastEditedFile', String(filePath))
        break

      case 'Grep':
      case 'Search':
      case 'Glob':
      case 'Find':
        if (input.pattern) {
          api.emitContext('lastSearch', { tool: toolName, pattern: input.pattern })
        }
        break

      case 'Bash': {
        const command = typeof input.command === 'string' ? input.command : ''
        if (!command) break

        if (command.startsWith('git ')) {
          api.emitContext('lastGitOp', command.substring(0, 100))
        }

        const cdMatch = command.match(/\bcd\s+("[^"]+"|'[^']+'|\S+)/)
        if (cdMatch) {
          const dir = cdMatch[1].replace(/^["']|["']$/g, '')
          api.emitContext('workingDirectory', dir)
        }

        if (/\b(pnpm\s+test|npm\s+test|yarn\s+test|vitest|jest|mocha)\b/.test(command)) {
          api.emitContext('lastTestRun', { command: command.substring(0, 200) })
        }
        break
      }
    }
  }

  /** @internal */ extractPullRequestUrl(text: string): string | null {
    // GitHub PR URL pattern: https://github.com/owner/repo/pull/123
    const prUrlPattern = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/g
    const matches = text.match(prUrlPattern)
    return matches ? matches[0] : null
  }

  /**
   * Update the Linear session with the PR URL
   */
  /** @internal */ async updateSessionPullRequest(
    sessionId: string,
    prUrl: string,
    agent: AgentProcess
  ): Promise<void> {
    const log = this.agentLoggers.get(agent.issueId)

    // If using API activity config, call the API endpoint
    if (this.config.apiActivityConfig) {
      const { baseUrl, apiKey } = this.config.apiActivityConfig
      try {
        const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/external-urls`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            externalUrls: [{ label: 'Pull Request', url: prUrl }],
          }),
        })

        if (!response.ok) {
          const error = await response.text()
          log?.warn('Failed to update session PR URL via API', { status: response.status, error })
        } else {
          log?.info('Session PR URL updated via API')
        }
      } catch (error) {
        log?.warn('Failed to update session PR URL via API', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } else {
      // Direct issue tracker API - use session if available
      const session = this.agentSessions.get(agent.issueId)
      if (session) {
        try {
          await session.setPullRequestUrl(prUrl)
          log?.info('Session PR URL updated via Linear API')
        } catch (error) {
          log?.warn('Failed to update session PR URL via Linear API', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  /**
   * Post completion comment with full result message
   * Uses multi-comment splitting for long messages (up to 10 comments, 10k chars each)
   */
  /** @internal */ async postCompletionComment(
    issueId: string,
    sessionId: string | undefined,
    resultMessage: string,
    log?: Logger
  ): Promise<void> {
    // Build completion comments with multi-part splitting
    const comments = this.client.buildCompletionComments(
      resultMessage,
      [], // No plan items to include (already shown via activities)
      sessionId ?? null
    )

    log?.info('Posting completion comment', {
      parts: comments.length,
      totalLength: resultMessage.length,
    })

    // If using API activity config, call the API endpoint
    if (this.config.apiActivityConfig) {
      const { baseUrl, apiKey } = this.config.apiActivityConfig
      try {
        const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/completion`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            summary: resultMessage,
          }),
        })

        if (!response.ok) {
          const error = await response.text()
          log?.warn('Failed to post completion comment via API', { status: response.status, error })
        } else {
          log?.info('Completion comment posted via API')
        }
      } catch (error) {
        log?.warn('Failed to post completion comment via API', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } else {
      // Direct Linear API - post comments sequentially
      for (const chunk of comments) {
        try {
          await this.client.createComment(issueId, chunk.body)
          log?.info(`Posted completion comment part ${chunk.partNumber}/${chunk.totalParts}`)
          // Small delay between comments to ensure ordering
          if (chunk.partNumber < chunk.totalParts) {
            await new Promise(resolve => setTimeout(resolve, 100))
          }
        } catch (error) {
          log?.error(`Failed to post completion comment part ${chunk.partNumber}`, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
  }

  /**
   * Clean up agent resources
   */
  /** @internal */ cleanupAgent(issueId: string, sessionId?: string): void {
    this.agentHandles.delete(issueId)
    this.agentSessions.delete(issueId)
    this.activityEmitters.delete(issueId)
    this.abortControllers.delete(issueId)
    this.agentLoggers.delete(issueId)
    const buf = this.assistantTextBuffers.get(issueId)
    if (buf?.timer) clearTimeout(buf.timer)
    this.assistantTextBuffers.delete(issueId)

    // Stop heartbeat writer
    const heartbeatWriter = this.heartbeatWriters.get(issueId)
    if (heartbeatWriter) {
      heartbeatWriter.stop()
      this.heartbeatWriters.delete(issueId)
    }

    // Stop progress logger
    const progressLogger = this.progressLoggers.get(issueId)
    if (progressLogger) {
      progressLogger.stop()
      this.progressLoggers.delete(issueId)
    }

    // Cleanup session output flags
    this.sessionOutputFlags.delete(issueId)

    // Cleanup stored spawn config used for steering retries
    this.steeringSpawnConfigs.delete(issueId)

    // Persist and cleanup context manager
    const contextManager = this.contextManagers.get(issueId)
    if (contextManager) {
      try {
        contextManager.persist()
      } catch {
        // Ignore persistence errors during cleanup
      }
      this.contextManagers.delete(issueId)
    }

    this.pendingToolCalls.delete(issueId)

    // Session logger is cleaned up separately (in finalizeSessionLogger)
    // to ensure the final status is captured before cleanup
    this.sessionLoggers.delete(issueId)

    if (sessionId) {
      this.sessionToIssue.delete(sessionId)
    }
  }

  /**
   * Finalize the session logger with final status
   */
  /** @internal */ finalizeSessionLogger(
    issueId: string,
    status: 'completed' | 'failed' | 'stopped',
    options?: { errorMessage?: string; pullRequestUrl?: string }
  ): void {
    const sessionLogger = this.sessionLoggers.get(issueId)
    if (sessionLogger) {
      sessionLogger.finalize(status, options)
    }
  }

  /**
   * Run the orchestrator - spawn agents for backlog issues
   */
  async run(): Promise<OrchestratorResult> {
    const issues = await this.getBacklogIssues()
    const result: OrchestratorResult = {
      success: true,
      agents: [],
      errors: [],
    }

    if (issues.length === 0) {
      console.log('No backlog issues found')
      return result
    }

    console.log(`Found ${issues.length} backlog issue(s)`)

    for (const issue of issues) {
      this.events.onIssueSelected?.(issue)
      console.log(`Processing: ${issue.identifier} - ${issue.title}`)

      try {
        // Detect work type from issue status
        const workType = await this.detectWorkType(issue.id, 'Backlog')

        // Create worktree with work type suffix
        const { worktreePath, worktreeIdentifier } = this.createWorktree(issue.identifier, workType)

        // Sync and link dependencies from main repo into worktree
        this.syncDependencies(worktreePath, issue.identifier)

        const startStatus = this.statusMappings.workTypeStartStatus[workType]

        // Update issue status based on work type if auto-transition is enabled
        if (this.config.autoTransition && startStatus) {
          await this.client.updateIssueStatus(issue.id, startStatus)
          console.log(`Updated ${issue.identifier} status to ${startStatus}`)
        }

        // Spawn agent with generated session ID for autonomous mode
        const agent = this.spawnAgent({
          issueId: issue.id,
          identifier: issue.identifier,
          worktreeIdentifier,
          sessionId: randomUUID(),
          worktreePath,
          workType,
          teamName: issue.teamName,
          projectName: issue.projectName,
          labels: issue.labels,
        })

        result.agents.push(agent)
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        result.errors.push({ issueId: issue.id, error: err })
        console.error(`Failed to process ${issue.identifier}:`, err.message)
      }
    }

    result.success = result.errors.length === 0

    return result
  }

  /** @internal Body lives in agent-spawner.ts (REN-1342). */
  async spawnAgentForIssue(
    issueIdOrIdentifier: string,
    sessionId?: string,
    workType?: AgentWorkType,
    prompt?: string,
    extra?: { dispatchModel?: string; dispatchSubAgentModel?: string }
  ): Promise<AgentProcess> {
    return spawnAgentForIssueImpl.call(this, issueIdOrIdentifier, sessionId, workType, prompt, extra)
  }

  /**
   * Get the merge queue adapter, if configured.
   * Returns undefined if no merge queue is enabled.
   */
  getMergeQueueAdapter(): import('../merge-queue/types.js').MergeQueueAdapter | undefined {
    return this.mergeQueueAdapter
  }

  /**
   * Get all active agents
   */
  getActiveAgents(): AgentProcess[] {
    return Array.from(this.activeAgents.values()).filter(
      (a) => a.status === 'running' || a.status === 'starting'
    )
  }

  /**
   * Stop a running agent by issue ID
   * @param issueId - The Linear issue ID
   * @param cleanupWorktree - Whether to remove the git worktree
   * @param stopReason - Why the agent is being stopped: 'user_request' or 'timeout'
   */
  async stopAgent(
    issueId: string,
    cleanupWorktree = false,
    stopReason: 'user_request' | 'timeout' = 'user_request'
  ): Promise<StopAgentResult> {
    const agent = this.activeAgents.get(issueId)
    if (!agent) {
      return { stopped: false, reason: 'not_found' }
    }

    if (agent.status !== 'running' && agent.status !== 'starting') {
      return { stopped: false, reason: 'already_stopped', agent }
    }

    const abortController = this.abortControllers.get(issueId)
    if (!abortController) {
      return { stopped: false, reason: 'not_found', agent }
    }

    const log = this.agentLoggers.get(issueId)

    try {
      // Emit final activity before stopping
      const emitter = this.activityEmitters.get(issueId)
      if (emitter) {
        try {
          const message = stopReason === 'user_request'
            ? 'Agent stopped by user request.'
            : 'Agent stopped due to timeout.'
          await emitter.emitResponse(message)
          await emitter.flush()
        } catch (emitError) {
          log?.warn('Failed to emit stop activity', {
            error: emitError instanceof Error ? emitError.message : String(emitError),
          })
        }
      }

      // Mark as stopped with reason before aborting
      agent.status = 'stopped'
      agent.stopReason = stopReason
      agent.completedAt = new Date()

      // Abort the query
      abortController.abort()

      // Clean up worktree if requested (only if agent has a worktree)
      if (cleanupWorktree && agent.worktreeIdentifier) {
        this.removeWorktree(agent.worktreeIdentifier)
      }

      const logMessage = stopReason === 'user_request'
        ? 'Agent stopped by user request'
        : 'Agent stopped due to timeout'
      log?.status('stopped', logMessage)
      return { stopped: true, agent }
    } catch (error) {
      log?.warn('Failed to stop agent', {
        error: error instanceof Error ? error.message : String(error),
      })
      return { stopped: false, reason: 'signal_failed', agent }
    }
  }

  /**
   * Stop a running agent by session ID
   */
  async stopAgentBySession(sessionId: string, cleanupWorktree = false): Promise<StopAgentResult> {
    const issueId = this.sessionToIssue.get(sessionId)
    if (!issueId) {
      return { stopped: false, reason: 'not_found' }
    }

    return this.stopAgent(issueId, cleanupWorktree)
  }

  /**
   * Get agent by session ID
   */
  getAgentBySession(sessionId: string): AgentProcess | undefined {
    const issueId = this.sessionToIssue.get(sessionId)
    if (!issueId) return undefined
    return this.activeAgents.get(issueId)
  }

  /**
   * Update the worker ID for all active activity emitters.
   * Called after worker re-registration to ensure activities are attributed
   * to the new worker ID and pass ownership checks.
   *
   * @param newWorkerId - The new worker ID after re-registration
   */
  updateWorkerId(newWorkerId: string): void {
    // Update the config for any future emitters
    if (this.config.apiActivityConfig) {
      this.config.apiActivityConfig.workerId = newWorkerId
    }

    // Update all existing activity emitters
    for (const [issueId, emitter] of this.activityEmitters.entries()) {
      // Only ApiActivityEmitter has updateWorkerId method
      if ('updateWorkerId' in emitter && typeof emitter.updateWorkerId === 'function') {
        emitter.updateWorkerId(newWorkerId)
        console.log(`[Orchestrator] Updated worker ID for emitter ${issueId}`)
      }
    }
  }

  /**
   * Forward a follow-up prompt to an existing or new agent
   *
   * If the agent is running, attempts to inject the message into the running session
   * without stopping it. If injection fails or agent isn't running, it will be
   * stopped gracefully and resumed with the new prompt.
   *
   * @param workType - Optional work type. If not provided, inherits from existing agent or defaults to 'development'.
   */
  async forwardPrompt(
    issueId: string,
    sessionId: string,
    prompt: string,
    providerSessionId?: string,
    workType?: AgentWorkType
  ): Promise<ForwardPromptResult> {
    const existingAgent = this.activeAgents.get(issueId)

    // If agent is running, try to inject the message without stopping
    if (existingAgent && (existingAgent.status === 'running' || existingAgent.status === 'starting')) {
      const injectResult = await this.injectMessage(issueId, sessionId, prompt)

      if (injectResult.injected) {
        console.log(`Message injected into running agent for ${existingAgent.identifier}`)
        return {
          forwarded: true,
          resumed: false,
          injected: true,
          agent: existingAgent,
        }
      }

      // Injection failed - fall back to stop and respawn
      console.log(`Message injection failed for ${existingAgent.identifier}: ${injectResult.reason} - stopping and respawning`)
      await this.stopAgent(issueId, false) // Don't cleanup worktree
    }

    // Get worktree path from existing agent or create new one
    let worktreePath: string | undefined
    let worktreeIdentifier: string | undefined
    let identifier: string
    let teamName: string | undefined

    if (existingAgent) {
      worktreePath = existingAgent.worktreePath
      worktreeIdentifier = existingAgent.worktreeIdentifier
      identifier = existingAgent.identifier
      // Use existing provider session ID if not provided
      providerSessionId = providerSessionId ?? existingAgent.providerSessionId
      // Inherit work type from existing agent if not provided
      workType = workType ?? existingAgent.workType
    } else {
      // Need to fetch issue to get identifier
      try {
        const issue = await this.client.getIssue(issueId)
        identifier = issue.identifier
        teamName = issue.teamName

        // Guard: skip work if the issue has moved to a terminal status since being queued
        const currentStatus = issue.status
        if (currentStatus && (this.statusMappings.terminalStatuses as readonly string[]).includes(currentStatus)) {
          console.log(`Issue ${identifier} is in terminal status '${currentStatus}' — skipping work`)
          return {
            forwarded: false,
            resumed: false,
            reason: 'terminal_status',
          }
        }

        // Auto-detect work type from issue status if not provided
        // This prevents defaulting to 'development' which would cause
        // incorrect status transitions (e.g., Delivered → Started for acceptance work)
        if (!workType) {
          const statusName = currentStatus ?? 'Backlog'
          workType = await this.detectWorkType(issue.id, statusName)
        }

        // Create isolated worktree for the agent
        if (this.statusMappings.workTypesRequiringWorktree.has(workType)) {
          const result = this.createWorktree(identifier, workType)
          worktreePath = result.worktreePath
          worktreeIdentifier = result.worktreeIdentifier

          // Sync and link dependencies from main repo into worktree
          this.syncDependencies(worktreePath, identifier)
        }
      } catch (error) {
        return {
          forwarded: false,
          resumed: false,
          reason: 'not_found',
          error: error instanceof Error ? error : new Error(String(error)),
        }
      }
    }

    // Check if worktree exists (only relevant for code work types)
    const effectiveWorkType = workType ?? 'development'
    if (this.statusMappings.workTypesRequiringWorktree.has(effectiveWorkType) && worktreePath && !existsSync(worktreePath)) {
      try {
        const result = this.createWorktree(identifier, effectiveWorkType)
        worktreePath = result.worktreePath
        worktreeIdentifier = result.worktreeIdentifier

        // Sync and link dependencies from main repo into worktree
        this.syncDependencies(worktreePath, identifier)
      } catch (error) {
        return {
          forwarded: false,
          resumed: false,
          reason: 'no_worktree',
          error: error instanceof Error ? error : new Error(String(error)),
        }
      }
    }

    // Spawn agent with resume if we have a provider session ID
    try {
      const agent = await this.spawnAgentWithResume({
        issueId,
        identifier,
        worktreeIdentifier,
        sessionId,
        worktreePath,
        prompt,
        providerSessionId,
        workType,
        teamName,
        mentionContext: prompt,
      })

      return {
        forwarded: true,
        resumed: !!providerSessionId,
        agent,
      }
    } catch (error) {
      return {
        forwarded: false,
        resumed: false,
        reason: 'spawn_failed',
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  /**
   * Inject a user message into a running agent session without stopping it.
   *
   * Uses the SDK's streamInput() method to send follow-up messages to a running session.
   * This is the preferred method for user follow-ups as it doesn't interrupt agent work.
   *
   * @param issueId - The issue ID the agent is working on
   * @param sessionId - The Linear session ID
   * @param message - The user message to inject
   * @returns Result indicating if injection was successful
   */
  async injectMessage(
    issueId: string,
    sessionId: string,
    message: string
  ): Promise<InjectMessageResult> {
    const log = this.agentLoggers.get(issueId)
    const agent = this.activeAgents.get(issueId)
    const handle = this.agentHandles.get(issueId)

    // Check if agent is running
    if (!agent || (agent.status !== 'running' && agent.status !== 'starting')) {
      return {
        injected: false,
        reason: 'not_running',
      }
    }

    // Check if we have the handle
    if (!handle) {
      log?.warn('No AgentHandle found for running agent', { issueId, sessionId })
      return {
        injected: false,
        reason: 'no_query',
      }
    }

    try {
      // Inject the message into the running session via provider handle
      log?.info('Injecting user message into running session', {
        issueId,
        sessionId,
        messageLength: message.length,
      })

      await handle.injectMessage(message)

      // Update activity timestamp since we just interacted with the agent
      agent.lastActivityAt = new Date()

      log?.success('Message injected successfully')

      return {
        injected: true,
      }
    } catch (error) {
      log?.error('Failed to inject message', {
        error: error instanceof Error ? error.message : String(error),
      })

      return {
        injected: false,
        reason: 'injection_failed',
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }

  /** @internal Body lives in agent-spawner.ts (REN-1342). */
  async spawnAgentWithResume(options: SpawnAgentWithResumeOptions): Promise<AgentProcess> {
    return spawnAgentWithResumeImpl.call(this, options)
  }

  /** @internal Body lives in agent-spawner.ts (REN-1342). */
  async attemptSessionSteering(agent: AgentProcess, log: Logger | undefined): Promise<void> {
    return attemptSessionSteeringImpl.call(this, agent, log)
  }

  /** @internal Body lives in agent-spawner.ts (REN-1342). */
  createResumeWithFallbackHandle(
    spawnProvider: AgentProvider,
    providerSessionId: string,
    spawnConfig: AgentSpawnConfig,
    agent: AgentProcess,
    log: Logger | undefined,
  ): AgentHandle {
    return createResumeWithFallbackHandleImpl.call(this, spawnProvider, providerSessionId, spawnConfig, agent, log)
  }

  /**
   * Stop all running agents
   */
  stopAll(): void {
    this.shuttingDown = true

    for (const [issueId] of this.abortControllers) {
      try {
        const agent = this.activeAgents.get(issueId)
        if (agent) {
          agent.status = 'stopped'
          agent.completedAt = new Date()
        }
        const abortController = this.abortControllers.get(issueId)
        abortController?.abort()
      } catch (error) {
        console.warn(`Failed to stop agent for ${issueId}:`, error)
      }
    }
    this.abortControllers.clear()
    this.sessionToIssue.clear()
  }

  /**
   * Gracefully shut down all provider resources (e.g., Codex app-server processes).
   * Call after stopAll() to ensure child processes don't become orphans.
   */
  async shutdownProviders(): Promise<void> {
    const shutdownPromises: Promise<void>[] = []
    for (const [name, provider] of this.providerCache) {
      if (provider.shutdown) {
        console.log(`Shutting down ${name} provider...`)
        shutdownPromises.push(
          provider.shutdown().catch((err) => {
            console.warn(`Failed to shut down ${name} provider:`, err)
          })
        )
      }
    }
    if (shutdownPromises.length > 0) {
      await Promise.all(shutdownPromises)
    }
  }

  /**
   * Full graceful cleanup: stop all agents and shut down provider resources.
   * Use this instead of stopAll() when the fleet is exiting.
   */
  async cleanup(): Promise<void> {
    this.stopAll()
    await this.shutdownProviders()
  }

  /**
   * Wait for all agents to complete with inactivity-based timeout
   *
   * Unlike a simple session timeout, this method monitors each agent's activity
   * and only stops agents that have been inactive for longer than the inactivity
   * timeout. Active agents are allowed to run indefinitely (unless maxSessionTimeoutMs
   * is set as a hard cap).
   *
   * @param inactivityTimeoutMsOverride - Override inactivity timeout from config (for backwards compatibility)
   */
  async waitForAll(inactivityTimeoutMsOverride?: number): Promise<AgentProcess[]> {
    const activeAgents = this.getActiveAgents()

    if (activeAgents.length === 0) {
      return Array.from(this.activeAgents.values())
    }

    return new Promise((resolve) => {
      const checkInterval = setInterval(async () => {
        const stillActive = this.getActiveAgents()

        if (stillActive.length === 0) {
          clearInterval(checkInterval)
          resolve(Array.from(this.activeAgents.values()))
          return
        }

        const now = Date.now()

        // Check each agent for inactivity timeout and max session timeout
        for (const agent of stillActive) {
          // Get timeout config for this agent's work type
          const timeoutConfig = this.getTimeoutConfig(agent.workType)

          // Use override if provided (for backwards compatibility), otherwise use config
          const inactivityTimeout = inactivityTimeoutMsOverride ?? timeoutConfig.inactivityTimeoutMs
          const maxSessionTimeout = timeoutConfig.maxSessionTimeoutMs

          const log = this.agentLoggers.get(agent.issueId)
          const timeSinceLastActivity = now - agent.lastActivityAt.getTime()
          const totalRuntime = now - agent.startedAt.getTime()

          // Check max session timeout (hard cap regardless of activity)
          if (maxSessionTimeout && totalRuntime > maxSessionTimeout) {
            log?.warn('Agent reached max session timeout', {
              totalRuntime: `${Math.floor(totalRuntime / 1000)}s`,
              maxSessionTimeout: `${Math.floor(maxSessionTimeout / 1000)}s`,
            })
            await this.stopAgent(agent.issueId, false, 'timeout')
            continue
          }

          // Check inactivity timeout (agent is "hung" only if no activity)
          if (timeSinceLastActivity > inactivityTimeout) {
            log?.warn('Agent timed out due to inactivity', {
              timeSinceLastActivity: `${Math.floor(timeSinceLastActivity / 1000)}s`,
              inactivityTimeout: `${Math.floor(inactivityTimeout / 1000)}s`,
              lastActivityAt: agent.lastActivityAt.toISOString(),
            })
            await this.stopAgent(agent.issueId, false, 'timeout')
          }
        }

        // Check again if all agents are done after potential stops
        const remaining = this.getActiveAgents()
        if (remaining.length === 0) {
          clearInterval(checkInterval)
          resolve(Array.from(this.activeAgents.values()))
        }
      }, 1000)
    })
  }
}

/**
 * Create an orchestrator instance
 */
export function createOrchestrator(
  config?: OrchestratorConfig,
  events?: OrchestratorEvents
): AgentOrchestrator {
  return new AgentOrchestrator(config, events)
}
