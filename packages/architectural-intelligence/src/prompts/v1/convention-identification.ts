/**
 * Architectural Intelligence — Convention Identification Prompt (v1)
 *
 * Architecture reference: donmai-architecture/007-intelligence-services.md
 * §"Architectural Intelligence" — Synthesis prompts
 *
 * This prompt drives LLM synthesis of raw ArchObservation streams
 * into structured Convention nodes.
 *
 * Design:
 * - Schema-prompt pattern: the prompt explicitly demands JSON conforming to
 *   ArchObservation (kind='convention').
 * - Output is a JSON array of ArchObservation values with kind='convention'.
 * - Payload carries: title, description, examples (path+excerpt), authored flag.
 * - Confidence capped at 0.95 for inferences.
 *
 * Versioning:
 * - This file is v1. When the prompt changes, a v2/ directory is added and
 *   this file is preserved verbatim for replay reproducibility.
 */

import type { ArchObservation } from '../../types.js'
import { _validateObservation } from './pattern-extraction.js'

// ---------------------------------------------------------------------------
// Prompt version metadata
// ---------------------------------------------------------------------------

export const PROMPT_VERSION = '1.0.0' as const
export const PROMPT_KIND = 'convention-identification' as const

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface ConventionIdentificationInput {
  /** Raw observations to synthesize into conventions. */
  observations: ArchObservation[]
  /** Optional project-level context hint. */
  projectContext?: string
}

export type ConventionIdentificationOutput = ArchObservation[]

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `\
You are an architectural intelligence synthesizer. Your job is to analyze a stream of
raw architectural observations and identify consistent CONVENTIONS — repeated practices
the codebase follows across a domain (error handling, naming, API design, etc.).

RULES:
1. Output ONLY a valid JSON array. No prose, no markdown, no explanation.
2. Each element MUST conform to the ArchObservation schema (see below).
3. kind MUST be "convention" for all entries.
4. confidence MUST be a number in [0.0, 0.95]. Never exceed 0.95 for inferences.
5. payload MUST contain: title (string), description (string), examples (array of {path, excerpt?}), authored (boolean).
6. Set authored=true ONLY if the convention is explicitly documented in CLAUDE.md or an ADR.
   For code-inferred conventions, authored=false.
7. Only emit conventions you have STRONG EVIDENCE for from the observations. Do not hallucinate.
8. Merge similar observations into a single convention. Prefer quality over quantity.
9. If no clear conventions emerge, return an empty array: []

ArchObservation schema:
{
  "kind": "convention",
  "payload": {
    "title": "Short human-readable title",
    "description": "1-3 sentence description with evidence",
    "examples": [{"path": "src/core/result.ts", "excerpt": "type Result<T,E> = ..."}],
    "authored": false
  },
  "source": {
    "sessionId": "<from input observation source, if present>",
    "changeRef": "<from input observation source, if present>"
  },
  "confidence": 0.70,
  "scope": <copy scope from the most representative input observation>
}
`

// ---------------------------------------------------------------------------
// User prompt template
// ---------------------------------------------------------------------------

export function buildUserPrompt(input: ConventionIdentificationInput): string {
  const contextLine = input.projectContext
    ? `Project context: ${input.projectContext}\n\n`
    : ''

  return (
    `${contextLine}` +
    `Analyze the following ${input.observations.length} raw architectural observation(s) and identify consistent conventions.\n\n` +
    `INPUT OBSERVATIONS:\n` +
    `${JSON.stringify(input.observations, null, 2)}\n\n` +
    `Return a JSON array of ArchObservation objects (kind="convention") as specified in the system prompt.`
  )
}

// ---------------------------------------------------------------------------
// Output parser / validator
// ---------------------------------------------------------------------------

export function parseOutput(rawOutput: string): ConventionIdentificationOutput {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawOutput.trim())
  } catch (err) {
    throw new Error(
      `[convention-identification v${PROMPT_VERSION}] LLM output is not valid JSON: ${String(err)}\nRaw: ${rawOutput.slice(0, 200)}`,
    )
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `[convention-identification v${PROMPT_VERSION}] Expected JSON array, got: ${typeof parsed}`,
    )
  }

  const results: ArchObservation[] = []
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as Record<string, unknown>
    _validateConventionObservation(item, i)
    results.push(item as unknown as ArchObservation)
  }

  return results
}

// ---------------------------------------------------------------------------
// Convention-specific validation
// ---------------------------------------------------------------------------

function _validateConventionObservation(
  item: Record<string, unknown>,
  index: number,
): void {
  _validateObservation(item, index, 'convention')

  const payload = item['payload'] as Record<string, unknown>

  if (typeof payload['description'] !== 'string' || payload['description'].length === 0) {
    throw new Error(
      `[convention-identification v${PROMPT_VERSION}] item[${index}].payload.description must be a non-empty string`,
    )
  }

  if (!Array.isArray(payload['examples'])) {
    throw new Error(
      `[convention-identification v${PROMPT_VERSION}] item[${index}].payload.examples must be an array`,
    )
  }

  if (typeof payload['authored'] !== 'boolean') {
    throw new Error(
      `[convention-identification v${PROMPT_VERSION}] item[${index}].payload.authored must be a boolean`,
    )
  }
}
