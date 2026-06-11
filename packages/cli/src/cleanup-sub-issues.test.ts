/**
 * Tests for the sub-issue cleanup utility (REN-1323)
 *
 * All Linear I/O is mocked via the LinearClientInterface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isTitleDecomposeNoise,
  wordOverlapSimilarity,
  renderMarkdownReport,
  runCleanupSubIssues,
  type LinearClientInterface,
  type LinearIssue,
  type CleanupReport,
} from './cleanup-sub-issues.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: overrides.id ?? 'issue-1',
    identifier: overrides.identifier ?? 'REN-100',
    title: overrides.title ?? 'Some issue',
    description: overrides.description ?? 'Description text here',
    status: overrides.status ?? 'In Progress',
    createdAt: overrides.createdAt ?? Date.now(),
    parentId: overrides.parentId,
    childCount: overrides.childCount ?? 0,
    labels: overrides.labels ?? [],
    authorId: overrides.authorId,
    hasLinkedResources: overrides.hasLinkedResources,
    editedByHuman: overrides.editedByHuman,
  }
}

function makeClient(overrides: Partial<LinearClientInterface> = {}): LinearClientInterface {
  return {
    listProjectIssues: vi.fn().mockResolvedValue([]),
    getIssueFull: vi.fn().mockResolvedValue({
      id: 'issue-1',
      identifier: 'REN-100',
      title: 'Some issue',
      description: null,
      authorId: undefined,
      hasLinkedResources: false,
      editedByHuman: false,
      labels: [],
    }),
    closeIssue: vi.fn().mockResolvedValue(undefined),
    detachFromParent: vi.fn().mockResolvedValue(undefined),
    addLabel: vi.fn().mockResolvedValue(undefined),
    hasLabel: vi.fn().mockResolvedValue(false),
    createComment: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Unit: isTitleDecomposeNoise
// ---------------------------------------------------------------------------

describe('isTitleDecomposeNoise', () => {
  it('matches "Part 1 of 3" style titles', () => {
    expect(isTitleDecomposeNoise('Part 1 of 3: Set up database')).toBe(true)
    expect(isTitleDecomposeNoise('Part 2 of 5')).toBe(true)
  })

  it('matches "Phase A:" style titles', () => {
    expect(isTitleDecomposeNoise('Phase A: Initial setup')).toBe(true)
    expect(isTitleDecomposeNoise('Phase 1: Research')).toBe(true)
  })

  it('matches "Step 1 -" and "Step 1:" patterns', () => {
    expect(isTitleDecomposeNoise('Step 1 - Configure the server')).toBe(true)
    expect(isTitleDecomposeNoise('Step 2: Deploy to staging')).toBe(true)
  })

  it('matches "(sub-task)" and "(subtask)" suffixes', () => {
    expect(isTitleDecomposeNoise('Add authentication (sub-task)')).toBe(true)
    expect(isTitleDecomposeNoise('Implement feature (subtask)')).toBe(true)
  })

  it('matches "Task N:" pattern', () => {
    expect(isTitleDecomposeNoise('Task 3: Write unit tests')).toBe(true)
  })

  it('matches "Sub-task" prefix', () => {
    expect(isTitleDecomposeNoise('Sub-task 1: Do the thing')).toBe(true)
    expect(isTitleDecomposeNoise('Subtask: handle edge case')).toBe(true)
  })

  it('does NOT match normal issue titles', () => {
    expect(isTitleDecomposeNoise('Add user authentication')).toBe(false)
    expect(isTitleDecomposeNoise('Fix flaky test in governor')).toBe(false)
    expect(isTitleDecomposeNoise('Refactor database layer')).toBe(false)
    expect(isTitleDecomposeNoise('Implement REN-1323 cleanup utility')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unit: wordOverlapSimilarity
// ---------------------------------------------------------------------------

describe('wordOverlapSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    const s = 'implement the database migration logic'
    expect(wordOverlapSimilarity(s, s)).toBe(1)
  })

  it('returns 0 for completely different strings', () => {
    expect(wordOverlapSimilarity('foo bar baz', 'alpha beta gamma')).toBe(0)
  })

  it('returns 0 for empty strings', () => {
    expect(wordOverlapSimilarity('', '')).toBe(0)
    expect(wordOverlapSimilarity('hello world', '')).toBe(0)
  })

  it('returns high similarity for near-duplicate text', () => {
    const a = 'Implement the authentication module with OAuth2 support and JWT tokens'
    const b = 'Implement the authentication module with OAuth2 support and JWT token validation'
    expect(wordOverlapSimilarity(a, b)).toBeGreaterThan(0.7)
  })

  it('returns low similarity for loosely related text', () => {
    const a = 'Set up CI/CD pipeline for deployment'
    const b = 'Add unit tests for the user profile component'
    expect(wordOverlapSimilarity(a, b)).toBeLessThan(0.3)
  })

  it('is case-insensitive', () => {
    expect(wordOverlapSimilarity('Hello World', 'hello world')).toBe(1)
  })

  it('ignores short words (length <= 2)', () => {
    // "is", "a", "to" are all short — only "long" words matter
    const sim = wordOverlapSimilarity('this is a test', 'this is a quiz')
    expect(sim).toBeLessThan(1) // "test" vs "quiz" differ
  })
})

// ---------------------------------------------------------------------------
// Unit: renderMarkdownReport
// ---------------------------------------------------------------------------

describe('renderMarkdownReport', () => {
  const emptyReport: CleanupReport = {
    project: 'MyProject',
    scannedParents: 5,
    scannedSubIssues: 10,
    alreadyProcessed: 2,
    toClose: [],
    toDetach: [],
    dryRun: true,
  }

  it('includes project name in heading', () => {
    const md = renderMarkdownReport(emptyReport)
    expect(md).toContain('MyProject')
  })

  it('reports scan stats', () => {
    const md = renderMarkdownReport(emptyReport)
    expect(md).toContain('5')
    expect(md).toContain('10')
    expect(md).toContain('already processed')
  })

  it('reports "Nothing to clean up" when empty', () => {
    const md = renderMarkdownReport(emptyReport)
    expect(md).toContain('Nothing to clean up')
  })

  it('shows decompose-noise table when issues to close', () => {
    const report: CleanupReport = {
      ...emptyReport,
      toClose: [
        {
          issueId: 'id-1',
          identifier: 'REN-101',
          title: 'Part 1 of 3: Setup',
          parentId: 'parent-1',
          parentIdentifier: 'REN-100',
          parentTitle: 'Setup project',
          parentStatus: 'Done',
          status: 'Done',
          authorId: 'bot-user-id',
          isAgentAuthored: true,
          titlePatternMatch: true,
          descriptionSimilarity: 0.8,
          disposition: 'decompose-noise',
          reasoning: ['Title matches decompose pattern', 'Author ID matches known agent bot'],
        },
      ],
    }
    const md = renderMarkdownReport(report)
    expect(md).toContain('Decompose-noise')
    expect(md).toContain('REN-101')
    expect(md).toContain('Part 1 of 3')
    expect(md).toContain('REN-100')
  })

  it('shows worth-keeping table when issues to detach', () => {
    const report: CleanupReport = {
      ...emptyReport,
      toDetach: [
        {
          issueId: 'id-2',
          identifier: 'REN-102',
          title: 'Fix edge case in parser',
          parentId: 'parent-1',
          parentIdentifier: 'REN-100',
          parentTitle: 'Parser overhaul',
          parentStatus: 'Done',
          status: 'Done',
          authorId: 'bot-user-id',
          isAgentAuthored: true,
          titlePatternMatch: false,
          descriptionSimilarity: 0.1,
          disposition: 'worth-keeping',
          reasoning: ['Sub-issue was edited by a human after creation'],
        },
      ],
    }
    const md = renderMarkdownReport(report)
    expect(md).toContain('Worth-keeping')
    expect(md).toContain('REN-102')
  })

  it('includes dry-run note when dryRun is true', () => {
    const md = renderMarkdownReport({ ...emptyReport, toClose: [emptyReport.toClose[0] ?? { issueId: 'x', identifier: 'X', title: 'T', parentId: 'p', parentIdentifier: 'P', parentTitle: 'PT', parentStatus: 'Done', status: 'Done', authorId: undefined, isAgentAuthored: false, titlePatternMatch: false, descriptionSimilarity: 0, disposition: 'decompose-noise', reasoning: [] }] })
    expect(md).toContain('Dry-run')
  })
})

// ---------------------------------------------------------------------------
// Integration: runCleanupSubIssues
// ---------------------------------------------------------------------------

describe('runCleanupSubIssues — no sub-issues', () => {
  it('returns empty report when project has no sub-issues', async () => {
    const client = makeClient({
      listProjectIssues: vi.fn().mockResolvedValue([
        makeIssue({ id: 'parent-1', identifier: 'REN-10', title: 'Parent' }),
      ]),
    })

    const report = await runCleanupSubIssues({
      project: 'TestProject',
      dryRun: true,
      apply: false,
      linearClient: client,
    })

    expect(report.scannedSubIssues).toBe(0)
    expect(report.toClose).toHaveLength(0)
    expect(report.toDetach).toHaveLength(0)
  })
})

describe('runCleanupSubIssues — heuristic classification', () => {
  it('classifies a title-matching agent-authored sub-issue as decompose-noise', async () => {
    const parent = makeIssue({
      id: 'parent-1',
      identifier: 'REN-10',
      title: 'Implement auth',
      description: 'Implement authentication module with OAuth2',
      status: 'Done',
    })
    const sub = makeIssue({
      id: 'sub-1',
      identifier: 'REN-11',
      title: 'Part 1 of 3: Setup OAuth2',
      description: 'Implement authentication module with OAuth2 step one',
      status: 'Done',
      parentId: 'parent-1',
    })

    const client = makeClient({
      listProjectIssues: vi.fn().mockResolvedValue([parent, sub]),
      getIssueFull: vi.fn().mockResolvedValue({
        id: 'sub-1',
        identifier: 'REN-11',
        title: sub.title,
        description: sub.description,
        authorId: 'known-bot-id',
        hasLinkedResources: false,
        editedByHuman: false,
        labels: [],
      }),
    })

    const report = await runCleanupSubIssues({
      project: 'TestProject',
      dryRun: true,
      apply: false,
      linearClient: client,
      agentAuthorsConfigPath: '/nonexistent/.donmai/known-agent-authors.json',
      // Provide a config path that won't exist — so agentUserIds is empty by default
      // But authorId=known-bot-id won't be in agentUserIds, so author heuristic won't fire.
      // The title match + description similarity should still score >= 2.
    })

    // Title match (2) + description similarity > 0.5 (1) = 3 → decompose-noise
    expect(report.toClose.length + report.toDetach.length).toBeGreaterThanOrEqual(1)
    // Title match alone is 2 points → decompose-noise
    const allRows = [...report.toClose, ...report.toDetach]
    const row = allRows.find((r) => r.identifier === 'REN-11')
    expect(row).toBeDefined()
    expect(row?.disposition).toBe('decompose-noise')
  })

  it('classifies a sub-issue with linked resources as worth-keeping', async () => {
    const parent = makeIssue({
      id: 'parent-1',
      identifier: 'REN-10',
      title: 'Implement auth',
      status: 'Done',
    })
    const sub = makeIssue({
      id: 'sub-1',
      identifier: 'REN-11',
      title: 'Part 1 of 3: Setup OAuth2',
      status: 'Done',
      parentId: 'parent-1',
    })

    const client = makeClient({
      listProjectIssues: vi.fn().mockResolvedValue([parent, sub]),
      getIssueFull: vi.fn().mockResolvedValue({
        id: 'sub-1',
        identifier: 'REN-11',
        title: sub.title,
        description: null,
        authorId: 'known-bot-id',
        hasLinkedResources: true, // Has PR linked!
        editedByHuman: false,
        labels: [],
      }),
    })

    const report = await runCleanupSubIssues({
      project: 'TestProject',
      dryRun: true,
      apply: false,
      linearClient: client,
    })

    const row = report.toDetach.find((r) => r.identifier === 'REN-11')
    expect(row).toBeDefined()
    expect(row?.disposition).toBe('worth-keeping')
  })

  it('classifies a human-edited sub-issue as worth-keeping even with noisy title', async () => {
    const parent = makeIssue({ id: 'parent-1', identifier: 'REN-10', title: 'Parent', status: 'Done' })
    const sub = makeIssue({
      id: 'sub-1',
      identifier: 'REN-11',
      title: 'Sub-task 2: Handle edge case',
      status: 'Done',
      parentId: 'parent-1',
    })

    const client = makeClient({
      listProjectIssues: vi.fn().mockResolvedValue([parent, sub]),
      getIssueFull: vi.fn().mockResolvedValue({
        id: 'sub-1',
        identifier: 'REN-11',
        title: sub.title,
        description: null,
        authorId: 'bot-id',
        hasLinkedResources: false,
        editedByHuman: true, // Edited by human
        labels: [],
      }),
    })

    const report = await runCleanupSubIssues({
      project: 'TestProject',
      dryRun: true,
      apply: false,
      linearClient: client,
    })

    const row = report.toDetach.find((r) => r.identifier === 'REN-11')
    expect(row?.disposition).toBe('worth-keeping')
    expect(row?.reasoning[0]).toContain('edited by a human')
  })

  it('skips issues with cleanup:processed label (idempotency)', async () => {
    const parent = makeIssue({ id: 'parent-1', identifier: 'REN-10', title: 'Parent', status: 'Done' })
    const sub = makeIssue({
      id: 'sub-1',
      identifier: 'REN-11',
      title: 'Part 1 of 3: Already cleaned',
      status: 'Done',
      parentId: 'parent-1',
      labels: ['cleanup:processed'],
    })

    const client = makeClient({
      listProjectIssues: vi.fn().mockResolvedValue([parent, sub]),
      getIssueFull: vi.fn().mockResolvedValue({
        id: 'sub-1',
        identifier: 'REN-11',
        title: sub.title,
        description: null,
        authorId: undefined,
        hasLinkedResources: false,
        editedByHuman: false,
        labels: ['cleanup:processed'],
      }),
    })

    const report = await runCleanupSubIssues({
      project: 'TestProject',
      dryRun: true,
      apply: false,
      linearClient: client,
    })

    expect(report.alreadyProcessed).toBe(1)
    expect(report.toClose).toHaveLength(0)
    expect(report.toDetach).toHaveLength(0)
  })
})

describe('runCleanupSubIssues — apply mode', () => {
  it('calls closeIssue for decompose-noise issues when apply=true', async () => {
    const parent = makeIssue({ id: 'parent-1', identifier: 'REN-10', title: 'Parent', status: 'Done' })
    const sub = makeIssue({
      id: 'sub-1',
      identifier: 'REN-11',
      title: 'Step 1: Do something',
      status: 'Done',
      parentId: 'parent-1',
    })

    const closeIssue = vi.fn().mockResolvedValue(undefined)
    const client = makeClient({
      listProjectIssues: vi.fn().mockResolvedValue([parent, sub]),
      getIssueFull: vi.fn().mockResolvedValue({
        id: 'sub-1',
        identifier: 'REN-11',
        title: sub.title,
        description: null,
        authorId: undefined,
        hasLinkedResources: false,
        editedByHuman: false,
        labels: [],
      }),
      closeIssue,
    })

    await runCleanupSubIssues({
      project: 'TestProject',
      dryRun: false,
      apply: true,
      linearClient: client,
    })

    expect(closeIssue).toHaveBeenCalledWith('sub-1', expect.stringContaining('REN-1323 cleanup'))
  })

  it('calls detachFromParent for worth-keeping issues when apply=true', async () => {
    const parent = makeIssue({ id: 'parent-1', identifier: 'REN-10', title: 'Parent', status: 'Done' })
    const sub = makeIssue({
      id: 'sub-1',
      identifier: 'REN-11',
      title: 'Fix unusual edge case in parser',
      status: 'Done',
      parentId: 'parent-1',
    })

    const detachFromParent = vi.fn().mockResolvedValue(undefined)
    const client = makeClient({
      listProjectIssues: vi.fn().mockResolvedValue([parent, sub]),
      getIssueFull: vi.fn().mockResolvedValue({
        id: 'sub-1',
        identifier: 'REN-11',
        title: sub.title,
        description: 'Completely unrelated description about parser edge cases',
        authorId: undefined,
        hasLinkedResources: false,
        editedByHuman: true,
        labels: [],
      }),
      detachFromParent,
    })

    await runCleanupSubIssues({
      project: 'TestProject',
      dryRun: false,
      apply: true,
      linearClient: client,
    })

    expect(detachFromParent).toHaveBeenCalledWith('sub-1', expect.stringContaining('REN-10'))
  })

  it('does NOT call closeIssue or detachFromParent in dry-run mode', async () => {
    const parent = makeIssue({ id: 'parent-1', identifier: 'REN-10', title: 'Parent', status: 'Done' })
    const sub = makeIssue({
      id: 'sub-1',
      identifier: 'REN-11',
      title: 'Step 1: Some step',
      status: 'Done',
      parentId: 'parent-1',
    })

    const closeIssue = vi.fn()
    const detachFromParent = vi.fn()
    const client = makeClient({
      listProjectIssues: vi.fn().mockResolvedValue([parent, sub]),
      getIssueFull: vi.fn().mockResolvedValue({
        id: 'sub-1',
        identifier: 'REN-11',
        title: sub.title,
        description: null,
        authorId: undefined,
        hasLinkedResources: false,
        editedByHuman: false,
        labels: [],
      }),
      closeIssue,
      detachFromParent,
    })

    await runCleanupSubIssues({
      project: 'TestProject',
      dryRun: true,
      apply: false,
      linearClient: client,
    })

    expect(closeIssue).not.toHaveBeenCalled()
    expect(detachFromParent).not.toHaveBeenCalled()
  })
})

describe('runCleanupSubIssues — tracking issue', () => {
  it('posts markdown report as comment on tracking issue in dry-run mode', async () => {
    const parent = makeIssue({ id: 'parent-1', identifier: 'REN-10', title: 'Parent', status: 'Done' })
    const createComment = vi.fn().mockResolvedValue(undefined)
    const client = makeClient({
      listProjectIssues: vi.fn().mockResolvedValue([parent]),
      createComment,
    })

    await runCleanupSubIssues({
      project: 'TestProject',
      dryRun: true,
      apply: false,
      trackingIssueId: 'REN-1323',
      linearClient: client,
    })

    expect(createComment).toHaveBeenCalledWith('REN-1323', expect.stringContaining('Sub-issue Cleanup Report'))
  })
})

describe('runCleanupSubIssues — known agent author IDs', () => {
  it('marks issues as agent-authored when authorId is in known list', async () => {
    const parent = makeIssue({ id: 'parent-1', identifier: 'REN-10', title: 'Parent', status: 'In Progress' })
    const sub = makeIssue({
      id: 'sub-1',
      identifier: 'REN-11',
      title: 'Do the thing',
      status: 'Done',
      parentId: 'parent-1',
    })

    const client = makeClient({
      listProjectIssues: vi.fn().mockResolvedValue([parent, sub]),
      getIssueFull: vi.fn().mockResolvedValue({
        id: 'sub-1',
        identifier: 'REN-11',
        title: sub.title,
        description: null,
        authorId: 'known-bot-uuid',
        hasLinkedResources: false,
        editedByHuman: false,
        labels: [],
      }),
    })

    // Write a temp config with the known author ID
    const { mkdirSync, writeFileSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const tmpDir = join(tmpdir(), `cleanup-test-${Date.now()}`)
    mkdirSync(join(tmpDir, '.donmai'), { recursive: true })
    const configPath = join(tmpDir, '.donmai', 'known-agent-authors.json')
    writeFileSync(configPath, JSON.stringify({ agentUserIds: ['known-bot-uuid'] }))

    try {
      const report = await runCleanupSubIssues({
        project: 'TestProject',
        dryRun: true,
        apply: false,
        linearClient: client,
        agentAuthorsConfigPath: configPath,
      })

      const allRows = [...report.toClose, ...report.toDetach]
      const row = allRows.find((r) => r.identifier === 'REN-11')
      expect(row?.isAgentAuthored).toBe(true)
      // Score = 2 (agent-authored) → decompose-noise
      expect(row?.disposition).toBe('decompose-noise')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
