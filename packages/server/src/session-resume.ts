/**
 * Session Resume (Decision 4)
 *
 * Reads journal entries for a session and computes the
 * "resume marker" — the latest checkpointed step.  Workers consult
 * this on start-up: any step whose journal entry already shows
 * `completed` is skipped on replay; the next step that should run is
 * whichever the workflow's step graph identifies as immediately after
 * the checkpoint.
 *
 * Architecture references:
 *   - donmai-architecture/ADR-2026-04-29-long-running-runtime-substrate.md
 *     (commit 56f2bc6) — Decision 4 (Resume).
 *   - `listSessionJournal(sessionId)` is the consumed API.
 *
 * Design contract:
 *   - The resume marker is purely the journal-derived view; the
 *     workflow engine is responsible for translating "after step X"
 *     into the next concrete step id.  This module exposes the journal
 *     observation only — it does NOT walk the workflow graph.
 *   - `running` entries are treated as in-flight: the worker that
 *     restarts will either (a) re-claim the session and continue, or
 *     (b) the session FSM's reassignment path (existing) re-routes it.
 *     We DO surface `running` steps in the resume payload so callers
 *     can decide.
 */

import {
  listSessionJournal,
  type JournalEntry,
} from './journal.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[session-resume] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[session-resume] ${msg}`, data ? JSON.stringify(data) : ''),
}

// ---------------------------------------------------------------------------
// Resume marker
// ---------------------------------------------------------------------------

/**
 * The shape returned by `resumeSessionFromJournal`.  Captures the
 * worker's view of where the session stood at the moment the journal
 * was last written.
 */
export interface ResumeMarker {
  sessionId: string
  /**
   * The most-recent step whose journal entry transitioned to
   * `completed`.  `undefined` if the session has no completed steps
   * yet (fresh session — replay starts from the beginning).
   */
  lastCompletedStepId?: string
  /** `completedAt` of the last completed step, if any. */
  lastCompletedAt?: number
  /**
   * Steps currently in `running` state on disk.  These are candidates
   * for retry: the worker that started the step crashed before
   * journal-completion.  The runner SHOULD treat these as fresh runs
   * (re-execute) UNLESS the step was marked idempotent.
   */
  inflightStepIds: string[]
  /** Steps that hit `failed` and have not yet been replayed. */
  failedStepIds: string[]
  /** Total journal entries observed (for diagnostics + tests). */
  totalEntries: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the journal for a session and produce a resume marker.  Workers
 * call this on start-up before deciding whether to re-execute or skip
 * the workflow's next step.
 *
 * Returns a marker even for sessions with no journal entries — callers
 * can detect "fresh session" via `marker.totalEntries === 0`.
 */
export async function resumeSessionFromJournal(
  sessionId: string,
): Promise<ResumeMarker> {
  const entries = await listSessionJournal(sessionId)
  const marker = computeResumeMarker(sessionId, entries)
  log.info('Resume marker computed', {
    sessionId,
    lastCompletedStepId: marker.lastCompletedStepId,
    inflightCount: marker.inflightStepIds.length,
    failedCount: marker.failedStepIds.length,
    totalEntries: marker.totalEntries,
  })
  return marker
}

/**
 * Pure helper that produces a `ResumeMarker` from a list of journal
 * entries.  Exported for tests (which can supply synthesized entries
 * without touching Redis).  The list does not need to be pre-sorted —
 * we sort by `completedAt` here.
 */
export function computeResumeMarker(
  sessionId: string,
  entries: JournalEntry[],
): ResumeMarker {
  const inflightStepIds: string[] = []
  const failedStepIds: string[] = []
  let lastCompletedAt = 0
  let lastCompletedStepId: string | undefined

  for (const entry of entries) {
    switch (entry.status) {
      case 'completed': {
        // Pick the entry with the largest completedAt; tie-break on
        // startedAt for determinism.
        if (
          entry.completedAt > lastCompletedAt ||
          (entry.completedAt === lastCompletedAt &&
            (lastCompletedStepId === undefined ||
              entry.stepId > lastCompletedStepId))
        ) {
          lastCompletedAt = entry.completedAt
          lastCompletedStepId = entry.stepId
        }
        break
      }
      case 'running':
        inflightStepIds.push(entry.stepId)
        break
      case 'failed':
        failedStepIds.push(entry.stepId)
        break
      case 'pending':
        // Pending entries don't influence the resume marker — the
        // worker that picks the session up writes `running` before
        // executing.
        break
    }
  }

  // Stable orderings for callers that compare markers across runs.
  inflightStepIds.sort()
  failedStepIds.sort()

  const marker: ResumeMarker = {
    sessionId,
    inflightStepIds,
    failedStepIds,
    totalEntries: entries.length,
  }
  if (lastCompletedStepId !== undefined) {
    marker.lastCompletedStepId = lastCompletedStepId
    marker.lastCompletedAt = lastCompletedAt
  }
  return marker
}

/**
 * Filter a list of upcoming step ids against a resume marker.  Returns
 * the steps that have NOT been completed yet (i.e. the steps the
 * worker should actually execute).  Useful when the workflow engine
 * has the step list and wants to skip the journal-completed prefix.
 *
 * Order of `nextSteps` is preserved.
 */
export function filterUnfinishedSteps(
  marker: ResumeMarker,
  nextSteps: string[],
): string[] {
  if (nextSteps.length === 0) return []
  // Build a Set of completed step ids from the journal.  We only have
  // the LAST completed step in the marker, so we can't dedupe on that
  // alone — but the typical workflow contract is "steps execute in a
  // total order recorded in the journal", so the last completed step
  // implies all earlier steps are done.  Callers with non-linear
  // workflows should walk `listSessionJournal` directly.
  if (marker.lastCompletedStepId === undefined) return [...nextSteps]
  const idx = nextSteps.indexOf(marker.lastCompletedStepId)
  if (idx === -1) return [...nextSteps]
  return nextSteps.slice(idx + 1)
}
