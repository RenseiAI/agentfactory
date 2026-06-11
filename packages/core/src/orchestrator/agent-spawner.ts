/**
 * Agent spawner — agent spawn lifecycle (synchronous spawn + async with-resume)
 *
 * Extracted from orchestrator.ts (phase-2 decomposition).
 * The functions here run with `this` bound to the AgentOrchestrator instance.
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { randomUUID } from 'crypto'
import { parse as parseDotenv } from 'dotenv'
import type {
  AgentProvider,
  AgentHandle,
  AgentSpawnConfig,
  AgentProviderName,
  AgentEvent,
} from '../providers/index.js'
import {
  createProvider,
  resolveModelWithSource,
  resolveProviderWithSource,
  resolveSubAgentModel,
} from '../providers/index.js'
import { applyReasoningEffort } from '../providers/reasoning-effort-dispatch.js'
import type { AgentOrchestrator } from './orchestrator.js'
import { validateGitRemote } from './orchestrator.js'
import type { AgentProcess, SpawnAgentOptions, SpawnAgentWithResumeOptions } from './types.js'
import type { AgentWorkType } from './work-types.js'
import type { TemplateContext } from '../templates/index.js'
import { createLogger, type Logger } from '../logger.js'
import {
  initializeAgentDir,
  writeState,
  updateState,
  createInitialState,
  checkRecovery,
  buildRecoveryPrompt,
  getHeartbeatTimeoutFromEnv,
  getMaxRecoveryAttemptsFromEnv,
} from './state-recovery.js'
import { createHeartbeatWriter, getHeartbeatIntervalFromEnv } from './heartbeat-writer.js'
import { createProgressLogger } from './progress-logger.js'
import { createSessionLogger } from './session-logger.js'
import { ContextManager } from './context-manager.js'
import { isSessionLoggingEnabled, isAutoAnalyzeEnabled, getLogAnalysisConfig } from './log-config.js'
import { createActivityEmitter, type ActivityEmitter } from './activity-emitter.js'
import { createApiActivityEmitter, type ApiActivityEmitter } from './api-activity-emitter.js'
import { mergeMentionContext, WORK_TYPE_SUFFIX, detectWorkType as detectWorkTypeHelper } from './dispatcher.js'
import { generatePromptForWorkType, loadSettingsEnv, loadAppEnvFiles } from './spawn-helpers.js'
import { getProjectConfig, getProjectPath, resolveProfileForSpawn } from '../config/index.js'
import { buildArchitecturalContext } from './context-injection.js'
import { resolveWorktreePath, getWorktreeIdentifier, checkForIncompleteWork, checkForPushedWorkWithoutPR, findRepoRoot, resolveMainRepoRoot } from '../workarea/git-worktree.js'
import { runSteeringRetry, decideSteering, inspectGitStateForSteering, buildSteeringPrompt } from './session-steering.js'
import { parseWorkResult } from './parse-work-result.js'

// AGENT_ENV_BLOCKLIST mirrors the constant in orchestrator.ts. Env vars that
// Claude Code interprets for authentication/routing — must not leak into agent
// processes from app .env.local files.
const AGENT_ENV_BLOCKLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENCLAW_GATEWAY_TOKEN',
]

/**
 * Spawn a Claude agent for a specific issue using the Agent SDK
 */
export function spawnAgent(
  this: AgentOrchestrator,options: SpawnAgentOptions): AgentProcess {
  const {
    issueId,
    identifier,
    worktreeIdentifier,
    sessionId,
    worktreePath,
    streamActivities,
    workType = 'development',
    prompt: customPrompt,
    teamName,
    projectName,
    labels,
    mentionContext,
    dispatchModel,
    dispatchSubAgentModel,
    architecturalContext: prebuiltArchContext,
  } = options

  // Resolve provider (and full profile when profiles are configured)
  const { provider: spawnProvider, providerName: spawnProviderName, source: providerSource, resolvedProfile } =
    this.resolveProviderForSpawn({ workType, projectName, labels, mentionContext, dispatchModel, dispatchSubAgentModel })

  // Extract model, effort, and sub-agent config from profile or legacy resolution
  let resolvedModel: string | undefined
  let resolvedSubAgentModel: string | undefined
  let resolvedEffort: import('../config/profiles.js').EffortLevel | undefined
  let resolvedProviderConfig: Record<string, unknown> | undefined
  let resolvedSubAgentProvider: AgentProviderName | undefined
  let resolvedSubAgentEffort: string | undefined

  if (resolvedProfile) {
    // Profile-based path
    resolvedModel = resolvedProfile.model
    resolvedEffort = resolvedProfile.effort
    resolvedProviderConfig = resolvedProfile.providerConfig
    resolvedSubAgentModel = resolvedProfile.subAgent?.model
    resolvedSubAgentProvider = resolvedProfile.subAgent?.provider
    resolvedSubAgentEffort = resolvedProfile.subAgent?.effort
  } else {
    // Legacy path
    const { model, source: modelSource } = resolveModelWithSource({
      dispatchModel,
      labels,
      workType,
      project: projectName,
      configModels: this.configModels,
    })
    resolvedModel = model
    resolvedSubAgentModel = resolveSubAgentModel({
      dispatchSubAgentModel,
      configModels: this.configModels,
    })
    if (resolvedModel) {
      const log = createLogger({ issueIdentifier: identifier })
      log.info('Model resolved (legacy)', { model: resolvedModel, source: modelSource })
    }
  }

  if (resolvedModel) {
    const log = createLogger({ issueIdentifier: identifier })
    log.info('Model resolved', { model: resolvedModel, source: providerSource, effort: resolvedEffort })
  }

  // Generate prompt. Template registry is the authoritative source for
  // workflow instructions (commit/push/PR ladder, scope audit, path scoping,
  // etc.). When a caller supplies a `prompt` (customPrompt) via webhook,
  // governor, or platform dispatch, treat it as caller-provided context and
  // fold it into the template's `mentionContext` slot so the template's
  // mandatory directives are never displaced.
  //
  // Rules:
  //   1. Template exists → render it; customPrompt becomes mentionContext.
  //   2. Template missing, customPrompt set → use customPrompt verbatim (legacy).
  //   3. Template missing, no customPrompt → generatePromptForWorkType fallback.
  let prompt: string
  const hasTemplate = this.templateRegistry?.hasTemplate(workType) ?? false
  // Merge customPrompt with any explicit mentionContext. See
  // mergeMentionContext() for the merge semantics.
  const mergedMentionContext = mergeMentionContext(mentionContext, customPrompt)

  // --- Use pre-built architectural context ---
  // The architectural context is pre-built by async callers (spawnAgentForIssue,
  // spawnAgentWithResume) via buildArchitecturalContext() before calling
  // spawnAgent(). This keeps spawnAgent() synchronous.
  const architecturalContext = prebuiltArchContext

  if (hasTemplate) {
    // Resolve per-project config overrides (falls back to repo-wide defaults)
    const perProject = projectName && this.repoConfig
      ? getProjectConfig(this.repoConfig, projectName)
      : null

    const context: TemplateContext = {
      identifier,
      repository: this.config.repository,
      projectPath: perProject?.path ?? this.projectPaths?.[projectName ?? ''],
      sharedPaths: this.sharedPaths,
      useToolPlugins: (spawnProvider.capabilities.supportsToolPlugins ?? false) && this.toolRegistry.getPlugins().length > 0,
      hasCodeIntelligence: this.toolRegistry.getPlugins().some(p => p.name === 'af-code-intelligence'),
      linearCli: this.linearCli ?? 'rensei linear',
      packageManager: perProject?.packageManager ?? this.packageManager ?? 'pnpm',
      buildCommand: perProject?.buildCommand ?? this.buildCommand,
      testCommand: perProject?.testCommand ?? this.testCommand,
      validateCommand: perProject?.validateCommand ?? this.validateCommand,
      agentBugBacklog: process.env.AGENT_BUG_BACKLOG || undefined,
      mergeQueueEnabled: !!this.mergeQueueAdapter,
      qualityBaseline: this.loadQualityBaselineForContext(worktreePath),
      model: resolvedModel,
      subAgentModel: resolvedSubAgentModel,
      effort: resolvedEffort,
      subAgentEffort: resolvedSubAgentEffort,
      subAgentProvider: resolvedSubAgentProvider,
      mentionContext: mergedMentionContext,
      architecturalContext,
    }
    const rendered = this.templateRegistry!.renderPrompt(workType, context)
    prompt = rendered ?? customPrompt ?? generatePromptForWorkType(identifier, workType)
  } else if (customPrompt) {
    prompt = customPrompt
  } else {
    prompt = generatePromptForWorkType(identifier, workType)
  }

  // Create logger for this agent
  const log = createLogger({ issueIdentifier: identifier })
  this.agentLoggers.set(issueId, log)

  const now = new Date()
  const agent: AgentProcess = {
    issueId,
    identifier,
    worktreeIdentifier,
    sessionId,
    worktreePath,
    pid: undefined,
    status: 'starting',
    startedAt: now,
    lastActivityAt: now, // Initialize for inactivity tracking
    workType,
    providerName: spawnProviderName,
  }

  this.activeAgents.set(issueId, agent)

  // Track session to issue mapping for stop signal handling
  if (sessionId) {
    this.sessionToIssue.set(sessionId, issueId)
  }

  // Initialize state persistence and monitoring (only for worktree-based agents)
  if (worktreePath) {
    try {
      // Write initial state
      const initialState = createInitialState({
        issueId,
        issueIdentifier: identifier,
        linearSessionId: sessionId ?? null,
        workType,
        prompt,
        workerId: this.config.apiActivityConfig?.workerId ?? null,
        pid: null, // Will be updated when process spawns
      })
      // Track which provider was used so recovery can detect provider changes
      initialState.providerName = spawnProviderName
      writeState(worktreePath, initialState)

      // Start heartbeat writer for crash detection
      const heartbeatWriter = createHeartbeatWriter({
        agentDir: resolve(worktreePath, '.agent'),
        pid: process.pid, // Will be updated to child PID after spawn
        intervalMs: getHeartbeatIntervalFromEnv(),
        startTime: now.getTime(),
      })
      heartbeatWriter.start()
      this.heartbeatWriters.set(issueId, heartbeatWriter)

      // Start progress logger for debugging
      const progressLogger = createProgressLogger({
        agentDir: resolve(worktreePath, '.agent'),
      })
      progressLogger.logStart({ issueId, workType, prompt: prompt.substring(0, 200) })
      this.progressLoggers.set(issueId, progressLogger)

      // Start session logger for verbose analysis if enabled
      if (isSessionLoggingEnabled()) {
        const logConfig = getLogAnalysisConfig()
        const sessionLogger = createSessionLogger({
          sessionId: sessionId ?? issueId,
          issueId,
          issueIdentifier: identifier,
          workType,
          prompt,
          logsDir: logConfig.logsDir,
          workerId: this.config.apiActivityConfig?.workerId,
        })
        this.sessionLoggers.set(issueId, sessionLogger)
        log.debug('Session logging initialized', { logsDir: logConfig.logsDir })
      }

      // Initialize context manager for context window management
      const contextManager = ContextManager.load(worktreePath)
      this.contextManagers.set(issueId, contextManager)

      log.debug('State persistence initialized', { agentDir: resolve(worktreePath, '.agent') })
    } catch (stateError) {
      // Log but don't fail - state persistence is optional
      log.warn('Failed to initialize state persistence', {
        error: stateError instanceof Error ? stateError.message : String(stateError),
      })
    }
  }

  this.events.onAgentStart?.(agent)

  // Set up activity streaming if sessionId is provided
  const shouldStream = streamActivities ?? !!sessionId
  let emitter: ActivityEmitter | ApiActivityEmitter | null = null

  if (shouldStream && sessionId) {
    // Check if we should use API-based activity emitter (for remote workers)
    // This proxies activities through the agent app which has OAuth tokens
    if (this.config.apiActivityConfig) {
      const { baseUrl, apiKey, workerId } = this.config.apiActivityConfig
      log.debug('Using API activity emitter', { baseUrl })

      emitter = createApiActivityEmitter({
        sessionId,
        workerId,
        apiBaseUrl: baseUrl,
        apiKey,
        minInterval: this.config.streamConfig.minInterval,
        maxOutputLength: this.config.streamConfig.maxOutputLength,
        includeTimestamps: this.config.streamConfig.includeTimestamps,
        onActivityEmitted: (type, content) => {
          log.activity(type, content)
        },
        onActivityError: (type, error) => {
          log.error(`Activity error (${type})`, { error: error.message })
        },
      })
    } else {
      // Direct Linear API - only works with OAuth tokens (not API keys)
      // This will fail for createAgentActivity calls but works for comments
      const session = this.client.createSession({
        issueId,
        sessionId,
        autoTransition: false, // Orchestrator handles transitions
      })
      this.agentSessions.set(issueId, session)

      // Create ActivityEmitter with rate limiting
      emitter = createActivityEmitter({
        session,
        minInterval: this.config.streamConfig.minInterval,
        maxOutputLength: this.config.streamConfig.maxOutputLength,
        includeTimestamps: this.config.streamConfig.includeTimestamps,
        onActivityEmitted: (type, content) => {
          log.activity(type, content)
        },
      })
    }
    this.activityEmitters.set(issueId, emitter)
  }

  // Create AbortController for cancellation
  const abortController = new AbortController()
  this.abortControllers.set(issueId, abortController)

  // Load environment from settings.local.json and app .env files.
  // Pass the main repo root so these functions can find gitignored files
  // (settings.local.json, .env.local) that only exist in the main repo.
  const envBaseDir = worktreePath ?? process.cwd()
  const settingsEnv = loadSettingsEnv(envBaseDir, log, this.gitRoot)
  const appEnv = loadAppEnvFiles(envBaseDir, workType, log, this.gitRoot)

  // Build environment variables - inherit ALL from process.env (required for node to be found)
  // Then overlay app env vars, settings.local.json env vars, then our specific vars
  const processEnvFiltered: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !AGENT_ENV_BLOCKLIST.includes(key)) {
      processEnvFiltered[key] = value
    }
  }

  const filteredAppEnv = Object.fromEntries(
    Object.entries(appEnv).filter(([key]) => !AGENT_ENV_BLOCKLIST.includes(key))
  )
  const filteredSettingsEnv = Object.fromEntries(
    Object.entries(settingsEnv).filter(([key]) => !AGENT_ENV_BLOCKLIST.includes(key))
  )

  const env: Record<string, string> = {
    ...processEnvFiltered, // Include all parent env vars (PATH, NODE_PATH, etc.)
    ...filteredAppEnv, // Include app env vars (blocklisted keys stripped)
    ...filteredSettingsEnv, // Include settings.local.json env vars (blocklisted keys stripped)
    LINEAR_ISSUE_ID: issueId,
    // Disable user .npmrc to prevent picking up expired auth tokens from ~/.npmrc
    // Point to a non-existent file so npm/pnpm won't try to use stale credentials
    NPM_CONFIG_USERCONFIG: '/dev/null',
    npm_config_userconfig: '/dev/null',
  }

  if (sessionId) {
    env.LINEAR_SESSION_ID = sessionId
  }

  // Set work type so agent knows what kind of work it's doing
  env.LINEAR_WORK_TYPE = workType

  // Flag shared worktree for coordination mode so sub-agents know not to modify git state
  if (workType === 'development' || workType === 'inflight' || workType === 'qa' || workType === 'acceptance' || workType === 'refinement-coordination') {
    env.SHARED_WORKTREE = 'true'
  }

  // Set Claude Code Task List ID for intra-issue task coordination
  // This enables Tasks to persist across crashes and be shared between subagents
  // Format: {issueIdentifier}-{WORKTYPE} (e.g., "ABC-123-DEV")
  env.CLAUDE_CODE_TASK_LIST_ID = worktreeIdentifier ?? `${identifier}-${WORK_TYPE_SUFFIX[workType]}`

  // Set team name so agents can use `rensei linear create-issue` without --team
  if (teamName) {
    env.LINEAR_TEAM_NAME = teamName
  }

  // Pass API proxy URL and auth token so rensei/af linear CLI can proxy through
  // the platform API when LINEAR_API_KEY is not available.
  // Without AGENTFACTORY_API_URL the CLI falls back to direct LinearAgentClient
  // which requires LINEAR_API_KEY and fails with 401 in platform-delegated setups.
  if (this.config.apiActivityConfig?.baseUrl) {
    env.AGENTFACTORY_API_URL = this.config.apiActivityConfig.baseUrl
  }
  if (this.config.apiActivityConfig?.apiKey) {
    env.WORKER_AUTH_TOKEN = this.config.apiActivityConfig.apiKey
  }

  log.info('Starting agent via provider', { provider: spawnProviderName, source: providerSource, cwd: worktreePath ?? 'repo-root', workType, promptPreview: prompt.substring(0, 50) })

  // Create stdio MCP server configs for tool plugins.
  // Stdio servers are used for all providers (Claude + Codex) so that
  // sub-agents spawned via the Agent tool inherit the tool servers.
  // In-process servers (createServers) only work for the top-level agent.
  const toolPluginContext = {
    env,
    cwd: worktreePath ?? process.cwd(),
    ...(this.config.fileReservation ? { fileReservation: this.config.fileReservation } : {}),
  }
  const stdioServers = this.toolRegistry.getPlugins().length > 0
    ? this.toolRegistry.createStdioServerConfigs(toolPluginContext)
    : undefined

  // Coordinators need significantly more turns than standard agents
  // since they spawn sub-agents and poll their status repeatedly.
  // Inflight also gets the bump — it may be resuming coordination work.
  const needsMoreTurns = workType === 'development' || workType === 'inflight' || workType === 'qa' || workType === 'acceptance' || workType === 'refinement-coordination'
  const maxTurns = needsMoreTurns ? 200 : undefined

  // Build code intelligence enforcement config.
  // Only providers with canUseTool-style enforcement (supportsCodeIntelligenceEnforcement) can use this.
  const hasCodeIntel = this.toolRegistry.getPlugins().some(p => p.name === 'af-code-intelligence')
  const supportsToolPlugins = (spawnProvider.capabilities.supportsToolPlugins ?? false) && this.toolRegistry.getPlugins().length > 0
  const codeIntelEnforcement = (
    this.repoConfig?.codeIntelligence?.enforceUsage &&
    hasCodeIntel &&
    (spawnProvider.capabilities.supportsCodeIntelligenceEnforcement ?? false)
  ) ? {
    enforceUsage: true,
    fallbackAfterAttempt: this.repoConfig.codeIntelligence.fallbackAfterAttempt ?? true,
  } : undefined

  // Build base instructions and permission config for providers that need them.
  // Capability-driven: any provider declaring needsBaseInstructions/needsPermissionConfig gets them.
  const baseInstructions = (spawnProvider.capabilities.needsBaseInstructions ?? false)
    ? this.buildBaseInstructions({
        workType,
        worktreePath,
        hasCodeIntelligence: hasCodeIntel,
        codeIntelEnforced: this.repoConfig?.codeIntelligence?.enforceUsage ?? false,
        useToolPlugins: supportsToolPlugins,
      })
    : undefined
  const permissionConfig = (spawnProvider.capabilities.needsPermissionConfig ?? false) && this.templateRegistry
    ? this.buildPermissionConfig(workType)
    : undefined

  // Resolve systemPrompt append from RepositoryConfig for Claude provider
  const systemPromptAppendSections: string[] = []
  if (this.repoConfig?.systemPrompt?.append) {
    systemPromptAppendSections.push(this.repoConfig.systemPrompt.append.trim())
  }
  if (workType && this.repoConfig?.systemPrompt?.byWorkType?.[workType]) {
    systemPromptAppendSections.push(this.repoConfig.systemPrompt.byWorkType[workType].trim())
  }
  const systemPromptAppend = systemPromptAppendSections.length > 0
    ? systemPromptAppendSections.join('\n\n')
    : undefined

  // gate the per-step reasoning-effort hint on the provider's
  // capabilities.supportsReasoningEffort flag. Drops + emits a Layer 6
  // capability-mismatch warning when the provider can't honor it, so the
  // dispatch never silently ignores cost-control hints.
  const effortDecision = applyReasoningEffort({
    provider: spawnProvider,
    requestedEffort: resolvedEffort,
  })
  if (effortDecision.dropped) {
    log.warn('Per-step reasoning-effort hint dropped (provider does not support it)', {
      provider: spawnProviderName,
      requestedEffort: resolvedEffort,
    })
  }

  // Spawn agent via provider interface
  const spawnConfig: AgentSpawnConfig = {
    prompt,
    cwd: worktreePath ?? process.cwd(),
    env,
    abortController,
    autonomous: true,
    sandboxEnabled: this.config.sandboxEnabled,
    mcpToolNames: stdioServers?.toolNames,
    mcpStdioServers: stdioServers?.servers,
    maxTurns,
    model: resolvedModel,
    effort: effortDecision.effort,
    providerConfig: resolvedProviderConfig,
    subAgentProvider: resolvedSubAgentProvider,
    baseInstructions,
    permissionConfig,
    codeIntelligenceEnforcement: codeIntelEnforcement,
    systemPromptAppend,
    onProcessSpawned: (pid) => {
      agent.pid = pid
      log.info('Agent process spawned', { pid })
    },
  }

  const handle = spawnProvider.spawn(spawnConfig)

  this.agentHandles.set(issueId, handle)
  agent.status = 'running'

  // Process the event stream in the background
  this.processEventStream(issueId, identifier, sessionId, handle, emitter, agent)

  return agent
}

/**
 * Spawn agent for a single issue (webhook-triggered or CLI)
 * Generates a session ID if not provided to enable autonomous mode
 *
 * This method includes crash recovery support:
 * - If a worktree exists with valid state and stale heartbeat, triggers recovery
 * - If a worktree exists with fresh heartbeat (agent alive), throws error to prevent duplicates
 *
 * @param issueIdOrIdentifier - Issue ID or identifier (e.g., ABC-123)
 * @param sessionId - Optional Linear session ID
 * @param workType - Optional work type (auto-detected from issue status if not provided)
 * @param prompt - Optional custom prompt override
 */
export async function spawnAgentForIssue(
  this: AgentOrchestrator,  issueIdOrIdentifier: string,
  sessionId?: string,
  workType?: AgentWorkType,
  prompt?: string,
  extra?: { dispatchModel?: string; dispatchSubAgentModel?: string }
): Promise<AgentProcess> {
  console.log(`Fetching issue:`, issueIdOrIdentifier)
  const issue = await this.client.getIssue(issueIdOrIdentifier)
  const identifier = issue.identifier
  const issueId = issue.id // Use the actual UUID
  const teamName = issue.teamName

  // Labels for provider resolution (pre-resolved by IssueTrackerClient)
  const labelNames = issue.labels

  // Resolve project name for path scoping in monorepos
  let projectName: string | undefined
  if (this.projectPaths) {
    projectName = issue.projectName
  }

  console.log(`Processing single issue: ${identifier} (${issueId}) - ${issue.title}`)

  // Guard: skip work if the issue has moved to a terminal status since being queued
  const currentStatus = issue.status
  if (currentStatus && (this.statusMappings.terminalStatuses as readonly string[]).includes(currentStatus)) {
    throw new Error(
      `Issue ${identifier} is in terminal status '${currentStatus}' — skipping ${workType ?? 'auto'} work. ` +
      `The issue was likely accepted/canceled after being queued.`
    )
  }

  // Guard: skip sub-issues that should be managed by a coordinator, not spawned independently.
  // Only applies when no explicit work type is provided (i.e., orchestrator auto-pickup).
  // Coordinators spawning sub-agents always pass an explicit work type, so they bypass this check.
  if (!workType) {
    try {
      const isChild = await this.client.isChildIssue(issueId)
      if (isChild) {
        throw new Error(
          `Issue ${identifier} is a sub-issue managed by a parent agent — skipping independent pickup. ` +
          `Sub-issues should only be processed by their parent issue's agent.`
        )
      }
    } catch (err) {
      // Re-throw our own guard error; swallow API errors so we don't block on transient failures
      if (err instanceof Error && err.message.includes('managed by a parent agent')) {
        throw err
      }
      console.warn(`Failed to check child status for ${identifier}:`, err)
    }
  }

  // Defense in depth: re-validate git remote before spawning (guards against long-running instances)
  if (this.config.repository) {
    validateGitRemote(this.config.repository, this.gitRoot)
  }

  // Auto-detect work type from issue status if not provided
  // This must happen BEFORE creating worktree since path includes work type suffix
  let effectiveWorkType = workType
  if (!effectiveWorkType) {
    const statusName = issue.status ?? 'Backlog'
    effectiveWorkType = await this.detectWorkType(issueId, statusName)
  } else {
    // Re-validate work type from issue status in case the caller had a stale value.
    try {
      const revalidated = detectWorkTypeHelper(issue.status ?? 'Backlog', false, this.statusMappings.statusToWorkType)
      if (revalidated !== effectiveWorkType) {
        console.log(`Re-validated work type from ${effectiveWorkType} to ${revalidated}`)
        effectiveWorkType = revalidated
      }
    } catch (err) {
      console.warn(`Failed to re-validate work type:`, err)
    }
  }

  // Create isolated worktree for the agent
  let worktreePath: string | undefined
  let worktreeIdentifier: string | undefined

  if (this.statusMappings.workTypesRequiringWorktree.has(effectiveWorkType)) {
    const wt = this.createWorktree(identifier, effectiveWorkType)
    worktreePath = wt.worktreePath
    worktreeIdentifier = wt.worktreeIdentifier

    // Sync and link dependencies from main repo into worktree
    this.syncDependencies(worktreePath, identifier)

    // Check for existing state and potential recovery.
    // Pass `expectedIdentifier` so a worktree holding stale state from a
    // DIFFERENT issue (e.g., a reused path after a template change) can't
    // trigger a cross-issue recovery. The conflict-check call site at
    // cleanupConflictingBranch intentionally omits this option.
    const recoveryCheck = checkRecovery(worktreePath, {
      heartbeatTimeoutMs: getHeartbeatTimeoutFromEnv(),
      maxRecoveryAttempts: getMaxRecoveryAttemptsFromEnv(),
      expectedIdentifier: identifier,
    })

    if (recoveryCheck.agentAlive) {
      // Agent is still running - prevent duplicate
      throw new Error(
        `Agent already running for ${identifier}: ${recoveryCheck.message}. ` +
        `Stop the existing agent before spawning a new one.`
      )
    }

    if (recoveryCheck.reason === 'identifier_mismatch') {
      // Stale state from a different issue. Log loudly so this is visible
      // in ops — but don't fail; fall through to fresh spawn, which will
      // overwrite state.json with the current issue's identifier.
      console.warn(
        `[orchestrator] ${identifier}: worktree ${worktreePath} held stale state ` +
        `for ${recoveryCheck.state?.issueIdentifier} — refusing cross-issue recovery, starting fresh`
      )
    }

    if (recoveryCheck.canRecover && recoveryCheck.state) {
      // Crashed agent detected - trigger recovery
      console.log(`Recovery detected for ${identifier}: ${recoveryCheck.message}`)

      // Increment recovery attempts in state
      const updatedState = updateState(worktreePath, {
        recoveryAttempts: (recoveryCheck.state.recoveryAttempts ?? 0) + 1,
      })

      // Build recovery prompt
      const recoveryPrompt = prompt ?? buildRecoveryPrompt(recoveryCheck.state, recoveryCheck.todos)

      // Inherit work type from previous state if not provided
      const recoveryWorkType = workType ?? recoveryCheck.state.workType ?? effectiveWorkType

      // Use existing provider session ID for resume if available,
      // but clear it when the work type or provider has changed.
      // A session from a different work type or provider cannot be resumed —
      // attempting it produces errors and wastes the recovery attempt.
      const workTypeChanged = recoveryWorkType !== recoveryCheck.state.workType

      // Resolve which provider will handle this recovery to detect provider switches
      // (e.g., previous run was Claude but labels now route to Codex)
      const { name: recoveryProviderName } = resolveProviderWithSource({
        project: projectName,
        workType: recoveryWorkType,
        labels: labelNames,
        configProviders: this.configProviders,
      })
      const providerChanged = recoveryCheck.state.providerName != null &&
        recoveryProviderName !== recoveryCheck.state.providerName

      const shouldClearSession = workTypeChanged || providerChanged
      const providerSessionId = shouldClearSession
        ? undefined
        : (recoveryCheck.state.providerSessionId ?? undefined)
      if (shouldClearSession && recoveryCheck.state.providerSessionId) {
        const reason = providerChanged
          ? `provider changed from ${recoveryCheck.state.providerName} to ${recoveryProviderName}`
          : `work type changed from ${recoveryCheck.state.workType} to ${recoveryWorkType}`
        console.log(`Clearing stale providerSessionId — ${reason}`)
        updateState(worktreePath, { providerSessionId: null })
      }
      const effectiveSessionId = sessionId ?? recoveryCheck.state.linearSessionId ?? randomUUID()

      console.log(`Resuming work on ${identifier} (recovery attempt ${updatedState?.recoveryAttempts ?? 1})`)

      // Update status based on work type if auto-transition is enabled
      const startStatus = this.statusMappings.workTypeStartStatus[recoveryWorkType]
      if (this.config.autoTransition && startStatus) {
        await this.client.updateIssueStatus(issueId, startStatus)
        console.log(`Updated ${identifier} status to ${startStatus}`)
      }

      // Spawn with resume capability
      return this.spawnAgentWithResume({
        issueId,
        identifier,
        worktreeIdentifier,
        sessionId: effectiveSessionId,
        worktreePath,
        prompt: recoveryPrompt,
        providerSessionId,
        workType: recoveryWorkType,
        teamName,
        projectName,
        labels: labelNames,
      })
    }
  }

  // No recovery needed - proceed with fresh spawn
  // Update status based on work type if auto-transition is enabled
  const startStatus = this.statusMappings.workTypeStartStatus[effectiveWorkType]
  if (this.config.autoTransition && startStatus) {
    await this.client.updateIssueStatus(issueId, startStatus)
    console.log(`Updated ${identifier} status to ${startStatus}`)
  }

  // Generate session ID if not provided to enable autonomous mode
  // This ensures LINEAR_SESSION_ID is always set, triggering headless operation
  const effectiveSessionId = sessionId ?? randomUUID()

  // --- Pre-build architectural context (async, before synchronous spawnAgent) ---
  const archContextLog = createLogger({ issueIdentifier: identifier })
  const architecturalContext = await buildArchitecturalContext(
    {
      workType: effectiveWorkType ?? 'development',
      issueId,
      scope: { level: 'project', projectId: projectName ?? issueId },
      maxTokens: this.contextInjectionConfig.maxTokens,
      includeActiveDrift: true,
    },
    this.contextInjectionConfig,
    archContextLog,
  )
  if (architecturalContext) {
    archContextLog.info('Architectural Intelligence context injected at session start', {
      chars: architecturalContext.length,
      workType: effectiveWorkType,
    })
  }

  // Spawn agent with work type and optional custom prompt
  return this.spawnAgent({
    issueId,
    identifier,
    worktreeIdentifier,
    sessionId: effectiveSessionId,
    worktreePath,
    workType: effectiveWorkType,
    prompt,
    teamName,
    projectName,
    labels: labelNames,
    dispatchModel: extra?.dispatchModel,
    dispatchSubAgentModel: extra?.dispatchSubAgentModel,
    architecturalContext,
  })
}

/**
 * Spawn an agent with resume capability for continuing a previous session
 * If autoTransition is enabled, also transitions the issue status to the appropriate working state
 */
export async function spawnAgentWithResume(
  this: AgentOrchestrator,options: SpawnAgentWithResumeOptions): Promise<AgentProcess> {
  const { issueId, identifier, worktreeIdentifier, sessionId, worktreePath, prompt, providerSessionId, workType, teamName, labels, mentionContext, dispatchModel, dispatchSubAgentModel } = options

  // Resolve provider (and full profile when profiles are configured)
  const { provider: spawnProvider, providerName: spawnProviderName, source: providerSource, resolvedProfile } =
    this.resolveProviderForSpawn({ workType, projectName: options.projectName, labels, mentionContext, dispatchModel, dispatchSubAgentModel })

  // Extract model and effort from profile or legacy resolution
  let resolvedModel: string | undefined
  let resolvedEffort: import('../config/profiles.js').EffortLevel | undefined
  let resolvedProviderConfig: Record<string, unknown> | undefined

  if (resolvedProfile) {
    resolvedModel = resolvedProfile.model
    resolvedEffort = resolvedProfile.effort
    resolvedProviderConfig = resolvedProfile.providerConfig
  } else {
    const { model, source: modelSource } = resolveModelWithSource({
      dispatchModel,
      labels,
      workType,
      project: options.projectName,
      configModels: this.configModels,
    })
    resolvedModel = model
  }

  // Create logger for this agent
  const log = createLogger({ issueIdentifier: identifier })
  this.agentLoggers.set(issueId, log)

  if (resolvedModel) {
    log.info('Model resolved for resume', { model: resolvedModel, source: providerSource, effort: resolvedEffort })
  }

  // Use the work type to determine if we need to transition on start
  // Only certain work types trigger a start transition
  const effectiveWorkType = workType ?? 'development'
  const startStatus = this.statusMappings.workTypeStartStatus[effectiveWorkType]

  if (this.config.autoTransition && startStatus) {
    try {
      await this.client.updateIssueStatus(issueId, startStatus)
      log.info('Transitioned issue status on resume', { workType: effectiveWorkType, to: startStatus })
    } catch (error) {
      // Log but don't fail - status might already be in a working state
      log.warn('Failed to transition issue status', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const now = new Date()
  const agent: AgentProcess = {
    issueId,
    identifier,
    worktreeIdentifier,
    sessionId,
    providerSessionId,
    worktreePath,
    pid: undefined,
    status: 'starting',
    startedAt: now,
    lastActivityAt: now, // Initialize for inactivity tracking
    workType,
    providerName: spawnProviderName,
  }

  this.activeAgents.set(issueId, agent)

  // Track session to issue mapping for stop signal handling
  this.sessionToIssue.set(sessionId, issueId)

  // Initialize state persistence and monitoring (only for worktree-based agents)
  if (worktreePath) {
    try {
      // Write/update state with resume info
      const initialState = createInitialState({
        issueId,
        issueIdentifier: identifier,
        linearSessionId: sessionId,
        workType: effectiveWorkType,
        prompt,
        workerId: this.config.apiActivityConfig?.workerId ?? null,
        pid: null, // Will be updated when process spawns
      })
      // Preserve provider session ID if resuming
      if (providerSessionId) {
        initialState.providerSessionId = providerSessionId
      }
      // Track which provider was used so recovery can detect provider changes
      initialState.providerName = spawnProviderName
      writeState(worktreePath, initialState)

      // Start heartbeat writer for crash detection
      const heartbeatWriter = createHeartbeatWriter({
        agentDir: resolve(worktreePath, '.agent'),
        pid: process.pid, // Will be updated to child PID after spawn
        intervalMs: getHeartbeatIntervalFromEnv(),
        startTime: now.getTime(),
      })
      heartbeatWriter.start()
      this.heartbeatWriters.set(issueId, heartbeatWriter)

      // Start progress logger for debugging
      const progressLogger = createProgressLogger({
        agentDir: resolve(worktreePath, '.agent'),
      })
      progressLogger.logStart({ issueId, workType: effectiveWorkType, prompt: prompt.substring(0, 200) })
      this.progressLoggers.set(issueId, progressLogger)

      // Start session logger for verbose analysis if enabled
      if (isSessionLoggingEnabled()) {
        const logConfig = getLogAnalysisConfig()
        const sessionLogger = createSessionLogger({
          sessionId,
          issueId,
          issueIdentifier: identifier,
          workType: effectiveWorkType,
          prompt,
          logsDir: logConfig.logsDir,
          workerId: this.config.apiActivityConfig?.workerId,
        })
        this.sessionLoggers.set(issueId, sessionLogger)
        log.debug('Session logging initialized', { logsDir: logConfig.logsDir })
      }

      // Initialize context manager for context window management
      const contextManager = ContextManager.load(worktreePath)
      this.contextManagers.set(issueId, contextManager)

      log.debug('State persistence initialized', { agentDir: resolve(worktreePath, '.agent') })
    } catch (stateError) {
      // Log but don't fail - state persistence is optional
      log.warn('Failed to initialize state persistence', {
        error: stateError instanceof Error ? stateError.message : String(stateError),
      })
    }
  }

  this.events.onAgentStart?.(agent)

  // Set up activity streaming
  let emitter: ActivityEmitter | ApiActivityEmitter

  // Check if we should use API-based activity emitter (for remote workers)
  if (this.config.apiActivityConfig) {
    const { baseUrl, apiKey, workerId } = this.config.apiActivityConfig
    log.debug('Using API activity emitter', { baseUrl })

    emitter = createApiActivityEmitter({
      sessionId,
      workerId,
      apiBaseUrl: baseUrl,
      apiKey,
      minInterval: this.config.streamConfig.minInterval,
      maxOutputLength: this.config.streamConfig.maxOutputLength,
      includeTimestamps: this.config.streamConfig.includeTimestamps,
      onActivityEmitted: (type, content) => {
        log.activity(type, content)
      },
      onActivityError: (type, error) => {
        log.error(`Activity error (${type})`, { error: error.message })
      },
    })
  } else {
    // Direct issue tracker API
    const session = this.client.createSession({
      issueId,
      sessionId,
      autoTransition: false,
    })
    this.agentSessions.set(issueId, session)

    emitter = createActivityEmitter({
      session,
      minInterval: this.config.streamConfig.minInterval,
      maxOutputLength: this.config.streamConfig.maxOutputLength,
      includeTimestamps: this.config.streamConfig.includeTimestamps,
      onActivityEmitted: (type, content) => {
        log.activity(type, content)
      },
    })
  }
  this.activityEmitters.set(issueId, emitter)

  // Create AbortController for cancellation
  const abortController = new AbortController()
  this.abortControllers.set(issueId, abortController)

  // Load environment from settings.local.json and app .env files.
  // Pass the main repo root so these functions can find gitignored files.
  const envBaseDir = worktreePath ?? process.cwd()
  const settingsEnv = loadSettingsEnv(envBaseDir, log, this.gitRoot)
  const effectiveWorkTypeForEnv = workType ?? 'development'
  const appEnv = loadAppEnvFiles(envBaseDir, effectiveWorkTypeForEnv, log, this.gitRoot)

  // Build environment variables - inherit ALL from process.env (required for node to be found)
  // Then overlay app env vars, settings.local.json env vars, then our specific vars
  // Apply the same blocklist as spawnAgent() to prevent API key leakage
  const processEnvFiltered: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !AGENT_ENV_BLOCKLIST.includes(key)) {
      processEnvFiltered[key] = value
    }
  }

  const filteredAppEnv = Object.fromEntries(
    Object.entries(appEnv).filter(([key]) => !AGENT_ENV_BLOCKLIST.includes(key))
  )
  const filteredSettingsEnv = Object.fromEntries(
    Object.entries(settingsEnv).filter(([key]) => !AGENT_ENV_BLOCKLIST.includes(key))
  )

  const env: Record<string, string> = {
    ...processEnvFiltered, // Include all parent env vars (PATH, NODE_PATH, etc.)
    ...filteredAppEnv, // Include app env vars (blocklisted keys stripped)
    ...filteredSettingsEnv, // Include settings.local.json env vars (blocklisted keys stripped)
    LINEAR_ISSUE_ID: issueId,
    LINEAR_SESSION_ID: sessionId,
    // Set work type so agent knows if it's doing QA or development work
    ...(workType && { LINEAR_WORK_TYPE: workType }),
    // Set team name so agents can use `rensei linear create-issue` without --team
    ...(teamName && { LINEAR_TEAM_NAME: teamName }),
    // Pass API proxy URL and auth token so rensei/af linear CLI can proxy through the platform API
    ...(this.config.apiActivityConfig?.baseUrl && { AGENTFACTORY_API_URL: this.config.apiActivityConfig.baseUrl }),
    ...(this.config.apiActivityConfig?.apiKey && { WORKER_AUTH_TOKEN: this.config.apiActivityConfig.apiKey }),
  }

  log.info('Starting agent via provider', {
    provider: spawnProviderName,
    source: providerSource,
    cwd: worktreePath ?? 'repo-root',
    resuming: !!providerSessionId,
    workType: workType ?? 'development',
  })

  // Create stdio MCP server configs for tool plugins (same as spawn path)
  const toolPluginContext = {
    env,
    cwd: worktreePath ?? process.cwd(),
    ...(this.config.fileReservation ? { fileReservation: this.config.fileReservation } : {}),
  }
  const stdioServers = this.toolRegistry.getPlugins().length > 0
    ? this.toolRegistry.createStdioServerConfigs(toolPluginContext)
    : undefined

  // Coordinators need significantly more turns than standard agents
  const resolvedWorkType = workType ?? 'development'
  const needsMoreTurns = resolvedWorkType === 'development' || resolvedWorkType === 'inflight' || resolvedWorkType === 'qa' || resolvedWorkType === 'acceptance' || resolvedWorkType === 'refinement-coordination'
  const maxTurns = needsMoreTurns ? 200 : undefined

  // Build code intelligence and tool plugin flags
  const hasCodeIntel = this.toolRegistry.getPlugins().some(p => p.name === 'af-code-intelligence')
  const supportsToolPlugins = (spawnProvider.capabilities.supportsToolPlugins ?? false) && this.toolRegistry.getPlugins().length > 0

  // Build base instructions and permission config for providers that need them (capability-driven)
  const baseInstructions = (spawnProvider.capabilities.needsBaseInstructions ?? false)
    ? this.buildBaseInstructions({
        workType,
        worktreePath,
        hasCodeIntelligence: hasCodeIntel,
        codeIntelEnforced: this.repoConfig?.codeIntelligence?.enforceUsage ?? false,
        useToolPlugins: supportsToolPlugins,
      })
    : undefined
  const permissionConfig = (spawnProvider.capabilities.needsPermissionConfig ?? false) && this.templateRegistry
    ? this.buildPermissionConfig(workType)
    : undefined

  // Resolve systemPrompt append from RepositoryConfig for Claude provider
  const systemPromptAppendSections: string[] = []
  if (this.repoConfig?.systemPrompt?.append) {
    systemPromptAppendSections.push(this.repoConfig.systemPrompt.append.trim())
  }
  if (workType && this.repoConfig?.systemPrompt?.byWorkType?.[workType]) {
    systemPromptAppendSections.push(this.repoConfig.systemPrompt.byWorkType[workType].trim())
  }
  const systemPromptAppend = systemPromptAppendSections.length > 0
    ? systemPromptAppendSections.join('\n\n')
    : undefined

  // gate per-step reasoning-effort hint on provider capability.
  // Same drop-and-warn behaviour as the fresh-spawn path so resume sessions
  // can't sneak through with an effort hint a provider would silently ignore.
  const effortDecision = applyReasoningEffort({
    provider: spawnProvider,
    requestedEffort: resolvedEffort,
  })
  if (effortDecision.dropped) {
    log.warn('Per-step reasoning-effort hint dropped (provider does not support it)', {
      provider: spawnProviderName,
      requestedEffort: resolvedEffort,
      path: 'resume',
    })
  }

  // Spawn agent via provider interface (with resume if session ID available)
  const spawnConfig: AgentSpawnConfig = {
    prompt,
    cwd: worktreePath ?? process.cwd(),
    env,
    abortController,
    autonomous: true,
    sandboxEnabled: this.config.sandboxEnabled,
    mcpToolNames: stdioServers?.toolNames,
    mcpStdioServers: stdioServers?.servers,
    maxTurns,
    model: resolvedModel,
    effort: effortDecision.effort,
    providerConfig: resolvedProviderConfig,
    baseInstructions,
    permissionConfig,
    systemPromptAppend,
    onProcessSpawned: (pid) => {
      agent.pid = pid
      log.info('Agent process spawned', { pid })
    },
  }

  const handle = providerSessionId
    ? this.createResumeWithFallbackHandle(spawnProvider, providerSessionId, spawnConfig, agent, log)
    : spawnProvider.spawn(spawnConfig)

  // Retain the spawn config so post-session steering can resume with the same
  // model/effort/sandbox/env. Cleared after the backstop runs.
  this.steeringSpawnConfigs.set(issueId, spawnConfig)

  this.agentHandles.set(issueId, handle)
  agent.status = 'running'

  // Process the event stream in the background
  this.processEventStream(issueId, identifier, sessionId, handle, emitter, agent)

  return agent
}

/**
 * Post-session steering: if the agent exited without committing/pushing/
 * creating a PR and the provider supports session resume, re-enter the
 * session with a focused follow-up prompt so the agent can finish its own
 * work. The deterministic backstop still runs afterwards as a final safety
 * net — this just reduces how often it needs to auto-commit on the agent's
 * behalf.
 *
 * No-ops (returns immediately) when steering preconditions aren't met.
 */
export async function attemptSessionSteering(
  this: AgentOrchestrator,agent: AgentProcess, log: Logger | undefined): Promise<void> {
  const issueId = agent.issueId
  if (!agent.worktreePath) return

  const provider = agent.providerName ? this.providerCache.get(agent.providerName) : undefined
  const gitState = inspectGitStateForSteering(agent.worktreePath)
  const decision = decideSteering({ agent, provider, gitState })

  if (!decision.shouldAttempt) {
    log?.debug('Session steering skipped', { reason: decision.reason })
    return
  }

  const baseSpawnConfig = this.steeringSpawnConfigs.get(issueId)
  if (!baseSpawnConfig) {
    log?.debug('Session steering skipped', { reason: 'no stored spawn config' })
    return
  }

  log?.warn('Attempting session steering retry', {
    reason: decision.reason,
    provider: provider!.name,
    providerSessionId: agent.providerSessionId,
  })

  const steeringPrompt = buildSteeringPrompt({
    identifier: agent.identifier,
    gitState,
    hasPr: !!agent.pullRequestUrl,
  })

  const outcome = await runSteeringRetry({
    provider: provider!,
    providerSessionId: agent.providerSessionId!,
    baseSpawnConfig,
    steeringPrompt,
  })

  // Capture any PR URL the agent created during the retry
  if (outcome.detectedPrUrl && !agent.pullRequestUrl) {
    agent.pullRequestUrl = outcome.detectedPrUrl
  }

  log?.info('Session steering result', {
    reason: outcome.reason,
    succeeded: outcome.succeeded,
    detectedPrUrl: outcome.detectedPrUrl,
    eventsConsumed: outcome.eventsConsumed,
    error: outcome.error,
  })
}

/**
 * Create a resume handle that falls back to a fresh spawn if the session is stale.
 * This avoids wasting a recovery attempt when the Claude Code session has expired.
 */
export function createResumeWithFallbackHandle(
  this: AgentOrchestrator,  provider: AgentProvider,
  providerSessionId: string,
  spawnConfig: AgentSpawnConfig,
  agent: AgentProcess,
  log: Logger | undefined,
): AgentHandle {
  let currentHandle = provider.resume(providerSessionId, spawnConfig)

  const fallbackStream = async function* (): AsyncIterable<AgentEvent> {
    for await (const event of currentHandle.stream) {
      // Detect stale session error: the resume failed because the session no longer exists.
      // Claude: "No conversation found with session ID"
      // Codex: "thread/resume failed" or "thread/resume: ..."
      if (
        event.type === 'result' &&
        !event.success &&
        event.errors?.some(e =>
          e.includes('No conversation found with session ID') ||
          e.includes('thread/resume failed') ||
          e.includes('thread/resume:')
        )
      ) {
        log?.warn('Stale session detected during resume — falling back to fresh spawn', {
          staleSessionId: providerSessionId,
        })

        // Clear stale session from worktree state
        if (agent.worktreePath) {
          try {
            updateState(agent.worktreePath, { providerSessionId: null })
          } catch {
            // Ignore state update errors
          }
        }
        agent.providerSessionId = undefined

        // Spawn fresh and yield all its events instead
        currentHandle = provider.spawn(spawnConfig)
        yield* currentHandle.stream
        return
      }

      yield event
    }
  }

  return {
    get sessionId() { return currentHandle.sessionId },
    stream: fallbackStream(),
    injectMessage: (text: string) => currentHandle.injectMessage(text),
    stop: () => currentHandle.stop(),
  }
}

