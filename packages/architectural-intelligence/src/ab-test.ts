/**
 * Architectural Intelligence — A/B Testing Harness
 *
 * Architecture reference: donmai-architecture/007-intelligence-services.md
 * §"Architectural Intelligence" — Synthesis prompts
 *
 * A/B harness to compare prompt versions on the same input stream.
 *
 * compareABPrompts(promptA, promptB, inputs, goldenOutputs, adapter) runs both
 * prompts against all inputs and returns side-by-side metrics for each run,
 * plus aggregate deltas.
 *
 * Design goals:
 * - Same input stream → comparable apples-to-apples eval
 * - Side-by-side breakdown: per-run scores + aggregate summary
 * - No live LLM required — callers provide a ModelAdapter
 * - Works for any PromptModule (pattern, convention, decision, deviation)
 *
 * Usage:
 *   const result = await compareABPrompts(
 *     promptRegistry.patternExtraction.v1,
 *     promptRegistry.patternExtraction.v2,  // hypothetical future version
 *     [{ observations: FIXTURE_AUTH_STREAM_INPUT }],
 *     [FIXTURE_AUTH_STREAM_GOLDEN_PATTERNS],
 *     adapterA,  // adapter that returns v1-style responses
 *     adapterB,  // adapter that returns v2-style responses
 *   )
 *   console.log(result.winner)           // 'A' | 'B' | 'tie'
 *   console.log(result.deltaScore)       // 0.05 (B is 5% better)
 */

import type { ArchObservation } from './types.js'
import type { PromptModule } from './prompts/index.js'
import { evaluatePrompt, type ModelAdapter, type EvalScore, type EvalConfig } from './eval.js'

// ---------------------------------------------------------------------------
// ABRunResult — result for one input/prompt pair
// ---------------------------------------------------------------------------

export interface ABRunResult {
  /** Input index (0-based) */
  inputIndex: number
  /** Score for prompt A */
  scoreA: EvalScore
  /** Score for prompt B */
  scoreB: EvalScore
  /** Score delta: B.score - A.score (positive = B wins) */
  delta: number
  /** Which prompt won this input: 'A' | 'B' | 'tie' */
  winner: 'A' | 'B' | 'tie'
}

// ---------------------------------------------------------------------------
// ABSummary — aggregate summary across all inputs
// ---------------------------------------------------------------------------

export interface ABSummary {
  /** Average score for prompt A across all inputs */
  avgScoreA: number
  /** Average score for prompt B across all inputs */
  avgScoreB: number
  /** Average delta: avgScoreB - avgScoreA */
  avgDelta: number
  /** Which prompt won overall: 'A' | 'B' | 'tie' */
  winner: 'A' | 'B' | 'tie'
  /** Average precision for A */
  avgPrecisionA: number
  /** Average precision for B */
  avgPrecisionB: number
  /** Average recall for A */
  avgRecallA: number
  /** Average recall for B */
  avgRecallB: number
  /** Average F1 for A */
  avgF1A: number
  /** Average F1 for B */
  avgF1B: number
  /** Number of inputs where A won */
  aWins: number
  /** Number of inputs where B won */
  bWins: number
  /** Number of ties */
  ties: number
  /** Total inputs processed */
  totalInputs: number
}

// ---------------------------------------------------------------------------
// ABTestResult — full output
// ---------------------------------------------------------------------------

export interface ABTestResult {
  /** Prompt A version string */
  promptAVersion: string
  /** Prompt A kind */
  promptAKind: string
  /** Prompt B version string */
  promptBVersion: string
  /** Prompt B kind */
  promptBKind: string
  /** Per-input results */
  runs: ABRunResult[]
  /** Aggregate summary */
  summary: ABSummary
}

// ---------------------------------------------------------------------------
// ABTestConfig
// ---------------------------------------------------------------------------

export interface ABTestConfig {
  /** Tie threshold: if |delta| < tieThreshold, count as a tie. Default: 0.02. */
  tieThreshold?: number
  /** Eval config to pass to evaluatePrompt. */
  evalConfig?: EvalConfig
}

// ---------------------------------------------------------------------------
// compareABPrompts — main entry point
// ---------------------------------------------------------------------------

/**
 * Compare two prompt versions on the same set of inputs.
 *
 * @param promptA - The first prompt to compare (e.g., v1).
 * @param promptB - The second prompt to compare (e.g., v2).
 * @param inputs - Array of inputs — one per eval run. Must be non-empty.
 * @param goldenOutputs - Golden expected outputs, one per input. Must match inputs.length.
 * @param adapterA - ModelAdapter for prompt A.
 * @param adapterB - ModelAdapter for prompt B. Pass the same adapter to test prompts with
 *   a shared model; pass different adapters to test with different models or fixture sets.
 * @param config - Optional configuration.
 *
 * @returns Full A/B comparison result with per-run scores and aggregate summary.
 */
export async function compareABPrompts<TInput>(
  promptA: PromptModule<TInput, ArchObservation[]>,
  promptB: PromptModule<TInput, ArchObservation[]>,
  inputs: TInput[],
  goldenOutputs: ArchObservation[][],
  adapterA: ModelAdapter,
  adapterB: ModelAdapter,
  config: ABTestConfig = {},
): Promise<ABTestResult> {
  if (inputs.length === 0) {
    throw new Error('[compareABPrompts] inputs must be non-empty')
  }

  if (inputs.length !== goldenOutputs.length) {
    throw new Error(
      `[compareABPrompts] inputs.length (${inputs.length}) must equal goldenOutputs.length (${goldenOutputs.length})`,
    )
  }

  const tieThreshold = config.tieThreshold ?? 0.02
  const evalConfig = config.evalConfig ?? {}

  const runs: ABRunResult[] = []

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!
    const golden = goldenOutputs[i]!

    const [scoreA, scoreB] = await Promise.all([
      evaluatePrompt(promptA, input, golden, adapterA, evalConfig),
      evaluatePrompt(promptB, input, golden, adapterB, evalConfig),
    ])

    const delta = scoreB.score - scoreA.score
    const winner: 'A' | 'B' | 'tie' =
      Math.abs(delta) < tieThreshold ? 'tie' : delta > 0 ? 'B' : 'A'

    runs.push({ inputIndex: i, scoreA, scoreB, delta, winner })
  }

  // Aggregate summary
  const n = runs.length
  let sumScoreA = 0
  let sumScoreB = 0
  let sumPrecA = 0
  let sumPrecB = 0
  let sumRecA = 0
  let sumRecB = 0
  let sumF1A = 0
  let sumF1B = 0
  let aWins = 0
  let bWins = 0
  let ties = 0

  for (const run of runs) {
    sumScoreA += run.scoreA.score
    sumScoreB += run.scoreB.score
    sumPrecA += run.scoreA.precision
    sumPrecB += run.scoreB.precision
    sumRecA += run.scoreA.recall
    sumRecB += run.scoreB.recall
    sumF1A += run.scoreA.f1
    sumF1B += run.scoreB.f1

    if (run.winner === 'A') aWins++
    else if (run.winner === 'B') bWins++
    else ties++
  }

  const avgScoreA = sumScoreA / n
  const avgScoreB = sumScoreB / n
  const avgDelta = avgScoreB - avgScoreA
  const overallWinner: 'A' | 'B' | 'tie' =
    Math.abs(avgDelta) < tieThreshold ? 'tie' : avgDelta > 0 ? 'B' : 'A'

  const summary: ABSummary = {
    avgScoreA,
    avgScoreB,
    avgDelta,
    winner: overallWinner,
    avgPrecisionA: sumPrecA / n,
    avgPrecisionB: sumPrecB / n,
    avgRecallA: sumRecA / n,
    avgRecallB: sumRecB / n,
    avgF1A: sumF1A / n,
    avgF1B: sumF1B / n,
    aWins,
    bWins,
    ties,
    totalInputs: n,
  }

  return {
    promptAVersion: promptA.PROMPT_VERSION,
    promptAKind: promptA.PROMPT_KIND,
    promptBVersion: promptB.PROMPT_VERSION,
    promptBKind: promptB.PROMPT_KIND,
    runs,
    summary,
  }
}

// ---------------------------------------------------------------------------
// formatABReport — human-readable summary
// ---------------------------------------------------------------------------

/**
 * Format an A/B test result as a human-readable report string.
 *
 * Useful for logging prompt comparison results during development.
 *
 * @example
 * const result = await compareABPrompts(...)
 * console.log(formatABReport(result))
 */
export function formatABReport(result: ABTestResult): string {
  const { summary } = result
  const lines: string[] = [
    `A/B Prompt Comparison`,
    `  A: ${result.promptAKind}@${result.promptAVersion}`,
    `  B: ${result.promptBKind}@${result.promptBVersion}`,
    ``,
    `Summary (${summary.totalInputs} input(s)):`,
    `  Score  A=${summary.avgScoreA.toFixed(3)}  B=${summary.avgScoreB.toFixed(3)}  Δ=${summary.avgDelta >= 0 ? '+' : ''}${summary.avgDelta.toFixed(3)}`,
    `  Prec   A=${summary.avgPrecisionA.toFixed(3)}  B=${summary.avgPrecisionB.toFixed(3)}`,
    `  Recall A=${summary.avgRecallA.toFixed(3)}  B=${summary.avgRecallB.toFixed(3)}`,
    `  F1     A=${summary.avgF1A.toFixed(3)}  B=${summary.avgF1B.toFixed(3)}`,
    `  Wins   A=${summary.aWins}  B=${summary.bWins}  Ties=${summary.ties}`,
    `  Overall winner: ${summary.winner}`,
  ]

  if (result.runs.length > 1) {
    lines.push(``, `Per-run:`)
    for (const run of result.runs) {
      const delta = run.delta >= 0 ? `+${run.delta.toFixed(3)}` : run.delta.toFixed(3)
      lines.push(
        `  [${run.inputIndex}] A=${run.scoreA.score.toFixed(3)} B=${run.scoreB.score.toFixed(3)} Δ=${delta} winner=${run.winner}`,
      )
    }
  }

  return lines.join('\n')
}
