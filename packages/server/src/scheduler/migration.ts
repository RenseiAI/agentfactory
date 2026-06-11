/**
 * Scheduler Migration — Backward-Compatible Feature Flag & Queue Maintenance
 *
 * Provides a three-phase migration path from the legacy inline dispatch to
 * the K8s-inspired filter/score scheduling pipeline:
 *
 *   1. legacy   — Existing behaviour; scheduling queue maintenance is skipped.
 *   2. shadow   — Both paths run; results are compared but legacy wins.
 *   3. pipeline — New scheduler is authoritative.
 *
 * Controlled via the SCHEDULER_MODE environment variable.
 *
 */

import { createLogger } from '../logger.js'
import {
  promoteFromBackoff,
  reevaluateSuspended,
  getQueueStats,
} from '../scheduling-queue.js'
import type { QueueStats } from '../scheduling-queue.js'

const logger = createLogger('scheduler-migration')

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

export type SchedulerMode = 'legacy' | 'shadow' | 'pipeline'

/**
 * Read the current scheduler mode from the environment.
 *
 * Defaults to 'legacy' when the env var is absent or contains an
 * unrecognised value.
 */
export function getSchedulerMode(): SchedulerMode {
  const mode = process.env.SCHEDULER_MODE || 'legacy'
  if (mode === 'legacy' || mode === 'shadow' || mode === 'pipeline') return mode
  return 'legacy'
}

// ---------------------------------------------------------------------------
// Queue maintenance
// ---------------------------------------------------------------------------

export interface QueueMaintenanceResult {
  promoted: number
  reevaluated: number
  stats: QueueStats | null
  skipped: boolean
}

/**
 * Run periodic queue maintenance tasks.
 *
 * Called from the patrol loop on every patrol pass. In legacy mode the
 * function exits immediately so existing behaviour is unchanged.
 *
 * In shadow/pipeline modes it:
 *   1. Promotes eligible backoff items to the active queue.
 *   2. Re-evaluates suspended items for feasibility changes.
 *   3. Fetches queue health stats for observability.
 */
export async function runQueueMaintenance(): Promise<QueueMaintenanceResult> {
  const mode = getSchedulerMode()
  if (mode === 'legacy') {
    return { promoted: 0, reevaluated: 0, stats: null, skipped: true }
  }

  // 1. Promote eligible backoff items to active queue
  const promoted = await promoteFromBackoff()

  // 2. Re-evaluate suspended items
  const suspended = await reevaluateSuspended()

  // 3. Get queue health stats
  const stats = await getQueueStats()

  logger.info('queue_maintenance', {
    promoted,
    reevaluated: suspended.length,
    stats,
  })

  return { promoted, reevaluated: suspended.length, stats, skipped: false }
}

// ---------------------------------------------------------------------------
// Shadow-mode comparison
// ---------------------------------------------------------------------------

export interface SchedulerComparison {
  legacyWorkIds: string[]
  pipelineWorkIds: string[]
  match: boolean
}

/**
 * Compare the results of the legacy and pipeline schedulers.
 *
 * Used during shadow mode to validate that the new pipeline produces
 * equivalent assignments before switching to pipeline mode.
 */
export function compareSchedulerResults(
  legacyWorkIds: string[],
  pipelineWorkIds: string[],
): SchedulerComparison {
  const match =
    legacyWorkIds.length === pipelineWorkIds.length &&
    legacyWorkIds.every((id, i) => id === pipelineWorkIds[i])

  if (!match) {
    logger.warn('scheduler_shadow_mismatch', { legacyWorkIds, pipelineWorkIds })
  }

  return { legacyWorkIds, pipelineWorkIds, match }
}
