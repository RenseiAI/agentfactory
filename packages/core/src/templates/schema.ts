/**
 * Template JSON Schema Generation
 *
 * Generates JSON Schema 7 definitions from WorkflowTemplate objects.
 * Schema is derived from TemplateContext fields referenced in the template's
 * prompt via Handlebars expressions.
 *
 */

import type { JSONSchema7, JSONSchema7Definition } from 'json-schema'
import type { WorkflowTemplate } from './types.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TemplateSchemaOptions {
  /** Include all TemplateContext fields, not just those referenced in the prompt */
  includeAllFields?: boolean
}

// ---------------------------------------------------------------------------
// Known TemplateContext field definitions
// ---------------------------------------------------------------------------

/**
 * Maps TemplateContext field names to their JSON Schema 7 definitions.
 * This is the source of truth for schema generation.
 */
const CONTEXT_FIELD_SCHEMAS: Record<string, JSONSchema7Definition> = {
  identifier: { type: 'string', description: 'Issue identifier, e.g., "ABC-123"' },
  mentionContext: { type: 'string', description: 'Optional user mention text providing additional context' },
  startStatus: { type: 'string', description: 'Status to show when agent starts, e.g., "Started"' },
  completeStatus: { type: 'string', description: 'Status to show when agent completes, e.g., "Finished"' },
  parentContext: { type: 'string', description: 'Pre-built enriched prompt for parent issues with sub-issues' },
  subIssueList: { type: 'string', description: 'Formatted list of sub-issues with statuses' },
  cycleCount: { type: 'integer', description: 'Current escalation cycle count' },
  strategy: { type: 'string', description: 'Current escalation strategy' },
  failureSummary: { type: 'string', description: 'Accumulated failure summary across cycles' },
  attemptNumber: { type: 'integer', description: 'Attempt number within current phase' },
  previousFailureReasons: {
    type: 'array',
    items: { type: 'string' },
    description: 'List of previous failure reasons',
  },
  totalCostUsd: { type: 'number', description: 'Total cost in USD across all attempts' },
  blockerIdentifier: { type: 'string', description: 'Blocker issue identifier' },
  team: { type: 'string', description: 'Team name' },
  repository: { type: 'string', description: 'Git repository URL pattern' },
  projectPath: { type: 'string', description: 'Root directory for this project within the repo' },
  sharedPaths: {
    type: 'array',
    items: { type: 'string' },
    description: 'Shared directories that any project agent may modify',
  },
  useToolPlugins: { type: 'boolean', description: 'When true, agents use in-process tools instead of CLI' },
  linearCli: { type: 'string', description: 'Command to invoke the Linear CLI (default: "pnpm af-linear")' },
  packageManager: { type: 'string', description: 'Package manager used by the project (default: "pnpm")' },
  buildCommand: { type: 'string', description: 'Build command override' },
  testCommand: { type: 'string', description: 'Test command override' },
  validateCommand: { type: 'string', description: 'Validation command override' },
  phaseOutputs: {
    type: 'object',
    additionalProperties: {
      type: 'object',
      additionalProperties: true,
    },
    description: 'Collected outputs from upstream phases',
  },
  agentBugBacklog: { type: 'string', description: 'Linear project name for agent-improvement issues' },
}

/** Fields that are always required in a template config */
const ALWAYS_REQUIRED = ['identifier']

// ---------------------------------------------------------------------------
// Handlebars expression extraction
// ---------------------------------------------------------------------------

/**
 * Extract Handlebars variable references from a template prompt.
 * Matches {{ varName }}, {{ varName.property }}, and handles
 * conditionals like {{#if varName}} and {{#unless varName}}.
 *
 * Returns the set of top-level variable names referenced.
 */
export function extractTemplateVariables(prompt: string): Set<string> {
  const vars = new Set<string>()

  // Match {{ expr }}, {{#if expr}}, {{#unless expr}}, {{> partial}}, etc.
  const patterns = [
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g,           // {{ varName }} or {{ var.prop }}
    /\{\{#(?:if|unless)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/g,     // {{#if varName}}
    /\{\{#(?:each)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/g,          // {{#each varName}}
    /\{\{#(?:with)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/g,          // {{#with varName}}
    /\{\{\s*(?:eq|neq)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/g,      // {{ eq varName "value" }}
    /\((?:eq|neq)\s+([a-zA-Z_][a-zA-Z0-9_.]*)/g,           // (eq varName "value") — subexpression
  ]

  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(prompt)) !== null) {
      const varName = match[1]
      // Extract the top-level variable name (before any dot)
      const topLevel = varName.split('.')[0]
      // Skip Handlebars built-ins and partials
      if (topLevel !== 'this' && topLevel !== 'else') {
        vars.add(topLevel)
      }
    }
  }

  return vars
}

// ---------------------------------------------------------------------------
// Schema generation
// ---------------------------------------------------------------------------

/**
 * Generate a JSON Schema 7 definition for a WorkflowTemplate's parameters.
 *
 * By default, only includes fields that are referenced in the template's
 * prompt. Set `includeAllFields: true` to include all known TemplateContext fields.
 */
export function generateTemplateSchema(
  template: WorkflowTemplate,
  options?: TemplateSchemaOptions,
): JSONSchema7 {
  const includeAll = options?.includeAllFields ?? false

  const properties: Record<string, JSONSchema7Definition> = {}
  const required: string[] = []

  if (includeAll) {
    // Include all known fields
    for (const [field, schemaDef] of Object.entries(CONTEXT_FIELD_SCHEMAS)) {
      properties[field] = schemaDef
    }
  } else {
    // Only include fields referenced in the template prompt
    const referencedVars = extractTemplateVariables(template.prompt)
    for (const varName of referencedVars) {
      if (varName in CONTEXT_FIELD_SCHEMAS) {
        properties[varName] = CONTEXT_FIELD_SCHEMAS[varName]
      }
    }
  }

  // Always include 'identifier' as required
  for (const field of ALWAYS_REQUIRED) {
    if (field in properties && !required.includes(field)) {
      required.push(field)
    }
  }

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    title: `${template.metadata.name} config`,
    description: template.metadata.description ?? `Configuration schema for ${template.metadata.name} template`,
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: true,
  }
}
