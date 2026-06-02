import { describe, it, expect, vi } from 'vitest'
import {
  betaMean,
  betaVariance,
  betaSample,
  selectProvider,
  DEFAULT_ROUTING_CONFIG,
} from './routing-engine.js'
import type { PosteriorStore } from './posterior-store.js'
import type { RoutingPosterior, RoutingConfig } from './types.js'
import type { AgentProviderName } from '../providers/types.js'
import type { AgentWorkType } from '../orchestrator/work-types.js'

function makePosterior(overrides: Partial<RoutingPosterior> = {}): RoutingPosterior {
  return {
    provider: 'claude',
    workType: 'development',
    alpha: 1,
    beta: 1,
    totalObservations: 0,
    avgReward: 0,
    avgCostUsd: 0,
    lastUpdated: Date.now(),
    ...overrides,
  }
}

function makeMockStore(posteriors: Record<string, RoutingPosterior>): PosteriorStore {
  return {
    getPosterior: vi.fn(async (provider: AgentProviderName, workType: AgentWorkType) => {
      const key = `${provider}:${workType}`
      return posteriors[key] ?? makePosterior({ provider, workType })
    }),
    updatePosterior: vi.fn(async () => makePosterior()),
    getAllPosteriors: vi.fn(async () => Object.values(posteriors)),
    resetPosterior: vi.fn(async () => {}),
  }
}

/**
 * Create a deterministic RNG from a seed using a simple LCG.
 * This allows reproducible tests.
 */
function seededRng(seed: number): () => number {
  let state = seed
  return () => {
    // LCG parameters (Numerical Recipes)
    state = (state * 1664525 + 1013904223) & 0xffffffff
    return (state >>> 0) / 0x100000000
  }
}

describe('betaMean', () => {
  it('returns correct mean for Beta(1,1) = 0.5', () => {
    expect(betaMean(1, 1)).toBe(0.5)
  })

  it('returns correct mean for Beta(2,1) ~ 0.667', () => {
    expect(betaMean(2, 1)).toBeCloseTo(2 / 3, 5)
  })

  it('returns correct mean for Beta(5,5) = 0.5', () => {
    expect(betaMean(5, 5)).toBe(0.5)
  })

  it('returns correct mean for Beta(10,2) ~ 0.833', () => {
    expect(betaMean(10, 2)).toBeCloseTo(10 / 12, 5)
  })
})

describe('betaVariance', () => {
  it('returns correct variance for Beta(1,1) = 1/12', () => {
    expect(betaVariance(1, 1)).toBeCloseTo(1 / 12, 10)
  })

  it('returns correct variance for Beta(2,2) = 1/20', () => {
    // Var = 2*2 / (4*4*5) = 4/80 = 1/20
    expect(betaVariance(2, 2)).toBeCloseTo(1 / 20, 10)
  })

  it('returns smaller variance with more observations (higher alpha+beta)', () => {
    const varLow = betaVariance(2, 2)
    const varHigh = betaVariance(20, 20)
    expect(varHigh).toBeLessThan(varLow)
  })
})

describe('betaSample', () => {
  it('returns values between 0 and 1', () => {
    const rng = seededRng(42)
    for (let i = 0; i < 100; i++) {
      const sample = betaSample(2, 3, rng)
      expect(sample).toBeGreaterThanOrEqual(0)
      expect(sample).toBeLessThanOrEqual(1)
    }
  })

  it('with deterministic RNG produces consistent results', () => {
    const rng1 = seededRng(12345)
    const rng2 = seededRng(12345)

    const sample1 = betaSample(3, 5, rng1)
    const sample2 = betaSample(3, 5, rng2)

    expect(sample1).toBe(sample2)
  })

  it('mean approximates betaMean over many samples (statistical test)', () => {
    const alpha = 4
    const beta = 8
    const rng = seededRng(999)
    const n = 5000
    let sum = 0

    for (let i = 0; i < n; i++) {
      sum += betaSample(alpha, beta, rng)
    }

    const empiricalMean = sum / n
    const theoreticalMean = betaMean(alpha, beta)

    // Allow 5% tolerance for statistical convergence
    expect(empiricalMean).toBeCloseTo(theoreticalMean, 1)
  })

  it('works with alpha < 1 and beta < 1', () => {
    const rng = seededRng(77)
    for (let i = 0; i < 50; i++) {
      const sample = betaSample(0.5, 0.5, rng)
      expect(sample).toBeGreaterThanOrEqual(0)
      expect(sample).toBeLessThanOrEqual(1)
    }
  })

  it('works with large alpha and beta', () => {
    const rng = seededRng(88)
    for (let i = 0; i < 50; i++) {
      const sample = betaSample(100, 100, rng)
      expect(sample).toBeGreaterThanOrEqual(0)
      expect(sample).toBeLessThanOrEqual(1)
    }
  })
})

describe('selectProvider', () => {
  const workType: AgentWorkType = 'development'
  const providers: AgentProviderName[] = ['claude', 'codex', 'amp']

  it('returns a valid RoutingDecision', async () => {
    const store = makeMockStore({})
    const rng = seededRng(42)

    const decision = await selectProvider(store, workType, providers, DEFAULT_ROUTING_CONFIG, {
      rng,
    })

    expect(decision.selectedProvider).toBeDefined()
    expect(providers).toContain(decision.selectedProvider)
    expect(decision.confidence).toBeGreaterThanOrEqual(0)
    expect(decision.confidence).toBeLessThanOrEqual(1)
    expect(decision.expectedReward).toBeGreaterThanOrEqual(0)
    expect(decision.expectedReward).toBeLessThanOrEqual(1)
    expect(decision.source).toBe('mab-routing')
    expect(Array.isArray(decision.alternatives)).toBe(true)
  })

  it('with forced exploration selects randomly and marks explorationReason as forced', async () => {
    const store = makeMockStore({
      'claude:development': makePosterior({
        provider: 'claude',
        workType: 'development',
        alpha: 100,
        beta: 1,
        totalObservations: 100,
      }),
      'codex:development': makePosterior({
        provider: 'codex',
        workType: 'development',
        alpha: 1,
        beta: 100,
        totalObservations: 100,
      }),
    })

    const rng = seededRng(42)
    const decision = await selectProvider(store, workType, ['claude', 'codex'], DEFAULT_ROUTING_CONFIG, {
      forcedExploration: true,
      rng,
    })

    expect(decision.explorationReason).toBe('forced')
    expect(['claude', 'codex']).toContain(decision.selectedProvider)
  })

  it('picks provider with highest sampled reward (deterministic RNG)', async () => {
    // Give claude a very strong posterior (alpha=50, beta=2) -- mean ~0.96
    // Give codex a very weak posterior (alpha=2, beta=50) -- mean ~0.04
    const store = makeMockStore({
      'claude:development': makePosterior({
        provider: 'claude',
        workType: 'development',
        alpha: 50,
        beta: 2,
        totalObservations: 50,
      }),
      'codex:development': makePosterior({
        provider: 'codex',
        workType: 'development',
        alpha: 2,
        beta: 50,
        totalObservations: 50,
      }),
    })

    // Use a config with 0 exploration rate so TS runs
    const config: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG, explorationRate: 0 }

    // Run multiple times -- claude should almost always be picked
    let claudeCount = 0
    for (let i = 0; i < 20; i++) {
      const rng = seededRng(i * 137)
      const decision = await selectProvider(store, workType, ['claude', 'codex'], config, { rng })
      if (decision.selectedProvider === 'claude') claudeCount++
    }

    // Claude should win the vast majority of the time
    expect(claudeCount).toBeGreaterThanOrEqual(18)
  })

  it('marks low-observation providers with explorationReason uncertainty', async () => {
    const store = makeMockStore({
      'claude:development': makePosterior({
        provider: 'claude',
        workType: 'development',
        alpha: 2,
        beta: 1,
        totalObservations: 2, // Below minObservationsForExploit (5)
      }),
    })

    const config: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG, explorationRate: 0 }
    const rng = seededRng(42)

    const decision = await selectProvider(store, workType, ['claude'], config, { rng })

    expect(decision.explorationReason).toBe('uncertainty')
  })

  it('explores with probability = explorationRate', async () => {
    const store = makeMockStore({
      'claude:development': makePosterior({
        provider: 'claude',
        workType: 'development',
        alpha: 10,
        beta: 10,
        totalObservations: 20,
      }),
      'codex:development': makePosterior({
        provider: 'codex',
        workType: 'development',
        alpha: 10,
        beta: 10,
        totalObservations: 20,
      }),
    })

    const explorationRate = 0.5
    const config: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG, explorationRate }

    let forcedCount = 0
    const n = 200
    for (let i = 0; i < n; i++) {
      const rng = seededRng(i * 31)
      const decision = await selectProvider(
        store,
        workType,
        ['claude', 'codex'],
        config,
        { rng },
      )
      if (decision.explorationReason === 'forced') forcedCount++
    }

    // Exploration should happen roughly explorationRate fraction of the time
    // Allow generous tolerance for randomness
    const fraction = forcedCount / n
    expect(fraction).toBeGreaterThan(0.3)
    expect(fraction).toBeLessThan(0.7)
  })

  it('includes alternatives array excluding the selected provider', async () => {
    const store = makeMockStore({})
    const rng = seededRng(42)

    const decision = await selectProvider(store, workType, providers, DEFAULT_ROUTING_CONFIG, {
      rng,
    })

    // Alternatives should not contain the selected provider
    const altProviders = decision.alternatives.map(a => a.provider)
    expect(altProviders).not.toContain(decision.selectedProvider)

    // Alternatives + selected should cover all providers
    expect(altProviders.length).toBe(providers.length - 1)
  })

  it('handles single provider (no alternatives)', async () => {
    const store = makeMockStore({})
    const rng = seededRng(42)

    const decision = await selectProvider(
      store,
      workType,
      ['claude'],
      DEFAULT_ROUTING_CONFIG,
      { rng },
    )

    expect(decision.selectedProvider).toBe('claude')
    expect(decision.alternatives).toHaveLength(0)
  })

  it('with deterministic RNG produces consistent selection', async () => {
    const store = makeMockStore({
      'claude:development': makePosterior({
        provider: 'claude',
        workType: 'development',
        alpha: 5,
        beta: 5,
        totalObservations: 10,
      }),
      'codex:development': makePosterior({
        provider: 'codex',
        workType: 'development',
        alpha: 3,
        beta: 7,
        totalObservations: 10,
      }),
    })

    const config: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG, explorationRate: 0 }

    const rng1 = seededRng(555)
    const decision1 = await selectProvider(store, workType, ['claude', 'codex'], config, {
      rng: rng1,
    })

    const rng2 = seededRng(555)
    const decision2 = await selectProvider(store, workType, ['claude', 'codex'], config, {
      rng: rng2,
    })

    expect(decision1.selectedProvider).toBe(decision2.selectedProvider)
    expect(decision1.expectedReward).toBe(decision2.expectedReward)
    expect(decision1.confidence).toBe(decision2.confidence)
  })

  it('does not mark explorationReason when provider has sufficient observations and high confidence', async () => {
    const store = makeMockStore({
      'claude:development': makePosterior({
        provider: 'claude',
        workType: 'development',
        alpha: 50,
        beta: 5,
        totalObservations: 55, // Well above minObservationsForExploit
      }),
    })

    const config: RoutingConfig = { ...DEFAULT_ROUTING_CONFIG, explorationRate: 0 }
    const rng = seededRng(42)

    const decision = await selectProvider(store, workType, ['claude'], config, { rng })

    expect(decision.explorationReason).toBeUndefined()
  })

  it('calls getPosterior for each available provider', async () => {
    const store = makeMockStore({})
    const rng = seededRng(42)

    await selectProvider(store, workType, providers, DEFAULT_ROUTING_CONFIG, { rng })

    expect(store.getPosterior).toHaveBeenCalledTimes(3)
    expect(store.getPosterior).toHaveBeenCalledWith('claude', 'development')
    expect(store.getPosterior).toHaveBeenCalledWith('codex', 'development')
    expect(store.getPosterior).toHaveBeenCalledWith('amp', 'development')
  })
})
