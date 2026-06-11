/**
 * Kit Composition Algorithm
 *
 * Merges contributions from multiple kits into a single KitComposedResult
 * using per-contribution-type composition rules from
 * 005-kit-manifest-spec.md §Composition rules.
 *
 * Rules summary:
 * | Contribution            | Rule                                                 |
 * |-------------------------|------------------------------------------------------|
 * | commands                | Last-applied-wins (foundation kits set defaults;     |
 * |                         | project kits override; per-OS override > generic)    |
 * | prompt_fragments        | Concatenated in apply order                          |
 * | tool_permissions        | Union (anything allowed by any kit is allowed)       |
 * | mcp_servers             | Concatenated; duplicate name is an error             |
 * | skills                  | Concatenated; duplicate id/file is an error          |
 * | agents                  | Concatenated; duplicate id is an error               |
 * | a2a_skills              | Concatenated; duplicate id is an error               |
 * | intelligence_extractors | Concatenated by language+emits                       |
 * | workarea_config.clean   | Union                                                |
 * | workarea_config.preserve| Union                                                |
 * | hooks                   | All run; foundation hooks run first                  |
 *
 * Architecture reference: donmai-architecture/005-kit-manifest-spec.md
 */

import type {
  KitManifest,
  KitCommandSet,
  KitPromptFragment,
  ToolPermissionGrant,
  McpServerSpec,
  SkillRef,
  AgentDefinitionRef,
  A2ASkillRef,
  IntelligenceExtractorRef,
  KitWorkareaConfig,
  KitHooks,
} from './manifest.js'

// ---------------------------------------------------------------------------
// Composed result
// ---------------------------------------------------------------------------

export interface ComposedHook {
  kitId: string
  script: string
}

export interface ComposedHooks {
  post_acquire: ComposedHook[]
  pre_release: ComposedHook[]
}

export interface KitComposedResult {
  /** Effective command set after last-applied-wins merging */
  commands: KitCommandSet

  /** All prompt fragments in apply order */
  promptFragments: KitPromptFragment[]

  /** Union of all tool permissions */
  toolPermissions: ToolPermissionGrant[]

  /** All MCP servers; duplicate name is a composition error */
  mcpServers: McpServerSpec[]

  /** All skills; duplicate id/file is a composition error */
  skills: SkillRef[]

  /** All agents; duplicate id is a composition error */
  agents: AgentDefinitionRef[]

  /** All A2A skills; duplicate id is a composition error */
  a2aSkills: A2ASkillRef[]

  /** All intelligence extractors */
  intelligenceExtractors: IntelligenceExtractorRef[]

  /** Union of workarea clean/preserve dirs */
  workareaConfig: KitWorkareaConfig

  /** All hooks in foundation-first order */
  hooks: ComposedHooks

  /** Non-fatal warnings (e.g., overridden commands) */
  warnings: string[]

  /** Errors that prevent composition (duplicate ids, etc.) */
  errors: string[]
}

// ---------------------------------------------------------------------------
// Composition context
// ---------------------------------------------------------------------------

export interface ComposeOptions {
  /**
   * Active OS — used to apply OS-specific command overrides and hooks.
   * e.g. 'linux', 'macos', 'windows'
   */
  os?: string
  /**
   * Work type for the current session — used to filter prompt fragments.
   * e.g. 'development', 'qa', 'refinement'
   */
  workType?: string
}

// ---------------------------------------------------------------------------
// composeKits — main entry point
// ---------------------------------------------------------------------------

/**
 * Compose contributions from an ordered list of kits.
 *
 * The kits array MUST be ordered: foundation kits first, then framework,
 * then project (i.e. the output of `selectKits()` from detect.ts).
 *
 * @param kits    Ordered list of kits to compose (foundation → project)
 * @param options Composition context (os, workType)
 */
export function composeKits(
  kits: KitManifest[],
  options: ComposeOptions = {},
): KitComposedResult {
  const result: KitComposedResult = {
    commands: {},
    promptFragments: [],
    toolPermissions: [],
    mcpServers: [],
    skills: [],
    agents: [],
    a2aSkills: [],
    intelligenceExtractors: [],
    workareaConfig: { clean_dirs: [], preserve_dirs: [] },
    hooks: { post_acquire: [], pre_release: [] },
    warnings: [],
    errors: [],
  }

  // Tracking sets for duplicate-id detection
  const mcpNames = new Set<string>()
  const skillKeys = new Set<string>()
  const agentIds = new Set<string>()
  const a2aIds = new Set<string>()

  for (const kit of kits) {
    const kitId = kit.kit.id
    const provide = kit.provide
    if (!provide) continue

    // -----------------------------------------------------------------------
    // commands — last-applied-wins
    // Apply base commands first, then OS-specific override (most-specific wins)
    // -----------------------------------------------------------------------
    if (provide.commands) {
      for (const [name, cmd] of Object.entries(provide.commands)) {
        if (cmd !== undefined) {
          if (name in result.commands && result.commands[name] !== cmd) {
            result.warnings.push(
              `Kit '${kitId}' overrides command '${name}' (was '${result.commands[name]}')`
            )
          }
          result.commands[name] = cmd
        }
      }
    }

    // OS-specific command overrides
    if (options.os && provide.commands_override) {
      const osCommands = provide.commands_override[options.os]
      if (osCommands) {
        for (const [name, cmd] of Object.entries(osCommands)) {
          if (cmd !== undefined) {
            result.commands[name] = cmd
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // prompt_fragments — concatenated in apply order, filtered by workType
    // -----------------------------------------------------------------------
    if (provide.prompt_fragments) {
      for (const frag of provide.prompt_fragments) {
        if (isFragmentActive(frag, options.workType)) {
          result.promptFragments.push(frag)
        }
      }
    }

    // -----------------------------------------------------------------------
    // tool_permissions — union (anything allowed by any kit is allowed)
    // -----------------------------------------------------------------------
    if (provide.tool_permissions) {
      result.toolPermissions.push(...provide.tool_permissions)
    }

    // -----------------------------------------------------------------------
    // mcp_servers — concatenated; duplicate name is an error
    // -----------------------------------------------------------------------
    if (provide.mcp_servers) {
      for (const server of provide.mcp_servers) {
        if (mcpNames.has(server.name)) {
          result.errors.push(
            `Duplicate mcp_server name '${server.name}' contributed by kit '${kitId}'`
          )
        } else {
          mcpNames.add(server.name)
          result.mcpServers.push(server)
        }
      }
    }

    // -----------------------------------------------------------------------
    // skills — concatenated; duplicate id/file is an error
    // -----------------------------------------------------------------------
    if (provide.skills) {
      for (const skill of provide.skills) {
        const key = skill.id ?? skill.file
        if (skillKeys.has(key)) {
          result.errors.push(
            `Duplicate skill '${key}' contributed by kit '${kitId}'`
          )
        } else {
          skillKeys.add(key)
          result.skills.push(skill)
        }
      }
    }

    // -----------------------------------------------------------------------
    // agents — concatenated; duplicate id is an error
    // -----------------------------------------------------------------------
    if (provide.agents) {
      for (const agent of provide.agents) {
        if (agentIds.has(agent.id)) {
          result.errors.push(
            `Duplicate agent id '${agent.id}' contributed by kit '${kitId}'`
          )
        } else {
          agentIds.add(agent.id)
          result.agents.push(agent)
        }
      }
    }

    // -----------------------------------------------------------------------
    // a2a_skills — concatenated; duplicate id is an error
    // -----------------------------------------------------------------------
    if (provide.a2a_skills) {
      for (const a2a of provide.a2a_skills) {
        if (a2aIds.has(a2a.id)) {
          result.errors.push(
            `Duplicate a2a_skill id '${a2a.id}' contributed by kit '${kitId}'`
          )
        } else {
          a2aIds.add(a2a.id)
          result.a2aSkills.push(a2a)
        }
      }
    }

    // -----------------------------------------------------------------------
    // intelligence_extractors — concatenated (multiple extractors may emit
    // the same kind; dedup at the memory layer, not here)
    // -----------------------------------------------------------------------
    if (provide.intelligence_extractors) {
      result.intelligenceExtractors.push(...provide.intelligence_extractors)
    }

    // -----------------------------------------------------------------------
    // workarea_config — union of clean_dirs and preserve_dirs
    // -----------------------------------------------------------------------
    if (provide.workarea_config) {
      const wc = provide.workarea_config
      if (wc.clean_dirs) {
        for (const d of wc.clean_dirs) {
          if (!result.workareaConfig.clean_dirs!.includes(d)) {
            result.workareaConfig.clean_dirs!.push(d)
          }
        }
      }
      if (wc.preserve_dirs) {
        for (const d of wc.preserve_dirs) {
          if (!result.workareaConfig.preserve_dirs!.includes(d)) {
            result.workareaConfig.preserve_dirs!.push(d)
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // hooks — all run; foundation hooks run first (maintained by kit order)
    // OS-keyed override: most-specific match wins
    // -----------------------------------------------------------------------
    if (provide.hooks) {
      const hooks = provide.hooks
      const postAcquire = resolveHook(hooks, 'post_acquire', options.os)
      if (postAcquire) {
        result.hooks.post_acquire.push({ kitId, script: postAcquire })
      }
      const preRelease = resolveHook(hooks, 'pre_release', options.os)
      if (preRelease) {
        result.hooks.pre_release.push({ kitId, script: preRelease })
      }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the prompt fragment should be included for the given workType.
 * If the fragment has no `when` filter, it is always included.
 */
function isFragmentActive(frag: KitPromptFragment, workType?: string): boolean {
  if (!frag.when || frag.when.length === 0) return true
  if (!workType) return true
  return frag.when.includes(workType)
}

/**
 * Resolve the effective hook script for a given hook name and OS.
 * OS-keyed hook overrides the generic one (most-specific-match-wins).
 */
function resolveHook(
  hooks: KitHooks,
  hookName: 'post_acquire' | 'pre_release',
  os?: string,
): string | undefined {
  // OS-keyed override wins
  if (os && hooks.os?.[os]?.[hookName]) {
    return hooks.os[os][hookName]
  }
  // Fallback to generic
  return hooks[hookName]
}

// ---------------------------------------------------------------------------
// Toolchain install resolution (per OS)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective toolchain install scripts for the active OS.
 * Merges across all kits; later kits win for the same toolchain key.
 */
export function resolveToolchainInstall(
  kits: KitManifest[],
  os: string,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const kit of kits) {
    const installMap = kit.provide?.toolchain_install
    if (!installMap) continue
    const osScripts = installMap[os]
    if (osScripts) {
      Object.assign(result, osScripts)
    }
  }
  return result
}
