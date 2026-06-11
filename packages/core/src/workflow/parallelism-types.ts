/**
 * Parallelism Types
 *
 * Type definitions for the parallel task execution system.
 * These types define the contract between the ParallelismExecutor,
 * strategy implementations, and calling code.
 */

import type { ParallelismGroupDefinition } from './workflow-types.js'

/**
 * A single task to be executed in parallel.
 */
export interface ParallelTask {
  /** Unique task identifier (typically the issue identifier) */
  id: string
  /** Issue identifier (e.g., "ABC-123") */
  issueId: string
  /** Phase name this task belongs to */
  phaseName: string
  /** Additional context for the task */
  context?: Record<string, unknown>
}

/**
 * Result of a single parallel task execution.
 */
export interface ParallelTaskResult {
  /** Task identifier */
  id: string
  /** Issue identifier */
  issueId: string
  /** Whether the task completed successfully */
  success: boolean
  /** Collected phase outputs (if any) */
  outputs?: Record<string, unknown>
  /** Duration in milliseconds */
  durationMs?: number
}

/**
 * Error details for a failed parallel task.
 */
export interface ParallelTaskError {
  /** Task identifier */
  id: string
  /** Issue identifier */
  issueId: string
  /** Error message */
  error: string
}

/**
 * Result of executing a parallelism group.
 */
export interface ParallelismResult {
  /** Strategy that was used */
  strategy: 'fan-out' | 'fan-in' | 'race'
  /** Tasks that completed (successfully or not) */
  completed: ParallelTaskResult[]
  /** Issue IDs that were cancelled (race strategy) */
  cancelled: string[]
  /** Tasks that failed with errors */
  failed: ParallelTaskError[]
  /** Per-issue phase outputs collected from completed tasks */
  outputs: Record<string, Record<string, unknown>>
}

/**
 * Interface for parallelism strategy implementations.
 */
export interface ParallelismStrategy {
  /** Execute a set of parallel tasks with the given options */
  execute(
    tasks: ParallelTask[],
    options: ParallelismStrategyOptions,
  ): Promise<ParallelismResult>
}

/**
 * Options passed to strategy implementations.
 */
export interface ParallelismStrategyOptions {
  /** Maximum concurrent executions */
  maxConcurrent?: number
  /** Whether to wait for all tasks to complete */
  waitForAll?: boolean
  /** Dispatch function that actually starts the agent work */
  dispatch: (task: ParallelTask) => Promise<ParallelTaskResult>
}
