/**
 * Completion Contracts
 *
 * Typed definitions of what each work type must produce before a session
 * is considered successful. The orchestrator validates these after the
 * agent session ends and runs deterministic backstop actions for any
 * missing fields that can be recovered programmatically.
 *
 * Design principles:
 * - Contracts are provider-agnostic (same expectations regardless of LLM)
 * - Fields marked `backstopCapable` can be filled by deterministic code
 * - Fields not backstop-capable require agent judgment (flagged for follow-up)
 * - Contracts drive both validation AND recovery
 */

import type { AgentWorkType } from './work-types.js'

// ---------------------------------------------------------------------------
// Completion field types
// ---------------------------------------------------------------------------

/** A field the agent session should produce */
export type CompletionFieldType =
  | 'pr_url'                  // GitHub PR URL created for the work
  | 'branch_pushed'           // Branch pushed to remote
  | 'commits_present'         // At least one commit exists on the branch
  | 'work_result'             // Structured pass/fail marker
  | 'issue_updated'           // Issue description was modified
  | 'comment_posted'          // At least one comment was posted to the issue
  | 'sub_issues_created'      // Sub-issues were created (backlog/coordination)
  | 'pr_merged'               // PR was merged to target branch
  | 'pr_merged_or_enqueued'   // PR was merged OR handed to the local merge queue

/** A single required or optional field in a completion contract */
export interface CompletionField {
  type: CompletionFieldType
  /** Human-readable description for diagnostic messages */
  label: string
  /**
   * Whether the orchestrator can fill this field deterministically
   * after the session ends (e.g., push a branch, create a PR).
   * Fields that require agent judgment (work_result) are NOT backstop-capable.
   */
  backstopCapable: boolean
}

// ---------------------------------------------------------------------------
// Completion contract
// ---------------------------------------------------------------------------

export interface CompletionContract {
  workType: AgentWorkType
  /** Fields that MUST be present for the session to be considered complete */
  required: CompletionField[]
  /** Fields that SHOULD be present but won't block completion */
  optional: CompletionField[]
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface CompletionValidationResult {
  /** Whether all required fields are satisfied */
  satisfied: boolean
  /** Required fields that are present */
  presentFields: CompletionFieldType[]
  /** Required fields that are missing */
  missingFields: CompletionFieldType[]
  /** Missing fields that the backstop can fill deterministically */
  backstopRecoverable: CompletionFieldType[]
  /** Missing fields that require agent judgment or manual intervention */
  manualRequired: CompletionFieldType[]
}

// ---------------------------------------------------------------------------
// Session outputs (collected during and after the session)
// ---------------------------------------------------------------------------

/** Structured data extracted from the agent session */
export interface SessionOutputs {
  prUrl?: string
  branchPushed?: boolean
  commitsPresent?: boolean
  workResult?: 'passed' | 'failed' | 'unknown'
  issueUpdated?: boolean
  commentPosted?: boolean
  subIssuesCreated?: boolean
  prMerged?: boolean
}

// ---------------------------------------------------------------------------
// Backstop action record
// ---------------------------------------------------------------------------

/** Record of a deterministic action taken by the backstop */
export interface BackstopAction {
  field: CompletionFieldType
  action: string
  success: boolean
  detail?: string
}

/** Result of running the backstop */
export interface BackstopResult {
  /** Actions the backstop attempted */
  actions: BackstopAction[]
  /** Whether all required fields are now satisfied */
  fullyRecovered: boolean
  /** Fields that still need manual intervention */
  remainingGaps: CompletionFieldType[]
}

// ---------------------------------------------------------------------------
// Shared field definitions (DRY)
// ---------------------------------------------------------------------------

const FIELD = {
  prUrl: {
    type: 'pr_url' as const,
    label: 'Pull request URL',
    backstopCapable: true,
  },
  branchPushed: {
    type: 'branch_pushed' as const,
    label: 'Branch pushed to remote',
    backstopCapable: true,
  },
  commitsPresent: {
    type: 'commits_present' as const,
    label: 'Commits on branch',
    backstopCapable: true,
  },
  workResult: {
    type: 'work_result' as const,
    label: 'Structured work result (passed/failed)',
    backstopCapable: false,
  },
  issueUpdated: {
    type: 'issue_updated' as const,
    label: 'Issue description updated',
    backstopCapable: false,
  },
  commentPosted: {
    type: 'comment_posted' as const,
    label: 'Comment posted to issue',
    backstopCapable: false,
  },
  subIssuesCreated: {
    type: 'sub_issues_created' as const,
    label: 'Sub-issues created',
    backstopCapable: false,
  },
  prMerged: {
    type: 'pr_merged' as const,
    label: 'Pull request merged',
    backstopCapable: false,
  },
  prMergedOrEnqueued: {
    type: 'pr_merged_or_enqueued' as const,
    label: 'Pull request merged',
    // Not backstop-capable: prMerged is set by the external merge path. If
    // the PR is not merged at session-end, the diagnostic comment path is
    // the correct recovery — the backstop has no authority to decide
    // whether a PR should merge.
    backstopCapable: false,
  },
} satisfies Record<string, CompletionField>

// ---------------------------------------------------------------------------
// Per-work-type contract definitions
// ---------------------------------------------------------------------------

const CONTRACTS: Record<string, CompletionContract> = {
  // --- Code-producing work types ---
  development: {
    workType: 'development',
    required: [FIELD.commitsPresent, FIELD.branchPushed, FIELD.prUrl],
    optional: [],
  },
  inflight: {
    workType: 'inflight',
    required: [FIELD.commitsPresent, FIELD.branchPushed, FIELD.prUrl],
    optional: [],
  },

  // --- Result-sensitive work types ---
  qa: {
    workType: 'qa',
    required: [FIELD.workResult, FIELD.commentPosted],
    optional: [],
  },
  acceptance: {
    workType: 'acceptance',
    // acceptance must produce BOTH a pass/fail decision AND a
    // resolution for the PR (merged directly, or handed to the local merge
    // queue). Prior contract only required workResult, so an agent could
    // emit WORK_RESULT:passed, skip the merge, and the issue would auto-
    // promote Delivered → Accepted leaving the PR open indefinitely.
    required: [FIELD.workResult, FIELD.prMergedOrEnqueued],
    optional: [],
  },

  // --- Triage/analysis work types ---
  refinement: {
    workType: 'refinement',
    required: [FIELD.commentPosted],
    optional: [FIELD.issueUpdated],
  },
  'refinement-coordination': {
    workType: 'refinement-coordination',
    required: [FIELD.commentPosted],
    optional: [],
  },
  research: {
    workType: 'research',
    required: [FIELD.issueUpdated],
    optional: [FIELD.commentPosted],
  },

  // --- Issue creation work types ---
  'backlog-creation': {
    workType: 'backlog-creation',
    required: [FIELD.subIssuesCreated],
    optional: [FIELD.commentPosted],
  },

  // --- PM agent work types ---
  // Backlog groomer processes ONE icebox issue per invocation: comment posted
  // records the disposition (discard/refine/escalate-human).
  'backlog-groomer': {
    workType: 'backlog-groomer',
    required: [FIELD.commentPosted],
    optional: [FIELD.issueUpdated],
  },

  // --- Merge work types ---
  merge: {
    workType: 'merge',
    required: [FIELD.prMerged],
    optional: [],
  },

  // Documentation steward scans repo docs, posts a summary comment, and optionally
  // creates refinement issues. A comment_posted is the primary evidence of a completed
  // scan. issue_updated is optional (direct-commit path updates the source issue).
  'documentation-steward': {
    workType: 'documentation-steward',
    required: [FIELD.commentPosted],
    optional: [FIELD.issueUpdated],
  },
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the completion contract for a work type.
 * Returns undefined for unknown work types (caller should treat as no contract).
 */
export function getCompletionContract(workType: AgentWorkType): CompletionContract | undefined {
  return CONTRACTS[workType]
}

/**
 * Validate session outputs against a completion contract.
 */
export function validateCompletion(
  contract: CompletionContract,
  outputs: SessionOutputs
): CompletionValidationResult {
  const presentFields: CompletionFieldType[] = []
  const missingFields: CompletionFieldType[] = []
  const backstopRecoverable: CompletionFieldType[] = []
  const manualRequired: CompletionFieldType[] = []

  for (const field of contract.required) {
    if (isFieldPresent(field.type, outputs)) {
      presentFields.push(field.type)
    } else {
      missingFields.push(field.type)
      if (field.backstopCapable) {
        backstopRecoverable.push(field.type)
      } else {
        manualRequired.push(field.type)
      }
    }
  }

  return {
    satisfied: missingFields.length === 0,
    presentFields,
    missingFields,
    backstopRecoverable,
    manualRequired,
  }
}

/**
 * Check whether a specific field is present in the session outputs.
 */
function isFieldPresent(fieldType: CompletionFieldType, outputs: SessionOutputs): boolean {
  switch (fieldType) {
    case 'pr_url':
      return !!outputs.prUrl
    case 'branch_pushed':
      return !!outputs.branchPushed
    case 'commits_present':
      return !!outputs.commitsPresent
    case 'work_result':
      return outputs.workResult === 'passed' || outputs.workResult === 'failed'
    case 'issue_updated':
      return !!outputs.issueUpdated
    case 'comment_posted':
      return !!outputs.commentPosted
    case 'sub_issues_created':
      return !!outputs.subIssuesCreated
    case 'pr_merged':
      return !!outputs.prMerged
    case 'pr_merged_or_enqueued':
      return !!outputs.prMerged
    default:
      return false
  }
}

/**
 * Format missing fields into a human-readable diagnostic message.
 */
export function formatMissingFields(
  contract: CompletionContract,
  validation: CompletionValidationResult
): string {
  const lines: string[] = [
    `Session completion check for ${contract.workType}:`,
  ]

  if (validation.satisfied) {
    lines.push('All required outputs are present.')
    return lines.join('\n')
  }

  lines.push('')
  lines.push('Missing required outputs:')
  for (const fieldType of validation.missingFields) {
    const field = contract.required.find(f => f.type === fieldType)
    const recoverable = validation.backstopRecoverable.includes(fieldType)
    lines.push(`  - ${field?.label ?? fieldType}${recoverable ? ' (auto-recoverable)' : ' (requires manual action)'}`)
  }

  if (validation.backstopRecoverable.length > 0) {
    lines.push('')
    lines.push(`The orchestrator will attempt to recover ${validation.backstopRecoverable.length} field(s) automatically.`)
  }

  if (validation.manualRequired.length > 0) {
    lines.push('')
    lines.push(`${validation.manualRequired.length} field(s) require manual intervention or re-triggering the agent.`)
  }

  return lines.join('\n')
}
