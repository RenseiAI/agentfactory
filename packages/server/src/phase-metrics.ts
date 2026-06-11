/**
 * Phase Metrics Aggregation Service
 *
 * Aggregates phase-level metrics (cycle time, cost, attempt counts,
 * rework rate, escalation strategy distribution) across all workflow
 * states in Redis. Supports time-range filtering (7d, 30d, 90d).
 *
 */

import { redisKeys, redisGet, isRedisConfigured } from './redis.js'
import type { WorkflowState, WorkflowPhase, EscalationStrategy, PhaseRecord } from './agent-tracking.js'

const WORKFLOW_STATE_PREFIX = 'workflow:state:'

export type TimeRange = '7d' | '30d' | '90d'

export interface PhaseMetrics {
  avgCycleTimeMs: number
  avgCostUsd: number
  avgAttempts: number
  totalRecords: number
}

export interface PhaseMetricsResult {
  timeRange: TimeRange
  phases: Record<WorkflowPhase, PhaseMetrics>
  reworkRate: number
  escalationDistribution: Record<EscalationStrategy, number>
  issueCount: number
}

const TIME_RANGE_MS: Record<TimeRange, number> = {
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
}

const ALL_PHASES: WorkflowPhase[] = ['development', 'qa', 'refinement', 'acceptance']
const ALL_STRATEGIES: EscalationStrategy[] = ['normal', 'context-enriched', 'decompose', 'escalate-human']

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/**
 * Fetch all WorkflowState records from Redis, optionally filtered by time range.
 */
export async function getAllWorkflowStates(timeRange?: TimeRange): Promise<WorkflowState[]> {
  if (!isRedisConfigured()) {
    return []
  }

  const keys = await redisKeys(`${WORKFLOW_STATE_PREFIX}*`)
  const states: WorkflowState[] = []

  const cutoff = timeRange ? Date.now() - TIME_RANGE_MS[timeRange] : 0

  for (const key of keys) {
    const state = await redisGet<WorkflowState>(key)
    if (state && state.createdAt >= cutoff) {
      states.push(state)
    }
  }

  return states
}

/**
 * Compute per-phase metrics from a set of workflow states.
 */
function computePhaseMetrics(states: WorkflowState[]): Record<WorkflowPhase, PhaseMetrics> {
  const result = {} as Record<WorkflowPhase, PhaseMetrics>

  for (const phase of ALL_PHASES) {
    const allRecords: PhaseRecord[] = states.flatMap(s => s.phases[phase])
    const totalRecords = allRecords.length

    if (totalRecords === 0) {
      result[phase] = { avgCycleTimeMs: 0, avgCostUsd: 0, avgAttempts: 0, totalRecords: 0 }
      continue
    }

    // Average cycle time: mean of (completedAt - startedAt) for records that have both
    const completedRecords = allRecords.filter(r => r.completedAt != null)
    const avgCycleTimeMs = completedRecords.length > 0
      ? round4(completedRecords.reduce((sum, r) => sum + (r.completedAt! - r.startedAt), 0) / completedRecords.length)
      : 0

    // Average cost
    const avgCostUsd = round4(
      allRecords.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) / totalRecords
    )

    // Average attempts per issue per phase
    const issuesWithPhase = states.filter(s => s.phases[phase].length > 0).length
    const avgAttempts = issuesWithPhase > 0
      ? round4(totalRecords / issuesWithPhase)
      : 0

    result[phase] = { avgCycleTimeMs, avgCostUsd, avgAttempts, totalRecords }
  }

  return result
}

/**
 * Compute rework rate: ratio of QA failures to total QA records.
 */
function computeReworkRate(states: WorkflowState[]): number {
  const allQaRecords = states.flatMap(s => s.phases.qa)
  if (allQaRecords.length === 0) return 0

  const failures = allQaRecords.filter(r => r.result === 'failed').length
  return round4(failures / allQaRecords.length)
}

/**
 * Compute escalation strategy distribution across workflow states.
 */
function computeEscalationDistribution(states: WorkflowState[]): Record<EscalationStrategy, number> {
  const dist = {} as Record<EscalationStrategy, number>
  for (const strategy of ALL_STRATEGIES) {
    dist[strategy] = 0
  }

  for (const state of states) {
    dist[state.strategy] = (dist[state.strategy] ?? 0) + 1
  }

  return dist
}

/**
 * Aggregate phase-level metrics across all issues in a workspace.
 *
 * @param timeRange - Time window to filter by (7d, 30d, 90d). Defaults to 30d.
 */
export async function aggregatePhaseMetrics(
  timeRange: TimeRange = '30d'
): Promise<PhaseMetricsResult> {
  const states = await getAllWorkflowStates(timeRange)

  return {
    timeRange,
    phases: computePhaseMetrics(states),
    reworkRate: computeReworkRate(states),
    escalationDistribution: computeEscalationDistribution(states),
    issueCount: states.length,
  }
}
