import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireWorkerAuth: vi.fn(),
}))

vi.mock('../middleware/worker-auth.js', () => ({
  requireWorkerAuth: mocks.requireWorkerAuth,
}))

import {
  deleteSessionState,
  deregisterWorker,
  disconnectRedis,
  getRedisClient,
  getWorker,
  queueWork,
  registerWorker,
  releaseClaim,
  storeSessionState,
  updateSessionStatus,
  type QueuedWork,
} from '@donmai/server'
import { createWorkerPollHandler } from '../handlers/workers/poll.js'

const RUN_ID = randomUUID()
const touchedSessionIds = new Set<string>()
const touchedWorkerIds = new Set<string>()

if (!process.env.REDIS_URL) {
  throw new Error(
    'REDIS_URL is required for the non-skipping worker poll replay Redis integration gate'
  )
}

const redis = getRedisClient()
const pong = await redis.ping()
if (pong !== 'PONG') {
  throw new Error(`Redis readiness probe returned ${pong}`)
}

function sessionId(label: string): string {
  const id = `worker-poll-replay:${RUN_ID}:${label}`
  touchedSessionIds.add(id)
  return id
}

async function createWorker(label: string, capacity = 1): Promise<string> {
  const registered = await registerWorker(
    `worker-poll-${RUN_ID}-${label}`,
    capacity
  )
  if (!registered) throw new Error('worker registration failed')
  touchedWorkerIds.add(registered.workerId)
  return registered.workerId
}

async function seedPendingWork(id: string): Promise<QueuedWork> {
  await storeSessionState(id, {
    issueId: `issue:${id}`,
    issueIdentifier: 'OSS-POLL-REPLAY',
    providerSessionId: null,
    worktreePath: '',
    status: 'pending',
  })

  const work: QueuedWork = {
    sessionId: id,
    issueId: `issue:${id}`,
    issueIdentifier: 'OSS-POLL-REPLAY',
    priority: 1,
    queuedAt: Date.now(),
    workType: 'development',
  }
  await expect(queueWork(work)).resolves.toBe(true)
  return work
}

function request() {
  return new NextRequest('http://localhost/api/workers/poll', { method: 'GET' })
}

function context(workerId: string) {
  return { params: Promise.resolve({ id: workerId }) }
}

beforeEach(() => {
  mocks.requireWorkerAuth.mockReturnValue(null)
})

afterEach(async () => {
  for (const id of touchedSessionIds) {
    await releaseClaim(id)
    await deleteSessionState(id)
    await redis.del(`work:claim:${id}`, `work:state:{${encodeURIComponent(id)}}`)
    await redis.zrem('work:queue', id)
    await redis.hdel('work:items', id)
  }
  touchedSessionIds.clear()

  for (const workerId of touchedWorkerIds) {
    await deregisterWorker(workerId)
  }
  touchedWorkerIds.clear()
})

afterAll(async () => {
  await disconnectRedis()
})

describe('worker poll response replay against real Redis', () => {
  it('replays an outstanding capacity-1 receipt before capacity admission, but never to another or terminal/released worker state', async () => {
    const ownerWorkerId = await createWorker('owner')
    const otherWorkerId = await createWorker('other')
    const id = sessionId('capacity-one')
    const work = await seedPendingWork(id)
    const handler = createWorkerPollHandler()

    // Simulate a capacity-1 worker whose first successful 200 is lost after
    // claimSession/addWorkerSession commit but before the remote worker reads it.
    const first = await handler(request(), context(ownerWorkerId))
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({
      work: [work],
      preClaimed: true,
      claimedSessionIds: [id],
    })
    await expect(getWorker(ownerWorkerId)).resolves.toMatchObject({
      capacity: 1,
      activeSessions: [id],
    })

    // The retry has zero *new* capacity, but the old receipt is already owned
    // by this worker and must be replayed before admission is evaluated.
    const retry = await handler(request(), context(ownerWorkerId))
    await expect(retry.json()).resolves.toMatchObject({
      work: [work],
      preClaimed: true,
      claimedSessionIds: [id],
    })

    // A different worker cannot use the replay path to obtain the payload.
    const otherWorkerPoll = await handler(request(), context(otherWorkerId))
    await expect(otherWorkerPoll.json()).resolves.toMatchObject({
      work: [],
      preClaimed: false,
      claimedSessionIds: [],
    })

    // A terminal session has no replayable delivery even if a stale active-set
    // member remains. Releasing the old receipt is also final for replay.
    await expect(updateSessionStatus(id, 'completed')).resolves.toBe(true)
    const terminalPoll = await handler(request(), context(ownerWorkerId))
    await expect(terminalPoll.json()).resolves.toMatchObject({ work: [] })

    await expect(releaseClaim(id)).resolves.toBe(true)
    const releasedPoll = await handler(request(), context(ownerWorkerId))
    await expect(releasedPoll.json()).resolves.toMatchObject({ work: [] })
  })

  it('does not let a replayed receipt consume a new-work selection slot', async () => {
    const workerId = await createWorker('spare-capacity', 2)
    const replayedId = sessionId('replayed')
    const newId = sessionId('new')
    const replayedWork = await seedPendingWork(replayedId)
    const handler = createWorkerPollHandler()

    // First response is lost with one free slot still available.
    const first = await handler(request(), context(workerId))
    const firstBody = await first.json() as { work: QueuedWork[] }
    expect(firstBody.work).toEqual([replayedWork])
    const newWork = await seedPendingWork(newId)

    const retry = await handler(request(), context(workerId))
    const body = await retry.json() as { work: QueuedWork[]; claimedSessionIds: string[] }
    expect(body.work.map((item) => item.sessionId)).toEqual([
      replayedWork.sessionId,
      newWork.sessionId,
    ])
    expect(body.claimedSessionIds).toEqual([
      replayedWork.sessionId,
      newWork.sessionId,
    ])
  })
})
