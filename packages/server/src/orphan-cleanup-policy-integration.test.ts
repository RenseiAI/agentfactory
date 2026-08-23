import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('./session-storage.js', () => ({
  getAllSessions: vi.fn(),
  getSessionState: vi.fn(),
  resetSessionForRequeue: vi.fn(),
  updateSessionStatus: vi.fn(),
}))

vi.mock('./worker-storage.js', () => ({
  listWorkers: vi.fn(),
}))

vi.mock('./work-queue.js', () => ({
  releaseClaim: vi.fn(),
  isSessionInQueue: vi.fn(() => false),
  getClaimOwner: vi.fn(() => null),
  queueWork: vi.fn(() => true),
}))

vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => true),
  redisSetNX: vi.fn(() => true),
  redisGet: vi.fn(),
  redisDel: vi.fn(() => 1),
  redisExpire: vi.fn(() => true),
  redisSet: vi.fn(),
  redisZAdd: vi.fn(() => 1),
  redisZRem: vi.fn(() => 1),
  redisZRangeByScore: vi.fn(() => []),
  redisZPopMin: vi.fn(() => null),
  redisCompareAndRemoveSortedHashMember: vi.fn(() => true),
  redisZCard: vi.fn(() => 0),
  redisHSet: vi.fn(() => 1),
  redisHGet: vi.fn(() => null),
  redisHDel: vi.fn(() => 1),
  redisHGetAll: vi.fn(),
  redisKeys: vi.fn(),
}))

import { cleanupOrphanedSessions } from './orphan-cleanup.js'
import {
  getAllSessions,
  getSessionState,
  resetSessionForRequeue,
  updateSessionStatus,
  type AgentSessionState,
} from './session-storage.js'
import { listWorkers } from './worker-storage.js'
import { queueWork, releaseClaim } from './work-queue.js'
import {
  redisCompareAndRemoveSortedHashMember,
  redisDel,
  redisGet,
  redisHGetAll,
  redisKeys,
} from './redis.js'

const mockGetAllSessions = vi.mocked(getAllSessions)
const mockGetSessionState = vi.mocked(getSessionState)
const mockListWorkers = vi.mocked(listWorkers)
const mockRedisGet = vi.mocked(redisGet)
const mockRedisHGetAll = vi.mocked(redisHGetAll)
const mockRedisKeys = vi.mocked(redisKeys)

describe('orphan cleanup policy across real issue-lock maintenance', () => {
  const issueId = 'issue-1'
  const session: AgentSessionState = {
    trackerSessionId: 'zombie-session',
    trackerProvider: 'linear',
    issueId,
    issueIdentifier: 'ABC-123',
    providerSessionId: null,
    worktreePath: '/tmp/worktree',
    status: 'pending',
    createdAt: Date.now() - 30 * 60_000,
    updatedAt: Date.now() - 30 * 60_000,
    rowSessionId: 'zombie-session',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAllSessions.mockResolvedValue([session])
    mockGetSessionState.mockResolvedValue(session)
    mockListWorkers.mockResolvedValue([
      {
        id: 'idle-worker',
        status: 'active',
        activeCount: 0,
        capacity: 1,
      } as never,
    ])
    mockRedisKeys.mockImplementation(async (pattern: string) =>
      pattern === 'issue:lock:*' ? [`issue:lock:${issueId}`] : []
    )
    mockRedisGet.mockImplementation(async (key: string) =>
      key === `issue:lock:${issueId}`
        ? {
            sessionId: session.trackerSessionId,
            workType: 'development',
            workerId: null,
            lockedAt: Date.now() - 26 * 60_000,
            issueIdentifier: session.issueIdentifier,
          }
        : null
    )
    // A sibling is parked for the same issue, but the zombie itself is not.
    mockRedisHGetAll.mockResolvedValue({
      qa: JSON.stringify({
        sessionId: 'parked-sibling',
        issueId,
        issueIdentifier: session.issueIdentifier,
        priority: 2,
        queuedAt: Date.now(),
        workType: 'qa',
      }),
    })
  })

  it('does not release or promote after refusing a >25m pending zombie', async () => {
    const beforeMutation = vi.fn(async () => ({
      permitted: false as const,
      code: 'restart_fence_held',
      detail: 'planned restart',
    }))

    const result = await cleanupOrphanedSessions({ beforeMutation })

    // The later real stale-lock sweep reuses the refusal for this lifecycle
    // identity instead of invoking policy twice or releasing the old lock.
    expect(beforeMutation).toHaveBeenCalledTimes(1)
    expect(beforeMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        session,
        action: 'zombie_redispatch',
        reason: 'pending_unqueued',
      })
    )
    expect(redisDel).not.toHaveBeenCalled()
    expect(redisCompareAndRemoveSortedHashMember).not.toHaveBeenCalled()
    expect(queueWork).not.toHaveBeenCalled()
    expect(releaseClaim).not.toHaveBeenCalled()
    expect(resetSessionForRequeue).not.toHaveBeenCalled()
    expect(updateSessionStatus).not.toHaveBeenCalled()
    expect(result.refused).toBe(1)
    expect(result.details).toContainEqual(
      expect.objectContaining({
        sessionId: 'zombie-session',
        action: 'refused',
        refusalCode: 'restart_fence_held',
      })
    )
  })

  it('deduplicates one executor refusal across zombie and stale-lock paths', async () => {
    const executeMutation = vi.fn(async () => ({
      permitted: false as const,
      code: 'restart_fence_held',
      detail: 'planned restart',
    }))

    const result = await cleanupOrphanedSessions({ executeMutation })

    expect(executeMutation).toHaveBeenCalledTimes(1)
    expect(executeMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        session,
        action: 'zombie_redispatch',
        reason: 'pending_unqueued',
      }),
      expect.any(Function)
    )
    expect(redisDel).not.toHaveBeenCalled()
    expect(redisCompareAndRemoveSortedHashMember).not.toHaveBeenCalled()
    expect(queueWork).not.toHaveBeenCalled()
    expect(releaseClaim).not.toHaveBeenCalled()
    expect(resetSessionForRequeue).not.toHaveBeenCalled()
    expect(updateSessionStatus).not.toHaveBeenCalled()
    expect(result.refused).toBe(1)
    expect(result.details).toContainEqual(
      expect.objectContaining({
        sessionId: 'zombie-session',
        action: 'refused',
        refusalCode: 'restart_fence_held',
      })
    )
  })
})
