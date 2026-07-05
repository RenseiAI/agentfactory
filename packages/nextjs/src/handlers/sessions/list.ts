/**
 * GET /api/sessions
 * Returns list of all agent sessions from Redis
 */

import { NextResponse } from 'next/server'
import {
  getAllSessions,
  type AgentSessionState,
  type AgentSessionStatus,
  createLogger,
} from '@donmai/server'

const log = createLogger('api/sessions')

export interface AgentSessionResponse {
  id: string
  /** Tracker-agnostic session ID. Use this field going forward. */
  trackerSessionId: string
  /** @deprecated Use `trackerSessionId`. Kept for one-major backward compat. */
  linearSessionId: string
  issueId: string
  identifier: string
  providerSessionId?: string
  provider?: string
  status: AgentSessionStatus
  createdAt: string
  updatedAt: string
  worktreePath: string
  workerId?: string
  queuedAt?: string
  claimedAt?: string
  agentId?: string
}

function toResponse(session: AgentSessionState): AgentSessionResponse {
  return {
    id: session.trackerSessionId,
    trackerSessionId: session.trackerSessionId,
    linearSessionId: session.trackerSessionId,
    issueId: session.issueId,
    identifier: session.issueIdentifier || session.issueId.slice(0, 8),
    providerSessionId: session.providerSessionId || undefined,
    provider: session.provider || undefined,
    status: session.status,
    createdAt: new Date(session.createdAt * 1000).toISOString(),
    updatedAt: new Date(session.updatedAt * 1000).toISOString(),
    worktreePath: session.worktreePath,
    workerId: session.workerId || undefined,
    queuedAt: session.queuedAt
      ? new Date(session.queuedAt).toISOString()
      : undefined,
    claimedAt: session.claimedAt
      ? new Date(session.claimedAt * 1000).toISOString()
      : undefined,
    agentId: session.agentId || undefined,
  }
}

export function createSessionListHandler() {
  return async function GET() {
    try {
      const allSessions = await getAllSessions()
      const sessions: AgentSessionResponse[] = allSessions.map(toResponse)

      return NextResponse.json({
        sessions,
        count: sessions.length,
        timestamp: new Date().toISOString(),
      })
    } catch (error) {
      log.error('Failed to fetch sessions', { error })

      return NextResponse.json({
        sessions: [],
        count: 0,
        timestamp: new Date().toISOString(),
        error: 'Failed to fetch sessions from Redis',
      })
    }
  }
}
