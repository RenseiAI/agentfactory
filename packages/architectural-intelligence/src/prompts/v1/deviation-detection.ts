/**
 * Architectural Intelligence — Deviation Detection Prompt (v1)
 *
 * Architecture reference: donmai-architecture/007-intelligence-services.md
 * §"Architectural Intelligence" — Synthesis prompts
 *
 * This prompt drives LLM synthesis of raw ArchObservation streams
 * (including established patterns/conventions) to detect DEVIATIONS — changes
 * that diverge from established architectural norms.
 *
 * Design:
 * - Schema-prompt pattern: the prompt explicitly demands JSON conforming to
 *   ArchObservation (kind='deviation').
 * - The prompt takes BOTH the new change observations AND the established
 *   baseline (known patterns/conventions/decisions) as context.
 * - Output is a JSON array of ArchObservation values with kind='deviation'.
 * - Payload carries: title, description, deviatesFrom, severity.
 * - Confidence capped at 0.95.
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
export const PROMPT_KIND = 'deviation-detection' as const

// ---------------------------------------------------------------------------
// Established baseline types (summarized for prompt context)
// ---------------------------------------------------------------------------

export interface BaselineEntry {
  kind: 'pattern' | 'convention' | 'decision'
  id: string
  title: string
  description: string
}

// ---------------------------------------------------------------------------
// Input / Output types
// ---------------------------------------------------------------------------

export interface DeviationDetectionInput {
  /**
   * New observations from the incoming change (PR diff, session observations).
   * These are compared against the established baseline.
   */
  changeObservations: ArchObservation[]

  /**
   * The established architectural baseline to compare against.
   * Typically loaded from ai.query() before running this prompt.
   */
  baseline: BaselineEntry[]

  /** Optional project-level context hint. */
  projectContext?: string
}

export type DeviationDetectionOutput = ArchObservation[]

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `\
You are an architectural intelligence synthesizer specializing in drift detection.
Your job is to compare a set of INCOMING CHANGE observations against an ESTABLISHED
ARCHITECTURAL BASELINE and identify DEVIATIONS — places where the change introduces
a pattern not present in the baseline, or contradicts a known convention or decision.

RULES:
1. Output ONLY a valid JSON array. No prose, no markdown, no explanation.
2. Each element MUST conform to the ArchObservation schema (see below).
3. kind MUST be "deviation" for all entries.
4. confidence MUST be a number in [0.0, 0.95]. Never exceed 0.95 for inferences.
5. payload MUST contain: title (string), description (string),
   deviatesFrom ({kind, id} — must reference an id from the PROVIDED BASELINE),
   severity ("high"|"medium"|"low").
   - high: clear contradiction of an established decision or pattern
   - medium: possible inconsistency; needs human review
   - low: minor divergence; informational
6. Only flag ACTUAL DEVIATIONS supported by evidence in the change observations.
   Do not hallucinate deviations that aren't supported by the input data.
7. If no deviations are detected, return an empty array: []

ArchObservation schema:
{
  "kind": "deviation",
  "payload": {
    "title": "New route bypasses central auth middleware",
    "description": "The change adds a new API route that calls auth inline rather than delegating to lib/auth/middleware.ts.",
    "deviatesFrom": {"kind": "pattern", "id": "auth-centralization-pattern-id"},
    "severity": "high"
  },
  "source": {
    "sessionId": "<from input observation source, if present>",
    "changeRef": "<from input observation source, if present>"
  },
  "confidence": 0.80,
  "scope": <copy scope from the most representative input observation>
}
`

// ---------------------------------------------------------------------------
// User prompt template
// ---------------------------------------------------------------------------

export function buildUserPrompt(input: DeviationDetectionInput): string {
  const contextLine = input.projectContext
    ? `Project context: ${input.projectContext}\n\n`
    : ''

  return (
    `${contextLine}` +
    `Compare the INCOMING CHANGE OBSERVATIONS against the ESTABLISHED BASELINE to detect deviations.\n\n` +
    `ESTABLISHED BASELINE (${input.baseline.length} entries):\n` +
    `${JSON.stringify(input.baseline, null, 2)}\n\n` +
    `INCOMING CHANGE OBSERVATIONS (${input.changeObservations.length} entries):\n` +
    `${JSON.stringify(input.changeObservations, null, 2)}\n\n` +
    `Return a JSON array of ArchObservation objects (kind="deviation") as specified in the system prompt.`
  )
}

// ---------------------------------------------------------------------------
// Output parser / validator
// ---------------------------------------------------------------------------

export function parseOutput(rawOutput: string): DeviationDetectionOutput {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawOutput.trim())
  } catch (err) {
    throw new Error(
      `[deviation-detection v${PROMPT_VERSION}] LLM output is not valid JSON: ${String(err)}\nRaw: ${rawOutput.slice(0, 200)}`,
    )
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `[deviation-detection v${PROMPT_VERSION}] Expected JSON array, got: ${typeof parsed}`,
    )
  }

  const results: ArchObservation[] = []
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as Record<string, unknown>
    _validateDeviationObservation(item, i)
    results.push(item as unknown as ArchObservation)
  }

  return results
}

// ---------------------------------------------------------------------------
// Deviation-specific validation
// ---------------------------------------------------------------------------

const VALID_SEVERITIES = ['high', 'medium', 'low'] as const

function _validateDeviationObservation(
  item: Record<string, unknown>,
  index: number,
): void {
  _validateObservation(item, index, 'deviation')

  const payload = item['payload'] as Record<string, unknown>

  if (typeof payload['description'] !== 'string' || payload['description'].length === 0) {
    throw new Error(
      `[deviation-detection v${PROMPT_VERSION}] item[${index}].payload.description must be a non-empty string`,
    )
  }

  if (typeof payload['deviatesFrom'] !== 'object' || payload['deviatesFrom'] === null) {
    throw new Error(
      `[deviation-detection v${PROMPT_VERSION}] item[${index}].payload.deviatesFrom must be an object`,
    )
  }

  const deviatesFrom = payload['deviatesFrom'] as Record<string, unknown>
  const validKinds = ['pattern', 'convention', 'decision']
  if (!validKinds.includes(deviatesFrom['kind'] as string)) {
    throw new Error(
      `[deviation-detection v${PROMPT_VERSION}] item[${index}].payload.deviatesFrom.kind must be one of: ${validKinds.join(', ')}`,
    )
  }

  if (typeof deviatesFrom['id'] !== 'string' || deviatesFrom['id'].length === 0) {
    throw new Error(
      `[deviation-detection v${PROMPT_VERSION}] item[${index}].payload.deviatesFrom.id must be a non-empty string`,
    )
  }

  if (!VALID_SEVERITIES.includes(payload['severity'] as typeof VALID_SEVERITIES[number])) {
    throw new Error(
      `[deviation-detection v${PROMPT_VERSION}] item[${index}].payload.severity must be one of: ${VALID_SEVERITIES.join(', ')}`,
    )
  }
}
