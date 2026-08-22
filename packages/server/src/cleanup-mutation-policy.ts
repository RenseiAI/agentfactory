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
