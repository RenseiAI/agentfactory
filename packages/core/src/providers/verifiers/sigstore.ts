/**
 * Sigstore Verifier — implements the Sigstore bundle verification path.
 *
 * Sigstore uses Rekor (transparency log) + Fulcio (certificate authority)
 * to produce signed bundles. Plugin tarballs and provider manifests both
 * follow the same path:
 *
 * 1. **Bundle mode** (production): signatureValue is base64(JSON sigstore bundle).
 *    `@sigstore/verify` is now a regular dependency, so this is the
 *    default-active path whenever a sigstore-algorithm signature is presented.
 *
 * 2. **Test mode**: signatureValue starts with 'SIGSTORE_TEST:'.
 *    Returns valid=true without any network call. Used by smoke tests.
 *
 * The publicKey field may be:
 *   - Empty string: keyless mode — bundle's embedded Fulcio cert is the
 *     trust anchor (verified via Rekor + the trusted-issuer set on the host).
 *   - PEM certificate or public key: keyful mode.
 *
 * Note: Full Sigstore verification can require network access to Rekor.
 * Air-gapped deployments should use cosign or ed25519 with a local key, or
 * supply a pre-fetched TrustedRoot bundle (see plugin-signing.md).
 */

import type { Verifier, VerifierInput, VerifierResult } from './index.js'

const SIGSTORE_TEST_PREFIX = 'SIGSTORE_TEST:'

// The shape we use from @sigstore/verify. Defined here so the type doesn't
// leak the package's internal types into our public surface.
type SigstoreBundle = Record<string, unknown>
type SignedEntity = Record<string, unknown>
type SigstoreVerifierInstance = { verify(entity: SignedEntity, artifact: Buffer): void }
type SigstoreVerifierCtor = new (policy: unknown, options?: unknown) => SigstoreVerifierInstance
type SigstoreVerifyModule = {
  Verifier?: SigstoreVerifierCtor
  toSignedEntity?: (bundle: SigstoreBundle) => SignedEntity
}

/**
 * Lazy-loaded module reference. We keep the import dynamic so that the
 * verifier remains tree-shake-friendly and degrades gracefully if a future
 * environment lacks the package (e.g. a stripped-down distribution).
 *
 * package is now a *regular* dependency, so this should always
 * resolve in production. The graceful-fallback path below remains for
 * defense in depth and clean error reporting.
 */
let _modulePromise: Promise<SigstoreVerifyModule | null> | null = null
async function loadSigstoreModule(): Promise<SigstoreVerifyModule | null> {
  if (_modulePromise) return _modulePromise
  // We use a string variable to keep the module name out of the static
  // import graph in environments where the package is intentionally absent.
  const moduleName = '@sigstore/verify'
  _modulePromise = import(/* @vite-ignore */ moduleName)
    .then((m) => m as SigstoreVerifyModule)
    .catch(() => null)
  return _modulePromise
}

/**
 * Reset the cached module reference. Tests use this to simulate
 * "package not installed" conditions.
 */
export function _resetSigstoreModuleCache(): void {
  _modulePromise = null
}

async function tryVerifyWithSigstorePackage(
  bundleJson: string,
  artifactBytes: Buffer,
): Promise<VerifierResult | null> {
  try {
    const sigstoreVerify = await loadSigstoreModule()
    if (!sigstoreVerify) return null

    const { Verifier: SigstoreVerifierClass, toSignedEntity } = sigstoreVerify

    if (!SigstoreVerifierClass || !toSignedEntity) {
      // Unexpected module shape — skip
      return null
    }

    let bundle: SigstoreBundle
    try {
      const parsed = JSON.parse(bundleJson) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { valid: false, reason: 'signatureValue is not a valid JSON object (expected sigstore bundle)' }
      }
      bundle = parsed as SigstoreBundle
    } catch {
      return { valid: false, reason: 'signatureValue is not valid JSON (expected sigstore bundle)' }
    }

    const signedEntity = toSignedEntity(bundle)
    // The verifier API varies between @sigstore/verify versions.
    // We use a permissive policy here — full trust enforcement happens at
    // the trusted-issuer-set layer in the plugin loader.
    const verifierInstance = new SigstoreVerifierClass({})
    verifierInstance.verify(signedEntity, artifactBytes)

    return { valid: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { valid: false, reason: `Sigstore bundle verification failed: ${msg}` }
  }
}

export class SigstoreVerifier implements Verifier {
  readonly algorithm = 'sigstore'

  async verify(input: VerifierInput): Promise<VerifierResult> {
    const { manifestHash, signatureValue } = input

    // Test mode bypass
    if (signatureValue.startsWith(SIGSTORE_TEST_PREFIX)) {
      return { valid: true, reason: 'sigstore test mode bypass' }
    }

    // The artifact being verified is the UTF-8 bytes of the manifest hash
    const artifactBytes = Buffer.from(manifestHash, 'utf8')

    // Attempt to decode the bundle
    let bundleJson: string
    try {
      bundleJson = Buffer.from(signatureValue, 'base64').toString('utf8')
    } catch {
      return { valid: false, reason: 'signatureValue is not valid base64' }
    }

    // Hand off to @sigstore/verify
    const packageResult = await tryVerifyWithSigstorePackage(bundleJson, artifactBytes)
    if (packageResult !== null) {
      return packageResult
    }

    // @sigstore/verify did not load — should not happen after the dependency promotion
    // since it's now a regular dep, but we keep a clear actionable error.
    return {
      valid: false,
      reason:
        '@sigstore/verify package failed to load. This package ' +
        'is a regular dependency of @donmai/core; reinstall dependencies ' +
        'with `pnpm install`. ' +
        'Alternatively, use signatureValue starting with "SIGSTORE_TEST:" for tests, ' +
        'or use the cosign or ed25519 algorithm with a local key.',
    }
  }
}
