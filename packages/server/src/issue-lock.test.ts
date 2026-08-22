import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock redis before importing module under test
vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  redisSetNX: vi.fn(),
  redisGet: vi.fn(),
  redisDel: vi.fn(),
  redisExpire: vi.fn(),
  redisSet: vi.fn(),
  redisZAdd: vi.fn(),
  redisZRem: vi.fn(),
  redisZRangeByScore: vi.fn(() => []),
  redisZPopMin: vi.fn(),
  redisCompareAndRemoveSortedHashMember: vi.fn(() => true),
  redisZCard: vi.fn(() => 0),
  redisHSet: vi.fn(),
  redisHGet: vi.fn(),
  redisHDel: vi.fn(),
  redisHGetAll: vi.fn(),
  redisKeys: vi.fn(() => []),
}))

vi.mock('./work-queue.js', () => ({
  queueWork: vi.fn(() => true),
}))

vi.mock('./session-storage.js', () => ({
  getSessionState: vi.fn(),
}))

import {
  clearAllParkedWork,
  parkWorkForIssue,
  promoteNextPendingWork,
  cleanupExpiredLocksWithPendingWork,
  cleanupStaleLocksWithIdleWorkers,
  type IssueLock,
} from './issue-lock.js'
import {
  isRedisConfigured,
  redisSetNX,
  redisDel,
  redisZCard,
  redisZPopMin,
  redisZRangeByScore,
  redisCompareAndRemoveSortedHashMember,
  redisHGet,
  redisHDel,
  redisZAdd,
  redisHSet,
  redisExpire,
  redisKeys,
  redisGet,
} from './redis.js'
import { getSessionState } from './session-storage.js'
import type { QueuedWork } from './work-queue.js'

const mockIsRedisConfigured = vi.mocked(isRedisConfigured)
const mockRedisSetNX = vi.mocked(redisSetNX)
const mockRedisDel = vi.mocked(redisDel)
const mockRedisZCard = vi.mocked(redisZCard)
const mockRedisZPopMin = vi.mocked(redisZPopMin)
const mockRedisZRangeByScore = vi.mocked(redisZRangeByScore)
const mockRedisCompareAndRemove = vi.mocked(
  redisCompareAndRemoveSortedHashMember
)
const mockRedisHGet = vi.mocked(redisHGet)
const mockRedisHDel = vi.mocked(redisHDel)
const mockRedisKeys = vi.mocked(redisKeys)
const mockRedisGet = vi.mocked(redisGet)
const mockGetSessionState = vi.mocked(getSessionState)

function makeWork(overrides: Partial<QueuedWork> = {}): QueuedWork {
  return {
    sessionId: 'session-1',
    issueId: 'issue-1',
    issueIdentifier: 'SUP-100',
    priority: 2,
    queuedAt: Date.now(),
    prompt: 'test prompt',
    workType: 'qa',
    ...overrides,
  }
}

describe('clearAllParkedWork', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
  })

  it('returns 0 when Redis is not configured', async () => {
    mockIsRedisConfigured.mockReturnValue(false)
    const result = await clearAllParkedWork('issue-1')
    expect(result).toBe(0)
    expect(mockRedisDel).not.toHaveBeenCalled()
  })

  it('returns 0 when no parked work exists', async () => {
    mockRedisZCard.mockResolvedValue(0)
    const result = await clearAllParkedWork('issue-1')
    expect(result).toBe(0)
    expect(mockRedisDel).not.toHaveBeenCalled()
  })

  it('clears a single parked item', async () => {
    mockRedisZCard.mockResolvedValue(1)
    mockRedisDel.mockResolvedValue(1)

    const result = await clearAllParkedWork('issue-1')
    expect(result).toBe(1)
    expect(mockRedisDel).toHaveBeenCalledWith('issue:pending:issue-1')
    expect(mockRedisDel).toHaveBeenCalledWith('issue:pending:items:issue-1')
  })

  it('clears multiple parked items', async () => {
    mockRedisZCard.mockResolvedValue(3)
    mockRedisDel.mockResolvedValue(1)

    const result = await clearAllParkedWork('issue-1')
    expect(result).toBe(3)
    expect(mockRedisDel).toHaveBeenCalledTimes(2)
  })

  it('promoteNextPendingWork returns null after clear', async () => {
    // First park some work
    vi.mocked(redisZAdd).mockResolvedValue(1)
    vi.mocked(redisHSet).mockResolvedValue(1)
    vi.mocked(redisExpire).mockResolvedValue(true)
    await parkWorkForIssue('issue-1', makeWork())

    // Clear it
    mockRedisZCard.mockResolvedValue(1)
    mockRedisDel.mockResolvedValue(1)
    await clearAllParkedWork('issue-1')

    // Promote should find nothing
    mockRedisZPopMin.mockResolvedValue(null)
    const promoted = await promoteNextPendingWork('issue-1')
    expect(promoted).toBeNull()
  })
})

describe('cleanupStaleLocksWithIdleWorkers — pending startup grace', () => {
  const ISSUE_ID = 'issue-cloud'
  const LOCK_KEY = `issue:lock:${ISSUE_ID}`
  // Mirrors PENDING_LOCK_STARTUP_GRACE_MS in issue-lock.ts (boot budget +
  // post-register first-activity budget). Kept in sync manually.
  const GRACE_MS = 25 * 60 * 1000

  function makeLock(overrides: Partial<IssueLock> = {}): IssueLock {
    return {
      sessionId: 'cloud-session-1',
      workType: 'development',
      workerId: null,
      lockedAt: Date.now(),
      issueIdentifier: 'SUP-200',
      ...overrides,
    }
  }

  function stubSession(status: string) {
    // cleanupStaleLocksWithIdleWorkers only reads `session.status`.
    mockGetSessionState.mockResolvedValue({ status } as never)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
    mockRedisKeys.mockResolvedValue([LOCK_KEY])
    // No parked work to promote → promoteNextPendingWork returns null and never
    // issues its own redisDel, so the only possible redisDel is the lock release.
    mockRedisZPopMin.mockResolvedValue(null)
    mockRedisDel.mockResolvedValue(1)
  })

  it('KEEPS the lock of a freshly-dispatched pending cloud session within the startup grace window', async () => {
    // A cloud session dispatched moments ago: still `pending` while its in-box
    // runner provisions + boots. lockAge ≈ 0 — this is the live mis-reap case.
    mockRedisGet.mockResolvedValue(makeLock({ lockedAt: Date.now() }) as never)
    stubSession('pending')

    const promoted = await cleanupStaleLocksWithIdleWorkers(true)

    // Lock must NOT be released during the startup window.
    expect(mockRedisDel).not.toHaveBeenCalledWith(LOCK_KEY)
    expect(promoted).toBe(0)
  })

  it('STILL reaps a genuinely-stale pending session whose lock is older than the grace window', async () => {
    // A truly-orphaned pending session (its explicit lock release failed): the
    // lock is far older than the startup grace window → must still be reaped.
    mockRedisGet.mockResolvedValue(
      makeLock({ lockedAt: Date.now() - (GRACE_MS + 60_000) }) as never
    )
    stubSession('pending')

    await cleanupStaleLocksWithIdleWorkers(true)

    // Lock IS released — genuine orphan cleanup is preserved.
    expect(mockRedisDel).toHaveBeenCalledWith(LOCK_KEY)
  })

  it('reaps a terminal (completed) holder immediately regardless of lock age', async () => {
    // Terminal holders skip the grace — a fresh lock held by a finished session
    // is still pure waste and released at once.
    mockRedisGet.mockResolvedValue(makeLock({ lockedAt: Date.now() }) as never)
    stubSession('completed')

    await cleanupStaleLocksWithIdleWorkers(true)

    expect(mockRedisDel).toHaveBeenCalledWith(LOCK_KEY)
  })

  it('fails closed before releasing a stale lock when policy throws', async () => {
    mockRedisGet.mockResolvedValue(
      makeLock({ lockedAt: Date.now() - (GRACE_MS + 60_000) }) as never
    )
    stubSession('pending')
    const onRefused = vi.fn()

    await cleanupStaleLocksWithIdleWorkers(true, {
      beforeMutation: vi.fn(async () => {
        throw new Error('policy store unavailable')
      }),
      onRefused,
    })

    expect(mockRedisDel).not.toHaveBeenCalledWith(LOCK_KEY)
    expect(mockRedisZPopMin).not.toHaveBeenCalled()
    expect(onRefused).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'cloud-session-1',
        action: 'stale_lock_release',
      }),
      expect.objectContaining({
        permitted: false,
        code: 'pre_mutation_predicate_failed',
      })
    )
  })
})

describe('cleanupExpiredLocksWithPendingWork — pre-mutation policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsRedisConfigured.mockReturnValue(true)
    mockRedisKeys.mockResolvedValue(['issue:pending:issue-1'])
    mockRedisGet.mockResolvedValue(null)
    mockRedisZCard.mockResolvedValue(1)
    mockRedisZRangeByScore.mockResolvedValue(['qa'])
    mockRedisHGet.mockResolvedValue(JSON.stringify(makeWork()))
    mockRedisSetNX.mockResolvedValue(true)
    mockGetSessionState.mockResolvedValue({
      ...makeWork(),
      trackerSessionId: 'session-1',
      trackerProvider: 'linear',
      providerSessionId: null,
      worktreePath: '/tmp/worktree',
      status: 'pending',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
    } as never)
  })

  it('authorizes the selected pending work before its first mutation', async () => {
    const beforeMutation = vi.fn(async () => ({ permitted: true as const }))

    const promoted = await cleanupExpiredLocksWithPendingWork({
      beforeMutation,
    })

    expect(beforeMutation).toHaveBeenCalledTimes(1)
    expect(beforeMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'expired_lock_promote',
        reason: 'expired_issue_lock',
      })
    )
    expect(mockRedisCompareAndRemove).toHaveBeenCalledWith(
      'issue:pending:issue-1',
      'issue:pending:items:issue-1',
      'qa',
      expect.any(String)
    )
    expect(promoted).toBe(1)
  })

  it('leaves the selected pending work untouched on an empty refusal', async () => {
    const onRefused = vi.fn()

    const promoted = await cleanupExpiredLocksWithPendingWork({
      beforeMutation: vi.fn(async () => ({
        permitted: false as const,
        code: '   ',
      })),
      onRefused,
    })

    expect(promoted).toBe(0)
    expect(mockRedisCompareAndRemove).not.toHaveBeenCalled()
    expect(mockRedisHDel).not.toHaveBeenCalled()
    expect(onRefused).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      expect.objectContaining({
        code: 'pre_mutation_predicate_failed',
      })
    )
  })

  it('does not mutate a same-member replacement after policy approval', async () => {
    mockRedisCompareAndRemove.mockResolvedValue(false)
    const beforeMutation = vi.fn(async () => ({ permitted: true as const }))

    const promoted = await cleanupExpiredLocksWithPendingWork({
      beforeMutation,
    })

    expect(beforeMutation).toHaveBeenCalledTimes(1)
    expect(mockRedisCompareAndRemove).toHaveBeenCalledTimes(1)
    expect(mockRedisSetNX).not.toHaveBeenCalled()
    expect(mockRedisHDel).not.toHaveBeenCalled()
    expect(promoted).toBe(0)
  })
})
