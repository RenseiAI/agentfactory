/**
 * POST /api/sessions/[id]/tool-error
 *
 * Report a tool error as a Linear issue for tracking.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import { getSessionState, createLogger } from '@donmai/server'
import { ENVIRONMENT_ISSUE_TYPES } from '@donmai/core'
import { createAgentSession } from '@donmai/plugin-linear'
import type { RouteConfig } from '../../types.js'

const log = createLogger('api:sessions:tool-error')

interface RouteParams {
  params: Promise<{ id: string }>
}

interface ToolErrorRequest {
  workerId: string
  toolName: string
  errorMessage: string
  context?: {
    issueIdentifier?: string
    additionalContext?: Record<string, unknown>
  }
}

export function createSessionToolErrorHandler(config: RouteConfig) {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: sessionId } = await params

    try {
      const body = (await request.json()) as ToolErrorRequest
      const { workerId, toolName, errorMessage, context } = body

      if (!workerId || typeof workerId !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'workerId is required' },
          { status: 400 }
        )
      }

      if (!toolName || typeof toolName !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'toolName is required' },
          { status: 400 }
        )
      }

      if (!errorMessage || typeof errorMessage !== 'string') {
        return NextResponse.json(
          { error: 'Bad Request', message: 'errorMessage is required' },
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

      // Skip Linear forwarding when no real Linear session exists.
      const linearSessionId = session.providerSessionId ?? sessionId
      if (linearSessionId.startsWith('governor-')) {
        log.debug('Skipping Linear tool error report for governor-generated session', {
          sessionId,
          toolName,
        })
        return NextResponse.json({
          created: false,
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

        const issue = await agentSession.reportEnvironmentIssue(
          `Tool error: ${toolName}`,
          `The agent encountered an error while using the **${toolName}** tool.\n\n**Error:**\n\`\`\`\n${errorMessage}\n\`\`\``,
          {
            issueType: ENVIRONMENT_ISSUE_TYPES.TOOL,
            sourceIssueId: context?.issueIdentifier ?? session.issueId,
            additionalContext: {
              toolName,
              sessionId,
              workerId,
              ...context?.additionalContext,
            },
          }
        )

        if (issue) {
          log.info('Tool error reported to Linear', {
            sessionId,
            toolName,
            issueIdentifier: issue.identifier,
          })

          return NextResponse.json({
            created: true,
            issue: {
              id: issue.id,
              identifier: issue.identifier,
              url: issue.url,
            },
          })
        }

        return NextResponse.json({
          created: false,
          reason: 'Failed to create issue in Linear',
        })
      } catch (linearError) {
        const errorMessage2 = linearError instanceof Error ? linearError.message : String(linearError)
        log.error('Failed to report tool error to Linear', {
          error: errorMessage2,
          sessionId,
          toolName,
        })
        return NextResponse.json({
          created: false,
          reason: `Failed to report to Linear: ${errorMessage2}`,
        })
      }
    } catch (error) {
      log.error('Failed to process tool error report', { error, sessionId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to process tool error report' },
        { status: 500 }
      )
    }
  }
}
