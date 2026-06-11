/**
 * Architectural Intelligence — Decision Recording Prompt (v1)
 *
 * Architecture reference: donmai-architecture/007-intelligence-services.md
 * §"Architectural Intelligence" — Synthesis prompts
 *
 * This prompt drives LLM synthesis of raw ArchObservation streams
 * into structured Decision nodes — captured architectural decisions (ADR-style).
 *
 * Design:
 * - Schema-prompt pattern: the prompt explicitly demands JSON conforming to
 *   ArchObservation (kind='decision').
 * - Output is a JSON array of ArchObservation values with kind='decision'.
 * - Payload carries: title, chosen, alternatives, rationale, status.
 * - Confidence capped at 0.95 for inferences; PR-title decisions may be 0.60.
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
export const PROMPT_KIND = 'decision-recording' as const

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface DecisionRecordingInput {
  /** Raw observations to synthesize into decision records. */
  observations: ArchObservation[]
  /** Optional project-level context hint. */
  projectContext?: string
}

export type DecisionRecordingOutput = ArchObservation[]

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `\
You are an architectural intelligence synthesizer. Your job is to analyze a stream of
raw architectural observations and capture ARCHITECTURAL DECISIONS — resolved trade-offs
with stated rationale (ADR-style: "we chose X over Y because Z").

Look for signals like:
- PR descriptions containing "chose X over Y", "picked X because", "migrating from X to Y"
- ADR files or CLAUDE.md entries describing technology choices
- Commit messages or issue titles that describe deliberate architectural choices

RULES:
1. Output ONLY a valid JSON array. No prose, no markdown, no explanation.
2. Each element MUST conform to the ArchObservation schema (see below).
3. kind MUST be "decision" for all entries.
4. confidence MUST be a number in [0.0, 0.95]. Never exceed 0.95 for inferences.
   - ADR-sourced decisions: use 0.90
   - PR description-sourced: use 0.60
   - Code-inferred: use 0.40
5. payload MUST contain: title (string), chosen (string), alternatives (array of {option, rejectionReason?}),
   rationale (string), status ("active"|"superseded"|"deprecated").
6. If there is no clear decision evidence, return an empty array: []

ArchObservation schema:
{
  "kind": "decision",
  "payload": {
    "title": "Drizzle chosen over Prisma",
    "chosen": "Drizzle ORM",
    "alternatives": [{"option": "Prisma", "rejectionReason": "no edge runtime support"}],
    "rationale": "Drizzle supports edge runtimes; Prisma does not — see PR #142.",
    "status": "active"
  },
  "source": {
    "sessionId": "<from input observation source, if present>",
    "changeRef": "<from input observation source, if present>"
  },
  "confidence": 0.60,
  "scope": <copy scope from the most representative input observation>
}
`

// ---------------------------------------------------------------------------
// User prompt template
// ---------------------------------------------------------------------------

export function buildUserPrompt(input: DecisionRecordingInput): string {
  const contextLine = input.projectContext
    ? `Project context: ${input.projectContext}\n\n`
    : ''

  return (
    `${contextLine}` +
    `Analyze the following ${input.observations.length} raw architectural observation(s) and capture any architectural decisions.\n\n` +
    `INPUT OBSERVATIONS:\n` +
    `${JSON.stringify(input.observations, null, 2)}\n\n` +
    `Return a JSON array of ArchObservation objects (kind="decision") as specified in the system prompt.`
  )
}

// ---------------------------------------------------------------------------
// Output parser / validator
// ---------------------------------------------------------------------------

export function parseOutput(rawOutput: string): DecisionRecordingOutput {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawOutput.trim())
  } catch (err) {
    throw new Error(
      `[decision-recording v${PROMPT_VERSION}] LLM output is not valid JSON: ${String(err)}\nRaw: ${rawOutput.slice(0, 200)}`,
    )
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `[decision-recording v${PROMPT_VERSION}] Expected JSON array, got: ${typeof parsed}`,
    )
  }

  const results: ArchObservation[] = []
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as Record<string, unknown>
    _validateDecisionObservation(item, i)
    results.push(item as unknown as ArchObservation)
  }

  return results
}

// ---------------------------------------------------------------------------
// Decision-specific validation
// ---------------------------------------------------------------------------

function _validateDecisionObservation(
  item: Record<string, unknown>,
  index: number,
): void {
  _validateObservation(item, index, 'decision')

  const payload = item['payload'] as Record<string, unknown>

  if (typeof payload['chosen'] !== 'string' || payload['chosen'].length === 0) {
    throw new Error(
      `[decision-recording v${PROMPT_VERSION}] item[${index}].payload.chosen must be a non-empty string`,
    )
  }

  if (!Array.isArray(payload['alternatives'])) {
    throw new Error(
      `[decision-recording v${PROMPT_VERSION}] item[${index}].payload.alternatives must be an array`,
    )
  }

  if (typeof payload['rationale'] !== 'string' || payload['rationale'].length === 0) {
    throw new Error(
      `[decision-recording v${PROMPT_VERSION}] item[${index}].payload.rationale must be a non-empty string`,
    )
  }

  const validStatuses = ['active', 'superseded', 'deprecated']
  if (!validStatuses.includes(payload['status'] as string)) {
    throw new Error(
      `[decision-recording v${PROMPT_VERSION}] item[${index}].payload.status must be one of: ${validStatuses.join(', ')}`,
    )
  }
}
