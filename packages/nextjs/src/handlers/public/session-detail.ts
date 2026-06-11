/**
 * GET /api/public/sessions/:id
 *
 * Returns sanitized session detail for a single session.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getAllSessions,
  type AgentSessionState,
  isSessionInQueue,
  hashSessionId,
  isValidPublicId,
  createLogger,
} from '@donmai/server'

const log = createLogger('api/public/sessions/[id]')

export interface PublicSessionDetailResponse {
  id: string
  identifier: string
  status: 'queued' | 'parked' | 'working' | 'completed' | 'failed'
  workType: string
  startedAt: string
  duration: number
  timeline: {
    created: string
    queued?: string
    started?: string
    completed?: string
  }
  provider?: string
  branch?: string
  issueTitle?: string
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
}

function toPublicStatus(
  status: AgentSessionState['status'],
  isParked: boolean = false
): PublicSessionDetailResponse['status'] {
  switch (status) {
    case 'pending':
      return isParked ? 'parked' : 'queued'
    case 'claimed':
    case 'running':
      return 'working'
    case 'completed':
      return 'completed'
    case 'failed':
    case 'stopped':
      return 'failed'
    default:
      return 'queued'
  }
}

async function toPublicSessionDetail(
  session: AgentSessionState
): Promise<PublicSessionDetailResponse> {
  const now = Math.floor(Date.now() / 1000)
  const startTime = session.queuedAt
    ? Math.floor(session.queuedAt / 1000)
    : session.createdAt
  const endTime = ['completed', 'failed', 'stopped'].includes(session.status)
    ? session.updatedAt
    : now

  const isComplete = ['completed', 'failed', 'stopped'].includes(session.status)

  let isParked = false
  if (session.status === 'pending') {
    const inQueue = await isSessionInQueue(session.trackerSessionId)
    isParked = !inQueue
  }

  return {
    // Hash the row's OWN id so per-dispatch rows aliasing one tracker
    // session keep distinct public identities (matches sessions-list)
    id: hashSessionId(session.rowSessionId ?? session.trackerSessionId),
    identifier: session.issueIdentifier || 'Unknown',
    status: toPublicStatus(session.status, isParked),
    workType: session.workType || 'development',
    startedAt: new Date(startTime * 1000).toISOString(),
    duration: endTime - startTime,
    timeline: {
      created: new Date(session.createdAt * 1000).toISOString(),
      queued: session.queuedAt
        ? new Date(session.queuedAt).toISOString()
        : undefined,
      started: session.claimedAt
        ? new Date(session.claimedAt * 1000).toISOString()
        : undefined,
      completed: isComplete
        ? new Date(session.updatedAt * 1000).toISOString()
        : undefined,
    },
    provider: session.provider,
    branch: session.worktreePath
      ? session.worktreePath.split('/').pop()
      : undefined,
    issueTitle: session.issueIdentifier
      ? `${session.issueIdentifier}`
      : undefined,
  }
}

async function findSessionByPublicId(
  publicId: string
): Promise<AgentSessionState | null> {
  const allSessions = await getAllSessions()

  for (const session of allSessions) {
    if (
      hashSessionId(session.rowSessionId ?? session.trackerSessionId) ===
      publicId
    ) {
      return session
    }
  }

  return null
}

export function createPublicSessionDetailHandler() {
  return async function GET(
    _request: NextRequest,
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

      const publicSession = await toPublicSessionDetail(session)

      return NextResponse.json({
        session: publicSession,
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      log.error('Failed to fetch public session detail', { error, publicId })

      return NextResponse.json(
        { error: 'Failed to fetch session' },
        { status: 500 }
      )
    }
  }
}
