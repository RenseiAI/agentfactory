/**
 * Node Type Registry Types
 *
 * Interfaces for the node type metadata store that serves
 * canvas UI and execution engine with provider plugin information.
 *
 * Provider plugin types (ProviderPlugin, ActionDefinition) are imported
 * from providers/plugin-types.ts (defined by).
 */

import type { JSONSchema7 } from 'json-schema'

/** Provider category grouping (e.g., "Communication", "Project Management") */
export interface ProviderCategory {
  /** Unique category identifier */
  id: string
  /** Human-readable name */
  displayName: string
  /** Category description */
  description: string
  /** Icon identifier for the canvas UI */
  icon?: string
}

/** Metadata for a single node type (action/trigger/condition) in the registry */
export interface NodeTypeMetadata {
  /** Unique identifier for this node type */
  id: string
  /** Provider identifier (e.g., "linear", "slack") */
  providerId: string
  /** Action identifier within the provider (e.g., "create-issue", "send-message") */
  actionId: string
  /** Human-readable name */
  displayName: string
  /** Description of what this node type does */
  description: string
  /** Category this node type belongs to */
  category: string
  /** JSON Schema for the node's input fields */
  inputSchema: JSONSchema7
  /** JSON Schema for the node's output */
  outputSchema?: JSONSchema7
  /** Fields that support dynamic option loading */
  dynamicOptionFields?: string[]
}

/** Filter parameters for querying node types */
export interface NodeTypeQuery {
  /** Filter by category */
  category?: string
  /** Filter by provider */
  providerId?: string
}

/** A single option returned from dynamic option loading */
export interface DynamicOption {
  /** Value to store when selected */
  value: string
  /** Human-readable label to display */
  label: string
}

/** Result of a dynamic option loading call */
export type DynamicOptionResult = DynamicOption[]

/**
 * Callback for fetching dynamic options at runtime.
 * Registered per-provider to allow the registry to delegate dynamic option
 * loading without coupling to a specific method on ActionDefinition.
 */
export type DynamicOptionLoader = (
  actionId: string,
  fieldPath: string,
  context?: Record<string, unknown>,
) => Promise<DynamicOptionResult>
