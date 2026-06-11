/**
 * JWT Envelope (Decision 6)
 *
 * Tenant-scoping enforcement for queue-borne work.  At enqueue time
 * the dispatcher injects a JWT envelope `{ proj, org, sub, claims }`
 * onto the QueuedWork metadata; at consume time the worker re-verifies
 * the signature against the trust anchor (sigstore-verified
 * issuer set) and compares the `org` claim against its own
 * registration's org context.  Org-mismatch → emit a
 * `session.permission-denied` audit event and reject the work item
 * before any tools fire.
 *
 * Architecture references:
 *   - donmai-architecture/ADR-2026-04-29-long-running-runtime-substrate.md
 *     (commit 56f2bc6) — Decision 6 (tenant-scoping JWT envelope).
 *   - sigstore trust anchor (the issuer set we trust).
 *   - ADR-2026-04-28-sandbox-capabilities-in-types.md —
 *     Cedar policy fires on the Layer 6 `pre-verb` hook for cross-cutting
 *     enforcement.  This module only implements the *envelope* check;
 *     Cedar lives in the platform repo.
 *
 * Implementation choices:
 *   - We use Node's built-in `crypto` module only — no new deps.  The
 *     verifier supports HS256 (shared-secret, used in tests + when
 *     `WORKER_JWT_HMAC_KEY` is set) and RS256/ES256 (PEM public keys
 *     from the trust-anchor allowlist).  This matches the SigstoreVerifier
 *     pattern already shipped earlier.
 *   - The JWT format is compact JWS (header.payload.signature), base64url
 *     encoded.  We do not implement JWE, JWK, or nested tokens.
 *   - Failures produce a structured `JwtVerificationResult` with `reason`
 *     so the caller can emit the right audit event.  We never throw.
 */

import crypto from 'crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The envelope the dispatcher attaches to a queued work item at enqueue
 * time.  Stored on `QueuedWork.tenantEnvelope` (added in this PR).
 */
export interface TenantEnvelope {
  /** Compact JWS — `header.payload.signature` (base64url). */
  jwt: string
  /**
   * Caller-provided `org` claim — duplicated outside the JWT so the
   * scheduler can route without parsing.  The verify path re-checks
   * this against the JWT payload to catch tampering.
   */
  org: string
  /** Caller-provided `proj` claim (Linear project) — same rationale. */
  proj?: string
  /** Caller-provided `sub` claim (the human or system actor). */
  sub?: string
}

/** Decoded JWT payload claims we depend on. */
export interface TenantJwtClaims {
  /** Organisation id — the primary tenancy boundary. */
  org: string
  /** Linear project name (optional). */
  proj?: string
  /** Subject — the actor who enqueued the work. */
  sub?: string
  /** Issuer — must appear in the trusted-issuer allowlist. */
  iss?: string
  /** Issued-at (Unix seconds). */
  iat?: number
  /** Expiration (Unix seconds).  Optional but enforced when present. */
  exp?: number
  /** Catch-all — the verifier returns the full payload. */
  [key: string]: unknown
}

export interface JwtVerificationOptions {
  /**
   * Trusted issuer allowlist (sigstore-verified).  The JWT's
   * `iss` claim must be a member.  Empty array = reject all (fail-closed).
   */
  trustedIssuers: string[]
  /**
   * The org the worker registered with.  Required for the org-claim
   * comparison — pass the `WORKER_ORG_ID` env value (or the
   * registration's org context) here.
   */
  workerOrg: string
  /**
   * Symmetric (HS256) key.  When set, the verifier accepts HS256 in
   * addition to asymmetric algorithms.  Tests use this; production
   * deployments rely on RS256/ES256 with PEM keys.
   */
  hmacKey?: string
  /**
   * Map of issuer → PEM public key (RS256/ES256).  When the JWT's
   * `iss` matches a key here, the corresponding PEM is used for
   * verification.  Sourced from the trust anchor in production.
   */
  issuerPublicKeys?: Record<string, string>
  /**
   * Clock skew tolerance for `exp` checks (seconds).  Default 60s.
   */
  clockSkewSeconds?: number
  /**
   * Override `Date.now` for deterministic tests.
   */
  now?: () => number
}

export type JwtVerificationFailureReason =
  | 'jwt-malformed'
  | 'jwt-unsupported-alg'
  | 'jwt-signature-invalid'
  | 'jwt-issuer-untrusted'
  | 'jwt-expired'
  | 'jwt-org-claim-missing'
  | 'envelope-org-mismatch'
  | 'worker-org-mismatch'

export type JwtVerificationResult =
  | { valid: true; claims: TenantJwtClaims }
  | { valid: false; reason: JwtVerificationFailureReason; detail?: string }

// ---------------------------------------------------------------------------
// Public verify entry point
// ---------------------------------------------------------------------------

/**
 * Verify a tenant envelope:
 *   1. Decode + verify the JWT signature against the trust anchor.
 *   2. Confirm the issuer appears in `trustedIssuers`.
 *   3. Check `exp` (when present) with `clockSkewSeconds` tolerance.
 *   4. Confirm the JWT `org` claim matches the envelope's outer `org`
 *      (catches a tampered envelope where only the outer field was
 *      changed).
 *   5. Confirm the JWT `org` matches the worker's registered org
 *      (the actual tenancy enforcement — Decision 6 §"mismatch →
 *      reject with permission_denied").
 *
 * Returns a structured result; never throws.  Callers should map
 * `valid: false` into a `session.permission-denied` event before
 * dropping the work item.
 */
export function verifyTenantEnvelope(
  envelope: TenantEnvelope,
  options: JwtVerificationOptions,
): JwtVerificationResult {
  const decoded = decodeJwt(envelope.jwt)
  if (!decoded) {
    return { valid: false, reason: 'jwt-malformed' }
  }

  const { header, payload, signingInput, signatureBytes } = decoded

  const alg = typeof header.alg === 'string' ? header.alg : ''
  if (alg !== 'HS256' && alg !== 'RS256' && alg !== 'ES256') {
    return {
      valid: false,
      reason: 'jwt-unsupported-alg',
      detail: `alg=${alg || 'none'}`,
    }
  }

  // --- Cryptographic verification ---
  const sigOk = verifyJwtSignature(alg, signingInput, signatureBytes, header, payload, options)
  if (!sigOk) {
    return { valid: false, reason: 'jwt-signature-invalid' }
  }

  // --- Issuer allowlist (trust anchor) ---
  if (typeof payload.iss !== 'string' || !options.trustedIssuers.includes(payload.iss)) {
    return {
      valid: false,
      reason: 'jwt-issuer-untrusted',
      detail: `iss=${typeof payload.iss === 'string' ? payload.iss : '<missing>'}`,
    }
  }

  // --- Expiration ---
  if (typeof payload.exp === 'number') {
    const nowSec = Math.floor((options.now ? options.now() : Date.now()) / 1000)
    const skew = options.clockSkewSeconds ?? 60
    if (nowSec > payload.exp + skew) {
      return { valid: false, reason: 'jwt-expired' }
    }
  }

  // --- Org claim presence ---
  if (typeof payload.org !== 'string' || payload.org.length === 0) {
    return { valid: false, reason: 'jwt-org-claim-missing' }
  }

  // --- Envelope outer-org tamper check ---
  if (envelope.org !== payload.org) {
    return {
      valid: false,
      reason: 'envelope-org-mismatch',
      detail: `envelope.org=${envelope.org} jwt.org=${payload.org}`,
    }
  }

  // --- Worker tenancy boundary (the actual Decision 6 enforcement) ---
  if (options.workerOrg !== payload.org) {
    return {
      valid: false,
      reason: 'worker-org-mismatch',
      detail: `worker=${options.workerOrg} job=${payload.org}`,
    }
  }

  return { valid: true, claims: payload }
}

// ---------------------------------------------------------------------------
// JWT decode + verify (Node crypto only)
// ---------------------------------------------------------------------------

interface DecodedJwt {
  header: Record<string, unknown>
  payload: TenantJwtClaims
  signingInput: string
  signatureBytes: Buffer
}

/**
 * Compact-JWS decode.  Returns null on any structural failure — caller
 * maps that to `jwt-malformed`.
 */
function decodeJwt(jwt: string): DecodedJwt | null {
  if (typeof jwt !== 'string') return null
  const parts = jwt.split('.')
  if (parts.length !== 3) return null

  const [headerB64, payloadB64, sigB64] = parts
  if (!headerB64 || !payloadB64 || !sigB64) return null

  let header: Record<string, unknown>
  let payload: TenantJwtClaims
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as Record<string, unknown>
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as TenantJwtClaims
  } catch {
    return null
  }

  if (!header || typeof header !== 'object') return null
  if (!payload || typeof payload !== 'object') return null

  return {
    header,
    payload,
    signingInput: `${headerB64}.${payloadB64}`,
    signatureBytes: base64UrlDecode(sigB64),
  }
}

function verifyJwtSignature(
  alg: 'HS256' | 'RS256' | 'ES256',
  signingInput: string,
  signature: Buffer,
  _header: Record<string, unknown>,
  payload: TenantJwtClaims,
  options: JwtVerificationOptions,
): boolean {
  if (alg === 'HS256') {
    if (!options.hmacKey) return false
    const expected = crypto
      .createHmac('sha256', options.hmacKey)
      .update(signingInput)
      .digest()
    if (expected.length !== signature.length) return false
    try {
      return crypto.timingSafeEqual(expected, signature)
    } catch {
      return false
    }
  }

  // Asymmetric — look up the public key by issuer
  const iss = typeof payload.iss === 'string' ? payload.iss : null
  if (!iss) return false
  const pem = options.issuerPublicKeys?.[iss]
  if (!pem) return false

  try {
    const verifier = crypto.createVerify(alg === 'RS256' ? 'RSA-SHA256' : 'sha256')
    verifier.update(signingInput)
    verifier.end()
    if (alg === 'ES256') {
      // ES256 signatures from JOSE are raw R||S concatenation; Node
      // expects DER.  Convert before verification.
      const der = ecdsaJoseToDer(signature)
      return verifier.verify(pem, der)
    }
    return verifier.verify(pem, signature)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// base64url helpers
// ---------------------------------------------------------------------------

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  const padLen = (4 - (padded.length % 4)) % 4
  return Buffer.from(padded + '='.repeat(padLen), 'base64')
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

// ---------------------------------------------------------------------------
// ES256 signature format conversion (JOSE → DER)
// ---------------------------------------------------------------------------

function ecdsaJoseToDer(jose: Buffer): Buffer {
  if (jose.length !== 64) {
    throw new Error('ES256 JOSE signature must be 64 bytes')
  }
  const r = trimLeadingZeros(jose.subarray(0, 32))
  const s = trimLeadingZeros(jose.subarray(32, 64))
  const rEncoded = encodeDerInteger(r)
  const sEncoded = encodeDerInteger(s)
  const seq = Buffer.concat([rEncoded, sEncoded])
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq])
}

function trimLeadingZeros(buf: Buffer): Buffer {
  let i = 0
  while (i < buf.length - 1 && buf[i] === 0) i++
  return buf.subarray(i)
}

function encodeDerInteger(int: Buffer): Buffer {
  // High bit set → prepend 0x00 to signal positive
  const needsPad = (int[0] ?? 0) & 0x80
  const body = needsPad ? Buffer.concat([Buffer.from([0x00]), int]) : int
  return Buffer.concat([Buffer.from([0x02, body.length]), body])
}

// ---------------------------------------------------------------------------
// Test helper — mint a compact JWS (HS256 only)
//
// Exported for unit tests + for local dev; production minting happens
// upstream in the dispatcher.  Marked `@internal` so dashboard/UI code
// doesn't accidentally rely on it.
// ---------------------------------------------------------------------------

/**
 * @internal — test helper.  Mint a compact JWS using HS256.
 */
export function _mintHS256(
  payload: TenantJwtClaims,
  hmacKey: string,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header), 'utf8'))
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'))
  const signingInput = `${headerB64}.${payloadB64}`
  const sig = crypto.createHmac('sha256', hmacKey).update(signingInput).digest()
  return `${signingInput}.${base64UrlEncode(sig)}`
}
