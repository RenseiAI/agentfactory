/**
 * Event processor — agent event stream loop and per-event handler
 *
 * Extracted from orchestrator.ts (phase-2 decomposition).
 * The functions here run with `this` bound to the AgentOrchestrator instance,
 * so they have full access to orchestrator state via `this.X` references.
 *
 * Wrappers on AgentOrchestrator delegate via `.call(this, ...)`.
 */

import { execSync } from 'child_process'
import { unlinkSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type { AgentEvent, AgentHandle } from '../providers/index.js'
import type { ActivityEmitter } from './activity-emitter.js'
import type { ApiActivityEmitter } from './api-activity-emitter.js'
import type { AgentOrchestrator } from './orchestrator.js'
import type { AgentProcess } from './types.js'
import type { TodoItem, TodosState } from './state-types.js'
import {
  extractShellCommand,
  isGrepGlobShellCommand,
  isToolRelatedError,
  extractToolNameFromError,
  shouldDeferAcceptanceTransition,
} from './dispatcher.js'
import { parseSecurityScanOutput } from './security-scan-event.js'
import { parseWorkResult } from './parse-work-result.js'
import { runBackstop, formatBackstopComment, type SessionContext } from './session-backstop.js'
import { updateState, writeTodos } from './state-recovery.js'
import { flushSessionObservations } from './context-injection.js'
import { shouldFlushObservations } from './session-supervisor.js'
import { checkForIncompleteWork } from '../workarea/git-worktree.js'
import {
  captureQualityBaseline,
  computeQualityDelta,
  formatQualityReport,
  loadBaseline,
} from './quality-baseline.js'

/**
 * Defaults that mirror DEFAULT_CONFIG in orchestrator.ts.
 * Defensive: orchestrator always sets these via the constructor's DEFAULT_CONFIG merge.
 */
const DEFAULT_CONFIG = {
  worktreePath: '../{repoName}.wt',
  preserveWorkOnPrFailure: true,
}

/**
 * Process the provider event stream and emit activities
 */
export async function processEventStream(
  this: AgentOrchestrator,
  issueId: string,
  identifier: string,
  sessionId: string | undefined,
  handle: AgentHandle,
  emitter: ActivityEmitter | ApiActivityEmitter | null,
  agent: AgentProcess
): Promise<void> {
  const log = this.agentLoggers.get(issueId)

  // Accumulate all assistant text for WORK_RESULT marker fallback scanning.
  // The provider's result message only contains the final turn's text, but
  // the agent may have emitted the marker in an earlier turn.
  const assistantTextChunks: string[] = []

  // Code intelligence adoption telemetry
  let codeIntelToolCalls = 0
  let grepGlobToolCalls = 0

  try {
    for await (const event of handle.stream) {
      if (event.type === 'assistant_text') {
        assistantTextChunks.push(event.text)
      }
      // Also capture tool call inputs that may contain WORK_RESULT markers.
      // Agents sometimes embed the marker inside a create-comment body rather
      // than in their direct text output.
      if (event.type === 'tool_use' && event.input) {
        const inputStr = typeof event.input === 'string' ? event.input : JSON.stringify(event.input)
        if (inputStr.includes('WORK_RESULT')) {
          assistantTextChunks.push(inputStr)
        }
      }
      // Track code intelligence vs legacy search tool usage.
      // Two shapes: Claude native tools ("Grep" / "Glob") and provider shell
      // commands (Codex "shell" with input.command containing rg/grep/find/sed).
      // Without the shell-command classification, Codex sessions always
      // reported grepGlobCalls=0 even when the agent grepped heavily.
      if (event.type === 'tool_use') {
        if (event.toolName.includes('af_code_')) codeIntelToolCalls++
        if (event.toolName === 'Grep' || event.toolName === 'Glob') {
          grepGlobToolCalls++
        } else if (event.toolName === 'shell' && event.input) {
          const cmd = extractShellCommand(event.input)
          if (cmd && isGrepGlobShellCommand(cmd)) {
            grepGlobToolCalls++
          }
        }
      }
      await this.handleAgentEvent(issueId, sessionId, event, emitter, agent, handle)
    }

    // Query completed successfully — preserve 'failed' or 'stopped' status.
    // If the orchestrator is shutting down (fleet kill), force 'stopped' to prevent
    // the backstop from promoting incomplete work.
    if (this.shuttingDown && agent.status !== 'failed') {
      agent.status = 'stopped'
      log?.info('Agent stopped by fleet shutdown — skipping backstop and auto-transition')
    } else if (agent.status !== 'stopped' && agent.status !== 'failed') {
      agent.status = 'completed'
    }
    agent.completedAt = new Date()

    // Log code intelligence adoption telemetry
    if (this.toolRegistry.getPlugins().some(p => p.name === 'af-code-intelligence')) {
      const total = codeIntelToolCalls + grepGlobToolCalls
      log?.info('Code intelligence adoption', {
        codeIntelCalls: codeIntelToolCalls,
        grepGlobCalls: grepGlobToolCalls,
        ratio: total > 0 ? (codeIntelToolCalls / total).toFixed(2) : 'N/A',
      })
    }

    // Update state file to completed (only for worktree-based agents)
    if (agent.worktreePath) {
      try {
        updateState(agent.worktreePath, {
          status: agent.status === 'stopped' ? 'stopped' : agent.status === 'failed' ? 'failed' : 'completed',
          pullRequestUrl: agent.pullRequestUrl ?? undefined,
        })
      } catch {
        // Ignore state update errors
      }
    }

    // Emit structured security scan events for security work type agents
    if (emitter && agent.status === 'completed' && agent.workType === 'security') {
      const fullOutput = assistantTextChunks.join('\n')
      const scanEvents = parseSecurityScanOutput(fullOutput)
      for (const scanEvent of scanEvents) {
        try {
          await emitter.emitSecurityScan(scanEvent)
          log?.info('Security scan event emitted', {
            scanner: scanEvent.scanner,
            findings: scanEvent.totalFindings,
          })
        } catch (scanError) {
          log?.warn('Failed to emit security scan event', {
            error: scanError instanceof Error ? scanError.message : String(scanError),
          })
        }
      }
    }

    // Emit a final response activity to close the Linear agent session.
    // Linear auto-transitions sessions to "complete" when a response activity is emitted.
    if (emitter && (agent.status === 'completed' || agent.status === 'failed')) {
      try {
        if (agent.status === 'completed') {
          const summary = agent.resultMessage
            ? agent.resultMessage.substring(0, 500)
            : 'Work completed successfully.'
          await emitter.emitResponse(summary)
        } else {
          await emitter.emitResponse(
            agent.resultMessage || 'Agent encountered an error during execution.'
          )
        }
      } catch (emitError) {
        log?.warn('Failed to emit completion response activity', {
          error: emitError instanceof Error ? emitError.message : String(emitError),
        })
      }
    }

    // Flush remaining activities
    if (emitter) {
      await emitter.flush()
    }

    // Post-exit PR detection: if the agent exited without a detected PR URL,
    // check GitHub directly in case the PR was created but the output wasn't captured
    if (agent.status === 'completed' && !agent.pullRequestUrl && agent.worktreePath) {
      const postExitWorkType = agent.workType ?? 'development'
      const isPostExitCodeProducing = postExitWorkType === 'development' || postExitWorkType === 'inflight'
      if (isPostExitCodeProducing) {
        try {
          const currentBranch = execSync('git branch --show-current', {
            cwd: agent.worktreePath,
            encoding: 'utf-8',
            timeout: 10000,
          }).trim()

          if (currentBranch && currentBranch !== 'main' && currentBranch !== 'master') {
            const prJson = execSync(`gh pr list --head "${currentBranch}" --json url --limit 1`, {
              cwd: agent.worktreePath,
              encoding: 'utf-8',
              timeout: 15000,
            }).trim()

            const prs = JSON.parse(prJson) as Array<{ url: string }>
            if (prs.length > 0 && prs[0].url) {
              log?.info('Post-exit PR detection found existing PR', { prUrl: prs[0].url, branch: currentBranch })
              agent.pullRequestUrl = prs[0].url
              if (sessionId) {
                await this.updateSessionPullRequest(sessionId, prs[0].url, agent)
              }
            }
          }
        } catch (error) {
          log?.debug('Post-exit PR detection failed (non-fatal)', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    // --- Session Steering: For providers that support resume, give the
    // agent a second chance to finish commit/push/PR itself before the
    // deterministic backstop takes over with a blind auto-commit.
    if (agent.status === 'completed' && agent.worktreePath) {
      await this.attemptSessionSteering(agent, log).catch((error) => {
        log?.warn('Session steering threw — falling through to backstop', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }

    // --- Session Backstop: Validate completion contract and recover missing outputs ---
    if (agent.status === 'completed') {
      const outputFlags = this.sessionOutputFlags.get(issueId)
      const backstopCtx: SessionContext = {
        agent,
        commentPosted: outputFlags?.commentPosted ?? false,
        issueUpdated: outputFlags?.issueUpdated ?? false,
        subIssuesCreated: outputFlags?.subIssuesCreated ?? false,
      }
      const backstopResult = runBackstop(backstopCtx)

      if (backstopResult.backstop.actions.length > 0) {
        log?.info('Session backstop ran', {
          actions: backstopResult.backstop.actions.map(a => `${a.field}:${a.success ? 'ok' : 'fail'}`),
          fullyRecovered: backstopResult.backstop.fullyRecovered,
          remainingGaps: backstopResult.backstop.remainingGaps,
        })

        // Post backstop diagnostic comment if there were actions taken or gaps remaining
        const backstopComment = formatBackstopComment(backstopResult)
        if (backstopComment) {
          try {
            await this.client.createComment(issueId, backstopComment)
          } catch {
            // Best-effort diagnostic comment
          }
        }
      }

      // If backstop recovered the PR URL, update the session
      if (agent.pullRequestUrl && sessionId) {
        try {
          await this.updateSessionPullRequest(sessionId, agent.pullRequestUrl, agent)
        } catch {
          // Best-effort session update
        }
      }
    }

    // --- Quality Gate: Check quality delta for code-producing work types ---
    if (agent.status === 'completed' && agent.worktreePath && this.isQualityBaselineEnabled()) {
      const codeProducingTypes = ['development', 'inflight']
      const agentWorkType = agent.workType ?? 'development'
      if (codeProducingTypes.includes(agentWorkType)) {
        try {
          const baseline = loadBaseline(agent.worktreePath)
          if (baseline) {
            const qualityConfig = this.buildQualityConfig()
            const current = captureQualityBaseline(agent.worktreePath, qualityConfig)
            const delta = computeQualityDelta(baseline, current)

            if (!delta.passed) {
              const report = formatQualityReport(baseline, current, delta)
              log?.warn('Quality gate FAILED — agent worsened quality metrics', {
                testFailuresDelta: delta.testFailuresDelta,
                typeErrorsDelta: delta.typeErrorsDelta,
                lintErrorsDelta: delta.lintErrorsDelta,
              })

              // Post quality gate failure comment
              try {
                await this.client.createComment(
                  issueId,
                  `## Quality Gate Failed\n\n` +
                  `The agent's changes worsened quality metrics compared to the baseline (main).\n\n` +
                  report +
                  `\n\n**Status promotion blocked.** The agent must fix quality regressions before this work can advance to QA.`
                )
              } catch {
                // Best-effort comment
              }

              // Block status promotion by marking agent as failed
              agent.status = 'failed'
              agent.workResult = 'failed'
            } else {
              log?.info('Quality gate passed', {
                testFailuresDelta: delta.testFailuresDelta,
                typeErrorsDelta: delta.typeErrorsDelta,
                testCountDelta: delta.testCountDelta,
              })

              if (delta.testFailuresDelta < 0 || delta.typeErrorsDelta < 0 || delta.lintErrorsDelta < 0) {
                log?.info('Boy scout rule: agent improved quality metrics', {
                  testFailuresDelta: delta.testFailuresDelta,
                  typeErrorsDelta: delta.typeErrorsDelta,
                  lintErrorsDelta: delta.lintErrorsDelta,
                })
              }
            }
          }
        } catch (qualityError) {
          log?.warn('Quality gate check failed (non-fatal)', {
            error: qualityError instanceof Error ? qualityError.message : String(qualityError),
          })
          // Quality gate check failure should not block the session — degrade gracefully
        }
      }
    }

    // Update Linear status based on work type if auto-transition is enabled
    if ((agent.status === 'completed' || agent.status === 'failed') && this.config.autoTransition) {
      const workType = agent.workType ?? 'development'
      const isResultSensitive = workType === 'qa' || workType === 'acceptance' || workType === 'development' || workType === 'inflight' || workType === 'merge'

      let targetStatus: string | null = null

      if (isResultSensitive) {
        if (agent.status === 'failed') {
          // Agent crashed/errored — treat as QA/acceptance failure
          agent.workResult = 'failed'
          targetStatus = this.statusMappings.workTypeFailStatus[workType]
          log?.info('Agent failed (crash/error), transitioning to fail status', { workType, targetStatus })
        } else {
          // For QA/acceptance: parse result to decide promote vs reject.
          // Try the final result message first, then fall back to scanning
          // all accumulated assistant text (the marker may be in an earlier turn).
          let workResult = parseWorkResult(agent.resultMessage, workType)
          if (workResult === 'unknown' && assistantTextChunks.length > 0) {
            const fullText = assistantTextChunks.join('\n')
            workResult = parseWorkResult(fullText, workType)
            if (workResult !== 'unknown') {
              log?.info('Work result found in accumulated text (not in final message)', { workResult })
            }
          }
          agent.workResult = workResult

          if (workResult === 'passed') {
            // when the local merge queue is enabled,
            // a passing acceptance only signals "the code is ready to
            // ship". The actual transition to Accepted is driven by the
            // merge worker once the PR lands on main — that's what makes
            // Accepted mean "live in production" rather than "the agent
            // says we're done." On merge failure (conflict / test-fail /
            // error) the worker demotes to Rejected and refinement picks
            // it up. The orchestrator's only job here is to enqueue, which
            // happens unconditionally a few lines below.
            const deferredToMergeQueue = shouldDeferAcceptanceTransition(workType, !!this.mergeQueueAdapter)
            if (deferredToMergeQueue) {
              log?.info('Acceptance passed — deferring status transition to merge worker', {
                workType,
                rationale: 'mergeQueueEnabled',
              })
            } else {
              targetStatus = this.statusMappings.workTypeCompleteStatus[workType]
              log?.info('Work result: passed, promoting', { workType, targetStatus })
            }
          } else if (workResult === 'failed') {
            targetStatus = this.statusMappings.workTypeFailStatus[workType]
            log?.info('Work result: failed, transitioning to fail status', { workType, targetStatus })
          } else {
            // unknown — safe default: don't transition
            log?.warn('Work result: unknown, skipping auto-transition', {
              workType,
              hasResultMessage: !!agent.resultMessage,
            })

            // Post a diagnostic comment so the issue doesn't silently stall
            try {
              await this.client.createComment(
                issueId,
                `⚠️ Agent completed but no structured result marker was detected in the output.\n\n` +
                `**Issue status was NOT updated automatically.**\n\n` +
                `The orchestrator expected one of:\n` +
                `- \`<!-- WORK_RESULT:passed -->\` to promote the issue\n` +
                `- \`<!-- WORK_RESULT:failed -->\` to record a failure\n\n` +
                `This usually means the agent exited early (timeout, error, or missing logic). ` +
                `Check the agent logs for details, then manually update the issue status or re-trigger the agent.`
              )
              log?.info('Posted diagnostic comment for unknown work result')
            } catch (error) {
              log?.warn('Failed to post diagnostic comment for unknown work result', {
                error: error instanceof Error ? error.message : String(error),
              })
            }
          }
        }
      } else if (agent.status === 'completed') {
        // Non-result-sensitive work types (research, backlog-creation, refinement, etc.):
        // promote on completion
        targetStatus = this.statusMappings.workTypeCompleteStatus[workType]
      }

      if (targetStatus) {
        try {
          await this.client.updateIssueStatus(issueId, targetStatus)
          log?.info('Issue status updated', { from: workType, to: targetStatus })
        } catch (error) {
          log?.error('Failed to update status', {
            targetStatus,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } else if (!isResultSensitive) {
        log?.info('No auto-transition configured for work type', { workType })
      }

      // Merge queue: enqueue PR after successful merge work, or after a
      // passing acceptance when the local merge queue is configured. This
      // is the primary handoff path — acceptance validates the
      // code, orchestrator hands the PR off to the queue, worker serializes
      // the actual merge against the latest main. Without this wire, the
      // queue feature is decorative (the trigger-merge dispatch that used
      // to populate it was removed in v0.8.20 as a QA-bypass fix).
      const isMergeWork = workType === 'merge'
      const isAcceptancePass =
        workType === 'acceptance' &&
        agent.workResult === 'passed'
      const shouldEnqueue =
        (isMergeWork || isAcceptancePass) &&
        this.mergeQueueAdapter &&
        agent.pullRequestUrl
      if (shouldEnqueue) {
        try {
          const prMatch = agent.pullRequestUrl!.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
          if (prMatch) {
            const [, owner, repo, prNum] = prMatch
            const canEnqueue = await this.mergeQueueAdapter!.canEnqueue(owner, repo, parseInt(prNum, 10))
            if (canEnqueue) {
              const status = await this.mergeQueueAdapter!.enqueue(owner, repo, parseInt(prNum, 10))
              log?.info('PR enqueued in merge queue', {
                owner, repo, prNumber: prNum, state: status.state,
                trigger: isMergeWork ? 'merge_work' : 'acceptance_pass',
              })
              // Feeds the acceptance completion contract's
              // pr_merged_or_enqueued check so the backstop treats this
              // as a successful handoff, not a missed merge.
              agent.prEnqueuedForMerge = true
            } else {
              log?.info('PR not eligible for merge queue', { owner, repo, prNumber: prNum })
            }
          }
        } catch (error) {
          log?.warn('Failed to enqueue PR in merge queue', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }

      // --- Session-end Architectural Intelligence flush ---
      // Flush new observations when the session completed successfully.
      // Best-effort — errors are swallowed inside flushSessionObservations.
      if (shouldFlushObservations(agent)) {
        await flushSessionObservations(
          {
            issueId,
            sessionId: sessionId ?? issueId,
            workType: workType ?? 'development',
            scope: { level: 'project', projectId: issueId },
            passed: agent.workResult === 'passed' || !['qa', 'acceptance'].includes(workType ?? ''),
          },
          this.contextInjectionConfig,
          log,
        )
      }

      // Unassign agent from issue for clean handoff visibility
      // This enables automated QA pickup via webhook
      // Skip unassignment for research work (user should decide when to move to backlog)
      if (workType !== 'research') {
        try {
          await this.client.unassignIssue(issueId)
          log?.info('Agent unassigned from issue')
        } catch (error) {
          log?.warn('Failed to unassign agent from issue', {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    // Post completion comment with full result (not truncated)
    // This uses multi-comment splitting for long messages
    if (agent.status === 'completed' && agent.resultMessage) {
      await this.postCompletionComment(issueId, sessionId, agent.resultMessage, log)
    }

    // Release file reservations held by this session.
    // Must happen before worktree cleanup so other agents can immediately use the files.
    // TTL provides fallback if this call fails.
    if (this.config.fileReservation && sessionId) {
      try {
        await this.config.fileReservation.releaseAllSessionFiles(sessionId)
      } catch {
        // Best-effort — TTL handles eventual release
      }
    }

    // Clean up worktree for completed agents
    // NOTE: This must happen AFTER the agent exits to avoid breaking its shell session
    // Agents should NEVER clean up their own worktree - this is the orchestrator's job
    if (agent.status === 'completed' && agent.worktreePath) {
      const shouldPreserve = this.config.preserveWorkOnPrFailure ?? DEFAULT_CONFIG.preserveWorkOnPrFailure
      let shouldCleanup = true

      // Only check for incomplete work on code-producing work types.
      // Non-code work types (research, backlog-creation, QA, refinement, etc.) use
      // worktrees for codebase exploration but don't produce commits/PRs. Checking
      // them triggers false "work not persisted" warnings from bootstrapped .agent/ files.
      const codeProducingWorkTypes = new Set(['development', 'inflight'])
      const agentWorkType = agent.workType ?? 'development'
      const isCodeProducingAgent = codeProducingWorkTypes.has(agentWorkType)

      // Validate that PR was created or work was fully pushed before cleanup
      if (shouldPreserve && isCodeProducingAgent) {
        if (!agent.pullRequestUrl) {
          // No PR detected - check for uncommitted/unpushed work
          const incompleteCheck = checkForIncompleteWork(agent.worktreePath)

          if (incompleteCheck.hasIncompleteWork) {
            // Mark as incomplete and preserve worktree
            agent.status = 'incomplete'
            agent.incompleteReason = incompleteCheck.reason
            shouldCleanup = false
            log?.warn('Work incomplete - preserving worktree', {
              reason: incompleteCheck.reason,
              details: incompleteCheck.details,
              worktreePath: agent.worktreePath,
            })

            // Delete the heartbeat file so the preserved worktree isn't falsely
            // detected as having a live agent (which would block branch reuse)
            try {
              const heartbeatPath = resolve(agent.worktreePath, '.agent', 'heartbeat.json')
              if (existsSync(heartbeatPath)) {
                unlinkSync(heartbeatPath)
              }
            } catch {
              // Best-effort - heartbeat will go stale naturally after timeout
            }

            // Write a .preserved marker so branch conflict resolution knows not to
            // destroy this worktree. The marker includes context for diagnostics.
            try {
              const agentDir = resolve(agent.worktreePath, '.agent')
              if (!existsSync(agentDir)) {
                mkdirSync(agentDir, { recursive: true })
              }
              writeFileSync(
                resolve(agentDir, 'preserved.json'),
                JSON.stringify({
                  preservedAt: new Date().toISOString(),
                  issueId,
                  reason: incompleteCheck.reason,
                  details: incompleteCheck.details,
                }, null, 2)
              )
            } catch {
              // Best-effort - the shouldCleanup=false flag is the primary guard
            }

            // Post diagnostic comment NOW that preservation is confirmed
            try {
              await this.client.createComment(
                issueId,
                `⚠️ **Agent completed but work was not persisted.**\n\n` +
                `The agent reported success but no PR was detected, and the worktree has ${incompleteCheck.details}.\n\n` +
                `**Issue status was NOT promoted** to prevent lost work from advancing through the pipeline.\n\n` +
                `The worktree has been preserved at \`${agent.worktreePath}\`. ` +
                `To recover: cd into the worktree, commit, push, and create a PR manually.`
              )
            } catch {
              // Best-effort comment
            }
          } else {
            // No PR but also no local changes - agent may not have made any changes
            log?.warn('No PR created but worktree is clean - proceeding with cleanup', {
              worktreePath: agent.worktreePath,
            })
          }
        }
      }

      if (shouldCleanup && agent.worktreeIdentifier) {
        try {
          // For non-code-producing work types, also delete the branch to prevent
          // stale branches from being accidentally reused by development agents.
          const shouldDeleteBranch = !isCodeProducingAgent
          this.removeWorktree(
            agent.worktreeIdentifier,
            shouldDeleteBranch ? (agent.identifier ?? undefined) : undefined
          )
          log?.info('Worktree cleaned up', { worktreePath: agent.worktreePath })
        } catch (error) {
          log?.warn('Failed to clean up worktree', {
            worktreePath: agent.worktreePath,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    // Finalize session logger before cleanup
    const finalStatus = agent.status === 'completed' ? 'completed' : (agent.status === 'stopped' ? 'stopped' : 'completed')
    this.finalizeSessionLogger(issueId, finalStatus, {
      pullRequestUrl: agent.pullRequestUrl,
    })

    // Clean up in-memory resources
    this.cleanupAgent(issueId, sessionId)

    if (agent.status === 'completed') {
      this.events.onAgentComplete?.(agent)
    } else if (agent.status === 'incomplete') {
      this.events.onAgentIncomplete?.(agent)
    } else if (agent.status === 'stopped') {
      this.events.onAgentStopped?.(agent)
    }
  } catch (error) {
    // Handle abort/cancellation
    if (error instanceof Error && error.name === 'AbortError') {
      agent.status = 'stopped'
      agent.completedAt = new Date()
      this.finalizeSessionLogger(issueId, 'stopped')
      this.cleanupAgent(issueId, sessionId)
      this.events.onAgentStopped?.(agent)
      return
    }

    // Handle other errors
    log?.error('Agent error', { error: error instanceof Error ? error.message : String(error) })
    agent.status = 'failed'
    agent.completedAt = new Date()
    agent.error = error instanceof Error ? error : new Error(String(error))

    // Flush remaining activities
    if (emitter) {
      await emitter.flush()
    }

    // Clean up worktree for failed agents (but preserve if there's work)
    if (agent.worktreePath) {
      const shouldPreserve = this.config.preserveWorkOnPrFailure ?? DEFAULT_CONFIG.preserveWorkOnPrFailure
      let shouldCleanup = true

      // Check for any uncommitted/unpushed work before cleaning up
      if (shouldPreserve) {
        const incompleteCheck = checkForIncompleteWork(agent.worktreePath)

        if (incompleteCheck.hasIncompleteWork) {
          // Preserve worktree - there's work that could be recovered
          shouldCleanup = false
          agent.incompleteReason = incompleteCheck.reason
          log?.warn('Agent failed but has uncommitted work - preserving worktree', {
            reason: incompleteCheck.reason,
            details: incompleteCheck.details,
            worktreePath: agent.worktreePath,
          })

          // Delete the heartbeat file so the preserved worktree isn't falsely
          // detected as having a live agent (which would block branch reuse)
          try {
            const heartbeatPath = resolve(agent.worktreePath, '.agent', 'heartbeat.json')
            if (existsSync(heartbeatPath)) {
              unlinkSync(heartbeatPath)
            }
          } catch {
            // Best-effort - heartbeat will go stale naturally after timeout
          }

          // Write a .preserved marker so branch conflict resolution knows not to
          // destroy this worktree
          try {
            const agentDir = resolve(agent.worktreePath, '.agent')
            if (!existsSync(agentDir)) {
              mkdirSync(agentDir, { recursive: true })
            }
            writeFileSync(
              resolve(agentDir, 'preserved.json'),
              JSON.stringify({
                preservedAt: new Date().toISOString(),
                issueId,
                reason: incompleteCheck.reason,
                details: incompleteCheck.details,
              }, null, 2)
            )
          } catch {
            // Best-effort - the shouldCleanup=false flag is the primary guard
          }
        }
      }

      if (shouldCleanup && agent.worktreeIdentifier) {
        try {
          const failedAgentWorkType = agent.workType ?? 'development'
          const failedCodeProducing = new Set(['development', 'inflight'])
          const shouldDeleteBranch = !failedCodeProducing.has(failedAgentWorkType)
          this.removeWorktree(
            agent.worktreeIdentifier,
            shouldDeleteBranch ? (agent.identifier ?? undefined) : undefined
          )
          log?.info('Worktree cleaned up after failure', { worktreePath: agent.worktreePath })
        } catch (cleanupError) {
          log?.warn('Failed to clean up worktree after failure', {
            worktreePath: agent.worktreePath,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          })
        }
      }
    }

    // Finalize session logger with error
    this.finalizeSessionLogger(issueId, 'failed', {
      errorMessage: agent.error?.message,
    })

    this.cleanupAgent(issueId, sessionId)
    this.events.onAgentError?.(agent, agent.error)
  }
}

/**
 * Handle a single normalized agent event from any provider
 */
export async function handleAgentEvent(
  this: AgentOrchestrator,
  issueId: string,
  sessionId: string | undefined,
  event: AgentEvent,
  emitter: ActivityEmitter | ApiActivityEmitter | null,
  agent: AgentProcess,
  handle: AgentHandle
): Promise<void> {
  const log = this.agentLoggers.get(issueId)

  // Get heartbeat writer and progress logger for state updates
  const heartbeatWriter = this.heartbeatWriters.get(issueId)
  const progressLogger = this.progressLoggers.get(issueId)
  const sessionLogger = this.sessionLoggers.get(issueId)

  switch (event.type) {
    case 'init':
      log?.success('Agent initialized', { session: event.sessionId.substring(0, 12) })
      agent.providerSessionId = event.sessionId
      this.updateLastActivity(issueId, 'init')

      // Update state with provider session ID (only for worktree-based agents)
      // Skip if agent already failed — a late init event after an error would
      // re-persist a stale session ID, preventing fresh recovery on next attempt
      if (agent.worktreePath && agent.status !== 'failed') {
        try {
          updateState(agent.worktreePath, {
            providerSessionId: event.sessionId,
            status: 'running',
            pid: agent.pid ?? null,
          })
        } catch {
          // Ignore state update errors
        }
      }

      // Notify via callback for external persistence
      if (sessionId) {
        await this.events.onProviderSessionId?.(sessionId, event.sessionId)
      }
      break

    case 'system':
      // System-level events (status changes, compaction, auth, etc.)
      if (event.subtype === 'status') {
        log?.debug('Status change', { status: event.message })
      } else if (event.subtype === 'compact_boundary') {
        log?.debug('Context compacted')
        // Trigger incremental summarization on compaction boundary
        this.contextManagers.get(issueId)?.handleCompaction()
      } else if (event.subtype === 'hook_response') {
        // Provider-specific hook handling — access raw event for details
        const raw = event.raw as { exit_code?: number; hook_name?: string }
        if (raw.exit_code !== undefined && raw.exit_code !== 0) {
          log?.warn('Hook failed', { hook: raw.hook_name, exitCode: raw.exit_code })
        }
      } else if (event.subtype === 'reasoning') {
        // Codex reasoning/thinking events — buffer and log for fleet observability
        this.updateLastActivity(issueId, 'thinking')
        if (event.message) {
          this.bufferAssistantText(issueId, event.message, log)
        }
        heartbeatWriter?.recordThinking()
        // Persist reasoning to Linear session (same pattern as Claude's assistant_text)
        if (emitter && event.message && typeof event.message === 'string') {
          await emitter.emitThought(event.message.substring(0, 200))
        }
      } else if (event.subtype === 'auth_status') {
        if (event.message?.includes('error') || event.message?.includes('Error')) {
          log?.error('Auth error', { error: event.message })
        }
      } else {
        log?.debug('System event', { subtype: event.subtype, message: event.message })
      }
      break

    case 'tool_result':
      // Tool results — track activity and detect PR URLs
      this.updateLastActivity(issueId, 'tool_result')

      // Feed to context manager for artifact tracking
      this.contextManagers.get(issueId)?.processEvent(event)

      sessionLogger?.logToolResult(event.toolUseId ?? 'unknown', event.content, event.isError)

      // Detect GitHub PR URLs in tool output (from gh pr create)
      if (sessionId) {
        const prUrl = this.extractPullRequestUrl(event.content)
        if (prUrl) {
          log?.info('Pull request detected', { prUrl })
          agent.pullRequestUrl = prUrl
          await this.updateSessionPullRequest(sessionId, prUrl, agent)
        }
      }

      // Auto-emit structured context for successful tool results
      if (emitter && !event.isError && event.toolUseId) {
        const pending = this.pendingToolCalls.get(issueId)?.get(event.toolUseId)
        if (pending) {
          this.pendingToolCalls.get(issueId)!.delete(event.toolUseId)
          this.emitToolContext(emitter, pending.toolName, pending.input)
        }
      }
      break

    case 'assistant_text':
      // Assistant text output
      this.updateLastActivity(issueId, 'assistant')

      // Buffer and log agent reasoning for fleet observability.
      // Streaming providers (Codex) send one token per event — buffer for readability.
      if (event.text) {
        this.bufferAssistantText(issueId, event.text, log)
      }

      // Feed to context manager for session intent extraction
      this.contextManagers.get(issueId)?.processEvent(event)

      heartbeatWriter?.recordThinking()
      sessionLogger?.logAssistant(event.text)

      // Detect GitHub PR URLs in assistant text (backup for tool_result detection)
      if (sessionId && !agent.pullRequestUrl) {
        const prUrl = this.extractPullRequestUrl(event.text)
        if (prUrl) {
          log?.info('Pull request detected in assistant text', { prUrl })
          agent.pullRequestUrl = prUrl
          await this.updateSessionPullRequest(sessionId, prUrl, agent)
        }
      }

      if (emitter) {
        await emitter.emitThought(event.text.substring(0, 200))
      }
      break

    case 'tool_use':
      // Tool invocation
      this.updateLastActivity(issueId, 'assistant')

      // Feed to context manager for artifact tracking
      this.contextManagers.get(issueId)?.processEvent(event)

      log?.toolCall(event.toolName, event.input)
      heartbeatWriter?.recordToolCall(event.toolName)
      progressLogger?.logTool(event.toolName, event.input)
      sessionLogger?.logToolUse(event.toolName, event.input)

      // Track session output signals for completion contract validation
      this.trackSessionOutputSignal(issueId, event.toolName, event.input)

      // Intercept TodoWrite tool calls to persist todos
      if (event.toolName === 'TodoWrite') {
        try {
          const input = event.input as { todos?: TodoItem[] }
          if (input.todos && Array.isArray(input.todos) && agent.worktreePath) {
            const todosState: TodosState = {
              updatedAt: Date.now(),
              items: input.todos,
            }
            writeTodos(agent.worktreePath, todosState)
            log?.debug('Todos persisted', { count: input.todos.length })
          }
        } catch {
          // Ignore todos persistence errors
        }
      }

      // Track pending tool call for context emission on tool_result
      if (event.toolUseId) {
        if (!this.pendingToolCalls.has(issueId)) {
          this.pendingToolCalls.set(issueId, new Map())
        }
        this.pendingToolCalls.get(issueId)!.set(event.toolUseId, {
          toolName: event.toolName,
          input: event.input,
        })
      }

      if (emitter) {
        await emitter.emitToolUse(event.toolName, event.input)
      }
      break

    case 'tool_progress':
      // Tool execution progress — track activity for long-running tools
      this.updateLastActivity(issueId, `tool_progress:${event.toolName}`)
      log?.debug('Tool progress', { tool: event.toolName, elapsed: `${event.elapsedSeconds}s` })
      break

    case 'result':
      // Flush any buffered assistant text before processing result
      this.flushAssistantTextBuffer(issueId, log)

      if (event.success) {
        log?.success('Agent completed', {
          cost: event.cost?.totalCostUsd ? `$${event.cost.totalCostUsd.toFixed(4)}` : 'N/A',
          turns: event.cost?.numTurns,
        })

        // Track cost data on the agent
        if (event.cost) {
          agent.totalCostUsd = event.cost.totalCostUsd
          agent.inputTokens = event.cost.inputTokens
          agent.outputTokens = event.cost.outputTokens
        }

        // Store full result for completion comment posting later
        if (event.message) {
          agent.resultMessage = event.message

          // Detect GitHub PR URLs in final result message (backup for tool_result detection)
          if (sessionId && !agent.pullRequestUrl) {
            const prUrl = this.extractPullRequestUrl(event.message)
            if (prUrl) {
              log?.info('Pull request detected in result message', { prUrl })
              agent.pullRequestUrl = prUrl
              await this.updateSessionPullRequest(sessionId, prUrl, agent)
            }
          }
        }

        // Update state to completing/completed (only for worktree-based agents)
        if (agent.worktreePath) {
          try {
            updateState(agent.worktreePath, {
              status: 'completing',
              currentPhase: 'Finalizing work',
            })
          } catch {
            // Ignore state update errors
          }
        }
        progressLogger?.logComplete({ message: event.message?.substring(0, 200) })

        // Check cost limit
        const maxCostUsd = parseFloat(process.env.AGENT_MAX_COST_USD ?? '0')
        if (maxCostUsd > 0 && event.cost?.totalCostUsd && event.cost.totalCostUsd > maxCostUsd) {
          log?.warn('Agent exceeded cost limit', {
            totalCost: event.cost.totalCostUsd,
            limit: maxCostUsd,
          })
        }

        // Emit truncated preview to activity feed (ephemeral)
        if (emitter && event.message && typeof event.message === 'string') {
          await emitter.emitThought(`Completed: ${event.message.substring(0, 200)}...`, true)
        }
      } else {
        // Error result — mark agent as failed so auto-transition doesn't fire
        // with an empty resultMessage (which would always produce 'unknown')
        agent.status = 'failed'
        log?.error('Agent error result', { subtype: event.errorSubtype })

        // Update state to failed
        const errorMessage = event.errors && event.errors.length > 0
          ? event.errors[0]
          : `Agent error: ${event.errorSubtype}`
        if (agent.worktreePath) {
          try {
            // If the error is a stale session (resume failed), clear providerSessionId
            // so the next recovery attempt starts fresh instead of hitting the same error.
            // Claude: "No conversation found with session ID"
            // Codex: "thread/resume failed" or "thread/resume: ..."
            const isStaleSession =
              errorMessage.includes('No conversation found with session ID') ||
              errorMessage.includes('thread/resume failed') ||
              errorMessage.includes('thread/resume:')
            updateState(agent.worktreePath, {
              status: 'failed',
              errorMessage,
              ...(isStaleSession && { providerSessionId: null }),
            })
            if (isStaleSession) {
              log?.info('Cleared stale providerSessionId from state — next recovery will start fresh')
            }
          } catch {
            // Ignore state update errors
          }
        }
        progressLogger?.logError('Agent error result', new Error(errorMessage))
        sessionLogger?.logError('Agent error result', new Error(errorMessage), { subtype: event.errorSubtype })

        // Merge queue: dequeue PR on merge agent failure
        if (agent.workType === 'merge' && this.mergeQueueAdapter && agent.pullRequestUrl) {
          try {
            const prMatch = agent.pullRequestUrl.match(/\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
            if (prMatch) {
              const [, owner, repo, prNum] = prMatch
              await this.mergeQueueAdapter.dequeue(owner, repo, parseInt(prNum, 10))
              log?.info('PR dequeued from merge queue after failure', { owner, repo, prNumber: prNum })
            }
          } catch (dequeueError) {
            log?.warn('Failed to dequeue PR from merge queue', {
              error: dequeueError instanceof Error ? dequeueError.message : String(dequeueError),
            })
          }
        }

        // Report tool errors as Linear issues for tracking
        // Only report for 'error_during_execution' subtype (tool/execution errors)
        if (
          event.errorSubtype === 'error_during_execution' &&
          event.errors &&
          emitter
        ) {
          for (const err of event.errors) {
            log?.error('Error detail', { error: err })

            if (isToolRelatedError(err)) {
              const toolName = extractToolNameFromError(err)
              try {
                const issue = await emitter.reportToolError(toolName, err, {
                  issueIdentifier: agent.identifier,
                  additionalContext: {
                    agentStatus: agent.status,
                    workType: agent.workType,
                    subtype: event.errorSubtype,
                  },
                })
                if (issue) {
                  log?.info('Tool error reported to Linear', {
                    issue: issue.identifier,
                    toolName,
                  })
                }
              } catch (reportError) {
                log?.warn('Failed to report tool error', {
                  error:
                    reportError instanceof Error
                      ? reportError.message
                      : String(reportError),
                })
              }
            }
          }
        } else if (event.errors) {
          for (const err of event.errors) {
            log?.error('Error detail', { error: err })
          }
        }
      }
      break

    case 'error':
      log?.error('Agent error', { message: event.message, code: event.code })
      break

    default:
      log?.debug('Unhandled event type', { type: (event as { type: string }).type })
  }
}

