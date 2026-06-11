import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./redis.js', () => ({
  isRedisConfigured: vi.fn(() => false),
  redisSet: vi.fn(),
}))

vi.mock('./session-storage.js', () => ({
  touchSessionHeartbeat: vi.fn(async () => false),
}))

import {
  createSessionHeartbeat,
  DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS,
  SESSION_STALE_THRESHOLD_MS,
  heartbeatRedisKey,
} from './session-heartbeat.js'
import { SessionEventBus, type SessionLifecycleEvent } from './session-event-bus.js'

describe('session-heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('exposes the ADR-mandated 15s cadence and 60s stale threshold', () => {
    expect(DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS).toBe(15_000)
    expect(SESSION_STALE_THRESHOLD_MS).toBe(60_000)
  })

  it('formats Redis key with the documented shape', () => {
    expect(heartbeatRedisKey('sess-abc')).toBe('session:heartbeat:sess-abc')
  })

  it('emits the first tick synchronously when start() is called', async () => {
    const bus = new SessionEventBus()
    const handler = vi.fn()
    bus.subscribe({ kinds: ['session.heartbeat'] }, handler)

    const hb = createSessionHeartbeat({
      sessionId: 's1',
      workerId: 'w1',
      bus,
      intervalMs: 100,
      redisWriter: vi.fn().mockResolvedValue(undefined),
    })

    hb.start('step-A')
    // Drain the immediate tick (start() schedules void tick())
    await vi.advanceTimersByTimeAsync(0)

    expect(handler).toHaveBeenCalledOnce()
    const event = handler.mock.calls[0][0] as SessionLifecycleEvent
    expect(event.kind).toBe('session.heartbeat')
    if (event.kind !== 'session.heartbeat') throw new Error('typed-narrow')
    expect(event.sessionId).toBe('s1')
    expect(event.workerId).toBe('w1')
    expect(event.stepId).toBe('step-A')

    hb.stop()
  })

  it('continues ticking on the configured cadence until stop()', async () => {
    const bus = new SessionEventBus()
    const handler = vi.fn()
    bus.subscribe({ kinds: ['session.heartbeat'] }, handler)

    const hb = createSessionHeartbeat({
      sessionId: 's2',
      workerId: 'w2',
      bus,
      intervalMs: 1_000,
      redisWriter: vi.fn().mockResolvedValue(undefined),
    })
    hb.start()

    await vi.advanceTimersByTimeAsync(0)
    expect(handler).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(handler).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(handler).toHaveBeenCalledTimes(4)

    hb.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(handler).toHaveBeenCalledTimes(4)
  })

  it('writes a Redis pointer alongside each tick', async () => {
    const bus = new SessionEventBus()
    const writer = vi.fn().mockResolvedValue(undefined)
    const hb = createSessionHeartbeat({
      sessionId: 's3',
      workerId: 'w3',
      bus,
      intervalMs: 5_000,
      redisWriter: writer,
    })
    hb.start('step-B')
    await vi.advanceTimersByTimeAsync(0)

    expect(writer).toHaveBeenCalledOnce()
    const [key, value, ttl] = writer.mock.calls[0]
    expect(key).toBe('session:heartbeat:s3')
    expect(typeof value).toBe('string')
    const parsed = JSON.parse(value as string) as Record<string, unknown>
    expect(parsed).toMatchObject({ sessionId: 's3', workerId: 'w3', stepId: 'step-B' })
    expect(typeof parsed.emittedAt).toBe('number')
    expect(ttl).toBe(20) // 4 ticks * 5s = 20s grace

    hb.stop()
  })

  it('keeps ticking when the Redis writer rejects (best-effort)', async () => {
    const bus = new SessionEventBus()
    const handler = vi.fn()
    bus.subscribe({ kinds: ['session.heartbeat'] }, handler)
    const writer = vi.fn().mockRejectedValue(new Error('redis down'))

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const hb = createSessionHeartbeat({
      sessionId: 's4',
      workerId: 'w4',
      bus,
      intervalMs: 1_000,
      redisWriter: writer,
    })
    hb.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(warnSpy).toHaveBeenCalled()

    hb.stop()
    warnSpy.mockRestore()
  })

  it('stops are idempotent', async () => {
    const bus = new SessionEventBus()
    const hb = createSessionHeartbeat({
      sessionId: 's5',
      workerId: 'w5',
      bus,
      intervalMs: 1_000,
      redisWriter: vi.fn().mockResolvedValue(undefined),
    })
    hb.start()
    hb.stop()
    expect(() => hb.stop()).not.toThrow()
    expect(hb.stopped).toBe(true)
  })

  it('refuses to restart after stop() (matches HeartbeatWriter contract)', async () => {
    const bus = new SessionEventBus()
    const handler = vi.fn()
    bus.subscribe({}, handler)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const hb = createSessionHeartbeat({
      sessionId: 's6',
      workerId: 'w6',
      bus,
      intervalMs: 1_000,
      redisWriter: vi.fn().mockResolvedValue(undefined),
    })
    hb.start()
    hb.stop()

    handler.mockClear()
    hb.start()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(handler).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('60s stale threshold matches the platform stale-detection job', () => {
    // Locked-in via constant; the platform side's heartbeat-mirror
    // imports SESSION_STALE_THRESHOLD_MS to keep the two in sync.
    expect(SESSION_STALE_THRESHOLD_MS / DEFAULT_SESSION_HEARTBEAT_INTERVAL_MS).toBe(4)
  })
})
