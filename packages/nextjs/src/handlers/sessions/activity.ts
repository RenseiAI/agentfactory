/**
 * POST /api/sessions/[id]/activity
 *
 * Report agent activity to be forwarded to Linear.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import { getSessionState, createLogger } from '@donmai/server'
import { createAgentSession } from '@donmai/plugin-linear'
import type { RouteConfig } from '../../types.js'
import { storeActivity } from './activity-store.js'

const log = createLogger('api:sessions:activity')

interface RouteParams {
  params: Promise<{ id: string }>
}

interface AgentActivity {
  type: 'thought' | 'action' | 'response' | 'context'
  content: string
  toolName?: string
  toolInput?: Record<string, unknown>
  timestamp?: string
  contextKey?: string
  contextValue?: unknown
}

export function createSessionActivityHandler(config: RouteConfig) {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params

    try {
      const body = await request.json()
      const { workerId, activity } = body as {
        workerId: string
        activity: AgentActivity
      }

      if (!workerId || typeof workerId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'workerId is required' },
          { status: 400 }
        )
      }

      if (!activity || !activity.type || !activity.content) {
        return NextResponse.json(
          { error: 'Bad Request', message: 'activity with type and content is required' },
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

      // Store activity for TUI streaming
      storeActivity(sessionId, {
        type: activity.type,
        content: activity.content,
        toolName: activity.toolName,
        timestamp: activity.timestamp || new Date().toISOString(),
        contextKey: activity.contextKey,
        contextValue: activity.contextValue,
      })

      // Resolve the Linear agent session ID. When the platform's workflow
      // dispatch sets providerSessionId on the session state, use that as
      // the authoritative Linear session ID. Fall back to the URL sessionId
      // for direct webhook-dispatched sessions. Governor-generated sessions
      // (prefixed "governor-") have no corresponding Linear session.
      const linearSessionId = session.providerSessionId ?? sessionId
      if (linearSessionId.startsWith('governor-')) {
        log.debug('Skipping Linear forwarding for governor-generated session', {
          sessionId,
          activityType: activity.type,
        })
        return NextResponse.json({
          forwarded: false,
          reason: 'Governor-generated session — no Linear agent session exists',
        })
      }

      try {
        const linearClient = await config.linearClient.getClient(session.organizationId)

        const agentSession = createAgentSession({
          client: linearClient,
          issueId: session.issueId,
          sessionId: linearSessionId,
          autoTransition: false,
        })

        // Context activities are stored locally but not forwarded to Linear
        if (activity.type === 'context') {
          log.debug('Context activity stored (not forwarded to Linear)', {
            sessionId,
            contextKey: activity.contextKey,
          })
          return NextResponse.json({ forwarded: false, reason: 'context activities are not forwarded to Linear' })
        }

        switch (activity.type) {
          case 'thought':
            await agentSession.emitThought(activity.content)
            break
          case 'action':
            await agentSession.emitAction(
              activity.toolName || 'Tool',
              activity.toolInput || {}
            )
            break
          case 'response':
            await agentSession.emitResponse(activity.content)
            break
        }

        log.debug('Activity forwarded to Linear', {
          sessionId,
          activityType: activity.type,
          issueId: session.issueId,
        })

        return NextResponse.json({
          forwarded: true,
        })
      } catch (linearError) {
        const errorMessage = linearError instanceof Error ? linearError.message : String(linearError)
        log.error('Failed to forward activity to Linear', {
          error: errorMessage,
          sessionId,
          issueId: session.issueId,
        })
        return NextResponse.json({
          forwarded: false,
          reason: `Failed to forward to Linear: ${errorMessage}`,
        })
      }
    } catch (error) {
      log.error('Failed to process activity', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to process activity' },
        { status: 500 }
      )
    }
  }
}
