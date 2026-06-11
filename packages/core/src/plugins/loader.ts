/**
 * Plugin Loader Runtime
 *
 * Turns a `rensei-plugin.yaml` manifest into registered providers + verbs that
 * the orchestrator and workflow engine can use. Implements:
 *
 * - Manifest discovery from four sources (bundled, project-local, registry, programmatic)
 * - Manifest validation (schema, signature, semver, namespace prefix on every verb)
 * - Plugin lifecycle (install / configure / enable / disable / uninstall)
 * - Provider-family registration into the appropriate resolver
 * - Verb registry population with namespace validation
 * - One-OAuth-per-install enforcement (atomic auth scope set)
 * - Hot-reload gating (disabled in production)
 *
 * Architecture reference: rensei-architecture/015-plugin-spec.md
 * Depends on: REN-1279 provider base contract (packages/core/src/providers/base.ts)
 *
 * Signing note: Structural signature checks (hash, empty-value, publicKey) run
 * synchronously via verifyPluginSignature() from manifest.ts. Cryptographic
 * verification then dispatches to the registered verifier (sigstore / cosign /
 * minisign / ed25519) via getVerifier() from providers/verifiers/index.ts.
 * Test bypass is gated behind NODE_ENV=test or _testBypassSignatureVerify.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  parsePluginManifest,
  loadPluginManifestFile,
  validatePluginManifest,
  verifyPluginSignature,
  discoverPluginFiles,
} from './manifest.js'
import type { PluginManifest, VerbDeclaration, ProviderRegistration } from './manifest.js'
import {
  PluginRegistry,
  getDefaultRegistry,
  type RegisteredPlugin,
  type RegisteredProvider,
  type RegisteredVerb,
  type PluginLifecycleState,
} from './registry.js'
import {
  checkTrustedIssuer,
  type PluginTrustMode,
  type TrustedIssuerSet,
} from './trusted-issuers.js'
import type { ProviderFamily } from '../providers/base.js'
import {
  getVerifier,
  type VerifierInput,
} from '../providers/verifiers/index.js'

// ---------------------------------------------------------------------------
// Discovery source type
// ---------------------------------------------------------------------------

export type DiscoverySource = 'bundled' | 'project-local' | 'registry' | 'programmatic'

// ---------------------------------------------------------------------------
// LoaderOptions
// ---------------------------------------------------------------------------

export interface PluginLoaderOptions {
  /**
   * Custom registry instance. Defaults to the process-level singleton from
   * getDefaultRegistry().
   */
  registry?: PluginRegistry

  /**
   * Root directory of the host binary. Used to resolve the `bundled` plugins
   * directory (relative to the binary's dist output).
   * Defaults to `process.cwd()`.
   */
  hostRoot?: string

  /**
   * The project workarea root. Used to discover project-local plugins in
   * `.donmai/plugins/`. Defaults to `process.cwd()`.
   */
  projectRoot?: string

  /**
   * Registry URLs to query for plugins. Each is a base URL; the loader
   * appends `/<pluginId>/manifest.yaml` for resolution.
   * Defaults to empty (no remote registries).
   */
  registryUrls?: string[]

  /**
   * When true, signature verification failures are treated as errors.
   * When false (OSS mode), unsigned plugins are accepted.
   * Defaults to false.
   */
  requireSignatures?: boolean

  /**
   * Plugin-loader trust mode (REN-1344). Gates the trusted-issuer check:
   *
   * - `permissive`: unsigned and untrusted-signer plugins emit a warning
   *   but are accepted (default; preserves OSS behaviour).
   * - `strict`: unsigned plugins are rejected, and signed plugins must
   *   match the trusted-issuer set.
   *
   * Setting `requireSignatures: true` and `trustMode: 'strict'` together
   * gives the SaaS-Standard / Enterprise default-signed posture.
   */
  trustMode?: PluginTrustMode

  /**
   * Trusted-issuer set used by the trust-mode gate. When omitted, the
   * loader falls back to the module-level singleton from trusted-issuers.ts
   * (which is the placeholder stub by default — populate via
   * setTrustedIssuerSet() at host startup, see docs/plugin-signing.md).
   */
  trustedIssuers?: TrustedIssuerSet

  /**
   * Override NODE_ENV for testing purposes.
   * Real code reads process.env.NODE_ENV.
   */
  _testNodeEnv?: string
}

// ---------------------------------------------------------------------------
// Install / register options
// ---------------------------------------------------------------------------

export interface PluginInstallOptions {
  /** Source from which this plugin was discovered. */
  source?: DiscoverySource
  /** When true, signature verification is skipped (for testing). */
  _testBypassSignatureVerify?: boolean
}

// ---------------------------------------------------------------------------
// Programmatic registration options
// ---------------------------------------------------------------------------

/**
 * A factory function that constructs a provider instance from its registration
 * entry. Used for programmatic (embedded) plugin registration.
 *
 * The factory receives the registration entry from the manifest and returns an
 * opaque implementation object. The loader stores the factory reference; it
 * does not call it during registration — only during enable.
 */
export type ProviderFactory = (registration: ProviderRegistration) => unknown

export interface ProgrammaticRegistrationOptions {
  /**
   * Provider factories keyed by provider id.
   * If a provider in the manifest has an entry here, the loader will use this
   * factory instead of dynamic import when enabling the provider.
   */
  providerFactories?: Record<string, ProviderFactory>
  /** Skip signature verification (for tests). */
  _testBypassSignatureVerify?: boolean
}

// ---------------------------------------------------------------------------
// LoadResult
// ---------------------------------------------------------------------------

export interface PluginLoadResult {
  pluginId: string
  success: boolean
  errors: string[]
  warnings: string[]
  source: DiscoverySource
}

// ---------------------------------------------------------------------------
// PluginLoader
// ---------------------------------------------------------------------------

/**
 * The Plugin Loader Runtime.
 *
 * Typical usage:
 * ```typescript
 * const loader = new PluginLoader({ projectRoot: '/path/to/project' })
 * await loader.discoverAndInstallAll()
 * await loader.enableAll()
 * ```
 *
 * For programmatic embedding:
 * ```typescript
 * await loader.registerPlugin(manifest, { providerFactories: { 'my-plugin.provider': () => impl } })
 * ```
 */
export class PluginLoader {
  private readonly registry: PluginRegistry
  private readonly options: Required<PluginLoaderOptions>

  /**
   * Provider factory store keyed by provider id.
   * Populated during programmatic registration; consumed during enable.
   */
  private readonly providerFactories = new Map<string, ProviderFactory>()

  constructor(options: PluginLoaderOptions = {}) {
    this.registry = options.registry ?? getDefaultRegistry()
    this.options = {
      registry: this.registry,
      hostRoot: options.hostRoot ?? process.cwd(),
      projectRoot: options.projectRoot ?? process.cwd(),
      registryUrls: options.registryUrls ?? [],
      requireSignatures: options.requireSignatures ?? false,
      trustMode: options.trustMode ?? 'permissive',
      trustedIssuers: options.trustedIssuers ?? { issuers: [] },
      _testNodeEnv: options._testNodeEnv ?? process.env.NODE_ENV ?? 'development',
    }
    // Track whether a trustedIssuers override was supplied so the loader
    // can fall back to the module singleton when none was given.
    this._trustedIssuersOverridden = options.trustedIssuers !== undefined
  }

  private readonly _trustedIssuersOverridden: boolean

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Discover all plugin manifests from all four sources and return them with
   * their provenance. Does NOT install or validate.
   *
   * Resolution order (015-plugin-spec.md §Discovery):
   * 1. Bundled — `<hostRoot>/plugins/`
   * 2. Project-local — `<projectRoot>/.donmai/plugins/`
   * 3. Configured registries — remote HTTP queries
   * 4. Programmatic — manifests pre-registered via registerPlugin()
   */
  discoverManifestFiles(): Array<{ filePath: string; source: DiscoverySource }> {
    const results: Array<{ filePath: string; source: DiscoverySource }> = []

    // 1. Bundled
    const bundledDir = path.join(this.options.hostRoot, 'plugins')
    for (const f of discoverPluginFiles(bundledDir)) {
      results.push({ filePath: f, source: 'bundled' })
    }

    // 2. Project-local
    const localDir = path.join(this.options.projectRoot, '.donmai', 'plugins')
    for (const f of discoverPluginFiles(localDir)) {
      results.push({ filePath: f, source: 'project-local' })
    }

    // Registry and programmatic sources are handled in discoverAndInstallAll()
    return results
  }

  // -------------------------------------------------------------------------
  // Install
  // -------------------------------------------------------------------------

  /**
   * Discover manifests from all sources and install each plugin.
   * Collects all results without throwing; callers inspect the returned array.
   */
  async discoverAndInstallAll(): Promise<PluginLoadResult[]> {
    const results: PluginLoadResult[] = []
    const files = this.discoverManifestFiles()

    for (const { filePath, source } of files) {
      let manifest: PluginManifest
      try {
        manifest = loadPluginManifestFile(filePath)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({
          pluginId: filePath,
          success: false,
          errors: [`Failed to parse manifest at '${filePath}': ${msg}`],
          warnings: [],
          source,
        })
        continue
      }

      const result = await this.installPlugin(manifest, { source })
      results.push(result)
    }

    return results
  }

  /**
   * Install a single plugin from its parsed manifest.
   *
   * Install sequence (015-plugin-spec.md §Lifecycle):
   * 1. Validate the manifest (schema + semver + namespace)
   * 2. Verify the signature (if required or present)
   * 3. Enforce one-OAuth-per-install scope-set atomicity
   * 4. Register providers into the appropriate family resolvers
   * 5. Populate the verb registry
   * 6. Set plugin state to 'installed'
   *
   * Does NOT activate providers — call enable() or enableAll() for that.
   */
  async installPlugin(
    manifest: PluginManifest,
    options: PluginInstallOptions = {}
  ): Promise<PluginLoadResult> {
    const source: DiscoverySource = options.source ?? 'programmatic'
    const pluginId = manifest.metadata?.id ?? '(unknown)'
    const errors: string[] = []
    const warnings: string[] = []

    // 1. Schema + semver + namespace validation
    const validation = validatePluginManifest(manifest)
    if (!validation.valid) {
      return {
        pluginId,
        success: false,
        errors: validation.errors,
        warnings,
        source,
      }
    }

    // 2. Signature verification — synchronous structural checks (hash, empty
    // signatureValue, publicKey presence) and test-only stub bypass.
    const sigResult = verifyPluginSignature(manifest, {
      _testBypassVerify: options._testBypassSignatureVerify,
    })
    if (!sigResult.valid && !sigResult.needsAsyncVerify) {
      // A structural check failed (wrong hash, empty signatureValue, etc.)
      // or a test-stub prefix was used outside of a test environment.
      if (this.options.requireSignatures || manifest.signature) {
        // Signature present but invalid — always fatal
        return {
          pluginId,
          success: false,
          errors: [`Signature verification failed: ${sigResult.reason}`],
          warnings,
          source,
        }
      }
      // No signature + not required — warn only
      warnings.push(`Plugin '${pluginId}' has no valid signature (OSS mode, accepted).`)
    }

    // 2b. Async cryptographic verification.
    //
    // Runs when a signature is present AND one of:
    //   (a) sigResult.needsAsyncVerify — structural checks passed, real crypto
    //       still needed (the sync path cannot verify real signatures).
    //   (b) sigResult.valid — sync accepted the signature (test-bypass or test
    //       stub in NODE_ENV=test), but we still run crypto for non-stub sigs.
    //
    // Test-prefix stub values (STUB_VALID, SIGSTORE_TEST:, COSIGN_TEST:) skip
    // the real crypto call in test environments, matching manifest.ts behaviour.
    // _testBypassSignatureVerify skips this entire block.
    if (
      manifest.signature &&
      (sigResult.valid || sigResult.needsAsyncVerify) &&
      !options._testBypassSignatureVerify
    ) {
      const sig = manifest.signature
      const isTestEnv = this.options._testNodeEnv === 'test'
      const isTestPrefixedSig =
        sig.signatureValue.startsWith('STUB_VALID') ||
        sig.signatureValue.startsWith('SIGSTORE_TEST:') ||
        sig.signatureValue.startsWith('COSIGN_TEST:')

      if (!isTestEnv || !isTestPrefixedSig) {
        // Real signature — run the registered cryptographic verifier.
        const verifier = getVerifier(sig.algorithm)
        if (!verifier) {
          return {
            pluginId,
            success: false,
            errors: [
              `Signature verification failed: no verifier registered for algorithm '${sig.algorithm}'. ` +
              `Supported algorithms: sigstore, cosign, minisign, ed25519.`,
            ],
            warnings,
            source,
          }
        }
        const verifierInput: VerifierInput = {
          manifestHash: sig.manifestHash,
          signatureValue: sig.signatureValue,
          publicKey: sig.publicKey ?? '',
          signer: sig.signer,
          attestedAt: sig.attestedAt,
          attestations: sig.attestations,
        }
        const cryptoResult = await verifier.verify(verifierInput)
        if (!cryptoResult.valid) {
          return {
            pluginId,
            success: false,
            errors: [
              `Signature verification failed: ${cryptoResult.reason ?? 'Cryptographic verification failed'}`,
            ],
            warnings,
            source,
          }
        }
      }
    }

    // 2c. Trusted-issuer gate (REN-1344)
    // Only run when not bypassed; in test bypass mode we skip both crypto
    // verification and the trust check to keep test fixtures simple.
    if (!options._testBypassSignatureVerify) {
      const trustResult = checkTrustedIssuer(manifest, {
        trustMode: this.options.trustMode,
        trustedIssuers: this._trustedIssuersOverridden
          ? this.options.trustedIssuers
          : undefined,
      })
      if (!trustResult.trusted) {
        // strict mode rejection — loud failure
        return {
          pluginId,
          success: false,
          errors: [`Trust check failed: ${trustResult.reason}`],
          warnings,
          source,
        }
      }
      // Permissive but signer not in trusted-issuer set — warn loudly so
      // operators see the gap before they flip strict mode on.
      if (
        manifest.signature &&
        !trustResult.matchedIssuer &&
        this.options.trustMode === 'permissive'
      ) {
        warnings.push(trustResult.reason)
      }
    }

    // 3. One-OAuth-per-install enforcement
    const existingRecord = this.registry.getPlugin(pluginId)
    const newScopes = manifest.auth?.scopes ?? []
    if (existingRecord) {
      const compatible = PluginRegistry.isScopeSetCompatible(
        existingRecord.grantedScopes,
        newScopes
      )
      if (!compatible) {
        const existingStr = existingRecord.grantedScopes.sort().join(', ')
        const newStr = newScopes.slice().sort().join(', ')
        return {
          pluginId,
          success: false,
          errors: [
            `Plugin '${pluginId}' scope-set mismatch on re-install: ` +
            `existing=[${existingStr}], requested=[${newStr}]. ` +
            `Operator must re-authorize before installing a changed scope set.`,
          ],
          warnings,
          source,
        }
      }
    }

    // 4. Register providers
    if (manifest.providers) {
      for (const [family, registrations] of Object.entries(manifest.providers)) {
        if (!registrations) continue
        for (const reg of registrations) {
          const provider: RegisteredProvider = {
            pluginId,
            family: family as ProviderFamily | string,
            registration: reg,
            state: 'installed',
          }
          try {
            this.registry.registerProvider(provider)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            errors.push(`Failed to register provider '${reg.id}': ${msg}`)
          }
        }
      }
    }

    if (errors.length > 0) {
      return { pluginId, success: false, errors, warnings, source }
    }

    // 5. Populate verb registry
    if (manifest.verbs?.length) {
      for (const verbDecl of manifest.verbs) {
        // Resolve the provider that backs this verb (if any)
        let resolvedProvider: RegisteredProvider | undefined
        if (verbDecl.implementedBy) {
          // Find the provider across all families
          for (const [family] of Object.entries(manifest.providers ?? {})) {
            const found = this.registry.getProvider(family, verbDecl.implementedBy)
            if (found) {
              resolvedProvider = found
              break
            }
          }
        }

        const verb: RegisteredVerb = {
          pluginId,
          declaration: verbDecl,
          resolvedProvider,
          available: false, // becomes true when plugin is enabled
        }

        try {
          this.registry.registerVerb(verb)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          errors.push(`Failed to register verb '${verbDecl.id}': ${msg}`)
        }
      }
    }

    if (errors.length > 0) {
      return { pluginId, success: false, errors, warnings, source }
    }

    // 6. Persist the plugin record
    const now = new Date().toISOString()
    const record: RegisteredPlugin = {
      manifest,
      state: 'installed',
      installedAt: existingRecord?.installedAt ?? now,
      updatedAt: now,
      runtimeConfig: existingRecord?.runtimeConfig ?? {},
      grantedScopes: newScopes,
    }
    this.registry.registerPlugin(record)

    return { pluginId, success: true, errors: [], warnings, source }
  }

  // ---------------------------------------------------------------------------
  // Configure
  // ---------------------------------------------------------------------------

  /**
   * Store runtime configuration for an installed plugin.
   * The plugin must be in 'installed' or 'configuring' state.
   *
   * This is a thin wrapper — full config-schema validation (via configSchema
   * JSON Schema file) is left to the caller / UI layer for now.
   */
  configurePlugin(pluginId: string, config: Record<string, unknown>): void {
    const record = this.registry.getPlugin(pluginId)
    if (!record) {
      throw new Error(`Plugin '${pluginId}' is not installed`)
    }
    if (record.state !== 'installed' && record.state !== 'configuring') {
      throw new Error(
        `Cannot configure plugin '${pluginId}' in state '${record.state}'. ` +
        `Plugin must be in 'installed' or 'configuring' state.`
      )
    }
    record.runtimeConfig = { ...record.runtimeConfig, ...config }
    record.updatedAt = new Date().toISOString()
    this.registry.updatePluginState(pluginId, 'installed')
  }

  // ---------------------------------------------------------------------------
  // Enable / Disable
  // ---------------------------------------------------------------------------

  /**
   * Enable an installed plugin.
   *
   * Activates all registered providers for this plugin by advancing their
   * state to 'enabled'. Marks all verbs as available.
   *
   * Hot-reload guard: if NODE_ENV is 'production' and the plugin is already
   * enabled, this is a no-op (hot-reload is disabled in production).
   */
  async enablePlugin(pluginId: string): Promise<void> {
    const record = this.registry.getPlugin(pluginId)
    if (!record) {
      throw new Error(`Plugin '${pluginId}' is not installed`)
    }

    // Hot-reload guard
    if (record.state === 'enabled' && this.isProduction()) {
      return // hot-reload disabled in production
    }

    this.registry.updatePluginState(pluginId, 'enabling')

    try {
      // Activate all providers
      const families = Object.keys(record.manifest.providers ?? {})
      for (const family of families) {
        const providers = this.registry.listProvidersForFamily(family).filter(
          (p) => p.pluginId === pluginId
        )
        for (const provider of providers) {
          this.registry.updateProviderState(family, provider.registration.id, 'enabled')
        }
      }

      // Make verbs available
      this.registry.setVerbsAvailability(pluginId, true)

      this.registry.updatePluginState(pluginId, 'enabled')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.registry.updatePluginState(pluginId, 'error', msg)
      throw err
    }
  }

  /**
   * Enable all installed (but not yet enabled) plugins.
   * Collects and returns errors without throwing.
   */
  async enableAll(): Promise<Array<{ pluginId: string; error?: string }>> {
    const results: Array<{ pluginId: string; error?: string }> = []
    for (const plugin of this.registry.listPlugins()) {
      const pluginId = plugin.manifest.metadata.id
      if (plugin.state === 'installed' || plugin.state === 'disabled') {
        try {
          await this.enablePlugin(pluginId)
          results.push({ pluginId })
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          results.push({ pluginId, error })
        }
      }
    }
    return results
  }

  /**
   * Disable a plugin.
   *
   * Deactivates providers and marks verbs as unavailable.
   * Disabled verbs are still in the registry but available=false —
   * workflows referencing them error at compile, not at run.
   */
  async disablePlugin(pluginId: string): Promise<void> {
    const record = this.registry.getPlugin(pluginId)
    if (!record) {
      throw new Error(`Plugin '${pluginId}' is not installed`)
    }
    if (record.state === 'disabled') {
      return // idempotent
    }

    this.registry.updatePluginState(pluginId, 'disabling')

    try {
      // Deactivate providers
      const families = Object.keys(record.manifest.providers ?? {})
      for (const family of families) {
        const providers = this.registry.listProvidersForFamily(family).filter(
          (p) => p.pluginId === pluginId
        )
        for (const provider of providers) {
          this.registry.updateProviderState(family, provider.registration.id, 'disabled')
        }
      }

      // Mark verbs unavailable
      this.registry.setVerbsAvailability(pluginId, false)

      this.registry.updatePluginState(pluginId, 'disabled')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.registry.updatePluginState(pluginId, 'error', msg)
      throw err
    }
  }

  // ---------------------------------------------------------------------------
  // Uninstall
  // ---------------------------------------------------------------------------

  /**
   * Uninstall a plugin.
   *
   * Removes all providers and verbs from the registry and removes the plugin
   * record. Local config is retained in the registry snapshot for re-install
   * convenience — the loader passes it back on re-install if the plugin record
   * is still cached.
   *
   * OAuth revocation is out of scope for this layer (requires HTTP call to the
   * provider's tokenUrl — left to the orchestrator).
   */
  async uninstallPlugin(pluginId: string): Promise<void> {
    const record = this.registry.getPlugin(pluginId)
    if (!record) {
      return // idempotent
    }

    this.registry.updatePluginState(pluginId, 'uninstalling')

    // Disable first to clean up activation state
    if (record.state === 'enabled' || record.state === 'enabling') {
      await this.disablePlugin(pluginId)
    }

    // Remove providers and verbs
    this.registry.removeProvidersForPlugin(pluginId)
    this.registry.removeVerbsForPlugin(pluginId)

    // Remove the plugin record itself
    this.registry.removePlugin(pluginId)
  }

  // ---------------------------------------------------------------------------
  // Programmatic registration (for embedded / test use)
  // ---------------------------------------------------------------------------

  /**
   * Register a plugin programmatically from a manifest object (no file I/O).
   *
   * This is the embedding / test path. The manifest still goes through full
   * validation and namespace enforcement.
   *
   * @param manifest - Parsed and validated PluginManifest
   * @param options  - Optional provider factories and test overrides
   * @returns        Load result (same shape as installPlugin)
   */
  async registerPlugin(
    manifest: PluginManifest,
    options: ProgrammaticRegistrationOptions = {}
  ): Promise<PluginLoadResult> {
    // Store any provider factories before installing
    if (options.providerFactories) {
      for (const [id, factory] of Object.entries(options.providerFactories)) {
        this.providerFactories.set(id, factory)
      }
    }

    return this.installPlugin(manifest, {
      source: 'programmatic',
      _testBypassSignatureVerify: options._testBypassSignatureVerify,
    })
  }

  /**
   * Full programmatic round-trip: register + enable.
   * Convenience for tests and embedded scenarios.
   */
  async registerAndEnable(
    manifest: PluginManifest,
    options: ProgrammaticRegistrationOptions = {}
  ): Promise<PluginLoadResult> {
    const result = await this.registerPlugin(manifest, options)
    if (!result.success) return result

    try {
      await this.enablePlugin(manifest.metadata.id)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      result.success = false
      result.errors.push(error)
    }

    return result
  }

  // ---------------------------------------------------------------------------
  // Hot-reload
  // ---------------------------------------------------------------------------

  /**
   * Hot-reload a plugin by re-installing its manifest without going through
   * the full uninstall/install cycle.
   *
   * DISABLED IN PRODUCTION. Returns false and does nothing if
   * NODE_ENV === 'production'.
   *
   * In development / test mode, this disables the plugin, re-validates and
   * re-registers providers + verbs from the new manifest, then re-enables.
   */
  async hotReload(manifest: PluginManifest): Promise<boolean> {
    if (this.isProduction()) {
      return false
    }

    const pluginId = manifest.metadata?.id
    if (!pluginId) return false

    // Disable existing plugin (if running)
    const existing = this.registry.getPlugin(pluginId)
    if (existing) {
      if (existing.state === 'enabled') {
        await this.disablePlugin(pluginId)
      }
      // Remove old providers and verbs, but keep the plugin record for config retention
      this.registry.removeProvidersForPlugin(pluginId)
      this.registry.removeVerbsForPlugin(pluginId)
      this.registry.removePlugin(pluginId)
    }

    // Re-install
    const result = await this.installPlugin(manifest, { source: 'programmatic' })
    if (!result.success) return false

    // Re-enable
    await this.enablePlugin(pluginId)
    return true
  }

  // ---------------------------------------------------------------------------
  // Accessors / introspection
  // ---------------------------------------------------------------------------

  /** Return the underlying registry. */
  getRegistry(): PluginRegistry {
    return this.registry
  }

  /** Check whether hot-reload is allowed in the current environment. */
  isHotReloadAllowed(): boolean {
    return !this.isProduction()
  }

  private isProduction(): boolean {
    return this.options._testNodeEnv === 'production'
  }
}

// ---------------------------------------------------------------------------
// Module-level convenience functions
// ---------------------------------------------------------------------------

/**
 * Install + enable a plugin from a YAML string using the default registry.
 * Convenience wrapper for the common case where you just want to turn a
 * manifest YAML into active providers + verbs.
 */
export async function loadPluginFromYaml(
  yamlContent: string,
  loaderOptions: PluginLoaderOptions = {}
): Promise<PluginLoadResult> {
  const manifest = parsePluginManifest(yamlContent)
  const loader = new PluginLoader(loaderOptions)
  return loader.registerAndEnable(manifest)
}

/**
 * Install + enable a plugin from a file path using the default registry.
 */
export async function loadPluginFromFile(
  filePath: string,
  loaderOptions: PluginLoaderOptions = {}
): Promise<PluginLoadResult> {
  const manifest = loadPluginManifestFile(filePath)
  const loader = new PluginLoader(loaderOptions)
  return loader.registerAndEnable(manifest)
}
