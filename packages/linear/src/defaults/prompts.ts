/**
 * Default prompt templates for each work type.
 *
 * These provide sensible defaults that can be overridden by consumers.
 * The Rensei project overrides these with its own prompts.ts.
 */

import type { AgentWorkType, SubIssueStatus } from '../types.js'

const HUMAN_BLOCKER_INSTRUCTION = `

HUMAN-NEEDED BLOCKERS:
If you encounter work that requires human action and cannot be resolved autonomously
(e.g., missing API keys/credentials, infrastructure not provisioned, third-party onboarding,
manual setup steps, policy decisions, access permissions), create a blocker issue:
  pnpm af-linear create-blocker <SOURCE-ISSUE-ID> --title "What human needs to do" --description "Detailed steps"
This creates a tracked issue in Icebox with 'Needs Human' label, linked as blocking the source issue.
Do NOT silently skip human-needed work or bury it in comments.
Only create blockers for things that genuinely require a human — not for things you can retry or work around.`

export const WORK_RESULT_MARKER_INSTRUCTION = `

MANDATORY — Structured Result Marker:
You MUST include exactly one of these HTML comment markers in your final output:
- On pass: <!-- WORK_RESULT:passed -->
- On fail: <!-- WORK_RESULT:failed -->
Without this marker, the orchestrator CANNOT detect your result and the issue status will NOT be updated. Even if you encounter errors, always emit <!-- WORK_RESULT:failed -->.`

export const READ_ONLY_CONSTRAINT = `

CRITICAL CONSTRAINT — READ-ONLY ROLE:
You are a VALIDATION agent, NOT a development agent. You MUST NOT modify any source code, configuration files, migration files, or project files. Your role is strictly to READ, VALIDATE, and REPORT.
FORBIDDEN actions: creating files, editing files, writing code, committing changes, patching snapshots, fixing bugs, resolving errors in code.
ALLOWED actions: reading files, running tests, running builds, checking CI status, posting comments, merging PRs (acceptance only), updating Linear status.
If you discover issues (missing files, broken builds, failing tests), REPORT them in your result comment and emit WORK_RESULT:failed. Do NOT attempt to fix them.`

export const PR_SELECTION_GUIDANCE = `

PR Selection (Multi-PR Handling):
Issues may have multiple PRs. Select the correct one:
1. Check linked PRs in the issue attachments/links for GitHub PR URLs
2. Filter by state — prefer OPEN over MERGED over CLOSED: gh pr view NNN --json state
3. If multiple OPEN PRs, pick the most recently created one
4. Fallback search by branch: gh pr list --head "$(git branch --show-current)" --state open
5. Last resort search by issue ID: gh pr list --state open --search "[issue-id]"
6. If no PR found, emit WORK_RESULT:failed with explanation`

/**
 * Compressed commit/push/PR ladder.
 *
 * Belt-and-suspenders directive for code-producing work types. The full
 * ladder lives in the `commit-push-pr` template partial; this inline
 * version guarantees the mandatory persistence steps appear in the prompt
 * even when a caller bypasses the template system entirely (e.g., the
 * platform's pre-generated prompts prior to orchestrator template merge).
 *
 * Without this, Codex-class single-turn agents will implement + test, then
 * exit without committing — forcing the session backstop to recover git
 * state. The backstop is a failure-mode safety net, not the happy path.
 */
export const PERSISTENCE_DIRECTIVES = `

MANDATORY — PERSIST YOUR WORK (non-negotiable):
Your work is NOT done until a PR exists. Execute this ladder before exiting:
  1. COMMIT: git add <files> && git commit -m "descriptive message"
  2. PUSH:   git push -u origin $(git branch --show-current)
  3. PR:     gh pr create --title "..." --body "..."
If you skip any step, the session backstop will have to recover your work and
the issue will be flagged as incomplete. Do NOT report completion until the
PR URL appears in your output.`

/**
 * Context from the workflow state machine for retry enrichment.
 * Injected when an issue has been through previous dev-QA-rejected cycles.
 */
export interface WorkflowContext {
  cycleCount: number
  strategy: string
  failureSummary: string | null
  qaAttemptCount?: number
}

/**
 * Build the failure context block to append to prompts for retries.
 */
export function buildFailureContextBlock(
  workType: AgentWorkType,
  context: WorkflowContext
): string {
  if (context.cycleCount <= 0) return ''

  switch (workType) {
    case 'refinement': {
      if (context.strategy === 'decompose') {
        return `\n\n## Decomposition Required (Cycle ${context.cycleCount})

This issue has been through ${context.cycleCount} development-QA cycle(s) and keeps failing.
Instead of refining, DECOMPOSE this issue into smaller, independently testable pieces.

### Failure History
${context.failureSummary ?? 'No details recorded.'}

### Decomposition Instructions
- Break this issue into smaller sub-issues (use --parentId to make them children)
- Each sub-issue must have clear, unambiguous acceptance criteria
- Each sub-issue must be testable in isolation
- Address one specific concern that previous attempts failed on
- After creating sub-issues, keep the PARENT issue in Icebox for human review`
      }

      return `\n\n## Previous Failure Context

This issue has been through ${context.cycleCount} development-QA cycle(s).

### Failure History
${context.failureSummary ?? 'No details recorded.'}

### Instructions
- Read the failure history carefully before making changes
- Do NOT repeat approaches that already failed
- If the acceptance criteria are ambiguous, update them to be testable before fixing code
- Focus on the ROOT CAUSE, not symptoms`
    }

    case 'development':
    case 'inflight': {
      return `\n\n## Retry Context

This is retry #${context.cycleCount} for this issue. Previous QA failures:
${context.failureSummary ?? 'No details recorded.'}

Pay special attention to the areas that failed QA previously.`
    }

    case 'qa': {
      if (!context.failureSummary) return ''
      return `\n\n## Previous QA Results
This issue has been QA'd ${context.qaAttemptCount ?? context.cycleCount} times previously.
${context.failureSummary}
Focus validation on these previously failing areas.`
    }

    default:
      return ''
  }
}

/**
 * Generate a default prompt for a given work type and issue identifier.
 *
 * @param identifier - The issue identifier (e.g., "PROJ-123")
 * @param workType - The type of work to perform
 * @param mentionContext - Optional additional context from a user mention
 * @param workflowContext - Optional workflow state context for retry enrichment
 */
export function defaultGeneratePrompt(
  identifier: string,
  workType: AgentWorkType,
  mentionContext?: string,
  workflowContext?: WorkflowContext
): string {
  let basePrompt: string

  switch (workType) {
    case 'research':
      basePrompt = `Research and flesh out story ${identifier}. Analyze requirements, identify technical approach, estimate complexity, and update the story description with detailed acceptance criteria. Do NOT implement code.`
      break
    case 'backlog-creation':
      basePrompt = `Create backlog issues from the researched story ${identifier}.
Read the issue description, identify distinct work items, classify each as bug/feature/chore,
and create appropriately scoped issues in Icebox status (so a human can review before moving to Backlog).
Choose the correct issue structure based on the work:
- Sub-issues (--parentId): When work is a single concern with sequential/parallel phases sharing context and dependencies.
- Independent issues (--type related): When items are unrelated work in different codebase areas with no shared context.
- Single issue rewrite: When scope is atomic (single concern, few files, no phases). Rewrite source in-place, keep in Icebox.
When creating multiple issues, always add "related" links between them AND blocking relations where one step depends on another.
Do NOT wait for user approval - create issues automatically.`
      break
    case 'development':
      basePrompt = `Start work on ${identifier}. Implement the feature/fix as specified.
${PERSISTENCE_DIRECTIVES}`
      break
    case 'inflight':
      basePrompt = `Continue work on ${identifier}. Resume where you left off.
${PERSISTENCE_DIRECTIVES}`
      break
    case 'qa':
      basePrompt = `QA ${identifier}. Validate the implementation against acceptance criteria.
${READ_ONLY_CONSTRAINT}
${WORK_RESULT_MARKER_INSTRUCTION}
${PR_SELECTION_GUIDANCE}

Validation Steps:
1. Find and validate the correct PR (see PR selection above)
2. Run tests scoped to the affected packages
3. Verify the build passes
4. Check deployment status (CI checks on the PR)
5. Review changes against issue requirements
6. Post result comment with the structured marker`
      break
    case 'acceptance':
      basePrompt = `Process acceptance for ${identifier}. Validate development and QA work is complete, verify PR is ready to merge (CI passing, no conflicts), merge the PR, and clean up local resources.
${READ_ONLY_CONSTRAINT}
${WORK_RESULT_MARKER_INSTRUCTION}
${PR_SELECTION_GUIDANCE}

Acceptance Steps:
1. Find and validate the correct PR (see PR selection above)
2. Verify CI is passing and there are no merge conflicts
3. Confirm QA has passed (check issue status or QA comments)
4. Merge the PR
5. Delete the remote branch after successful merge
6. Post result comment with the structured marker`
      break
    case 'refinement':
      basePrompt = `Refine ${identifier} based on rejection feedback. Read comments, update requirements, then return to Backlog.`
      break
    case 'refinement-coordination':
      basePrompt = `Coordinate refinement across sub-issues for parent issue ${identifier}.
Read the QA/acceptance failure comments to identify which sub-issues failed and why.
For each failing sub-issue, update its description with the specific failure feedback and move it back to Backlog.
Leave passing sub-issues in their current state — do not re-run them.
Once failing sub-issues are triaged, the orchestrator will move the parent to Backlog for re-coordination.

Refinement Coordination Steps:
1. Read comments on ${identifier} to find the QA/acceptance failure report
2. Fetch sub-issues: pnpm af-linear list-sub-issues ${identifier}
3. For each failing sub-issue: update description with failure details, move to Backlog
4. Leave passing sub-issues unchanged

IMPORTANT: Do NOT implement fixes yourself — only triage and route feedback to the correct sub-issues.`
      break
    case 'merge':
      basePrompt = `Handle merge queue operations for ${identifier}.

WORKFLOW:
1. Check PR merge readiness (CI status, approvals)
2. Pull latest main and rebase feature branch
3. If conflicts arise, resolve using mergiraf-enhanced git merge
4. Push updated branch
5. Add PR to merge queue via configured provider (gh pr merge --merge-queue)
6. Monitor queue status until merged or failed`
      break
    case 'security':
      basePrompt = `Security scan ${identifier}. Run security scanning tools (SAST, dependency audit) against the codebase and output structured results.
${READ_ONLY_CONSTRAINT}
${WORK_RESULT_MARKER_INSTRUCTION}

Security Scan Steps:
1. Identify the project type (Node.js, Python, etc.) by inspecting package.json, requirements.txt, etc.
2. Run appropriate scanners (semgrep for SAST, npm-audit/pip-audit for dependencies)
3. Parse scanner outputs and produce structured JSON summaries
4. Output results in fenced code blocks tagged \`security-scan-result\`
5. If critical or high severity issues found, emit WORK_RESULT:failed
6. If only medium/low or no issues found, emit WORK_RESULT:passed`
      break

    case 'improvement-loop':
      basePrompt = `You are the Improvement Loop for project ${identifier}.
Read the last 20 accepted/rejected sessions and identify systemic patterns.
Author meta-issues (at most 5 per cycle) about how the system works.

HARD RULES:
- Author at most 5 issues per cycle.
- Each issue MUST cite at least 3 specific failure cases (issue IDs / session IDs).
- Tag every meta-issue with meta:improvement AND subsystem:<name>.
- NEVER create sub-issues (--parentId is forbidden).

${WORK_RESULT_MARKER_INSTRUCTION}`
      break

    case 'outcome-auditor':
      basePrompt = `Run outcome audit for recently accepted issues.
${READ_ONLY_CONSTRAINT}
${WORK_RESULT_MARKER_INSTRUCTION}

Outcome Audit Steps:
1. List recently accepted issues for the project.
2. For each issue: read the original AC, find merged PR(s), diff against AC, check for deferred or missed work.
3. For each gap: author a follow-up issue (Backlog), reference source issue, add blocks relation if applicable.
4. For clean issues: tag with audit:clean and post "Audit pass: no gaps" comment.
5. For issues with gaps: tag with audit:has-followups.
IMPORTANT: Do NOT create sub-issues (--parentId). Follow-up issues are standalone.`
      break

    case 'backlog-groomer':
      // PM agent (012 Archetype 3 — Ralph Wiggum loop). One issue per invocation.
      // The TemplateRegistry-based prompt is the canonical path; this legacy
      // function is a fallback for environments that haven't migrated to templates.
      basePrompt = `Groom icebox issue ${identifier}.
Read the issue, evaluate its relevance, and apply exactly one disposition:
- discard: add label pm:discard, post comment explaining why, close the issue.
- refine: add label pm:needs-refine, post comment describing what needs refinement.
- escalate-human: add label pm:needs-human-decision, post comment describing the decision needed.
If the issue is older than 60 days with no recent activity, also add label pm:stale.
NEVER create sub-issues (Principle 1). Process this one issue only.`
      break

    case 'documentation-steward':
      // PM agent (012 Archetype 7 — Documentation Steward). Maintains docs alongside code.
      // The TemplateRegistry-based prompt is the canonical path; this legacy
      // function is a fallback for environments that haven't migrated to templates.
      basePrompt = `Run documentation steward scan for ${identifier}.

WORKFLOW:
1. Enumerate all Markdown files in the repo (find . -name "*.md").
2. Cross-reference API/symbol mentions in docs against current codebase.
3. Identify public surfaces without documentation.
4. Check recent PRs for code changes not accompanied by doc updates.
5. Author standalone refinement issues for each gap.
   - NEVER use --parentId (Principle 1).
6. Post a summary comment on ${identifier}.

HARD RULES:
- NEVER create sub-issues (Principle 1).
- Complex gaps always become standalone refinement issues.

STRUCTURED RESULT MARKER (REQUIRED):
- On completion: Include <!-- WORK_RESULT:passed --> in your final message
- On failure: Include <!-- WORK_RESULT:failed --> in your final message`
      break

    case 'ga-readiness':
      // PM agent (012 Archetype 5 — GA-Readiness Assessor). Runs before production promotion.
      // The TemplateRegistry-based prompt is the canonical path; this legacy
      // function is a fallback for environments that haven't migrated to templates.
      basePrompt = `Assess GA readiness for feature ${identifier}.

WORKFLOW:
1. Read the feature epic: pnpm af-linear get-issue ${identifier}
2. List accepted issues for this feature.
3. For each accepted issue: verify all AC items were delivered in the merged PR.
4. Run Architectural Intelligence drift check via pnpm af-ai assess.
5. Check observability: search for HookBus emissions and metrics in touched paths.
6. Security review: PENDING 010-security-architecture.md — note as manual check.
7. Post a structured GA-readiness report as a comment on the feature epic.
8. For each gap: create a standalone blocker issue and add a blocks relation.

HARD RULES:
- NEVER use --parentId (Principle 1: sub-issues are reserved for human intent).
- Author blocker issues via: pnpm af-linear add-relation <BLOCKER_ID> ${identifier} --type blocks
- The GA-readiness report is a COMMENT (create-comment), not a new issue.

STRUCTURED RESULT MARKER (REQUIRED):
- All checks pass (no blockers): Include <!-- WORK_RESULT:passed --> in your final message
- Any blockers found or assessment failed: Include <!-- WORK_RESULT:failed --> in your final message`
      break

    case 'operational-scanner-vercel':
      // PM agent (012 Archetype 6 — Operational Scanner, Vercel variant)..
      // The TemplateRegistry-based prompt is the canonical path; this legacy
      // function is a fallback for environments that haven't migrated to templates.
      // NOTE: Live Vercel binding is mocked pending a Vercel plugin.
      basePrompt = `Run Vercel operational scan.

WORKFLOW:
1. Query Vercel deploy logs for the configured time window (mock source pending).
2. Cluster by failure type: deploy failures, function timeouts, cold-start regressions.
3. Dedupe against existing Linear issues (search by vercel-deploy-id).
4. For each new cluster: create a standalone bug-report issue with provenance tags.

HARD RULES:
- NEVER use --parentId (Principle 1).
- Cap issues per scan at 10 (default).
- Tag issues: bug, source:vercel, provenance:scan-<runId>.

${WORK_RESULT_MARKER_INSTRUCTION}`
      break

    case 'operational-scanner-audit':
      // PM agent (012 Archetype 6 — Operational Scanner, Audit variant)..
      // The TemplateRegistry-based prompt is the canonical path; this fallback
      // is for environments that haven't migrated to templates.
      basePrompt = `Run audit-chain operational scan.

WORKFLOW:
1. Query audit chain entries for the configured time window (006 Seam 6).
2. Cluster by anomaly type: missing entries, broken chains, unexpected actors.
3. Dedupe against existing Linear issues (search by audit-event-id).
4. For each new cluster: create a standalone bug-report issue with provenance tags.

HARD RULES:
- NEVER use --parentId (Principle 1).
- Cap issues per scan at 10 (default).
- Tag issues: bug, source:audit, provenance:scan-<runId>.

${WORK_RESULT_MARKER_INSTRUCTION}`
      break

    case 'operational-scanner-ci':
      // PM agent (012 Archetype 6 — Operational Scanner, CI variant)..
      // The TemplateRegistry-based prompt is the canonical path; this fallback
      // is for environments that haven't migrated to templates.
      basePrompt = `Run CI operational scan.

WORKFLOW:
1. Query CI run logs for the configured time window.
2. Cluster by signal type: flaky tests, slow steps, optimization opportunities.
3. Dedupe against existing Linear issues (search by ci-run-id + test-name).
4. For each new cluster: create a standalone bug-report or improvement issue with provenance.

HARD RULES:
- NEVER use --parentId (Principle 1).
- Cap issues per scan at 10 (default).
- Tag issues: source:ci, provenance:scan-<runId>; add bug for flaky tests, chore for optimizations.

${WORK_RESULT_MARKER_INSTRUCTION}`
      break
  }

  basePrompt += HUMAN_BLOCKER_INSTRUCTION

  // Inject workflow failure context for retries
  if (workflowContext) {
    basePrompt += buildFailureContextBlock(workType, workflowContext)
  }

  if (mentionContext) {
    return `${basePrompt}\n\nAdditional context from the user's mention:\n${mentionContext}`
  }
  return basePrompt
}

/**
 * Build default QA context for parent issues with sub-issues.
 */
export function defaultBuildParentQAContext(
  issueIdentifier: string,
  subIssueStatuses: SubIssueStatus[]
): string {
  const subIssueList = subIssueStatuses
    .map(s => `- ${s.identifier}: ${s.title} (Status: ${s.status})`)
    .join('\n')

  return `QA ${issueIdentifier} (parent issue with ${subIssueStatuses.length} sub-issues).

## Sub-Issues
${subIssueList}

## Holistic QA Instructions
This is a parent issue whose work was coordinated across multiple sub-issues.
Perform holistic validation beyond individual sub-issue checks:

1. **Scope Coverage**: Read each sub-issue description and verify the PR includes implementation for ALL sub-issues.
2. **Integration Validation**: Check that shared types, API contracts, and data flow between sub-issue implementations are consistent and correct.
3. **Cross-Cutting Concerns**: Verify consistent error handling, auth patterns, naming conventions, and no orphaned/dead code across all sub-issue changes.
4. **Sub-Issue Status**: All sub-issues must be in Finished, Delivered, or Accepted status.

Validate the implementation against the parent issue's acceptance criteria as a whole, not just each sub-issue in isolation.`
}

/**
 * Build default acceptance context for parent issues with sub-issues.
 */
export function defaultBuildParentAcceptanceContext(
  issueIdentifier: string,
  subIssueStatuses: SubIssueStatus[]
): string {
  const subIssueList = subIssueStatuses
    .map(s => `- ${s.identifier}: ${s.title} (Status: ${s.status})`)
    .join('\n')

  return `Process acceptance for ${issueIdentifier} (parent issue with ${subIssueStatuses.length} sub-issues).

## Sub-Issues
${subIssueList}

## Parent Issue Acceptance Requirements
This is a parent issue with coordinated sub-issues. Before merging:

1. **Sub-Issue Status**: ALL sub-issues must be in **Delivered** or **Accepted** status.
2. **PR Completeness**: The single PR should contain changes for all sub-issues.
3. **CI/Deployment**: Verify the combined PR passes CI and deploys successfully.

Validate development and QA work is complete, verify PR is ready to merge (CI passing, no conflicts), merge the PR.
After merge succeeds, delete the remote branch.`
}
