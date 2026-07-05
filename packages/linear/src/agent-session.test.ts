import { describe, it, expect, vi } from 'vitest'
import { createAgentSession } from './agent-session.js'
import type { LinearAgentClient } from './agent-client.js'

/**
 * Minimal Linear SDK Issue stub — just enough for AgentSession.start().
 */
function mockIssue() {
  return {
    id: 'issue-uuid-1',
    identifier: 'SUP-1',
    get state() {
      return Promise.resolve({ name: 'Backlog' })
    },
  }
}

describe('AgentSession.start — client wiring regression', () => {
  it('loads the issue through the LinearAgentClient wrapper getIssue()', async () => {
    const getIssue = vi.fn().mockResolvedValue(mockIssue())
    const wrapper = {
      getIssue,
      updateIssueStatus: vi.fn().mockResolvedValue(undefined),
    } as unknown as LinearAgentClient

    const session = createAgentSession({
      client: wrapper,
      issueId: 'SUP-1',
      autoTransition: false,
    })

    const result = await session.start()

    expect(result.success).toBe(true)
    expect(getIssue).toHaveBeenCalledWith('SUP-1')
  })

  it('reproduces the crash when handed a raw @linear/sdk client (issue(), no getIssue())', async () => {
    // The raw @linear/sdk LinearClient exposes issue()/issues(), never
    // getIssue(). Passing it where a LinearAgentClient wrapper is required is
    // the original "this.client.getIssue is not a function" defect that aborted
    // the SDLC agent session before any work was done.
    const rawSdkClient = {
      issue: vi.fn().mockResolvedValue(mockIssue()),
    } as unknown as LinearAgentClient

    const session = createAgentSession({
      client: rawSdkClient,
      issueId: 'SUP-1',
      autoTransition: false,
    })

    await expect(session.start()).rejects.toThrow(/getIssue is not a function/)
  })
})
