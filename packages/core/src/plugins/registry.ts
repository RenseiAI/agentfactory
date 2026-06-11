/**
 * Plugin Registry
 *
 * In-memory store of installed plugins, their registered providers, and their
 * verb registrations. The loader populates this registry; the orchestrator and
 * workflow engine query it.
 *
 * Architecture reference: donmai-architecture/015-plugin-spec.md §Workflow Verb registry
 *
 * Design decisions:
 * - Single-process, in-memory. No persistence layer — persistence is the
 *   orchestrator's concern (it re-runs install on startup if needed).
 * - Verb registry is keyed by verb id (globally unique after namespace
 *   enforcement). Collision is a load-order error, not a silent override.
 * - Provider registry is keyed by `<family>/<providerId>`. Consumers query by
 *   family to get all registered providers for scope resolution.
 */

import type { ProviderFamily } from '../providers/base.js'
import type {
  PluginManifest,
  VerbDeclaration,
  ProviderRegistration,
  PluginAuth,
} from './manifest.js'

// ---------------------------------------------------------------------------
// Plugin lifecycle state
// ---------------------------------------------------------------------------

export type PluginLifecycleState =
  | 'installing'
  | 'installed'      // manifest validated, providers registered, verbs added
  | 'configuring'    // waiting for user config form completion
  | 'enabling'       // activate() is running on all registered providers
  | 'enabled'        // fully active — verbs invokable, webhooks live
  | 'disabling'      // deactivate() running
  | 'disabled'       // paused — verbs unavailable, webhooks suspended
  | 'uninstalling'
  | 'error'          // install/enable/disable failed — details in errorMessage

// ---------------------------------------------------------------------------
// Registered plugin record
// ---------------------------------------------------------------------------

export interface RegisteredPlugin {
  /** The validated plugin manifest. */
  manifest: PluginManifest
  /** Current lifecycle phase. */
  state: PluginLifecycleState
  /** When the plugin was first installed (ISO timestamp). */
  installedAt: string
  /** When state last changed. */
  updatedAt: string
  /** Tenant/org-specific runtime config provided at configure time. */
  runtimeConfig: Record<string, unknown>
  /**
   * The atomic OAuth scope set that was granted at install time.
   * Once set, re-install with a different scope set is rejected unless the
   * operator explicitly re-authorizes (ADR-2026-04-27 §Auth).
   */
  grantedScopes: string[]
  /** Non-empty only when state === 'error'. */
  errorMessage?: string
}

// ---------------------------------------------------------------------------
// Registered provider record
// ---------------------------------------------------------------------------

export interface RegisteredProvider {
  /** The plugin this provider came from. */
  pluginId: string
  /** Provider family. */
  family: ProviderFamily | string
  /** The registration entry from the manifest. */
  registration: ProviderRegistration
  /** State mirrors the owning plugin's lifecycle. */
  state: PluginLifecycleState
}

// ---------------------------------------------------------------------------
// Registered verb record
// ---------------------------------------------------------------------------

export interface RegisteredVerb {
  /** The plugin this verb came from. */
  pluginId: string
  /** The full verb declaration. */
  declaration: VerbDeclaration
  /** Resolved provider for this verb (if implementedBy is set). */
  resolvedProvider?: RegisteredProvider
  /** Whether this verb is available for workflow compilation (state === 'enabled'). */
  available: boolean
}

// ---------------------------------------------------------------------------
// PluginRegistry
// ---------------------------------------------------------------------------

/**
 * Central in-memory registry for installed plugins, their providers, and
 * their workflow verbs.
 *
 * Thread-safety note: this is single-threaded Node.js — no locking needed.
 * All mutations are synchronous and atomic within the event loop.
 */
export class PluginRegistry {
  /** All installed plugins, keyed by plugin id. */
  private readonly plugins = new Map<string, RegisteredPlugin>()

  /**
   * All registered providers, keyed by `<family>/<providerId>`.
   */
  private readonly providers = new Map<string, RegisteredProvider>()

  /**
   * All registered verbs, keyed by verb id.
   */
  private readonly verbs = new Map<string, RegisteredVerb>()

  // -------------------------------------------------------------------------
  // Plugin CRUD
  // -------------------------------------------------------------------------

  /**
   * Register a plugin record. Overwrites any existing record with the same id.
   * Called by the loader during install.
   */
  registerPlugin(record: RegisteredPlugin): void {
    this.plugins.set(record.manifest.metadata.id, record)
  }

  getPlugin(pluginId: string): RegisteredPlugin | undefined {
    return this.plugins.get(pluginId)
  }

  listPlugins(): RegisteredPlugin[] {
    return Array.from(this.plugins.values())
  }

  hasPlugin(pluginId: string): boolean {
    return this.plugins.has(pluginId)
  }

  removePlugin(pluginId: string): boolean {
    return this.plugins.delete(pluginId)
  }

  updatePluginState(
    pluginId: string,
    state: PluginLifecycleState,
    errorMessage?: string
  ): boolean {
    const record = this.plugins.get(pluginId)
    if (!record) return false
    record.state = state
    record.updatedAt = new Date().toISOString()
    if (errorMessage !== undefined) {
      record.errorMessage = errorMessage
    } else if (state !== 'error') {
      delete record.errorMessage
    }
    return true
  }

  // -------------------------------------------------------------------------
  // Provider CRUD
  // -------------------------------------------------------------------------

  /**
   * Register a provider.
   *
   * Key: `<family>/<providerId>`
   *
   * Throws if a provider with the same family+id is already registered by a
   * *different* plugin (same plugin re-registering on reload is allowed).
   */
  registerProvider(provider: RegisteredProvider): void {
    const key = `${provider.family}/${provider.registration.id}`
    const existing = this.providers.get(key)
    if (existing && existing.pluginId !== provider.pluginId) {
      throw new Error(
        `Provider '${provider.registration.id}' in family '${provider.family}' is already ` +
        `registered by plugin '${existing.pluginId}'. ` +
        `Cannot overwrite from plugin '${provider.pluginId}'.`
      )
    }
    this.providers.set(key, provider)
  }

  getProvider(family: string, providerId: string): RegisteredProvider | undefined {
    return this.providers.get(`${family}/${providerId}`)
  }

  /**
   * Return all registered providers for a given family.
   */
  listProvidersForFamily(family: string): RegisteredProvider[] {
    const results: RegisteredProvider[] = []
    for (const [key, provider] of this.providers) {
      if (key.startsWith(`${family}/`)) {
        results.push(provider)
      }
    }
    return results
  }

  /**
   * Remove all providers that were registered by the given plugin.
   */
  removeProvidersForPlugin(pluginId: string): void {
    for (const [key, provider] of this.providers) {
      if (provider.pluginId === pluginId) {
        this.providers.delete(key)
      }
    }
  }

  updateProviderState(family: string, providerId: string, state: PluginLifecycleState): boolean {
    const provider = this.providers.get(`${family}/${providerId}`)
    if (!provider) return false
    provider.state = state
    return true
  }

  // -------------------------------------------------------------------------
  // Verb CRUD
  // -------------------------------------------------------------------------

  /**
   * Register a verb.
   *
   * Throws if a verb with the same id is already registered by a *different*
   * plugin. (Same plugin re-registering on reload is allowed.)
   */
  registerVerb(verb: RegisteredVerb): void {
    const id = verb.declaration.id
    const existing = this.verbs.get(id)
    if (existing && existing.pluginId !== verb.pluginId) {
      throw new Error(
        `Verb '${id}' is already registered by plugin '${existing.pluginId}'. ` +
        `Cannot overwrite from plugin '${verb.pluginId}'.`
      )
    }
    this.verbs.set(id, verb)
  }

  getVerb(verbId: string): RegisteredVerb | undefined {
    return this.verbs.get(verbId)
  }

  listVerbs(): RegisteredVerb[] {
    return Array.from(this.verbs.values())
  }

  /**
   * Return only available verbs (plugin state === 'enabled').
   */
  listAvailableVerbs(): RegisteredVerb[] {
    return this.listVerbs().filter((v) => v.available)
  }

  /**
   * Remove all verbs registered by the given plugin.
   */
  removeVerbsForPlugin(pluginId: string): void {
    for (const [id, verb] of this.verbs) {
      if (verb.pluginId === pluginId) {
        this.verbs.delete(id)
      }
    }
  }

  /**
   * Mark all verbs for a plugin as available or unavailable.
   * Called when the plugin is enabled or disabled.
   */
  setVerbsAvailability(pluginId: string, available: boolean): void {
    for (const verb of this.verbs.values()) {
      if (verb.pluginId === pluginId) {
        verb.available = available
      }
    }
  }

  // -------------------------------------------------------------------------
  // Auth / scope-set helpers
  // -------------------------------------------------------------------------

  /**
   * Check whether a re-install with `newScopes` is compatible with the
   * `existingScopes` that were granted atomically at the original install.
   *
   * Compatible = the new scope set is identical to the existing set.
   * Any difference (addition or removal) requires operator re-authorization.
   *
   * Per ADR-2026-04-27 §Auth, adding scopes re-prompts consent; removing is
   * a major bump. This helper enforces the check — callers decide whether to
   * error or prompt.
   */
  static isScopeSetCompatible(existingScopes: string[], newScopes: string[]): boolean {
    if (existingScopes.length !== newScopes.length) return false
    const existingSet = new Set(existingScopes)
    for (const s of newScopes) {
      if (!existingSet.has(s)) return false
    }
    return true
  }

  // -------------------------------------------------------------------------
  // Snapshot / diagnostics
  // -------------------------------------------------------------------------

  /**
   * Return a plain-object snapshot for logging / diagnostics.
   */
  snapshot(): {
    pluginCount: number
    providerCount: number
    verbCount: number
    plugins: Array<{ id: string; version: string; state: PluginLifecycleState }>
  } {
    return {
      pluginCount: this.plugins.size,
      providerCount: this.providers.size,
      verbCount: this.verbs.size,
      plugins: Array.from(this.plugins.values()).map((p) => ({
        id: p.manifest.metadata.id,
        version: p.manifest.metadata.version,
        state: p.state,
      })),
    }
  }
}

// ---------------------------------------------------------------------------
// Default singleton registry (used by the loader; consumers can inject their own)
// ---------------------------------------------------------------------------

let _defaultRegistry: PluginRegistry | null = null

/**
 * Return the process-level singleton PluginRegistry.
 * Created lazily on first call.
 */
export function getDefaultRegistry(): PluginRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new PluginRegistry()
  }
  return _defaultRegistry
}

/**
 * Replace the default registry. Primarily for testing — allows tests to
 * install a fresh registry before each test without leaking state.
 */
export function setDefaultRegistry(registry: PluginRegistry): void {
  _defaultRegistry = registry
}
