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
}))

vi.mock('./issue-lock.js', () => ({
  dispatchWork: vi.fn(() => ({ dispatched: true, parked: false, replaced: false })),
  cleanupExpiredLocksWithPendingWork: vi.fn(() => 0),
  cleanupStaleLocksWithIdleWorkers: vi.fn(() => 0),
  isSessionParkedForIssue: vi.fn(() => false),
  getIssueLock: vi.fn(() => null),
  releaseIssueLock: vi.fn(),
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

const mockGetAllSessions = vi.mocked(getAllSessions)
const mockGetSessionState = vi.mocked(getSessionState)
const mockResetSessionForRequeue = vi.mocked(resetSessionForRequeue)
const mockUpdateSessionStatus = vi.mocked(updateSessionStatus)
const mockDispatchWork = vi.mocked(dispatchWork)

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
  })

  it('terminal-marks a stranded alias row under its OWN key when the tracker session is terminal', async () => {
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

  it('terminal-marks a stranded alias row when the tracker session no longer exists', async () => {
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

  it('leaves a stranded alias row alone while the tracker session is still active', async () => {
    mockGetAllSessions.mockResolvedValue([makeAliasRow()])
    mockGetSessionState.mockResolvedValue(
      makeSession({
        trackerSessionId: 'tracker-shared',
        rowSessionId: 'tracker-shared',
        status: 'running',
      })
    )

    const result = await cleanupOrphanedSessions()

    expect(mockUpdateSessionStatus).not.toHaveBeenCalled()
    expect(mockDispatchWork).not.toHaveBeenCalled()
    expect(result.terminalMarked).toBe(0)
  })

  it('never re-queues a running alias row as an orphan, even with no active worker', async () => {
    mockGetAllSessions.mockResolvedValue([
      makeAliasRow({ status: 'running', workerId: 'wkr-dead' }),
    ])
    mockGetSessionState.mockResolvedValue(null)

    const result = await cleanupOrphanedSessions()

    expect(mockResetSessionForRequeue).not.toHaveBeenCalled()
    expect(mockDispatchWork).not.toHaveBeenCalled()
    // Stranded sweep still reconciles it terminally
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
