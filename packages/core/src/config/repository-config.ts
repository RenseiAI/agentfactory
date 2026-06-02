/**
 * Repository Configuration
 *
 * Loads and validates the declarative .donmai/config.yaml file.
 * This config controls repository-level settings such as:
 * - Git remote validation (repository field)
 * - Project allowlisting for the orchestrator (allowedProjects field)
 */

import { z } from 'zod'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import YAML from 'yaml'
import type { ProvidersConfig, ModelsConfig } from '../providers/index.js'
import type { RoutingConfig } from '../routing/types.js'
import type { ProfileConfig, DispatchConfig } from './profiles.js'

// ---------------------------------------------------------------------------
// Zod Schema
// ---------------------------------------------------------------------------

/** Per-project configuration (object form of projectPaths values) */
export const ProjectConfigSchema = z.object({
  /** Root directory for this project within the repo */
  path: z.string(),
  /** Package manager override for this project */
  packageManager: z.enum(['pnpm', 'npm', 'yarn', 'bun', 'none']).optional(),
  /** Build command override for this project */
  buildCommand: z.string().optional(),
  /** Test command override for this project */
  testCommand: z.string().optional(),
  /** Validation command override for this project */
  validateCommand: z.string().optional(),
})

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>

/**
 * projectPaths values can be a string (path shorthand) or a full ProjectConfig object.
 * String values are normalized to { path: value } by getProjectConfig().
 */
const ProjectPathValueSchema = z.union([z.string(), ProjectConfigSchema])

/** Valid agent provider names */
const AgentProviderNameSchema = z.enum(['claude', 'codex', 'amp', 'spring-ai', 'a2a'])

/** Normalized effort levels (provider-agnostic) */
export const EffortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh'])

/** Sub-agent configuration within a profile */
const SubAgentProfileSchema = z.object({
  provider: AgentProviderNameSchema.optional(),
  model: z.string().optional(),
  effort: EffortLevelSchema.optional(),
})

/** Named profile: bundles provider + model + effort + provider-specific config */
export const ProfileConfigSchema = z.object({
  provider: AgentProviderNameSchema,
  model: z.string().optional(),
  effort: EffortLevelSchema.optional(),
  subAgent: SubAgentProfileSchema.optional(),
  openai: z.record(z.string(), z.any()).optional(),
  anthropic: z.record(z.string(), z.any()).optional(),
  codex: z.record(z.string(), z.any()).optional(),
  gemini: z.record(z.string(), z.any()).optional(),
})

/** Dispatch config: maps work types and projects to profile names */
export const DispatchConfigSchema = z.object({
  default: z.string(),
  byWorkType: z.record(z.string(), z.string()).optional(),
  byProject: z.record(z.string(), z.string()).optional(),
})

/** Provider selection configuration */
export const ProvidersConfigSchema = z.object({
  /** Default provider for all agents */
  default: AgentProviderNameSchema.optional(),
  /** Provider overrides by work type (e.g., { qa: 'codex' }) */
  byWorkType: z.record(z.string(), AgentProviderNameSchema).optional(),
  /** Provider overrides by project name (e.g., { Social: 'codex' }) */
  byProject: z.record(z.string(), AgentProviderNameSchema).optional(),
})

/**
 * Model selection configuration.
 *
 * Controls which model ID is passed to providers. Model IDs are free-form strings
 * (e.g., 'claude-sonnet-4-6', 'claude-opus-4-6', 'gpt-5-codex') and are passed
 * through to the provider SDK without validation — each provider interprets them.
 *
 * Resolution cascade (highest priority wins):
 * 1. Platform dispatch override (QueuedWork.model)
 * 2. Issue label (model:<id>)
 * 3. Config models.byWorkType
 * 4. Config models.byProject
 * 5. Env var AGENT_MODEL_{WORKTYPE}
 * 6. Env var AGENT_MODEL_{PROJECT}
 * 7. Config models.default
 * 8. Env var AGENT_MODEL
 * 9. Provider default (no override)
 */
export const ModelsConfigSchema = z.object({
  /** Default model for all agents (e.g., 'claude-sonnet-4-6') */
  default: z.string().optional(),
  /** Model overrides by work type (e.g., { development: 'claude-opus-4-6', qa: 'claude-sonnet-4-6' }) */
  byWorkType: z.record(z.string(), z.string()).optional(),
  /** Model overrides by project name (e.g., { Agent: 'claude-opus-4-6' }) */
  byProject: z.record(z.string(), z.string()).optional(),
  /** Default model for Task sub-agents spawned by coordinators (e.g., 'claude-sonnet-4-6') */
  subAgent: z.string().optional(),
})

/** Routing configuration for MAB-based provider selection */
export const RoutingConfigSectionSchema = z.object({
  /** Enable MAB-based intelligent routing (default: false) */
  enabled: z.boolean().default(false),
  /** Exploration rate for Thompson Sampling (0-1, default: 0.1) */
  explorationRate: z.number().min(0).max(1).default(0.1),
  /** Observation window size (default: 100) */
  windowSize: z.number().int().positive().default(100),
  /** Discount factor for older observations (default: 0.99) */
  discountFactor: z.number().min(0).max(1).default(0.99),
  /** Minimum observations before exploiting (default: 5) */
  minObservationsForExploit: z.number().int().min(0).default(5),
  /** Change detection threshold (default: 0.2) */
  changeDetectionThreshold: z.number().min(0).default(0.2),
})

/** Deployment provider configuration */
export const DeploymentConfigSchema = z.object({
  /** Deployment provider to use for status checks */
  provider: z.enum(['vercel', 'none']).default('vercel'),
  /** Provider-specific options */
  options: z.record(z.string(), z.any()).optional(),
})

/** Git identity configuration for backstop commits */
export const GitConfigSchema = z.object({
  /** Git author name override */
  authorName: z.string().optional(),
  /** Git author email override */
  authorEmail: z.string().email().optional(),
})

export const RepositoryConfigSchema = z.object({
  apiVersion: z.string(),
  kind: z.literal('RepositoryConfig'),
  repository: z.string().optional(),
  allowedProjects: z.array(z.string()).optional(),
  /**
   * Maps Linear project names to their root directory or full config.
   * String shorthand: { Family: 'apps/family' }
   * Object form: { 'Family iOS': { path: 'apps/family-ios', packageManager: 'none', buildCommand: 'make build' } }
   */
  projectPaths: z.record(z.string(), ProjectPathValueSchema).optional(),
  /** Shared directories that any project's agent may modify (e.g., ['packages/ui']) */
  sharedPaths: z.array(z.string()).optional(),
  /**
   * Command to invoke the Linear CLI (default: "pnpm af-linear").
   * For non-Node projects, set to a path or wrapper script, e.g.:
   *   "npx -y @donmai/cli af-linear"
   *   "./tools/af-linear.sh"
   *   "/usr/local/bin/af-linear"
   */
  linearCli: z.string().optional(),
  /**
   * Package manager used by the project (default: "pnpm").
   * Set to "none" for non-Node projects (disables dependency linking and helper scripts).
   * Supported values: "pnpm" | "npm" | "yarn" | "bun" | "none"
   */
  packageManager: z.enum(['pnpm', 'npm', 'yarn', 'bun', 'none']).optional(),
  /**
   * Build command override (e.g. 'cargo build', 'cmake --build build', 'make').
   * Injected into workflow templates as {{buildCommand}}.
   */
  buildCommand: z.string().optional(),
  /**
   * Test command override (e.g. 'cargo test', 'ctest --test-dir build', 'make test').
   * Injected into workflow templates as {{testCommand}}.
   */
  testCommand: z.string().optional(),
  /**
   * Validation command override — replaces typecheck for compiled projects
   * (e.g. 'cargo clippy', 'go vet ./...').
   * Injected into workflow templates as {{validateCommand}}.
   */
  validateCommand: z.string().optional(),
  /**
   * Provider selection configuration.
   * Allows routing agents to different providers by work type or project.
   */
  providers: ProvidersConfigSchema.optional(),
  /**
   * Model selection configuration.
   * Controls which model ID agents use, with per-work-type and per-project overrides.
   */
  models: ModelsConfigSchema.optional(),
  /**
   * Routing configuration for MAB-based intelligent provider selection.
   * When enabled, Thompson Sampling is used to learn optimal provider routing.
   */
  routing: RoutingConfigSectionSchema.optional(),
  /**
   * Merge queue configuration.
   * Controls which merge queue provider agents use for automated merging.
   */
  mergeQueue: z.object({
    /** Merge queue provider to use */
    provider: z.enum(['github-native', 'local', 'mergify', 'trunk']).default('local'),
    /** Whether merge queue integration is enabled */
    enabled: z.boolean().default(false),
    /** Automatically add approved PRs to merge queue */
    autoMerge: z.boolean().default(true),
    /** Required CI checks that must pass before merge (provider-specific) */
    requiredChecks: z.array(z.string()).optional(),
    /** Merge strategy: rebase, merge, or squash */
    strategy: z.enum(['rebase', 'merge', 'squash']).default('rebase'),
    /** Command to run after rebase (e.g., test suite) */
    testCommand: z.string().default('pnpm test'),
    /** Timeout for test command in milliseconds */
    testTimeout: z.number().default(300_000),
    /** Regenerate lock files after rebase */
    lockFileRegenerate: z.boolean().default(true),
    /** Use mergiraf for syntax-aware conflict resolution */
    mergiraf: z.boolean().default(true),
    /** Queue polling interval in milliseconds */
    pollInterval: z.number().default(10_000),
    /** Maximum retries for failed merges */
    maxRetries: z.number().default(2),
    /** Escalation policy for conflicts and test failures */
    escalation: z.object({
      onConflict: z.enum(['reassign', 'notify', 'park']).default('reassign'),
      onTestFailure: z.enum(['notify', 'park', 'retry']).default('notify'),
    }).optional(),
    /** Delete PR branch after successful merge */
    deleteBranchOnMerge: z.boolean().default(true),
    /** Maximum concurrent merge operations (default 1 for backward compat) */
    concurrency: z.number().min(1).default(1),
  }).optional(),
  /**
   * Worktree configuration.
   * Controls where git worktrees are created and how paths are resolved.
   */
  worktree: z.object({
    /**
     * Base directory template for git worktrees.
     * Supports template variables: {repoName} (repo directory basename), {branch} (worktree branch name).
     * Default: '../{repoName}.wt' (sibling directory, outside repo to avoid VSCode file watcher crashes).
     * Legacy: '.worktrees' (inside repo, causes VSCode crashes with many worktrees).
     */
    directory: z.string().default('../{repoName}.wt'),
  }).optional(),
  /**
   * Git merge driver to use in agent worktrees.
   * 'mergiraf' enables syntax-aware merging for supported file types.
   * Defaults to 'default' (standard git line-based merge).
   */
  mergeDriver: z.enum(['mergiraf', 'default']).optional(),
  /**
   * Quality gate configuration.
   * Controls baseline-diff quality checks and ratchet enforcement.
   */
  /**
   * Code intelligence enforcement configuration.
   * Controls whether agents are required to use af_code_* tools before Grep/Glob.
   */
  codeIntelligence: z.object({
    /** Require agents to attempt af_code_* tools before Grep/Glob are allowed */
    enforceUsage: z.boolean().default(false),
    /** Allow Grep/Glob fallback after agent has tried at least one af_code_* tool */
    fallbackAfterAttempt: z.boolean().default(true),
  }).optional(),
  /**
   * System prompt customization.
   * Allows appending project-specific instructions to the agent system prompt.
   * These are added after the standard instruction sections and before AGENTS.md/CLAUDE.md.
   */
  systemPrompt: z.object({
    /** Instructions appended to the system prompt for ALL work types */
    append: z.string().optional(),
    /** Per-work-type instructions (merged with append, not replacing) */
    byWorkType: z.record(z.string(), z.string()).optional(),
  }).optional(),
  quality: z.object({
    /** Enable quality baseline capture at worktree creation and post-session delta check */
    baselineEnabled: z.boolean().default(false),
    /** Enable quality ratchet enforcement in merge queue and CI */
    ratchetEnabled: z.boolean().default(false),
    /** Include boy scout rule instructions in agent prompts */
    boyscoutRule: z.boolean().default(true),
    /** Include TDD workflow instructions in agent prompts */
    tddWorkflow: z.boolean().default(true),
  }).optional(),
  /**
   * Deployment provider configuration.
   * Controls which deployment platform is used for status checks.
   */
  deployment: DeploymentConfigSchema.optional(),
  /**
   * Git identity configuration for backstop commits.
   * Overrides git config user.name/email for agent-authored commits.
   */
  git: GitConfigSchema.optional(),
  /**
   * Named profiles bundling provider + model + effort + provider-specific config.
   * When present with `dispatch`, replaces the flat `providers` and `models` sections.
   */
  profiles: z.record(z.string(), ProfileConfigSchema).optional(),
  /**
   * Dispatch configuration mapping work types and projects to profile names.
   * Required when `profiles` is set.
   */
  dispatch: DispatchConfigSchema.optional(),
}).refine(
  (data) => !(data.allowedProjects && data.projectPaths),
  { message: 'allowedProjects and projectPaths are mutually exclusive — use one or the other' },
).refine(
  (data) => {
    // profiles and dispatch must both be present or both absent
    if (data.profiles && !data.dispatch) return false
    if (data.dispatch && !data.profiles) return false
    return true
  },
  { message: 'profiles and dispatch must both be present — cannot use one without the other' },
).refine(
  (data) => {
    if (!data.profiles || !data.dispatch) return true
    const profileNames = new Set(Object.keys(data.profiles))
    // Validate dispatch.default references an existing profile
    if (!profileNames.has(data.dispatch.default)) return false
    // Validate byWorkType references
    if (data.dispatch.byWorkType) {
      for (const name of Object.values(data.dispatch.byWorkType)) {
        if (!profileNames.has(name)) return false
      }
    }
    // Validate byProject references
    if (data.dispatch.byProject) {
      for (const name of Object.values(data.dispatch.byProject)) {
        if (!profileNames.has(name)) return false
      }
    }
    return true
  },
  { message: 'dispatch references a profile name that does not exist in profiles' },
)

// ---------------------------------------------------------------------------
// TypeScript Type
// ---------------------------------------------------------------------------

export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the effective list of allowed project names.
 * When `projectPaths` is set, the keys are the allowed projects.
 * Otherwise falls back to `allowedProjects`.
 */
export function getEffectiveAllowedProjects(config: RepositoryConfig): string[] | undefined {
  if (config.projectPaths) {
    return Object.keys(config.projectPaths)
  }
  return config.allowedProjects
}

/**
 * Returns the normalized ProjectConfig for a given project name.
 * Handles both string shorthand and object form of projectPaths values.
 * Per-project overrides take precedence over repo-wide defaults.
 */
export function getProjectConfig(config: RepositoryConfig, projectName: string): ProjectConfig | null {
  if (!config.projectPaths) return null
  const value = config.projectPaths[projectName]
  if (value === undefined) return null

  // Normalize string shorthand to object form
  const projectConfig = typeof value === 'string' ? { path: value } : value

  return {
    path: projectConfig.path,
    packageManager: projectConfig.packageManager ?? config.packageManager,
    buildCommand: projectConfig.buildCommand ?? config.buildCommand,
    testCommand: projectConfig.testCommand ?? config.testCommand,
    validateCommand: projectConfig.validateCommand ?? config.validateCommand,
  }
}

/**
 * Returns just the path string for a given project name.
 * Handles both string shorthand and object form.
 */
export function getProjectPath(config: RepositoryConfig, projectName: string): string | undefined {
  if (!config.projectPaths) return undefined
  const value = config.projectPaths[projectName]
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : value.path
}

/**
 * Returns the providers config from a RepositoryConfig, if present.
 * Convenience helper for passing to ProviderResolutionContext.configProviders.
 */
export function getProvidersConfig(config: RepositoryConfig): ProvidersConfig | undefined {
  return config.providers as ProvidersConfig | undefined
}

/**
 * Returns the routing config from a RepositoryConfig, if present.
 * Convenience helper for passing to async provider resolution.
 */
export function getRoutingConfig(config: RepositoryConfig): RoutingConfig | undefined {
  return config.routing as RoutingConfig | undefined
}

/**
 * Returns the models config from a RepositoryConfig, if present.
 * Convenience helper for passing to model resolution.
 */
export function getModelsConfig(config: RepositoryConfig): ModelsConfig | undefined {
  return config.models as ModelsConfig | undefined
}

/**
 * Returns the profiles config from a RepositoryConfig, if present.
 */
export function getProfilesConfig(config: RepositoryConfig): Record<string, ProfileConfig> | undefined {
  return config.profiles as Record<string, ProfileConfig> | undefined
}

/**
 * Returns the dispatch config from a RepositoryConfig, if present.
 */
export function getDispatchConfig(config: RepositoryConfig): DispatchConfig | undefined {
  return config.dispatch as DispatchConfig | undefined
}

/**
 * Returns the deployment config from a RepositoryConfig, if present.
 */
export function getDeploymentConfig(config: RepositoryConfig): z.infer<typeof DeploymentConfigSchema> | undefined {
  return config.deployment
}

/**
 * Returns the git config from a RepositoryConfig, if present.
 */
export function getGitIdentityConfig(config: RepositoryConfig): z.infer<typeof GitConfigSchema> | undefined {
  return config.git
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load and validate .donmai/config.yaml from the given git root.
 *
 * @param gitRoot - The root directory of the git repository
 * @returns The validated RepositoryConfig, or null if the file does not exist
 * @throws {z.ZodError} If the file exists but fails schema validation
 */
export function loadRepositoryConfig(gitRoot: string): RepositoryConfig | null {
  const configPath = resolve(gitRoot, '.donmai', 'config.yaml')
  if (!existsSync(configPath)) {
    return null
  }
  const content = readFileSync(configPath, 'utf-8')
  const parsed = YAML.parse(content)
  return RepositoryConfigSchema.parse(parsed)
}
