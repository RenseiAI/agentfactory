/**
 * agentskills.io Kit Source Adapter
 *
 * Fetches skills from the agentskills.io registry and synthesizes a
 * single-purpose KitManifest per skill. Each imported skill becomes a Kit
 * with a single `provide.skills` entry (a SKILL.md conforming to the
 * agentskills.io specification) so it rides the same Plugin trust model,
 * scope resolution, and composition algorithm as any locally-authored kit.
 *
 * Architecture reference: donmai-architecture/005-kit-manifest-spec.md
 * §Registry sources — "Anthropic Skills registry"
 *
 * API shape (observed / documented):
 *   GET https://agentskills.io/api/v1/skills
 *   GET https://agentskills.io/api/v1/skills/:id
 *
 * If the agentskills.io API shape changes, set AGENTSKILLS_API_BASE to
 * override the base URL, or extend AgentSkillsApiSkill.
 *
 * Trust model:
 * - Synthesized kits carry authorIdentity from the skill's `publisher` field.
 * - Signature verification is STUB_VALID (permissive OSS mode, same as
 *   PluginLoader). Full sigstore wiring is.
 * - Imported kits use the same validateKitManifest() path as local kits.
 */

import {
  type KitManifest,
  type KitProvide,
  type SkillRef,
  KIT_API_VERSION,
  validateKitManifest,
} from '../manifest.js'

// ---------------------------------------------------------------------------
// API surface (agentskills.io registry)
// ---------------------------------------------------------------------------

/** Base URL for the agentskills.io registry. Override via AGENTSKILLS_API_BASE env var. */
export const AGENTSKILLS_API_BASE = 'https://agentskills.io/api/v1'

/**
 * A single skill entry as returned by the agentskills.io API.
 *
 * This shape follows the agentskills.io specification. If the registry
 * ships an official OpenAPI spec, update these types.
 */
export interface AgentSkillsApiSkill {
  /** Stable skill identifier, e.g. "anthropic/web-search" */
  id: string
  /** Human-readable name */
  name: string
  /** Short description */
  description?: string
  /** SemVer of this skill release */
  version: string
  /**
   * URL to the SKILL.md content conforming to the agentskills.io spec.
   * The host loads this as the skill file; remote refs are resolved at
   * session provision time.
   */
  skillUrl: string
  /** Publisher identity (used as kit authorIdentity) */
  publisher?: string
  /** Homepage or source URL */
  homepage?: string
  /** SPDX license identifier */
  license?: string
  /** Relevant work types (optional; omit = applicable to all work types) */
  workTypes?: string[]
  /** Tags for discovery (informational, not used in detection) */
  tags?: string[]
}

/** List response from GET /skills */
export interface AgentSkillsApiListResponse {
  skills: AgentSkillsApiSkill[]
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
 * Synthesize a KitManifest from an agentskills.io skill.
 *
 * The synthesized kit:
 * - Has id `agentskills/<skill.id>`
 * - Carries no detect rules (always-applicable, single-purpose)
 * - Carries no toolchain demands
 * - Contains a single `provide.skills` entry pointing to the SKILL.md URL
 * - Is tagged with composition order `project`
 */
export function agentSkillToKitManifest(skill: AgentSkillsApiSkill): KitManifest {
  const skillRef: SkillRef = {
    id: skill.id,
    // URL used as the file reference; host resolves remote skill refs
    file: skill.skillUrl,
  }

  const provide: KitProvide = {
    skills: [skillRef],
  }

  const manifest: KitManifest = {
    api: KIT_API_VERSION,
    kit: {
      id: `agentskills/${skill.id}`,
      version: skill.version,
      name: skill.name,
      description: skill.description,
      author: skill.publisher,
      authorIdentity: skill.publisher
        ? `did:web:agentskills.io/publishers/${encodeURIComponent(skill.publisher)}`
        : undefined,
      license: skill.license,
      homepage: skill.homepage,
      // agentskills.io skills: single-purpose, lowest priority vs local/bundled kits
      priority: 10,
    },
    // No [supports] — skills are platform-agnostic
    // No [detect] — always-applicable single-purpose kit
    provide,
    composition: {
      order: 'project',
    },
  }

  return manifest
}

// ---------------------------------------------------------------------------
// AgentSkillsKitSource
// ---------------------------------------------------------------------------

export interface AgentSkillsKitSourceOptions {
  /** Base URL override; defaults to AGENTSKILLS_API_BASE. */
  apiBase?: string
  /** Bearer token for authenticated requests (optional; public registry is open). */
  apiToken?: string
  /**
   * Maximum number of skills to fetch per listing call.
   * Defaults to 100. Set to 0 for no limit (follow all cursors).
   */
  maxSkills?: number
  /** Filter by tag (e.g. "web", "code", "anthropic") — passed as query param. */
  filterTags?: string[]
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
 * agentskills.io Kit Source adapter.
 *
 * Fetches skills from agentskills.io and synthesizes a KitManifest per skill
 * so they integrate seamlessly with the Kit composition runtime.
 *
 * Usage:
 * ```typescript
 * const source = new AgentSkillsKitSource({ apiToken: process.env.AGENTSKILLS_API_TOKEN })
 * const results = await source.fetchAll()
 * const manifests = results.filter(r => r.valid).map(r => r.manifest)
 * ```
 */
export class AgentSkillsKitSource {
  private readonly apiBase: string
  private readonly apiToken?: string
  private readonly maxSkills: number
  private readonly filterTags: string[]
  private readonly fetchFn: FetchFn

  constructor(options: AgentSkillsKitSourceOptions = {}) {
    this.apiBase = (options.apiBase ?? AGENTSKILLS_API_BASE).replace(/\/$/, '')
    this.apiToken = options.apiToken
    this.maxSkills = options.maxSkills ?? 100
    this.filterTags = options.filterTags ?? []
    this.fetchFn = options.fetchFn ?? fetch
  }

  /**
   * Fetch a single skill by id and synthesize a KitManifest.
   */
  async fetchById(skillId: string): Promise<KitSourceResult> {
    const url = `${this.apiBase}/skills/${encodeURIComponent(skillId)}`
    const skill = await this.getJson<AgentSkillsApiSkill>(url)
    return this.skillToResult(skill, url)
  }

  /**
   * Fetch all skills (up to `maxSkills`) and synthesize KitManifests.
   * Follows the cursor-based pagination if the registry returns one.
   */
  async fetchAll(): Promise<KitSourceResult[]> {
    const results: KitSourceResult[] = []
    let cursor: string | undefined
    let fetched = 0

    do {
      const params = new URLSearchParams()
      if (cursor) params.set('cursor', cursor)
      if (this.filterTags.length > 0) {
        params.set('tags', this.filterTags.join(','))
      }

      const qs = params.toString()
      const url = qs ? `${this.apiBase}/skills?${qs}` : `${this.apiBase}/skills`

      const page = await this.getJson<AgentSkillsApiListResponse>(url)

      for (const skill of page.skills) {
        if (this.maxSkills > 0 && fetched >= this.maxSkills) break
        results.push(
          this.skillToResult(
            skill,
            `${this.apiBase}/skills/${encodeURIComponent(skill.id)}`,
          ),
        )
        fetched++
      }

      cursor = page.nextCursor
    } while (cursor && (this.maxSkills === 0 || fetched < this.maxSkills))

    return results
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private skillToResult(skill: AgentSkillsApiSkill, sourceUrl: string): KitSourceResult {
    const manifest = agentSkillToKitManifest(skill)
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
        `agentskills.io registry request failed: ${response.status} ${response.statusText} — ${url}`,
      )
    }

    return response.json() as Promise<T>
  }
}
