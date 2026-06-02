/**
 * Tests for the first-class GeminiProvider (gemini-first-class wave C1).
 *
 * Verifies:
 *  1. createProvider('gemini') returns a GeminiProvider — NOT an A2aProvider
 *     (the previous stopgap). The provider's name is 'gemini', not 'a2a'.
 *  2. Declared capabilities mirror the Go native runner (donmai/provider/gemini):
 *     supportsReasoningEffort=true, supportsMessageInjection=true,
 *     supportsSessionResume=false, supportsToolPlugins=true (native tools),
 *     emitsSubagentEvents=false, supportsCodeIntelligenceEnforcement=false.
 *  3. supportsReasoningEffort is true and effort flows through the
 *     effortToGeminiOptions mapping (resolveGeminiThinkingBudget).
 *  4. The provider does NOT masquerade as A2A: spawn/resume surface an explicit
 *     GeminiDelegatedExecutionError (execution is owned by the Go runner), and
 *     the handle is not an A2aAgentHandle.
 */

import { describe, it, expect } from 'vitest'
import { GeminiProvider, createGeminiProvider, resolveGeminiThinkingBudget, GeminiDelegatedExecutionError } from './gemini-provider.js'
import { A2aProvider } from './a2a-provider.js'
import { createProvider } from './index.js'
import { effortToGeminiOptions } from '../config/effort.js'
import type { AgentSpawnConfig, AgentEvent, AgentProviderCapabilities } from './types.js'
import type { EffortLevel } from '../config/profiles.js'

function makeSpawnConfig(overrides: Partial<AgentSpawnConfig> = {}): AgentSpawnConfig {
  return {
    prompt: 'do the thing',
    cwd: '/tmp/work',
    env: {},
    abortController: new AbortController(),
    autonomous: true,
    sandboxEnabled: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. Factory wiring — gemini is its own provider, not aliased to a2a
// ---------------------------------------------------------------------------

describe('createProvider("gemini")', () => {
  it('returns a GeminiProvider instance (not the A2A stopgap)', () => {
    const provider = createProvider('gemini')
    expect(provider).toBeInstanceOf(GeminiProvider)
    expect(provider).not.toBeInstanceOf(A2aProvider)
  })

  it('the provider name is "gemini", not "a2a"', () => {
    expect(createProvider('gemini').name).toBe('gemini')
  })

  it('createGeminiProvider() returns a GeminiProvider', () => {
    expect(createGeminiProvider()).toBeInstanceOf(GeminiProvider)
    expect(createGeminiProvider().name).toBe('gemini')
  })
})

// ---------------------------------------------------------------------------
// 2. Capabilities mirror the Go native runner
// ---------------------------------------------------------------------------

describe('GeminiProvider capabilities', () => {
  const caps = new GeminiProvider().capabilities

  it('supportsReasoningEffort is true (effort → thinkingConfig)', () => {
    expect(caps.supportsReasoningEffort).toBe(true)
  })

  it('supportsMessageInjection is true (runner appends a user turn)', () => {
    expect(caps.supportsMessageInjection).toBe(true)
  })

  it('supportsSessionResume is false (stateless REST endpoint)', () => {
    expect(caps.supportsSessionResume).toBe(false)
  })

  it('supportsToolPlugins is true (native Bash/Read/Edit/Write executor)', () => {
    expect(caps.supportsToolPlugins).toBe(true)
  })

  it('emitsSubagentEvents is false', () => {
    expect(caps.emitsSubagentEvents).toBe(false)
  })

  it('supportsCodeIntelligenceEnforcement is false', () => {
    expect(caps.supportsCodeIntelligenceEnforcement).toBe(false)
  })

  it('humanLabel is "Gemini"', () => {
    expect(caps.humanLabel).toBe('Gemini')
  })

  it('does not declare a Claude-style toolPermissionFormat (gates via functionCallingConfig)', () => {
    // Widen to the interface type: the `as const` capabilities literal omits the
    // optional toolPermissionFormat field entirely, which is exactly the point.
    const widened: AgentProviderCapabilities = caps
    expect(widened.toolPermissionFormat).toBeUndefined()
  })

  it('declares distinct capabilities from A2aProvider (no longer aliased)', () => {
    const a2a = new A2aProvider().capabilities
    // The A2A stopgap declared supportsReasoningEffort=false; Gemini declares true.
    expect(a2a.supportsReasoningEffort).toBe(false)
    expect(caps.supportsReasoningEffort).toBe(true)
    expect(caps.supportsReasoningEffort).not.toBe(a2a.supportsReasoningEffort)
  })
})

// ---------------------------------------------------------------------------
// 3. Effort flows through effortToGeminiOptions
// ---------------------------------------------------------------------------

describe('reasoning-effort flow (resolveGeminiThinkingBudget)', () => {
  const efforts: EffortLevel[] = ['low', 'medium', 'high', 'xhigh']

  for (const effort of efforts) {
    it(`maps effort "${effort}" to the same thinkingBudget as effortToGeminiOptions`, () => {
      const resolved = resolveGeminiThinkingBudget(makeSpawnConfig({ effort }))
      expect(resolved).toEqual(effortToGeminiOptions(effort))
      expect(resolved?.thinkingBudget).toBeGreaterThan(0)
    })
  }

  it('higher effort yields a larger thinkingBudget', () => {
    const low = resolveGeminiThinkingBudget(makeSpawnConfig({ effort: 'low' }))!
    const xhigh = resolveGeminiThinkingBudget(makeSpawnConfig({ effort: 'xhigh' }))!
    expect(xhigh.thinkingBudget).toBeGreaterThan(low.thinkingBudget)
  })

  it('returns undefined when no effort is set (runner uses model-family default)', () => {
    expect(resolveGeminiThinkingBudget(makeSpawnConfig())).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. Honest delegation — no A2A masquerade, explicit error
// ---------------------------------------------------------------------------

async function drain(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const e of stream) events.push(e)
  return events
}

describe('GeminiProvider execution delegation', () => {
  it('spawn() does not throw synchronously and returns a handle named distinctly', () => {
    const provider = new GeminiProvider()
    const handle = provider.spawn(makeSpawnConfig())
    expect(handle).toBeDefined()
    // The handle is NOT an A2aAgentHandle — it surfaces a delegation outcome.
    expect(handle.sessionId).toBeNull()
  })

  it('the stream surfaces an explicit delegated-execution error + failure result', async () => {
    const handle = new GeminiProvider().spawn(makeSpawnConfig())
    const events = await drain(handle.stream)

    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as { code?: string }).code).toBe('gemini_delegated_execution')

    const result = events.find((e) => e.type === 'result')
    expect(result).toBeDefined()
    expect((result as { success: boolean }).success).toBe(false)
    expect((result as { errorSubtype?: string }).errorSubtype).toBe('gemini_delegated_execution')
  })

  it('resume() routes through the same delegation path', async () => {
    const handle = new GeminiProvider().resume('gemini-session-abc', makeSpawnConfig())
    const events = await drain(handle.stream)
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(events.some((e) => e.type === 'result' && e.success === false)).toBe(true)
  })

  it('injectMessage() throws GeminiDelegatedExecutionError (no in-process session to steer)', async () => {
    const handle = new GeminiProvider().spawn(makeSpawnConfig())
    await expect(handle.injectMessage('follow up')).rejects.toBeInstanceOf(GeminiDelegatedExecutionError)
  })

  it('stop() aborts the controller', async () => {
    const ac = new AbortController()
    const handle = new GeminiProvider().spawn(makeSpawnConfig({ abortController: ac }))
    await handle.stop()
    expect(ac.signal.aborted).toBe(true)
  })
})
