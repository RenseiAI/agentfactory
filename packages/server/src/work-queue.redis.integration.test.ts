import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { disconnectRedis, getRedisClient } from './redis.js'
import {
  getWorkClaimKey,
  getWorkReconciliationTombstoneKey,
  WORK_ITEMS_KEY,
  WORK_QUEUE_KEY,
  queueWork,
  claimWorkWithReceipt,
  popAndClaimWorkWithReceipt,
  reconcileWork,
  type QueuedWork,
} from './work-queue.js'

const RUN_ID = randomUUID()
const touchedSessionIds = new Set<string>()

if (!process.env.REDIS_URL) {
  throw new Error(
    'REDIS_URL is required for the non-skipping work reconciliation Redis integration gate'
  )
}

const redis = getRedisClient()
const pong = await redis.ping()
if (pong !== 'PONG') {
  throw new Error(`Redis readiness probe returned ${pong}`)
}

function sessionId(label: string): string {
  const id = `work-reconcile:${RUN_ID}:${label}`
  touchedSessionIds.add(id)
  return id
}

function makeWork(id: string): QueuedWork {
  return {
    sessionId: id,
    issueId: `issue:${id}`,
    issueIdentifier: 'OSS-1',
    priority: 1,
    queuedAt: Date.now(),
    workType: 'development',
  }
}

async function expectQueueArtifactsRemoved(id: string): Promise<void> {
  await expect(redis.zscore(WORK_QUEUE_KEY, id)).resolves.toBeNull()
  await expect(redis.hget(WORK_ITEMS_KEY, id)).resolves.toBeNull()
}

afterEach(async () => {
  for (const id of touchedSessionIds) {
    await redis.zrem(WORK_QUEUE_KEY, id)
    await redis.hdel(WORK_ITEMS_KEY, id)
    await redis.del(getWorkClaimKey(id), getWorkReconciliationTombstoneKey(id))
  }
  touchedSessionIds.clear()
})

afterAll(async () => {
  await disconnectRedis()
})

describe('work queue reconciliation fence against real Redis', () => {
  it('serializes a concurrent reconcile and claims to exactly one winner', async () => {
    const id = sessionId('race')
    await expect(queueWork(makeWork(id))).resolves.toBe(true)

    const [reconciliation, ...claims] = await Promise.all([
      reconcileWork(id, { generation: 'generation-race', ttlSeconds: 300 }),
      ...Array.from({ length: 24 }, (_, index) =>
        claimWorkWithReceipt(id, `worker-${index}`)
      ),
    ])

    const claimWinners = claims.filter(result => result.status === 'claimed')
    const reconciliationWon = reconciliation.status === 'reconcile_tombstone_written'
    expect(Number(reconciliationWon) + claimWinners.length).toBe(1)

    if (reconciliationWon) {
      expect(claims).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: 'claim_refused_reconciled' }),
        ])
      )
      await expect(redis.get(getWorkClaimKey(id))).resolves.toBeNull()
      await expectQueueArtifactsRemoved(id)
    } else {
      expect(reconciliation).toEqual({
        status: 'reconcile_refused_claimed',
        sessionId: id,
        workerId: expect.any(String),
      })
      await expect(redis.get(getWorkReconciliationTombstoneKey(id))).resolves.toBeNull()
    }
  })

  it('refuses delayed direct and poll claims with typed receipts after reconciliation', async () => {
    const directId = sessionId('later-direct')
    const pollId = sessionId('later-poll')

    await expect(
      reconcileWork(directId, { generation: 'generation-direct', ttlSeconds: 300 })
    ).resolves.toMatchObject({
      status: 'reconcile_tombstone_written',
      generation: 'generation-direct',
    })
    await expect(queueWork(makeWork(directId))).resolves.toBe(true)

    await expect(claimWorkWithReceipt(directId, 'worker-direct')).resolves.toEqual({
      status: 'claim_refused_reconciled',
      sessionId: directId,
      reconciliationGeneration: 'generation-direct',
    })
    await expect(redis.get(getWorkClaimKey(directId))).resolves.toBeNull()
    await expectQueueArtifactsRemoved(directId)

    await expect(
      reconcileWork(pollId, { generation: 'generation-poll', ttlSeconds: 300 })
    ).resolves.toMatchObject({
      status: 'reconcile_tombstone_written',
      generation: 'generation-poll',
    })
    await expect(queueWork(makeWork(pollId))).resolves.toBe(true)

    await expect(popAndClaimWorkWithReceipt('worker-poll')).resolves.toEqual({
      status: 'claim_refused_reconciled',
      sessionId: pollId,
      reconciliationGeneration: 'generation-poll',
    })
    await expect(redis.get(getWorkClaimKey(pollId))).resolves.toBeNull()
    await expectQueueArtifactsRemoved(pollId)
  })

  it('preserves the caller-owned tombstone TTL and refuses reconciliation after a claim', async () => {
    const ttlId = sessionId('ttl')
    await expect(
      reconcileWork(ttlId, { generation: 'generation-ttl', ttlSeconds: 300 })
    ).resolves.toMatchObject({ status: 'reconcile_tombstone_written' })
    expect(await redis.ttl(getWorkReconciliationTombstoneKey(ttlId))).toBeGreaterThanOrEqual(298)

    const claimedId = sessionId('claim-first')
    await expect(queueWork(makeWork(claimedId))).resolves.toBe(true)
    await expect(claimWorkWithReceipt(claimedId, 'worker-first')).resolves.toMatchObject({
      status: 'claimed',
      workerId: 'worker-first',
    })
    await expect(
      reconcileWork(claimedId, { generation: 'generation-after-claim', ttlSeconds: 300 })
    ).resolves.toEqual({
      status: 'reconcile_refused_claimed',
      sessionId: claimedId,
      workerId: 'worker-first',
    })
    await expect(redis.get(getWorkReconciliationTombstoneKey(claimedId))).resolves.toBeNull()
  })
})
