/**
 * Tests for REN-1282: AgentRuntimeProvider alias + emitsSubagentEvents capability.
 *
 * Verifies:
 *  1. AgentRuntimeProvider alias is structurally equivalent to AgentProvider.
 *  2. emitsSubagentEvents is true for Claude, false for Codex and Spring AI.
 *  3. humanLabel is present and matches the canonical registry.
 *  4. AGENT_RUNTIME_PROVIDER_HUMAN_LABELS registry covers all provider names.
 *  5. Capability discrepancy detection: warns when observed runtime behaviour
 *     (a subagent event arriving) contradicts the declared flag.
 */

import { describe, it, expect, vi } from 'vitest'
import { ClaudeProvider } from './claude-provider.js'
import { CodexProvider } from './codex-provider.js'
import { SpringAiProvider } from './spring-ai-provider.js'
import { AmpProvider } from './amp-provider.js'
import { A2aProvider } from './a2a-provider.js'
import {
  AGENT_RUNTIME_PROVIDER_HUMAN_LABELS,
} from './index.js'
import type {
  AgentProvider,
  AgentRuntimeProvider,
  AgentProviderCapabilities,
  AgentProviderName,
} from './index.js'

// ---------------------------------------------------------------------------
// 1. AgentRuntimeProvider alias compatibility
// ---------------------------------------------------------------------------

describe('AgentRuntimeProvider alias', () => {
  it('AgentRuntimeProvider is structurally identical to AgentProvider', () => {
    // A ClaudeProvider instance should be assignable to both.
    const provider = new ClaudeProvider()
    // TypeScript assignment is the real check; these assertions guard runtime shape.
    const asProvider: AgentProvider = provider
    const asRuntimeProvider: AgentRuntimeProvider = provider
    expect(asProvider.name).toBe('claude')
    expect(asRuntimeProvider.name).toBe('claude')
    expect(asProvider.capabilities).toBe(asRuntimeProvider.capabilities)
  })

  it('all provider names satisfy AgentProviderName', () => {
    const names: AgentProviderName[] = ['claude', 'codex', 'amp', 'spring-ai', 'a2a']
    expect(names).toHaveLength(5)
  })
})

// ---------------------------------------------------------------------------
// 2. emitsSubagentEvents declarations
// ---------------------------------------------------------------------------

describe('emitsSubagentEvents capability flag', () => {
  it('ClaudeProvider declares emitsSubagentEvents: true', () => {
    const p = new ClaudeProvider()
    expect(p.capabilities.emitsSubagentEvents).toBe(true)
  })

  it('CodexProvider declares emitsSubagentEvents: false (all modes)', () => {
    const p = new CodexProvider()
    // Default state — no probe outcome yet; check the returned object.
    expect(p.capabilities.emitsSubagentEvents).toBe(false)
  })

  it('SpringAiProvider declares emitsSubagentEvents: false', () => {
    const p = new SpringAiProvider()
    expect(p.capabilities.emitsSubagentEvents).toBe(false)
  })

  it('AmpProvider declares emitsSubagentEvents: false', () => {
    const p = new AmpProvider()
    expect(p.capabilities.emitsSubagentEvents).toBe(false)
  })

  it('A2aProvider declares emitsSubagentEvents: false', () => {
    const p = new A2aProvider()
    expect(p.capabilities.emitsSubagentEvents).toBe(false)
  })

  it('only Claude emits subagent events among the core provider set', () => {
    const providers = [
      new ClaudeProvider(),
      new CodexProvider(),
      new SpringAiProvider(),
      new AmpProvider(),
      new A2aProvider(),
    ]
    const emitters = providers.filter((p) => p.capabilities.emitsSubagentEvents)
    const nonEmitters = providers.filter((p) => !p.capabilities.emitsSubagentEvents)
    expect(emitters.map((p) => p.name)).toEqual(['claude'])
    // Use arrayContaining to avoid asserting order (providers array order: codex, spring-ai, amp, a2a)
    expect(nonEmitters.map((p) => p.name)).toEqual(
      expect.arrayContaining(['codex', 'amp', 'spring-ai', 'a2a']),
    )
    expect(nonEmitters).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// 3. humanLabel declarations
// ---------------------------------------------------------------------------

describe('humanLabel capability field', () => {
  it('ClaudeProvider humanLabel is "Claude"', () => {
    expect(new ClaudeProvider().capabilities.humanLabel).toBe('Claude')
  })

  it('CodexProvider humanLabel is "Codex"', () => {
    expect(new CodexProvider().capabilities.humanLabel).toBe('Codex')
  })

  it('SpringAiProvider humanLabel is "Spring AI"', () => {
    expect(new SpringAiProvider().capabilities.humanLabel).toBe('Spring AI')
  })

  it('AmpProvider humanLabel is "Amp"', () => {
    expect(new AmpProvider().capabilities.humanLabel).toBe('Amp')
  })

  it('A2aProvider humanLabel is "A2A"', () => {
    expect(new A2aProvider().capabilities.humanLabel).toBe('A2A')
  })
})

// ---------------------------------------------------------------------------
// 4. AGENT_RUNTIME_PROVIDER_HUMAN_LABELS registry
// ---------------------------------------------------------------------------

describe('AGENT_RUNTIME_PROVIDER_HUMAN_LABELS registry', () => {
  const ALL_PROVIDERS: AgentProviderName[] = ['claude', 'codex', 'amp', 'spring-ai', 'a2a']

  it('contains an entry for every AgentProviderName', () => {
    for (const name of ALL_PROVIDERS) {
      expect(AGENT_RUNTIME_PROVIDER_HUMAN_LABELS[name]).toBeDefined()
      expect(typeof AGENT_RUNTIME_PROVIDER_HUMAN_LABELS[name]).toBe('string')
      expect(AGENT_RUNTIME_PROVIDER_HUMAN_LABELS[name].length).toBeGreaterThan(0)
    }
  })

  it('has exactly the expected provider entries', () => {
    expect(Object.keys(AGENT_RUNTIME_PROVIDER_HUMAN_LABELS)).toEqual(
      expect.arrayContaining(ALL_PROVIDERS),
    )
    expect(Object.keys(AGENT_RUNTIME_PROVIDER_HUMAN_LABELS)).toHaveLength(ALL_PROVIDERS.length)
  })

  it('registry labels match individual provider humanLabel declarations', () => {
    const providerInstances = [
      new ClaudeProvider(),
      new CodexProvider(),
      new SpringAiProvider(),
      new AmpProvider(),
      new A2aProvider(),
    ]
    for (const p of providerInstances) {
      const registryLabel = AGENT_RUNTIME_PROVIDER_HUMAN_LABELS[p.name]
      const declaredLabel = p.capabilities.humanLabel
      // Both should be defined and equal.
      expect(registryLabel).toBeDefined()
      expect(declaredLabel).toBeDefined()
      expect(registryLabel).toBe(declaredLabel)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. Capability discrepancy detection
// ---------------------------------------------------------------------------

/**
 * detectCapabilityDiscrepancy compares a provider's declared capabilities
 * against observed runtime signals and emits a warning if they conflict.
 *
 * This is the detection logic that would live in the orchestrator/runtime.
 * Tested here to verify the contract.
 */
function detectCapabilityDiscrepancy(
  caps: AgentProviderCapabilities,
  observed: { receivedSubagentEvent: boolean },
  warn: (msg: string) => void,
): void {
  if (observed.receivedSubagentEvent && !caps.emitsSubagentEvents) {
    warn(
      `Capability discrepancy: provider declared emitsSubagentEvents=false ` +
        `but a subagent event was observed at runtime. ` +
        `Update the provider's capability declaration.`,
    )
  }
  if (!observed.receivedSubagentEvent && caps.emitsSubagentEvents) {
    // Not a discrepancy — the provider may emit events in future turns.
    // Only warn if the session ended without any event (handled elsewhere).
  }
}

describe('capability discrepancy detection', () => {
  it('warns when a provider declares emitsSubagentEvents=false but an event is observed', () => {
    const warnFn = vi.fn()
    const caps = new CodexProvider().capabilities
    detectCapabilityDiscrepancy(caps, { receivedSubagentEvent: true }, warnFn)
    expect(warnFn).toHaveBeenCalledOnce()
    expect(warnFn.mock.calls[0][0]).toContain('Capability discrepancy')
    expect(warnFn.mock.calls[0][0]).toContain('emitsSubagentEvents=false')
  })

  it('warns for SpringAiProvider with observed subagent event', () => {
    const warnFn = vi.fn()
    detectCapabilityDiscrepancy(
      new SpringAiProvider().capabilities,
      { receivedSubagentEvent: true },
      warnFn,
    )
    expect(warnFn).toHaveBeenCalledOnce()
  })

  it('does not warn when Claude declares true and an event is observed', () => {
    const warnFn = vi.fn()
    detectCapabilityDiscrepancy(
      new ClaudeProvider().capabilities,
      { receivedSubagentEvent: true },
      warnFn,
    )
    expect(warnFn).not.toHaveBeenCalled()
  })

  it('does not warn when Codex declares false and no event is observed', () => {
    const warnFn = vi.fn()
    detectCapabilityDiscrepancy(
      new CodexProvider().capabilities,
      { receivedSubagentEvent: false },
      warnFn,
    )
    expect(warnFn).not.toHaveBeenCalled()
  })

  it('does not warn when Claude declares true but no event observed yet (session in progress)', () => {
    const warnFn = vi.fn()
    detectCapabilityDiscrepancy(
      new ClaudeProvider().capabilities,
      { receivedSubagentEvent: false },
      warnFn,
    )
    expect(warnFn).not.toHaveBeenCalled()
  })
})
