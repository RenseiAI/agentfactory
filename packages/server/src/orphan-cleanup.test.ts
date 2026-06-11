import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all dependencies
vi.mock('./logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('./session-storage.js', () => ({
  getAllSessions: vi.fn(() => []),
  getSessionState: vi.fn(() => null),
  resetSessionForRequeue: vi.fn(() => true),
  updateSessionStatus: vi.fn(() => true),
}))

vi.mock('./worker-storage.js', () => ({
  listWorkers: vi.fn(() => []),
}))

vi.mock('./work-queue.js', () => ({
  releaseClaim: vi.fn(),
  isSessionInQueue: vi.fn(() => false),
  getClaimOwner: vi.fn(() => null),
}))

vi.mock('./issue-lock.js', () => ({
  dispatchWork: vi.fn(() => ({ dispatched: true, parked: false, replaced: false })),
  cleanupExpiredLocksWithPendingWork: vi.fn(() => 0),
  cleanupStaleLocksWithIdleWorkers: vi.fn(() => 0),
  isSessionParkedForIssue: vi.fn(() => false),
  getIssueLock: vi.fn(() => null),
  releaseIssueLock: vi.fn(),
}))

// Liveness probes read the heartbeat pointer via redisGet; default to "no
// pointer" (dead). The session-heartbeat module only contributes the pure
// key-builder, so it needs no mock.
vi.mock('./redis.js', () => ({
  redisGet: vi.fn(async () => null),
}))

import {
  cleanupOrphanedSessions,
  findStrandedDispatchRows,
  findZombiePendingSessions,
} from './orphan-cleanup.js'
import {
  getAllSessions,
  getSessionState,
  resetSessionForRequeue,
  updateSessionStatus,
  type AgentSessionState,
} from './session-storage.js'
import { dispatchWork } from './issue-lock.js'
import { getClaimOwner, isSessionInQueue } from './work-queue.js'
import { isSessionParkedForIssue } from './issue-lock.js'
import { redisGet } from './redis.js'
import { heartbeatRedisKey } from './session-heartbeat.js'

const mockGetAllSessions = vi.mocked(getAllSessions)
const mockGetSessionState = vi.mocked(getSessionState)
const mockResetSessionForRequeue = vi.mocked(resetSessionForRequeue)
const mockUpdateSessionStatus = vi.mocked(updateSessionStatus)
const mockDispatchWork = vi.mocked(dispatchWork)
const mockGetClaimOwner = vi.mocked(getClaimOwner)
const mockIsSessionInQueue = vi.mocked(isSessionInQueue)
const mockIsSessionParkedForIssue = vi.mocked(isSessionParkedForIssue)
const mockRedisGet = vi.mocked(redisGet)

const TEN_MINUTES_AGO = () => Date.now() - 10 * 60_000

function makeSession(
  overrides: Partial<AgentSessionState> = {}
): AgentSessionState {
  return {
    trackerSessionId: 'tracker-1',
    trackerProvider: 'linear',
    issueId: 'issue-1',
    issueIdentifier: 'ABC-123',
    providerSessionId: null,
    worktreePath: '/tmp/worktree',
    status: 'pending',
    createdAt: TEN_MINUTES_AGO(),
    updatedAt: TEN_MINUTES_AGO(),
    rowSessionId: 'tracker-1',
    ...overrides,
  }
}

/** A per-dispatch alias row: stored under its own key, pointing at a shared tracker session */
function makeAliasRow(
  overrides: Partial<AgentSessionState> = {}
): AgentSessionState {
  return makeSession({
    rowSessionId: 'dispatch-uuid-1',
    trackerSessionId: 'tracker-shared',
    ...overrides,
  })
}

describe('findStrandedDispatchRows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns stale non-terminal alias rows', async () => {
    const alias = makeAliasRow()
    mockGetAllSessions.mockResolvedValue([alias])

    const stranded = await findStrandedDispatchRows()

    expect(stranded).toEqual([alias])
  })

  it('ignores rows whose own id matches the tracker session id', async () => {
    mockGetAllSessions.mockResolvedValue([makeSession()])

    expect(await findStrandedDispatchRows()).toEqual([])
  })

  it('ignores alias rows already in a terminal status', async () => {
    mockGetAllSessions.mockResolvedValue([makeAliasRow({ status: 'stopped' })])

    expect(await findStrandedDispatchRows()).toEqual([])
  })

  it('ignores fresh alias rows within the grace period', async () => {
    mockGetAllSessions.mockResolvedValue([
      makeAliasRow({ updatedAt: Date.now() }),
    ])

    expect(await findStrandedDispatchRows()).toEqual([])
  })
})

describe('findZombiePendingSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('excludes per-dispatch alias rows from the zombie list', async () => {
    mockGetAllSessions.mockResolvedValue([makeAliasRow()])

    expect(await findZombiePendingSessions()).toEqual([])
  })

  it('still detects genuine zombie pending sessions', async () => {
    const zombie = makeSession()
    mockGetAllSessions.mockResolvedValue([zombie])

    expect(await findZombiePendingSessions()).toEqual([zombie])
  })
})

describe('cleanupOrphanedSessions — stranded per-dispatch rows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetAllSessions.mockResolvedValue([])
    mockGetSessionState.mockResolvedValue(null)
    mockUpdateSessionStatus.mockResolvedValue(true)
    mockDispatchWork.mockResolvedValue({
      dispatched: true,
      parked: false,
      replaced: false,
    })
    // Default: no liveness anywhere (no heartbeat pointer, no claim, not
    // queued, not parked) — so a stale candidate IS a true strand unless a
    // test arranges otherwise.
    mockRedisGet.mockResolvedValue(null)
    mockGetClaimOwner.mockResolvedValue(null)
    mockIsSessionInQueue.mockResolvedValue(false)
    mockIsSessionParkedForIssue.mockResolvedValue(false)
  })

  it('terminal-marks a true-stranded alias row under its OWN key (no liveness, tracker terminal)', async () => {
    const alias = makeAliasRow()
    mockGetAllSessions.mockResolvedValue([alias])
    mockGetSessionState.mockResolvedValue(
      makeSession({
        trackerSessionId: 'tracker-shared',
        rowSessionId: 'tracker-shared',
        status: 'completed',
      })
    )

    const result = await cleanupOrphanedSessions()

    expect(mockGetSessionState).toHaveBeenCalledWith('tracker-shared')
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(
      'dispatch-uuid-1',
      'stopped',
      { stoppedReason: expect.stringContaining('completed') }
    )
    expect(mockDispatchWork).not.toHaveBeenCalled()
    expect(result.terminalMarked).toBe(1)
    expect(result.requeued).toBe(0)
    expect(result.details).toEqual([
      expect.objectContaining({
        sessionId: 'dispatch-uuid-1',
        action: 'terminal-marked',
      }),
    ])
  })

  it('terminal-marks a true-stranded alias row when the tracker session no longer exists', async () => {
    mockGetAllSessions.mockResolvedValue([makeAliasRow()])
    mockGetSessionState.mockResolvedValue(null)

    const result = await cleanupOrphanedSessions()

    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(
      'dispatch-uuid-1',
      'stopped',
      { stoppedReason: expect.stringContaining('no longer exists') }
    )
    expect(mockDispatchWork).not.toHaveBeenCalled()
    expect(result.terminalMarked).toBe(1)
  })

  // ── Regression guards: never reap a live session ──────────────────────────

  it('NEVER reaps a live long-running alias row — survives a stale updatedAt when a heartbeat pointer is fresh', async () => {
    // A real agent running for 10+ minutes: its row updatedAt is stale (the
    // lifecycle no longer touches it under this id), so it passes the cheap
    // candidate pre-filter — but its heartbeat pointer was emitted seconds ago.
    const alias = makeAliasRow({ status: 'running', updatedAt: TEN_MINUTES_AGO() })
    mockGetAllSessions.mockResolvedValue([alias])
    // Tracker row was NEVER written under the shared id (the exact prod shape):
    mockGetSessionState.mockResolvedValue(null)
    // Live heartbeat pointer under the ROW's own id (where the runner heartbeats).
    mockRedisGet.mockImplementation(async (key: string) => {
      if (key === heartbeatRedisKey('dispatch-uuid-1')) {
        return {
          sessionId: 'dispatch-uuid-1',
          workerId: 'wkr-alive',
          emittedAt: Date.now() - 3_000, // 3s ago — fresh
        }
      }
      return null
    })

    const result = await cleanupOrphanedSessions()

    expect(mockUpdateSessionStatus).not.toHaveBeenCalled()
    expect(mockDispatchWork).not.toHaveBeenCalled()
    expect(mockResetSessionForRequeue).not.toHaveBeenCalled()
    expect(result.terminalMarked).toBe(0)
    expect(result.orphaned).toBe(0)
  })

  it('survives indefinitely while heartbeats keep arriving — repeated passes never reap a heartbeating row', async () => {
    const alias = makeAliasRow({ status: 'running', updatedAt: TEN_MINUTES_AGO() })
    mockGetAllSessions.mockResolvedValue([alias])
    mockGetSessionState.mockResolvedValue(null)
    // Every pass sees a fresh pointer (the worker keeps heartbeating).
    mockRedisGet.mockImplementation(async (key: string) =>
      key === heartbeatRedisKey('dispatch-uuid-1')
        ? { sessionId: 'dispatch-uuid-1', workerId: 'wkr-alive', emittedAt: Date.now() }
        : null
    )

    for (let pass = 0; pass < 5; pass++) {
      const result = await cleanupOrphanedSessions()
      expect(result.terminalMarked).toBe(0)
    }
    expect(mockUpdateSessionStatus).not.toHaveBeenCalled()
  })

  it('NEVER reaps an alias row whose tracker id holds the live heartbeat (runner heartbeats under the tracker id)', async () => {
    const alias = makeAliasRow({ status: 'running', updatedAt: TEN_MINUTES_AGO() })
    mockGetAllSessions.mockResolvedValue([alias])
    mockGetSessionState.mockResolvedValue(null)
    mockRedisGet.mockImplementation(async (key: string) =>
      key === heartbeatRedisKey('tracker-shared')
        ? { sessionId: 'tracker-shared', workerId: 'wkr-alive', emittedAt: Date.now() }
        : null
    )

    const result = await cleanupOrphanedSessions()

    expect(mockUpdateSessionStatus).not.toHaveBeenCalled()
    expect(result.terminalMarked).toBe(0)
  })

  it('NEVER reaps an alias row that still holds a live work-claim', async () => {
    const alias = makeAliasRow({ status: 'claimed', updatedAt: TEN_MINUTES_AGO() })
    mockGetAllSessions.mockResolvedValue([alias])
    mockGetSessionState.mockResolvedValue(null)
    // No heartbeat, but a worker holds the claim.
    mockGetClaimOwner.mockResolvedValue('wkr-claimed')

    const result = await cleanupOrphanedSessions()

    expect(mockUpdateSessionStatus).not.toHaveBeenCalled()
    expect(result.terminalMarked).toBe(0)
  })

  it('ignores a stale (expired-but-present) heartbeat pointer and reaps the true strand', async () => {
    // Pointer present but emittedAt is well past the live threshold → dead.
    const alias = makeAliasRow({ status: 'running', updatedAt: TEN_MINUTES_AGO() })
    mockGetAllSessions.mockResolvedValue([alias])
    mockGetSessionState.mockResolvedValue(null)
    mockRedisGet.mockImplementation(async (key: string) =>
      key === heartbeatRedisKey('dispatch-uuid-1')
        ? { sessionId: 'dispatch-uuid-1', workerId: 'wkr-dead', emittedAt: TEN_MINUTES_AGO() }
        : null
    )

    const result = await cleanupOrphanedSessions()

    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(
      'dispatch-uuid-1',
      'stopped',
      { stoppedReason: expect.stringContaining('no live worker') }
    )
    expect(result.terminalMarked).toBe(1)
  })

  it('reaps a TRUE orphan alias row — no heartbeat, no claim, not queued, not parked (the original phantom case)', async () => {
    // The original phantom scenario: dispatch died before the runner started, so
    // the row never got a heartbeat, the claim TTL'd out, and the tracker row
    // was never written. This is a genuine strand and MUST still be reaped.
    mockGetAllSessions.mockResolvedValue([
      makeAliasRow({ status: 'pending', updatedAt: TEN_MINUTES_AGO() }),
    ])
    mockGetSessionState.mockResolvedValue(null)

    const result = await cleanupOrphanedSessions()

    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(
      'dispatch-uuid-1',
      'stopped',
      { stoppedReason: expect.stringContaining('no longer exists') }
    )
    expect(mockDispatchWork).not.toHaveBeenCalled()
    expect(result.terminalMarked).toBe(1)
  })

  it('never re-queues a running alias row as an orphan, even with no active worker', async () => {
    mockGetAllSessions.mockResolvedValue([
      makeAliasRow({ status: 'running', workerId: 'wkr-dead' }),
    ])
    mockGetSessionState.mockResolvedValue(null)

    const result = await cleanupOrphanedSessions()

    expect(mockResetSessionForRequeue).not.toHaveBeenCalled()
    expect(mockDispatchWork).not.toHaveBeenCalled()
    // No liveness signal → stranded sweep reconciles it terminally
    expect(mockUpdateSessionStatus).toHaveBeenCalledWith(
      'dispatch-uuid-1',
      'stopped',
      { stoppedReason: expect.any(String) }
    )
    expect(result.orphaned).toBe(0)
    expect(result.terminalMarked).toBe(1)
  })

  it('still re-dispatches genuine zombie pending sessions', async () => {
    mockGetAllSessions.mockResolvedValue([makeSession()])

    const result = await cleanupOrphanedSessions()

    expect(mockDispatchWork).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'tracker-1', issueId: 'issue-1' })
    )
    expect(mockUpdateSessionStatus).not.toHaveBeenCalled()
    expect(result.requeued).toBe(1)
    expect(result.terminalMarked).toBe(0)
  })
})
