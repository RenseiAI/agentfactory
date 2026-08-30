/**
 * GET, POST /api/sessions/[id]/status
 *
 * Report status update from worker or get current status.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import {
  getSessionState,
  updateSessionStatus,
  updateSessionCostData,
  updateProviderSessionId,
  startSession,
  acknowledgeWorkClaimForWorker,
  type AgentSessionStatus,
  removeWorkerSession,
  releaseClaim,
  markAgentWorked,
  releaseIssueLock,
  promoteNextPendingWork,
  RedisProcessingStateStorage,
  createLogger,
  recordSessionFailure,
  clearSessionFailures,
  archiveInbox,
  onSessionTerminated,
} from '@donmai/server'
import type { RouteConfig } from '../../types.js'

const log = createLogger('api:sessions:status')

interface RouteParams {
  params: Promise<{ id: string }>
}

const VALID_STATUSES: AgentSessionStatus[] = [
  'running',
  'finalizing',
  'completed',
  'failed',
  'stopped',
]

const TERMINAL_STATUSES: AgentSessionStatus[] = ['completed', 'failed', 'stopped']

export function createSessionStatusPostHandler(config?: RouteConfig) {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params

    try {
      const body = await request.json()
      const { workerId, status, providerSessionId, worktreePath, error: errorInfo, totalCostUsd, inputTokens, outputTokens } = body as {
        workerId: string
        status: AgentSessionStatus
        providerSessionId?: string
        worktreePath?: string
        error?: unknown
        totalCostUsd?: number
        inputTokens?: number
        outputTokens?: number
      }

      if (!workerId || typeof workerId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'workerId is required' },
          { status: 400 }
        )
      }

      if (!status || !VALID_STATUSES.includes(status)) {
        return NextResponse.json(
          {
            error: 'Bad Request',
            message: `status must be one of: ${VALID_STATUSES.join(', ')}`,
          },
          { status: 400 }
        )
      }

      const session = await getSessionState(sessionId)
      if (!session) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Session not found' },
          { status: 404 }
        )
      }

      if (session.workerId && session.workerId !== workerId) {
        return NextResponse.json(
          { error: 'Forbidden', message: 'Session is owned by another worker' },
          { status: 403 }
        )
      }

      if (status === 'running') {
        const started = await startSession(
          sessionId,
          workerId,
          worktreePath || session.worktreePath || ''
        )
        if (!started) {
          log.warn('Session start transition rejected', {
            sessionId,
            workerId,
          })
          return NextResponse.json(
            {
              error: 'Conflict',
              message: 'Session could not transition to running',
            },
            { status: 409 }
          )
        }

        // A worker can only report `running` after receiving the work payload.
        // This existing authenticated transition is the delivery boundary; the
        // claim and poll HTTP responses remain replayable until this point.
        const acknowledged = await acknowledgeWorkClaimForWorker(sessionId, workerId)
        if (!acknowledged) {
          log.warn('Work claim delivery acknowledgement deferred', { sessionId, workerId })
        }

        if (providerSessionId) {
          await updateProviderSessionId(sessionId, providerSessionId)
        }

        // Mark agent-worked EARLY (on running, not just completed) to prevent
        // a race condition: the orchestrator transitions issue status to Finished
        // before the worker reports completion, so the webhook handler's
        // wasAgentWorked check would fail if we only set it on completed.
        if (session.issueId) {
          try {
            await markAgentWorked(session.issueId, {
              issueIdentifier: session.issueIdentifier || 'unknown',
              sessionId: sessionId,
            })
            log.info('Issue pre-marked as agent-worked (running)', {
              issueId: session.issueId,
              sessionId,
            })
          } catch (err) {
            log.warn('Failed to pre-mark agent-worked', { sessionId, error: err })
          }
        }
      } else if (status === 'finalizing') {
        await updateSessionStatus(sessionId, 'finalizing')
      } else if (TERMINAL_STATUSES.includes(status)) {
        await updateSessionStatus(sessionId, status)

        if (totalCostUsd != null || inputTokens != null || outputTokens != null) {
          await updateSessionCostData(sessionId, { totalCostUsd, inputTokens, outputTokens }).catch(
            (err) => log.error('Failed to persist cost data', { sessionId, error: err })
          )
        }

        // Fleet quota: decrement concurrent session count and record final cost
        onSessionTerminated(session.projectName, sessionId, totalCostUsd).catch((err) => {
          log.error('Fleet quota onSessionTerminated failed', { sessionId, error: err })
        })

        // Track session failures for circuit breaker (exponential backoff)
        if (session.issueId) {
          if (status === 'failed') {
            const errorMsg = typeof errorInfo === 'object' && errorInfo !== null && 'message' in errorInfo
              ? String((errorInfo as { message: unknown }).message)
              : undefined
            try {
              await recordSessionFailure(session.issueId, errorMsg)
            } catch (err) {
              log.error('Failed to record session failure', { sessionId, issueId: session.issueId, error: err })
            }
          } else if (status === 'completed') {
            try {
              await clearSessionFailures(session.issueId)
            } catch (err) {
              log.error('Failed to clear session failures', { sessionId, issueId: session.issueId, error: err })
            }
          }
        }

        if (status === 'completed' && session.issueId) {
          try {
            await markAgentWorked(session.issueId, {
              issueIdentifier: session.issueIdentifier || 'unknown',
              sessionId: sessionId,
            })
            log.info('Issue marked as agent-worked', {
              issueId: session.issueId,
              sessionId,
            })
          } catch (err) {
            log.error('Failed to mark agent-worked', { sessionId, error: err })
          }

          // Mark research/backlog-creation phases as completed so the
          // governor does not re-dispatch the same top-of-funnel work.
          const phase = session.workType === 'research' ? 'research'
            : session.workType === 'backlog-creation' ? 'backlog-creation'
            : null
          if (phase) {
            try {
              const processingState = new RedisProcessingStateStorage()
              await processingState.markPhaseCompleted(session.issueId, phase, sessionId)
              log.info('Processing phase marked complete', {
                issueId: session.issueId,
                phase,
                sessionId,
              })
            } catch (err) {
              log.error('Failed to mark processing phase complete', {
                sessionId,
                issueId: session.issueId,
                phase,
                error: err,
              })
            }
          }
        }

        // Emit a response activity to close the Linear agent session.
        // Linear auto-transitions sessions to "complete" based on response activities.
        if (config && session.trackerSessionId && session.organizationId) {
          try {
            const linearClient = await config.linearClient.getClient(session.organizationId)
            const message = status === 'completed'
              ? 'Work completed successfully.'
              : status === 'failed'
                ? 'Agent encountered an error during execution.'
                : 'Agent was stopped.'
            await linearClient.createAgentActivity({
              agentSessionId: session.trackerSessionId,
              content: { type: 'response', body: message },
              ephemeral: false,
            })
            log.info('Emitted completion response activity to close Linear session', {
              sessionId,
              trackerSessionId: session.trackerSessionId,
              status,
            })
          } catch (err) {
            log.warn('Failed to emit completion response activity', {
              sessionId,
              trackerSessionId: session.trackerSessionId,
              error: err,
            })
          }
        }

        await releaseClaim(sessionId)
        await removeWorkerSession(workerId, sessionId)

        // Archive inbox streams (non-destructive — renames with TTL)
        if (session.agentId) {
          try {
            await archiveInbox(session.agentId, sessionId)
            log.info('Inbox streams archived', {
              sessionId,
              agentId: session.agentId,
            })
          } catch (err) {
            log.error('Failed to archive inbox streams', {
              sessionId,
              agentId: session.agentId,
              error: err,
            })
          }
        }

        if (session.issueId) {
          try {
            await releaseIssueLock(session.issueId)
            const promoted = await promoteNextPendingWork(session.issueId)
            if (promoted) {
              log.info('Promoted pending work after lock release', {
                issueId: session.issueId,
                promotedSessionId: promoted.sessionId,
                promotedWorkType: promoted.workType,
              })
            }
          } catch (err) {
            log.error('Failed to release issue lock or promote pending work', {
              sessionId,
              issueId: session.issueId,
              error: err,
            })
          }
        }
      }

      log.info('Session status updated', {
        sessionId,
        workerId,
        status,
        hasProviderSessionId: !!providerSessionId,
        hasError: !!errorInfo,
      })

      const updatedSession = await getSessionState(sessionId)

      return NextResponse.json({
        updated: true,
        session: updatedSession,
      })
    } catch (error) {
      log.error('Failed to update session status', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to update session status' },
        { status: 500 }
      )
    }
  }
}

export function createSessionStatusGetHandler() {
  return async function GET(request: NextRequest, { params }: RouteParams) {
    const { id: sessionId } = await params

    try {
      const session = await getSessionState(sessionId)

      if (!session) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Session not found' },
          { status: 404 }
        )
      }

      return NextResponse.json(session)
    } catch (error) {
      log.error('Failed to get session status', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to get session status' },
        { status: 500 }
      )
    }
  }
}
