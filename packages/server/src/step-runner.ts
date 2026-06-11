/**
 * Cooperative Step Runner (Decision 4)
 *
 * Wraps a session's step loop with the cancel/resume contract from the
 * long-running runtime substrate ADR.  Per step:
 *
 *   1. Observe the cancel signal via `isCancelRequested(sessionId)`.
 *      Between-step observation is the default; `interrupt: 'safe'` may
 *      escalate observation when the step explicitly declared a
 *      checkpoint primitive; `interrupt: 'unsafe'` kills the worker
 *      subprocess when the step is also marked `idempotent`.
 *   2. Write a `running` journal entry before invoking the
 *      step body.
 *   3. Run the step body; on success write `completed` (and the
 *      step's content-addressable output pointer); on error write
 *      `failed` with the error message.
 *   4. After each step, observe cancel again — if the flag is set,
 *      emit `session.cancelled` and terminate the loop.
 *
 * Architecture references:
 *   - donmai-architecture/ADR-2026-04-29-long-running-runtime-substrate.md
 *     (commit 56f2bc6) — Decision 4 (Cooperative cancel; per-step
 *     interrupt config).
 *   - `writeJournalEntry` / `computeIdempotencyHash` are the
 *     consumed APIs.
 *
 * Design notes:
 *   - The runner is intentionally framework-agnostic: the step body is
 *     a `(ctx) => Promise<StepOutput>` callback, so the same primitive
 *     wires into the workflow engine, ad-hoc orchestrator runs, and
 *     tests.
 *   - `unsafe` interrupt does NOT call `process.exit` from this module
 *     — it surfaces a `'kill'` mode in the result so the worker runner
 *     (which owns subprocess lifecycle) can do the kill.  This keeps
 *     the runner side-effect-free for testing.
 */

import {
  computeIdempotencyHash,
  writeJournalEntry,
} from './journal.js'
import {
  confirmSessionCancelled,
  isCancelRequested,
  readCancelRecord,
} from './session-cancel.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[step-runner] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[step-runner] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.error(`[step-runner] ${msg}`, data ? JSON.stringify(data) : ''),
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-step interrupt policy.  Default (omitted) is "cooperative": cancel
 * is observed only between steps.
 *
 *   - `safe`: the step has registered a checkpoint primitive.  The
 *     runner may attempt mid-step interrupt; if no checkpoint primitive
 *     was declared, the interrupt is a no-op (cooperative fallback).
 *   - `unsafe`: the runner may kill the worker subprocess mid-step.
 *     Requires the step to also be marked `idempotent: true` so the
 *     replay can re-execute the step from scratch.
 */
export type StepInterruptPolicy = 'safe' | 'unsafe'

export interface StepDefinition<I = unknown, O = unknown> {
  /** Workflow node id used for journal keying + idempotency hashing. */
  stepId: string
  /** Workflow definition version (input to idempotency hash). */
  nodeVersion: string
  /** The step's input payload — hashed for idempotency. */
  input: I
  /** Per-step interrupt policy (see above). */
  interrupt?: StepInterruptPolicy
  /**
   * Whether the step body is safe to re-execute.  Required for
   * `interrupt: 'unsafe'`; informational otherwise.
   */
  idempotent?: boolean
  /**
   * Whether the step has registered a checkpoint primitive.  When
   * `interrupt: 'safe'` is set without a checkpoint primitive, the
   * runner falls back to cooperative cancel and logs a warning.
   */
  hasCheckpoint?: boolean
  /**
   * Step body.  Returns the content-addressable storage pointer for
   * the step's output (caller-supplied — the runner does not interpret
   * the value).
   */
  run: (ctx: StepRunContext) => Promise<StepRunOutput<O>>
}

export interface StepRunContext {
  sessionId: string
  stepId: string
  /**
   * Resolved at the start of the step — `true` if the cancel flag was
   * already set when the worker observed it.  Step bodies that
   * declared `interrupt: 'safe'` may inspect this and short-circuit.
   */
  cancelAlreadyRequested: boolean
}

export interface StepRunOutput<O = unknown> {
  /** Pointer to the step's output in content-addressable storage. */
  outputCAS: string
  /** Optional in-memory output (mostly for tests + downstream steps). */
  value?: O
}

/**
 * The result of running a single step (success or failure).  Workers
 * use the `cancellationMode` field to decide whether to escalate
 * (kill the subprocess) or wind down cooperatively.
 */
export type StepResult<O = unknown> =
  | {
      kind: 'completed'
      stepId: string
      output: StepRunOutput<O>
      inputHash: string
      startedAt: number
      completedAt: number
    }
  | {
      kind: 'failed'
      stepId: string
      error: string
      inputHash: string
      startedAt: number
      completedAt: number
    }
  | {
      kind: 'cancelled-before-start'
      stepId: string
      inputHash: string
      mode: 'cooperative'
    }
  | {
      kind: 'cancelled-after-step'
      stepId: string
      output: StepRunOutput<O>
      inputHash: string
      startedAt: number
      completedAt: number
      mode: 'cooperative' | 'safe'
    }
  | {
      kind: 'kill-requested'
      stepId: string
      inputHash: string
      mode: 'unsafe'
      /**
       * If the step body had already finished by the time the runner
       * observed the unsafe-cancel, the output pointer is included so
       * the journal can record `completed` before the worker exits.
       */
      output?: StepRunOutput<O>
    }

export interface RunStepOptions {
  sessionId: string
  workerId: string
  /**
   * Optional clock injection for tests.  Defaults to `Date.now`.
   */
  now?: () => number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a single step with cancel observation + journal writes.  Use
 * this from the worker's session loop:
 *
 *   for (const stepDef of steps) {
 *     const result = await runStepWithCancel(stepDef, options)
 *     if (result.kind !== 'completed') break
 *   }
 *   await confirmSessionCancelled(... ) // if loop exited on cancel
 */
export async function runStepWithCancel<I, O>(
  step: StepDefinition<I, O>,
  options: RunStepOptions,
): Promise<StepResult<O>> {
  const now = options.now ?? Date.now
  const inputHash = computeIdempotencyHash(
    step.stepId,
    step.input,
    step.nodeVersion,
  )

  // Pre-step cancel observation.
  const preStartCancel = await isCancelRequested(options.sessionId)
  if (preStartCancel) {
    log.info('Cancel observed before step start — skipping', {
      sessionId: options.sessionId,
      stepId: step.stepId,
    })
    return {
      kind: 'cancelled-before-start',
      stepId: step.stepId,
      inputHash,
      mode: 'cooperative',
    }
  }

  const startedAt = now()
  await writeJournalEntry({
    sessionId: options.sessionId,
    stepId: step.stepId,
    status: 'running',
    inputHash,
    startedAt,
    attempt: 0,
  })

  // Run the step body.
  let runOutput: StepRunOutput<O>
  try {
    runOutput = await step.run({
      sessionId: options.sessionId,
      stepId: step.stepId,
      cancelAlreadyRequested: false,
    })
  } catch (err) {
    const completedAt = now()
    const error = err instanceof Error ? err.message : String(err)
    await writeJournalEntry({
      sessionId: options.sessionId,
      stepId: step.stepId,
      status: 'failed',
      inputHash,
      startedAt,
      completedAt,
      attempt: 0,
      error,
    })
    return {
      kind: 'failed',
      stepId: step.stepId,
      error,
      inputHash,
      startedAt,
      completedAt,
    }
  }

  const completedAt = now()
  await writeJournalEntry({
    sessionId: options.sessionId,
    stepId: step.stepId,
    status: 'completed',
    inputHash,
    outputCAS: runOutput.outputCAS,
    startedAt,
    completedAt,
    attempt: 0,
  })

  // Post-step cancel observation.  This is the canonical "between-step"
  // observation point — the in-flight step has completed, so the
  // session can wind down cleanly without losing work.
  const postCancel = await readCancelRecord(options.sessionId)
  if (!postCancel) {
    return {
      kind: 'completed',
      stepId: step.stepId,
      output: runOutput,
      inputHash,
      startedAt,
      completedAt,
    }
  }

  // A cancel is pending.  Determine the effective interrupt mode.
  const sessionMode = postCancel.interrupt
  const stepMode = step.interrupt
  const effectiveMode = stepMode ?? sessionMode

  if (effectiveMode === 'unsafe') {
    // Unsafe interrupt requires the step to be idempotent — but we are
    // POST step-completion here, so we always have a clean output.  The
    // worker still wants to die fast (the caller signaled `unsafe`),
    // so surface kill-requested with the output already journaled.
    if (!step.idempotent) {
      log.warn(
        'Unsafe cancel requested but step not marked idempotent; falling back to cooperative',
        { sessionId: options.sessionId, stepId: step.stepId },
      )
      return {
        kind: 'cancelled-after-step',
        stepId: step.stepId,
        output: runOutput,
        inputHash,
        startedAt,
        completedAt,
        mode: 'cooperative',
      }
    }
    return {
      kind: 'kill-requested',
      stepId: step.stepId,
      inputHash,
      mode: 'unsafe',
      output: runOutput,
    }
  }

  if (effectiveMode === 'safe') {
    if (step.hasCheckpoint !== true) {
      log.warn(
        'Safe interrupt requested but no checkpoint primitive declared; falling back to cooperative',
        { sessionId: options.sessionId, stepId: step.stepId },
      )
      return {
        kind: 'cancelled-after-step',
        stepId: step.stepId,
        output: runOutput,
        inputHash,
        startedAt,
        completedAt,
        mode: 'cooperative',
      }
    }
    return {
      kind: 'cancelled-after-step',
      stepId: step.stepId,
      output: runOutput,
      inputHash,
      startedAt,
      completedAt,
      mode: 'safe',
    }
  }

  // Default cooperative path: in-flight step completed, then we observed
  // the cancel and wound down.
  return {
    kind: 'cancelled-after-step',
    stepId: step.stepId,
    output: runOutput,
    inputHash,
    startedAt,
    completedAt,
    mode: 'cooperative',
  }
}

// ---------------------------------------------------------------------------
// Loop helper
// ---------------------------------------------------------------------------

export interface RunSessionLoopOptions extends RunStepOptions {
  /** All steps to execute in order — tests + simple workflows. */
  steps: Array<StepDefinition<unknown, unknown>>
}

export interface RunSessionLoopResult {
  /** Steps that completed (in order). */
  completed: string[]
  /** The terminal result of the last attempted step. */
  finalResult: StepResult<unknown>
  /** True if the loop exited because of a cancel signal. */
  cancelled: boolean
  /** The mode the cancel took effect in (when cancelled). */
  cancelMode?: 'cooperative' | 'safe' | 'unsafe'
}

/**
 * Convenience driver — runs a static list of steps with cancel-aware
 * dispatch.  Production workers wire `runStepWithCancel` into their
 * existing loop; this helper covers the simple case + tests.
 *
 * Emits `session.cancelled` on the bus before returning when the loop
 * exits due to a cancel.
 */
export async function runSessionLoop(
  options: RunSessionLoopOptions,
): Promise<RunSessionLoopResult> {
  const completed: string[] = []
  let finalResult: StepResult<unknown> | undefined
  let lastCompletedStepId: string | undefined

  for (const step of options.steps) {
    const result = await runStepWithCancel(step, options)
    finalResult = result

    if (result.kind === 'completed') {
      completed.push(result.stepId)
      lastCompletedStepId = result.stepId
      continue
    }

    if (result.kind === 'cancelled-after-step') {
      completed.push(result.stepId)
      lastCompletedStepId = result.stepId
      await confirmSessionCancelled(options.sessionId, {
        workerId: options.workerId,
        ...(lastCompletedStepId !== undefined && { lastCompletedStepId }),
        mode: result.mode,
      })
      return {
        completed,
        finalResult: result,
        cancelled: true,
        cancelMode: result.mode,
      }
    }

    if (result.kind === 'kill-requested') {
      // The caller (worker runner) is responsible for the actual
      // process kill.  We still emit `session.cancelled` here so
      // observability has a terminal event even if the kill is racy.
      if (result.output !== undefined) {
        completed.push(result.stepId)
        lastCompletedStepId = result.stepId
      }
      await confirmSessionCancelled(options.sessionId, {
        workerId: options.workerId,
        ...(lastCompletedStepId !== undefined && { lastCompletedStepId }),
        mode: 'unsafe',
      })
      return {
        completed,
        finalResult: result,
        cancelled: true,
        cancelMode: 'unsafe',
      }
    }

    if (result.kind === 'cancelled-before-start') {
      await confirmSessionCancelled(options.sessionId, {
        workerId: options.workerId,
        ...(lastCompletedStepId !== undefined && { lastCompletedStepId }),
        mode: 'cooperative',
      })
      return {
        completed,
        finalResult: result,
        cancelled: true,
        cancelMode: 'cooperative',
      }
    }

    // failed — terminate without confirming cancel.
    return { completed, finalResult: result, cancelled: false }
  }

  // Steps exhausted without cancel.
  if (finalResult === undefined) {
    // Empty step list — synthesize a no-op completed result so callers
    // always have a finalResult to inspect.
    finalResult = {
      kind: 'completed',
      stepId: '<empty>',
      output: { outputCAS: '' },
      inputHash: '',
      startedAt: 0,
      completedAt: 0,
    }
  }
  return { completed, finalResult, cancelled: false }
}
