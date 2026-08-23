import type { AgentSessionState } from './session-storage.js'

/** Cleanup mutations that can release, requeue, promote, or terminalize work. */
export type CleanupMutationAction =
  | 'orphan_requeue'
  | 'zombie_redispatch'
  | 'stranded_terminalize'
  | 'expired_lock_promote'
  | 'stale_lock_release'

export type CleanupMutationReason =
  | 'worker_unreachable'
  | 'pending_unqueued'
  | 'dispatch_stranded'
  | 'expired_issue_lock'
  | 'stale_issue_lock'

export interface CleanupMutationInput {
  session: AgentSessionState
  action: CleanupMutationAction
  reason: CleanupMutationReason
  now: number
}

export type CleanupMutationDecision =
  | { permitted: true }
  | { permitted: false; code: string; detail?: string }

export type BeforeCleanupMutation = (
  input: CleanupMutationInput
) => Promise<CleanupMutationDecision>

export type CleanupMutationExecutionResult<T> =
  | { permitted: true; idempotentReplay: false; value: T }
  | { permitted: true; idempotentReplay: true }
  | Extract<CleanupMutationDecision, { permitted: false }>

/** Around-mutation composition seam for transactional or revision-CAS hosts. */
export type ExecuteCleanupMutation = <T>(
  input: CleanupMutationInput,
  mutate: () => Promise<T>
) => Promise<CleanupMutationExecutionResult<T>>

/**
 * The executor entered the mutation closure before failing its contract.
 * Callers must reconcile this as ambiguous rather than convert it to refusal.
 */
export class CleanupMutationExecutionError extends Error {
  readonly cause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'CleanupMutationExecutionError'
    this.cause = cause
  }
}

function executorFailure(detail: string): Extract<
  CleanupMutationDecision,
  { permitted: false }
> {
  return {
    permitted: false,
    code: 'mutation_executor_failed',
    detail,
  }
}

function validateExecutionResult<T>(
  value: unknown
): CleanupMutationExecutionResult<T> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>
  if (result.permitted === true) {
    if (
      result.idempotentReplay === true &&
      !Object.prototype.hasOwnProperty.call(result, 'value')
    ) {
      return value as CleanupMutationExecutionResult<T>
    }
    if (
      result.idempotentReplay === false &&
      Object.prototype.hasOwnProperty.call(result, 'value')
    ) {
      return value as CleanupMutationExecutionResult<T>
    }
    return null
  }
  if (
    result.permitted === false &&
    typeof result.code === 'string' &&
    result.code.trim() &&
    (result.detail === undefined || typeof result.detail === 'string')
  ) {
    return value as CleanupMutationExecutionResult<T>
  }
  return null
}

/**
 * Evaluate a composing policy without ever converting an error or malformed
 * refusal into permission. Absence preserves the standalone OSS behavior.
 */
export async function evaluateCleanupMutationPolicy(
  beforeMutation: BeforeCleanupMutation | undefined,
  input: CleanupMutationInput
): Promise<CleanupMutationDecision> {
  if (!beforeMutation) return { permitted: true }

  try {
    const decision = await beforeMutation(input)
    if (decision.permitted) return decision
    if (!decision.code.trim()) {
      return {
        permitted: false,
        code: 'pre_mutation_predicate_failed',
        detail: 'pre-mutation predicate returned an empty refusal code',
      }
    }
    return decision
  } catch (err) {
    return {
      permitted: false,
      code: 'pre_mutation_predicate_failed',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Execute one complete cleanup mutation under the strongest available seam.
 *
 * `executeMutation` is authoritative when present; `beforeMutation` is retained
 * only as a backward-compatible fallback. A pre-entry executor failure or
 * malformed result fails closed. Once the closure is entered, any throw,
 * duplicate invocation, swallowed failure, or malformed result is ambiguous and
 * propagates so a composing host can retain its durable intent.
 */
export async function executeCleanupMutation<T>(options: {
  input: CleanupMutationInput
  mutate: () => Promise<T>
  executeMutation?: ExecuteCleanupMutation
  beforeMutation?: BeforeCleanupMutation
}): Promise<CleanupMutationExecutionResult<T>> {
  const { input, mutate, executeMutation, beforeMutation } = options

  if (!executeMutation) {
    const decision = await evaluateCleanupMutationPolicy(beforeMutation, input)
    if (!decision.permitted) return decision
    return {
      permitted: true,
      idempotentReplay: false,
      value: await mutate(),
    }
  }

  let entered = false
  let completed = false
  let active = true
  let duplicateAttempted = false
  const guardedMutation = async (): Promise<T> => {
    if (!active) {
      throw new CleanupMutationExecutionError(
        'cleanup mutation executor invoked mutate after settlement'
      )
    }
    if (entered) {
      duplicateAttempted = true
      throw new CleanupMutationExecutionError(
        'cleanup mutation executor invoked mutate more than once'
      )
    }
    entered = true
    try {
      const value = await mutate()
      completed = true
      return value
    } catch (err) {
      throw new CleanupMutationExecutionError(
        'cleanup mutation failed after executor entry',
        err
      )
    }
  }

  let rawResult: unknown
  let executorFailed = false
  let executorError: unknown
  try {
    rawResult = await executeMutation(input, guardedMutation)
  } catch (err) {
    executorFailed = true
    executorError = err
  } finally {
    active = false
  }

  if (duplicateAttempted) {
    throw new CleanupMutationExecutionError(
      'cleanup mutation executor invoked mutate more than once',
      executorError
    )
  }
  if (executorFailed) {
    if (entered) {
      if (executorError instanceof CleanupMutationExecutionError) {
        throw executorError
      }
      throw new CleanupMutationExecutionError(
        'cleanup mutation executor failed after mutation entry',
        executorError
      )
    }
    return executorFailure(
      executorError instanceof Error
        ? executorError.message
        : String(executorError)
    )
  }

  const result = validateExecutionResult<T>(rawResult)
  if (!result) {
    if (entered) {
      throw new CleanupMutationExecutionError(
        'cleanup mutation executor returned malformed output after mutation entry'
      )
    }
    return executorFailure('cleanup mutation executor returned malformed output')
  }

  if (!result.permitted) {
    if (entered) {
      throw new CleanupMutationExecutionError(
        'cleanup mutation executor refused after mutation entry'
      )
    }
    return result
  }
  if (result.idempotentReplay) {
    if (entered) {
      throw new CleanupMutationExecutionError(
        'cleanup mutation executor reported replay after mutation entry'
      )
    }
    return result
  }
  if (!entered) {
    return executorFailure(
      'cleanup mutation executor reported a fresh result without invoking the mutation'
    )
  }
  if (!completed) {
    throw new CleanupMutationExecutionError(
      'cleanup mutation executor returned before the mutation completed'
    )
  }
  return result
}
