/**
 * Trusted Issuer Set
 *
 * The trusted issuer list is the bridge between the cryptographic
 * verification layer (sigstore / cosign / minisign / ed25519) and the
 * organisation's policy decision: "we accept artifacts signed by these
 * identities, and only these."
 *
 * For Sigstore-keyless signatures (the productionized path) the issuer is
 * the OIDC subject embedded in the Fulcio leaf certificate — typically
 * a GitHub Actions workflow URI of the form:
 *
 *     https://github.com/<org>/<repo>/.github/workflows/<file>@refs/heads/<branch>
 *
 * For keyed algorithms (ed25519, minisign) the issuer is the DID or URL
 * declared in the manifest's `signature.signer` field.
 *
 * # Bootstrap stub
 *
 * This module ships a *placeholder* set. The real Rensei official cert
 * chain is sensitive (governance-level) and lives outside this repo.
 * Operators populate the list at host startup via:
 *
 *     setTrustedIssuerSet({ issuers: [...] })
 *
 * or by passing `trustedIssuers` to PluginLoader. The shipped placeholder
 * is loud enough that any production deployment that forgets to populate
 * it will reject all signed plugins under `strict` trust mode — which is
 * the safe failure direction.
 *
 * # Trust modes
 *
 * - `permissive`: unsigned and untrusted-signer plugins emit a warning but
 *   are accepted. Suitable for OSS / development.
 * - `strict`: unsigned plugins are rejected. Signed plugins must match the
 *   trusted-issuer set. Suitable for SaaS Standard and Enterprise.
 *
 * The trust mode shipped earlier (`signed-by-allowlist`, `attested`)
 * remains the lower-level provider-base concept; this module's
 * `permissive | strict` modes are the *plugin-loader-level* policy gate
 * exposed in 015-plugin-spec §Auth + trust.
 *
 * Architecture references:
 *   - donmai-architecture/015-plugin-spec.md §Auth + trust
 *   - donmai-architecture/002-provider-base-contract.md §Signing and trust
 */

import type { PluginManifest, PluginSignature } from './manifest.js'

// ---------------------------------------------------------------------------
// PluginTrustMode — plugin-loader-level policy gate
// ---------------------------------------------------------------------------

/**
 * The plugin loader's trust mode. This sits one level above the provider-
 * level TrustMode in providers/signing.ts:
 *
 * | Plugin trust mode | Provider trust mode | Behavior on bad signature |
 * |-------------------|---------------------|---------------------------|
 * | permissive        | permissive          | warn, accept              |
 * | strict            | signed-by-allowlist | reject, log               |
 */
export type PluginTrustMode = 'permissive' | 'strict'

// ---------------------------------------------------------------------------
// TrustedIssuer
// ---------------------------------------------------------------------------

/**
 * A single trusted-issuer entry. The host accepts signatures whose
 * `signer` field matches this entry, given the algorithm constraint.
 *
 * For Sigstore keyless: `subject` is the OIDC subject claim on the
 * Fulcio leaf cert (e.g. a GitHub Actions workflow URI).
 *
 * For keyed algorithms (ed25519, minisign): `subject` is the DID or URL
 * of the signer.
 */
export interface TrustedIssuer {
  /** Human-readable label (for logging). */
  name: string
  /** OIDC subject / DID / URL — matched against signature.signer exactly. */
  subject: string
  /** Algorithms this issuer is trusted for. Empty array = all algorithms. */
  algorithms: string[]
  /**
   * Optional notes on the issuer (purpose, scope, contact). Logged when
   * a signature matches.
   */
  notes?: string
}

// ---------------------------------------------------------------------------
// TrustedIssuerSet
// ---------------------------------------------------------------------------

export interface TrustedIssuerSet {
  /** Mode discriminator — informational, not enforced here. */
  mode?: 'placeholder' | 'production'
  /** The trusted issuer list. */
  issuers: TrustedIssuer[]
}

// ---------------------------------------------------------------------------
// Bootstrap stub — REPLACE with real Rensei cert chain at deployment time
// ---------------------------------------------------------------------------

/**
 * Placeholder trusted-issuer set. Ships empty and `mode: 'placeholder'` so
 * any operator who forgets to populate it under `strict` mode gets a loud
 * rejection rather than silent success.
 *
 * **DO NOT** populate this at this layer with the real Rensei cert chain.
 * The chain is governance-sensitive: it is provisioned out-of-band by the
 * platform team and supplied at host startup via:
 *
 *     setTrustedIssuerSet({ mode: 'production', issuers: [...] })
 *
 * Refer to docs/plugin-signing.md §Trusted issuer set.
 */
export const PLACEHOLDER_TRUSTED_ISSUERS: TrustedIssuerSet = {
  mode: 'placeholder',
  issuers: [
    // Example shape — uncomment + populate at deployment.
    // {
    //   name: 'Rensei Official Plugin Workflow',
    //   subject: 'https://github.com/RenseiAI/donmai-libraries/.github/workflows/plugin-sign.yml@refs/heads/main',
    //   algorithms: ['sigstore'],
    //   notes: 'Plugins published from the Rensei monorepo via GH Actions OIDC.',
    // },
    // {
    //   name: 'Rensei Plugin DID',
    //   subject: 'did:web:rensei.dev',
    //   algorithms: ['ed25519', 'minisign'],
    //   notes: 'Long-lived publisher key for non-OIDC publishing channels.',
    // },
  ],
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _activeSet: TrustedIssuerSet = PLACEHOLDER_TRUSTED_ISSUERS

/**
 * Replace the active trusted-issuer set. Hosts call this once at startup
 * after reading their out-of-band trust configuration.
 */
export function setTrustedIssuerSet(set: TrustedIssuerSet): void {
  _activeSet = set
}

/** Return a snapshot of the active trusted-issuer set. */
export function getTrustedIssuerSet(): TrustedIssuerSet {
  return { mode: _activeSet.mode, issuers: _activeSet.issuers.slice() }
}

/** Reset to the placeholder set (for tests / teardown). */
export function resetTrustedIssuerSet(): void {
  _activeSet = PLACEHOLDER_TRUSTED_ISSUERS
}

// ---------------------------------------------------------------------------
// Trust verification
// ---------------------------------------------------------------------------

export interface TrustCheckResult {
  /** Whether the plugin's signer is trusted under the active set + trust mode. */
  trusted: boolean
  /** The matching issuer, if any. */
  matchedIssuer?: TrustedIssuer
  /** Human-readable reason — always populated. */
  reason: string
}

/**
 * Determine whether a plugin manifest's signer is trusted under the
 * active trusted-issuer set and the given trust mode.
 *
 * Behavior:
 *
 * | Has signature? | Mode       | Result                                            |
 * |----------------|------------|---------------------------------------------------|
 * | no             | permissive | trusted=true, reason notes unsigned-acceptance    |
 * | no             | strict     | trusted=false                                     |
 * | yes            | permissive | trusted=true; logs match status                   |
 * | yes            | strict     | trusted=true iff signer is in trusted issuer set  |
 *
 * Pass an explicit `trustedIssuers` to override the module singleton — used
 * by the loader when the operator supplies a per-load trust config.
 */
export function checkTrustedIssuer(
  manifest: PluginManifest,
  options: {
    trustMode: PluginTrustMode
    trustedIssuers?: TrustedIssuerSet
  },
): TrustCheckResult {
  const { trustMode } = options
  const set = options.trustedIssuers ?? _activeSet
  const sig: PluginSignature | undefined = manifest.signature

  if (!sig) {
    if (trustMode === 'permissive') {
      return {
        trusted: true,
        reason: `Plugin '${manifest.metadata.id}' is unsigned; accepted under permissive trust mode.`,
      }
    }
    return {
      trusted: false,
      reason:
        `Plugin '${manifest.metadata.id}' is unsigned; strict trust mode requires a signature ` +
        `from the trusted-issuer set.`,
    }
  }

  const matched = set.issuers.find(
    (i) =>
      i.subject === sig.signer &&
      (i.algorithms.length === 0 || i.algorithms.includes(sig.algorithm)),
  )

  if (matched) {
    return {
      trusted: true,
      matchedIssuer: matched,
      reason:
        `Plugin '${manifest.metadata.id}' signer '${sig.signer}' matched trusted issuer ` +
        `'${matched.name}' (algorithm=${sig.algorithm}).`,
    }
  }

  // Signer is present but not in the trusted set.
  if (trustMode === 'permissive') {
    const placeholderHint =
      set.mode === 'placeholder'
        ? ` (active trusted-issuer set is the placeholder stub — ` +
          `populate via setTrustedIssuerSet() per docs/plugin-signing.md)`
        : ''
    return {
      trusted: true,
      reason:
        `Plugin '${manifest.metadata.id}' signer '${sig.signer}' is not in the trusted-issuer set; ` +
        `accepted under permissive trust mode${placeholderHint}.`,
    }
  }

  const subjects = set.issuers.map((i) => i.subject)
  const allowedStr = subjects.length > 0 ? subjects.join(', ') : '(empty set)'
  const placeholderHint =
    set.mode === 'placeholder'
      ? ` Active trusted-issuer set is the placeholder stub — populate it at ` +
        `host startup via setTrustedIssuerSet() per docs/plugin-signing.md.`
      : ''
  return {
    trusted: false,
    reason:
      `Plugin '${manifest.metadata.id}' signer '${sig.signer}' is not in the trusted-issuer set ` +
      `under strict mode. Trusted subjects: ${allowedStr}.${placeholderHint}`,
  }
}
