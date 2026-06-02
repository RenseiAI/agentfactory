/**
 * Plugin Manifest Types and Validation
 *
 * Defines the TypeScript types for the `rensei-plugin.yaml` manifest format
 * and the validation logic that enforces schema, semver, namespace, and
 * signature constraints at install time.
 *
 * Architecture reference: rensei-architecture/015-plugin-spec.md
 *
 * Key rules enforced here:
 * - Every verb id must start with `<plugin.metadata.id>.` (namespace enforcement)
 * - apiVersion must be 'rensei.dev/v1', kind must be 'Plugin'
 * - metadata.version must be valid semver
 * - auth scope set is captured atomically (one OAuth per install)
 */

import { parse as parseYaml } from 'yaml'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ProviderFamily, ProviderSignature } from '../providers/base.js'

// ---------------------------------------------------------------------------
// Plugin manifest — top-level YAML document
// ---------------------------------------------------------------------------

/**
 * The `rensei-plugin.yaml` manifest kind. A Plugin is the unit of
 * distribution — one installable artifact, one OAuth grant, atomic lifecycle.
 *
 * See 015-plugin-spec.md for the full field semantics.
 */
export interface PluginManifest {
  /** Always 'rensei.dev/v1' */
  apiVersion: 'rensei.dev/v1'
  /** Always 'Plugin' */
  kind: 'Plugin'

  metadata: PluginMetadata

  /** Host compatibility range (SemVer range expression). */
  engines: {
    rensei: string
  }

  /** OS + arch support matrix. Optional — omit to allow all. */
  supports?: {
    os?: string[]
    arch?: string[]
  }

  /**
   * Provider Family registrations — typed arrays keyed by family name.
   * Each entry becomes a registration into that family's resolver.
   */
  providers?: Partial<Record<ProviderFamily | string, ProviderRegistration[]>>

  /** Flat verb registry. Registry validates namespace prefix at install. */
  verbs?: VerbDeclaration[]

  /** Singular webhook surface (one URL, event-type discriminator in payload). */
  events?: PluginEvents

  /**
   * Auth declaration. Atomic per-plugin — one flow grants the full scope set.
   * No capability-level scoping allowed (ADR-2026-04-27 Decision 1).
   */
  auth?: PluginAuth

  /** Path to a JSON Schema file used to render the config form at install. */
  configSchema?: string

  /** Prometheus-style metrics prefix for this plugin's metrics. */
  metricsPrefix?: string

  /** Structured logging scope label. */
  logScope?: string

  /**
   * Manifest signature. Optional in OSS; required in SaaS allow-listed mode.
   * Reuses the ProviderSignature shape from the provider base contract.
   */
  signature?: PluginSignature
}

// ---------------------------------------------------------------------------
// PluginMetadata
// ---------------------------------------------------------------------------

export interface PluginMetadata {
  /** Globally unique plugin id within the registry. Used as verb namespace prefix. */
  id: string
  /** Human-readable display name. */
  name: string
  /** SemVer. */
  version: string
  description?: string
  author?: string
  /** DID or URL of the author identity (for signature trust chain). */
  authorIdentity?: string
  license?: string
  homepage?: string
  repository?: string
  iconUrl?: string
}

// ---------------------------------------------------------------------------
// ProviderRegistration
// ---------------------------------------------------------------------------

/**
 * A single provider implementation entry within a plugin manifest.
 * Matches `ProviderRegistration<F>` from 015-plugin-spec.md.
 */
export interface ProviderRegistration {
  /** Globally unique within the family — must be namespaced `<pluginId>.<name>`. */
  id: string
  /**
   * Module-path + export separator: `'./dist/providers/foo.js#FooProvider'`
   * Resolved relative to the plugin's package root.
   */
  class: string
  /** Flat capability struct declared up-front. */
  capabilities?: Record<string, unknown>
  /** Override the plugin's default scope for this specific provider. */
  scope?: string
}

// ---------------------------------------------------------------------------
// VerbDeclaration
// ---------------------------------------------------------------------------

/**
 * A single workflow verb registered by the plugin.
 * Namespace enforcement: id MUST start with `<plugin.metadata.id>.`
 */
export interface VerbDeclaration {
  /**
   * Fully-qualified verb id. Must start with `<pluginId>.`
   * Examples: 'vercel.deploy', 'vercel.deployment.completed'
   */
  id: string
  description?: string
  /**
   * Verb kind. Tells the workflow engine how to place this verb in a graph.
   * Defaults to 'action'.
   */
  kind?: 'action' | 'condition' | 'trigger' | 'gate'
  /** Path to a JSON Schema file. Resolved relative to the plugin package root. */
  inputSchema?: string
  /** Path to a JSON Schema file. Resolved relative to the plugin package root. */
  outputSchema?: string
  /** Provider id from this plugin's `providers` map that backs this verb. */
  implementedBy?: string
  sideEffectClass?: 'read-only' | 'external-write' | 'internal-only'
  /** Expression evaluated against the input to produce an idempotency key. */
  idempotencyKey?: string
  /** Pipe-delimited event type ids this gate verb subscribes to. */
  eventSubscription?: string
  /** When true the verb is deprecated. */
  deprecated?: boolean
  deprecatedSince?: string
  deprecatedAfter?: string
  /** Successor verb id for deprecated verbs. */
  successor?: string
}

// ---------------------------------------------------------------------------
// PluginEvents
// ---------------------------------------------------------------------------

export interface PluginEvents {
  /** URL path prefix for this plugin's webhook ingress. */
  webhookPath: string
  /** HTTP header name that carries the webhook signature. */
  signatureHeader?: string
  /** Signing algorithm used by the upstream system. */
  signatureAlgorithm?: string
  /** Event type ids this plugin emits (single-URL, payload-discriminated). */
  types: string[]
}

// ---------------------------------------------------------------------------
// PluginAuth
// ---------------------------------------------------------------------------

export interface PluginAuth {
  type: 'oauth2' | 'apiKey' | 'bearer' | 'none'
  authUrl?: string
  tokenUrl?: string
  /** Full scope set granted atomically. No capability-level partial grants. */
  scopes?: string[]
  refreshable?: boolean
  /** When true, one install covers the entire Rensei org (not per-user). */
  perOrgInstall?: boolean
}

// ---------------------------------------------------------------------------
// PluginSignature — same shape as ProviderSignature from base.ts
// ---------------------------------------------------------------------------

/**
 * Reuses the ProviderSignature shape so the same verification pattern from
 * providers/base.ts can be applied to plugin manifests.
 */
export type PluginSignature = ProviderSignature

// ---------------------------------------------------------------------------
// Canonical hashing helpers
// ---------------------------------------------------------------------------

/**
 * Produce a canonical-JSON string from a value (mirrors base.ts canonicalJson).
 * Keys sorted recursively, no extra whitespace.
 */
export function canonicalJsonPlugin(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJsonPlugin).join(',') + ']'
  }
  const sorted = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + canonicalJsonPlugin((value as Record<string, unknown>)[k]))
    .join(',')
  return '{' + sorted + '}'
}

/**
 * Compute the canonical SHA-256 hash of a plugin manifest, excluding the
 * `signature` block (which would otherwise create a circular dependency).
 * Returns a lowercase hex string.
 */
export function hashPluginManifest(manifest: PluginManifest): string {
  // Strip the signature block before hashing
  const { signature: _sig, ...rest } = manifest
  const canonical = canonicalJsonPlugin(rest)
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

export interface PluginSignatureVerificationResult {
  valid: boolean
  reason?: string
  /**
   * When true, structural checks all passed but a real cryptographic
   * verification is still required via the async verifier path.
   * The loader uses this flag to dispatch to the registered verifier instead
   * of treating the sync result as a final failure.
   */
  needsAsyncVerify?: boolean
}

/**
 * Verify the signature attached to a plugin manifest.
 *
 * Checks in order:
 * 1. manifest.signature.manifestHash must match hashPluginManifest(manifest)
 * 2. signatureValue must be present and non-empty
 * 3. publicKey must be present and non-empty
 * 4. Cryptographic check — dispatches to the registered verifier for the
 *    algorithm (sigstore, cosign, minisign, ed25519) via signing.ts.
 *    Tests use signatureValue starting with 'STUB_VALID' or _testBypassVerify.
 *
 * If no signature is present, returns valid=true (OSS mode accepts unsigned).
 *
 * Note: This function is synchronous. Full async verification (including
 * Rekor/Fulcio lookups for sigstore) is available via verifyManifestSignature()
 * in providers/signing.ts.
 */
export function verifyPluginSignature(
  manifest: PluginManifest,
  options?: { _testBypassVerify?: boolean }
): PluginSignatureVerificationResult {
  if (!manifest.signature) {
    return { valid: true, reason: 'no signature present (unsigned plugin accepted in OSS mode)' }
  }

  const sig = manifest.signature

  // 1. Hash check
  const expectedHash = hashPluginManifest(manifest)
  if (sig.manifestHash !== expectedHash) {
    return {
      valid: false,
      reason: `manifestHash mismatch: got ${sig.manifestHash}, expected ${expectedHash}`,
    }
  }

  // 2. Structural checks
  if (!sig.signatureValue || sig.signatureValue.trim().length === 0) {
    return { valid: false, reason: 'signatureValue is empty' }
  }
  // publicKey is required for keyed algorithms (ed25519, minisign).
  // For keyless algorithms (sigstore, cosign) the cert chain travels in
  // the bundle so publicKey may be empty.
  const requiresPublicKey = sig.algorithm !== 'sigstore' && sig.algorithm !== 'cosign'
  if (requiresPublicKey && (!sig.publicKey || sig.publicKey.trim().length === 0)) {
    return {
      valid: false,
      reason: `publicKey is empty for algorithm '${sig.algorithm}'`,
    }
  }

  // 3. Cryptographic verification
  if (options?._testBypassVerify) {
    return { valid: true }
  }

  // Test-only stub prefixes — ONLY accepted when NODE_ENV === 'test'.
  // In production these prefixes are treated as invalid signatures so an
  // attacker cannot craft signatureValue:"STUB_VALID_pwned" to bypass
  // verification.
  const isTestEnv = process.env.NODE_ENV === 'test'

  if (sig.signatureValue.startsWith('STUB_VALID')) {
    if (isTestEnv) {
      return { valid: true }
    }
    return {
      valid: false,
      reason:
        'signatureValue prefix "STUB_VALID" is only accepted in test environments ' +
        '(NODE_ENV=test). Use a real cryptographic signature in production.',
    }
  }

  if (
    sig.signatureValue.startsWith('SIGSTORE_TEST:') ||
    sig.signatureValue.startsWith('COSIGN_TEST:')
  ) {
    if (isTestEnv) {
      return { valid: true }
    }
    return {
      valid: false,
      reason:
        'signatureValue test prefixes ("SIGSTORE_TEST:", "COSIGN_TEST:") are only accepted ' +
        'in test environments (NODE_ENV=test). Use a real cryptographic signature in production.',
    }
  }

  // Structural checks all passed. Cryptographic verification requires the
  // async path — callers that support async (e.g. PluginLoader.installPlugin)
  // must dispatch to the registered verifier via getVerifier() from
  // providers/verifiers/index.ts. The needsAsyncVerify flag signals this.
  return {
    valid: false,
    needsAsyncVerify: true,
    reason:
      `Cryptographic verification for algorithm '${sig.algorithm}' requires the async path. ` +
      `Use verifyManifestSignature() from providers/signing.ts, or use ` +
      `signatureValue starting with "STUB_VALID" / pass _testBypassVerify: true for tests.`,
  }
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

export interface PluginManifestValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Validate a parsed PluginManifest against the schema, semver, namespace, and
 * signature constraints defined in 015-plugin-spec.md.
 *
 * Checks:
 * 1. apiVersion === 'rensei.dev/v1'
 * 2. kind === 'Plugin'
 * 3. metadata.id (non-empty), metadata.name (non-empty), metadata.version (semver)
 * 4. engines.rensei present
 * 5. Every verb id starts with `<metadata.id>.` (namespace enforcement)
 * 6. Every provider id starts with `<metadata.id>.` (namespace enforcement)
 * 7. Signature structural integrity (if present)
 *
 * Returns { valid, errors[] } — all violations collected before returning.
 */
export function validatePluginManifest(manifest: PluginManifest): PluginManifestValidationResult {
  const errors: string[] = []

  // 1. apiVersion
  if (manifest.apiVersion !== 'rensei.dev/v1') {
    errors.push(`apiVersion must be 'rensei.dev/v1', got '${manifest.apiVersion}'`)
  }

  // 2. kind
  if (manifest.kind !== 'Plugin') {
    errors.push(`kind must be 'Plugin', got '${manifest.kind}'`)
  }

  // 3. metadata
  if (!manifest.metadata) {
    errors.push('metadata block is required')
  } else {
    const { id, name, version } = manifest.metadata

    if (!id || id.trim().length === 0) {
      errors.push('metadata.id must be a non-empty string')
    }
    if (!name || name.trim().length === 0) {
      errors.push('metadata.name must be a non-empty string')
    }
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
      errors.push(`metadata.version '${version}' is not a valid semver string`)
    }
  }

  // 4. engines
  if (!manifest.engines?.rensei) {
    errors.push('engines.rensei must be a non-empty semver range string')
  }

  // 5. Verb namespace enforcement
  const pluginId = manifest.metadata?.id
  if (pluginId && manifest.verbs?.length) {
    for (const verb of manifest.verbs) {
      if (!verb.id.startsWith(`${pluginId}.`)) {
        errors.push(
          `plugin '${pluginId}' declares verb '${verb.id}' — must start with '${pluginId}.'`
        )
      }
    }
  }

  // 6. Provider namespace enforcement
  if (pluginId && manifest.providers) {
    for (const [family, registrations] of Object.entries(manifest.providers)) {
      if (!registrations) continue
      for (const reg of registrations) {
        if (!reg.id.startsWith(`${pluginId}.`)) {
          errors.push(
            `plugin '${pluginId}' registers provider '${reg.id}' in family '${family}' — ` +
            `provider id must start with '${pluginId}.'`
          )
        }
      }
    }
  }

  // 7. Signature structural integrity (if present)
  if (manifest.signature) {
    const sig = manifest.signature
    const expectedHash = hashPluginManifest(manifest)
    if (sig.manifestHash !== expectedHash) {
      errors.push(
        `signature.manifestHash mismatch: stored '${sig.manifestHash}', computed '${expectedHash}'`
      )
    }
    if (!sig.signatureValue || sig.signatureValue.trim().length === 0) {
      errors.push('signature.signatureValue must not be empty')
    }
    // publicKey is required for keyed algorithms (ed25519, minisign).
    // For keyless algorithms (sigstore OIDC, cosign keyless) the cert chain
    // travels inside the bundle, so publicKey may legitimately be empty.
    const requiresPublicKey = sig.algorithm !== 'sigstore' && sig.algorithm !== 'cosign'
    if (requiresPublicKey && (!sig.publicKey || sig.publicKey.trim().length === 0)) {
      errors.push(
        `signature.publicKey must not be empty for algorithm '${sig.algorithm}'`
      )
    }
  }

  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a `rensei-plugin.yaml` string into a PluginManifest object.
 * Throws on YAML syntax errors.
 */
export function parsePluginManifest(yamlContent: string): PluginManifest {
  const parsed = parseYaml(yamlContent)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Plugin manifest must be a YAML object')
  }
  return parsed as PluginManifest
}

/**
 * Load and parse a `rensei-plugin.yaml` file from disk.
 * Throws on file-system or YAML syntax errors.
 */
export function loadPluginManifestFile(filePath: string): PluginManifest {
  const content = fs.readFileSync(filePath, 'utf-8')
  return parsePluginManifest(content)
}

/**
 * Discover all plugin manifest files in a directory.
 * Matches: `*.plugin.yaml`, `*.plugin.json`, `rensei-plugin.yaml`
 * Returns an array of absolute file paths.
 */
export function discoverPluginFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return []
  }
  const entries = fs.readdirSync(directory)
  return entries
    .filter(
      (f) =>
        f.endsWith('.plugin.yaml') ||
        f.endsWith('.plugin.json') ||
        f === 'rensei-plugin.yaml'
    )
    .map((f) => path.join(directory, f))
}
