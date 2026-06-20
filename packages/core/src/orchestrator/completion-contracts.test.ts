import { describe, it, expect } from 'vitest'
import {
  getCompletionContract,
  validateCompletion,
  formatMissingFields,
  type SessionOutputs,
} from './completion-contracts.js'

describe('getCompletionContract', () => {
  it('returns a contract for development work type', () => {
    const contract = getCompletionContract('development')
    expect(contract).toBeDefined()
    expect(contract!.workType).toBe('development')
    expect(contract!.required.map(f => f.type)).toContain('pr_url')
    expect(contract!.required.map(f => f.type)).toContain('branch_pushed')
    expect(contract!.required.map(f => f.type)).toContain('commits_present')
  })

  it('returns a contract for qa work type', () => {
    const contract = getCompletionContract('qa')
    expect(contract).toBeDefined()
    expect(contract!.required.map(f => f.type)).toContain('work_result')
    expect(contract!.required.map(f => f.type)).toContain('comment_posted')
  })

  it('returns a contract for acceptance work type', () => {
    const contract = getCompletionContract('acceptance')
    expect(contract).toBeDefined()
    const required = contract!.required.map(f => f.type)
    expect(required).toContain('work_result')
    // Acceptance must also resolve the PR (merged directly). Prior contract
    // let WORK_RESULT:passed alone satisfy the gate, leaving PRs open
    // indefinitely after Accepted.
    expect(required).toContain('pr_merged_or_enqueued')
  })


  it('returns a contract for refinement work type', () => {
    const contract = getCompletionContract('refinement')
    expect(contract).toBeDefined()
    expect(contract!.required.map(f => f.type)).toContain('comment_posted')
  })

  it('returns a contract for research work type', () => {
    const contract = getCompletionContract('research')
    expect(contract).toBeDefined()
    expect(contract!.required.map(f => f.type)).toContain('issue_updated')
  })

  it('returns a contract for backlog-creation work type', () => {
    const contract = getCompletionContract('backlog-creation')
    expect(contract).toBeDefined()
    expect(contract!.required.map(f => f.type)).toContain('sub_issues_created')
  })

  it('returns a contract for development work type (which handles coordinator behavior)', () => {
    const contract = getCompletionContract('development')
    expect(contract).toBeDefined()
    const required = contract!.required.map(f => f.type)
    expect(required).toContain('pr_url')
    expect(required).toContain('branch_pushed')
    expect(required).toContain('commits_present')
  })

  it('returns a contract for merge work type', () => {
    const contract = getCompletionContract('merge')
    expect(contract).toBeDefined()
    expect(contract!.required.map(f => f.type)).toContain('pr_merged')
  })

  it('returns contract for refinement-coordination', () => {
    expect(getCompletionContract('refinement-coordination')).toBeDefined()
  })
})

describe('validateCompletion', () => {
  it('marks satisfied when all required fields present (development)', () => {
    const contract = getCompletionContract('development')!
    const outputs: SessionOutputs = {
      prUrl: 'https://github.com/org/repo/pull/1',
      branchPushed: true,
      commitsPresent: true,
    }
    const result = validateCompletion(contract, outputs)
    expect(result.satisfied).toBe(true)
    expect(result.missingFields).toHaveLength(0)
  })

  it('detects missing PR URL (development)', () => {
    const contract = getCompletionContract('development')!
    const outputs: SessionOutputs = {
      branchPushed: true,
      commitsPresent: true,
    }
    const result = validateCompletion(contract, outputs)
    expect(result.satisfied).toBe(false)
    expect(result.missingFields).toContain('pr_url')
    expect(result.backstopRecoverable).toContain('pr_url')
  })

  it('detects missing branch push (development)', () => {
    const contract = getCompletionContract('development')!
    const outputs: SessionOutputs = {
      prUrl: 'https://github.com/org/repo/pull/1',
      branchPushed: false,
      commitsPresent: true,
    }
    const result = validateCompletion(contract, outputs)
    expect(result.satisfied).toBe(false)
    expect(result.missingFields).toContain('branch_pushed')
    expect(result.backstopRecoverable).toContain('branch_pushed')
  })

  it('marks commits_present as backstop-capable', () => {
    const contract = getCompletionContract('development')!
    const outputs: SessionOutputs = {
      prUrl: 'https://github.com/org/repo/pull/1',
      branchPushed: true,
      commitsPresent: false,
    }
    const result = validateCompletion(contract, outputs)
    expect(result.satisfied).toBe(false)
    expect(result.backstopRecoverable).toContain('commits_present')
    expect(result.manualRequired).not.toContain('commits_present')
  })

  it('marks satisfied for QA with work result passed', () => {
    const contract = getCompletionContract('qa')!
    const outputs: SessionOutputs = {
      workResult: 'passed',
      commentPosted: true,
    }
    const result = validateCompletion(contract, outputs)
    expect(result.satisfied).toBe(true)
  })

  it('marks satisfied for QA with work result failed', () => {
    const contract = getCompletionContract('qa')!
    const outputs: SessionOutputs = {
      workResult: 'failed',
      commentPosted: true,
    }
    const result = validateCompletion(contract, outputs)
    expect(result.satisfied).toBe(true)
  })

  it('marks unsatisfied for QA with unknown work result', () => {
    const contract = getCompletionContract('qa')!
    const outputs: SessionOutputs = {
      workResult: 'unknown',
      commentPosted: true,
    }
    const result = validateCompletion(contract, outputs)
    expect(result.satisfied).toBe(false)
    expect(result.missingFields).toContain('work_result')
    expect(result.manualRequired).toContain('work_result')
  })

  it('marks unsatisfied for QA without comment', () => {
    const contract = getCompletionContract('qa')!
    const outputs: SessionOutputs = {
      workResult: 'passed',
      commentPosted: false,
    }
    const result = validateCompletion(contract, outputs)
    expect(result.satisfied).toBe(false)
    expect(result.missingFields).toContain('comment_posted')
  })

  it('marks satisfied for refinement with comment posted', () => {
    const contract = getCompletionContract('refinement')!
    const outputs: SessionOutputs = {
      commentPosted: true,
    }
    const result = validateCompletion(contract, outputs)
    expect(result.satisfied).toBe(true)
  })

  it('marks satisfied for backlog-creation with sub-issues', () => {
    const contract = getCompletionContract('backlog-creation')!
    const outputs: SessionOutputs = {
      subIssuesCreated: true,
    }
    const result = validateCompletion(contract, outputs)
    expect(result.satisfied).toBe(true)
  })

  it('handles empty outputs gracefully', () => {
    const contract = getCompletionContract('development')!
    const outputs: SessionOutputs = {}
    const result = validateCompletion(contract, outputs)
    expect(result.satisfied).toBe(false)
    expect(result.missingFields).toHaveLength(3)
  })
})

describe('formatMissingFields', () => {
  it('formats satisfied contract', () => {
    const contract = getCompletionContract('development')!
    const validation = validateCompletion(contract, {
      prUrl: 'https://github.com/org/repo/pull/1',
      branchPushed: true,
      commitsPresent: true,
    })
    const message = formatMissingFields(contract, validation)
    expect(message).toContain('All required outputs are present')
  })

  it('formats missing fields with recovery info', () => {
    const contract = getCompletionContract('development')!
    const validation = validateCompletion(contract, {
      commitsPresent: true,
    })
    const message = formatMissingFields(contract, validation)
    expect(message).toContain('Missing required outputs')
    expect(message).toContain('auto-recoverable')
    expect(message).toContain('Pull request URL')
    expect(message).toContain('Branch pushed to remote')
  })

  it('formats manual-required fields', () => {
    const contract = getCompletionContract('qa')!
    const validation = validateCompletion(contract, {})
    const message = formatMissingFields(contract, validation)
    expect(message).toContain('requires manual action')
  })
})

describe('acceptance pr_merged_or_enqueued field', () => {
  const contract = getCompletionContract('acceptance')!

  it('workResult:passed alone is insufficient — PR must be merged', () => {
    const validation = validateCompletion(contract, { workResult: 'passed' })
    expect(validation.satisfied).toBe(false)
    expect(validation.missingFields).toContain('pr_merged_or_enqueued')
  })

  it('workResult:passed + prMerged:true satisfies the contract', () => {
    const validation = validateCompletion(contract, {
      workResult: 'passed',
      prMerged: true,
    })
    expect(validation.satisfied).toBe(true)
  })

  it('workResult:failed alone is insufficient (still missing pr resolution)', () => {
    const validation = validateCompletion(contract, { workResult: 'failed' })
    // 'failed' counts as a decision for work_result, but pr_merged_or_enqueued
    // is still missing. Policy: a failed acceptance should also resolve the
    // PR (e.g., close it, or leave it open for refinement) — the caller must
    // decide. The contract surfaces the gap.
    expect(validation.satisfied).toBe(false)
    expect(validation.missingFields).toContain('pr_merged_or_enqueued')
  })

  it('pr_merged_or_enqueued is not backstop-capable (requires caller signal)', () => {
    const validation = validateCompletion(contract, { workResult: 'passed' })
    expect(validation.backstopRecoverable).not.toContain('pr_merged_or_enqueued')
    expect(validation.manualRequired).toContain('pr_merged_or_enqueued')
  })
})
