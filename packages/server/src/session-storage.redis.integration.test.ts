import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { disconnectRedis, getRedisClient } from './redis.js'
import {
  claimSession,
  startSession,
  type AgentSessionState,
} from './session-storage.js'

const SESSION_KEY_PREFIX = 'agent:session:'
const SESSION_TTL_SECONDS = 24 * 60 * 60
const RUN_ID = randomUUID()

const touchedKeys = new Set<string>()

if (!process.env.REDIS_URL) {
  throw new Error(
    'REDIS_URL is required for the non-skipping session lifecycle Redis integration gate'
  )
}

const redis = getRedisClient()
const pong = await redis.ping()
if (pong !== 'PONG') {
  throw new Error(`Redis readiness probe returned ${pong}`)
}

function sessionId(label: string): string {
  return `ren-2875:${RUN_ID}:${label}`
}

function sessionKey(id: string): string {
  const key = `${SESSION_KEY_PREFIX}${id}`
  touchedKeys.add(key)
  return key
}

function makeSession(
  id: string,
  overrides: Partial<AgentSessionState> = {}
): AgentSessionState {
  return {
    trackerSessionId: id,
    trackerProvider: 'linear',
    issueId: `issue:${id}`,
    providerSessionId: null,
    worktreePath: '',
    status: 'pending',
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    ...overrides,
  }
}

async function seedRaw(
  id: string,
  value: unknown,
  ttlSeconds = 60
): Promise<string> {
  const key = sessionKey(id)
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds)
  return key
}

async function readRaw(key: string): Promise<Record<string, unknown>> {
  const raw = await redis.get(key)
  expect(raw).not.toBeNull()
  return JSON.parse(raw!) as Record<string, unknown>
}

afterEach(async () => {
  if (touchedKeys.size > 0) {
    await redis.del(...touchedKeys)
  }
  touchedKeys.clear()
})

afterAll(async () => {
  await disconnectRedis()
})

describe('production atomic worker lifecycle Lua against Redis', () => {
  it('rejects missing and malformed rows without creating or rewriting them', async () => {
    const missingId = sessionId('missing')
    const missingKey = sessionKey(missingId)

    await expect(claimSession(missingId, 'worker-a')).resolves.toBe(false)
    await expect(
      startSession(missingId, 'worker-a', '/tmp/missing')
    ).resolves.toBe(false)
    await expect(redis.exists(missingKey)).resolves.toBe(0)

    const malformedId = sessionId('malformed')
    const malformedKey = sessionKey(malformedId)
    const malformedValue = '{not-json'
    await redis.set(malformedKey, malformedValue, 'EX', 60)

    await expect(claimSession(malformedId, 'worker-a')).resolves.toBe(false)
    await expect(
      startSession(malformedId, 'worker-a', '/tmp/malformed')
    ).resolves.toBe(false)
    await expect(redis.get(malformedKey)).resolves.toBe(malformedValue)
    expect(await redis.ttl(malformedKey)).toBeGreaterThan(0)
  })

  it('preserves TTL and bytes on rejection, then resets TTL on successful claim and start', async () => {
    const id = sessionId('ttl-contract')
    const key = await seedRaw(id, makeSession(id, { status: 'running' }))
    const rejectedValue = await redis.get(key)
    const rejectedTtl = await redis.ttl(key)

    await expect(claimSession(id, 'worker-a')).resolves.toBe(false)
    await expect(redis.get(key)).resolves.toBe(rejectedValue)
    expect(await redis.ttl(key)).toBeGreaterThanOrEqual(rejectedTtl - 2)

    await seedRaw(id, makeSession(id), 60)
    await expect(claimSession(id, 'worker-a')).resolves.toBe(true)
    expect(await redis.ttl(key)).toBeGreaterThanOrEqual(
      SESSION_TTL_SECONDS - 2
    )

    await redis.expire(key, 60)
    await expect(
      startSession(id, 'worker-a', '/tmp/ttl-contract')
    ).resolves.toBe(true)
    expect(await redis.ttl(key)).toBeGreaterThanOrEqual(
      SESSION_TTL_SECONDS - 2
    )
  })

  it('migrates legacy tracker fields on both successful transitions', async () => {
    const claimId = sessionId('legacy-claim')
    const claimKey = await seedRaw(claimId, {
      linearSessionId: claimId,
      issueId: 'issue-legacy-claim',
      providerSessionId: null,
      worktreePath: '',
      status: 'pending',
      createdAt: 1_000_000,
      updatedAt: 1_000_000,
    })

    await expect(claimSession(claimId, 'worker-legacy')).resolves.toBe(true)
    expect(await readRaw(claimKey)).toMatchObject({
      linearSessionId: claimId,
      trackerSessionId: claimId,
      trackerProvider: 'linear',
      status: 'claimed',
      workerId: 'worker-legacy',
    })

    const startId = sessionId('legacy-start')
    const exactClaimedAt = 1_234_567
    const startKey = await seedRaw(startId, {
      linearSessionId: startId,
      issueId: 'issue-legacy-start',
      providerSessionId: null,
      worktreePath: '',
      status: 'claimed',
      workerId: 'worker-legacy',
      claimedAt: exactClaimedAt,
      createdAt: 1_000_000,
      updatedAt: 1_000_000,
    })

    await expect(
      startSession(startId, 'worker-legacy', '/tmp/legacy')
    ).resolves.toBe(true)
    expect(await readRaw(startKey)).toMatchObject({
      linearSessionId: startId,
      trackerSessionId: startId,
      trackerProvider: 'linear',
      status: 'running',
      workerId: 'worker-legacy',
      claimedAt: exactClaimedAt,
      worktreePath: '/tmp/legacy',
    })
  })

  it('allows a claim only from pending and leaves every other status unchanged', async () => {
    for (const status of [
      'claimed',
      'running',
      'finalizing',
      'completed',
      'failed',
      'stopped',
      'timed_out',
    ] as const) {
      const id = sessionId(`claim-from-${status}`)
      const key = await seedRaw(id, makeSession(id, { status }))
      const before = await redis.get(key)

      await expect(claimSession(id, 'worker-a')).resolves.toBe(false)
      await expect(redis.get(key)).resolves.toBe(before)
    }
  })

  it('permits exactly one winner across concurrent pending claims', async () => {
    const id = sessionId('one-claim-winner')
    const key = await seedRaw(id, makeSession(id))
    const workers = Array.from({ length: 24 }, (_, index) => `worker-${index}`)

    const results = await Promise.all(
      workers.map((workerId) => claimSession(id, workerId))
    )

    expect(results.filter(Boolean)).toHaveLength(1)
    const winningWorker = workers[results.findIndex(Boolean)]
    expect(await readRaw(key)).toMatchObject({
      status: 'claimed',
      workerId: winningWorker,
      claimedAt: expect.any(Number),
    })
  })

  it('starts only a claimed row owned by the same worker with numeric claimedAt', async () => {
    const invalidRows: Array<{
      label: string
      row: Partial<AgentSessionState>
    }> = [
      { label: 'pending', row: { status: 'pending', workerId: 'worker-a' } },
      { label: 'running', row: { status: 'running', workerId: 'worker-a' } },
      {
        label: 'wrong-worker',
        row: { status: 'claimed', workerId: 'worker-b', claimedAt: 123 },
      },
      {
        label: 'missing-claimed-at',
        row: { status: 'claimed', workerId: 'worker-a' },
      },
      {
        label: 'null-claimed-at',
        row: { status: 'claimed', workerId: 'worker-a', claimedAt: null },
      },
    ]

    for (const { label, row } of invalidRows) {
      const id = sessionId(`invalid-start-${label}`)
      const key = await seedRaw(id, makeSession(id, row))
      const before = await redis.get(key)

      await expect(
        startSession(id, 'worker-a', `/tmp/${label}`)
      ).resolves.toBe(false)
      await expect(redis.get(key)).resolves.toBe(before)
    }

    const validId = sessionId('valid-start')
    const validKey = await seedRaw(
      validId,
      makeSession(validId, {
        status: 'claimed',
        workerId: 'worker-a',
        claimedAt: 123,
      })
    )
    await expect(
      startSession(validId, 'worker-a', '/tmp/valid')
    ).resolves.toBe(true)
    expect(await readRaw(validKey)).toMatchObject({
      status: 'running',
      workerId: 'worker-a',
      claimedAt: 123,
      worktreePath: '/tmp/valid',
    })
  })

  it('preserves the exact claimedAt sampled by claim through start', async () => {
    const id = sessionId('claimed-at')
    const key = await seedRaw(id, makeSession(id))

    await expect(claimSession(id, 'worker-a')).resolves.toBe(true)
    const claimed = await readRaw(key)
    expect(claimed.claimedAt).toEqual(expect.any(Number))
    const exactClaimedAt = claimed.claimedAt

    await expect(
      startSession(id, 'worker-a', '/tmp/claimed-at')
    ).resolves.toBe(true)
    expect((await readRaw(key)).claimedAt).toBe(exactClaimedAt)
  })

  it('serializes both claim/start command orderings without an impossible running row', async () => {
    const startFirstId = sessionId('start-first')
    const startFirstKey = await seedRaw(
      startFirstId,
      makeSession(startFirstId)
    )
    const startFirst = await Promise.all([
      startSession(startFirstId, 'worker-a', '/tmp/start-first'),
      claimSession(startFirstId, 'worker-a'),
    ])
    expect(startFirst).toEqual([false, true])
    expect(await readRaw(startFirstKey)).toMatchObject({
      status: 'claimed',
      workerId: 'worker-a',
      claimedAt: expect.any(Number),
    })

    const claimFirstId = sessionId('claim-first')
    const claimFirstKey = await seedRaw(
      claimFirstId,
      makeSession(claimFirstId)
    )
    const claimFirst = await Promise.all([
      claimSession(claimFirstId, 'worker-a'),
      startSession(claimFirstId, 'worker-a', '/tmp/claim-first'),
    ])
    expect(claimFirst).toEqual([true, true])
    expect(await readRaw(claimFirstKey)).toMatchObject({
      status: 'running',
      workerId: 'worker-a',
      claimedAt: expect.any(Number),
      worktreePath: '/tmp/claim-first',
    })
  })

  it('propagates Redis EVAL errors instead of converting them to a skipped transition', async () => {
    const id = sessionId('wrong-type')
    const key = sessionKey(id)
    await redis.rpush(key, 'not-a-session-row')

    await expect(claimSession(id, 'worker-a')).rejects.toThrow(/WRONGTYPE/)
    await expect(
      startSession(id, 'worker-a', '/tmp/wrong-type')
    ).rejects.toThrow(/WRONGTYPE/)
  })
})
