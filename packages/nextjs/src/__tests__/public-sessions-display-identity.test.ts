import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Display-identity regression tests for the public sessions handlers.
 *
 * Per-dispatch session rows can alias one shared tracker session
 * (rowSessionId !== trackerSessionId). Hashing trackerSessionId rendered
 * all of them as N duplicates of the same public id; the public id must be
 * derived from the row's OWN id instead.
 */

vi.mock('@donmai/server', () => ({
  getAllSessions: vi.fn(() => []),
  isSessionInQueue: vi.fn(() => false),
  hashSessionId: vi.fn((id: string) => `hash(${id})`),
  isValidPublicId: vi.fn(() => true),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { getAllSessions, type AgentSessionState } from '@donmai/server'
import { createPublicSessionsListHandler } from '../handlers/public/sessions-list.js'

const mockGetAllSessions = vi.mocked(getAllSessions)

function makeSession(
  overrides: Partial<AgentSessionState> = {}
): AgentSessionState {
  const now = Date.now()
  return {
    trackerSessionId: 'tracker-shared',
    trackerProvider: 'linear',
    issueId: 'issue-1',
    issueIdentifier: 'ABC-123',
    providerSessionId: null,
    worktreePath: '/tmp/worktree',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    rowSessionId: 'tracker-shared',
    ...overrides,
  }
}

describe('public sessions list display identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('gives per-dispatch rows aliasing one tracker session distinct public ids', async () => {
    mockGetAllSessions.mockResolvedValue([
      makeSession({ rowSessionId: 'dispatch-uuid-1' }),
      makeSession({ rowSessionId: 'dispatch-uuid-2' }),
      makeSession({ rowSessionId: 'tracker-shared' }),
    ])

    const handler = createPublicSessionsListHandler()
    const response = await handler()
    const body = (await response.json()) as {
      sessions: Array<{ id: string }>
    }

    const ids = body.sessions.map((s) => s.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids).toContain('hash(dispatch-uuid-1)')
    expect(ids).toContain('hash(dispatch-uuid-2)')
    expect(ids).toContain('hash(tracker-shared)')
  })

  it('falls back to trackerSessionId when rowSessionId is absent', async () => {
    mockGetAllSessions.mockResolvedValue([
      makeSession({ rowSessionId: undefined }),
    ])

    const handler = createPublicSessionsListHandler()
    const response = await handler()
    const body = (await response.json()) as {
      sessions: Array<{ id: string }>
    }

    expect(body.sessions[0]!.id).toBe('hash(tracker-shared)')
  })
})
