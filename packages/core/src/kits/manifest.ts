/**
 * Kit Manifest — schema types, parser, and validator
 *
 * Kits are the buildpacks-shaped composition primitive for AI agent sessions.
 * A `kit.toml` declares what workloads the kit applies to (detection), what
 * it contributes to a session (commands, prompt_fragments, tool_permissions,
 * mcp_servers, skills, agents, a2a_skills, intelligence_extractors,
 * workarea_config, hooks, toolchain_install), and composition ordering.
 *
 * Architecture reference: donmai-architecture/005-kit-manifest-spec.md
 *
 * TOML parsing: no @iarna/toml or smol-toml in the root package.json, so
 * this module ships a minimal TOML parser sufficient for the kit.toml schema.
 * The parser handles: string, integer, boolean, array, and inline/section
 * tables. It does NOT support datetime, multi-line strings, or TOML 1.1.
 */

import fs from 'node:fs'

// ---------------------------------------------------------------------------
// Manifest API constant
// ---------------------------------------------------------------------------

export const KIT_API_VERSION = 'rensei.dev/v1' as const

// ---------------------------------------------------------------------------
// [kit] — identity
// ---------------------------------------------------------------------------

export interface KitIdentity {
  /** Globally unique kit id, e.g. 'spring/java', 'default/ts-nextjs' */
  id: string
  /** SemVer */
  version: string
  name: string
  description?: string
  author?: string
  /** DID or URL for signature trust chain */
  authorIdentity?: string
  license?: string
  homepage?: string
  repository?: string
  /**
   * Priority tiebreaker for confidence-tied detection results.
   * Higher numbers win. Default: 50.
   */
  priority?: number
}

// ---------------------------------------------------------------------------
// [supports] — OS / arch gate
// ---------------------------------------------------------------------------

export interface KitSupports {
  /** Supported OS values: 'linux' | 'macos' | 'windows' */
  os: string[]
  /** Supported CPU architectures: 'x86_64' | 'arm64' | 'aarch64' */
  arch: string[]
}

// ---------------------------------------------------------------------------
// [requires] — host-side requirements
// ---------------------------------------------------------------------------

export interface KitRequires {
  /** SemVer range of the rensei host runtime required */
  rensei?: string
  /** Host-side capability tokens required (e.g. 'workarea:toolchain') */
  capabilities?: string[]
}

// ---------------------------------------------------------------------------
// [detect] — detection rules
// ---------------------------------------------------------------------------

/**
 * Declarative content-match rule.
 * Match if `file` exists AND the JSON/YAML path resolves to a truthy value.
 */
export interface ContentMatch {
  file: string
  /** JSON path expression, e.g. "$.dependencies.next" */
  json_path?: string
  /** YAML path expression (dot-separated), e.g. "dependencies.next" */
  yaml_path?: string
  /** Regex to match against the raw file content */
  content_regex?: string
}

/**
 * Toolchain demand pre-declared at detect time so the scheduler can
 * pre-warm the workarea before provide() runs.
 */
export interface ToolchainDemand {
  node?: string
  java?: string
  python?: string
  ruby?: string
  go?: string
  rust?: string
  dotnet?: string
  /** Arbitrary additional toolchain entries */
  [key: string]: string | undefined
}

export interface KitDetect {
  /**
   * Phase 1 — Declarative: match if ANY of these files/globs exist.
   * Evaluated with a fast indexed file-tree lookup (no I/O beyond index).
   */
  files?: string[]
  /**
   * Phase 1 — Declarative: match only if ALL of these files/globs exist.
   */
  files_all?: string[]
  /**
   * Phase 1 — Declarative: structured content matchers.
   */
  content_matches?: ContentMatch[]
  /**
   * Phase 1 — Declarative: exclusion conditions.
   * Kit does NOT match if any of these files exist.
   */
  not_files?: string[]
  /**
   * Phase 2 — Executable: path to detect binary inside the workarea sandbox.
   * Only invoked after Phase 1 declarative match passes.
   * Binary must output a JSON KitDetectResult to stdout.
   */
  exec?: string
  /**
   * Toolchain pre-declaration — revealed at detect time so the scheduler
   * can provision the workarea before provide() runs.
   */
  toolchain?: ToolchainDemand
}

// ---------------------------------------------------------------------------
// [provide.*] — contribution types
// ---------------------------------------------------------------------------

export interface KitCommandSet {
  build?: string
  test?: string
  validate?: string
  /** Arbitrary named commands */
  [name: string]: string | undefined
}

export interface KitPromptFragment {
  /** Handlebars partial name */
  partial: string
  /** Work-type filter — fragment only included when workType matches */
  when?: string[]
  /** Path to the fragment file (relative to kit package root) */
  file: string
}

export interface ToolPermissionGrant {
  /** Shell glob pattern, e.g. "./mvnw *" or "java *" */
  shell?: string
  /** MCP tool glob, e.g. "spring-context:*" */
  mcp?: string
  /** Arbitrary permission description */
  description?: string
}

export interface McpServerSpec {
  name: string
  /** Command to start the MCP server */
  command: string
  args?: string[]
  description?: string
  env?: Record<string, string>
}

export interface SkillRef {
  /** Path to SKILL.md (relative to kit package root) */
  file: string
  /** Optional stable skill id (derived from file if omitted) */
  id?: string
}

export interface AgentDefinitionRef {
  id: string
  /** Path to agent YAML (relative to kit package root) */
  template: string
  /** Work types this agent is activated for */
  work_types?: string[]
}

export interface A2ASkillRef {
  id: string
  description?: string
  /** Path to A2A endpoint YAML */
  endpoint: string
}

export interface IntelligenceExtractorRef {
  name: string
  language: string
  /** AST node kinds this extractor emits, e.g. ['entity', 'repository'] */
  emits: string[]
}

export interface KitWorkareaConfig {
  /** Directories to clean on workarea reset */
  clean_dirs?: string[]
  /** Directories to preserve across workarea releases (e.g., build caches) */
  preserve_dirs?: string[]
}

/**
 * Per-OS toolchain install scripts.
 * Keys are OS names: 'linux' | 'macos' | 'windows'
 */
export type KitToolchainInstall = {
  [os: string]: Record<string, string>
}

/**
 * Per-OS command overrides. Only deviations from the base [provide.commands]
 * need to be specified.
 */
export type KitCommandsOverride = {
  [os: string]: KitCommandSet
}

export interface KitHooksBase {
  /** Script to run once after workarea is acquired and ready */
  post_acquire?: string
  /** Script to run before workarea is released to the pool */
  pre_release?: string
}

export interface KitHooks extends KitHooksBase {
  /**
   * OS-keyed hook overrides. Most-specific match wins (OS-keyed > generic).
   * e.g. `os.windows.post_acquire = 'bin\\setup.cmd'`
   */
  os?: { [os: string]: KitHooksBase }
}

// ---------------------------------------------------------------------------
// [composition] — ordering and conflict declarations
// ---------------------------------------------------------------------------

export type KitOrderGroup = 'foundation' | 'framework' | 'project'

export interface KitComposition {
  /**
   * Kit ids that conflict with this one.
   * Host warns and requires tenant to choose when both apply.
   */
  conflicts_with?: string[]
  /**
   * Kit ids this kit composes well with (informational, not enforced).
   */
  composes_with?: string[]
  /**
   * Ordering group.
   * Apply order: foundation → framework → project
   */
  order?: KitOrderGroup
}

// ---------------------------------------------------------------------------
// KitManifest — top-level parsed document
// ---------------------------------------------------------------------------

export interface KitProvide {
  commands?: KitCommandSet
  tool_permissions?: ToolPermissionGrant[]
  prompt_fragments?: KitPromptFragment[]
  mcp_servers?: McpServerSpec[]
  skills?: SkillRef[]
  agents?: AgentDefinitionRef[]
  a2a_skills?: A2ASkillRef[]
  intelligence_extractors?: IntelligenceExtractorRef[]
  workarea_config?: KitWorkareaConfig
  toolchain_install?: KitToolchainInstall
  commands_override?: KitCommandsOverride
  hooks?: KitHooks
}

export interface KitManifest {
  /** Always 'rensei.dev/v1' */
  api: typeof KIT_API_VERSION
  kit: KitIdentity
  supports?: KitSupports
  requires?: KitRequires
  detect?: KitDetect
  provide?: KitProvide
  composition?: KitComposition
}

// ---------------------------------------------------------------------------
// KitDetectResult — returned by the detect runtime
// ---------------------------------------------------------------------------

export interface KitDetectResult {
  applies: boolean
  confidence: number
  reason?: string
  toolchain?: ToolchainDemand
}

// ---------------------------------------------------------------------------
// Minimal TOML parser
// ---------------------------------------------------------------------------

/**
 * Parse a TOML document sufficient for the kit.toml schema.
 *
 * Supported:
 * - String values (single and double quoted)
 * - Integer and boolean values
 * - Inline arrays: ["a", "b"] and [1, 2]
 * - Section tables: [section] and [section.subsection]
 * - Array-of-tables: [[provide.tool_permissions]], etc.
 * - Dotted keys: key.sub = value
 *
 * Not supported: datetime, multi-line strings, TOML 1.1 features.
 */
export function parseToml(content: string): Record<string, unknown> {
  const lines = content.split('\n')
  const root: Record<string, unknown> = {}

  // Current table path (e.g. ['provide', 'commands'])
  let currentPath: string[] = []
  // Current array-of-tables path (non-empty when inside [[...]])
  let currentAoTPath: string[] | null = null
  // Reference to the current object being written to
  let currentObj: Record<string, unknown> = root

  /**
   * Resolve a dot-separated path against the root, creating intermediate
   * objects as needed. Returns the leaf object and the final key.
   */
  function ensurePath(
    base: Record<string, unknown>,
    parts: string[],
  ): [Record<string, unknown>, string] {
    let cur = base
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (!(part in cur)) {
        cur[part] = {}
      }
      // If it's an array (array-of-tables), use the last element
      if (Array.isArray(cur[part])) {
        const arr = cur[part] as Record<string, unknown>[]
        if (arr.length === 0) {
          arr.push({})
        }
        cur = arr[arr.length - 1]
      } else {
        cur = cur[part] as Record<string, unknown>
      }
    }
    return [cur, parts[parts.length - 1]]
  }

  /**
   * Get the object for the current table path (creating it if needed).
   */
  function resolveCurrentObj(path: string[]): Record<string, unknown> {
    if (path.length === 0) return root
    const [parent, key] = ensurePath(root, path)
    if (!(key in parent)) {
      parent[key] = {}
    }
    if (Array.isArray(parent[key])) {
      const arr = parent[key] as Record<string, unknown>[]
      if (arr.length === 0) arr.push({})
      return arr[arr.length - 1]
    }
    return parent[key] as Record<string, unknown>
  }

  /**
   * Parse a TOML value from a string.
   */
  function parseValue(raw: string): unknown {
    const s = raw.trim()

    // Boolean
    if (s === 'true') return true
    if (s === 'false') return false

    // Integer / float (simple)
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      return s.includes('.') ? parseFloat(s) : parseInt(s, 10)
    }

    // Double-quoted string
    if (s.startsWith('"') && s.endsWith('"')) {
      return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }

    // Single-quoted string
    if (s.startsWith("'") && s.endsWith("'")) {
      return s.slice(1, -1)
    }

    // Array
    if (s.startsWith('[') && s.endsWith(']')) {
      return parseArray(s.slice(1, -1))
    }

    // Inline table
    if (s.startsWith('{') && s.endsWith('}')) {
      return parseInlineTable(s.slice(1, -1))
    }

    // Bare string fallback
    return s
  }

  /**
   * Parse a comma-separated list of TOML values.
   */
  function parseArray(inner: string): unknown[] {
    const items: unknown[] = []
    if (inner.trim() === '') return items

    // Tokenize respecting nested brackets and quotes
    let depth = 0
    let inStr = false
    let strChar = ''
    let start = 0

    for (let i = 0; i <= inner.length; i++) {
      const ch = i < inner.length ? inner[i] : ','
      if (inStr) {
        if (ch === strChar && inner[i - 1] !== '\\') inStr = false
      } else if (ch === '"' || ch === "'") {
        inStr = true
        strChar = ch
      } else if (ch === '[' || ch === '{') {
        depth++
      } else if (ch === ']' || ch === '}') {
        depth--
      } else if (ch === ',' && depth === 0) {
        const token = inner.slice(start, i).trim()
        if (token !== '') items.push(parseValue(token))
        start = i + 1
      }
    }

    return items
  }

  /**
   * Parse an inline table: key = val, key2 = val2
   */
  function parseInlineTable(inner: string): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    if (inner.trim() === '') return obj

    let depth = 0
    let inStr = false
    let strChar = ''
    let start = 0

    const pairs: string[] = []
    for (let i = 0; i <= inner.length; i++) {
      const ch = i < inner.length ? inner[i] : ','
      if (inStr) {
        if (ch === strChar && inner[i - 1] !== '\\') inStr = false
      } else if (ch === '"' || ch === "'") {
        inStr = true
        strChar = ch
      } else if (ch === '[' || ch === '{') {
        depth++
      } else if (ch === ']' || ch === '}') {
        depth--
      } else if (ch === ',' && depth === 0) {
        pairs.push(inner.slice(start, i).trim())
        start = i + 1
      }
    }

    for (const pair of pairs) {
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      const k = pair.slice(0, eq).trim()
      const v = pair.slice(eq + 1).trim()
      obj[k] = parseValue(v)
    }
    return obj
  }

  for (const rawLine of lines) {
    // Strip inline comments (but not within strings)
    let line = ''
    let inStr = false
    let strChar = ''
    for (let i = 0; i < rawLine.length; i++) {
      const ch = rawLine[i]
      if (inStr) {
        line += ch
        if (ch === strChar && rawLine[i - 1] !== '\\') inStr = false
      } else if (ch === '"' || ch === "'") {
        inStr = true
        strChar = ch
        line += ch
      } else if (ch === '#') {
        break // rest is comment
      } else {
        line += ch
      }
    }
    line = line.trim()
    if (!line) continue

    // Array-of-tables: [[path.to.table]]
    const aotMatch = line.match(/^\[\[([^\]]+)\]\]$/)
    if (aotMatch) {
      const path = aotMatch[1].trim().split('.')
      currentAoTPath = path
      currentPath = path

      // Ensure the array exists at the path
      const [parent, key] = ensurePath(root, path)
      if (!Array.isArray(parent[key])) {
        parent[key] = []
      }
      const arr = parent[key] as Record<string, unknown>[]
      const newEntry: Record<string, unknown> = {}
      arr.push(newEntry)
      currentObj = newEntry
      continue
    }

    // Section table: [path.to.table]
    const tableMatch = line.match(/^\[([^\]]+)\]$/)
    if (tableMatch) {
      const path = tableMatch[1].trim().split('.')
      currentPath = path
      currentAoTPath = null
      currentObj = resolveCurrentObj(path)
      continue
    }

    // Key-value pair
    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) continue

    const rawKey = line.slice(0, eqIdx).trim()
    const rawVal = line.slice(eqIdx + 1).trim()

    // Dotted key within current table
    const keyParts = rawKey.split('.').map((k) => k.trim())
    if (keyParts.length === 1) {
      currentObj[rawKey] = parseValue(rawVal)
    } else {
      // Write to sub-path relative to currentObj
      const [parent, leafKey] = ensurePath(currentObj, keyParts)
      parent[leafKey] = parseValue(rawVal)
    }
  }

  return root
}

// ---------------------------------------------------------------------------
// Kit manifest validation
// ---------------------------------------------------------------------------

export interface KitManifestValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * Validate a parsed KitManifest against the schema defined in
 * 005-kit-manifest-spec.md.
 *
 * Checks (all violations collected before returning):
 * 1. api === 'rensei.dev/v1'
 * 2. kit.id — non-empty
 * 3. kit.version — semver
 * 4. kit.name — non-empty
 * 5. supports.os / supports.arch — non-empty arrays when present
 * 6. detect.exec — string when present
 * 7. detect.content_matches — each entry has a file
 * 8. provide.mcp_servers — no duplicate names
 * 9. provide.skills — no duplicate ids
 * 10. provide.agents — no duplicate ids
 * 11. provide.a2a_skills — no duplicate ids
 */
export function validateKitManifest(manifest: KitManifest): KitManifestValidationResult {
  const errors: string[] = []

  // 1. api
  if (manifest.api !== KIT_API_VERSION) {
    errors.push(`api must be '${KIT_API_VERSION}', got '${manifest.api}'`)
  }

  // 2-4. kit identity
  if (!manifest.kit) {
    errors.push('kit block is required')
  } else {
    const { id, version, name } = manifest.kit
    if (!id || id.trim().length === 0) {
      errors.push('kit.id must be a non-empty string')
    }
    if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
      errors.push(`kit.version '${version}' is not a valid semver string`)
    }
    if (!name || name.trim().length === 0) {
      errors.push('kit.name must be a non-empty string')
    }
  }

  // 5. supports
  if (manifest.supports) {
    if (!Array.isArray(manifest.supports.os) || manifest.supports.os.length === 0) {
      errors.push('supports.os must be a non-empty array')
    }
    if (!Array.isArray(manifest.supports.arch) || manifest.supports.arch.length === 0) {
      errors.push('supports.arch must be a non-empty array')
    }
  }

  // 6. detect.exec
  if (manifest.detect?.exec !== undefined && typeof manifest.detect.exec !== 'string') {
    errors.push('detect.exec must be a string path')
  }

  // 7. detect.content_matches
  if (manifest.detect?.content_matches) {
    for (const cm of manifest.detect.content_matches) {
      if (!cm.file || cm.file.trim().length === 0) {
        errors.push('detect.content_matches entries must have a non-empty file field')
      }
    }
  }

  // 8-11. Duplicate checks in provide arrays
  const provide = manifest.provide
  if (provide) {
    // MCP server names must be unique
    if (provide.mcp_servers) {
      const seen = new Set<string>()
      for (const s of provide.mcp_servers) {
        if (seen.has(s.name)) {
          errors.push(`provide.mcp_servers has duplicate name '${s.name}'`)
        }
        seen.add(s.name)
      }
    }

    // Skill ids must be unique (derived from file path if id omitted)
    if (provide.skills) {
      const seen = new Set<string>()
      for (const s of provide.skills) {
        const key = s.id ?? s.file
        if (seen.has(key)) {
          errors.push(`provide.skills has duplicate id/file '${key}'`)
        }
        seen.add(key)
      }
    }

    // Agent ids must be unique
    if (provide.agents) {
      const seen = new Set<string>()
      for (const a of provide.agents) {
        if (seen.has(a.id)) {
          errors.push(`provide.agents has duplicate id '${a.id}'`)
        }
        seen.add(a.id)
      }
    }

    // A2A skill ids must be unique
    if (provide.a2a_skills) {
      const seen = new Set<string>()
      for (const a of provide.a2a_skills) {
        if (seen.has(a.id)) {
          errors.push(`provide.a2a_skills has duplicate id '${a.id}'`)
        }
        seen.add(a.id)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a `kit.toml` string into a KitManifest.
 * Throws on TOML syntax errors (unbalanced brackets, etc.).
 */
export function parseKitManifest(tomlContent: string): KitManifest {
  const parsed = parseToml(tomlContent)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('kit.toml must be a TOML document')
  }
  return parsed as unknown as KitManifest
}

/**
 * Load and parse a `kit.toml` file from disk.
 * Throws on file-system or TOML syntax errors.
 */
export function loadKitManifestFile(filePath: string): KitManifest {
  const content = fs.readFileSync(filePath, 'utf-8')
  return parseKitManifest(content)
}
