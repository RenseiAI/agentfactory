/**
 * GET /api/public/sessions
 *
 * Returns sanitized session data for public display.
 */

import { NextResponse } from 'next/server'
import {
  getAllSessions,
  type AgentSessionState,
  isSessionInQueue,
  hashSessionId,
  createLogger,
} from '@donmai/server'

const log = createLogger('api/public/sessions')

export interface PublicSessionResponse {
  id: string
  identifier: string
  status: 'queued' | 'parked' | 'working' | 'completed' | 'failed' | 'stopped'
  workType: string
  startedAt: string
  duration: number
  costUsd?: number
  provider?: string
}

function toPublicStatus(
  status: AgentSessionState['status'],
  isParked: boolean = false
): PublicSessionResponse['status'] {
  switch (status) {
    case 'pending':
      return isParked ? 'parked' : 'queued'
    case 'claimed':
    case 'running':
    case 'finalizing':
      return 'working'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'stopped'
    default:
      return 'queued'
  }
}

async function toPublicSession(
  session: AgentSessionState
): Promise<PublicSessionResponse> {
  const now = Math.floor(Date.now() / 1000)
  const startTime = session.queuedAt
    ? Math.floor(session.queuedAt / 1000)
    : session.createdAt
  const endTime = ['completed', 'failed', 'stopped'].includes(session.status)
    ? session.updatedAt
    : now

  let isParked = false
  if (session.status === 'pending') {
    const inQueue = await isSessionInQueue(session.trackerSessionId)
    isParked = !inQueue
  }

  return {
    // Hash the row's OWN id, not the (possibly shared) trackerSessionId:
    // multiple per-dispatch rows can alias one tracker session, and hashing
    // the tracker id rendered them all as N duplicates of the same public id.
    id: hashSessionId(session.rowSessionId ?? session.trackerSessionId),
    identifier: session.issueIdentifier || 'Unknown',
    status: toPublicStatus(session.status, isParked),
    workType: session.workType || 'development',
    startedAt: new Date(startTime * 1000).toISOString(),
    duration: endTime - startTime,
    costUsd: session.totalCostUsd,
    provider: session.provider,
  }
}

export function createPublicSessionsListHandler() {
  return async function GET() {
    try {
      const allSessions = await getAllSessions()
      const publicSessions = await Promise.all(allSessions.map(toPublicSession))

      publicSessions.sort((a, b) => {
        return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
      })

      return NextResponse.json({
        sessions: publicSessions,
        count: publicSessions.length,
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      log.error('Failed to fetch public sessions', { error })

      return NextResponse.json(
        {
          sessions: [],
          count: 0,
          timestamp: new Date().toISOString(),
          error: 'Failed to fetch sessions',
        },
        { status: 500 }
      )
    }
  }
}
