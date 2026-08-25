import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireWorkerAuth: vi.fn(),
  getSessionState: vi.fn(),
  updateSessionStatus: vi.fn(),
  updateSessionCostData: vi.fn(),
  updateProviderSessionId: vi.fn(),
  startSession: vi.fn(),
  removeWorkerSession: vi.fn(),
  releaseClaim: vi.fn(),
  markAgentWorked: vi.fn(),
  releaseIssueLock: vi.fn(),
  promoteNextPendingWork: vi.fn(),
  recordSessionFailure: vi.fn(),
  clearSessionFailures: vi.fn(),
  archiveInbox: vi.fn(),
  onSessionTerminated: vi.fn(),
}))

vi.mock('../middleware/worker-auth.js', () => ({
  requireWorkerAuth: mocks.requireWorkerAuth,
}))

vi.mock('@donmai/server', () => ({
  getSessionState: mocks.getSessionState,
  updateSessionStatus: mocks.updateSessionStatus,
  updateSessionCostData: mocks.updateSessionCostData,
  updateProviderSessionId: mocks.updateProviderSessionId,
  startSession: mocks.startSession,
  removeWorkerSession: mocks.removeWorkerSession,
  releaseClaim: mocks.releaseClaim,
  markAgentWorked: mocks.markAgentWorked,
  releaseIssueLock: mocks.releaseIssueLock,
  promoteNextPendingWork: mocks.promoteNextPendingWork,
  RedisProcessingStateStorage: class {
    markPhaseCompleted = vi.fn()
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  recordSessionFailure: mocks.recordSessionFailure,
  clearSessionFailures: mocks.clearSessionFailures,
  archiveInbox: mocks.archiveInbox,
  onSessionTerminated: mocks.onSessionTerminated,
}))

import { createSessionStatusPostHandler } from '../handlers/sessions/status.js'

const session = {
  trackerSessionId: 'session-1',
  trackerProvider: 'linear',
  issueId: 'issue-1',
  issueIdentifier: 'ISSUE-1',
  providerSessionId: null,
  worktreePath: '/stored/worktree',
  status: 'claimed',
  createdAt: 1_000_000,
  updatedAt: 1_000_001,
  workerId: 'worker-1',
}

const context = { params: Promise.resolve({ id: 'session-1' }) }

function runningRequest(overrides: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/sessions/session-1/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workerId: 'worker-1',
      status: 'running',
      providerSessionId: 'provider-1',
      ...overrides,
    }),
  })
}

describe('session status running transition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireWorkerAuth.mockReturnValue(null)
    mocks.getSessionState
      .mockResolvedValueOnce(session)
      .mockResolvedValue({ ...session, status: 'running' })
    mocks.startSession.mockResolvedValue(true)
    mocks.updateSessionStatus.mockResolvedValue(true)
    mocks.updateProviderSessionId.mockResolvedValue(true)
    mocks.markAgentWorked.mockResolvedValue(true)
    mocks.clearSessionFailures.mockResolvedValue(undefined)
    mocks.onSessionTerminated.mockResolvedValue(undefined)
    mocks.releaseIssueLock.mockResolvedValue(true)
    mocks.promoteNextPendingWork.mockResolvedValue(null)
  })

  it('starts with the stored worktree path when the report omits worktreePath', async () => {
    const response = await createSessionStatusPostHandler()(runningRequest(), context)

    expect(response.status).toBe(200)
    expect(mocks.startSession).toHaveBeenCalledWith(
      'session-1',
      'worker-1',
      '/stored/worktree'
    )
    expect(mocks.updateSessionStatus).not.toHaveBeenCalledWith(
      'session-1',
      'running'
    )
    expect(mocks.updateProviderSessionId).toHaveBeenCalledWith(
      'session-1',
      'provider-1'
    )
    expect(mocks.markAgentWorked).toHaveBeenCalled()
  })

  it('returns conflict before running-only effects when atomic start is rejected', async () => {
    mocks.startSession.mockResolvedValue(false)

    const response = await createSessionStatusPostHandler()(
      runningRequest({ worktreePath: '/reported/worktree' }),
      context
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: 'Conflict',
      message: 'Session could not transition to running',
    })
    expect(mocks.startSession).toHaveBeenCalledWith(
      'session-1',
      'worker-1',
      '/reported/worktree'
    )
    expect(mocks.updateProviderSessionId).not.toHaveBeenCalled()
    expect(mocks.markAgentWorked).not.toHaveBeenCalled()
    expect(mocks.getSessionState).toHaveBeenCalledTimes(1)
  })

  it('preserves worker authentication rejection before session access', async () => {
    mocks.requireWorkerAuth.mockReturnValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )

    const response = await createSessionStatusPostHandler()(runningRequest(), context)

    expect(response.status).toBe(401)
    expect(mocks.getSessionState).not.toHaveBeenCalled()
    expect(mocks.startSession).not.toHaveBeenCalled()
  })

  it('preserves terminal status updates outside the atomic start path', async () => {
    const response = await createSessionStatusPostHandler()(
      new NextRequest('http://localhost/api/sessions/session-1/status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'worker-1', status: 'completed' }),
      }),
      context
    )

    expect(response.status).toBe(200)
    expect(mocks.updateSessionStatus).toHaveBeenCalledWith(
      'session-1',
      'completed'
    )
    expect(mocks.startSession).not.toHaveBeenCalled()
  })
})
