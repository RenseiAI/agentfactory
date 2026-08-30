import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireWorkerAuth: vi.fn(),
  claimWorkWithReceipt: vi.fn(),
  acknowledgeWorkClaim: vi.fn(),
  requeueWork: vi.fn(),
  releaseClaim: vi.fn(),
  claimSession: vi.fn(),
  getSessionState: vi.fn(),
  addWorkerSession: vi.fn(),
  getWorker: vi.fn(),
  onSessionClaimed: vi.fn(),
}))

vi.mock('../middleware/worker-auth.js', () => ({
  requireWorkerAuth: mocks.requireWorkerAuth,
}))

vi.mock('@donmai/server', () => ({
  claimWorkWithReceipt: mocks.claimWorkWithReceipt,
  acknowledgeWorkClaim: mocks.acknowledgeWorkClaim,
  requeueWork: mocks.requeueWork,
  releaseClaim: mocks.releaseClaim,
  claimSession: mocks.claimSession,
  getSessionState: mocks.getSessionState,
  addWorkerSession: mocks.addWorkerSession,
  getWorker: mocks.getWorker,
  onSessionClaimed: mocks.onSessionClaimed,
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import { createSessionClaimHandler } from '../handlers/sessions/claim.js'

const work = {
  sessionId: 'session-replay',
  issueId: 'issue-replay',
  issueIdentifier: 'OSS-REPLAY',
  priority: 1,
  queuedAt: 1_000,
}

const context = { params: Promise.resolve({ id: 'session-replay' }) }

function claimRequest() {
  return new NextRequest('http://localhost/api/sessions/session-replay/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workerId: 'worker-replay', attemptToken: 'attempt-http-replay' }),
  })
}

describe('session claim HTTP replay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireWorkerAuth.mockReturnValue(null)
    mocks.claimWorkWithReceipt.mockResolvedValue({
      status: 'claimed',
      sessionId: 'session-replay',
      workerId: 'worker-replay',
      attemptToken: 'attempt-http-replay',
      claimedAt: 1_000,
      work,
    })
    mocks.claimSession
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    mocks.addWorkerSession.mockResolvedValue(undefined)
    mocks.getSessionState.mockResolvedValue({
      trackerSessionId: 'session-replay',
      trackerProvider: 'linear',
      issueId: 'issue-replay',
      providerSessionId: null,
      worktreePath: '',
      status: 'claimed',
      createdAt: 1,
      updatedAt: 1,
      workerId: 'worker-replay',
    })
    mocks.onSessionClaimed.mockResolvedValue(undefined)
  })

  it('keeps the same token replayable when the first HTTP 200 is lost', async () => {
    const handler = createSessionClaimHandler()

    // The first response represents an HTTP reply that the remote worker never
    // receives. It must not clear the durable payload/receipt before retry.
    await expect(handler(claimRequest(), context)).resolves.toMatchObject({ status: 200 })

    const retry = await handler(claimRequest(), context)
    expect(retry.status).toBe(200)
    await expect(retry.json()).resolves.toMatchObject({ claimed: true, work })
    expect(mocks.claimWorkWithReceipt).toHaveBeenNthCalledWith(
      1,
      'session-replay',
      'worker-replay',
      'attempt-http-replay'
    )
    expect(mocks.claimSession).toHaveBeenNthCalledWith(2, 'session-replay', 'worker-replay')
    expect(mocks.claimWorkWithReceipt).toHaveBeenNthCalledWith(
      2,
      'session-replay',
      'worker-replay',
      'attempt-http-replay'
    )
    expect(mocks.acknowledgeWorkClaim).not.toHaveBeenCalled()
  })
})
