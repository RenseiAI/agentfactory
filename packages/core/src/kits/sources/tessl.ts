/**
 * Tessl Kit Source Adapter
 *
 * Fetches Tessl tiles via the Tessl registry API and synthesizes a
 * single-purpose KitManifest per tile. Tessl tiles ship contribution subsets
 * (skills, docs as prompt fragments, MCP server pointers) — no detect phase,
 * no toolchain demand. The synthesized kit wraps those contributions in the
 * standard Kit manifest shape so they ride the same Plugin trust model and
 * composition algorithm.
 *
 * Architecture reference: donmai-architecture/005-kit-manifest-spec.md
 * §Registry sources — "Tessl registry"
 *
 * API shape (observed / documented):
 *   GET https://registry.tessl.io/v1/tiles
 *   GET https://registry.tessl.io/v1/tiles/:id
 *
 * If the Tessl registry shape changes materially, set TESSL_API_BASE to
 * override the base URL, or extend TesslApiTile.
 *
 * Trust model:
 * - Synthesized kits carry authorIdentity from the tile's `publisher` field.
 * - Signature verification is STUB_VALID (permissive OSS mode, same as
 *   PluginLoader). Full sigstore wiring is.
 * - Imported kits use the same validateKitManifest() path as local kits.
 */

import {
  type KitManifest,
  type KitProvide,
  type McpServerSpec,
  type SkillRef,
  type KitPromptFragment,
  KIT_API_VERSION,
  validateKitManifest,
} from '../manifest.js'

// ---------------------------------------------------------------------------
// API surface (Tessl registry)
// ---------------------------------------------------------------------------

/** Base URL for the Tessl registry. Override via TESSL_API_BASE env var. */
export const TESSL_API_BASE = 'https://registry.tessl.io/v1'

/**
 * A single tile entry as returned by the Tessl registry API.
 *
 * This shape is based on the observed Tessl registry schema. If Tessl ships
 * an official OpenAPI spec, update these types and post a migration comment.
 */
export interface TesslApiTile {
  /** Stable tile identifier, e.g. "tessl/react-docs" */
  id: string
  /** Human-readable name */
  name: string
  /** Short description */
  description?: string
  /** SemVer of this tile release */
  version: string
  /** Publisher identity (used as kit authorIdentity) */
  publisher?: string
  /** Homepage or source URL */
  homepage?: string
  /** SPDX license identifier */
  license?: string

  /** Skill files distributed with this tile (SKILL.md conforming to agentskills.io spec) */
  skills?: TesslApiSkill[]

  /** Documentation fragments (become KitPromptFragment entries) */
  docs?: TesslApiDoc[]

  /** MCP servers this tile exposes */
  mcpServers?: TesslApiMcpServer[]
}

export interface TesslApiSkill {
  /** Stable id, e.g. "tessl/react-docs/react-hooks" */
  id: string
  /** URL to the SKILL.md content */
  url: string
}

export interface TesslApiDoc {
  /** Partial name for Handlebars, e.g. "tessl/react-docs/api-overview" */
  id: string
  /** URL to the Markdown content */
  url: string
  /** Work types this fragment applies to (omit = all types) */
  workTypes?: string[]
}

export interface TesslApiMcpServer {
  /** Unique name for the server, used as McpServerSpec.name */
  name: string
  /** Command to launch the MCP server */
  command: string
  args?: string[]
  description?: string
}

/** List response from GET /tiles */
export interface TesslApiListResponse {
  tiles: TesslApiTile[]
  nextCursor?: string
}

// ---------------------------------------------------------------------------
// Fetch helpers (injectable for testing)
// ---------------------------------------------------------------------------

export type FetchFn = typeof fetch

// ---------------------------------------------------------------------------
// Normalizer
// ---------------------------------------------------------------------------

/**
 * Synthesize a KitManifest from a Tessl tile.
 *
 * The synthesized kit:
 * - Has id `tessl/<tile.id>`
 * - Carries no detect rules (Tessl tiles are always-applicable, single-purpose)
 * - Carries no toolchain demands
 * - Contains only the contribution subset Tessl declares: skills, docs, MCP servers
 * - Is tagged with composition order `project` (overlays on top of framework kits)
 */
export function tesslTileToKitManifest(tile: TesslApiTile): KitManifest {
  const provide: KitProvide = {}

  // Skills
  if (tile.skills && tile.skills.length > 0) {
    provide.skills = tile.skills.map(
      (s): SkillRef => ({
        id: s.id,
        // URL used as the file reference; host resolves remote skill refs
        file: s.url,
      }),
    )
  }

  // Docs → prompt fragments
  if (tile.docs && tile.docs.length > 0) {
    provide.prompt_fragments = tile.docs.map(
      (d): KitPromptFragment => ({
        partial: d.id,
        file: d.url,
        when: d.workTypes,
      }),
    )
  }

  // MCP servers
  if (tile.mcpServers && tile.mcpServers.length > 0) {
    provide.mcp_servers = tile.mcpServers.map(
      (s): McpServerSpec => ({
        name: s.name,
        command: s.command,
        args: s.args,
        description: s.description,
      }),
    )
  }

  const manifest: KitManifest = {
    api: KIT_API_VERSION,
    kit: {
      id: `tessl/${tile.id}`,
      version: tile.version,
      name: tile.name,
      description: tile.description,
      author: tile.publisher,
      authorIdentity: tile.publisher ? `did:web:registry.tessl.io/publishers/${encodeURIComponent(tile.publisher)}` : undefined,
      license: tile.license,
      homepage: tile.homepage,
      // Tessl tiles: single-purpose, low priority vs local/bundled kits
      priority: 20,
    },
    // No [supports] — Tessl tiles are platform-agnostic
    // No [detect] — always-applicable single-purpose kit
    provide: Object.keys(provide).length > 0 ? provide : undefined,
    composition: {
      order: 'project',
    },
  }

  return manifest
}

// ---------------------------------------------------------------------------
// TesslKitSource
// ---------------------------------------------------------------------------

export interface TesslKitSourceOptions {
  /** Base URL override; defaults to TESSL_API_BASE. */
  apiBase?: string
  /** Bearer token for authenticated requests (optional; public registry is open). */
  apiToken?: string
  /**
   * Maximum number of tiles to fetch per listing call.
   * Defaults to 100. Set to 0 for no limit (follow all cursors).
   */
  maxTiles?: number
  /** Custom fetch implementation (injectable for testing). */
  fetchFn?: FetchFn
}

export interface KitSourceResult {
  manifest: KitManifest
  /** Source URL from which the manifest was synthesized */
  sourceUrl: string
  /** Whether the synthesized manifest passed validation */
  valid: boolean
  /** Validation errors, if any */
  errors: string[]
}

/**
 * Tessl Kit Source adapter.
 *
 * Fetches Tessl tiles and synthesizes a KitManifest per tile so they integrate
 * seamlessly with the Kit composition runtime.
 *
 * Usage:
 * ```typescript
 * const source = new TesslKitSource({ apiToken: process.env.TESSL_API_TOKEN })
 * const results = await source.fetchAll()
 * const manifests = results.filter(r => r.valid).map(r => r.manifest)
 * ```
 */
export class TesslKitSource {
  private readonly apiBase: string
  private readonly apiToken?: string
  private readonly maxTiles: number
  private readonly fetchFn: FetchFn

  constructor(options: TesslKitSourceOptions = {}) {
    this.apiBase = (options.apiBase ?? TESSL_API_BASE).replace(/\/$/, '')
    this.apiToken = options.apiToken
    this.maxTiles = options.maxTiles ?? 100
    this.fetchFn = options.fetchFn ?? fetch
  }

  /**
   * Fetch a single tile by id and synthesize a KitManifest.
   */
  async fetchById(tileId: string): Promise<KitSourceResult> {
    const url = `${this.apiBase}/tiles/${encodeURIComponent(tileId)}`
    const tile = await this.getJson<TesslApiTile>(url)
    return this.tileToResult(tile, url)
  }

  /**
   * Fetch all tiles (up to `maxTiles`) and synthesize KitManifests.
   * Follows the cursor-based pagination if the registry returns one.
   */
  async fetchAll(): Promise<KitSourceResult[]> {
    const results: KitSourceResult[] = []
    let cursor: string | undefined
    let fetched = 0

    do {
      const url = cursor
        ? `${this.apiBase}/tiles?cursor=${encodeURIComponent(cursor)}`
        : `${this.apiBase}/tiles`

      const page = await this.getJson<TesslApiListResponse>(url)

      for (const tile of page.tiles) {
        if (this.maxTiles > 0 && fetched >= this.maxTiles) break
        results.push(this.tileToResult(tile, `${this.apiBase}/tiles/${encodeURIComponent(tile.id)}`))
        fetched++
      }

      cursor = page.nextCursor
    } while (cursor && (this.maxTiles === 0 || fetched < this.maxTiles))

    return results
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private tileToResult(tile: TesslApiTile, sourceUrl: string): KitSourceResult {
    const manifest = tesslTileToKitManifest(tile)
    const validation = validateKitManifest(manifest)
    return {
      manifest,
      sourceUrl,
      valid: validation.valid,
      errors: validation.errors,
    }
  }

  private async getJson<T>(url: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    }
    if (this.apiToken) {
      headers['Authorization'] = `Bearer ${this.apiToken}`
    }

    const response = await this.fetchFn(url, { headers })

    if (!response.ok) {
      throw new Error(
        `Tessl registry request failed: ${response.status} ${response.statusText} — ${url}`,
      )
    }

    return response.json() as Promise<T>
  }
}
