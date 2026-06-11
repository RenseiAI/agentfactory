/**
 * Spawn helpers — environment loading and legacy prompt generation
 *
 * Extracted from orchestrator.ts.
 *
 *   - loadSettingsEnv: reads .claude/settings.local.json for agent env vars
 *   - loadAppEnvFiles: loads .env.local / .env.test.local from monorepo apps
 *   - generatePromptForWorkType: legacy fallback prompt generator (superseded
 *     by the TemplateRegistry for most work types)
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { parse as parseDotenv } from 'dotenv'
import { resolveMainRepoRoot as resolveMainRepoRootWA, findRepoRoot as findRepoRootWA } from '../workarea/git-worktree.js'
import type { AgentWorkType } from './work-types.js'
import type { Logger } from '../logger.js'

export function loadSettingsEnv(workDir: string, log?: Logger, mainRepoRoot?: string): Record<string, string> {
  // If main repo root is known, check there first (settings.local.json is gitignored,
  // so it only exists in the main repo, not in worktrees)
  if (mainRepoRoot) {
    const settingsPath = resolve(mainRepoRoot, '.claude', 'settings.local.json')
    if (existsSync(settingsPath)) {
      try {
        const content = readFileSync(settingsPath, 'utf-8')
        const settings = JSON.parse(content)
        if (settings.env && typeof settings.env === 'object') {
          const env: Record<string, string> = {}
          for (const [key, value] of Object.entries(settings.env)) {
            if (typeof value === 'string') {
              env[key] = value
            }
          }
          log?.debug('Loaded settings.local.json from main repo', { envVars: Object.keys(env).length })
          return env
        }
      } catch (error) {
        log?.warn('Failed to load settings.local.json from main repo', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return {}
    }
  }

  // Walk up from workDir to find .claude/settings.local.json
  let currentDir = workDir
  let prevDir = ''

  // Keep walking up until we reach the filesystem root
  while (currentDir !== prevDir) {
    const settingsPath = resolve(currentDir, '.claude', 'settings.local.json')
    const exists = existsSync(settingsPath)

    if (exists) {
      try {
        const content = readFileSync(settingsPath, 'utf-8')
        const settings = JSON.parse(content)
        if (settings.env && typeof settings.env === 'object') {
          // Filter to only string values
          const env: Record<string, string> = {}
          for (const [key, value] of Object.entries(settings.env)) {
            if (typeof value === 'string') {
              env[key] = value
            }
          }
          log?.debug('Loaded settings.local.json', { envVars: Object.keys(env).length })
          return env
        }
      } catch (error) {
        log?.warn('Failed to load settings.local.json', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
      // File exists but has no env property — not an error
      log?.debug('settings.local.json found but contains no env property', { path: settingsPath })
      return {}
    }
    prevDir = currentDir
    currentDir = dirname(currentDir)
  }

  log?.debug('settings.local.json not found', { startDir: workDir })
  return {}
}

/**
 * Load environment variables from app .env files based on work type
 *
 * - Development work: loads .env.local from all apps
 * - QA/Acceptance work: loads .env.test.local from all apps
 *
 * This ensures agents running in worktrees have access to database config
 * and other environment variables that are gitignored.
 */
export function loadAppEnvFiles(
  workDir: string,
  workType: AgentWorkType,
  log?: Logger,
  mainRepoRoot?: string,
): Record<string, string> {
  // Use provided main repo root, or resolve from workDir (follows worktree .git references)
  const repoRoot = mainRepoRoot ?? resolveMainRepoRootWA(workDir) ?? findRepoRootWA(workDir)
  if (!repoRoot) {
    log?.warn('Could not find repo root for env file loading', { startDir: workDir })
    return {}
  }

  const appsDir = resolve(repoRoot, 'apps')
  if (!existsSync(appsDir)) {
    return {}
  }

  // Determine which env file to load based on work type
  const isTestWork = workType === 'qa' || workType === 'acceptance'
  const envFileName = isTestWork ? '.env.test.local' : '.env.local'

  const env: Record<string, string> = {}
  let loadedCount = 0

  try {
    const appDirs = readdirSync(appsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)

    for (const appName of appDirs) {
      const envPath = resolve(appsDir, appName, envFileName)
      if (existsSync(envPath)) {
        // Parse the file without injecting into process.env (avoids dotenv log spam)
        const parsed = parseDotenv(readFileSync(envPath, 'utf-8'))
        if (parsed && Object.keys(parsed).length > 0) {
          Object.assign(env, parsed)
          loadedCount++
          log?.debug(`Loaded ${envFileName} from ${appName}`, {
            vars: Object.keys(parsed).length,
          })
        }
      }
    }

    if (loadedCount > 0) {
      log?.info(`Monorepo detected — loaded ${envFileName} from ${loadedCount} app(s)`, {
        workType,
        totalVars: Object.keys(env).length,
      })
    }
  } catch (error) {
    log?.warn('Failed to load app env files', {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return env
}

/**
 * Generate a prompt for the agent based on work type (legacy fallback).
 *
 * This function is a fallback used when the TemplateRegistry doesn't have a
 * template for a given work type. For most work types, the TemplateRegistry
 * renders the prompt from YAML templates.
 *
 * @param identifier - Issue identifier (e.g., ABC-123)
 * @param workType - Type of work being performed
 * @param options - Optional configuration
 * @param options.parentContext - Pre-built enriched prompt for parent issues.
 * @returns The fallback prompt for the work type
 */

export function generatePromptForWorkType(
  identifier: string,
  workType: AgentWorkType,
  options?: { parentContext?: string; mentionContext?: string; failureContext?: string }
): string {
  // Use enriched parent context for QA/acceptance if provided
  if (options?.parentContext && (workType === 'qa' || workType === 'acceptance')) {
    return options.parentContext
  }

  const LINEAR_CLI_INSTRUCTION = `

LINEAR CLI (CRITICAL):
Use the Linear CLI (\`pnpm af-linear\`) for ALL Linear operations. Do NOT use Linear MCP tools.
See the project documentation (CLAUDE.md / AGENTS.md) for the full command reference.

HUMAN-NEEDED BLOCKERS:
If you encounter work that requires human action and cannot be resolved autonomously
(e.g., missing API keys/credentials, infrastructure not provisioned, third-party onboarding,
manual setup steps, policy decisions, access permissions), create a blocker issue:
  pnpm af-linear create-blocker <SOURCE-ISSUE-ID> --title "What human needs to do" --description "Detailed steps"
This creates a tracked issue in Icebox with 'Needs Human' label, linked as blocking the source issue.
Do NOT silently skip human-needed work or bury it in comments.
Only create blockers for things that genuinely require a human — not for things you can retry or work around.`

  let basePrompt: string
  switch (workType) {
    case 'research':
      basePrompt = `Research and flesh out story ${identifier}.
Analyze requirements, identify technical approach, estimate complexity,
and update the story description with detailed acceptance criteria.
Do NOT implement code. Focus on story refinement only.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'backlog-creation':
      basePrompt = `Create backlog issues from the researched story ${identifier}.
Read the issue description, identify distinct work items, classify each as bug/feature/chore,
and create appropriately scoped Linear issues in Icebox status (so a human can review before moving to Backlog).
Choose the correct issue structure based on the work:
- Sub-issues (--parentId): When work is a single concern with sequential/parallel phases sharing context and dependencies. Keep source in Icebox as parent. Add blocking relations (--type blocks) between sub-issues to define execution order for the coordinator.
- Independent issues (--type related): When items are unrelated work in different codebase areas with no shared context. Source stays in Icebox.
- Single issue rewrite: When scope is atomic (single concern, \u22643 files, no phases). Rewrite source in-place, keep in Icebox.
IMPORTANT: When creating multiple issues (sub-issues or independent), always add "related" links between them AND blocking relations where one step depends on another. This informs sub-agents and the coordinator of execution order.
Do NOT wait for user approval - create issues automatically.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'development':
      basePrompt = `Start work on ${identifier}.
Implement the feature/fix as specified in the issue description.
You MUST deliver 100% of the documented scope. Do NOT defer, punt, or list
"follow-ups" for requirements described in this issue.

DEPENDENCY INSTALLATION:
Dependencies are symlinked from the main repo by the orchestrator. Do NOT run pnpm install.
If you encounter a specific "Cannot find module" error, run it SYNCHRONOUSLY
(never with run_in_background). Never use sleep or polling loops to wait for commands.

IMPORTANT: If you encounter "exceeds maximum allowed tokens" error when reading files:
- Use Grep to search for specific code patterns instead of reading entire files
- Use Read with offset/limit parameters to paginate through large files
- Avoid reading auto-generated files like payload-types.ts (use Grep instead)
See the "Working with Large Files" section in the project documentation (CLAUDE.md / AGENTS.md) for details.

MANDATORY — PUSH AND CREATE PR (non-negotiable):
When your work is complete and validated (typecheck, build, test all pass):
1. git push -u origin $(git branch --show-current)
2. gh pr create --title "<type>: <description>" --body "<summary of changes>"
If you skip these steps, your work will be LOST. The orchestrator marks work as FAILED if no PR is detected.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'inflight':
      basePrompt = `Continue work on ${identifier}.
Resume where you left off. Check the issue for any new comments or feedback.

DEPENDENCY INSTALLATION:
Dependencies are symlinked from the main repo by the orchestrator. Do NOT run pnpm install.
If you encounter a specific "Cannot find module" error, run it SYNCHRONOUSLY
(never with run_in_background). Never use sleep or polling loops to wait for commands.

IMPORTANT: If you encounter "exceeds maximum allowed tokens" error when reading files:
- Use Grep to search for specific code patterns instead of reading entire files
- Use Read with offset/limit parameters to paginate through large files
- Avoid reading auto-generated files like payload-types.ts (use Grep instead)
See the "Working with Large Files" section in the project documentation (CLAUDE.md / AGENTS.md) for details.

MANDATORY — PUSH AND CREATE PR (non-negotiable):
When your work is complete and validated (typecheck, build, test all pass):
1. git push -u origin $(git branch --show-current)
2. gh pr create --title "<type>: <description>" --body "<summary of changes>"
If you skip these steps, your work will be LOST. The orchestrator marks work as FAILED if no PR is detected.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'qa':
      basePrompt = `QA ${identifier}.
Validate the implementation against acceptance criteria.
Run tests, check for regressions, verify the PR meets requirements.

STRUCTURED RESULT MARKER (REQUIRED):
You MUST include a structured result marker in your final output message.
The orchestrator parses your output to determine whether to promote or reject the issue.
Without this marker, the issue status will NOT be updated automatically.
- On QA pass: Include <!-- WORK_RESULT:passed --> in your final message
- On QA fail: Include <!-- WORK_RESULT:failed --> in your final message

DEPENDENCY INSTALLATION:
Dependencies are symlinked from the main repo by the orchestrator. Do NOT run pnpm install.
If you encounter a specific "Cannot find module" error, run it SYNCHRONOUSLY
(never with run_in_background). Never use sleep or polling loops to wait for commands.

IMPORTANT: If you encounter "exceeds maximum allowed tokens" error when reading files:
- Use Grep to search for specific code patterns instead of reading entire files
- Use Read with offset/limit parameters to paginate through large files
- Avoid reading auto-generated files like payload-types.ts (use Grep instead)
See the "Working with Large Files" section in the project documentation (CLAUDE.md / AGENTS.md) for details.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'acceptance':
      basePrompt = `Process acceptance for ${identifier}.
Validate development and QA work is complete.
Verify PR is ready to merge (CI passing, no conflicts).
Merge the PR using: gh pr merge <PR_NUMBER> --squash
After merge succeeds, delete the remote branch: git push origin --delete <BRANCH_NAME>

STRUCTURED RESULT MARKER (REQUIRED):
You MUST include a structured result marker in your final output message.
The orchestrator parses your output to determine whether to promote or reject the issue.
Without this marker, the issue status will NOT be updated automatically.
- On acceptance pass: Include <!-- WORK_RESULT:passed --> in your final message
- On acceptance fail: Include <!-- WORK_RESULT:failed --> in your final message${LINEAR_CLI_INSTRUCTION}`
      break

    case 'refinement':
      basePrompt = `Refine ${identifier} based on rejection feedback.
Read the rejection comments, identify required changes,
update the issue description with refined requirements,
then return to Backlog for re-implementation.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'refinement-coordination':
      basePrompt = `Coordinate refinement across sub-issues for parent issue ${identifier}.

WORKFLOW:
1. Read the QA/acceptance failure comments on ${identifier} to identify which sub-issues failed and why
2. Fetch sub-issues: pnpm af-linear list-sub-issues ${identifier}
3. For each FAILING sub-issue:
   a. Update its description with the specific failure feedback from the QA/acceptance report
   b. Move it back to Backlog: pnpm af-linear update-sub-issue <id> --state Backlog --comment "Refinement: <failure summary>"
4. Leave PASSING sub-issues in their current state (Finished) — do not re-run them
5. Once all failing sub-issues are updated, the parent issue will be moved to Backlog by the orchestrator,
   which will trigger a coordination agent that picks up only the Backlog sub-issues for re-implementation.

IMPORTANT CONSTRAINTS:
- This is a REFINEMENT task — do NOT implement fixes yourself, only triage and route feedback to sub-issues.
- NEVER run pnpm af-linear update-issue --state on the parent issue. The orchestrator manages parent status transitions.
- Only use pnpm af-linear for: list-sub-issues, list-sub-issue-statuses, get-issue, list-comments, create-comment, update-sub-issue${LINEAR_CLI_INSTRUCTION}`
      break

    case 'merge':
      basePrompt = `Handle merge queue operations for ${identifier}.
Check PR merge readiness (CI status, approvals).
Attempt rebase onto latest main.
Resolve conflicts using mergiraf-enhanced git merge if available.
Push updated branch and trigger merge via configured merge queue provider.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'security':
      basePrompt = `Security scan ${identifier}.
Run security scanning tools (SAST, dependency audit) against the codebase and output structured results.

WORKFLOW:
1. Identify the project type (Node.js, Python, etc.) by inspecting package.json, requirements.txt, etc.
2. Run appropriate scanners (semgrep for SAST, npm-audit/pip-audit for dependencies)
3. Parse scanner outputs and produce structured JSON summaries
4. Output results in fenced code blocks tagged \`security-scan-result\`

IMPORTANT CONSTRAINTS:
- This is READ-ONLY scanning — do NOT make code changes, git commits, or fix vulnerabilities yourself.
- If critical or high severity issues found, emit <!-- WORK_RESULT:failed -->.
- If only medium/low or no issues found, emit <!-- WORK_RESULT:passed -->.
- If a scanner is not available, skip it and note this in your output.

STRUCTURED RESULT MARKER (REQUIRED):
You MUST include a structured result marker in your final output message.
- On pass: Include <!-- WORK_RESULT:passed --> in your final message
- On fail: Include <!-- WORK_RESULT:failed --> in your final message${LINEAR_CLI_INSTRUCTION}`
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

WORKFLOW:
1. List recent sessions: pnpm af-linear list-issues --project ${identifier} --status "Accepted,Rejected" --limit 20
2. Read each issue and its comments.
3. Cluster by failure mode. Only clusters of 3+ cases become meta-issues.
4. Author one meta-issue per cluster (at most 5 total).
5. Emit WORK_RESULT:passed when done.

STRUCTURED RESULT MARKER (REQUIRED):
- On completion: Include <!-- WORK_RESULT:passed --> in your final message
- On failure: Include <!-- WORK_RESULT:failed --> in your final message${LINEAR_CLI_INSTRUCTION}`
      break

    case 'outcome-auditor':
      basePrompt = `Run outcome audit: verify recently accepted issues delivered their stated intent.

WORKFLOW:
1. List recently accepted issues: pnpm af-linear list-issues --project ${identifier} --status Accepted --limit 20
2. For each issue: read AC, find merged PR via git log, diff PR against AC.
3. For gaps (missed/deferred/incorrect work): create a standalone follow-up issue in Backlog.
   - NEVER use --parentId (Principle 1: sub-issues are reserved for human intent).
   - Reference source issue in description; add blocks relation if gap blocks further use.
   - Tag source issue: pnpm af-linear update-issue <id> --labels "audit:has-followups"
4. For clean issues: pnpm af-linear update-issue <id> --labels "audit:clean"
   Post comment: "Audit pass: no gaps detected."

STRUCTURED RESULT MARKER (REQUIRED):
- On success: Include <!-- WORK_RESULT:passed --> in your final message
- On failure (no issues to audit, PRs missing): Include <!-- WORK_RESULT:failed -->${LINEAR_CLI_INSTRUCTION}`
      break

    case 'backlog-groomer':
      // PM agent (012 Archetype 3 — Ralph Wiggum loop). One issue per invocation.
      // The TemplateRegistry-based prompt is the canonical path; this legacy
      // function is a fallback for environments that haven't migrated to templates.
      basePrompt = `Groom icebox issue ${identifier}.
Read the issue, evaluate its relevance, and apply exactly one disposition:
- discard: add label pm:discard, post comment, close issue.
- refine: add label pm:needs-refine, post comment describing what needs refinement.
- escalate-human: add label pm:needs-human-decision, post comment describing the decision needed.
If the issue is older than 60 days with no recent activity, also add label pm:stale.
NEVER create sub-issues (Principle 1). Process this one issue only.${LINEAR_CLI_INSTRUCTION}`
      break

    case 'documentation-steward':
      // PM agent (012 Archetype 7 — Documentation Steward). Maintains docs alongside code.
      // The TemplateRegistry-based prompt is the canonical path; this legacy
      // function is a fallback for environments that haven't migrated to templates.
      basePrompt = `Run documentation steward scan for ${identifier}.

WORKFLOW:
1. Enumerate all Markdown files in the repo.
2. Cross-reference API/symbol mentions in docs against current codebase.
3. Identify public surfaces without documentation.
4. Check recent PRs for code changes not accompanied by doc updates.
5. Author standalone refinement issues for each gap.
   - NEVER use --parentId (Principle 1: sub-issues are reserved for human intent).
6. Post a summary comment on ${identifier} with counts and issue IDs.

HARD RULES:
- NEVER create sub-issues (--parentId is forbidden).
- Direct PRs only for typo-class fixes when tenant policy allows.
- Complex gaps always become standalone refinement issues.

STRUCTURED RESULT MARKER (REQUIRED):
- On completion: Include <!-- WORK_RESULT:passed --> in your final message
- On failure (repo inaccessible, no docs): Include <!-- WORK_RESULT:failed -->${LINEAR_CLI_INSTRUCTION}`
      break

    case 'ga-readiness':
      // PM agent (012 Archetype 5 — GA-Readiness Assessor). Runs before production promotion.
      // The TemplateRegistry-based prompt is the canonical path; this legacy
      // function is a fallback for environments that haven't migrated to templates.
      basePrompt = `Assess GA readiness for feature ${identifier}.

WORKFLOW:
1. Read the feature epic: pnpm af-linear get-issue ${identifier}
2. List accepted issues: pnpm af-linear list-issues --label "${identifier}" --status Accepted
3. For each accepted issue: verify all AC items were delivered in the merged PR.
4. Run Architectural Intelligence drift check: pnpm af-ai assess --paths "<code paths>"
5. Check observability: search for HookBus emissions and metrics in touched paths.
6. Security review: PENDING 010-security-architecture.md — note as manual check.
7. Post a structured GA-readiness report as a comment on the feature epic.
8. For each gap found: create a standalone blocker issue and add a blocks relation.

HARD RULES:
- NEVER use --parentId (Principle 1: sub-issues are reserved for human intent).
- Author blocker issues, not sub-issues. Use: pnpm af-linear add-relation <BLOCKER_ID> ${identifier} --type blocks
- The GA-readiness report is a COMMENT, not a new issue.

STRUCTURED RESULT MARKER (REQUIRED):
- All checks pass (no blockers): Include <!-- WORK_RESULT:passed --> in your final message
- Any blockers found: Include <!-- WORK_RESULT:failed --> in your final message${LINEAR_CLI_INSTRUCTION}`
      break

    case 'operational-scanner-vercel':
      // PM agent (012 Archetype 6 — Vercel scanner)..
      // Live Vercel binding is mocked pending a Vercel plugin.
      // The TemplateRegistry-based prompt is the canonical path; this legacy
      // function is a fallback for environments that haven't migrated to templates.
      basePrompt = `Run Vercel operational scan.

WORKFLOW:
1. Query Vercel deploy logs for the configured time window (mock source pending).
2. Cluster by failure type: deploy failures, function timeouts, cold-start regressions.
3. Dedupe against existing Linear issues (search by vercel-deploy-id).
4. For each new cluster: create a standalone bug-report issue with provenance tags.

HARD RULES:
- NEVER use --parentId (Principle 1: sub-issues are reserved for human intent).
- Cap issues per scan at 10 (default).
- Tag issues: bug, source:vercel, provenance:scan-<runId>.

STRUCTURED RESULT MARKER (REQUIRED):
- On completion: Include <!-- WORK_RESULT:passed --> in your final message
- On scan error: Include <!-- WORK_RESULT:failed --> in your final message${LINEAR_CLI_INSTRUCTION}`
      break

    case 'operational-scanner-audit':
      // PM agent (012 Archetype 6 — Audit scanner)..
      // The TemplateRegistry-based prompt is the canonical path; this legacy
      // function is a fallback for environments that haven't migrated to templates.
      basePrompt = `Run audit-chain operational scan (006 Seam 6).

WORKFLOW:
1. Query audit chain entries for the configured time window.
2. Cluster by anomaly type: missing entries, broken chains, unexpected actors, out-of-order events.
3. Dedupe against existing Linear issues (search by audit-event-id).
4. For each new cluster: create a standalone bug-report issue with provenance tags.

HARD RULES:
- NEVER use --parentId (Principle 1: sub-issues are reserved for human intent).
- Cap issues per scan at 10 (default).
- Tag issues: bug, source:audit, provenance:scan-<runId>.

STRUCTURED RESULT MARKER (REQUIRED):
- On completion: Include <!-- WORK_RESULT:passed --> in your final message
- On scan error: Include <!-- WORK_RESULT:failed --> in your final message${LINEAR_CLI_INSTRUCTION}`
      break

    case 'operational-scanner-ci':
      // PM agent (012 Archetype 6 — CI scanner)..
      // The TemplateRegistry-based prompt is the canonical path; this legacy
      // function is a fallback for environments that haven't migrated to templates.
      basePrompt = `Run CI operational scan.

WORKFLOW:
1. Query CI run logs for the configured time window.
2. Cluster by signal type: flaky tests, slow steps, optimization opportunities.
3. Dedupe against existing Linear issues (search by ci-run-id + test-name).
4. For each new cluster: create a standalone bug-report or improvement issue with provenance.

HARD RULES:
- NEVER use --parentId (Principle 1: sub-issues are reserved for human intent).
- Cap issues per scan at 10 (default).
- Tag issues: source:ci, provenance:scan-<runId>; bug for flaky tests, chore for optimizations.

STRUCTURED RESULT MARKER (REQUIRED):
- On completion: Include <!-- WORK_RESULT:passed --> in your final message
- On scan error: Include <!-- WORK_RESULT:failed --> in your final message${LINEAR_CLI_INSTRUCTION}`
      break
  }

  // Inject workflow failure context for retries
  if (options?.failureContext) {
    basePrompt += options.failureContext
  }

  if (options?.mentionContext) {
    return `${basePrompt}\n\nAdditional context from the user's mention:\n${options.mentionContext}`
  }
  return basePrompt
}