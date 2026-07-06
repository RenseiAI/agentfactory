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
  redisZPopMin: vi.fn(),
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
  cleanupStaleLocksWithIdleWorkers,
  type IssueLock,
} from './issue-lock.js'
import {
  isRedisConfigured,
  redisDel,
  redisZCard,
  redisZPopMin,
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
const mockRedisDel = vi.mocked(redisDel)
const mockRedisZCard = vi.mocked(redisZCard)
const mockRedisZPopMin = vi.mocked(redisZPopMin)
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
})
