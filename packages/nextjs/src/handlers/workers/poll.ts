/**
 * GET /api/workers/[id]/poll
 *
 * Poll for pending work items and inbox messages.
 * Reads from agent inbox streams (urgent-first) instead of pending-prompts Lists.
 */

import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireWorkerAuth } from '../../middleware/worker-auth.js'
import {
  getWorker,
  popAndClaimWorkWithReceipt,
  queueWork,
  claimSession,
  addWorkerSession,
  onSessionClaimed,
  getSessionState,
  readInbox,
  releaseClaim,
  type InboxMessage,
  type QueuedWork,
  maybeCleanupOrphans,
  createLogger,
  filterByQuota,
} from '@donmai/server'

const log = createLogger('api:workers:poll')

/** Return a popped item to the queue with its original priority/timestamp preserved. */
async function returnToQueue(item: QueuedWork): Promise<void> {
  await releaseClaim(item.sessionId)
  await queueWork(item)
}

interface RouteParams {
  params: Promise<{ id: string }>
}

export function createWorkerPollHandler() {
  return async function GET(request: NextRequest, { params }: RouteParams) {
    const authError = requireWorkerAuth(request)
    if (authError) return authError

    const { id: workerId } = await params

    try {
      maybeCleanupOrphans().catch((err) => {
        log.error('Background orphan cleanup failed', { error: err })
      })

      const worker = await getWorker(workerId)
      if (!worker) {
        return NextResponse.json(
          { error: 'Not Found', message: 'Worker not found' },
          { status: 404 }
        )
      }

      // Use activeSessions.length (authoritative Redis set) instead of
      // activeCount (heartbeat-reported, can be stale after re-registration)
      const availableCapacity = worker.capacity - worker.activeSessions.length
      let work: QueuedWork[] = []
      const claimedSessionIds: string[] = []

      // TODO(SUP-1292): When SCHEDULER_MODE=pipeline, use scheduler orchestrator here
      // For now, atomic pop-and-claim eliminates thundering herd races
      if (availableCapacity > 0) {
        const desiredCount = Math.min(availableCapacity, 5)
        const workerProjects = worker.projects
        const hasProjectFilter = workerProjects && workerProjects.length > 0

        // The global priority index selects candidates while each work item has
        // one hash-tagged durable claim authority and replayable receipt.
        const maxAttempts = hasProjectFilter ? desiredCount * 4 : desiredCount
        const popped: QueuedWork[] = []
        const returned: QueuedWork[] = []

        for (let i = 0; i < maxAttempts && popped.length < desiredCount; i++) {
          const claimResult = await popAndClaimWorkWithReceipt(workerId, randomUUID())
          if (claimResult.status === 'claim_refused_reconciled') {
            log.warn('Poll skipped work refused by durable reconciliation tombstone', {
              workerId,
              sessionId: claimResult.sessionId,
              reconciliationGeneration: claimResult.reconciliationGeneration,
            })
            continue
          }
          if (claimResult.status !== 'claimed') break // Queue is empty or unavailable

          const item = claimResult.work

          if (hasProjectFilter) {
            if (!item.projectName || !workerProjects!.includes(item.projectName)) {
              // Not for this worker — return to queue
              returned.push(item)
              continue
            }
          }

          popped.push(item)
        }

        // Return items that don't match this worker's project filter
        for (const item of returned) {
          await returnToQueue(item).catch((err) => {
            log.error('Failed to return popped item to queue', {
              sessionId: item.sessionId,
              error: err,
            })
          })
        }

        // QuotaFilter: exclude work from over-quota projects
        const quotaResult = await filterByQuota(popped)
        work = quotaResult.allowed
        if (quotaResult.rejected.length > 0) {
          log.info('Quota filter rejected work items', {
            workerId,
            rejected: quotaResult.rejected.map(r => ({
              sessionId: r.work.sessionId,
              project: r.work.projectName,
              reason: r.reason,
            })),
          })
          // Return quota-rejected items to queue
          for (const r of quotaResult.rejected) {
            await returnToQueue(r.work).catch((err) => {
              log.error('Failed to return quota-rejected item to queue', {
                sessionId: r.work.sessionId,
                error: err,
              })
            })
          }
        }

        // Complete the claim process for accepted items (update session state,
        // add to worker's active sessions, track quota)
        for (const item of work) {
          try {
            const claimed = await claimSession(item.sessionId, workerId)
            if (!claimed) {
              const session = await getSessionState(item.sessionId)
              if (!session || session.status !== 'pending') {
                log.warn('Session not claimable, dropping', {
                  sessionId: item.sessionId,
                  status: session?.status ?? 'expired',
                })
                await releaseClaim(item.sessionId)
                continue
              }
              // Transient failure — return to queue
              await returnToQueue(item)
              continue
            }

            await addWorkerSession(workerId, item.sessionId)
            claimedSessionIds.push(item.sessionId)

            onSessionClaimed(item.projectName, item.sessionId).catch((err) => {
              log.error('Fleet quota onSessionClaimed failed', {
                sessionId: item.sessionId,
                error: err,
              })
            })
          } catch (err) {
            log.error('Failed to complete claim for popped item', {
              sessionId: item.sessionId,
              error: err,
            })
            await returnToQueue(item).catch(() => {})
          }
        }

        // Filter to only items that were fully claimed
        work = work.filter(w => claimedSessionIds.includes(w.sessionId))
      }

      // Read inbox messages for active sessions (urgent-first via streams)
      const inboxMessages: Record<string, InboxMessage[]> = {}
      let totalInboxMessages = 0

      if (worker.activeSessions.length > 0) {
        await Promise.all(
          worker.activeSessions.map(async (sessionId) => {
            try {
              const session = await getSessionState(sessionId)
              const agentId = session?.agentId
              if (!agentId) return

              const messages = await readInbox(agentId, workerId)
              if (messages.length > 0) {
                inboxMessages[sessionId] = messages
                totalInboxMessages += messages.length
              }
            } catch (err) {
              log.warn('Failed to read inbox for session', {
                sessionId,
                error: err,
              })
            }
          })
        )
      }

      if (work.length > 0 || totalInboxMessages > 0) {
        log.info('Poll result with items', {
          workerId,
          availableCapacity,
          workCount: work.length,
          workItems: work.map((w) => ({
            sessionId: w.sessionId,
            issueIdentifier: w.issueIdentifier,
            workType: w.workType,
            projectName: w.projectName,
          })),
          activeSessionCount: worker.activeSessions.length,
          inboxMessageCount: totalInboxMessages,
          inboxMessagesBySession: Object.entries(inboxMessages).map(
            ([sessionId, messages]) => ({
              sessionId,
              count: messages.length,
              messageIds: messages.map((m) => m.id),
              types: messages.map((m) => m.type),
            })
          ),
        })
      } else {
        log.debug('Poll result (empty)', {
          workerId,
          availableCapacity,
          activeSessionCount: worker.activeSessions.length,
        })
      }

      return NextResponse.json({
        work,
        inboxMessages,
        hasInboxMessages: totalInboxMessages > 0,
        // Signal to workers that items are pre-claimed — skip separate claim request
        preClaimed: claimedSessionIds.length > 0,
        claimedSessionIds,
      })
    } catch (error) {
      log.error('Failed to poll for work', { error, workerId })
      return NextResponse.json(
        { error: 'Internal Server Error', message: 'Failed to poll for work' },
        { status: 500 }
      )
    }
  }
}
