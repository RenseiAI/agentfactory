/**
 * Scheduling Orchestrator
 *
 * Wires together the filter pipeline and score pipeline
 * into a single scheduling pass. For each work item in priority order:
 *
 *   1. Run filter pipeline -> feasible worker set
 *   2. If no feasible workers -> classify as backoff (transient) or suspend (permanent)
 *   3. Run score pipeline on feasible set -> ranked list
 *   4. Assign to highest-scoring worker
 *   5. Decrement that worker's available capacity for subsequent iterations
 *   6. Record a SchedulingDecision audit record
 *
 * This module is a pure function — it does NOT touch Redis or any I/O. The
 * caller (poll handler, scheduling loop, etc.) is responsible for fetching
 * inputs and acting on the ScheduleResult.
 */

import type { QueuedWork } from '../work-queue.js'
import type { WorkerInfo } from '../worker-storage.js'
import type { SchedulerFilter, FilterPipelineResult } from './filters.js'
import type { SchedulerScorer, ScoringContext, ScoreResult } from './scorers.js'
import { runFilters } from './filters.js'
import { runScorers } from './scorers.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleRequest {
  workItems: QueuedWork[]
  workers: WorkerInfo[]
  filters: SchedulerFilter[]
  scorers: SchedulerScorer[]
  context: ScoringContext
}

export interface ScheduleResult {
  assignments: WorkAssignment[]
  unschedulable: UnschedulableWork[]
  /** Audit records — one per work item (for a follow-up consumer) */
  decisions: SchedulingDecision[]
}

export interface WorkAssignment {
  work: QueuedWork
  worker: WorkerInfo
  score: number
  scores: Map<string, ScoreResult>
}

export interface UnschedulableWork {
  work: QueuedWork
  filterResults: Map<string, string[]>
  action: 'backoff' | 'suspend'
}

/**
 * Audit record for each scheduling decision.
 * A follow-up will extend this for persistence / metrics.
 */
export interface SchedulingDecision {
  workSessionId: string
  outcome: 'assigned' | 'backoff' | 'suspended' | 'no_workers'
  assignedWorkerId?: string
  assignedScore?: number
  totalWorkers: number
  feasibleWorkers: number
  filterDurationMs: number
  scoreDurationMs: number
  totalDurationMs: number
}

// ---------------------------------------------------------------------------
// Filter-reason classification
// ---------------------------------------------------------------------------

/**
 * Filter names whose failure reasons are transient — the situation may
 * change on the next scheduling cycle (e.g. a worker frees capacity,
 * quota replenishes).
 */
const TRANSIENT_FILTERS = new Set([
  'CapacityFilter',
  'QuotaFilter',
])

/**
 * Classify filter failures as transient or permanent.
 *
 * If *any* worker was rejected only by transient filters, the work item
 * should be backed off (retried later). If *all* workers were rejected by
 * at least one permanent filter, the work item should be suspended.
 */
export function classifyFilterFailures(
  filtered: Map<string, string[]>,
  filters: SchedulerFilter[],
): 'backoff' | 'suspend' {
  // Build a lookup: filter reason substring -> filter name
  // Since the filter reasons are human-readable strings, we match by checking
  // which filters produced the recorded reasons. But for simplicity, we check
  // whether any worker was rejected *only* by transient filters.
  //
  // Approach: for each filtered worker, check if all its failure reasons map
  // to transient filters. If so, this is a transient failure overall.

  // Build a mapping of filter name -> set of possible reason prefixes
  // We'll use a simpler approach: run through the filter names and check
  // if the failure reasons came from transient or permanent filters.
  const filterNameSet = new Set(filters.map(f => f.name))

  for (const [_workerId, reasons] of filtered) {
    // For each rejected worker, check if ALL its rejection reasons came
    // from transient filters.
    const allTransient = reasons.every(reason => {
      // Match the reason to a filter. We check if the reason was produced
      // by a transient filter. Since we control the filter implementations,
      // we use well-known reason patterns.
      return isTransientReason(reason)
    })

    if (allTransient && reasons.length > 0) {
      // At least one worker was rejected only by transient reasons.
      // The situation may improve, so backoff.
      return 'backoff'
    }
  }

  // All workers had at least one permanent rejection reason.
  return 'suspend'
}

/**
 * Determine if a filter failure reason is transient.
 *
 * Transient reasons come from CapacityFilter and QuotaFilter — situations
 * that can change without configuration changes.
 */
function isTransientReason(reason: string): boolean {
  // CapacityFilter reasons start with "worker at capacity"
  if (reason.startsWith('worker at capacity')) return true
  // QuotaFilter reasons start with "quota low"
  if (reason.startsWith('quota low')) return true
  // Everything else (status, project, provider) is considered permanent
  return false
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full filter -> score scheduling pipeline for a batch of work items.
 *
 * This is a pure, synchronous function. It does not perform any I/O.
 * The caller provides all inputs and acts on the returned ScheduleResult.
 *
 * @param request - Work items, workers, filters, scorers, and scoring context
 * @returns Assignments, unschedulable items, and audit decisions
 */
export function schedule(request: ScheduleRequest): ScheduleResult {
  const { workItems, workers, filters, scorers, context } = request

  const assignments: WorkAssignment[] = []
  const unschedulable: UnschedulableWork[] = []
  const decisions: SchedulingDecision[] = []

  // Track remaining capacity per worker across iterations.
  // Key: workerId, Value: remaining available capacity.
  const remainingCapacity = new Map<string, number>()
  for (const w of workers) {
    remainingCapacity.set(w.id, w.capacity - w.activeCount)
  }

  for (const work of workItems) {
    const itemStart = performance.now()

    // Build an effective worker list that reflects capacity consumed by
    // earlier assignments in this same scheduling pass.
    const effectiveWorkers = workers.map(w => {
      const remaining = remainingCapacity.get(w.id) ?? 0
      // Create a shallow copy with adjusted activeCount so that
      // CapacityFilter sees the up-to-date capacity.
      return {
        ...w,
        activeCount: w.capacity - remaining,
      } as WorkerInfo
    })

    // ---------------------------------------------------------------
    // Step 1: Filter
    // ---------------------------------------------------------------
    const filterStart = performance.now()
    const filterResult: FilterPipelineResult = runFilters(work, effectiveWorkers, filters)
    const filterDurationMs = performance.now() - filterStart

    // ---------------------------------------------------------------
    // Step 2: Handle no feasible workers
    // ---------------------------------------------------------------
    if (filterResult.feasible.length === 0) {
      const totalDurationMs = performance.now() - itemStart

      if (workers.length === 0) {
        // No workers at all
        decisions.push({
          workSessionId: work.sessionId,
          outcome: 'no_workers',
          totalWorkers: 0,
          feasibleWorkers: 0,
          filterDurationMs,
          scoreDurationMs: 0,
          totalDurationMs,
        })
      } else {
        const action = classifyFilterFailures(filterResult.filtered, filters)
        const outcome = action === 'backoff' ? 'backoff' : 'suspended'

        unschedulable.push({
          work,
          filterResults: filterResult.filtered,
          action,
        })

        decisions.push({
          workSessionId: work.sessionId,
          outcome,
          totalWorkers: workers.length,
          feasibleWorkers: 0,
          filterDurationMs,
          scoreDurationMs: 0,
          totalDurationMs,
        })
      }

      continue
    }

    // ---------------------------------------------------------------
    // Step 3: Score feasible workers
    // ---------------------------------------------------------------
    const scoreStart = performance.now()
    const scored = runScorers(work, filterResult.feasible, scorers, {
      ...context,
      // Pass effective workers so scorers see updated capacity
      allWorkers: effectiveWorkers,
    })
    const scoreDurationMs = performance.now() - scoreStart

    // ---------------------------------------------------------------
    // Step 4: Assign to highest-scoring worker
    // ---------------------------------------------------------------
    const best = scored[0] // runScorers returns descending by score

    assignments.push({
      work,
      worker: best.worker,
      score: best.totalScore,
      scores: best.scores,
    })

    // ---------------------------------------------------------------
    // Step 5: Decrement worker capacity for subsequent iterations
    // ---------------------------------------------------------------
    const currentRemaining = remainingCapacity.get(best.worker.id) ?? 0
    remainingCapacity.set(best.worker.id, currentRemaining - 1)

    // ---------------------------------------------------------------
    // Step 6: Record decision
    // ---------------------------------------------------------------
    const totalDurationMs = performance.now() - itemStart

    decisions.push({
      workSessionId: work.sessionId,
      outcome: 'assigned',
      assignedWorkerId: best.worker.id,
      assignedScore: best.totalScore,
      totalWorkers: workers.length,
      feasibleWorkers: filterResult.feasible.length,
      filterDurationMs,
      scoreDurationMs,
      totalDurationMs,
    })
  }

  return { assignments, unschedulable, decisions }
}
