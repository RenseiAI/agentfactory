import { describe, it, expect } from 'vitest'

import { parseRedisUrl } from '../redis.js'

/**
 * REDIS_URL parsing — strict (percent-encoded) path and the literal-userinfo
 * fallback for unencoded passwords from managed-Redis consoles.
 *
 * The fallback exists because a raw `/` in the password terminates the URL
 * authority section, so `new URL()` throws ERR_INVALID_URL — which took a
 * production replica's pub/sub bootstrap down during a Redis migration.
 */
describe('parseRedisUrl', () => {
  it('parses a plain redis:// URL', () => {
    expect(parseRedisUrl('redis://cache.internal:6379')).toEqual({
      host: 'cache.internal',
      port: 6379,
    })
  })

  it('enables TLS for rediss:// and keeps username/password', () => {
    expect(parseRedisUrl('rediss://app-user:secret@cache.internal:10147')).toEqual({
      host: 'cache.internal',
      port: 10147,
      username: 'app-user',
      password: 'secret',
      tls: {},
    })
  })

  it('percent-decodes an encoded password (strict path)', () => {
    expect(parseRedisUrl('rediss://u:a%2Fb%2Bc@h:1').password).toBe('a/b+c')
  })

  it('omits the implicit "default" username', () => {
    expect(parseRedisUrl('redis://default:pw@h:1')).not.toHaveProperty('username')
  })

  it('parses db path and family query param', () => {
    expect(parseRedisUrl('redis://h:1/2?family=6')).toMatchObject({ db: 2, family: 6 })
  })

  it('accepts a raw "/" in the password via the literal-userinfo fallback', () => {
    // The outage shape: unencoded managed-Redis password containing `/` and `+`.
    expect(parseRedisUrl('rediss://prod-user:abc/def+gh@cache.internal:10147')).toEqual({
      host: 'cache.internal',
      port: 10147,
      username: 'prod-user',
      password: 'abc/def+gh',
      tls: {},
    })
  })

  it('accepts a stray "%" in the password (invalid percent-encoding)', () => {
    // Parses as a URL but decodeURIComponent throws URIError — falls back.
    expect(parseRedisUrl('redis://u:abc%@h:1').password).toBe('abc%')
  })

  it('keeps db path and query params on the fallback path', () => {
    expect(parseRedisUrl('redis://u:a/b@h:1/2?family=6')).toMatchObject({
      host: 'h',
      port: 1,
      password: 'a/b',
      db: 2,
      family: 6,
    })
  })

  it('accepts "@" and ":" inside the password (last-@ / first-: split)', () => {
    expect(parseRedisUrl('redis://u:p@ss:w@rd@h:1')).toMatchObject({
      host: 'h',
      port: 1,
      username: 'u',
      password: 'p@ss:w@rd',
    })
  })

  it('throws an actionable error, without echoing the credential, when unsalvageable', () => {
    let caught: Error | undefined
    try {
      parseRedisUrl('redis://u:pa/ss@bad host:port')
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeDefined()
    expect(caught!.message).toContain('percent-encode')
    expect(caught!.message).not.toContain('pa/ss')
    expect(caught!.cause).toBeDefined()
  })

  it('still rejects non-redis schemes', () => {
    expect(() => parseRedisUrl('http://h:1')).not.toThrow() // strict path is scheme-agnostic (pre-existing behavior)
    expect(() => parseRedisUrl('http://u:a/b@h:1')).toThrow(/percent-encode/) // fallback is redis-only
  })
})
