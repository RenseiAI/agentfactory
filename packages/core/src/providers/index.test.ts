import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  resolveProviderName,
  resolveProviderWithSource,
  resolveProviderWithSourceAsync,
  resolveProviderNameAsync,
  extractProviderFromLabels,
  extractProviderFromMention,
  extractModelFromLabels,
  resolveModelWithSource,
  resolveModel,
  resolveSubAgentModel,
  PROVIDER_ALIASES,
  isValidProviderName,
} from './index.js'
import type { AsyncProviderResolutionContext, ModelsConfig } from './index.js'
import type { PosteriorStore } from '../routing/posterior-store.js'
import type { RoutingConfig, RoutingDecision } from '../routing/types.js'

describe('extractProviderFromLabels', () => {
  it('extracts provider from "provider:<name>" label', () => {
    expect(extractProviderFromLabels(['Bug', 'provider:codex', 'Feature'])).toBe('codex')
  })

  it('returns null when no provider label present', () => {
    expect(extractProviderFromLabels(['Bug', 'Feature'])).toBeNull()
  })

  it('resolves aliases in labels', () => {
    expect(extractProviderFromLabels(['provider:opus'])).toBe('claude')
    expect(extractProviderFromLabels(['provider:sonnet'])).toBe('claude')
    expect(extractProviderFromLabels(['provider:gemini'])).toBe('a2a')
  })

  it('is case-insensitive', () => {
    expect(extractProviderFromLabels(['Provider:Codex'])).toBe('codex')
    expect(extractProviderFromLabels(['PROVIDER:AMP'])).toBe('amp')
  })

  it('ignores invalid provider names', () => {
    expect(extractProviderFromLabels(['provider:invalid'])).toBeNull()
  })

  it('returns first match when multiple provider labels exist', () => {
    expect(extractProviderFromLabels(['provider:codex', 'provider:amp'])).toBe('codex')
  })

  it('handles empty array', () => {
    expect(extractProviderFromLabels([])).toBeNull()
  })
})

describe('extractProviderFromMention', () => {
  it('matches "use <provider>" pattern', () => {
    expect(extractProviderFromMention('please use codex for this')).toBe('codex')
  })

  it('matches "@<provider>" pattern', () => {
    expect(extractProviderFromMention('@codex handle this')).toBe('codex')
  })

  it('matches "provider:<provider>" pattern', () => {
    expect(extractProviderFromMention('run with provider:amp')).toBe('amp')
  })

  it('resolves aliases in mentions', () => {
    expect(extractProviderFromMention('use opus')).toBe('claude')
    expect(extractProviderFromMention('@sonnet')).toBe('claude')
    expect(extractProviderFromMention('provider:gemini')).toBe('a2a')
  })

  it('is case-insensitive', () => {
    expect(extractProviderFromMention('use Codex')).toBe('codex')
    expect(extractProviderFromMention('USE AMP')).toBe('amp')
  })

  it('returns null for invalid provider names', () => {
    expect(extractProviderFromMention('use invalid')).toBeNull()
  })

  it('returns null when no pattern matches', () => {
    expect(extractProviderFromMention('fix the bug in login')).toBeNull()
  })

  it('handles empty string', () => {
    expect(extractProviderFromMention('')).toBeNull()
  })
})

describe('resolveProviderWithSource — full cascade', () => {
  const envBackup: Record<string, string | undefined> = {}

  beforeEach(() => {
    // Save and clear relevant env vars
    for (const key of ['AGENT_PROVIDER', 'AGENT_PROVIDER_QA', 'AGENT_PROVIDER_DEVELOPMENT', 'AGENT_PROVIDER_SOCIAL', 'AGENT_PROVIDER_AGENT']) {
      envBackup[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    // Restore env vars
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('defaults to claude when no context provided', () => {
    const result = resolveProviderWithSource()
    expect(result).toEqual({ name: 'claude', source: 'default' })
  })

  it('1. label overrides everything', () => {
    process.env.AGENT_PROVIDER = 'amp'
    process.env.AGENT_PROVIDER_QA = 'amp'
    const result = resolveProviderWithSource({
      labels: ['provider:codex'],
      mentionContext: 'use amp',
      workType: 'qa',
      project: 'Social',
      configProviders: {
        default: 'amp',
        byWorkType: { qa: 'amp' },
        byProject: { Social: 'amp' },
      },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toContain('label')
  })

  it('2. mention overrides config and env', () => {
    process.env.AGENT_PROVIDER = 'amp'
    const result = resolveProviderWithSource({
      mentionContext: 'use codex',
      workType: 'qa',
      configProviders: { byWorkType: { qa: 'amp' } },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toContain('mention')
  })

  it('3. config byWorkType overrides env and config defaults', () => {
    process.env.AGENT_PROVIDER_QA = 'amp'
    const result = resolveProviderWithSource({
      workType: 'qa',
      configProviders: { byWorkType: { qa: 'codex' }, default: 'amp' },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toContain('config providers.byWorkType.qa')
  })

  it('4. config byProject overrides env vars', () => {
    process.env.AGENT_PROVIDER_SOCIAL = 'amp'
    const result = resolveProviderWithSource({
      project: 'Social',
      configProviders: { byProject: { Social: 'codex' } },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toContain('config providers.byProject.Social')
  })

  it('5. env AGENT_PROVIDER_{WORKTYPE} overrides env project and defaults', () => {
    process.env.AGENT_PROVIDER_QA = 'codex'
    process.env.AGENT_PROVIDER_SOCIAL = 'amp'
    process.env.AGENT_PROVIDER = 'amp'
    const result = resolveProviderWithSource({
      workType: 'qa',
      project: 'Social',
    })
    expect(result.name).toBe('codex')
    expect(result.source).toBe('env AGENT_PROVIDER_QA')
  })

  it('6. env AGENT_PROVIDER_{PROJECT} overrides global default', () => {
    process.env.AGENT_PROVIDER_SOCIAL = 'codex'
    process.env.AGENT_PROVIDER = 'amp'
    const result = resolveProviderWithSource({
      project: 'Social',
    })
    expect(result.name).toBe('codex')
    expect(result.source).toBe('env AGENT_PROVIDER_SOCIAL')
  })

  it('7. config providers.default overrides env AGENT_PROVIDER', () => {
    process.env.AGENT_PROVIDER = 'amp'
    const result = resolveProviderWithSource({
      configProviders: { default: 'codex' },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toBe('config providers.default')
  })

  it('8. env AGENT_PROVIDER overrides hardcoded default', () => {
    process.env.AGENT_PROVIDER = 'codex'
    const result = resolveProviderWithSource()
    expect(result.name).toBe('codex')
    expect(result.source).toBe('env AGENT_PROVIDER')
  })

  it('normalizes work type with hyphens to env var format', () => {
    process.env.AGENT_PROVIDER_REFINEMENT_COORDINATION = 'codex'
    const result = resolveProviderWithSource({ workType: 'refinement-coordination' })
    expect(result.name).toBe('codex')
    expect(result.source).toBe('env AGENT_PROVIDER_REFINEMENT_COORDINATION')
    delete process.env.AGENT_PROVIDER_REFINEMENT_COORDINATION
  })
})

describe('resolveProviderName — backwards compatibility', () => {
  const envBackup: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ['AGENT_PROVIDER', 'AGENT_PROVIDER_QA', 'AGENT_PROVIDER_SOCIAL']) {
      envBackup[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('returns claude by default', () => {
    expect(resolveProviderName()).toBe('claude')
  })

  it('respects old { project, workType } shape', () => {
    process.env.AGENT_PROVIDER_QA = 'codex'
    expect(resolveProviderName({ workType: 'qa' })).toBe('codex')
  })

  it('accepts new ProviderResolutionContext shape', () => {
    expect(resolveProviderName({ labels: ['provider:codex'] })).toBe('codex')
  })
})

describe('PROVIDER_ALIASES', () => {
  it('maps opus to claude', () => {
    expect(PROVIDER_ALIASES['opus']).toBe('claude')
  })

  it('maps sonnet to claude', () => {
    expect(PROVIDER_ALIASES['sonnet']).toBe('claude')
  })

  it('maps gemini to a2a', () => {
    expect(PROVIDER_ALIASES['gemini']).toBe('a2a')
  })

  it('maps codex to codex', () => {
    expect(PROVIDER_ALIASES['codex']).toBe('codex')
  })
})

describe('isValidProviderName', () => {
  it('accepts valid provider names', () => {
    expect(isValidProviderName('claude')).toBe(true)
    expect(isValidProviderName('codex')).toBe(true)
    expect(isValidProviderName('amp')).toBe(true)
    expect(isValidProviderName('spring-ai')).toBe(true)
    expect(isValidProviderName('a2a')).toBe(true)
  })

  it('rejects invalid names', () => {
    expect(isValidProviderName('invalid')).toBe(false)
    expect(isValidProviderName('')).toBe(false)
    expect(isValidProviderName('opus')).toBe(false) // alias, not a provider name
  })
})

// ---------------------------------------------------------------------------
// Async provider resolution (with MAB routing)
// ---------------------------------------------------------------------------

// Mock the routing engine module
vi.mock('../routing/routing-engine.js', () => ({
  selectProvider: vi.fn(),
}))

// Mock the logger to suppress warnings in tests
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

function createMockPosteriorStore(): PosteriorStore {
  return {
    getPosterior: vi.fn(),
    updatePosterior: vi.fn(),
    getAllPosteriors: vi.fn(),
    resetPosterior: vi.fn(),
  }
}

function createMockRoutingConfig(overrides?: Partial<RoutingConfig>): RoutingConfig {
  return {
    enabled: true,
    explorationRate: 0.1,
    windowSize: 100,
    discountFactor: 0.99,
    minObservationsForExploit: 5,
    changeDetectionThreshold: 0.2,
    ...overrides,
  }
}

function createHighConfidenceDecision(provider: 'claude' | 'codex' | 'amp' | 'spring-ai' | 'a2a' = 'codex'): RoutingDecision {
  return {
    selectedProvider: provider,
    confidence: 0.85,
    expectedReward: 0.9,
    source: 'mab-routing',
    alternatives: [],
  }
}

function createLowConfidenceDecision(): RoutingDecision {
  return {
    selectedProvider: 'codex',
    confidence: 0.2,
    expectedReward: 0.5,
    explorationReason: 'uncertainty',
    source: 'mab-routing',
    alternatives: [],
  }
}

describe('resolveProviderWithSourceAsync — full cascade with MAB routing', () => {
  const envBackup: Record<string, string | undefined> = {}

  beforeEach(async () => {
    // Save and clear relevant env vars
    for (const key of ['AGENT_PROVIDER', 'AGENT_PROVIDER_QA', 'AGENT_PROVIDER_DEVELOPMENT', 'AGENT_PROVIDER_SOCIAL', 'AGENT_PROVIDER_AGENT']) {
      envBackup[key] = process.env[key]
      delete process.env[key]
    }
    // Reset the routing engine mock
    const { selectProvider } = await import('../routing/routing-engine.js')
    vi.mocked(selectProvider).mockReset()
  })

  afterEach(() => {
    // Restore env vars
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('10. defaults to claude when no context provided', async () => {
    const result = await resolveProviderWithSourceAsync()
    expect(result).toEqual({ name: 'claude', source: 'default' })
  })

  it('1. label overrides everything including MAB', async () => {
    const { selectProvider } = await import('../routing/routing-engine.js')
    vi.mocked(selectProvider).mockResolvedValue(createHighConfidenceDecision('amp'))

    process.env.AGENT_PROVIDER = 'amp'
    process.env.AGENT_PROVIDER_QA = 'amp'
    const result = await resolveProviderWithSourceAsync({
      labels: ['provider:codex'],
      mentionContext: 'use amp',
      workType: 'qa',
      project: 'Social',
      configProviders: {
        default: 'amp',
        byWorkType: { qa: 'amp' },
        byProject: { Social: 'amp' },
      },
      routingContext: {
        posteriorStore: createMockPosteriorStore(),
        routingConfig: createMockRoutingConfig(),
      },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toContain('label')
  })

  it('2. mention overrides MAB, config, and env', async () => {
    const { selectProvider } = await import('../routing/routing-engine.js')
    vi.mocked(selectProvider).mockResolvedValue(createHighConfidenceDecision('amp'))

    process.env.AGENT_PROVIDER = 'amp'
    const result = await resolveProviderWithSourceAsync({
      mentionContext: 'use codex',
      workType: 'qa',
      configProviders: { byWorkType: { qa: 'amp' } },
      routingContext: {
        posteriorStore: createMockPosteriorStore(),
        routingConfig: createMockRoutingConfig(),
      },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toContain('mention')
  })

  it('3. config byWorkType overrides MAB, env, and config defaults', async () => {
    const { selectProvider } = await import('../routing/routing-engine.js')
    vi.mocked(selectProvider).mockResolvedValue(createHighConfidenceDecision('amp'))

    process.env.AGENT_PROVIDER_QA = 'amp'
    const result = await resolveProviderWithSourceAsync({
      workType: 'qa',
      configProviders: { byWorkType: { qa: 'codex' }, default: 'amp' },
      routingContext: {
        posteriorStore: createMockPosteriorStore(),
        routingConfig: createMockRoutingConfig(),
      },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toContain('config providers.byWorkType.qa')
  })

  it('4. config byProject overrides MAB and env vars', async () => {
    const { selectProvider } = await import('../routing/routing-engine.js')
    vi.mocked(selectProvider).mockResolvedValue(createHighConfidenceDecision('amp'))

    process.env.AGENT_PROVIDER_SOCIAL = 'amp'
    const result = await resolveProviderWithSourceAsync({
      project: 'Social',
      workType: 'qa',
      configProviders: { byProject: { Social: 'codex' } },
      routingContext: {
        posteriorStore: createMockPosteriorStore(),
        routingConfig: createMockRoutingConfig(),
      },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toContain('config providers.byProject.Social')
  })

  it('5. MAB routing selects provider when enabled with high confidence', async () => {
    const { selectProvider } = await import('../routing/routing-engine.js')
    vi.mocked(selectProvider).mockResolvedValue(createHighConfidenceDecision('codex'))

    process.env.AGENT_PROVIDER_QA = 'amp'
    process.env.AGENT_PROVIDER = 'amp'
    const result = await resolveProviderWithSourceAsync({
      workType: 'qa',
      routingContext: {
        posteriorStore: createMockPosteriorStore(),
        routingConfig: createMockRoutingConfig(),
      },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toBe('mab-routing')
  })

  it('5. MAB routing passes available providers and config to selectProvider', async () => {
    const { selectProvider } = await import('../routing/routing-engine.js')
    vi.mocked(selectProvider).mockResolvedValue(createHighConfidenceDecision('amp'))

    const mockStore = createMockPosteriorStore()
    const mockConfig = createMockRoutingConfig({ explorationRate: 0.05 })
    const result = await resolveProviderWithSourceAsync({
      workType: 'development',
      routingContext: {
        posteriorStore: mockStore,
        routingConfig: mockConfig,
        availableProviders: ['claude', 'codex', 'amp'],
      },
    })
    expect(result.name).toBe('amp')
    expect(result.source).toBe('mab-routing')
    expect(vi.mocked(selectProvider)).toHaveBeenCalledWith(
      mockStore,
      'development',
      ['claude', 'codex', 'amp'],
      mockConfig,
    )
  })

  it('5. low-confidence MAB decisions fall through to env var', async () => {
    const { selectProvider } = await import('../routing/routing-engine.js')
    vi.mocked(selectProvider).mockResolvedValue(createLowConfidenceDecision())

    process.env.AGENT_PROVIDER_QA = 'amp'
    const result = await resolveProviderWithSourceAsync({
      workType: 'qa',
      routingContext: {
        posteriorStore: createMockPosteriorStore(),
        routingConfig: createMockRoutingConfig(),
      },
    })
    expect(result.name).toBe('amp')
    expect(result.source).toBe('env AGENT_PROVIDER_QA')
  })

  it('5. MAB errors gracefully fall through to env var', async () => {
    const { selectProvider } = await import('../routing/routing-engine.js')
    vi.mocked(selectProvider).mockRejectedValue(new Error('Redis connection failed'))

    process.env.AGENT_PROVIDER_QA = 'amp'
    const result = await resolveProviderWithSourceAsync({
      workType: 'qa',
      routingContext: {
        posteriorStore: createMockPosteriorStore(),
        routingConfig: createMockRoutingConfig(),
      },
    })
    expect(result.name).toBe('amp')
    expect(result.source).toBe('env AGENT_PROVIDER_QA')
  })

  it('5. MAB tier skipped when routing disabled (default)', async () => {
    const { selectProvider } = await import('../routing/routing-engine.js')

    process.env.AGENT_PROVIDER_QA = 'amp'
    const result = await resolveProviderWithSourceAsync({
      workType: 'qa',
      routingContext: {
        posteriorStore: createMockPosteriorStore(),
        routingConfig: createMockRoutingConfig({ enabled: false }),
      },
    })
    expect(result.name).toBe('amp')
    expect(result.source).toBe('env AGENT_PROVIDER_QA')
    // selectProvider should NOT have been called
    expect(vi.mocked(selectProvider)).not.toHaveBeenCalled()
  })

  it('5. MAB tier skipped when no posteriorStore provided', async () => {
    const { selectProvider } = await import('../routing/routing-engine.js')

    process.env.AGENT_PROVIDER_QA = 'amp'
    const result = await resolveProviderWithSourceAsync({
      workType: 'qa',
      routingContext: {
        routingConfig: createMockRoutingConfig(),
      },
    })
    expect(result.name).toBe('amp')
    expect(result.source).toBe('env AGENT_PROVIDER_QA')
    expect(vi.mocked(selectProvider)).not.toHaveBeenCalled()
  })

  it('5. MAB tier skipped when no workType provided', async () => {
    const { selectProvider } = await import('../routing/routing-engine.js')

    const result = await resolveProviderWithSourceAsync({
      routingContext: {
        posteriorStore: createMockPosteriorStore(),
        routingConfig: createMockRoutingConfig(),
      },
    })
    // Should fall through to hardcoded default
    expect(result.name).toBe('claude')
    expect(result.source).toBe('default')
    expect(vi.mocked(selectProvider)).not.toHaveBeenCalled()
  })

  it('5. MAB tier skipped when no routingContext provided', async () => {
    const { selectProvider } = await import('../routing/routing-engine.js')

    process.env.AGENT_PROVIDER_QA = 'amp'
    const result = await resolveProviderWithSourceAsync({
      workType: 'qa',
    })
    expect(result.name).toBe('amp')
    expect(result.source).toBe('env AGENT_PROVIDER_QA')
    expect(vi.mocked(selectProvider)).not.toHaveBeenCalled()
  })

  it('6. env AGENT_PROVIDER_{WORKTYPE} overrides env project and defaults', async () => {
    process.env.AGENT_PROVIDER_QA = 'codex'
    process.env.AGENT_PROVIDER_SOCIAL = 'amp'
    process.env.AGENT_PROVIDER = 'amp'
    const result = await resolveProviderWithSourceAsync({
      workType: 'qa',
      project: 'Social',
    })
    expect(result.name).toBe('codex')
    expect(result.source).toBe('env AGENT_PROVIDER_QA')
  })

  it('7. env AGENT_PROVIDER_{PROJECT} overrides global default', async () => {
    process.env.AGENT_PROVIDER_SOCIAL = 'codex'
    process.env.AGENT_PROVIDER = 'amp'
    const result = await resolveProviderWithSourceAsync({
      project: 'Social',
    })
    expect(result.name).toBe('codex')
    expect(result.source).toBe('env AGENT_PROVIDER_SOCIAL')
  })

  it('8. config providers.default overrides env AGENT_PROVIDER', async () => {
    process.env.AGENT_PROVIDER = 'amp'
    const result = await resolveProviderWithSourceAsync({
      configProviders: { default: 'codex' },
    })
    expect(result.name).toBe('codex')
    expect(result.source).toBe('config providers.default')
  })

  it('9. env AGENT_PROVIDER overrides hardcoded default', async () => {
    process.env.AGENT_PROVIDER = 'codex'
    const result = await resolveProviderWithSourceAsync()
    expect(result.name).toBe('codex')
    expect(result.source).toBe('env AGENT_PROVIDER')
  })
})

describe('resolveProviderNameAsync — backwards compatibility', () => {
  const envBackup: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ['AGENT_PROVIDER', 'AGENT_PROVIDER_QA', 'AGENT_PROVIDER_SOCIAL']) {
      envBackup[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('returns claude by default', async () => {
    expect(await resolveProviderNameAsync()).toBe('claude')
  })

  it('respects { project, workType } shape', async () => {
    process.env.AGENT_PROVIDER_QA = 'codex'
    expect(await resolveProviderNameAsync({ workType: 'qa' })).toBe('codex')
  })

  it('accepts labels in context', async () => {
    expect(await resolveProviderNameAsync({ labels: ['provider:codex'] })).toBe('codex')
  })

  it('uses MAB routing when configured', async () => {
    const { selectProvider } = await import('../routing/routing-engine.js')
    vi.mocked(selectProvider).mockResolvedValue(createHighConfidenceDecision('amp'))

    const result = await resolveProviderNameAsync({
      workType: 'qa',
      routingContext: {
        posteriorStore: createMockPosteriorStore(),
        routingConfig: createMockRoutingConfig(),
      },
    })
    expect(result).toBe('amp')
  })
})

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

describe('extractModelFromLabels', () => {
  it('extracts model from "model:<id>" label', () => {
    expect(extractModelFromLabels(['Bug', 'model:claude-sonnet-4-6', 'Feature'])).toBe('claude-sonnet-4-6')
  })

  it('returns null when no model label present', () => {
    expect(extractModelFromLabels(['Bug', 'Feature'])).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(extractModelFromLabels(['Model:claude-opus-4-6'])).toBe('claude-opus-4-6')
  })

  it('handles empty array', () => {
    expect(extractModelFromLabels([])).toBeNull()
  })

  it('returns first match when multiple model labels exist', () => {
    expect(extractModelFromLabels(['model:claude-opus-4-6', 'model:claude-sonnet-4-6'])).toBe('claude-opus-4-6')
  })
})

describe('resolveModelWithSource — full cascade', () => {
  const envBackup: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ['AGENT_MODEL', 'AGENT_MODEL_QA', 'AGENT_MODEL_DEVELOPMENT', 'AGENT_MODEL_SOCIAL', 'AGENT_MODEL_AGENT']) {
      envBackup[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('returns undefined (provider default) when no context provided', () => {
    const result = resolveModelWithSource()
    expect(result).toEqual({ model: undefined, source: 'provider-default' })
  })

  it('1. dispatch model overrides everything', () => {
    process.env.AGENT_MODEL = 'claude-haiku-4-5'
    const result = resolveModelWithSource({
      dispatchModel: 'claude-opus-4-6',
      labels: ['model:claude-sonnet-4-6'],
      workType: 'qa',
      project: 'Social',
      configModels: {
        default: 'claude-haiku-4-5',
        byWorkType: { qa: 'claude-haiku-4-5' },
        byProject: { Social: 'claude-haiku-4-5' },
      },
    })
    expect(result.model).toBe('claude-opus-4-6')
    expect(result.source).toBe('dispatch')
  })

  it('2. label overrides config and env', () => {
    process.env.AGENT_MODEL = 'claude-haiku-4-5'
    const result = resolveModelWithSource({
      labels: ['model:claude-opus-4-6'],
      workType: 'qa',
      configModels: { byWorkType: { qa: 'claude-haiku-4-5' } },
    })
    expect(result.model).toBe('claude-opus-4-6')
    expect(result.source).toContain('label')
  })

  it('3. config byWorkType overrides env and config defaults', () => {
    process.env.AGENT_MODEL_QA = 'claude-haiku-4-5'
    const result = resolveModelWithSource({
      workType: 'qa',
      configModels: { byWorkType: { qa: 'claude-opus-4-6' }, default: 'claude-haiku-4-5' },
    })
    expect(result.model).toBe('claude-opus-4-6')
    expect(result.source).toContain('config models.byWorkType.qa')
  })

  it('4. config byProject overrides env vars', () => {
    process.env.AGENT_MODEL_SOCIAL = 'claude-haiku-4-5'
    const result = resolveModelWithSource({
      project: 'Social',
      configModels: { byProject: { Social: 'claude-opus-4-6' } },
    })
    expect(result.model).toBe('claude-opus-4-6')
    expect(result.source).toContain('config models.byProject.Social')
  })

  it('5. env AGENT_MODEL_{WORKTYPE} overrides env project and defaults', () => {
    process.env.AGENT_MODEL_QA = 'claude-opus-4-6'
    process.env.AGENT_MODEL_SOCIAL = 'claude-haiku-4-5'
    process.env.AGENT_MODEL = 'claude-haiku-4-5'
    const result = resolveModelWithSource({
      workType: 'qa',
      project: 'Social',
    })
    expect(result.model).toBe('claude-opus-4-6')
    expect(result.source).toBe('env AGENT_MODEL_QA')
  })

  it('6. env AGENT_MODEL_{PROJECT} overrides global default', () => {
    process.env.AGENT_MODEL_SOCIAL = 'claude-opus-4-6'
    process.env.AGENT_MODEL = 'claude-haiku-4-5'
    const result = resolveModelWithSource({
      project: 'Social',
    })
    expect(result.model).toBe('claude-opus-4-6')
    expect(result.source).toBe('env AGENT_MODEL_SOCIAL')
  })

  it('7. config models.default overrides env AGENT_MODEL', () => {
    process.env.AGENT_MODEL = 'claude-haiku-4-5'
    const result = resolveModelWithSource({
      configModels: { default: 'claude-opus-4-6' },
    })
    expect(result.model).toBe('claude-opus-4-6')
    expect(result.source).toBe('config models.default')
  })

  it('8. env AGENT_MODEL overrides provider default', () => {
    process.env.AGENT_MODEL = 'claude-opus-4-6'
    const result = resolveModelWithSource()
    expect(result.model).toBe('claude-opus-4-6')
    expect(result.source).toBe('env AGENT_MODEL')
  })

  it('normalizes work type with hyphens to env var format', () => {
    process.env.AGENT_MODEL_REFINEMENT_COORDINATION = 'claude-opus-4-6'
    const result = resolveModelWithSource({ workType: 'refinement-coordination' })
    expect(result.model).toBe('claude-opus-4-6')
    expect(result.source).toBe('env AGENT_MODEL_REFINEMENT_COORDINATION')
    delete process.env.AGENT_MODEL_REFINEMENT_COORDINATION
  })
})

describe('resolveModel — convenience wrapper', () => {
  it('returns undefined by default', () => {
    expect(resolveModel()).toBeUndefined()
  })

  it('returns model from dispatch', () => {
    expect(resolveModel({ dispatchModel: 'claude-opus-4-6' })).toBe('claude-opus-4-6')
  })
})

describe('resolveSubAgentModel', () => {
  const envBackup: Record<string, string | undefined> = {}

  beforeEach(() => {
    envBackup.AGENT_SUB_MODEL = process.env.AGENT_SUB_MODEL
    delete process.env.AGENT_SUB_MODEL
  })

  afterEach(() => {
    if (envBackup.AGENT_SUB_MODEL === undefined) {
      delete process.env.AGENT_SUB_MODEL
    } else {
      process.env.AGENT_SUB_MODEL = envBackup.AGENT_SUB_MODEL
    }
  })

  it('returns undefined when no context provided', () => {
    expect(resolveSubAgentModel()).toBeUndefined()
  })

  it('1. dispatch override wins', () => {
    process.env.AGENT_SUB_MODEL = 'claude-haiku-4-5'
    expect(resolveSubAgentModel({
      dispatchSubAgentModel: 'claude-sonnet-4-6',
      configModels: { subAgent: 'claude-haiku-4-5' },
    })).toBe('claude-sonnet-4-6')
  })

  it('2. config models.subAgent overrides env', () => {
    process.env.AGENT_SUB_MODEL = 'claude-haiku-4-5'
    expect(resolveSubAgentModel({
      configModels: { subAgent: 'claude-sonnet-4-6' },
    })).toBe('claude-sonnet-4-6')
  })

  it('3. env AGENT_SUB_MODEL as fallback', () => {
    process.env.AGENT_SUB_MODEL = 'claude-sonnet-4-6'
    expect(resolveSubAgentModel()).toBe('claude-sonnet-4-6')
  })
})
