import { describe, expect, it, vi } from 'vitest'

import {
  CleanupMutationExecutionError,
  executeCleanupMutation,
  type CleanupMutationInput,
} from './cleanup-mutation-policy.js'
import type { AgentSessionState } from './session-storage.js'

const session = {
  trackerSessionId: 'session-1',
  trackerProvider: 'linear',
  issueId: 'issue-1',
  issueIdentifier: 'ABC-1',
  providerSessionId: null,
  worktreePath: '/tmp/worktree',
  status: 'running',
  createdAt: 1,
  updatedAt: 1,
  rowSessionId: 'session-1',
} satisfies AgentSessionState

const input = {
  session,
  action: 'orphan_requeue',
  reason: 'worker_unreachable',
  now: 123,
} satisfies CleanupMutationInput

describe('executeCleanupMutation', () => {
  it('preserves standalone behavior when no composing callback exists', async () => {
    const mutate = vi.fn(async () => 'standalone')

    await expect(executeCleanupMutation({ input, mutate })).resolves.toEqual({
      permitted: true,
      idempotentReplay: false,
      value: 'standalone',
    })
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('retains beforeMutation as a source-compatible fallback', async () => {
    const beforeMutation = vi.fn(async () => ({ permitted: true as const }))
    const mutate = vi.fn(async () => 7)

    await expect(
      executeCleanupMutation({ input, beforeMutation, mutate })
    ).resolves.toEqual({ permitted: true, idempotentReplay: false, value: 7 })
    expect(beforeMutation).toHaveBeenCalledOnce()
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('prefers the executor without double-evaluating beforeMutation', async () => {
    const beforeMutation = vi.fn(async () => ({ permitted: false as const, code: 'stale' }))
    const mutate = vi.fn(async () => 11)
    const executeMutation = vi.fn(async (_input, execute) => ({
      permitted: true as const,
      idempotentReplay: false as const,
      value: await execute(),
    }))

    await expect(
      executeCleanupMutation({ input, beforeMutation, executeMutation, mutate })
    ).resolves.toEqual({
      permitted: true,
      idempotentReplay: false,
      value: 11,
    })
    expect(executeMutation).toHaveBeenCalledOnce()
    expect(beforeMutation).not.toHaveBeenCalled()
    expect(mutate).toHaveBeenCalledOnce()
  })

  it.each([
    {
      name: 'throws before entering',
      executeMutation: async () => {
        throw new Error('authority unavailable')
      },
    },
    {
      name: 'returns malformed output',
      executeMutation: async () => ({ permitted: true }),
    },
    {
      name: 'returns an empty refusal code',
      executeMutation: async () => ({ permitted: false, code: '   ' }),
    },
  ])('fails closed without mutation when the executor $name', async ({ executeMutation }) => {
    const mutate = vi.fn(async () => 'must-not-run')

    const result = await executeCleanupMutation({
      input,
      executeMutation: executeMutation as never,
      mutate,
    })

    expect(result).toMatchObject({
      permitted: false,
      code: 'mutation_executor_failed',
    })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('returns a typed refusal without entering the mutation', async () => {
    const mutate = vi.fn(async () => 'must-not-run')

    await expect(
      executeCleanupMutation({
        input,
        executeMutation: async () => ({
          permitted: false,
          code: 'restart_fence_held',
          detail: 'planned restart',
        }),
        mutate,
      })
    ).resolves.toEqual({
      permitted: false,
      code: 'restart_fence_held',
      detail: 'planned restart',
    })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('accepts a permitted durable replay without re-entering the mutation', async () => {
    const mutate = vi.fn(async () => 'must-not-run')

    await expect(
      executeCleanupMutation({
        input,
        executeMutation: async () => ({
          permitted: true,
          idempotentReplay: true,
        }),
        mutate,
      })
    ).resolves.toEqual({ permitted: true, idempotentReplay: true })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('propagates a post-entry throw as composing ambiguity', async () => {
    const cause = new Error('release claim committed; queue write failed')

    await expect(
      executeCleanupMutation({
        input,
        executeMutation: async (_input, mutate) => ({
          permitted: true,
          idempotentReplay: false,
          value: await mutate(),
        }),
        mutate: async () => {
          throw cause
        },
      })
    ).rejects.toMatchObject({
      name: 'CleanupMutationExecutionError',
      cause,
    } satisfies Partial<CleanupMutationExecutionError>)
  })

  it('refuses an executor that invokes the mutation more than once', async () => {
    const mutate = vi.fn(async () => 1)

    await expect(
      executeCleanupMutation({
        input,
        executeMutation: async (_input, execute) => {
          await execute()
          return {
            permitted: true,
            idempotentReplay: false,
            value: await execute(),
          }
        },
        mutate,
      })
    ).rejects.toBeInstanceOf(CleanupMutationExecutionError)
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('retains a duplicate-attempt violation when the executor swallows it', async () => {
    const mutate = vi.fn(async () => 1)

    await expect(
      executeCleanupMutation({
        input,
        executeMutation: async (_input, execute) => {
          const value = await execute()
          await execute().catch(() => undefined)
          return {
            permitted: true,
            idempotentReplay: false,
            value,
          }
        },
        mutate,
      })
    ).rejects.toBeInstanceOf(CleanupMutationExecutionError)
    expect(mutate).toHaveBeenCalledOnce()
  })

  it('retains a concurrent duplicate-attempt violation after both calls settle', async () => {
    const mutate = vi.fn(async () => 1)

    await expect(
      executeCleanupMutation({
        input,
        executeMutation: async (_input, execute) => {
          const outcomes = await Promise.allSettled([execute(), execute()])
          const first = outcomes[0]
          if (first.status !== 'fulfilled') throw first.reason
          return {
            permitted: true,
            idempotentReplay: false,
            value: first.value,
          }
        },
        mutate,
      })
    ).rejects.toBeInstanceOf(CleanupMutationExecutionError)
    expect(mutate).toHaveBeenCalledOnce()
  })

  it.each([
    {
      name: 'refusal',
      execute: async () => ({
        permitted: false as const,
        code: 'restart_fence_held',
      }),
      assertOutcome: async (outcome: Promise<unknown>) => {
        await expect(outcome).resolves.toEqual({
          permitted: false,
          code: 'restart_fence_held',
        })
      },
      expectedMutations: 0,
    },
    {
      name: 'replay',
      execute: async () => ({
        permitted: true as const,
        idempotentReplay: true as const,
      }),
      assertOutcome: async (outcome: Promise<unknown>) => {
        await expect(outcome).resolves.toEqual({
          permitted: true,
          idempotentReplay: true,
        })
      },
      expectedMutations: 0,
    },
    {
      name: 'malformed output',
      execute: async () => ({ permitted: true as const }),
      assertOutcome: async (outcome: Promise<unknown>) => {
        await expect(outcome).resolves.toMatchObject({
          permitted: false,
          code: 'mutation_executor_failed',
        })
      },
      expectedMutations: 0,
    },
    {
      name: 'fresh result',
      execute: async (run: () => Promise<unknown>) => ({
        permitted: true as const,
        idempotentReplay: false as const,
        value: await run(),
      }),
      assertOutcome: async (outcome: Promise<unknown>) => {
        await expect(outcome).resolves.toEqual({
          permitted: true,
          idempotentReplay: false,
          value: 1,
        })
      },
      expectedMutations: 1,
    },
    {
      name: 'typed pre-entry throw',
      execute: async () => {
        throw new CleanupMutationExecutionError('caller-owned error class')
      },
      assertOutcome: async (outcome: Promise<unknown>) => {
        await expect(outcome).resolves.toMatchObject({
          permitted: false,
          code: 'mutation_executor_failed',
          detail: 'caller-owned error class',
        })
      },
      expectedMutations: 0,
    },
  ])(
    'deactivates a retained mutation closure after $name settlement',
    async ({ execute, assertOutcome, expectedMutations }) => {
      let retainedMutation: (() => Promise<unknown>) | undefined
      const mutate = vi.fn(async () => 1)

      const outcome = executeCleanupMutation({
        input,
        executeMutation: async (_input, run) => {
          retainedMutation = run
          return execute(run) as never
        },
        mutate,
      })

      await assertOutcome(outcome)
      expect(retainedMutation).toBeDefined()
      await expect(retainedMutation!()).rejects.toBeInstanceOf(
        CleanupMutationExecutionError
      )
      expect(mutate).toHaveBeenCalledTimes(expectedMutations)
    }
  )
})
