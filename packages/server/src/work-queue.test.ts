import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock redis before importing module under test
vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  redisGet: vi.fn(),
  redisDel: vi.fn(),
  redisEval: vi.fn(),
  redisExpire: vi.fn(),
  redisSet: vi.fn(),
  redisZAdd: vi.fn(),
  redisZRem: vi.fn(),
  redisZRangeByScore: vi.fn(() => []),
  redisZCard: vi.fn(() => 0),
  redisHSet: vi.fn(),
  redisHGet: vi.fn(),
  redisHDel: vi.fn(),
  redisHMGet: vi.fn(() => []),
  redisHGetAll: vi.fn(),
  redisHLen: vi.fn(() => 0),
  redisKeys: vi.fn(() => []),
  redisLRange: vi.fn(() => []),
  redisLLen: vi.fn(() => 0),
  redisLRem: vi.fn(),
}))

import {
  queueWork,
  peekWork,
  getQueueLength,
  claimWork,
  claimWorkWithReceipt,
  popAndClaimWork,
  popAndClaimWorkWithReceipt,
  reconcileWork,
  releaseClaim,
  getClaimOwner,
  isSessionInQueue,
  requeueWork,
  removeFromQueue,
} from './work-queue.js'
import type { QueuedWork } from './work-queue.js'
import {
  isRedisConfigured,
  redisGet,
  redisDel,
  redisEval,
  redisZAdd,
  redisZRem,
  redisZRangeByScore,
  redisZCard,
  redisHSet,
  redisHGet,
  redisHDel,
  redisHMGet,
} from './redis.js'

const mockIsRedisConfigured = vi.mocked(isRedisConfigured)
const mockRedisGet = vi.mocked(redisGet)
const mockRedisDel = vi.mocked(redisDel)
const mockRedisEval = vi.mocked(redisEval)
const mockRedisZAdd = vi.mocked(redisZAdd)
const mockRedisZRem = vi.mocked(redisZRem)
const mockRedisZRangeByScore = vi.mocked(redisZRangeByScore)
const mockRedisZCard = vi.mocked(redisZCard)
const mockRedisHSet = vi.mocked(redisHSet)
const mockRedisHGet = vi.mocked(redisHGet)
const mockRedisHDel = vi.mocked(redisHDel)
const mockRedisHMGet = vi.mocked(redisHMGet)

function makeWork(overrides: Partial<QueuedWork> = {}): QueuedWork {
  return {
    sessionId: 'session-1',
    issueId: 'issue-1',
    issueIdentifier: 'SUP-100',
    priority: 2,
    queuedAt: Date.now(),
    prompt: 'test prompt',
    workType: 'development',
    ...overrides,
  }
}

describe('queueWork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns false when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await queueWork(makeWork())
    expect(result).toBe(false)
    expect(mockRedisHSet).not.toHaveBeenCalled()
    expect(mockRedisZAdd).not.toHaveBeenCalled()
  })

  it('stores work in hash and sorted set', async () => {
    const work = makeWork({ sessionId: 'sess-42', priority: 3 })
    mockRedisHSet.mockResolvedValue(1)
    mockRedisZAdd.mockResolvedValue(1)

    const result = await queueWork(work)

    expect(result).toBe(true)
    expect(mockRedisHSet).toHaveBeenCalledWith(
      'work:items',
      'sess-42',
      JSON.stringify(work)
    )
    expect(mockRedisZAdd).toHaveBeenCalledWith(
      'work:queue',
      expect.any(Number),
      'sess-42'
    )
  })

  it('returns true on success', async () => {
    mockRedisHSet.mockResolvedValue(1)
    mockRedisZAdd.mockResolvedValue(1)

    const result = await queueWork(makeWork())
    expect(result).toBe(true)
  })

  it('returns false on Redis error', async () => {
    mockRedisHSet.mockRejectedValue(new Error('connection lost'))

    const result = await queueWork(makeWork())
    expect(result).toBe(false)
  })
})

describe('peekWork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns empty array when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await peekWork()
    expect(result).toEqual([])
  })

  it('returns empty array when queue is empty', async () => {
    mockRedisZRangeByScore.mockResolvedValue([])
    const result = await peekWork()
    expect(result).toEqual([])
  })

  it('returns parsed work items sorted by priority', async () => {
    const work1 = makeWork({ sessionId: 'sess-1', priority: 1 })
    const work2 = makeWork({ sessionId: 'sess-2', priority: 3 })

    mockRedisZRangeByScore.mockResolvedValue(['sess-1', 'sess-2'])
    mockRedisHMGet.mockResolvedValue([JSON.stringify(work1), JSON.stringify(work2)])

    const result = await peekWork(10)

    expect(result).toHaveLength(2)
    expect(result[0].sessionId).toBe('sess-1')
    expect(result[1].sessionId).toBe('sess-2')
    expect(mockRedisZRangeByScore).toHaveBeenCalledWith(
      'work:queue',
      '-inf',
      '+inf',
      10
    )
    expect(mockRedisHMGet).toHaveBeenCalledWith('work:items', ['sess-1', 'sess-2'])
  })

  it('handles invalid JSON gracefully', async () => {
    const validWork = makeWork({ sessionId: 'sess-1' })

    mockRedisZRangeByScore.mockResolvedValue(['sess-1', 'sess-bad'])
    mockRedisHMGet.mockResolvedValue([JSON.stringify(validWork), '{not valid json'])

    const result = await peekWork()

    expect(result).toHaveLength(1)
    expect(result[0].sessionId).toBe('sess-1')
  })
})

describe('getQueueLength', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns 0 when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await getQueueLength()
    expect(result).toBe(0)
  })

  it('returns count from ZCARD', async () => {
    mockRedisZCard.mockResolvedValue(7)
    const result = await getQueueLength()
    expect(result).toBe(7)
    expect(mockRedisZCard).toHaveBeenCalledWith('work:queue')
  })
})

describe('claimWork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns null when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await claimWork('session-1', 'worker-1')
    expect(result).toBeNull()
  })

  it('returns null when the atomic claim script reports no available work', async () => {
    mockRedisEval.mockResolvedValue(['claim_unavailable'])

    const result = await claimWork('session-1', 'worker-1')

    expect(result).toBeNull()
  })

  it('returns work from one Redis Lua transition on successful claim', async () => {
    const work = makeWork({ sessionId: 'session-1' })
    mockRedisEval.mockResolvedValue(['claimed', JSON.stringify(work)])

    const result = await claimWork('session-1', 'worker-1')

    expect(result).toEqual(work)
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[2])"),
      [
        'work:claim:session-1',
        'work:reconciliation:session-1',
        'work:items',
        'work:queue',
      ],
      ['worker-1', expect.any(Number), 'session-1']
    )
    expect(mockRedisHGet).not.toHaveBeenCalled()
    expect(mockRedisZRem).not.toHaveBeenCalled()
    expect(mockRedisHDel).not.toHaveBeenCalled()
  })

  it('returns null through the legacy helper when reconciliation refuses a claim', async () => {
    mockRedisEval.mockResolvedValue([
      'claim_refused_reconciled',
      JSON.stringify({ generation: 'generation-7' }),
    ])

    const result = await claimWork('session-1', 'worker-1')

    expect(result).toBeNull()
  })

  it('returns null when the atomic transition errors', async () => {
    mockRedisEval.mockRejectedValue(new Error('Redis down'))

    const result = await claimWork('session-1', 'worker-1')

    expect(result).toBeNull()
  })
})

describe('claimWorkWithReceipt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns typed claim_refused_reconciled without issuing split Redis commands', async () => {
    mockRedisEval.mockResolvedValue([
      'claim_refused_reconciled',
      JSON.stringify({ generation: 'generation-9' }),
    ])

    await expect(claimWorkWithReceipt('session-9', 'worker-9')).resolves.toEqual({
      status: 'claim_refused_reconciled',
      sessionId: 'session-9',
      reconciliationGeneration: 'generation-9',
    })
    expect(mockRedisEval).toHaveBeenCalledTimes(1)
    expect(mockRedisHGet).not.toHaveBeenCalled()
    expect(mockRedisZRem).not.toHaveBeenCalled()
    expect(mockRedisHDel).not.toHaveBeenCalled()
  })
})

describe('reconcileWork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('writes a caller-TTL tombstone in one atomic transition', async () => {
    mockRedisEval.mockResolvedValue([
      'reconcile_tombstone_written',
      JSON.stringify({ generation: 'generation-11' }),
    ])

    await expect(
      reconcileWork('session-11', { generation: 'generation-11', ttlSeconds: 7200 })
    ).resolves.toEqual({
      status: 'reconcile_tombstone_written',
      sessionId: 'session-11',
      generation: 'generation-11',
    })
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])"),
      [
        'work:claim:session-11',
        'work:reconciliation:session-11',
        'work:items',
        'work:queue',
      ],
      [JSON.stringify({ generation: 'generation-11' }), 7200, 'session-11']
    )
  })

  it('rejects an invalid TTL before calling Redis', async () => {
    await expect(
      reconcileWork('session-invalid', { generation: 'generation-12', ttlSeconds: 0 })
    ).rejects.toThrow('positive whole number')
    expect(mockRedisEval).not.toHaveBeenCalled()
  })

  it('returns a typed unavailable result when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)

    await expect(
      reconcileWork('session-unavailable', { generation: 'generation-13', ttlSeconds: 300 })
    ).resolves.toEqual({ status: 'reconcile_unavailable', sessionId: 'session-unavailable' })
    expect(mockRedisEval).not.toHaveBeenCalled()
  })
})

describe('releaseClaim', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns false when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await releaseClaim('session-1')
    expect(result).toBe(false)
  })

  it('returns true when claim key deleted', async () => {
    mockRedisDel.mockResolvedValue(1)

    const result = await releaseClaim('session-1')

    expect(result).toBe(true)
    expect(mockRedisDel).toHaveBeenCalledWith('work:claim:session-1')
  })
})

describe('getClaimOwner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns null when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await getClaimOwner('session-1')
    expect(result).toBeNull()
  })

  it('returns worker ID from claim key', async () => {
    mockRedisGet.mockResolvedValue('worker-42')

    const result = await getClaimOwner('session-1')

    expect(result).toBe('worker-42')
    expect(mockRedisGet).toHaveBeenCalledWith('work:claim:session-1')
  })
})

describe('isSessionInQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns false when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await isSessionInQueue('session-1')
    expect(result).toBe(false)
  })

  it('returns true when session exists in hash', async () => {
    mockRedisHGet.mockResolvedValue(JSON.stringify(makeWork()))

    const result = await isSessionInQueue('session-1')

    expect(result).toBe(true)
    expect(mockRedisHGet).toHaveBeenCalledWith('work:items', 'session-1')
  })

  it('returns false when session not in hash', async () => {
    mockRedisHGet.mockResolvedValue(null)

    const result = await isSessionInQueue('session-1')
    expect(result).toBe(false)
  })
})

describe('requeueWork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('re-queues with boosted priority', async () => {
    mockRedisDel.mockResolvedValue(1) // releaseClaim
    mockRedisHSet.mockResolvedValue(1)
    mockRedisZAdd.mockResolvedValue(1)

    const work = makeWork({ priority: 4 })
    const result = await requeueWork(work, 2)

    expect(result).toBe(true)
    // The re-queued item should have priority 4 - 2 = 2
    const storedJson = mockRedisHSet.mock.calls[0][2] as string
    const stored = JSON.parse(storedJson) as QueuedWork
    expect(stored.priority).toBe(2)
  })

  it('releases existing claim before re-queuing', async () => {
    mockRedisDel.mockResolvedValue(1)
    mockRedisHSet.mockResolvedValue(1)
    mockRedisZAdd.mockResolvedValue(1)

    const work = makeWork({ sessionId: 'sess-requeue' })
    await requeueWork(work)

    expect(mockRedisDel).toHaveBeenCalledWith('work:claim:sess-requeue')
  })

  it('clamps priority to minimum 1', async () => {
    mockRedisDel.mockResolvedValue(1)
    mockRedisHSet.mockResolvedValue(1)
    mockRedisZAdd.mockResolvedValue(1)

    const work = makeWork({ priority: 1 })
    const result = await requeueWork(work, 5)

    expect(result).toBe(true)
    const storedJson = mockRedisHSet.mock.calls[0][2] as string
    const stored = JSON.parse(storedJson) as QueuedWork
    expect(stored.priority).toBe(1)
  })
})

describe('removeFromQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns false when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await removeFromQueue('session-1')
    expect(result).toBe(false)
  })

  it('removes from both sorted set and hash', async () => {
    mockRedisZRem.mockResolvedValue(1)
    mockRedisHDel.mockResolvedValue(1)

    const result = await removeFromQueue('session-1')

    expect(result).toBe(true)
    expect(mockRedisZRem).toHaveBeenCalledWith('work:queue', 'session-1')
    expect(mockRedisHDel).toHaveBeenCalledWith('work:items', 'session-1')
  })
})

describe('popAndClaimWork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns null when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await popAndClaimWork('worker-1')
    expect(result).toBeNull()
  })

  it('returns null when queue is empty', async () => {
    mockRedisEval.mockResolvedValue(['claim_unavailable'])
    const result = await popAndClaimWork('worker-1')
    expect(result).toBeNull()
  })

  it('pops highest-priority item and claims it in one Redis Lua transition', async () => {
    const work = makeWork()
    mockRedisEval.mockResolvedValue(['claimed', JSON.stringify(work), 'session-1'])

    const result = await popAndClaimWork('worker-1')

    expect(result).toEqual(work)
    expect(mockRedisEval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('ZRANGE', KEYS[2], 0, 0)"),
      ['work:items', 'work:queue'],
      ['worker-1', expect.any(Number), 'work:claim:', 'work:reconciliation:']
    )
  })

  it('returns null when a popped item is refused by reconciliation', async () => {
    mockRedisEval.mockResolvedValue([
      'claim_refused_reconciled',
      JSON.stringify({ generation: 'generation-13' }),
      'session-13',
    ])

    const result = await popAndClaimWork('worker-1')

    expect(result).toBeNull()
  })

  it('returns null on error', async () => {
    mockRedisEval.mockRejectedValue(new Error('Redis down'))

    const result = await popAndClaimWork('worker-1')

    expect(result).toBeNull()
  })
})

describe('popAndClaimWorkWithReceipt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns the reconciliation refusal with its selected session ID', async () => {
    mockRedisEval.mockResolvedValue([
      'claim_refused_reconciled',
      JSON.stringify({ generation: 'generation-14' }),
      'session-14',
    ])

    await expect(popAndClaimWorkWithReceipt('worker-14')).resolves.toEqual({
      status: 'claim_refused_reconciled',
      sessionId: 'session-14',
      reconciliationGeneration: 'generation-14',
    })
  })
})
