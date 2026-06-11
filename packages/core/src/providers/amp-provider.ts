/**
 * AmpCode (Sourcegraph Amp) Agent Provider (Stub)
 *
 * Will wrap @sourcegraph/amp-sdk to implement the AgentProvider interface.
 * Currently a placeholder — install the SDK and implement when ready.
 *
 * Expected SDK pattern:
 *   import { execute } from '@sourcegraph/amp-sdk'
 *   const stream = execute({ prompt, cwd, ... })
 *   for await (const msg of stream) { ... }
 *   // resume: execute({ continue: threadId })
 */

import type {
  AgentProvider,
  AgentSpawnConfig,
  AgentHandle,
} from './types.js'

export class AmpProvider implements AgentProvider {
  readonly name = 'amp' as const
  readonly capabilities = {
    supportsMessageInjection: false,
    supportsSessionResume: false,
    supportsToolPlugins: false,
    needsBaseInstructions: false,
    needsPermissionConfig: false,
    supportsCodeIntelligenceEnforcement: false,
    emitsSubagentEvents: false,
    // Amp provider is a stub; no reasoning-effort plumbing yet.
    supportsReasoningEffort: false,
    humanLabel: 'Amp',
  } as const

  spawn(_config: AgentSpawnConfig): AgentHandle {
    throw new Error(
      'Amp provider is not yet implemented. Install @sourcegraph/amp-sdk and implement AmpProvider.'
    )
  }

  resume(_sessionId: string, _config: AgentSpawnConfig): AgentHandle {
    throw new Error(
      'Amp provider is not yet implemented. Install @sourcegraph/amp-sdk and implement AmpProvider.'
    )
  }
}

export function createAmpProvider(): AmpProvider {
  return new AmpProvider()
}
