/**
 * Architectural Intelligence — Prompt Registry
 *
 * Architecture reference: donmai-architecture/007-intelligence-services.md
 * §"Architectural Intelligence" — Synthesis prompts
 *
 * Central registry for all versioned synthesis prompts.
 *
 * Prompt versioning:
 * - Prompts live in versioned directories (v1/, v2/, etc.).
 * - Current version: v1 (CURRENT_PROMPT_VERSION).
 * - Older versions are retained verbatim for replay reproducibility:
 *   eval harnesses can re-run historical observation streams through the
 *   exact prompt that produced the original output.
 * - When a prompt changes, a new version directory is created. The
 *   registry adds the new version and retains the old one.
 * - Semver: patch = wording tweak; minor = new output fields; major = schema change.
 *
 * Usage:
 *   import { promptRegistry, CURRENT_PROMPT_VERSION } from './prompts/index.js'
 *   const prompt = promptRegistry.patternExtraction.v1
 *   const userPrompt = prompt.buildUserPrompt({ observations, projectContext })
 *   // ... send to LLM ...
 *   const parsed = prompt.parseOutput(llmResponse)
 *
 * Replay:
 *   const prompt = promptRegistry.patternExtraction[version]
 *   // version can be 'v1', 'v2', etc.
 */

// ---------------------------------------------------------------------------
// v1 prompt modules
// ---------------------------------------------------------------------------

import * as patternExtractionV1 from './v1/pattern-extraction.js'
import * as conventionIdentificationV1 from './v1/convention-identification.js'
import * as decisionRecordingV1 from './v1/decision-recording.js'
import * as deviationDetectionV1 from './v1/deviation-detection.js'

// ---------------------------------------------------------------------------
// PromptVersion — valid version keys
// ---------------------------------------------------------------------------

export type PromptVersion = 'v1'

// ---------------------------------------------------------------------------
// PromptModule — the shape each versioned prompt module must satisfy
// ---------------------------------------------------------------------------

export interface PromptModule<TInput, TOutput> {
  /** Semantic version string (e.g., "1.0.0") */
  PROMPT_VERSION: string
  /** Prompt kind identifier */
  PROMPT_KIND: string
  /** System prompt string to send as the system role */
  SYSTEM_PROMPT: string
  /** Build the user-facing prompt from structured input */
  buildUserPrompt(input: TInput): string
  /** Parse and validate LLM output into typed observations */
  parseOutput(rawOutput: string): TOutput
}

// ---------------------------------------------------------------------------
// Typed prompt families
// ---------------------------------------------------------------------------

export type PatternExtractionModule = PromptModule<
  patternExtractionV1.PatternExtractionInput,
  patternExtractionV1.PatternExtractionOutput
>

export type ConventionIdentificationModule = PromptModule<
  conventionIdentificationV1.ConventionIdentificationInput,
  conventionIdentificationV1.ConventionIdentificationOutput
>

export type DecisionRecordingModule = PromptModule<
  decisionRecordingV1.DecisionRecordingInput,
  decisionRecordingV1.DecisionRecordingOutput
>

export type DeviationDetectionModule = PromptModule<
  deviationDetectionV1.DeviationDetectionInput,
  deviationDetectionV1.DeviationDetectionOutput
>

// ---------------------------------------------------------------------------
// PromptRegistry — the versioned registry
// ---------------------------------------------------------------------------

export interface PromptRegistry {
  patternExtraction: {
    v1: PatternExtractionModule
    [version: string]: PatternExtractionModule
  }
  conventionIdentification: {
    v1: ConventionIdentificationModule
    [version: string]: ConventionIdentificationModule
  }
  decisionRecording: {
    v1: DecisionRecordingModule
    [version: string]: DecisionRecordingModule
  }
  deviationDetection: {
    v1: DeviationDetectionModule
    [version: string]: DeviationDetectionModule
  }
}

// ---------------------------------------------------------------------------
// Registry instance
// ---------------------------------------------------------------------------

/**
 * The canonical prompt registry.
 *
 * Adding a v2 prompt:
 *   1. Create `src/prompts/v2/pattern-extraction.ts`
 *   2. Import it here as `patternExtractionV2`
 *   3. Add `v2: patternExtractionV2` to `patternExtraction`
 *   4. Update `CURRENT_PROMPT_VERSION = 'v2'`
 *   5. Do NOT remove v1 — it is retained for replay.
 */
export const promptRegistry: PromptRegistry = {
  patternExtraction: {
    v1: patternExtractionV1,
  },
  conventionIdentification: {
    v1: conventionIdentificationV1,
  },
  decisionRecording: {
    v1: decisionRecordingV1,
  },
  deviationDetection: {
    v1: deviationDetectionV1,
  },
}

// ---------------------------------------------------------------------------
// Current version
// ---------------------------------------------------------------------------

/**
 * The version used by default in the pipeline and eval harnesses.
 * Update this when a new version is promoted to current.
 */
export const CURRENT_PROMPT_VERSION: PromptVersion = 'v1'

// ---------------------------------------------------------------------------
// Convenience accessors
// ---------------------------------------------------------------------------

/**
 * Get the current (default) prompt for a given kind.
 *
 * @example
 * const prompt = currentPrompt('patternExtraction')
 * const userMsg = prompt.buildUserPrompt({ observations })
 */
export function currentPrompt(
  kind: 'patternExtraction',
): PatternExtractionModule
export function currentPrompt(
  kind: 'conventionIdentification',
): ConventionIdentificationModule
export function currentPrompt(
  kind: 'decisionRecording',
): DecisionRecordingModule
export function currentPrompt(
  kind: 'deviationDetection',
): DeviationDetectionModule
export function currentPrompt(
  kind: keyof PromptRegistry,
): PromptModule<unknown, unknown> {
  return promptRegistry[kind][CURRENT_PROMPT_VERSION] as PromptModule<unknown, unknown>
}

/**
 * Get a specific versioned prompt for replay purposes.
 *
 * @example
 * const prompt = versionedPrompt('patternExtraction', 'v1')
 */
export function versionedPrompt(
  kind: 'patternExtraction',
  version: PromptVersion,
): PatternExtractionModule
export function versionedPrompt(
  kind: 'conventionIdentification',
  version: PromptVersion,
): ConventionIdentificationModule
export function versionedPrompt(
  kind: 'decisionRecording',
  version: PromptVersion,
): DecisionRecordingModule
export function versionedPrompt(
  kind: 'deviationDetection',
  version: PromptVersion,
): DeviationDetectionModule
export function versionedPrompt(
  kind: keyof PromptRegistry,
  version: PromptVersion,
): PromptModule<unknown, unknown> {
  const family = promptRegistry[kind]
  const prompt = family[version]
  if (!prompt) {
    throw new Error(
      `[promptRegistry] No prompt registered for kind="${String(kind)}" version="${version}". ` +
        `Available versions: ${Object.keys(family).join(', ')}`,
    )
  }
  return prompt as PromptModule<unknown, unknown>
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type {
  PatternExtractionInput,
  PatternExtractionOutput,
} from './v1/pattern-extraction.js'

export type {
  ConventionIdentificationInput,
  ConventionIdentificationOutput,
} from './v1/convention-identification.js'

export type {
  DecisionRecordingInput,
  DecisionRecordingOutput,
} from './v1/decision-recording.js'

export type {
  DeviationDetectionInput,
  DeviationDetectionOutput,
  BaselineEntry,
} from './v1/deviation-detection.js'
