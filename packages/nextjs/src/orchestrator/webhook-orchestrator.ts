/**
 * Webhook Orchestrator Factory
 *
 * Creates a singleton orchestrator instance configured for webhook-triggered
 * agent spawning. Includes retry logic, idempotency, session state persistence,
 * and error activity emission to Linear.
 *
 * Consumers provide lifecycle hooks (e.g., onAgentComplete) for custom behavior
 * like marking issues as "agent-worked" for automated QA.
 */

import {
  createOrchestrator,
  type AgentOrchestrator,
  type AgentProcess,
} from '@donmai/core'
import {
  withRetry,
  AgentSpawnError,
  isRetryableError,
  createAgentSession,
  createLinearAgentClient,
  type RetryConfig,
} from '@donmai/plugin-linear'
import {
  createLogger,
  generateIdempotencyKey,
  isWebhookProcessed,
  markWebhookProcessed,
  unmarkWebhookProcessed,
  storeSessionState,
  getSessionState,
  updateProviderSessionId,
  updateSessionStatus,
  updateSessionCostData,
  getWorkflowState,
  updateWorkflowState,
  recordPhaseAttempt,
  incrementCycleCount,
  appendFailureSummary,
  clearWorkflowState,
  extractFailureReason,
  markAcceptanceCompleted,
  type WorkflowPhase,
} from '@donmai/server'
import { formatErrorForComment } from './error-formatting.js'
import type {
  WebhookOrchestratorConfig,
  WebhookOrchestratorHooks,
  WebhookOrchestratorInstance,
} from './types.js'

const log = createLogger('webhook-orchestrator')

const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  maxRetries: 2,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 5000,
  retryableStatusCodes: [429, 500, 502, 503, 504],
}

/**
 * Resolve the Linear client lazily from environment.
 * Used for error activity emission.
 */
function getLinearClientFromEnv() {
  const apiKey = process.env.LINEAR_ACCESS_TOKEN
  if (!apiKey) return null
  return createLinearAgentClient({ apiKey })
}

/**
 * Determine if a spawn error is retryable.
 */
function isSpawnErrorRetryable(error: unknown): boolean {
  if (isRetryableError(error)) return true

  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    if (message.includes('lock') || message.includes('busy') || message.includes('temporary')) {
      return true
    }
    if (message.includes('not found') || message.includes('enoent')) {
      return false
    }
  }

  return false
}

/**
 * Clean up resources after a failed spawn attempt.
 */
async function cleanupFailedSpawn(
  issueId: string,
  idempotencyKey: string
): Promise<void> {
  try {
    await unmarkWebhookProcessed(idempotencyKey)
    log.debug('Cleaned up resources for failed spawn', { issueId, idempotencyKey })
  } catch (cleanupError) {
    log.error('Cleanup error', { issueId, idempotencyKey, error: cleanupError })
  }
}

/**
 * Emit an error activity to Linear for tracking agent failures.
 */
async function emitAgentErrorActivity(
  issueId: string,
  error: Error,
  sessionId?: string
): Promise<void> {
  try {
    const client = getLinearClientFromEnv()
    if (!client) {
      log.warn('Cannot emit error activity: LINEAR_ACCESS_TOKEN not set')
      return
    }

    if (sessionId) {
      const session = createAgentSession({
        client,
        issueId,
        sessionId,
        autoTransition: false,
      })
      await session.emitError(error)
    } else {
      const errorMessage = formatErrorForComment(error)
      await client.createComment(issueId, errorMessage)
    }
    log.debug('Error activity emitted to Linear', { issueId, sessionId })
  } catch (emitError) {
    log.error('Failed to emit error activity', { issueId, sessionId, error: emitError })
  }
}

/**
 * Create a webhook orchestrator instance.
 *
 * @param config - Orchestrator configuration
 * @param hooks - Lifecycle hooks for custom behavior
 * @returns A webhook orchestrator instance
 *
 * @example
 * ```typescript
 * const orchestrator = createWebhookOrchestrator(
 *   { maxConcurrent: 10 },
 *   {
 *     onAgentComplete: async (agent) => {
 *       await markAgentWorked(agent.issueId, { ... })
 *     },
 *   }
 * )
 * ```
 */
export function createWebhookOrchestrator(
  config?: WebhookOrchestratorConfig,
  hooks?: WebhookOrchestratorHooks
): WebhookOrchestratorInstance {
  const retryConfig = config?.retryConfig ?? DEFAULT_RETRY_CONFIG

  let _orchestrator: AgentOrchestrator | null = null

  function getOrchestrator(): AgentOrchestrator {
    if (!_orchestrator) {
      const apiKey = process.env.LINEAR_ACCESS_TOKEN
      if (!apiKey) {
        throw new Error('LINEAR_ACCESS_TOKEN not set - orchestrator initialization failed')
      }

      _orchestrator = createOrchestrator(
        {
          linearApiKey: apiKey,
          maxConcurrent: config?.maxConcurrent ?? 10,
          autoTransition: config?.autoTransition ?? true,
        },
        {
          onAgentStart: (agent: AgentProcess) => {
            log.info('Agent started', {
              agentIdentifier: agent.identifier,
              agentPid: agent.pid,
              issueId: agent.issueId,
              sessionId: agent.sessionId,
            })
          },
          onAgentComplete: async (agent: AgentProcess) => {
            log.info('Agent completed', {
              agentIdentifier: agent.identifier,
              issueId: agent.issueId,
              sessionId: agent.sessionId,
              totalCostUsd: agent.totalCostUsd,
            })
            if (agent.sessionId && (agent.totalCostUsd != null || agent.inputTokens != null || agent.outputTokens != null)) {
              await updateSessionCostData(agent.sessionId, {
                totalCostUsd: agent.totalCostUsd,
                inputTokens: agent.inputTokens,
                outputTokens: agent.outputTokens,
              }).catch((err) => log.error('Failed to persist cost data', { error: err }))
            }

            // Track workflow state for result-sensitive work types
            try {
              const workType = agent.workType ?? 'development'
              const phaseMap: Partial<Record<string, WorkflowPhase>> = {
                development: 'development',
                qa: 'qa',
                'qa-coordination': 'qa',
                acceptance: 'acceptance',
                'acceptance-coordination': 'acceptance',
                refinement: 'refinement',
              }
              const phase = phaseMap[workType]

              if (phase) {
                // Ensure workflow state exists
                await updateWorkflowState(agent.issueId, {
                  issueIdentifier: agent.identifier,
                })

                // Record the phase attempt
                await recordPhaseAttempt(agent.issueId, phase, {
                  attempt: 1, // Will be refined by phase-specific logic
                  sessionId: agent.sessionId,
                  startedAt: agent.startedAt.getTime(),
                  completedAt: agent.completedAt?.getTime(),
                  result: agent.workResult ?? (phase === 'development' || phase === 'refinement' ? 'passed' : undefined),
                  costUsd: agent.totalCostUsd,
                })

                // On QA/acceptance failure: increment cycle count and append failure summary
                const isResultSensitive = phase === 'qa' || phase === 'acceptance'
                if (isResultSensitive && (agent.workResult === 'failed' || agent.workResult === 'unknown')) {
                  const state = await incrementCycleCount(agent.issueId)
                  const failureReason = agent.workResult === 'unknown'
                    ? 'Agent completed without a structured WORK_RESULT marker (treated as failure)'
                    : extractFailureReason(agent.resultMessage)
                  const formattedFailure = `--- Cycle ${state.cycleCount}, ${phase} (${new Date().toISOString()}) ---\n${failureReason}`
                  await appendFailureSummary(agent.issueId, formattedFailure)

                  log.info('Workflow state updated after failure', {
                    issueId: agent.issueId,
                    cycleCount: state.cycleCount,
                    strategy: state.strategy,
                    phase,
                    workResult: agent.workResult,
                  })
                }

                // On acceptance pass: clear workflow state (issue is done)
                if (phase === 'acceptance' && agent.workResult === 'passed') {
                  await clearWorkflowState(agent.issueId)
                  await markAcceptanceCompleted(agent.issueId)
                  log.info('Workflow state cleared after acceptance pass', {
                    issueId: agent.issueId,
                  })
                }

                // On acceptance failure/unknown: mark completed to prevent re-trigger loop.
                // The issue stays in Delivered but won't auto-fire another acceptance agent.
                if (phase === 'acceptance' && (agent.workResult === 'failed' || agent.workResult === 'unknown')) {
                  await markAcceptanceCompleted(agent.issueId)
                  log.info('Marked acceptance completed to prevent re-trigger loop', {
                    issueId: agent.issueId,
                    workResult: agent.workResult,
                  })
                }
              }
            } catch (err) {
              log.error('Failed to update workflow state', { error: err, issueId: agent.issueId })
            }

            try {
              await hooks?.onAgentComplete?.(agent)
            } catch (err) {
              log.error('Hook onAgentComplete failed', { error: err })
            }
          },
          onAgentError: (agent: AgentProcess, error: Error) => {
            log.error('Agent failed', {
              agentIdentifier: agent.identifier,
              issueId: agent.issueId,
              sessionId: agent.sessionId,
              error,
            })
            emitAgentErrorActivity(agent.issueId, error, agent.sessionId).catch(
              (err) => log.error('Failed to emit error activity', { error: err })
            )
            try {
              hooks?.onAgentError?.(agent, error)
            } catch (err) {
              log.error('Hook onAgentError failed', { error: err })
            }
          },
          onAgentStopped: (agent: AgentProcess) => {
            log.info('Agent stopped', {
              agentIdentifier: agent.identifier,
              issueId: agent.issueId,
              sessionId: agent.sessionId,
            })
            if (agent.sessionId) {
              updateSessionStatus(agent.sessionId, 'stopped').catch((err) =>
                log.error('Failed to update session status', { error: err })
              )
            }
            hooks?.onAgentStopped?.(agent)
          },
          onProviderSessionId: async (sessionId: string, providerSessionId: string) => {
            log.info('Provider session ID captured', { sessionId, providerSessionId })
            await updateProviderSessionId(sessionId, providerSessionId)
          },
        }
      )
    }
    return _orchestrator
  }

  return {
    async spawnAgentAsync(issueId, sessionId, webhookId) {
      const idempotencyKey = generateIdempotencyKey(webhookId, sessionId)

      if (await isWebhookProcessed(idempotencyKey)) {
        return { spawned: false, reason: 'duplicate_webhook' }
      }

      const orch = getOrchestrator()
      if (orch.getActiveAgents().some((a) => a.issueId === issueId)) {
        return { spawned: false, reason: 'agent_already_running' }
      }

      await markWebhookProcessed(idempotencyKey)

      const spawnLog = log.child({ issueId, sessionId })

      try {
        const agent = await withRetry(
          async () => {
            return getOrchestrator().spawnAgentForIssue(issueId, sessionId)
          },
          {
            config: retryConfig,
            shouldRetry: isSpawnErrorRetryable,
            onRetry: ({ attempt, delay, lastError }) => {
              spawnLog.warn('Spawn retry attempt', {
                attempt: attempt + 1,
                maxRetries: retryConfig.maxRetries,
                delayMs: delay,
                lastErrorMessage: lastError?.message,
              })
            },
          }
        )

        spawnLog.info('Agent spawn successful', {
          agentIdentifier: agent.identifier,
          agentPid: agent.pid,
        })

        await storeSessionState(sessionId, {
          issueId,
          providerSessionId: agent.providerSessionId ?? null,
          worktreePath: agent.worktreePath ?? '',
          status: 'running',
        })

        return { spawned: true, agent }
      } catch (error) {
        const spawnError = error instanceof Error ? error : new Error(String(error))
        const typedError = new AgentSpawnError(
          `Failed to spawn agent: ${spawnError.message}`,
          issueId,
          sessionId,
          isSpawnErrorRetryable(error),
          spawnError
        )

        spawnLog.error('Failed to spawn agent after retries', {
          error: typedError,
          isRetryable: typedError.isRetryable,
        })

        await emitAgentErrorActivity(issueId, typedError, sessionId)
        await cleanupFailedSpawn(issueId, idempotencyKey)

        return { spawned: false, reason: 'spawn_failed', error: typedError }
      }
    },

    async stopAgentBySession(sessionId, cleanupWorktree = true) {
      const stopLog = log.child({ sessionId })
      try {
        const orch = getOrchestrator()
        const result = await orch.stopAgentBySession(sessionId, cleanupWorktree)
        if (result.stopped) {
          stopLog.info('Agent stopped by session', {
            agentIdentifier: result.agent?.identifier,
            cleanedWorktree: cleanupWorktree,
          })
        } else {
          stopLog.info('Could not stop agent', { reason: result.reason })
        }
        return result
      } catch (error) {
        stopLog.error('Failed to stop agent', { error })
        throw error
      }
    },

    getAgentBySession(sessionId) {
      return getOrchestrator().getAgentBySession(sessionId)
    },

    isAgentRunningForIssue(issueId) {
      return getOrchestrator().getActiveAgents().some((a) => a.issueId === issueId)
    },

    async forwardPromptAsync(issueId, sessionId, promptText) {
      const promptLog = log.child({ issueId, sessionId })

      try {
        const sessionState = await getSessionState(sessionId)

        promptLog.info('Forwarding prompt to agent', {
          hasSessionState: !!sessionState,
          hasProviderSessionId: !!sessionState?.providerSessionId,
          promptLength: promptText.length,
          workType: sessionState?.workType ?? 'development',
        })

        const orch = getOrchestrator()
        const result = await orch.forwardPrompt(
          issueId,
          sessionId,
          promptText,
          sessionState?.providerSessionId ?? undefined,
          sessionState?.workType
        )

        if (result.forwarded) {
          promptLog.info('Prompt forwarded successfully', {
            resumed: result.resumed,
            agentIdentifier: result.agent?.identifier,
            agentPid: result.agent?.pid,
          })

          if (result.agent) {
            await storeSessionState(sessionId, {
              issueId,
              providerSessionId: result.agent.providerSessionId ?? null,
              worktreePath: result.agent.worktreePath ?? '',
              status: 'running',
              workType: sessionState?.workType,
            })
          }
        } else {
          promptLog.warn('Prompt not forwarded', {
            reason: result.reason,
            error: result.error?.message,
          })
        }

        return result
      } catch (error) {
        const errorMsg = error instanceof Error ? error : new Error(String(error))
        promptLog.error('Failed to forward prompt', { error: errorMsg })
        return { forwarded: false, resumed: false, reason: 'spawn_failed', error: errorMsg }
      }
    },
  }
}
