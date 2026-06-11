/**
 * Legacy Bridge — RepositoryConfig.projectPaths → KitManifest
 *
 * Reads legacy `projectPaths` overrides from a RepositoryConfig and
 * synthesizes in-memory KitManifest objects so the kit composition pipeline
 * sees them.  Consumers do NOT need to migrate their
 * config files — they get equivalent agent behavior automatically.
 *
 * Architecture reference: donmai-architecture/005-kit-manifest-spec.md
 */

import type { RepositoryConfig, ProjectConfig } from './repository-config.js'
import { getProjectConfig } from './repository-config.js'
import type { KitManifest, KitDetect } from '../kits/manifest.js'
import { KIT_API_VERSION } from '../kits/manifest.js'

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Synthesize a single KitManifest from a legacy ProjectConfig entry.
 *
 * The generated kit:
 * - Has id `project/<slugified-name>` and version `0.0.0`
 * - Declares `[detect]` matching the project path via a path-prefix regex
 * - Provides `[provide.commands]` from the ProjectConfig overrides
 * - Declares `[supports]` defaulting to all common OS+arch when not specified
 * - Carries `composition.order = 'project'` so it overrides foundation/framework kits
 *
 * @param projectName  Linear project name, e.g. "Family iOS"
 * @param config       Normalized ProjectConfig (from getProjectConfig)
 * @returns A valid KitManifest
 */
export function projectConfigToKitManifest(
  projectName: string,
  config: ProjectConfig,
): KitManifest {
  const slug = slugify(projectName)

  // Detection: match when the session's monorepoPath starts with the project path.
  // We use content_matches on a sentinel file that would be present at the root
  // when the monorepoPath is set, BUT the simpler approach for the bridge layer
  // is to emit a path-regex detect against the monorepo path.  Since the kit
  // pipeline receives monorepoPath on the target, we use `files` matching
  // relative to that path.  The bridge always marks applies=true — the host
  // already scope-selects the kit before calling detect.
  const detect: KitDetect = {
    // Match any file under the project path — a package.json is conventional
    // for Node projects; for non-Node projects the path itself is the signal.
    // We list common sentinels; at least one typically exists.
    files: [
      `${config.path}/package.json`,
      `${config.path}/Makefile`,
      `${config.path}/Cargo.toml`,
      `${config.path}/go.mod`,
      `${config.path}/pyproject.toml`,
      `${config.path}/pom.xml`,
      `${config.path}/build.gradle`,
    ],
  }

  // Build the commands section from ProjectConfig overrides
  const commands: Record<string, string> = {}
  if (config.buildCommand) commands.build = config.buildCommand
  if (config.testCommand) commands.test = config.testCommand
  if (config.validateCommand) commands.validate = config.validateCommand

  const manifest: KitManifest = {
    api: KIT_API_VERSION,
    kit: {
      id: `project/${slug}`,
      version: '0.0.0',
      name: projectName,
      description: `Legacy projectPaths bridge for project "${projectName}" (path: ${config.path})`,
      priority: 90, // project-level kits should override framework kits
    },
    supports: {
      // Default to all platforms that the platform currently supports
      os: ['linux', 'macos', 'windows'],
      arch: ['x86_64', 'arm64'],
    },
    detect,
    provide: {
      ...(Object.keys(commands).length > 0 ? { commands } : {}),
    },
    composition: {
      order: 'project',
    },
  }

  return manifest
}

/**
 * Synthesize KitManifests for all `projectPaths` entries in a RepositoryConfig.
 *
 * Only projects that carry at least one per-project override
 * (buildCommand, testCommand, validateCommand, or packageManager) produce a
 * meaningful kit manifest — path-only entries have nothing to contribute to the
 * command set but are still emitted so the detection pipeline can scope them.
 *
 * @param repoConfig  Validated RepositoryConfig (may be null → returns [])
 * @returns           Array of in-memory KitManifests, one per projectPaths entry
 */
export function synthesizeKitsFromLegacyConfig(
  repoConfig: RepositoryConfig | null,
): KitManifest[] {
  if (!repoConfig?.projectPaths) return []

  const kits: KitManifest[] = []

  for (const projectName of Object.keys(repoConfig.projectPaths)) {
    const config = getProjectConfig(repoConfig, projectName)
    if (!config) continue
    kits.push(projectConfigToKitManifest(projectName, config))
  }

  return kits
}

// ---------------------------------------------------------------------------
// TOML serialization helpers (for the migration CLI)
// ---------------------------------------------------------------------------

/**
 * Serialize a KitManifest produced by `projectConfigToKitManifest` to TOML.
 *
 * Only the subset of fields produced by the bridge is serialized.  This is
 * NOT a generic TOML serializer — it is purposely scoped to the shape that
 * the migration CLI writes.
 *
 * @param manifest  A KitManifest as produced by projectConfigToKitManifest
 * @returns         TOML string ready to be written to a `.kit.toml` file
 */
export function serializeKitManifestToToml(manifest: KitManifest): string {
  const lines: string[] = []

  lines.push(`api = "${manifest.api}"`)
  lines.push('')

  // [kit]
  lines.push('[kit]')
  lines.push(`id = "${manifest.kit.id}"`)
  lines.push(`version = "${manifest.kit.version}"`)
  lines.push(`name = "${escapeTomlString(manifest.kit.name)}"`)
  if (manifest.kit.description) {
    lines.push(`description = "${escapeTomlString(manifest.kit.description)}"`)
  }
  if (manifest.kit.priority !== undefined) {
    lines.push(`priority = ${manifest.kit.priority}`)
  }
  lines.push('')

  // [supports]
  if (manifest.supports) {
    lines.push('[supports]')
    lines.push(`os = [${manifest.supports.os.map((v) => `"${v}"`).join(', ')}]`)
    lines.push(`arch = [${manifest.supports.arch.map((v) => `"${v}"`).join(', ')}]`)
    lines.push('')
  }

  // [detect]
  if (manifest.detect) {
    lines.push('[detect]')
    if (manifest.detect.files && manifest.detect.files.length > 0) {
      const files = manifest.detect.files.map((f) => `"${f}"`).join(', ')
      lines.push(`files = [${files}]`)
    }
    lines.push('')
  }

  // [provide.commands]
  if (manifest.provide?.commands && Object.keys(manifest.provide.commands).length > 0) {
    lines.push('[provide.commands]')
    for (const [name, cmd] of Object.entries(manifest.provide.commands)) {
      if (cmd !== undefined) {
        lines.push(`${name} = "${escapeTomlString(cmd)}"`)
      }
    }
    lines.push('')
  }

  // [[provide.prompt_fragments]] — placeholder comment for template references
  lines.push('# Prompt fragment references (templates from partials/ directory):')
  lines.push('# [[provide.prompt_fragments]]')
  lines.push('# partial = "my-partial"')
  lines.push('# when = ["development", "qa"]')
  lines.push('# file = "partials/my-partial.yaml"')
  lines.push('')

  // [composition]
  if (manifest.composition) {
    lines.push('[composition]')
    if (manifest.composition.order) {
      lines.push(`order = "${manifest.composition.order}"`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Slugify a project name into a filesystem- and TOML-safe identifier.
 * e.g. "Family iOS" → "family-ios"
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Escape a string for inclusion inside TOML double-quoted strings.
 */
function escapeTomlString(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
}
