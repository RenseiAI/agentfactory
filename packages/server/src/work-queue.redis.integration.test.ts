import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { disconnectRedis, getRedisClient } from './redis.js'
import {
  getWorkClaimKey,
  getWorkReconciliationTombstoneKey,
  getWorkStateKey,
  WORK_ITEMS_KEY,
  WORK_QUEUE_KEY,
  queueWork,
  claimWork,
  claimWorkWithReceipt,
  acknowledgeWorkClaim,
  getClaimOwner,
  releaseClaim,
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

async function seedV0914PendingWork(
  id: string,
  options: { legacyWorkerId?: string } = {}
): Promise<QueuedWork> {
  const work = makeWork(id)
  await redis.hset(WORK_ITEMS_KEY, id, JSON.stringify(work))
  await redis.zadd(WORK_QUEUE_KEY, work.priority, id)
  if (options.legacyWorkerId) {
    await redis.set(`work:claim:${id}`, options.legacyWorkerId, 'EX', 300)
  }
  return work
}

function redisClusterSlot(key: string): number {
  const start = key.indexOf('{')
  const end = start === -1 ? -1 : key.indexOf('}', start + 1)
  const tag = start !== -1 && end > start + 1 ? key.slice(start + 1, end) : key
  let crc = 0
  for (const byte of Buffer.from(tag)) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) === 0 ? (crc << 1) : ((crc << 1) ^ 0x1021)
      crc &= 0xffff
    }
  }
  return crc % 16384
}

async function expectQueueArtifactsRemoved(id: string): Promise<void> {
  await expect(redis.zscore(WORK_QUEUE_KEY, id)).resolves.toBeNull()
  await expect(redis.hget(WORK_ITEMS_KEY, id)).resolves.toBeNull()
}

afterEach(async () => {
  for (const id of touchedSessionIds) {
    await redis.zrem(WORK_QUEUE_KEY, id)
    await redis.hdel(WORK_ITEMS_KEY, id)
    await redis.del(
      `work:claim:${id}`,
      getWorkClaimKey(id),
      getWorkReconciliationTombstoneKey(id)
    )
  }
  touchedSessionIds.clear()
})

afterAll(async () => {
  await disconnectRedis()
})

describe('work queue reconciliation fence against real Redis', () => {
  it('materializes v0.9.14 pending work before claiming and retains legacy indexes', async () => {
    const id = sessionId('legacy-pending')
    const work = await seedV0914PendingWork(id)

    await expect(redis.zscore(WORK_QUEUE_KEY, id)).resolves.not.toBeNull()
    await expect(redis.hget(WORK_ITEMS_KEY, id)).resolves.toBe(JSON.stringify(work))
    await expect(redis.get(getWorkStateKey(id))).resolves.toBeNull()

    await expect(
      popAndClaimWorkWithReceipt('worker-upgrade', 'attempt-upgrade')
    ).resolves.toMatchObject({
      status: 'claimed',
      workerId: 'worker-upgrade',
      attemptToken: 'attempt-upgrade',
      work,
    })

    // The state record is authoritative, but legacy mixed-version readers
    // retain their source payload until a durable delivery cleanup occurs.
    await expect(redis.zscore(WORK_QUEUE_KEY, id)).resolves.not.toBeNull()
    await expect(redis.hget(WORK_ITEMS_KEY, id)).resolves.toBe(JSON.stringify(work))
    await expect(redis.get(getWorkStateKey(id))).resolves.toMatch(/"claim"/)
    await expect(redis.get(`work:claim:${id}`)).resolves.toMatch(/^bridge:worker-upgrade:/)
    await expect(
      redis.set(`work:claim:${id}`, 'worker-v0914-racer', 'EX', 300, 'NX')
    ).resolves.toBeNull()
  })

  it('honors a v0.9.14 live claim without deleting pending legacy payload', async () => {
    const id = sessionId('legacy-live-claim')
    const work = await seedV0914PendingWork(id, { legacyWorkerId: 'worker-v0914' })

    await expect(
      popAndClaimWorkWithReceipt('worker-upgrade', 'attempt-upgrade-live')
    ).resolves.toEqual({ status: 'claim_unavailable', sessionId: '' })

    await expect(redis.get(`work:claim:${id}`)).resolves.toBe('worker-v0914')
    await expect(redis.zscore(WORK_QUEUE_KEY, id)).resolves.not.toBeNull()
    await expect(redis.hget(WORK_ITEMS_KEY, id)).resolves.toBe(JSON.stringify(work))
    await expect(redis.get(getWorkStateKey(id))).resolves.toMatch(/"workerId":"worker-v0914"/)
  })

  it('keeps legacy claimWork single-delivery after terminal release', async () => {
    const id = sessionId('legacy-single-delivery')
    const work = makeWork(id)
    await expect(queueWork(work)).resolves.toBe(true)

    await expect(claimWork(id, 'worker-one')).resolves.toEqual(work)
    const { releaseClaim } = await import('./work-queue.js')
    await expect(releaseClaim(id)).resolves.toBe(true)
    await expect(claimWork(id, 'worker-two')).resolves.toBeNull()
    await expectQueueArtifactsRemoved(id)
  })

  it('uses one hash-tagged authority slot for claim and reconciliation state', () => {
    const id = sessionId('cluster-slot')
    const stateKey = getWorkStateKey(id)

    expect(stateKey).toMatch(/^work:state:\{.+\}$/)
    expect(redisClusterSlot(stateKey)).toBe(redisClusterSlot(getWorkClaimKey(id)))
    expect(redisClusterSlot(stateKey)).toBe(
      redisClusterSlot(getWorkReconciliationTombstoneKey(id))
    )
  })

  it('serializes a concurrent reconcile and claims to exactly one winner', async () => {
    const id = sessionId('race')
    await expect(queueWork(makeWork(id))).resolves.toBe(true)

    const [reconciliation, ...claims] = await Promise.all([
      reconcileWork(id, { generation: 'generation-race', ttlSeconds: 300 }),
      ...Array.from({ length: 24 }, (_, index) =>
        claimWorkWithReceipt(id, `worker-${index}`, `attempt-race-${index}`)
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
      await expect(redis.get(getWorkStateKey(id))).resolves.toMatch(
        /"tombstone"/
      )
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
    await expect(claimWorkWithReceipt(directId, 'worker-direct', 'attempt-direct')).resolves.toEqual({
      status: 'claim_refused_reconciled',
      sessionId: directId,
      reconciliationGeneration: 'generation-direct',
    })
    await expect(redis.get(getWorkStateKey(directId))).resolves.toMatch(
      /"tombstone"/
    )
    await expectQueueArtifactsRemoved(directId)

    await expect(
      reconcileWork(pollId, { generation: 'generation-poll', ttlSeconds: 300 })
    ).resolves.toMatchObject({
      status: 'reconcile_tombstone_written',
      generation: 'generation-poll',
    })
    // Simulate a delayed non-authoritative index write after reconciliation.
    // The colocated state tombstone remains authoritative and poll must refuse.
    const pollWork = makeWork(pollId)
    await redis.hset(WORK_ITEMS_KEY, pollId, JSON.stringify(pollWork))
    await redis.zadd(WORK_QUEUE_KEY, pollWork.priority, pollId)

    await expect(popAndClaimWorkWithReceipt('worker-poll', 'attempt-poll')).resolves.toEqual({
      status: 'claim_refused_reconciled',
      sessionId: pollId,
      reconciliationGeneration: 'generation-poll',
    })
    await expect(redis.get(getWorkStateKey(pollId))).resolves.toMatch(
      /"tombstone"/
    )
    await expectQueueArtifactsRemoved(pollId)
  })

  it('preserves the caller-owned tombstone TTL and refuses reconciliation after a claim', async () => {
    const ttlId = sessionId('ttl')
    await expect(
      reconcileWork(ttlId, { generation: 'generation-ttl', ttlSeconds: 300 })
    ).resolves.toMatchObject({ status: 'reconcile_tombstone_written' })
    const ttlState = JSON.parse(await redis.get(getWorkStateKey(ttlId)) ?? '{}') as {
      tombstone?: { expiresAt?: number }
    }
    expect((ttlState.tombstone?.expiresAt ?? 0) - Date.now()).toBeGreaterThanOrEqual(298_000)

    const claimedId = sessionId('claim-first')
    await expect(queueWork(makeWork(claimedId))).resolves.toBe(true)
    await expect(claimWorkWithReceipt(claimedId, 'worker-first', 'attempt-first')).resolves.toMatchObject({
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
    await expect(redis.get(getWorkStateKey(claimedId))).resolves.toMatch(
      /"claim"/
    )
  })

  it('retains the payload through same-token replay until delivery acknowledgement', async () => {
    const id = sessionId('delivery-boundary')
    const work = makeWork(id)
    const attemptToken = 'attempt-delivery-boundary'
    await expect(queueWork(work)).resolves.toBe(true)

    const first = await claimWorkWithReceipt(id, 'worker-delivery', attemptToken)
    expect(first).toMatchObject({ status: 'claimed', attemptToken, work })
    await expect(redis.get(getWorkStateKey(id))).resolves.toMatch(/"work"/)

    await expect(
      claimWorkWithReceipt(id, 'worker-delivery', attemptToken)
    ).resolves.toEqual(first)

    await expect(acknowledgeWorkClaim(id, attemptToken)).resolves.toBe(true)
    expect(await redis.get(getWorkStateKey(id))).not.toContain('"work"')
    await expectQueueArtifactsRemoved(id)
  })

  it('treats durable delivery acknowledgement as live ownership until release', async () => {
    const id = sessionId('delivery-is-live')
    await expect(queueWork(makeWork(id))).resolves.toBe(true)
    await expect(
      claimWorkWithReceipt(id, 'worker-live', 'attempt-live')
    ).resolves.toMatchObject({ status: 'claimed' })

    await expect(acknowledgeWorkClaim(id, 'attempt-live')).resolves.toBe(true)
    await expect(getClaimOwner(id)).resolves.toBe('worker-live')
    await expect(
      reconcileWork(id, { generation: 'generation-live', ttlSeconds: 300 })
    ).resolves.toEqual({
      status: 'reconcile_refused_claimed',
      sessionId: id,
      workerId: 'worker-live',
    })

    await expect(releaseClaim(id)).resolves.toBe(true)
    await expect(getClaimOwner(id)).resolves.toBeNull()
    await expect(
      reconcileWork(id, { generation: 'generation-after-release', ttlSeconds: 300 })
    ).resolves.toMatchObject({ status: 'reconcile_tombstone_written' })
  })
})
