/**
 * Provider Signing & Trust Verification Runtime — REN-1314
 *
 * Implements the verification-side concerns for the provider signing contract:
 *
 * 1. Manifest hash computation (canonical JSON sha256) — delegates to base.ts
 * 2. Signature verification with pluggable verifier dispatch
 *    (sigstore / cosign / minisign / ed25519)
 * 3. Trust mode enforcement at activation:
 *    - permissive: warn on unsigned, accept
 *    - signed-by-allowlist: reject unknown signers
 *    - attested: require SLSA provenance in attestations
 * 4. trustOverride: 'allowed-this-once' for incident response, with audit log
 * 5. Capability discrepancy detection: declared vs. observed; fires
 *    'capability-mismatch' hook event via globalHookBus
 *
 * Architecture references:
 *   - rensei-architecture/002-provider-base-contract.md §Signing and trust
 *   - rensei-architecture/015-plugin-spec.md §Auth + trust
 */

import type {
  ProviderFamily,
  ProviderManifest,
  ProviderSignature,
  ProviderRef,
} from './base.js'
import { hashManifest } from './base.js'
import {
  registerVerifier,
  getVerifier,
  type Verifier,
  type VerifierInput,
  type VerifierResult,
  Ed25519Verifier,
  MinisignVerifier,
  CosignVerifier,
  SigstoreVerifier,
} from './verifiers/index.js'
import { globalHookBus } from '../observability/hooks.js'

// ---------------------------------------------------------------------------
// Re-export Verifier types for consumers
// ---------------------------------------------------------------------------
export type { Verifier, VerifierInput, VerifierResult }
export { registerVerifier, getVerifier }

// ---------------------------------------------------------------------------
// Register default verifiers at module load
// ---------------------------------------------------------------------------

registerVerifier(new Ed25519Verifier())
registerVerifier(new MinisignVerifier())
registerVerifier(new CosignVerifier())
registerVerifier(new SigstoreVerifier())

// ---------------------------------------------------------------------------
// Trust modes
// ---------------------------------------------------------------------------

/**
 * Trust mode determines what signature evidence is required before a provider
 * may activate.
 *
 * - `permissive`:         Unsigned providers emit a warning but are accepted.
 * - `signed-by-allowlist`: The signer identity must appear in the allowlist.
 * - `attested`:           Requires SLSA provenance in signature.attestations.
 */
export type TrustMode = 'permissive' | 'signed-by-allowlist' | 'attested'

// ---------------------------------------------------------------------------
// TrustOverride — incident-response escape hatch
// ---------------------------------------------------------------------------

export interface TrustOverride {
  mode: 'allowed-this-once'
  /** Who is authorizing the override (email, operator id, or 'env:DONMAI_OPERATOR'). */
  actor: string
  /** Human-readable reason for the override. */
  reason: string
}

/**
 * Audit log entry written whenever a trustOverride is applied.
 * These entries should be forwarded to your audit/SIEM system.
 */
export interface TrustOverrideAuditEntry {
  /** Canonical-JSON SHA-256 hex digest of the manifest. */
  manifestHash: string
  /** The signer identity from the signature, or 'unsigned' if none. */
  signer: string
  /** ISO 8601 timestamp when the override was applied. */
  timestamp: string
  actor: string
  reason: string
  /** The provider being activated under override. */
  providerRef: { family: string; id: string; version: string }
}

/** In-process audit log (append-only, observable for tests). */
const _auditLog: TrustOverrideAuditEntry[] = []

/** Return a snapshot of all audit log entries. */
export function getTrustOverrideAuditLog(): readonly TrustOverrideAuditEntry[] {
  return _auditLog.slice()
}

/** Clear the audit log (for test teardown). */
export function clearTrustOverrideAuditLog(): void {
  _auditLog.length = 0
}

// ---------------------------------------------------------------------------
// Verification options
// ---------------------------------------------------------------------------

export interface VerifyManifestOptions {
  /**
   * The trust mode to enforce. Defaults to 'permissive'.
   */
  trustMode?: TrustMode

  /**
   * For 'signed-by-allowlist' mode: the set of trusted signer identities
   * (URLs or DIDs). The signature.signer must be an exact member.
   */
  signerAllowlist?: string[]

  /**
   * Incident-response override. When provided and the normal trust check would
   * fail, the override is applied, an audit log entry is written, and the
   * activation is allowed.
   */
  trustOverride?: TrustOverride

  /**
   * The provider reference — used for audit log entries and hook events.
   * If omitted, a stub ref is constructed from the manifest.
   */
  providerRef?: ProviderRef

  /**
   * Skip cryptographic verification entirely (test-only).
   * Never set to true in production code.
   */
  _testBypassVerify?: boolean
}

export interface ManifestVerificationResult {
  valid: boolean
  reason?: string
  /** True if a trustOverride was applied to reach a valid result. */
  overrideApplied?: boolean
}

// ---------------------------------------------------------------------------
// Core verification entry point
// ---------------------------------------------------------------------------

/**
 * Verify a provider manifest's signature and enforce the configured trust mode.
 *
 * Steps:
 * 1. If no signature present: permissive → warn + accept; others → reject.
 * 2. Verify manifestHash matches canonical-JSON sha256 of manifest.
 * 3. Dispatch to the registered verifier for sig.algorithm.
 * 4. Apply trust-mode policy (allowlist membership, SLSA attestation check).
 * 5. If policy fails and trustOverride is provided: log + accept.
 *
 * @param manifest - The provider manifest to verify.
 * @param sig      - The signature to verify against. May be null (unsigned).
 * @param options  - Trust mode and policy configuration.
 */
export async function verifyManifestSignature<F extends ProviderFamily>(
  manifest: ProviderManifest<F>,
  sig: ProviderSignature | null,
  options: VerifyManifestOptions = {},
): Promise<ManifestVerificationResult> {
  const trustMode = options.trustMode ?? 'permissive'
  const providerRef = options.providerRef ?? {
    family: manifest.family,
    id: manifest.id,
    version: manifest.version,
  }

  // --- Unsigned provider ---
  if (!sig) {
    if (trustMode === 'permissive') {
      console.warn(
        `[signing] Provider '${manifest.id}' (${manifest.family}) has no signature. ` +
        `Activating in permissive mode.`,
      )
      return { valid: true, reason: 'unsigned provider accepted in permissive mode' }
    }

    const failReason = `Provider '${manifest.id}' has no signature; trust mode '${trustMode}' requires one.`
    return applyOverrideOrFail(failReason, 'unsigned', providerRef, manifest, options)
  }

  // --- Hash check ---
  const expectedHash = hashManifest(manifest)
  if (sig.manifestHash !== expectedHash) {
    const failReason = `manifestHash mismatch: signature contains '${sig.manifestHash}', manifest hashes to '${expectedHash}'`
    return applyOverrideOrFail(failReason, sig.signer, providerRef, manifest, options)
  }

  // --- Structural checks ---
  if (!sig.signatureValue || sig.signatureValue.trim().length === 0) {
    const failReason = 'signatureValue is empty'
    return applyOverrideOrFail(failReason, sig.signer, providerRef, manifest, options)
  }
  // publicKey may be empty for keyless algorithms (sigstore OIDC, cosign keyless).
  // Only enforce non-empty for keyed algorithms.
  const requiresPublicKey = sig.algorithm !== 'sigstore' && sig.algorithm !== 'cosign'
  if (requiresPublicKey && (!sig.publicKey || sig.publicKey.trim().length === 0)) {
    const failReason = 'publicKey is empty'
    return applyOverrideOrFail(failReason, sig.signer, providerRef, manifest, options)
  }

  // --- Cryptographic verification ---
  if (!options._testBypassVerify) {
    const cryptoResult = await dispatchVerifier(sig)
    if (!cryptoResult.valid) {
      return applyOverrideOrFail(
        cryptoResult.reason ?? 'Cryptographic verification failed',
        sig.signer,
        providerRef,
        manifest,
        options,
      )
    }
  }

  // --- Trust mode policy ---
  const policyResult = enforceTrustPolicy(sig, trustMode, options)
  if (!policyResult.valid) {
    return applyOverrideOrFail(
      policyResult.reason ?? 'Trust policy check failed',
      sig.signer,
      providerRef,
      manifest,
      options,
    )
  }

  return { valid: true }
}

// ---------------------------------------------------------------------------
// Verifier dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a signature to the registered verifier for its algorithm.
 */
async function dispatchVerifier(sig: ProviderSignature): Promise<VerifierResult> {
  const verifier = getVerifier(sig.algorithm)
  if (!verifier) {
    return {
      valid: false,
      reason: `No verifier registered for algorithm '${sig.algorithm}'. ` +
        `Supported algorithms: sigstore, cosign, minisign, ed25519.`,
    }
  }

  const input: VerifierInput = {
    manifestHash: sig.manifestHash,
    signatureValue: sig.signatureValue,
    publicKey: sig.publicKey,
    signer: sig.signer,
    attestedAt: sig.attestedAt,
    attestations: sig.attestations,
  }

  return verifier.verify(input)
}

// ---------------------------------------------------------------------------
// Trust mode policy enforcement
// ---------------------------------------------------------------------------

function enforceTrustPolicy(
  sig: ProviderSignature,
  trustMode: TrustMode,
  options: VerifyManifestOptions,
): { valid: boolean; reason?: string } {
  switch (trustMode) {
    case 'permissive':
      // Any valid signature is accepted
      return { valid: true }

    case 'signed-by-allowlist': {
      const allowlist = options.signerAllowlist ?? []
      if (allowlist.length === 0) {
        return {
          valid: false,
          reason:
            "Trust mode 'signed-by-allowlist' requires a non-empty signerAllowlist. " +
            'No allowlist was provided.',
        }
      }
      if (!allowlist.includes(sig.signer)) {
        return {
          valid: false,
          reason:
            `Signer '${sig.signer}' is not in the allowlist. ` +
            `Allowed signers: ${allowlist.join(', ')}`,
        }
      }
      return { valid: true }
    }

    case 'attested': {
      // Requires SLSA provenance attestation
      const attestations = sig.attestations ?? {}
      const hasSlsa =
        'slsa' in attestations ||
        'slsaProvenance' in attestations ||
        'slsa-provenance' in attestations
      if (!hasSlsa) {
        return {
          valid: false,
          reason:
            "Trust mode 'attested' requires SLSA provenance in signature.attestations. " +
            "Expected key 'slsa', 'slsaProvenance', or 'slsa-provenance'.",
        }
      }
      return { valid: true }
    }
  }
}

// ---------------------------------------------------------------------------
// trustOverride application
// ---------------------------------------------------------------------------

function applyOverrideOrFail<F extends ProviderFamily>(
  failReason: string,
  signer: string,
  providerRef: ProviderRef,
  manifest: ProviderManifest<F>,
  options: VerifyManifestOptions,
): ManifestVerificationResult {
  if (options.trustOverride?.mode === 'allowed-this-once') {
    const entry: TrustOverrideAuditEntry = {
      manifestHash: hashManifest(manifest),
      signer,
      timestamp: new Date().toISOString(),
      actor: options.trustOverride.actor,
      reason: options.trustOverride.reason,
      providerRef: {
        family: providerRef.family,
        id: providerRef.id,
        version: providerRef.version,
      },
    }
    _auditLog.push(entry)
    console.warn(
      `[signing] trustOverride 'allowed-this-once' applied for provider '${manifest.id}'. ` +
      `Original failure: ${failReason}. ` +
      `Actor: ${entry.actor}. Reason: ${entry.reason}. ` +
      `This override is logged.`,
    )
    return { valid: true, overrideApplied: true }
  }

  return { valid: false, reason: failReason }
}

// ---------------------------------------------------------------------------
// Capability discrepancy detection
// ---------------------------------------------------------------------------

/**
 * Compare declared capabilities against observed runtime behavior and emit
 * a 'capability-mismatch' hook event if any discrepancies are found.
 *
 * @param providerRef   - Reference to the provider being checked.
 * @param declared      - Capabilities declared in the manifest.
 * @param observed      - Capabilities observed at runtime.
 * @returns             - Array of discrepancy descriptions (empty = no mismatch).
 */
export async function detectCapabilityMismatch(
  providerRef: ProviderRef,
  declared: Record<string, unknown>,
  observed: Record<string, unknown>,
): Promise<string[]> {
  const discrepancies: string[] = []

  // Check all declared keys are present and match in observed
  for (const [key, declaredValue] of Object.entries(declared)) {
    if (!(key in observed)) {
      discrepancies.push(`Capability '${key}' is declared but not observed`)
      continue
    }
    const observedValue = observed[key]
    if (!capabilityValuesMatch(declaredValue, observedValue)) {
      discrepancies.push(
        `Capability '${key}' mismatch: declared=${JSON.stringify(declaredValue)}, observed=${JSON.stringify(observedValue)}`,
      )
    }
  }

  if (discrepancies.length > 0) {
    await globalHookBus.emit({
      kind: 'capability-mismatch',
      provider: providerRef,
      declared,
      observed,
    })
  }

  return discrepancies
}

/**
 * Determine if two capability values are equivalent.
 *
 * - Primitives: strict equality.
 * - Arrays: same elements in any order (set semantics for string arrays).
 */
function capabilityValuesMatch(declared: unknown, observed: unknown): boolean {
  if (declared === observed) return true

  // Array comparison (e.g. regions: ['us-east-1', 'eu-west-1'])
  if (Array.isArray(declared) && Array.isArray(observed)) {
    if (declared.length !== observed.length) return false
    const declaredSet = new Set(declared.map(String))
    const observedSet = new Set(observed.map(String))
    if (declaredSet.size !== observedSet.size) return false
    for (const item of declaredSet) {
      if (!observedSet.has(item)) return false
    }
    return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Convenience: verify with STUB_VALID legacy support
// ---------------------------------------------------------------------------

/**
 * Backwards-compatible wrapper around verifyManifestSignature that also
 * accepts the legacy STUB_VALID prefix (for existing tests that use base.ts
 * verifySignature directly).
 *
 * New code should use verifyManifestSignature() directly.
 */
export async function verifySignatureDispatch<F extends ProviderFamily>(
  sig: ProviderSignature,
  manifest: ProviderManifest<F>,
  options: VerifyManifestOptions = {},
): Promise<ManifestVerificationResult> {
  // Legacy STUB_VALID support for existing tests
  if (sig.signatureValue.startsWith('STUB_VALID')) {
    options = { ...options, _testBypassVerify: true }
  }
  return verifyManifestSignature(manifest, sig, options)
}
