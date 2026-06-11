/**
 * Workflow Template Types
 *
 * TypeScript interfaces and Zod schemas for the YAML-based workflow template system.
 * Templates use Handlebars for interpolation and partials for composability.
 *
 * Architecture decisions (from):
 * - YAML format with Handlebars interpolation (not custom parser)
 * - Single flat `prompt` field (not sectioned)
 * - State transitions stay in TypeScript (not in templates)
 * - Schema versioning: apiVersion: v1
 * - Provider-agnostic tool permissions
 * - Frontend-specific content in partials only
 */

import { z } from 'zod'
import type { AgentWorkType } from '../orchestrator/work-types.js'

// Re-export for convenience
export type { AgentWorkType } from '../orchestrator/work-types.js'

// ---------------------------------------------------------------------------
// Tool Permission Types
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic tool permission.
 *
 * Shell permissions specify command patterns (e.g., "pnpm *").
 * Provider adapters translate these to native format:
 *   - Claude: { shell: "pnpm *" } → "Bash(pnpm:*)"
 *   - Other providers: their own format
 */
export type ToolPermission =
  | { shell: string }
  | 'user-input'
  | string

// ---------------------------------------------------------------------------
// Workflow Template
// ---------------------------------------------------------------------------

/**
 * A workflow template defines the prompt and tool permissions for a work type.
 */
export interface WorkflowTemplate {
  apiVersion: 'v1'
  kind: 'WorkflowTemplate'
  metadata: {
    name: string
    description?: string
    workType: AgentWorkType
  }
  tools?: {
    allow?: ToolPermission[]
    disallow?: ToolPermission[]
  }
  /** Handlebars template string rendered with TemplateContext variables */
  prompt: string
}

// ---------------------------------------------------------------------------
// Partial Template
// ---------------------------------------------------------------------------

/**
 * A reusable instruction block that can be composed into workflow templates
 * via Handlebars partials: {{> partials/name}}
 */
export interface PartialTemplate {
  apiVersion: 'v1'
  kind: 'PartialTemplate'
  metadata: {
    name: string
    description?: string
    /** If set, this partial is frontend-specific (e.g., "linear", "asana") */
    frontend?: string
  }
  /** Handlebars template string (may reference other partials) */
  content: string
}

// ---------------------------------------------------------------------------
// Template Context (variables available during rendering)
// ---------------------------------------------------------------------------

/**
 * Variables available for interpolation in workflow templates.
 */
export interface TemplateContext {
  /** Issue identifier, e.g., "ABC-123" */
  identifier: string
  /** Optional user mention text providing additional context */
  mentionContext?: string

  // Frontend-resolved variables (injected by frontend adapter)
  /** Status to show when agent starts, e.g., "Started" (Linear) */
  startStatus?: string
  /** Status to show when agent completes, e.g., "Finished" */
  completeStatus?: string

  // Parent issue context (coordination work types)
  /** Pre-built enriched prompt for parent issues with sub-issues */
  parentContext?: string
  /** Formatted list of sub-issues with statuses */
  subIssueList?: string

  // Strategy / WorkflowState variables (injected by escalation governor)
  /** Current escalation cycle count (from WorkflowState) */
  cycleCount?: number
  /** Current escalation strategy: 'normal' | 'context-enriched' | 'decompose' | 'escalate-human' */
  strategy?: string
  /** Accumulated failure summary across cycles */
  failureSummary?: string
  /** Attempt number within current phase */
  attemptNumber?: number
  /** List of previous failure reasons */
  previousFailureReasons?: string[]
  /** Total cost in USD across all attempts */
  totalCostUsd?: number

  // Governor notification variables
  /** Blocker issue identifier (for escalation alerts) */
  blockerIdentifier?: string
  /** Team name (for decomposition sub-issue creation) */
  team?: string

  // Repository validation variables
  /** Git repository URL pattern for pre-push validation (e.g. 'github.com/org/repo') */
  repository?: string

  // Project path scoping variables (monorepo support)
  /** Root directory for this project within the repo (e.g. 'apps/family') */
  projectPath?: string
  /** Shared directories that any project's agent may modify (e.g. ['packages/ui']) */
  sharedPaths?: string[]

  // Tool plugin mode
  /** When true, agents use in-process af_linear_* tools instead of CLI */
  useToolPlugins?: boolean
  /** When true, code-intelligence tools (af_code_*) are available via registered plugin */
  hasCodeIntelligence?: boolean

  // Non-Node project support
  /** Command to invoke the Linear CLI (default: "pnpm af-linear") */
  linearCli?: string
  /** Package manager used by the project (default: "pnpm"). Set to "none" for non-Node projects. */
  packageManager?: string

  // Configurable build/test commands (native/compiled project support)
  /** Build command override (e.g. 'cargo build', 'cmake --build build', 'make') */
  buildCommand?: string
  /** Test command override (e.g. 'cargo test', 'ctest --test-dir build', 'make test') */
  testCommand?: string
  /** Validation command override — replaces typecheck for compiled projects (e.g. 'cargo clippy') */
  validateCommand?: string

  // Phase output data (parallel data passing)
  /** Collected outputs from upstream phases, keyed by phase name then output key */
  phaseOutputs?: Record<string, Record<string, unknown>>

  // Agent improvement backlog
  /** Linear project name for creating agent-improvement issues (from AGENT_BUG_BACKLOG env var) */
  agentBugBacklog?: string

  // Model selection (for sub-agent control in coordination templates)
  /** Resolved model ID for the primary agent (e.g., 'claude-sonnet-4-6'). Informational — already applied to provider. */
  model?: string
  /** Model ID for Task sub-agents spawned by coordinators. Templates can pass this to sub-agent prompts. */
  subAgentModel?: string
  /** Normalized effort level for the primary agent (e.g., 'low', 'medium', 'high', 'xhigh') */
  effort?: string
  /** Effort level for sub-agents spawned by coordinators */
  subAgentEffort?: string
  /** Provider name for sub-agents when different from parent (e.g., 'codex' when parent uses 'claude') */
  subAgentProvider?: string

  // Merge queue awareness
  /** When true, a merge queue (local or GitHub-native) handles rebase/merge — QA should not hard-fail on merge conflicts */
  mergeQueueEnabled?: boolean

  // Conflict prediction
  /** Pre-flight conflict warning when in-flight PRs overlap with this issue's scope */
  conflictWarning?: string

  // Quality baseline (captured from main before agent starts)
  /** Quality metrics baseline for delta checking. Injected by orchestrator when quality gates are enabled. */
  qualityBaseline?: {
    tests: { total: number; passed: number; failed: number }
    typecheckErrors: number
    lintErrors: number
  }

  // Session memory (cross-session context injection)
  /** Pre-built context from past observations, injected by the context builder */
  sessionMemoryContext?: string

  // Architectural Intelligence
  /**
   * Rendered architectural context section (## Architectural context).
   * Injected by the orchestrator at session start from ArchitecturalIntelligence.query().
   * Priority-ordered: drift warnings > active issue patterns > project-wide conventions > org-wide patterns.
   */
  architecturalContext?: string
}

// ---------------------------------------------------------------------------
// Tool Permission Adapter
// ---------------------------------------------------------------------------

/**
 * Translates abstract tool permissions to provider-native format.
 *
 * Example: Claude adapter translates { shell: "pnpm *" } → "Bash(pnpm:*)"
 */
export interface ToolPermissionAdapter {
  /** Translate abstract permissions to provider-native format */
  translatePermissions(permissions: ToolPermission[]): string[]
}

// ---------------------------------------------------------------------------
// Template Registry Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for creating a template registry.
 */
export interface TemplateRegistryConfig {
  /** Directories to scan for template YAML files (searched in order) */
  templateDirs?: string[]
  /**
   * Inline template overrides (highest priority).
   * Keys can be AgentWorkType values (e.g., "development") or strategy-specific
   * compound keys (e.g., "refinement-context-enriched").
   */
  templates?: Partial<Record<AgentWorkType, WorkflowTemplate>> & Record<string, WorkflowTemplate>
  /** Whether to load built-in defaults (default: true) */
  useBuiltinDefaults?: boolean
  /** Frontend discriminator for partial resolution (e.g., "linear", "asana") */
  frontend?: string
  /** Provider discriminator for tool permission translation */
  provider?: string
}

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

/** All valid work type values */
const WORK_TYPES = [
  'research',
  'backlog-creation',
  'backlog-groomer',
  'development',
  'inflight',
  'qa',
  'acceptance',
  'refinement',
  'refinement-coordination',
  'merge',
  'security',
  'improvement-loop',
  'outcome-auditor',
  'ga-readiness',
  'documentation-steward',
  'operational-scanner-vercel',
  'operational-scanner-audit',
  'operational-scanner-ci',
] as const

export const AgentWorkTypeSchema = z.enum(WORK_TYPES)

export const ToolPermissionSchema = z.union([
  z.object({ shell: z.string().min(1) }),
  z.literal('user-input'),
  z.string().min(1),
])

export const WorkflowTemplateSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('WorkflowTemplate'),
  metadata: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    workType: AgentWorkTypeSchema,
  }),
  tools: z.object({
    allow: z.array(ToolPermissionSchema).optional(),
    disallow: z.array(ToolPermissionSchema).optional(),
  }).optional(),
  prompt: z.string().min(1),
})

export const PartialTemplateSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('PartialTemplate'),
  metadata: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    frontend: z.string().optional(),
  }),
  content: z.string().min(1),
})

export const TemplateContextSchema = z.object({
  identifier: z.string().min(1),
  mentionContext: z.string().optional(),
  startStatus: z.string().optional(),
  completeStatus: z.string().optional(),
  parentContext: z.string().optional(),
  subIssueList: z.string().optional(),
  // Strategy / WorkflowState variables
  cycleCount: z.number().int().nonnegative().optional(),
  strategy: z.string().optional(),
  failureSummary: z.string().optional(),
  attemptNumber: z.number().int().positive().optional(),
  previousFailureReasons: z.array(z.string()).optional(),
  totalCostUsd: z.number().nonnegative().optional(),
  // Governor notification variables
  blockerIdentifier: z.string().optional(),
  team: z.string().optional(),
  // Repository validation variables
  repository: z.string().optional(),
  // Project path scoping variables (monorepo support)
  projectPath: z.string().optional(),
  sharedPaths: z.array(z.string()).optional(),
  // Tool plugin mode
  useToolPlugins: z.boolean().optional(),
  // Non-Node project support
  linearCli: z.string().optional(),
  packageManager: z.string().optional(),
  // Configurable build/test commands (native/compiled project support)
  buildCommand: z.string().optional(),
  testCommand: z.string().optional(),
  validateCommand: z.string().optional(),
  // Phase output data (parallel data passing)
  phaseOutputs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  // Agent improvement backlog
  agentBugBacklog: z.string().optional(),
  // Model selection (for sub-agent control in coordination templates)
  model: z.string().optional(),
  subAgentModel: z.string().optional(),
  // Merge queue awareness
  mergeQueueEnabled: z.boolean().optional(),
  conflictWarning: z.string().optional(),
  // Quality baseline (captured from main before agent starts)
  qualityBaseline: z.object({
    tests: z.object({
      total: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
    typecheckErrors: z.number().int().nonnegative(),
    lintErrors: z.number().int().nonnegative(),
  }).optional(),
  // Session memory (cross-session context injection)
  sessionMemoryContext: z.string().optional(),
  // Architectural Intelligence
  architecturalContext: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Validation Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a parsed YAML object as a WorkflowTemplate.
 * Throws ZodError with detailed messages on failure.
 */
export function validateWorkflowTemplate(data: unknown, filePath?: string): WorkflowTemplate {
  try {
    return WorkflowTemplateSchema.parse(data)
  } catch (error) {
    if (filePath && error instanceof z.ZodError) {
      throw new Error(`Invalid workflow template at ${filePath}: ${error.message}`, { cause: error })
    }
    throw error
  }
}

/**
 * Validate a parsed YAML object as a PartialTemplate.
 * Throws ZodError with detailed messages on failure.
 */
export function validatePartialTemplate(data: unknown, filePath?: string): PartialTemplate {
  try {
    return PartialTemplateSchema.parse(data)
  } catch (error) {
    if (filePath && error instanceof z.ZodError) {
      throw new Error(`Invalid partial template at ${filePath}: ${error.message}`, { cause: error })
    }
    throw error
  }
}
