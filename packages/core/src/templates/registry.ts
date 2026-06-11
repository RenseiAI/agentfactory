/**
 * Template Registry
 *
 * In-memory registry that resolves workflow templates by work type.
 * Supports layered resolution with built-in defaults, project overrides,
 * and inline config overrides.
 */

import Handlebars from 'handlebars'
import type { JSONSchema7 } from 'json-schema'
import type { AgentWorkType } from '../orchestrator/work-types.js'
import type {
  WorkflowTemplate,
  TemplateContext,
  TemplateRegistryConfig,
  ToolPermission,
  ToolPermissionAdapter,
} from './types.js'
import {
  loadTemplatesFromDir,
  loadPartialsFromDir,
  getBuiltinDefaultsDir,
  getBuiltinPartialsDir,
} from './loader.js'
import { generateTemplateSchema, type TemplateSchemaOptions } from './schema.js'

/**
 * Template Registry manages workflow templates and renders prompts.
 *
 * Supports strategy-aware template resolution: given a (workType, strategy) tuple,
 * the registry first looks for a strategy-specific template (e.g., "refinement-context-enriched")
 * and falls back to the base work type template (e.g., "refinement").
 */
export class TemplateRegistry {
  /**
   * Internal map uses string keys to support both base work types (e.g., "development")
   * and strategy-specific compound keys (e.g., "refinement-context-enriched").
   */
  private templates = new Map<string, WorkflowTemplate>()
  private handlebars: typeof Handlebars
  private toolPermissionAdapter?: ToolPermissionAdapter

  constructor() {
    this.handlebars = Handlebars.create()

    // Register custom helpers
    this.handlebars.registerHelper('eq', function (a: unknown, b: unknown) {
      return a === b
    })
    this.handlebars.registerHelper('neq', function (a: unknown, b: unknown) {
      return a !== b
    })
  }

  /**
   * Create and initialize a registry from configuration.
   */
  static create(config: TemplateRegistryConfig = {}): TemplateRegistry {
    const registry = new TemplateRegistry()
    registry.initialize(config)
    return registry
  }

  /**
   * Initialize the registry by loading templates from configured sources.
   * Resolution order (later sources override earlier):
   *   1. Built-in defaults
   *   2. Each directory in templateDirs (in order)
   *   3. Inline template overrides
   */
  initialize(config: TemplateRegistryConfig = {}): void {
    const { templateDirs = [], templates, useBuiltinDefaults = true, frontend } = config

    // Layer 1: Built-in defaults
    if (useBuiltinDefaults) {
      const builtinDir = getBuiltinDefaultsDir()
      const builtinTemplates = loadTemplatesFromDir(builtinDir)
      for (const [key, template] of builtinTemplates) {
        this.templates.set(key, template)
      }

      // Load built-in partials
      const builtinPartialsDir = getBuiltinPartialsDir()
      const builtinPartials = loadPartialsFromDir(builtinPartialsDir, frontend)
      for (const [name, content] of builtinPartials) {
        this.handlebars.registerPartial(`partials/${name}`, content)
      }
    }

    // Layer 2: Project-level overrides (each dir in order)
    for (const dir of templateDirs) {
      const dirTemplates = loadTemplatesFromDir(dir)
      for (const [key, template] of dirTemplates) {
        this.templates.set(key, template)
      }

      // Load partials from each dir's partials subdirectory
      const partialsDir = `${dir}/partials`
      const partials = loadPartialsFromDir(partialsDir, frontend)
      for (const [name, content] of partials) {
        this.handlebars.registerPartial(`partials/${name}`, content)
      }
    }

    // Layer 3: Inline config overrides (highest priority)
    if (templates) {
      for (const [workType, template] of Object.entries(templates)) {
        if (template) {
          this.templates.set(workType, template)
        }
      }
    }
  }

  /**
   * Set the tool permission adapter for provider-specific translation.
   */
  setToolPermissionAdapter(adapter: ToolPermissionAdapter): void {
    this.toolPermissionAdapter = adapter
  }

  /**
   * Look up a template by work type, with optional strategy for compound key resolution.
   *
   * Resolution order:
   *   1. "{workType}-{strategy}" (e.g., "refinement-context-enriched")
   *   2. "{workType}" (e.g., "refinement" -- fallback)
   *
   * Returns undefined if no template is registered.
   */
  getTemplate(workType: AgentWorkType, strategy?: string): WorkflowTemplate | undefined {
    if (strategy) {
      const strategyKey = `${workType}-${strategy}`
      const strategyTemplate = this.templates.get(strategyKey)
      if (strategyTemplate) return strategyTemplate
    }
    return this.templates.get(workType)
  }

  /**
   * Check if a template is registered for a work type (optionally with strategy).
   */
  hasTemplate(workType: AgentWorkType, strategy?: string): boolean {
    if (strategy) {
      const strategyKey = `${workType}-${strategy}`
      if (this.templates.has(strategyKey)) return true
    }
    return this.templates.has(workType)
  }

  /**
   * Get all registered template keys (base work types and strategy-specific keys).
   */
  getRegisteredWorkTypes(): string[] {
    return Array.from(this.templates.keys())
  }

  /**
   * Render a template for a work type with the given context variables.
   * Optionally specify a strategy for strategy-aware template resolution.
   * Returns null if no template is registered for the work type.
   */
  renderPrompt(workType: AgentWorkType, context: TemplateContext, strategy?: string): string | null {
    const template = this.getTemplate(workType, strategy)
    if (!template) {
      return null
    }

    try {
      const compiledTemplate = this.handlebars.compile(template.prompt, { noEscape: true })
      return compiledTemplate(context)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const key = strategy ? `${workType}-${strategy}` : workType
      throw new Error(
        `Failed to render template for work type "${key}": ${message}`
      )
    }
  }

  /**
   * Get the translated tool permissions for a work type (optionally with strategy).
   * Returns undefined if no template or no tool permissions defined.
   */
  getToolPermissions(workType: AgentWorkType, strategy?: string): string[] | undefined {
    const template = this.getTemplate(workType, strategy)
    if (!template?.tools?.allow) {
      return undefined
    }

    if (this.toolPermissionAdapter) {
      return this.toolPermissionAdapter.translatePermissions(template.tools.allow)
    }

    // Without an adapter, return string permissions as-is
    return template.tools.allow.map(p =>
      typeof p === 'string' ? p : (p as { shell: string }).shell
    )
  }

  /**
   * Get disallowed tools for a work type (optionally with strategy).
   */
  getDisallowedTools(workType: AgentWorkType, strategy?: string): ToolPermission[] | undefined {
    const template = this.getTemplate(workType, strategy)
    return template?.tools?.disallow
  }

  /**
   * Get the raw allow and disallow permission arrays for a work type.
   * Used by the orchestrator to build Codex permission configs via the adapter.
   */
  getRawToolPermissions(workType: AgentWorkType, strategy?: string): {
    allow: ToolPermission[]
    disallow: ToolPermission[]
  } {
    const template = this.getTemplate(workType, strategy)
    return {
      allow: template?.tools?.allow ?? [],
      disallow: template?.tools?.disallow ?? [],
    }
  }

  /**
   * Register a partial template for use in Handlebars rendering.
   */
  registerPartial(name: string, content: string): void {
    this.handlebars.registerPartial(name, content)
  }

  /**
   * Get JSON Schema 7 for a template's parameters.
   *
   * The schema is derived from the template's prompt by extracting
   * Handlebars expression references and mapping them to the known
   * TemplateContext fields. Returns null if no template is registered.
   */
  getSchema(templateName: string, options?: TemplateSchemaOptions): JSONSchema7 | null {
    const template = this.templates.get(templateName)
    if (!template) return null
    return generateTemplateSchema(template, options)
  }

  /**
   * Validate a config object against a template's JSON Schema.
   *
   * Template expressions ({{ }}) in string values are treated as valid
   * placeholders and are not validated against the schema type.
   *
   * Returns a validation result with `valid` boolean and any `errors`.
   */
  validateConfig(
    templateName: string,
    config: Record<string, unknown>,
  ): TemplateValidationResult {
    const template = this.templates.get(templateName)
    if (!template) {
      return { valid: false, errors: [`Template "${templateName}" not found`] }
    }

    const schema = generateTemplateSchema(template)
    return validateConfigAgainstSchema(config, schema)
  }
}

// ---------------------------------------------------------------------------
// Validation types and helpers
// ---------------------------------------------------------------------------

export interface TemplateValidationResult {
  valid: boolean
  errors: string[]
}

/** Handlebars expression pattern: {{ ... }} */
const TEMPLATE_EXPRESSION_RE = /^\{\{.*\}\}$/s

/**
 * Validate a config object against a JSON Schema 7.
 * Template expressions ({{ }}) are treated as valid for any field.
 */
function validateConfigAgainstSchema(
  config: Record<string, unknown>,
  schema: JSONSchema7,
): TemplateValidationResult {
  const errors: string[] = []
  const properties = schema.properties ?? {}
  const required = schema.required ?? []

  // Check required fields
  for (const field of required) {
    if (!(field in config)) {
      errors.push(`Missing required field: "${field}"`)
    }
  }

  // Type-check provided fields
  for (const [key, value] of Object.entries(config)) {
    const fieldSchema = properties[key]
    if (!fieldSchema || typeof fieldSchema === 'boolean') continue

    // Template expressions are always valid
    if (typeof value === 'string' && TEMPLATE_EXPRESSION_RE.test(value.trim())) {
      continue
    }

    const typeError = checkType(key, value, fieldSchema)
    if (typeError) errors.push(typeError)
  }

  return { valid: errors.length === 0, errors }
}

function checkType(key: string, value: unknown, schema: JSONSchema7): string | null {
  const schemaType = schema.type
  if (!schemaType) return null

  // Normalize to array of type strings
  const types: string[] = Array.isArray(schemaType) ? schemaType : [schemaType]

  const valueType = Array.isArray(value) ? 'array' : typeof value
  // null is a valid JSON Schema type
  if (value === null && types.includes('null')) return null
  if (value === null) return `Field "${key}" is null but expected ${types.join(' | ')}`

  // 'integer' matches typeof 'number' in JS
  const effectiveTypes = types.map(t => t === 'integer' ? 'number' : t)
  if (!effectiveTypes.includes(valueType)) {
    return `Field "${key}" has type "${valueType}" but expected ${types.join(' | ')}`
  }

  return null
}
