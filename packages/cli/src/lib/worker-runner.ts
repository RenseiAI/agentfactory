/**
 * Worker Runner — Programmatic API for the remote worker CLI.
 *
 * Encapsulates all global state into the runner function's closure so that
 * multiple workers can be started from the same process (e.g. tests) without
 * leaking state between invocations.
 */

import path from 'path'
import { execSync } from 'child_process'
import os from 'os'
import {
  createOrchestrator,
  createLogger,
  NullIssueTrackerClient,
  type AgentProcess,
  type OrchestratorIssue,
  type AgentOrchestrator,
  type Logger,
  type ToolPlugin,
} from '@donmai/core'
import {
  LinearIssueTrackerClient,
  ProxyIssueTrackerAdapter,
  createLinearStatusMappings,
  linearPlugin,
  type AgentWorkType,
} from '@donmai/plugin-linear'
import {
  reserveFiles as serverReserveFiles,
  checkFileConflicts as serverCheckFileConflicts,
  releaseFiles as serverReleaseFiles,
  releaseAllSessionFiles as serverReleaseAllSessionFiles,
  isRedisConfigured,
  createSessionHeartbeat,
  verifyTenantEnvelope,
  sessionEventBus,
  type TenantEnvelope,
  type SessionHeartbeatHandle,
} from '@donmai/server'
import { createProxyFileReservationDelegate } from '@donmai/core'
import { withRoutingRecorder } from './routing-recorder.js'

let codeIntelligencePlugin: ToolPlugin | undefined
try {
  ;({ codeIntelligencePlugin } = await import('@donmai/code-intelligence'))
} catch {
  // code-intelligence is optional — agents run without af_code_* tools
}

// ---------------------------------------------------------------------------
// Public config interface
// ---------------------------------------------------------------------------

export interface WorkerRunnerConfig {
  /** Coordinator API URL */
  apiUrl: string
  /** API key for authentication */
  apiKey: string
  /** Worker hostname (default: os.hostname()) */
  hostname?: string
  /** Maximum concurrent agents (default: 3) */
  capacity?: number
  /** Poll but don't execute work (default: false) */
  dryRun?: boolean
  /** Linear API key for agent operations (default: process.env.LINEAR_API_KEY) */
  linearApiKey?: string
  /** Git repository root (default: auto-detect) */
  gitRoot?: string
  /** Linear project names to accept (undefined = all) */
  projects?: string[]
}

// ---------------------------------------------------------------------------
// Internal types (formerly file-level)
// ---------------------------------------------------------------------------

interface WorkerInternalConfig {
  apiUrl: string
  apiKey: string
  hostname: string
  capacity: number
  dryRun: boolean
}

interface WorkItem {
  sessionId: string
  issueId: string
  issueIdentifier: string
  priority: number
  queuedAt: number
  prompt?: string
  providerSessionId?: string
  workType?: AgentWorkType
  /** Model override from platform dispatch (e.g., 'claude-sonnet-4-6') */
  model?: string
  /** Sub-agent model override from platform dispatch */
  subAgentModel?: string
  /**
   * Tenant envelope injected at enqueue time per ADR-2026-04-29 §Decision 6.
   * Workers re-verify the JWT signature against the trust anchor and reject
   * jobs whose `org` claim does not match their registration.  REN-1399.
   */
  tenantEnvelope?: TenantEnvelope
}

interface InboxMessage {
  id: string
  type: 'stop' | 'directive' | 'hook-result' | 'nudge'
  sessionId: string
  payload: string
  userId?: string
  userName?: string
  createdAt: number
  lane: 'urgent' | 'normal'
}

interface PollResult {
  work: WorkItem[]
  inboxMessages: Record<string, InboxMessage[]>
  hasInboxMessages: boolean
  /** When true, work items are already claimed server-side — skip separate claim request */
  preClaimed?: boolean
  claimedSessionIds?: string[]
}

type ApiError =
  | { type: 'worker_not_found' }
  | { type: 'network_error'; message: string }
  | { type: 'server_error'; status: number; body: string }

interface ApiResult<T> {
  data: T | null
  error: ApiError | null
}

// ---------------------------------------------------------------------------
// Helpers (stateless)
// ---------------------------------------------------------------------------

function getGitRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return process.cwd()
  }
}

const MAX_HEARTBEAT_FAILURES = 3

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a worker that polls the coordinator for work and executes agents.
 *
 * All state is encapsulated in the function closure. The caller can cancel
 * via the optional {@link AbortSignal}.
 */
export async function runWorker(
  config: WorkerRunnerConfig,
  signal?: AbortSignal,
): Promise<void> {
  // Resolve config with defaults
  const hostname = config.hostname ?? os.hostname()
  const capacity = config.capacity ?? 3
  const dryRun = config.dryRun ?? false
  const gitRoot = config.gitRoot ?? getGitRoot()
  const linearApiKey = config.linearApiKey ?? process.env.LINEAR_API_KEY

  // -----------------------------------------------------------------------
  // State (formerly globals)
  // -----------------------------------------------------------------------
  let workerId: string | null = null
  let workerShortId: string | null = null
  let activeCount = 0
  let running = true
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let shutdownInProgress = false
  let consecutiveHeartbeatFailures = 0
  let reregistrationInProgress = false
  let claimFailureCount = 0
  const activeOrchestrators = new Map<string, AgentOrchestrator>()
  // Sessions whose ownership transfer failed during re-registration.
  // The stop checker in executeWork uses this to kill duplicate agents.
  const lostSessions = new Set<string>()

  // Logger — will be re-created after registration with worker context
  let log: Logger = createLogger({}, { showTimestamp: true })

  // Internal config object used by API helpers
  const workerConfig: WorkerInternalConfig = {
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
    hostname,
    capacity,
    dryRun,
  }

  // -----------------------------------------------------------------------
  // AbortSignal handling
  // -----------------------------------------------------------------------
  const onAbort = () => {
    if (shutdownInProgress) return
    shutdownInProgress = true
    log.warn('Shutting down (abort signal)...')
    running = false
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    // Fire and forget — server will clean up via heartbeat timeout
    deregister().catch(() => {})
  }

  signal?.addEventListener('abort', onAbort, { once: true })

  // -----------------------------------------------------------------------
  // API helpers (closures over workerConfig & log)
  // -----------------------------------------------------------------------

  async function apiRequestWithError<T>(
    apiPath: string,
    options: RequestInit = {},
    retries = 3,
  ): Promise<ApiResult<T>> {
    const url = `${workerConfig.apiUrl}${apiPath}`

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${workerConfig.apiKey}`,
            ...options.headers,
          },
        })

        if (!response.ok) {
          const errorBody = await response.text()

          if (response.status === 404 && errorBody.includes('Worker not found')) {
            log.warn(`Worker not found on server: ${apiPath}`, { status: response.status })
            return { data: null, error: { type: 'worker_not_found' } }
          }

          log.error(`API request failed: ${apiPath}`, { status: response.status, body: errorBody })
          return { data: null, error: { type: 'server_error', status: response.status, body: errorBody } }
        }

        return { data: (await response.json()) as T, error: null }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        const isLastAttempt = attempt === retries

        if (isLastAttempt) {
          log.error(`API request error: ${apiPath}`, { error: errorMsg, attempts: attempt })
          return { data: null, error: { type: 'network_error', message: errorMsg } }
        }

        const delay = Math.pow(2, attempt - 1) * 1000
        log.warn(`API request failed, retrying in ${delay}ms: ${apiPath}`, {
          error: errorMsg,
          attempt,
          maxRetries: retries,
        })
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    return { data: null, error: { type: 'network_error', message: 'Max retries exceeded' } }
  }

  async function apiRequest<T>(
    apiPath: string,
    options: RequestInit = {},
    retries = 3,
  ): Promise<T | null> {
    const result = await apiRequestWithError<T>(apiPath, options, retries)
    return result.data
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  async function register(): Promise<{
    workerId: string
    heartbeatInterval: number
    pollInterval: number
  } | null> {
    log.info('Registering with coordinator', {
      apiUrl: workerConfig.apiUrl,
      hostname: workerConfig.hostname,
      capacity: workerConfig.capacity,
    })

    const result = await apiRequest<{
      workerId: string
      heartbeatInterval: number
      pollInterval: number
    }>('/api/workers/register', {
      method: 'POST',
      body: JSON.stringify({
        hostname: workerConfig.hostname,
        capacity: workerConfig.capacity,
        version: '1.0.0',
        projects: config.projects,
      }),
    })

    if (result) {
      log.status('registered', `Worker ID: ${result.workerId.substring(0, 8)}`)
    }

    return result
  }

  async function transferSessionOwnership(
    sessionId: string,
    newWorkerId: string,
    oldWorkerId: string,
  ): Promise<boolean> {
    const result = await apiRequest<{ transferred: boolean; reason?: string }>(
      `/api/sessions/${sessionId}/transfer-ownership`,
      {
        method: 'POST',
        body: JSON.stringify({ newWorkerId, oldWorkerId }),
      },
    )

    if (result?.transferred) {
      log.debug('Session ownership transferred', {
        sessionId: sessionId.substring(0, 8),
        oldWorkerId: oldWorkerId.substring(0, 8),
        newWorkerId: newWorkerId.substring(0, 8),
      })
      return true
    } else {
      log.warn('Failed to transfer session ownership', {
        sessionId: sessionId.substring(0, 8),
        reason: result?.reason,
      })
      return false
    }
  }

  async function attemptReregistration(): Promise<boolean> {
    if (reregistrationInProgress) {
      log.debug('Re-registration already in progress, skipping')
      return false
    }

    reregistrationInProgress = true
    const oldWorkerId = workerId
    log.warn('Worker not found on server - attempting to re-register')

    try {
      const registration = await register()
      if (registration) {
        const newWid = registration.workerId
        const newShortId = newWid.substring(4, 8) // Skip 'wkr_' prefix

        // Transfer ownership of active sessions BEFORE updating workerId.
        // This prevents in-flight API calls from executeWork from using the
        // new worker ID before the server knows about the transfer.
        if (oldWorkerId && activeOrchestrators.size > 0) {
          log.info('Transferring ownership of active sessions', {
            sessionCount: activeOrchestrators.size,
            oldWorkerId: oldWorkerId.substring(0, 8),
            newWorkerId: newWid.substring(0, 8),
          })

          const transferPromises: Promise<boolean>[] = []
          for (const sessionId of activeOrchestrators.keys()) {
            transferPromises.push(
              transferSessionOwnership(sessionId, newWid, oldWorkerId),
            )
          }

          const results = await Promise.all(transferPromises)
          const successCount = results.filter(Boolean).length
          log.info('Session ownership transfer complete', {
            total: results.length,
            succeeded: successCount,
            failed: results.length - successCount,
          })

          // If any transfers failed, the sessions may have been reclaimed
          // by another worker. Mark those for ownership-loss detection so
          // the stop checker in executeWork can kill the duplicate agent.
          const sessionIds = Array.from(activeOrchestrators.keys())
          for (let i = 0; i < results.length; i++) {
            if (!results[i]) {
              lostSessions.add(sessionIds[i])
              log.warn('Session ownership lost — another worker may have claimed it', {
                sessionId: sessionIds[i].substring(0, 8),
              })
            }
          }
        }

        // NOW update workerId — transfers are done, so in-flight API calls
        // from executeWork will use the correct (new) ID going forward.
        workerId = newWid
        workerShortId = newShortId
        consecutiveHeartbeatFailures = 0
        log.status('re-registered', `New Worker ID: ${workerShortId}`)

        // Update worker ID in all active orchestrators' activity emitters
        for (const [sessionId, orchestrator] of activeOrchestrators.entries()) {
          orchestrator.updateWorkerId(newWid)
          log.debug('Updated orchestrator worker ID', {
            sessionId: sessionId.substring(0, 8),
          })
        }

        return true
      }
      log.error('Re-registration failed')
      return false
    } finally {
      reregistrationInProgress = false
    }
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  async function sendHeartbeat(): Promise<void> {
    if (!workerId) return

    const result = await apiRequestWithError<{
      acknowledged: boolean
      serverTime: string
      pendingWorkCount: number
    }>(`/api/workers/${workerId}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({
        activeCount,
        load: {
          cpu: os.loadavg()[0],
          memory: 1 - os.freemem() / os.totalmem(),
        },
      }),
    })

    if (result.data) {
      consecutiveHeartbeatFailures = 0

      if (claimFailureCount > 0) {
        log.debug('Claim race summary since last heartbeat', { claimFailures: claimFailureCount })
        claimFailureCount = 0
      }

      log.debug('Heartbeat acknowledged', {
        activeCount,
        pendingWorkCount: result.data.pendingWorkCount,
      })
    } else if (result.error?.type === 'worker_not_found') {
      consecutiveHeartbeatFailures++
      await attemptReregistration()
    } else {
      consecutiveHeartbeatFailures++
      log.warn('Heartbeat failed', {
        consecutiveFailures: consecutiveHeartbeatFailures,
        maxFailures: MAX_HEARTBEAT_FAILURES,
        errorType: result.error?.type,
      })

      if (consecutiveHeartbeatFailures >= MAX_HEARTBEAT_FAILURES) {
        log.error('Multiple heartbeat failures - checking if re-registration needed', {
          consecutiveFailures: consecutiveHeartbeatFailures,
        })
        await attemptReregistration()
      }
    }
  }

  // -----------------------------------------------------------------------
  // Polling & claiming
  // -----------------------------------------------------------------------

  async function pollForWork(): Promise<PollResult> {
    if (!workerId) return { work: [], inboxMessages: {}, hasInboxMessages: false }

    const result = await apiRequestWithError<PollResult>(
      `/api/workers/${workerId}/poll`,
    )

    if (result.error?.type === 'worker_not_found') {
      await attemptReregistration()
      return { work: [], inboxMessages: {}, hasInboxMessages: false }
    }

    if (!result.data) {
      return { work: [], inboxMessages: {}, hasInboxMessages: false }
    }

    const pollData = result.data

    if (pollData.hasInboxMessages) {
      const totalMessages = Object.values(pollData.inboxMessages).reduce(
        (sum, messages) => sum + messages.length,
        0,
      )
      log.info('Received inbox messages', {
        sessionCount: Object.keys(pollData.inboxMessages).length,
        totalMessages,
        sessions: Object.entries(pollData.inboxMessages).map(([sessionId, messages]) => ({
          sessionId: sessionId.substring(0, 8),
          messageCount: messages.length,
          messageIds: messages.map((m) => m.id),
          types: messages.map((m) => m.type),
        })),
      })
    }

    return pollData
  }

  async function claimWork(
    sessionId: string,
  ): Promise<{ claimed: boolean; work?: WorkItem } | null> {
    if (!workerId) return null

    return apiRequest(`/api/sessions/${sessionId}/claim`, {
      method: 'POST',
      body: JSON.stringify({ workerId }),
    })
  }

  async function ackInboxMessage(
    sessionId: string,
    message: InboxMessage,
  ): Promise<void> {
    await apiRequest(`/api/sessions/${sessionId}/inbox/ack`, {
      method: 'POST',
      body: JSON.stringify({
        messageId: message.id,
        lane: message.lane,
      }),
    })
  }

  async function reportStatus(
    sessionId: string,
    status: 'running' | 'finalizing' | 'completed' | 'failed' | 'stopped',
    extra?: { providerSessionId?: string; worktreePath?: string; error?: { message: string }; totalCostUsd?: number; inputTokens?: number; outputTokens?: number },
  ): Promise<void> {
    if (!workerId) return

    await apiRequest(`/api/sessions/${sessionId}/status`, {
      method: 'POST',
      body: JSON.stringify({
        workerId,
        status,
        ...extra,
      }),
    })

    log.debug(`Reported status: ${status}`, { sessionId })
  }

  async function postProgress(
    sessionId: string,
    milestone: string,
    message: string,
  ): Promise<void> {
    if (!workerId) return

    const result = await apiRequest<{ posted: boolean; reason?: string }>(
      `/api/sessions/${sessionId}/progress`,
      {
        method: 'POST',
        body: JSON.stringify({
          workerId,
          milestone,
          message,
        }),
      },
    )

    if (result?.posted) {
      log.debug(`Progress posted: ${milestone}`, { sessionId })
    } else {
      log.warn(`Failed to post progress: ${milestone}`, { reason: result?.reason })
    }
  }

  async function checkSessionOwnership(
    sessionId: string,
  ): Promise<{ workerId?: string; status?: string } | null> {
    return apiRequest<{ workerId?: string; status?: string }>(
      `/api/sessions/${sessionId}/status`,
    )
  }

  async function checkSessionStopped(sessionId: string): Promise<boolean> {
    const result = await apiRequest<{ status: string }>(
      `/api/sessions/${sessionId}/status`,
    )
    return result?.status === 'stopped'
  }

  async function deregister(): Promise<void> {
    if (!workerId) return

    log.info('Deregistering worker')

    const result = await apiRequest<{
      deregistered: boolean
      unclaimedSessions: string[]
    }>(`/api/workers/${workerId}`, {
      method: 'DELETE',
    })

    if (result) {
      log.status('stopped', `Unclaimed sessions: ${result.unclaimedSessions.length}`)
    }

    workerId = null
  }

  // -----------------------------------------------------------------------
  // Agent logger factory
  // -----------------------------------------------------------------------

  function createAgentLogger(issueIdentifier: string): Logger {
    return log.child({ issueIdentifier })
  }

  // -----------------------------------------------------------------------
  // Work execution
  // -----------------------------------------------------------------------

  async function executeWork(work: WorkItem): Promise<void> {
    const agentLog = createAgentLogger(work.issueIdentifier)
    const isResume = !!work.providerSessionId

    agentLog.section(`${isResume ? 'Resuming' : 'Starting'} work on ${work.issueIdentifier}`)
    agentLog.info('Work details', {
      hasPrompt: !!work.prompt,
      isResume,
      workType: work.workType,
    })

    activeCount++

    // Two-phase completion: set in try/catch, read in finally
    let finalStatus: 'completed' | 'failed' | 'stopped' = 'failed'
    let statusPayload: { providerSessionId?: string; worktreePath?: string; error?: { message: string }; totalCostUsd?: number; inputTokens?: number; outputTokens?: number } | undefined
    // Tracks whether the agent was stopped due to ownership loss or user request
    let stopRequested = false

    // Issue lock TTL refresher
    let lockRefresher: ReturnType<typeof setInterval> | null = null

    // Per-step session heartbeat (REN-1399 / ADR Decision 5).  Started below
    // once we've passed the JWT envelope check; stopped in finally.
    let sessionHeartbeat: SessionHeartbeatHandle | null = null

    try {
      // -- Tenant envelope verification (REN-1399 / ADR Decision 6) --------
      // The dispatcher attaches a JWT envelope to every queued work item.
      // We re-verify the signature against the REN-1314 trust anchor and
      // confirm the `org` claim matches our registration.  Mismatch ->
      // emit `session.permission-denied` and reject before any tools fire.
      if (work.tenantEnvelope) {
        const trustedIssuersEnv = process.env.WORKER_JWT_TRUSTED_ISSUERS ?? ''
        const trustedIssuers = trustedIssuersEnv
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const workerOrg = process.env.WORKER_ORG_ID
        const hmacKey = process.env.WORKER_JWT_HMAC_KEY
        const issuerKeysJson = process.env.WORKER_JWT_ISSUER_PUBLIC_KEYS
        let issuerPublicKeys: Record<string, string> | undefined
        if (issuerKeysJson) {
          try {
            issuerPublicKeys = JSON.parse(issuerKeysJson) as Record<string, string>
          } catch {
            agentLog.warn('WORKER_JWT_ISSUER_PUBLIC_KEYS is not valid JSON; ignoring')
          }
        }

        // When the trust anchor is configured, enforcement is on.  Without
        // a configured workerOrg / trustedIssuers the verification is a
        // no-op (rollout window — falls back to the legacy WORKER_API_KEY
        // path).
        if (workerOrg && trustedIssuers.length > 0) {
          const verifyOpts = {
            trustedIssuers,
            workerOrg,
            ...(hmacKey && { hmacKey }),
            ...(issuerPublicKeys && { issuerPublicKeys }),
          }
          const result = verifyTenantEnvelope(work.tenantEnvelope, verifyOpts)
          if (!result.valid) {
            agentLog.error('Tenant envelope verification failed; rejecting work', {
              sessionId: work.sessionId.substring(0, 8),
              reason: result.reason,
              detail: result.detail,
            })
            // Emit a permission_denied audit event for the platform mirror.
            await sessionEventBus.emit({
              kind: 'session.permission-denied',
              sessionId: work.sessionId,
              workerId: workerId ?? 'unknown',
              emittedAt: Date.now(),
              reason: result.reason,
              ...(work.tenantEnvelope.org && { jobOrg: work.tenantEnvelope.org }),
              workerOrg,
            })
            finalStatus = 'failed'
            statusPayload = {
              error: { message: `permission_denied: ${result.reason}` },
            }
            await reportStatus(work.sessionId, 'finalizing').catch(() => {})
            await postProgress(
              work.sessionId,
              'failed',
              `Tenant verification failed: ${result.reason}`,
            )
            return
          }
        }
      }

      // -- Per-step session heartbeat (REN-1399 / ADR Decision 5) -----------
      sessionHeartbeat = createSessionHeartbeat({
        sessionId: work.sessionId,
        workerId: workerId ?? 'unknown',
      })
      sessionHeartbeat.start(work.workType)

      await reportStatus(work.sessionId, 'running')

      // Start lock TTL refresher (refresh every 60s, lock TTL is 2 hours)
      if (work.issueId) {
        lockRefresher = setInterval(async () => {
          try {
            const response = await apiRequest<{ refreshed: boolean }>(
              `/api/sessions/${work.sessionId}/lock-refresh`,
              {
                method: 'POST',
                body: JSON.stringify({ workerId, issueId: work.issueId }),
              },
            )
            if (response?.refreshed) {
              agentLog.debug('Issue lock TTL refreshed')
            }
          } catch {
            // Non-fatal — lock has a 2hr TTL so missing one refresh is fine
          }
        }, 60_000)
      }

      // Post initial progress
      await postProgress(
        work.sessionId,
        isResume ? 'resumed' : 'claimed',
        isResume
          ? `Resuming work on ${work.issueIdentifier}`
          : `Worker claimed ${work.issueIdentifier}. Setting up environment...`,
      )

      // Create orchestrator with API activity proxy
      // Priority: direct Linear API → proxy via platform API → null (no-op)
      let issueTrackerClient
      if (linearApiKey) {
        issueTrackerClient = new LinearIssueTrackerClient({ apiKey: linearApiKey })
      } else if (workerConfig.apiUrl && workerConfig.apiKey) {
        issueTrackerClient = new ProxyIssueTrackerAdapter({
          apiUrl: workerConfig.apiUrl,
          apiKey: workerConfig.apiKey,
        })
      } else {
        issueTrackerClient = new NullIssueTrackerClient()
      }
      const statusMappings = createLinearStatusMappings()

      // Create file reservation delegate.
      // Priority: direct Redis (OSS) → platform API proxy (SaaS) → disabled
      const repoId = path.basename(gitRoot)
      const fileReservation = isRedisConfigured() ? {
        reserveFiles: (sessionId: string, filePaths: string[], reason?: string) =>
          serverReserveFiles(repoId, sessionId, filePaths, reason),
        checkFileConflicts: (sessionId: string, filePaths: string[]) =>
          serverCheckFileConflicts(repoId, sessionId, filePaths),
        releaseFiles: (sessionId: string, filePaths: string[]) =>
          serverReleaseFiles(repoId, sessionId, filePaths),
        releaseAllSessionFiles: (sessionId: string) =>
          serverReleaseAllSessionFiles(repoId, sessionId),
      } : (workerConfig.apiUrl && workerConfig.apiKey)
        ? createProxyFileReservationDelegate({ apiUrl: workerConfig.apiUrl, apiKey: workerConfig.apiKey })
        : undefined

      const orchestrator = createOrchestrator(
        {
          maxConcurrent: 1,
          worktreePath: path.resolve(gitRoot, '..', path.basename(gitRoot) + '.wt'),
          issueTrackerClient,
          statusMappings,
          fileReservation,
          toolPlugins: [linearPlugin, codeIntelligencePlugin].filter(Boolean) as ToolPlugin[],
          apiActivityConfig: {
            baseUrl: workerConfig.apiUrl,
            apiKey: workerConfig.apiKey,
            workerId: workerId!,
          },
        },
        withRoutingRecorder({
          onIssueSelected: (issue: OrchestratorIssue) => {
            agentLog.info('Issue fetched', {
              title: issue.title.slice(0, 50),
              labels: issue.labels.join(', '),
            })
          },
          onAgentStart: (agent: AgentProcess) => {
            agentLog.status('running', agent.pid ? `PID: ${agent.pid}` : 'spawning')
            agentLog.debug('Agent details', {
              worktree: agent.worktreePath,
            })

            reportStatus(work.sessionId, 'running', {
              providerSessionId: agent.sessionId,
              worktreePath: agent.worktreePath,
            })

            postProgress(
              work.sessionId,
              'started',
              `Agent started working on ${agent.identifier}`,
            )
          },
          onAgentComplete: (agent: AgentProcess) => {
            agentLog.status('completed', `Exit code: ${agent.exitCode}`)
          },
          onAgentError: (_agent: AgentProcess, error: Error) => {
            agentLog.error('Agent error', { error: error.message })
          },
          onAgentStopped: (_agent: AgentProcess) => {
            agentLog.status('stopped')
          },
          onAgentIncomplete: (agent: AgentProcess) => {
            agentLog.warn('Agent incomplete - worktree preserved', {
              reason: agent.incompleteReason,
              worktreePath: agent.worktreePath,
            })
          },
          onProviderSessionId: (_sessionId: string, providerSessionId: string) => {
            agentLog.debug('Provider session captured', { providerSessionId })
            reportStatus(work.sessionId, 'running', {
              providerSessionId,
            })
          },
        }),
      )

      // Store orchestrator for prompt forwarding
      activeOrchestrators.set(work.sessionId, orchestrator)
      agentLog.debug('Orchestrator registered for session', {
        sessionId: work.sessionId.substring(0, 8),
      })

      let spawnedAgent: AgentProcess

      // Retry configuration for "agent already running" conflicts
      const MAX_SPAWN_RETRIES = 3
      const SPAWN_RETRY_DELAY_MS = 15000

      if (work.providerSessionId) {
        // Resume existing Claude session
        agentLog.info('Resuming provider session', {
          providerSessionId: work.providerSessionId.substring(0, 12),
        })

        const prompt = work.prompt || `Continue work on ${work.issueIdentifier}`
        const result = await orchestrator.forwardPrompt(
          work.issueId,
          work.sessionId,
          prompt,
          work.providerSessionId,
          work.workType,
        )

        if (!result.forwarded || !result.agent) {
          throw new Error(
            `Failed to resume session: ${result.reason || 'unknown error'}`,
          )
        }

        agentLog.success('Session resumed')
        spawnedAgent = result.agent
      } else {
        // Fresh start with retry logic
        agentLog.info('Spawning new agent', { workType: work.workType })

        let lastError: Error | null = null
        for (let attempt = 1; attempt <= MAX_SPAWN_RETRIES; attempt++) {
          try {
            spawnedAgent = await orchestrator.spawnAgentForIssue(
              work.issueIdentifier,
              work.sessionId,
              work.workType,
              work.prompt,
              { dispatchModel: work.model, dispatchSubAgentModel: work.subAgentModel },
            )
            break
          } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err))

            const isAgentRunning =
              lastError.message.includes('Agent already running') ||
              lastError.message.includes('Agent is still running')
            const isBranchConflict =
              lastError.message.includes('already checked out') ||
              lastError.message.includes('is already checked out at')
            const isRetriable = isAgentRunning || isBranchConflict

            if (isRetriable && attempt < MAX_SPAWN_RETRIES) {
              // For "agent already running" errors, check if another worker owns this session
              // If so, bail immediately instead of wasting retries
              if (isAgentRunning && !isBranchConflict) {
                try {
                  const sessionStatus = await checkSessionOwnership(work.sessionId)
                  if (sessionStatus?.workerId && sessionStatus.workerId !== workerId) {
                    agentLog.warn('Session owned by another worker, abandoning spawn', {
                      ownerWorkerId: sessionStatus.workerId.substring(0, 8),
                    })
                    throw new Error(`Session owned by another worker: ${sessionStatus.workerId}`)
                  }
                } catch (ownershipErr) {
                  // Re-throw ownership errors, swallow check failures
                  if (ownershipErr instanceof Error && ownershipErr.message.includes('Session owned by another worker')) {
                    throw ownershipErr
                  }
                }
              }

              const reason = isBranchConflict
                ? 'Branch in use by another agent'
                : 'Agent still running'
              agentLog.warn(
                `${reason}, waiting to retry (attempt ${attempt}/${MAX_SPAWN_RETRIES})`,
                { retryInMs: SPAWN_RETRY_DELAY_MS },
              )

              await postProgress(
                work.sessionId,
                'waiting',
                `${reason}, waiting to retry (${attempt}/${MAX_SPAWN_RETRIES})...`,
              )

              await new Promise((resolve) => setTimeout(resolve, SPAWN_RETRY_DELAY_MS))
            } else {
              throw lastError
            }
          }
        }

        if (!spawnedAgent!) {
          throw lastError || new Error('Failed to spawn agent after retries')
        }
      }

      agentLog.info('Agent spawned', {
        pid: spawnedAgent.pid,
        status: spawnedAgent.status,
      })

      // Historical warning: "Agent has no PID — spawn may have failed" used to
      // fire here when pid was missing. That check was correct for exec-mode
      // providers (Claude, Codex exec) where spawn starts a subprocess and
      // its PID is known synchronously. It false-positives for multiplexed
      // providers (Codex app-server) where a single shared process serves
      // many agent handles and the PID is only plumbed in after the first
      // event stream iteration. The actual spawn-failed case throws above
      // (MAX_SPAWN_RETRIES loop), so reaching this point with spawnedAgent
      // set already means spawn succeeded — log at debug instead of warn.
      if (!spawnedAgent.pid) {
        agentLog.debug('Agent pid not yet available (likely multiplexed provider — pid will appear after first stream iteration)')
      }

      // Start a stop signal checker (also detects ownership loss)
      const stopChecker = setInterval(async () => {
        try {
          // Fast path: check if re-registration flagged this session as lost
          if (lostSessions.has(work.sessionId)) {
            lostSessions.delete(work.sessionId)
            agentLog.warn('Session ownership lost during re-registration — stopping agent to prevent duplicate work')
            stopRequested = true
            clearInterval(stopChecker)
            await orchestrator.stopAgent(work.issueId, false)
            return
          }

          // Check for explicit stop signal
          if (await checkSessionStopped(work.sessionId)) {
            agentLog.warn('Stop signal received')
            stopRequested = true
            clearInterval(stopChecker)
            await orchestrator.stopAgent(work.issueId, false)
            return
          }

          // Periodic ownership check: verify the server still considers us the owner.
          // This catches cases where the server re-queued the session to another worker
          // during a heartbeat gap without an explicit stop signal.
          const ownerStatus = await checkSessionOwnership(work.sessionId)
          if (ownerStatus?.workerId && ownerStatus.workerId !== workerId) {
            agentLog.warn('Session owned by another worker — stopping agent to prevent duplicate work', {
              ourWorkerId: workerId?.substring(0, 8),
              ownerWorkerId: ownerStatus.workerId.substring(0, 8),
            })
            stopRequested = true
            clearInterval(stopChecker)
            await orchestrator.stopAgent(work.issueId, false)
          }
        } catch {
          // Ignore errors in stop checker
        }
      }, 5000)

      // Wait for agent to complete
      agentLog.info('Waiting for agent to complete...')
      const results = await orchestrator.waitForAll()
      // Shut down provider resources (e.g., Codex app-server) to prevent orphans
      await orchestrator.shutdownProviders()
      const agent = results[0]

      clearInterval(stopChecker)

      // Determine final status
      if (stopRequested || agent?.stopReason === 'user_request') {
        finalStatus = 'stopped'
        // Don't report status if we lost ownership — another worker owns this session
        const ownershipLost = agent?.stopReason !== 'user_request' && stopRequested
        if (!ownershipLost) {
          await reportStatus(work.sessionId, 'finalizing')
          await postProgress(work.sessionId, 'stopped', `Work stopped by user request`)
        }
        agentLog.status('stopped', ownershipLost ? 'Ownership lost — yielded to another worker' : 'Work stopped by user request')
      } else if (agent?.stopReason === 'timeout') {
        finalStatus = 'failed'
        statusPayload = { error: { message: 'Agent timed out' } }
        await reportStatus(work.sessionId, 'finalizing')
        await postProgress(work.sessionId, 'failed', `Work timed out`)
        agentLog.status('stopped', 'Work timed out')
      } else if (agent?.status === 'completed') {
        finalStatus = 'completed'
        statusPayload = {
          providerSessionId: agent.sessionId,
          worktreePath: agent.worktreePath,
          totalCostUsd: agent.totalCostUsd,
          inputTokens: agent.inputTokens,
          outputTokens: agent.outputTokens,
        }
        await reportStatus(work.sessionId, 'finalizing')
        await postProgress(
          work.sessionId,
          'completed',
          `Work completed successfully on ${work.issueIdentifier}`,
        )
        agentLog.success('Work completed successfully')
      } else {
        const errorMsg = agent?.error?.message || 'Agent did not complete successfully'
        finalStatus = 'failed'
        statusPayload = { error: { message: errorMsg } }
        await reportStatus(work.sessionId, 'finalizing')
        await postProgress(work.sessionId, 'failed', `Work failed: ${errorMsg}`)
        agentLog.error('Work failed', { error: errorMsg })
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      agentLog.error('Work execution failed', { error: errorMsg })
      finalStatus = 'failed'
      statusPayload = { error: { message: errorMsg } }
      await reportStatus(work.sessionId, 'finalizing').catch(() => {})
      await postProgress(work.sessionId, 'failed', `Work failed: ${errorMsg}`)
    } finally {
      if (lockRefresher) clearInterval(lockRefresher)

      // Stop the per-step session heartbeat (REN-1399). idempotent.
      if (sessionHeartbeat) {
        sessionHeartbeat.stop()
      }

      // Clean up lost session marker if present
      lostSessions.delete(work.sessionId)

      activeOrchestrators.delete(work.sessionId)
      agentLog.debug('Orchestrator unregistered for session', {
        sessionId: work.sessionId.substring(0, 8),
      })
      activeCount--

      // Report true terminal status AFTER all cleanup.
      // Skip if we lost ownership — the session belongs to another worker now,
      // and sending status updates would just produce 403 errors.
      if (finalStatus === 'stopped' && stopRequested) {
        agentLog.debug('Skipping final status report — session ownership was yielded')
      } else {
        await reportStatus(work.sessionId, finalStatus, statusPayload).catch((err) => {
          agentLog.error('Failed to report final status', {
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
    }
  }

  // -----------------------------------------------------------------------
  // Main logic
  // -----------------------------------------------------------------------

  try {
    log.section('AgentFactory Worker')
    log.info('Configuration', {
      apiUrl: workerConfig.apiUrl,
      hostname: workerConfig.hostname,
      capacity: workerConfig.capacity,
      dryRun: workerConfig.dryRun,
      projects: config.projects?.length ? config.projects : 'all',
    })

    // Register with coordinator
    const registration = await register()
    if (!registration) {
      throw new Error('Failed to register with coordinator')
    }

    workerId = registration.workerId
    workerShortId = registration.workerId.substring(0, 8)

    // Update logger with worker context
    log = createLogger({ workerId, workerShortId }, { showTimestamp: true })

    // Auto-inherit projects from server if not explicitly configured
    if (!config.projects?.length) {
      try {
        const serverConfig = await apiRequest<{ projects: string[] }>('/api/config')
        if (serverConfig?.projects?.length) {
          config.projects = serverConfig.projects
          log.info('Auto-inherited projects from server', { projects: config.projects })
        }
      } catch {
        log.debug('Could not fetch server config, using no project filter')
      }
    }

    // Set up heartbeat
    heartbeatTimer = setInterval(
      () => sendHeartbeat(),
      registration.heartbeatInterval,
    )

    // Send initial heartbeat
    await sendHeartbeat()

    // Main poll loop
    log.info('Starting poll loop...')

    while (running) {
      if (signal?.aborted) break

      try {
        const availableCapacity = workerConfig.capacity - activeCount

        const pollResult = await pollForWork()

        // Handle new work items if we have capacity
        if (availableCapacity > 0 && pollResult.work.length > 0) {
          log.info(`Found ${pollResult.work.length} work item(s)`, {
            activeCount,
            availableCapacity,
            preClaimed: pollResult.preClaimed ?? false,
          })

          for (const item of pollResult.work.slice(0, availableCapacity)) {
            if (!running) break

            // Server-side claiming: items are already claimed during poll
            if (pollResult.preClaimed) {
              log.status('claimed', item.issueIdentifier)

              if (workerConfig.dryRun) {
                log.info(`[DRY RUN] Would execute: ${item.issueIdentifier}`)
              } else {
                executeWork(item).catch((error) => {
                  log.error('Background work execution failed', {
                    error: error instanceof Error ? error.message : String(error),
                  })
                })
              }
              continue
            }

            // Legacy client-side claiming (fallback for older servers)
            const claimResult = await claimWork(item.sessionId)

            if (claimResult?.claimed) {
              log.status('claimed', item.issueIdentifier)

              if (workerConfig.dryRun) {
                log.info(`[DRY RUN] Would execute: ${item.issueIdentifier}`)
              } else {
                executeWork(item).catch((error) => {
                  log.error('Background work execution failed', {
                    error: error instanceof Error ? error.message : String(error),
                  })
                })
              }
            } else {
              claimFailureCount++
              log.debug(`Failed to claim work: ${item.issueIdentifier}`)
            }
          }
        }

        // Handle inbox messages for active sessions (urgent-first)
        if (pollResult.hasInboxMessages) {
          for (const [sessionId, messages] of Object.entries(pollResult.inboxMessages)) {
            for (const message of messages) {
              // Handle nudge: no-op wake signal, just discard
              if (message.type === 'nudge') {
                log.debug('Nudge received (no-op)', {
                  sessionId: sessionId.substring(0, 8),
                  messageId: message.id,
                })
                await ackInboxMessage(sessionId, message)
                continue
              }

              const orchestrator = activeOrchestrators.get(sessionId)

              // Handle stop signal: trigger graceful agent shutdown
              if (message.type === 'stop') {
                log.info('Stop signal received', {
                  sessionId: sessionId.substring(0, 8),
                  messageId: message.id,
                })
                if (orchestrator) {
                  const agent = orchestrator.getAgentBySession(sessionId)
                  if (agent) {
                    try {
                      await orchestrator.stopAgent(agent.issueId, false)
                      log.success('Agent stopped via inbox signal', {
                        sessionId: sessionId.substring(0, 8),
                      })
                    } catch (error) {
                      log.error('Failed to stop agent', {
                        sessionId: sessionId.substring(0, 8),
                        error: error instanceof Error ? error.message : String(error),
                      })
                    }
                  }
                }
                await ackInboxMessage(sessionId, message)
                continue
              }

              // Handle directive and hook-result: inject as follow-up prompt
              log.info('Processing inbox message', {
                sessionId: sessionId.substring(0, 8),
                messageId: message.id,
                type: message.type,
                lane: message.lane,
                payloadLength: message.payload.length,
                userName: message.userName,
              })

              if (!orchestrator) {
                log.warn('No active orchestrator found for session', {
                  sessionId: sessionId.substring(0, 8),
                  messageId: message.id,
                })
                continue
              }

              const agent = orchestrator.getAgentBySession(sessionId)
              const providerSessionId = agent?.providerSessionId

              try {
                const result = await orchestrator.forwardPrompt(
                  agent?.issueId ?? '',
                  sessionId,
                  message.payload,
                  providerSessionId,
                  agent?.workType,
                )

                if (result.forwarded) {
                  log.success(
                    result.injected
                      ? 'Message injected into running session'
                      : 'Inbox message forwarded successfully',
                    {
                      sessionId: sessionId.substring(0, 8),
                      messageId: message.id,
                      type: message.type,
                      injected: result.injected ?? false,
                      resumed: result.resumed,
                      newAgentPid: result.agent?.pid,
                    },
                  )

                  // ACK after successful delivery
                  await ackInboxMessage(sessionId, message)
                } else {
                  log.error('Failed to forward inbox message', {
                    sessionId: sessionId.substring(0, 8),
                    messageId: message.id,
                    type: message.type,
                    reason: result.reason,
                    error: result.error?.message,
                  })
                }
              } catch (error) {
                log.error('Error forwarding inbox message', {
                  sessionId: sessionId.substring(0, 8),
                  messageId: message.id,
                  error: error instanceof Error ? error.message : String(error),
                })
              }
            }
          }
        }
      } catch (error) {
        log.error('Poll loop error', {
          error: error instanceof Error ? error.message : String(error),
        })
      }

      // Wait before next poll (with jitter to desynchronize workers)
      const jitter = Math.floor(Math.random() * registration.pollInterval * 0.4)
      await new Promise((resolve) => setTimeout(resolve, registration.pollInterval + jitter))
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)

    // Clean up timers
    if (heartbeatTimer) clearInterval(heartbeatTimer)

    // Deregister if we haven't already
    if (workerId && !shutdownInProgress) {
      await deregister().catch(() => {})
    }

    log.status('stopped', 'Shutdown complete')
  }
}
