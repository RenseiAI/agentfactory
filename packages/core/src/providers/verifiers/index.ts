/**
 * Verifier interface — pluggable signature verification backends.
 *
 * Each algorithm (sigstore, cosign, minisign, ed25519) implements
 * this interface. The signing runtime dispatches to the appropriate
 * verifier based on ProviderSignature.algorithm.
 *
 * Architecture reference: donmai-architecture/002-provider-base-contract.md §Signing and trust
 */

// ---------------------------------------------------------------------------
// Core Verifier interface
// ---------------------------------------------------------------------------

export interface VerifierInput {
  /** The canonical-JSON SHA-256 hex digest that was signed. */
  manifestHash: string
  /** Base64-encoded signature value. */
  signatureValue: string
  /** PEM or multibase-encoded public key. */
  publicKey: string
  /** Signer identity (URL or DID) — used for allowlist matching. */
  signer: string
  /** ISO timestamp when the signature was created. */
  attestedAt: string
  /** Signer-defined attestation extensions (e.g. SLSA provenance). */
  attestations?: Record<string, unknown>
}

export interface VerifierResult {
  valid: boolean
  reason?: string
  /** Attestation-level claims extracted during verification (e.g. SLSA level). */
  claims?: Record<string, unknown>
}

/**
 * A pluggable cryptographic verifier.
 *
 * Implementations are stateless (no constructor side effects). The
 * signing runtime constructs one instance per verification call.
 */
export interface Verifier {
  /**
   * The algorithm discriminant this verifier handles.
   * Matches ProviderSignature.algorithm.
   */
  readonly algorithm: string

  /**
   * Perform cryptographic verification.
   *
   * Must be pure with respect to process state — no global mutations.
   * May be async (e.g. Sigstore requires network for Rekor lookups).
   */
  verify(input: VerifierInput): Promise<VerifierResult>
}

// ---------------------------------------------------------------------------
// Registry of verifiers
// ---------------------------------------------------------------------------

const _registry = new Map<string, Verifier>()

/**
 * Register a verifier implementation for an algorithm.
 * Replaces any existing registration for the same algorithm.
 */
export function registerVerifier(verifier: Verifier): void {
  _registry.set(verifier.algorithm, verifier)
}

/**
 * Look up a registered verifier by algorithm name.
 * Returns undefined if no verifier is registered for the algorithm.
 */
export function getVerifier(algorithm: string): Verifier | undefined {
  return _registry.get(algorithm)
}

/**
 * Return all registered verifier algorithms.
 */
export function listRegisteredAlgorithms(): string[] {
  return Array.from(_registry.keys())
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------
export { Ed25519Verifier } from './ed25519.js'
export { MinisignVerifier } from './minisign.js'
export { CosignVerifier } from './cosign.js'
export { SigstoreVerifier } from './sigstore.js'
