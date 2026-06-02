/**
 * Profile Resolution
 *
 * Resolves a named profile for a given spawn context, applying overrides
 * from dispatch config, issue labels, env vars, and platform dispatch.
 *
 * Resolution cascade:
 * 1. Resolve profile name from dispatch (byWorkType > byProject > default)
 * 2. Look up profile -> base provider, model, effort, providerConfig, subAgent
 * 3. Apply overrides in priority order:
 *    - Platform dispatch model (highest; provider auto-switches when the
 *      dispatched model is unambiguously owned by another declared profile
 *      or matches a well-known prefix like `claude-*` / `gpt-*`)
 *    - Issue label provider:/model:
 *    - Mention context
 *    - Env AGENT_PROVIDER_{WORKTYPE} / AGENT_MODEL_{WORKTYPE}
 *    - Env AGENT_PROVIDER / AGENT_MODEL (global fallback)
 */

import type { AgentProviderName } from '../providers/index.js'
import type {
  ProfileConfig,
  DispatchConfig,
  ResolvedProfile,
  SubAgentProfileConfig,
} from './profiles.js'
import { extractProviderConfig } from './effort.js'

// ---------------------------------------------------------------------------
// Context for profile resolution
// ---------------------------------------------------------------------------

export interface ProfileResolutionContext {
  /** Work type (e.g., 'development', 'qa', 'refinement-coordination') */
  workType?: string
  /** Project name (e.g., 'Social') */
  project?: string
  /** Issue labels (scanned for 'provider:<name>' and 'model:<id>') */
  labels?: string[]
  /** Mention text (scanned for 'use <provider>', '@<provider>') */
  mentionContext?: string
  /** Platform-dispatched model override (highest priority) */
  dispatchModel?: string
  /** Platform-dispatched sub-agent model override */
  dispatchSubAgentModel?: string

  /** Profile definitions from config.yaml */
  profiles: Record<string, ProfileConfig>
  /** Dispatch config from config.yaml */
  dispatch: DispatchConfig
}

// ---------------------------------------------------------------------------
// Label/mention extraction helpers
// ---------------------------------------------------------------------------

const VALID_PROVIDERS = new Set(['claude', 'codex', 'amp', 'spring-ai', 'a2a'])

function extractProviderFromLabels(labels: string[]): AgentProviderName | null {
  for (const label of labels) {
    const match = label.match(/^provider:(.+)$/)
    if (match && VALID_PROVIDERS.has(match[1])) {
      return match[1] as AgentProviderName
    }
  }
  return null
}

function extractModelFromLabels(labels: string[]): string | null {
  for (const label of labels) {
    const match = label.match(/^model:(.+)$/)
    if (match) return match[1]
  }
  return null
}

function extractProviderFromMention(mention: string): AgentProviderName | null {
  const lower = mention.toLowerCase()
  for (const provider of VALID_PROVIDERS) {
    if (
      lower.includes(`use ${provider}`) ||
      lower.includes(`@${provider}`) ||
      lower.includes(`provider:${provider}`)
    ) {
      return provider as AgentProviderName
    }
  }
  return null
}

/**
 * Infer the provider for a model name.
 *
 * Resolution: (1) match against any declared profile's `model`; (2) match
 * well-known model-name prefixes. Used to keep (provider, model) pairs
 * coherent when a model override arrives without a matching provider override
 * — e.g., a `dispatchModel` of `claude-opus-4-7` layered onto a codex profile
 * would otherwise produce a 400 from the codex backend.
 *
 * Returns null when inference is ambiguous; callers keep the prior provider.
 */
export function inferProviderForModel(
  model: string,
  profiles: Record<string, ProfileConfig>,
): AgentProviderName | null {
  for (const profile of Object.values(profiles)) {
    if (profile.model === model) return profile.provider
  }
  if (/^claude-/i.test(model)) return 'claude'
  if (/^(gpt-|o1-|o3-|o4-)/i.test(model)) return 'codex'
  return null
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a profile for a given spawn context.
 *
 * The dispatch section selects a profile name (byWorkType > byProject > default),
 * then individual overrides (labels, env vars, dispatch model) patch fields on top.
 */
export function resolveProfileForSpawn(context: ProfileResolutionContext): ResolvedProfile {
  const { profiles, dispatch } = context

  // Step 1: Resolve profile name from dispatch
  let profileName = dispatch.default
  let dispatchSource = 'dispatch.default'

  if (context.workType && dispatch.byWorkType?.[context.workType]) {
    profileName = dispatch.byWorkType[context.workType]
    dispatchSource = `dispatch.byWorkType.${context.workType}`
  } else if (context.project && dispatch.byProject?.[context.project]) {
    profileName = dispatch.byProject[context.project]
    dispatchSource = `dispatch.byProject.${context.project}`
  }

  // Step 2: Look up profile
  const profile = profiles[profileName]
  if (!profile) {
    // Profile not found — fall back to hardcoded default
    return {
      provider: 'claude',
      source: `profile:${profileName} not found, using default`,
    }
  }

  // Start with base profile values
  let provider: AgentProviderName = profile.provider
  let model: string | undefined = profile.model
  let providerSource = `profile:${profileName} via ${dispatchSource}`

  // Step 3: Apply overrides in priority order (lowest to highest)

  // Env var AGENT_PROVIDER (global fallback)
  const globalProvider = process.env.AGENT_PROVIDER
  if (globalProvider && VALID_PROVIDERS.has(globalProvider)) {
    provider = globalProvider as AgentProviderName
    providerSource = `profile:${profileName} + env AGENT_PROVIDER`
  }

  // Env var AGENT_MODEL (global fallback)
  const globalModel = process.env.AGENT_MODEL
  if (globalModel) {
    model = globalModel
    providerSource = `profile:${profileName} + env AGENT_MODEL`
  }

  // Env var AGENT_PROVIDER_{PROJECT}
  if (context.project) {
    const projectKey = `AGENT_PROVIDER_${context.project.toUpperCase()}`
    const projectProvider = process.env[projectKey]
    if (projectProvider && VALID_PROVIDERS.has(projectProvider)) {
      provider = projectProvider as AgentProviderName
      providerSource = `profile:${profileName} + env ${projectKey}`
    }
  }

  // Env var AGENT_MODEL_{PROJECT}
  if (context.project) {
    const projectKey = `AGENT_MODEL_${context.project.toUpperCase()}`
    const envModel = process.env[projectKey]
    if (envModel) {
      model = envModel
      providerSource = `profile:${profileName} + env ${projectKey}`
    }
  }

  // Env var AGENT_PROVIDER_{WORKTYPE}
  if (context.workType) {
    const workTypeKey = `AGENT_PROVIDER_${context.workType.toUpperCase().replace(/-/g, '_')}`
    const workTypeProvider = process.env[workTypeKey]
    if (workTypeProvider && VALID_PROVIDERS.has(workTypeProvider)) {
      provider = workTypeProvider as AgentProviderName
      providerSource = `profile:${profileName} + env ${workTypeKey}`
    }
  }

  // Env var AGENT_MODEL_{WORKTYPE}
  if (context.workType) {
    const workTypeKey = `AGENT_MODEL_${context.workType.toUpperCase().replace(/-/g, '_')}`
    const envModel = process.env[workTypeKey]
    if (envModel) {
      model = envModel
      providerSource = `profile:${profileName} + env ${workTypeKey}`
    }
  }

  // Mention context override (provider only)
  if (context.mentionContext) {
    const mentionProvider = extractProviderFromMention(context.mentionContext)
    if (mentionProvider) {
      provider = mentionProvider
      providerSource = `profile:${profileName} + mention`
    }
  }

  // Issue label overrides
  if (context.labels?.length) {
    const labelProvider = extractProviderFromLabels(context.labels)
    if (labelProvider) {
      provider = labelProvider
      providerSource = `profile:${profileName} + label provider:${labelProvider}`
    }

    const labelModel = extractModelFromLabels(context.labels)
    if (labelModel) {
      model = labelModel
      providerSource = `profile:${profileName} + label model:${labelModel}`
    }
  }

  // Platform dispatch model override (highest priority)
  if (context.dispatchModel) {
    model = context.dispatchModel
    providerSource = `profile:${profileName} + dispatch model:${context.dispatchModel}`

    // Keep (provider, model) coherent: if the dispatched model belongs to a
    // different provider (declared via profile or known prefix), switch the
    // provider too. Otherwise, e.g., codex+ChatGPT would receive a Claude
    // model and return HTTP 400.
    const inferred = inferProviderForModel(context.dispatchModel, profiles)
    if (inferred && inferred !== provider) {
      provider = inferred
      providerSource = `${providerSource}→provider:${inferred}`
    }
  }

  // Step 4: Extract provider-specific config
  const providerConfig = extractProviderConfig(profile, provider)

  // Step 5: Resolve sub-agent config
  const subAgent = resolveSubAgentFromProfile(profile, context)

  return {
    provider,
    model,
    effort: profile.effort,
    providerConfig,
    subAgent,
    source: providerSource,
  }
}

// ---------------------------------------------------------------------------
// Sub-agent resolution
// ---------------------------------------------------------------------------

/**
 * Resolve sub-agent configuration from a profile.
 *
 * Priority:
 * 1. Platform dispatch sub-agent model (overrides model only)
 * 2. Profile's subAgent block (provider, model, effort)
 * 3. Env AGENT_SUB_MODEL (overrides model only)
 * 4. Inherit from parent profile
 */
export function resolveSubAgentFromProfile(
  profile: ProfileConfig,
  context: Pick<ProfileResolutionContext, 'dispatchSubAgentModel'>,
): SubAgentProfileConfig | undefined {
  const base = profile.subAgent

  // Start with profile's sub-agent block or inherit from parent
  const result: SubAgentProfileConfig = {
    provider: base?.provider ?? profile.provider,
    model: base?.model ?? profile.model,
    effort: base?.effort ?? profile.effort,
  }

  // Env var AGENT_SUB_MODEL overrides model
  const envSubModel = process.env.AGENT_SUB_MODEL
  if (envSubModel) {
    result.model = envSubModel
  }

  // Platform dispatch override (highest priority)
  if (context.dispatchSubAgentModel) {
    result.model = context.dispatchSubAgentModel
  }

  return result
}
