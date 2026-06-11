/**
 * GET /api/public/sessions/:id/activities
 *
 * Returns stored activities for TUI streaming with cursor-based polling.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getAllSessions,
  type AgentSessionState,
  hashSessionId,
  isValidPublicId,
  createLogger,
} from '@donmai/server'
import { getActivities, getLastCursor } from '../sessions/activity-store.js'

const log = createLogger('api/public/sessions/[id]/activities')

type PublicSessionStatus = 'queued' | 'parked' | 'working' | 'completed' | 'failed' | 'stopped'

function toPublicStatus(status: AgentSessionState['status']): PublicSessionStatus {
  switch (status) {
    case 'pending': return 'queued'
    case 'claimed':
    case 'running': return 'working'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'stopped': return 'stopped'
    default: return 'queued'
  }
}

async function findSessionByPublicId(publicId: string): Promise<AgentSessionState | null> {
  const allSessions = await getAllSessions()
  for (const session of allSessions) {
    // Match on the row's OWN id (falls back to trackerSessionId for rows
    // that are their own tracker session) — same identity as sessions-list.
    // Activities stay keyed by trackerSessionId: alias rows share the
    // tracker session's activity stream.
    if (
      hashSessionId(session.rowSessionId ?? session.trackerSessionId) ===
      publicId
    ) {
      return session
    }
  }
  return null
}

export interface PublicActivityResponse {
  activities: Array<{
    id: string
    type: 'thought' | 'action' | 'response' | 'error' | 'progress' | 'context'
    content: string
    toolName?: string
    timestamp: string
    contextKey?: string
    contextValue?: unknown
  }>
  cursor?: string
  sessionStatus: PublicSessionStatus
}

export function createPublicSessionActivitiesHandler() {
  return async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ) {
    const { id: publicId } = await params

    if (!isValidPublicId(publicId)) {
      return NextResponse.json(
        { error: 'Invalid session ID format' },
        { status: 400 }
      )
    }

    try {
      const session = await findSessionByPublicId(publicId)

      if (!session) {
        return NextResponse.json(
          { error: 'Session not found' },
          { status: 404 }
        )
      }

      const afterCursor = request.nextUrl.searchParams.get('after') ?? undefined
      const activities = getActivities(session.trackerSessionId, afterCursor)
      const cursor = activities.length > 0
        ? activities[activities.length - 1].id
        : (afterCursor || undefined)

      const response: PublicActivityResponse = {
        activities,
        cursor,
        sessionStatus: toPublicStatus(session.status),
      }

      return NextResponse.json(response)
    } catch (error) {
      log.error('Failed to fetch session activities', { error, publicId })
      return NextResponse.json(
        { error: 'Failed to fetch activities' },
        { status: 500 }
      )
    }
  }
}
