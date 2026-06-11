/**
 * Federated Kit Source Loader
 *
 * Orchestrates kit discovery across multiple registry sources in a
 * configurable order. The default federation order mirrors the spec:
 *
 *   local → bundled → Rensei registry → Tessl → agentskills.io
 *
 * Kits from higher-priority sources shadow those with the same id from
 * lower-priority sources. Conflict resolution follows scope precedence
 * then the `priority` field within the same source.
 *
 * Architecture reference: rensei-architecture/005-kit-manifest-spec.md
 * §Registry sources — "Federation order is the discovery order."
 */

import type { KitManifest } from '../manifest.js'
import { TesslKitSource, type TesslKitSourceOptions, type KitSourceResult } from './tessl.js'
import { AgentSkillsKitSource, type AgentSkillsKitSourceOptions } from './agentskills.js'

// ---------------------------------------------------------------------------
// Federation order
// ---------------------------------------------------------------------------

/**
 * Named registry source labels in the default federation order.
 * Lower index = higher priority.
 */
export type FederationOrder = Array<
  'local' | 'bundled' | 'rensei' | 'tessl' | 'agentskills' | string
>

/**
 * Default federation order per 005-kit-manifest-spec.md §Registry sources.
 *
 *   1. local       — .donmai/kits/*.kit.toml in the workarea (highest priority)
 *   2. bundled     — shipped with the OSS execution layer
 *   3. rensei      — registry.rensei.dev
 *   4. tessl       — registry.tessl.io
 *   5. agentskills — agentskills.io (lowest priority)
 */
export const DEFAULT_FEDERATION_ORDER: FederationOrder = [
  'local',
  'bundled',
  'rensei',
  'tessl',
  'agentskills',
]

// ---------------------------------------------------------------------------
// FederatedKitSourceConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for the federated kit source loader.
 *
 * Tenant config surfaces this via `.donmai/config.yaml`; the loader
 * merges with sensible defaults.
 *
 * Example config.yaml usage:
 * ```yaml
 * kits:
 *   federationOrder: [local, bundled, tessl, agentskills]
 *   tessl:
 *     apiToken: ${TESSL_API_TOKEN}
 *   agentskills:
 *     apiToken: ${AGENTSKILLS_API_TOKEN}
 * ```
 */
export interface FederatedKitSourceConfig {
  /**
   * Ordered list of source names. Sources earlier in the list have higher
   * precedence. Defaults to DEFAULT_FEDERATION_ORDER.
   */
  federationOrder?: FederationOrder

  /** Options forwarded to TesslKitSource. */
  tessl?: TesslKitSourceOptions

  /** Options forwarded to AgentSkillsKitSource. */
  agentskills?: AgentSkillsKitSourceOptions

  /**
   * When true, validation errors on individual kits are logged but do not
   * prevent other kits from loading. Defaults to true (permissive).
   */
  continueOnError?: boolean
}

// ---------------------------------------------------------------------------
// FederatedKitLoader
// ---------------------------------------------------------------------------

export interface FederatedKitLoadResult {
  /** All valid manifests in federation-priority order (deduped by kit id). */
  manifests: KitManifest[]
  /**
   * Raw per-source results including invalid manifests and errors.
   * Useful for diagnostics and debugging.
   */
  raw: Array<{
    source: string
    results: KitSourceResult[]
  }>
  /** Sources that were skipped (disabled or not in federation order). */
  skippedSources: string[]
}

/**
 * Federated Kit Loader.
 *
 * Loads kits from Tessl and agentskills.io in the configured federation
 * order, merges them with local/bundled/registry kits, and deduplicates by
 * kit id (first occurrence wins — higher-priority source wins).
 *
 * Local and bundled kit loading is out of scope here (they use the filesystem
 * loader in detect.ts). This loader handles the remote registry portion.
 *
 * Usage:
 * ```typescript
 * const loader = new FederatedKitLoader({
 *   federationOrder: ['local', 'bundled', 'tessl', 'agentskills'],
 *   tessl: { apiToken: process.env.TESSL_API_TOKEN },
 *   agentskills: { apiToken: process.env.AGENTSKILLS_API_TOKEN },
 * })
 * const { manifests } = await loader.loadRemoteSources()
 * ```
 */
export class FederatedKitLoader {
  private readonly config: Required<FederatedKitSourceConfig>

  constructor(config: FederatedKitSourceConfig = {}) {
    this.config = {
      federationOrder: config.federationOrder ?? DEFAULT_FEDERATION_ORDER,
      tessl: config.tessl ?? {},
      agentskills: config.agentskills ?? {},
      continueOnError: config.continueOnError ?? true,
    }
  }

  /**
   * Load kits from all configured remote sources in federation order.
   *
   * Only the remote sources (tessl, agentskills, and any custom registry)
   * are fetched here. Local and bundled kits are resolved by the caller via
   * the filesystem detection runtime.
   *
   * Kit ids are deduped: the first occurrence (highest-priority source) wins.
   */
  async loadRemoteSources(): Promise<FederatedKitLoadResult> {
    const order = this.config.federationOrder
    const seenIds = new Set<string>()
    const manifests: KitManifest[] = []
    const raw: FederatedKitLoadResult['raw'] = []
    const skippedSources: string[] = []

    for (const sourceName of order) {
      // Local and bundled are handled by the filesystem loader
      if (sourceName === 'local' || sourceName === 'bundled' || sourceName === 'rensei') {
        skippedSources.push(sourceName)
        continue
      }

      let results: KitSourceResult[] = []

      try {
        if (sourceName === 'tessl') {
          const source = new TesslKitSource(this.config.tessl)
          results = await source.fetchAll()
        } else if (sourceName === 'agentskills') {
          const source = new AgentSkillsKitSource(this.config.agentskills)
          results = await source.fetchAll()
        } else {
          // Unknown source — skip
          skippedSources.push(sourceName)
          continue
        }
      } catch (err) {
        if (!this.config.continueOnError) {
          throw err
        }
        // Record error but continue with other sources
        raw.push({
          source: sourceName,
          results: [],
        })
        continue
      }

      raw.push({ source: sourceName, results })

      // Deduplicate: first occurrence wins
      for (const result of results) {
        if (!result.valid) continue
        const kitId = result.manifest.kit.id
        if (!seenIds.has(kitId)) {
          seenIds.add(kitId)
          manifests.push(result.manifest)
        }
      }
    }

    return { manifests, raw, skippedSources }
  }
}
