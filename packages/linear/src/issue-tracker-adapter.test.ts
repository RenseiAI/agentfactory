import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentSession } from './agent-session.js'
import type { AgentSessionConfig } from './types.js'

// Spy on createAgentSession so we can inspect exactly which client the adapter
// hands to the session. Hoisted so the vi.mock factory can reference it.
const { createAgentSessionSpy } = vi.hoisted(() => ({
  createAgentSessionSpy: vi.fn(
    (_config: AgentSessionConfig) => ({}) as unknown as AgentSession
  ),
}))

vi.mock('./agent-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-session.js')>()
  return {
    ...actual,
    createAgentSession: createAgentSessionSpy,
  }
})

// Imported after vi.mock so the mocked createAgentSession is in effect.
const { LinearIssueTrackerClient } = await import('./issue-tracker-adapter.js')

describe('LinearIssueTrackerClient.createSession — client wiring regression', () => {
  beforeEach(() => {
    createAgentSessionSpy.mockClear()
  })

  it('passes the LinearAgentClient wrapper — not the raw @linear/sdk client — to createAgentSession', () => {
    const client = new LinearIssueTrackerClient({ apiKey: 'test-key' })

    client.createSession({ issueId: 'ISSUE-1', sessionId: 'sess-1' })

    expect(createAgentSessionSpy).toHaveBeenCalledTimes(1)
    const passed = createAgentSessionSpy.mock.calls[0][0]

    // Must be wired to the wrapper itself…
    expect(passed.client).toBe(client.linearClient)
    // …whose surface includes wrapper-only methods such as getIssue(). The raw
    // @linear/sdk client reachable via `.linearClient` has no getIssue and
    // previously caused a runtime crash on session start.
    expect(typeof passed.client.getIssue).toBe('function')
    expect(passed.client).not.toBe(client.linearClient.linearClient)
  })
})
