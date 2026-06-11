/**
 * Architectural Intelligence — Pattern Extraction Prompt (v1)
 *
 * Architecture reference: donmai-architecture/007-intelligence-services.md
 * §"Architectural Intelligence" — Synthesis prompts
 *
 * This prompt drives LLM synthesis of raw ArchObservation streams
 * into structured ArchitecturalPattern nodes.
 *
 * Design:
 * - Schema-prompt pattern: the prompt explicitly demands JSON conforming to
 *   ArchObservation (kind='pattern'). The LLM acts as a structured extractor.
 * - Output is a JSON array of ArchObservation values with kind='pattern'.
 * - Confidence is capped at 0.95 (inference cap from 007 non-negotiable
 *   principles). Only authored-doc sources may reach 1.0; this prompt
 *   always produces inferences.
 * - Input: a JSON array of raw ArchObservation values representing a session
 *   or PR observation stream.
 *
 * Versioning:
 * - This file is v1. When the prompt changes, a v2/ directory is added and
 *   this file is preserved verbatim for replay reproducibility.
 */

import type { ArchObservation } from '../../types.js'

// ---------------------------------------------------------------------------
// Prompt version metadata
// ---------------------------------------------------------------------------

export const PROMPT_VERSION = '1.0.0' as const
export const PROMPT_KIND = 'pattern-extraction' as const

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

/**
 * Input to the pattern extraction prompt.
 * Callers supply a stream of raw ArchObservation values (typically from a
 * session's observation buffer or a pipeline pass).
 */
export interface PatternExtractionInput {
  /** Raw observations to synthesize into patterns. */
  observations: ArchObservation[]
  /** Optional project-level context hint (e.g., "Next.js + tRPC + Drizzle"). */
  projectContext?: string
}

/**
 * Expected LLM output: an array of ArchObservation with kind='pattern'.
 * The eval harness validates this against the ArchObservation schema.
 */
export type PatternExtractionOutput = ArchObservation[]

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * System prompt for pattern extraction.
 *
 * This prompt instructs the LLM to act as a structured extractor.
 * It must not generate free-form prose — only the JSON envelope below.
 */
export const SYSTEM_PROMPT = `\
You are an architectural intelligence synthesizer. Your job is to analyze a stream of
raw architectural observations and extract stable ARCHITECTURAL PATTERNS — recurring
structural or behavioral choices observable across the codebase.

RULES:
1. Output ONLY a valid JSON array. No prose, no markdown, no explanation.
2. Each element MUST conform to the ArchObservation schema (see below).
3. kind MUST be "pattern" for all entries.
4. confidence MUST be a number in [0.0, 0.95]. Never exceed 0.95 for inferences.
5. payload MUST contain: title (string), description (string), locations (array of {path,role?}), tags (string[]).
6. Only emit patterns you have STRONG EVIDENCE for from the observations. Do not hallucinate.
7. Merge similar observations into a single pattern entry. Prefer quality over quantity.
8. If no clear patterns emerge, return an empty array: []

ArchObservation schema:
{
  "kind": "pattern",
  "payload": {
    "title": "Short human-readable title",
    "description": "1-3 sentence description of the pattern with evidence",
    "locations": [{"path": "src/auth/middleware.ts", "role": "central auth handler"}],
    "tags": ["auth", "middleware"]
  },
  "source": {
    "sessionId": "<from input observation source, if present>",
    "changeRef": "<from input observation source, if present>"
  },
  "confidence": 0.75,
  "scope": <copy scope from the most representative input observation>
}
`

// ---------------------------------------------------------------------------
// User prompt template
// ---------------------------------------------------------------------------

/**
 * Build the user-facing prompt for pattern extraction.
 *
 * @param input - The structured input containing observations and context.
 * @returns The formatted user prompt string to send to the LLM.
 */
export function buildUserPrompt(input: PatternExtractionInput): string {
  const contextLine = input.projectContext
    ? `Project context: ${input.projectContext}\n\n`
    : ''

  return (
    `${contextLine}` +
    `Analyze the following ${input.observations.length} raw architectural observation(s) and extract stable patterns.\n\n` +
    `INPUT OBSERVATIONS:\n` +
    `${JSON.stringify(input.observations, null, 2)}\n\n` +
    `Return a JSON array of ArchObservation objects (kind="pattern") as specified in the system prompt.`
  )
}

// ---------------------------------------------------------------------------
// Output parser / validator
// ---------------------------------------------------------------------------

/**
 * Parse and validate LLM output for pattern extraction.
 *
 * Returns the parsed observations or throws a descriptive error if the
 * output does not conform to the expected schema.
 *
 * This is called by the eval harness and the A/B test harness.
 */
export function parseOutput(rawOutput: string): PatternExtractionOutput {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawOutput.trim())
  } catch (err) {
    throw new Error(
      `[pattern-extraction v${PROMPT_VERSION}] LLM output is not valid JSON: ${String(err)}\nRaw: ${rawOutput.slice(0, 200)}`,
    )
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `[pattern-extraction v${PROMPT_VERSION}] Expected JSON array, got: ${typeof parsed}`,
    )
  }

  const results: ArchObservation[] = []
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as Record<string, unknown>
    _validateObservation(item, i, 'pattern')
    _validatePatternPayload(item['payload'] as Record<string, unknown>, i)
    results.push(item as unknown as ArchObservation)
  }

  return results
}

// ---------------------------------------------------------------------------
// Internal validation helper (shared by sibling prompts via re-export)
// ---------------------------------------------------------------------------

/**
 * Validate common ArchObservation fields shared by all prompt kinds.
 *
 * Validates: kind, confidence, payload (object with title+description),
 * and scope. Kind-specific payload fields (locations, tags, examples,
 * chosen, deviatesFrom, etc.) are validated by each prompt's own validator.
 *
 * Exported so sibling prompt validators can call it as the base check.
 */
export function _validateObservation(
  item: Record<string, unknown>,
  index: number,
  expectedKind: ArchObservation['kind'],
): void {
  if (item['kind'] !== expectedKind) {
    throw new Error(
      `[${expectedKind} v${PROMPT_VERSION}] item[${index}].kind must be "${expectedKind}", got "${String(item['kind'])}"`,
    )
  }
  if (typeof item['confidence'] !== 'number') {
    throw new Error(
      `[${expectedKind} v${PROMPT_VERSION}] item[${index}].confidence must be a number`,
    )
  }
  if ((item['confidence'] as number) < 0 || (item['confidence'] as number) > 0.95) {
    throw new Error(
      `[${expectedKind} v${PROMPT_VERSION}] item[${index}].confidence must be in [0, 0.95], got ${item['confidence']}`,
    )
  }
  if (typeof item['payload'] !== 'object' || item['payload'] === null) {
    throw new Error(
      `[${expectedKind} v${PROMPT_VERSION}] item[${index}].payload must be an object`,
    )
  }
  const payload = item['payload'] as Record<string, unknown>
  if (typeof payload['title'] !== 'string' || payload['title'].length === 0) {
    throw new Error(
      `[${expectedKind} v${PROMPT_VERSION}] item[${index}].payload.title must be a non-empty string`,
    )
  }
  if (typeof item['scope'] !== 'object' || item['scope'] === null) {
    throw new Error(
      `[${expectedKind} v${PROMPT_VERSION}] item[${index}].scope must be an object`,
    )
  }
}

/**
 * Validate pattern-specific payload fields (description, locations, tags).
 */
function _validatePatternPayload(
  payload: Record<string, unknown>,
  index: number,
): void {
  if (typeof payload['description'] !== 'string' || payload['description'].length === 0) {
    throw new Error(
      `[pattern-extraction v${PROMPT_VERSION}] item[${index}].payload.description must be a non-empty string`,
    )
  }
  if (!Array.isArray(payload['locations'])) {
    throw new Error(
      `[pattern-extraction v${PROMPT_VERSION}] item[${index}].payload.locations must be an array`,
    )
  }
  if (!Array.isArray(payload['tags'])) {
    throw new Error(
      `[pattern-extraction v${PROMPT_VERSION}] item[${index}].payload.tags must be an array`,
    )
  }
}
