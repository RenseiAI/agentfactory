/**
 * Architectural Intelligence — Eval Rubric Harness
 *
 * Architecture reference: donmai-architecture/007-intelligence-services.md
 * §"Architectural Intelligence" — Synthesis prompts
 *
 * Evaluation harness for synthesis prompt quality.
 *
 * evaluatePrompt(prompt, fixtureInputs, goldenOutputs) returns a scoring
 * breakdown covering:
 *   - Structural validity: does the output parse and conform to ArchObservation?
 *   - Precision: of extracted concepts, how many match golden examples?
 *   - Recall: of golden concepts, how many are covered by actual output?
 *   - Confidence calibration: are confidence values in the expected range?
 *   - Kind correctness: do all observations have the expected kind?
 *
 * The harness does NOT call a live LLM. It accepts a `ModelAdapter` that
 * callers provide. Tests inject a deterministic stub adapter.
 *
 * Usage:
 *   const result = await evaluatePrompt(
 *     promptRegistry.patternExtraction.v1,
 *     { observations: FIXTURE_AUTH_STREAM_INPUT },
 *     FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS,
 *     mockAdapter,
 *   )
 *   console.log(result.score) // 0.85
 */

import type { ArchObservation } from './types.js'
import type { PromptModule } from './prompts/index.js'

// ---------------------------------------------------------------------------
// ModelAdapter — the LLM interface the harness calls
// ---------------------------------------------------------------------------

/**
 * Minimal LLM interface required by the eval harness.
 *
 * In production: implement this against your LLM client (Anthropic SDK, etc.).
 * In tests: use createStubAdapter() or a custom mock.
 */
export interface ModelAdapter {
  /**
   * Send a chat completion request.
   *
   * @param systemPrompt - The system role message.
   * @param userPrompt - The user role message.
   * @returns The assistant's raw text response.
   */
  complete(systemPrompt: string, userPrompt: string): Promise<string>
}

// ---------------------------------------------------------------------------
// Concept extraction — maps observations to comparable concept sets
// ---------------------------------------------------------------------------

/**
 * Extract a set of "concept tokens" from an ArchObservation for comparison.
 *
 * Two observations are considered to cover the same concept when their
 * concept token sets have Jaccard similarity >= conceptMatchThreshold.
 *
 * Concept tokens: lowercased words from title + tags (if present).
 */
function extractConcepts(obs: ArchObservation): Set<string> {
  const payload = obs.payload as Record<string, unknown> | null | undefined
  const concepts = new Set<string>()

  if (!payload || typeof payload !== 'object') return concepts

  const title = typeof payload['title'] === 'string' ? payload['title'] : ''
  for (const word of title.toLowerCase().split(/\W+/)) {
    if (word.length >= 3) concepts.add(word)
  }

  const tags = Array.isArray(payload['tags']) ? payload['tags'] : []
  for (const tag of tags) {
    if (typeof tag === 'string') concepts.add(tag.toLowerCase())
  }

  return concepts
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0
  if (a.size === 0 || b.size === 0) return 0.0

  let intersection = 0
  for (const t of a) {
    if (b.has(t)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

// ---------------------------------------------------------------------------
// EvalScore — the output of the harness
// ---------------------------------------------------------------------------

export interface EvalScore {
  /**
   * Composite score in [0, 1].
   * Weighted average of precision, recall, confidence calibration, and
   * structural validity.
   */
  score: number

  /** Fraction of actual output concepts that match golden concepts. */
  precision: number

  /** Fraction of golden concepts covered by actual output. */
  recall: number

  /** F1 = harmonic mean of precision and recall. */
  f1: number

  /** Fraction of output observations with confidence in [0, 0.95]. */
  confidenceCalibration: number

  /** Fraction of output observations that parse and validate successfully. */
  structuralValidity: number

  /** Fraction of output observations with the correct kind. */
  kindCorrectness: number

  /** Number of output observations. */
  actualCount: number

  /** Number of golden observations. */
  goldenCount: number

  /** Error details (if any observations failed structural validation). */
  errors: string[]
}

// ---------------------------------------------------------------------------
// EvalConfig
// ---------------------------------------------------------------------------

export interface EvalConfig {
  /**
   * Jaccard similarity threshold for two concepts to be considered matching.
   * Default: 0.4 (intentionally loose — concepts are paraphrases).
   */
  conceptMatchThreshold?: number

  /**
   * Weights for the composite score.
   * Must sum to 1.0. Default: equal weighting of 5 dimensions.
   */
  weights?: {
    precision?: number
    recall?: number
    confidenceCalibration?: number
    structuralValidity?: number
    kindCorrectness?: number
  }
}

const DEFAULT_CONCEPT_THRESHOLD = 0.4
const DEFAULT_WEIGHTS = {
  precision: 0.25,
  recall: 0.30,
  confidenceCalibration: 0.15,
  structuralValidity: 0.20,
  kindCorrectness: 0.10,
}

// ---------------------------------------------------------------------------
// evaluatePrompt — main harness entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate a synthesis prompt against a fixture input and golden output.
 *
 * Steps:
 * 1. Run the prompt through the model adapter.
 * 2. Parse the output (structural validity check).
 * 3. Score against golden examples (precision/recall).
 * 4. Return a breakdown of all scoring dimensions.
 *
 * @param prompt - A PromptModule (e.g., promptRegistry.patternExtraction.v1).
 * @param input - The fixture input for this prompt kind.
 * @param goldenOutput - Curated expected output observations.
 * @param adapter - The model adapter (real or stub).
 * @param config - Optional scoring configuration.
 */
export async function evaluatePrompt<TInput>(
  prompt: PromptModule<TInput, ArchObservation[]>,
  input: TInput,
  goldenOutput: ArchObservation[],
  adapter: ModelAdapter,
  config: EvalConfig = {},
): Promise<EvalScore> {
  const threshold = config.conceptMatchThreshold ?? DEFAULT_CONCEPT_THRESHOLD
  const weights = { ...DEFAULT_WEIGHTS, ...config.weights }

  // Normalize weights to sum to 1.0
  const weightSum =
    (weights.precision ?? 0) +
    (weights.recall ?? 0) +
    (weights.confidenceCalibration ?? 0) +
    (weights.structuralValidity ?? 0) +
    (weights.kindCorrectness ?? 0)

  const wPrec = (weights.precision ?? 0) / weightSum
  const wRec = (weights.recall ?? 0) / weightSum
  const wConf = (weights.confidenceCalibration ?? 0) / weightSum
  const wStruct = (weights.structuralValidity ?? 0) / weightSum
  const wKind = (weights.kindCorrectness ?? 0) / weightSum

  // --- Step 1: Run through model adapter ---
  const systemPrompt = prompt.SYSTEM_PROMPT
  const userPrompt = prompt.buildUserPrompt(input)
  const rawOutput = await adapter.complete(systemPrompt, userPrompt)

  // --- Step 2: Parse and validate structural validity ---
  const errors: string[] = []
  let actualObs: ArchObservation[] = []
  let structuralValidity = 0.0

  try {
    actualObs = prompt.parseOutput(rawOutput)
    structuralValidity = 1.0
  } catch (err) {
    errors.push(String(err))
    structuralValidity = 0.0
    // Return early with zero score — cannot score unparseable output
    return {
      score: 0,
      precision: 0,
      recall: 0,
      f1: 0,
      confidenceCalibration: 0,
      structuralValidity: 0,
      kindCorrectness: 0,
      actualCount: 0,
      goldenCount: goldenOutput.length,
      errors,
    }
  }

  // --- Step 3: Kind correctness ---
  let kindCorrect = 0
  const expectedKind = prompt.PROMPT_KIND.split('-')[0] === 'pattern'
    ? 'pattern'
    : prompt.PROMPT_KIND.split('-')[0] === 'convention'
      ? 'convention'
      : prompt.PROMPT_KIND.split('-')[0] === 'decision'
        ? 'decision'
        : prompt.PROMPT_KIND.split('-')[0] === 'deviation'
          ? 'deviation'
          : null

  if (expectedKind !== null && actualObs.length > 0) {
    for (const obs of actualObs) {
      if (obs.kind === expectedKind) kindCorrect++
    }
    kindCorrect = kindCorrect / actualObs.length
  } else if (actualObs.length === 0) {
    kindCorrect = 1.0 // Empty output is fine
  } else {
    kindCorrect = 1.0 // Unknown kind — skip kind scoring
  }

  // --- Step 4: Confidence calibration ---
  let confCalibrated = 0
  if (actualObs.length > 0) {
    for (const obs of actualObs) {
      if (obs.confidence >= 0 && obs.confidence <= 0.95) {
        confCalibrated++
      }
    }
    confCalibrated = confCalibrated / actualObs.length
  } else {
    confCalibrated = 1.0 // No observations to miscalibrate
  }

  // --- Step 5: Precision / Recall via concept matching ---
  if (goldenOutput.length === 0 && actualObs.length === 0) {
    // Both empty — perfect score
    return {
      score: 1.0,
      precision: 1.0,
      recall: 1.0,
      f1: 1.0,
      confidenceCalibration: confCalibrated,
      structuralValidity,
      kindCorrectness: kindCorrect,
      actualCount: 0,
      goldenCount: 0,
      errors,
    }
  }

  if (goldenOutput.length === 0) {
    // Golden is empty but we produced output — precision penalty
    const precision = 0.0
    const recall = 1.0
    const f1 = 0.0
    const score = _computeScore(
      { precision, recall, confCalibrated, structuralValidity, kindCorrect },
      { wPrec, wRec, wConf, wStruct, wKind },
    )
    return {
      score,
      precision,
      recall,
      f1,
      confidenceCalibration: confCalibrated,
      structuralValidity,
      kindCorrectness: kindCorrect,
      actualCount: actualObs.length,
      goldenCount: 0,
      errors,
    }
  }

  // Build concept sets for all actual and golden observations
  const actualConcepts = actualObs.map(extractConcepts)
  const goldenConcepts = goldenOutput.map(extractConcepts)

  // Precision: for each actual observation, does it match any golden?
  let precisionHits = 0
  for (const actualSet of actualConcepts) {
    let matched = false
    for (const goldenSet of goldenConcepts) {
      if (jaccardSimilarity(actualSet, goldenSet) >= threshold) {
        matched = true
        break
      }
    }
    if (matched) precisionHits++
  }

  // Recall: for each golden observation, is it covered by any actual?
  let recallHits = 0
  for (const goldenSet of goldenConcepts) {
    let covered = false
    for (const actualSet of actualConcepts) {
      if (jaccardSimilarity(actualSet, goldenSet) >= threshold) {
        covered = true
        break
      }
    }
    if (covered) recallHits++
  }

  const precision = actualObs.length > 0 ? precisionHits / actualObs.length : 0
  const recall = goldenOutput.length > 0 ? recallHits / goldenOutput.length : 1.0
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0

  const score = _computeScore(
    { precision, recall, confCalibrated, structuralValidity, kindCorrect },
    { wPrec, wRec, wConf, wStruct, wKind },
  )

  return {
    score,
    precision,
    recall,
    f1,
    confidenceCalibration: confCalibrated,
    structuralValidity,
    kindCorrectness: kindCorrect,
    actualCount: actualObs.length,
    goldenCount: goldenOutput.length,
    errors,
  }
}

function _computeScore(
  dims: {
    precision: number
    recall: number
    confCalibrated: number
    structuralValidity: number
    kindCorrect: number
  },
  weights: {
    wPrec: number
    wRec: number
    wConf: number
    wStruct: number
    wKind: number
  },
): number {
  return (
    dims.precision * weights.wPrec +
    dims.recall * weights.wRec +
    dims.confCalibrated * weights.wConf +
    dims.structuralValidity * weights.wStruct +
    dims.kindCorrect * weights.wKind
  )
}

// ---------------------------------------------------------------------------
// createStubAdapter — deterministic stub for tests
// ---------------------------------------------------------------------------

/**
 * Create a deterministic stub ModelAdapter for tests.
 *
 * The stub maps (systemPrompt, userPrompt) pairs to canned responses.
 * When no match is found, it returns the provided defaultResponse.
 *
 * @param responses - Map of (partial system prompt key) to raw JSON responses.
 * @param defaultResponse - Fallback response. Default: '[]'.
 *
 * @example
 * const adapter = createStubAdapter({
 *   'pattern': JSON.stringify(FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS),
 * })
 */
export function createStubAdapter(
  responses: Record<string, string> = {},
  defaultResponse = '[]',
): ModelAdapter {
  return {
    async complete(systemPrompt: string, _userPrompt: string): Promise<string> {
      // Match by checking if systemPrompt contains the key
      for (const [key, response] of Object.entries(responses)) {
        if (systemPrompt.includes(key)) {
          return response
        }
      }
      return defaultResponse
    },
  }
}

/**
 * Create a stub that always returns a specific JSON response.
 * Most useful for single-prompt tests.
 */
export function createFixedAdapter(response: string): ModelAdapter {
  return {
    async complete(): Promise<string> {
      return response
    },
  }
}
