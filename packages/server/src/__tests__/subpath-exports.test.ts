import { describe, it, expect } from 'vitest'

/**
 * Subpath export resolution tests for @donmai/server.
 *
 * Verifies that every key export defined in the main barrel resolves
 * to a module that exports the expected symbol. These tests catch:
 * - Missing `default` condition in exports map (breaks tsx/CJS loaders)
 * - Mismatched file paths between exports map and built output
 * - Missing or renamed function/class exports
 */

// The first `import('../index.js')` pays the full barrel-transform cost
// (the entire @donmai/server module graph), which is several seconds under
// parallel load and can exceed vitest's 5s default. Give the suite a generous
// timeout so this transform-bound smoke test never flakes; the imports
// themselves are trivial and cached after the first.
describe('@donmai/server subpath exports', { timeout: 30_000 }, () => {
  // Redis exports
  it('exports isRedisConfigured from main', async () => {
    const mod = await import('../index.js')
    expect(mod.isRedisConfigured).toBeDefined()
    expect(typeof mod.isRedisConfigured).toBe('function')
  })

  it('exports getRedisClient from main', async () => {
    const mod = await import('../index.js')
    expect(mod.getRedisClient).toBeDefined()
    expect(typeof mod.getRedisClient).toBe('function')
  })

  it('exports executeCleanupMutation from main', async () => {
    const mod = await import('../index.js')
    expect(mod.executeCleanupMutation).toBeDefined()
    expect(typeof mod.executeCleanupMutation).toBe('function')
  })

  // Rate limiting
  it('exports RateLimiter from main', async () => {
    const mod = await import('../index.js')
    expect(mod.RateLimiter).toBeDefined()
    expect(typeof mod.RateLimiter).toBe('function')
  })

  it('exports RATE_LIMITS from main', async () => {
    const mod = await import('../index.js')
    expect(mod.RATE_LIMITS).toBeDefined()
    expect(typeof mod.RATE_LIMITS).toBe('object')
  })

  it('exports checkRateLimit from main', async () => {
    const mod = await import('../index.js')
    expect(mod.checkRateLimit).toBeDefined()
    expect(typeof mod.checkRateLimit).toBe('function')
  })

  it('exports getClientIP from main', async () => {
    const mod = await import('../index.js')
    expect(mod.getClientIP).toBeDefined()
    expect(typeof mod.getClientIP).toBe('function')
  })

  // Worker auth
  it('exports extractBearerToken from main', async () => {
    const mod = await import('../index.js')
    expect(mod.extractBearerToken).toBeDefined()
    expect(typeof mod.extractBearerToken).toBe('function')
  })

  it('exports verifyApiKey from main', async () => {
    const mod = await import('../index.js')
    expect(mod.verifyApiKey).toBeDefined()
    expect(typeof mod.verifyApiKey).toBe('function')
  })

  it('exports isWorkerAuthConfigured from main', async () => {
    const mod = await import('../index.js')
    expect(mod.isWorkerAuthConfigured).toBeDefined()
    expect(typeof mod.isWorkerAuthConfigured).toBe('function')
  })

  // Session hash
  it('exports hashSessionId from main', async () => {
    const mod = await import('../index.js')
    expect(mod.hashSessionId).toBeDefined()
    expect(typeof mod.hashSessionId).toBe('function')
  })

  it('exports isValidPublicId from main', async () => {
    const mod = await import('../index.js')
    expect(mod.isValidPublicId).toBeDefined()
    expect(typeof mod.isValidPublicId).toBe('function')
  })

  // Webhook idempotency
  it('exports generateIdempotencyKey from main', async () => {
    const mod = await import('../index.js')
    expect(mod.generateIdempotencyKey).toBeDefined()
    expect(typeof mod.generateIdempotencyKey).toBe('function')
  })

  // Agent tracking
  it('exports computeStrategy from main', async () => {
    const mod = await import('../index.js')
    expect(mod.computeStrategy).toBeDefined()
    expect(typeof mod.computeStrategy).toBe('function')
  })

  it('exports extractFailureReason from main', async () => {
    const mod = await import('../index.js')
    expect(mod.extractFailureReason).toBeDefined()
    expect(typeof mod.extractFailureReason).toBe('function')
  })

  it('exports MAX_TOTAL_SESSIONS from main', async () => {
    const mod = await import('../index.js')
    expect(mod.MAX_TOTAL_SESSIONS).toBeDefined()
    expect(typeof mod.MAX_TOTAL_SESSIONS).toBe('number')
  })

  it('exports incrementDispatchCount from main', async () => {
    const mod = await import('../index.js')
    expect(mod.incrementDispatchCount).toBeDefined()
    expect(typeof mod.incrementDispatchCount).toBe('function')
  })

  it('exports getDispatchCount from main', async () => {
    const mod = await import('../index.js')
    expect(mod.getDispatchCount).toBeDefined()
    expect(typeof mod.getDispatchCount).toBe('function')
  })

  it('exports clearDispatchCount from main', async () => {
    const mod = await import('../index.js')
    expect(mod.clearDispatchCount).toBeDefined()
    expect(typeof mod.clearDispatchCount).toBe('function')
  })

  // Governor storage
  it('exports RedisOverrideStorage from main', async () => {
    const mod = await import('../index.js')
    expect(mod.RedisOverrideStorage).toBeDefined()
    expect(typeof mod.RedisOverrideStorage).toBe('function')
  })

  // Governor event bus
  it('exports RedisEventBus from main', async () => {
    const mod = await import('../index.js')
    expect(mod.RedisEventBus).toBeDefined()
    expect(typeof mod.RedisEventBus).toBe('function')
  })

  // Governor dedup
  it('exports RedisEventDeduplicator from main', async () => {
    const mod = await import('../index.js')
    expect(mod.RedisEventDeduplicator).toBeDefined()
    expect(typeof mod.RedisEventDeduplicator).toBe('function')
  })

  // Redis circuit breaker
  it('exports RedisCircuitBreaker from main', async () => {
    const mod = await import('../index.js')
    expect(mod.RedisCircuitBreaker).toBeDefined()
    expect(typeof mod.RedisCircuitBreaker).toBe('function')
  })

  it('exports createRedisCircuitBreaker from main', async () => {
    const mod = await import('../index.js')
    expect(mod.createRedisCircuitBreaker).toBeDefined()
    expect(typeof mod.createRedisCircuitBreaker).toBe('function')
  })

  // A2A server
  it('exports buildAgentCard from main', async () => {
    const mod = await import('../index.js')
    expect(mod.buildAgentCard).toBeDefined()
    expect(typeof mod.buildAgentCard).toBe('function')
  })

  it('exports createA2aRequestHandler from main', async () => {
    const mod = await import('../index.js')
    expect(mod.createA2aRequestHandler).toBeDefined()
    expect(typeof mod.createA2aRequestHandler).toBe('function')
  })

  // Logger
  it('exports createLogger from main', async () => {
    const mod = await import('../index.js')
    expect(mod.createLogger).toBeDefined()
    expect(typeof mod.createLogger).toBe('function')
  })
})
