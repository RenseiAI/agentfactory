import { describe, it, expect } from 'vitest'
import { DecisionEngineAdapter, type DecisionEngineAdapterConfig } from './decision-engine-adapter.js'
import { decideAction, MAX_SESSION_ATTEMPTS, type DecisionContext } from './decision-engine.js'
import { DEFAULT_GOVERNOR_CONFIG, type GovernorConfig, type GovernorIssue } from './governor-types.js'
import type { WorkflowDefinitionV2, NodeDefinition } from '../workflow/workflow-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<GovernorIssue> = {}): GovernorIssue {
  return {
    id: 'issue-1',
    identifier: 'SUP-100',
    title: 'Test Issue',
    description: undefined,
    status: 'Backlog',
    labels: [],
    createdAt: Date.now() - 2 * 60 * 60 * 1000,
    ...overrides,
  }
}

function makeContext(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    issue: makeIssue(),
    config: { ...DEFAULT_GOVERNOR_CONFIG, projects: ['TestProject'] },
    hasActiveSession: false,
    isHeld: false,
    isWithinCooldown: false,
    isParentIssue: false,
    workflowStrategy: undefined,
    researchCompleted: false,
    backlogCreationCompleted: false,
    completedSessionCount: 0,
    ...overrides,
  }
}

function findNode(workflow: WorkflowDefinitionV2, name: string): NodeDefinition | undefined {
  return workflow.nodes?.find(n => n.name === name)
}

// ---------------------------------------------------------------------------
// Basic structure tests
// ---------------------------------------------------------------------------

describe('DecisionEngineAdapter', () => {
  describe('toWorkflowDefinition', () => {
    it('generates a valid WorkflowDefinition v2', () => {
      const workflow = DecisionEngineAdapter.toWorkflowDefinition()
      expect(workflow.apiVersion).toBe('v2')
      expect(workflow.kind).toBe('WorkflowDefinition')
      expect(workflow.metadata.name).toBe('governor-decision-engine')
    })

    it('uses custom workflow name when provided', () => {
      const workflow = DecisionEngineAdapter.toWorkflowDefinition({
        workflowName: 'custom-workflow',
      })
      expect(workflow.metadata.name).toBe('custom-workflow')
    })

    it('includes triggers for Linear events and governor scan', () => {
      const workflow = DecisionEngineAdapter.toWorkflowDefinition()
      expect(workflow.triggers).toHaveLength(2)
      expect(workflow.triggers?.[0].name).toBe('issue-status-change')
      expect(workflow.triggers?.[0].source).toBe('linear')
      expect(workflow.triggers?.[1].name).toBe('governor-scan')
      expect(workflow.triggers?.[1].type).toBe('schedule')
    })

    it('includes agent and linear providers', () => {
      const workflow = DecisionEngineAdapter.toWorkflowDefinition()
      expect(workflow.providers).toHaveLength(2)
      const names = workflow.providers?.map(p => p.name)
      expect(names).toContain('linear')
      expect(names).toContain('agent')
    })

    it('stores governor config values in workflow config', () => {
      const config: GovernorConfig = {
        ...DEFAULT_GOVERNOR_CONFIG,
        enableAutoDevelopment: false,
        enableAutoQA: false,
      }
      const workflow = DecisionEngineAdapter.toWorkflowDefinition({ governorConfig: config })
      expect(workflow.config?.enableAutoDevelopment).toBe(false)
      expect(workflow.config?.enableAutoQA).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Guard nodes
  // ---------------------------------------------------------------------------

  describe('guard nodes', () => {
    const workflow = DecisionEngineAdapter.toWorkflowDefinition()

    it('includes active-session guard', () => {
      const node = findNode(workflow, 'guard-active-session')
      expect(node).toBeDefined()
      expect(node?.when).toContain('hasActiveSession')
    })

    it('includes cooldown guard', () => {
      const node = findNode(workflow, 'guard-cooldown')
      expect(node).toBeDefined()
      expect(node?.when).toContain('isWithinCooldown')
    })

    it('includes hold guard', () => {
      const node = findNode(workflow, 'guard-hold')
      expect(node).toBeDefined()
      expect(node?.when).toContain('isHeld')
    })

    it('includes gate guard', () => {
      const node = findNode(workflow, 'guard-gates')
      expect(node).toBeDefined()
      expect(node?.when).toContain('gateEvaluation')
    })

    it('includes circuit breaker guard', () => {
      const node = findNode(workflow, 'guard-circuit-breaker')
      expect(node).toBeDefined()
      expect(node?.when).toContain(`${MAX_SESSION_ATTEMPTS}`)
    })

    it('includes terminal status guard', () => {
      const node = findNode(workflow, 'guard-terminal-status')
      expect(node).toBeDefined()
      expect(node?.when).toContain('Accepted')
      expect(node?.when).toContain('Canceled')
      expect(node?.when).toContain('Duplicate')
    })

    it('includes sub-issue guard', () => {
      const node = findNode(workflow, 'guard-sub-issue')
      expect(node).toBeDefined()
      expect(node?.when).toContain('parentId')
    })
  })

  // ---------------------------------------------------------------------------
  // Routing nodes
  // ---------------------------------------------------------------------------

  describe('routing nodes', () => {
    it('includes Backlog routing node', () => {
      const workflow = DecisionEngineAdapter.toWorkflowDefinition()
      const node = findNode(workflow, 'route-backlog')
      expect(node).toBeDefined()
      expect(node?.when).toContain('Backlog')
      const actions = node?.steps?.map(s => s.action)
      expect(actions).toContain('trigger-development')
    })

    it('includes Started routing node', () => {
      const workflow = DecisionEngineAdapter.toWorkflowDefinition()
      const node = findNode(workflow, 'route-started')
      expect(node).toBeDefined()
      expect(node?.when).toContain('Started')
    })

    it('includes Finished routing node with QA', () => {
      const workflow = DecisionEngineAdapter.toWorkflowDefinition()
      const node = findNode(workflow, 'route-finished')
      expect(node).toBeDefined()
      expect(node?.when).toContain('Finished')
      const actions = node?.steps?.map(s => s.action)
      expect(actions).toContain('trigger-qa')
      expect(actions).toContain('escalate-human')
      expect(actions).toContain('decompose')
    })

    it('never includes a merge step in Finished (merges are owned by the landing serializer)', () => {
      const workflow = DecisionEngineAdapter.toWorkflowDefinition()
      const node = findNode(workflow, 'route-finished')
      const actions = node?.steps?.map(s => s.action)
      expect(actions).not.toContain('trigger-merge')
    })

    it('includes Delivered routing node', () => {
      const workflow = DecisionEngineAdapter.toWorkflowDefinition()
      const node = findNode(workflow, 'route-delivered')
      expect(node).toBeDefined()
      expect(node?.when).toContain('Delivered')
      const actions = node?.steps?.map(s => s.action)
      expect(actions).toContain('trigger-acceptance')
    })

    it('includes Rejected routing node with escalation', () => {
      const workflow = DecisionEngineAdapter.toWorkflowDefinition()
      const node = findNode(workflow, 'route-rejected')
      expect(node).toBeDefined()
      expect(node?.when).toContain('Rejected')
      const actions = node?.steps?.map(s => s.action)
      expect(actions).toContain('trigger-refinement')
      expect(actions).toContain('escalate-human')
      expect(actions).toContain('decompose')
    })
  })

  // ---------------------------------------------------------------------------
  // Top-of-funnel (Icebox) nodes
  // ---------------------------------------------------------------------------

  describe('top-of-funnel nodes', () => {
    it('includes Icebox research node by default', () => {
      const workflow = DecisionEngineAdapter.toWorkflowDefinition()
      const node = findNode(workflow, 'icebox-research')
      expect(node).toBeDefined()
      expect(node?.when).toContain('Icebox')
      expect(node?.when).toContain('enableAutoResearch')
    })

    it('includes Icebox backlog-creation node by default', () => {
      const workflow = DecisionEngineAdapter.toWorkflowDefinition()
      const node = findNode(workflow, 'icebox-backlog-creation')
      expect(node).toBeDefined()
      expect(node?.when).toContain('Icebox')
      expect(node?.when).toContain('enableAutoBacklogCreation')
    })

    it('excludes top-of-funnel nodes when disabled', () => {
      const workflow = DecisionEngineAdapter.toWorkflowDefinition({
        includeTopOfFunnel: false,
      })
      expect(findNode(workflow, 'icebox-research')).toBeUndefined()
      expect(findNode(workflow, 'icebox-backlog-creation')).toBeUndefined()
    })
  })

  // ---------------------------------------------------------------------------
  // Decision parity: verify the adapter covers all decision paths
  // ---------------------------------------------------------------------------

  describe('decision parity with decideAction()', () => {
    const workflow = DecisionEngineAdapter.toWorkflowDefinition({
      includeTopOfFunnel: true,
    })

    it('covers active session skip → guard-active-session node exists', () => {
      const ctx = makeContext({ hasActiveSession: true })
      const result = decideAction(ctx)
      expect(result.action).toBe('none')
      expect(findNode(workflow, 'guard-active-session')).toBeDefined()
    })

    it('covers cooldown skip → guard-cooldown node exists', () => {
      const ctx = makeContext({ isWithinCooldown: true })
      const result = decideAction(ctx)
      expect(result.action).toBe('none')
      expect(findNode(workflow, 'guard-cooldown')).toBeDefined()
    })

    it('covers hold skip → guard-hold node exists', () => {
      const ctx = makeContext({ isHeld: true })
      const result = decideAction(ctx)
      expect(result.action).toBe('none')
      expect(findNode(workflow, 'guard-hold')).toBeDefined()
    })

    it('covers circuit breaker → guard-circuit-breaker node exists', () => {
      const ctx = makeContext({ completedSessionCount: MAX_SESSION_ATTEMPTS })
      const result = decideAction(ctx)
      expect(result.action).toBe('none')
      expect(findNode(workflow, 'guard-circuit-breaker')).toBeDefined()
    })

    it('covers terminal status → guard-terminal-status node exists', () => {
      for (const status of ['Accepted', 'Canceled', 'Duplicate']) {
        const ctx = makeContext({ issue: makeIssue({ status }) })
        const result = decideAction(ctx)
        expect(result.action).toBe('none')
      }
      expect(findNode(workflow, 'guard-terminal-status')).toBeDefined()
    })

    it('covers sub-issue guard → guard-sub-issue node exists', () => {
      const ctx = makeContext({ issue: makeIssue({ parentId: 'parent-1' }) })
      const result = decideAction(ctx)
      expect(result.action).toBe('none')
      expect(findNode(workflow, 'guard-sub-issue')).toBeDefined()
    })

    it('covers Backlog → trigger-development', () => {
      const ctx = makeContext({ issue: makeIssue({ status: 'Backlog' }) })
      const result = decideAction(ctx)
      expect(result.action).toBe('trigger-development')

      const node = findNode(workflow, 'route-backlog')
      const dispatchStep = node?.steps?.find(s => s.action === 'trigger-development')
      expect(dispatchStep).toBeDefined()
    })

    it('covers Finished → trigger-qa', () => {
      const ctx = makeContext({ issue: makeIssue({ status: 'Finished' }) })
      const result = decideAction(ctx)
      expect(result.action).toBe('trigger-qa')

      const node = findNode(workflow, 'route-finished')
      const qaStep = node?.steps?.find(s => s.action === 'trigger-qa')
      expect(qaStep).toBeDefined()
    })

    it('covers Finished + escalate-human → escalate-human', () => {
      const ctx = makeContext({
        issue: makeIssue({ status: 'Finished' }),
        workflowStrategy: 'escalate-human',
      })
      const result = decideAction(ctx)
      expect(result.action).toBe('escalate-human')

      const node = findNode(workflow, 'route-finished')
      const escalateStep = node?.steps?.find(s => s.action === 'escalate-human')
      expect(escalateStep).toBeDefined()
    })

    it('covers Finished + decompose → decompose', () => {
      const ctx = makeContext({
        issue: makeIssue({ status: 'Finished' }),
        workflowStrategy: 'decompose',
      })
      const result = decideAction(ctx)
      expect(result.action).toBe('decompose')

      const node = findNode(workflow, 'route-finished')
      const decomposeStep = node?.steps?.find(s => s.action === 'decompose')
      expect(decomposeStep).toBeDefined()
    })

    it('Finished always triggers QA even with merge queue enabled (merge queue does not bypass QA)', () => {
      const ctx = makeContext({
        issue: makeIssue({ status: 'Finished' }),
        mergeQueueEnabled: true,
      })
      const result = decideAction(ctx)
      expect(result.action).toBe('trigger-qa')

      const node = findNode(workflow, 'route-finished')
      // No trigger-merge step should exist in the Finished node
      const mergeStep = node?.steps?.find(s => s.action === 'trigger-merge')
      expect(mergeStep).toBeUndefined()
    })

    it('covers Delivered → trigger-acceptance', () => {
      const ctx = makeContext({ issue: makeIssue({ status: 'Delivered' }) })
      const result = decideAction(ctx)
      expect(result.action).toBe('trigger-acceptance')

      const node = findNode(workflow, 'route-delivered')
      const acceptStep = node?.steps?.find(s => s.action === 'trigger-acceptance')
      expect(acceptStep).toBeDefined()
    })

    it('covers Rejected → trigger-refinement', () => {
      const ctx = makeContext({ issue: makeIssue({ status: 'Rejected' }) })
      const result = decideAction(ctx)
      expect(result.action).toBe('trigger-refinement')

      const node = findNode(workflow, 'route-rejected')
      const refineStep = node?.steps?.find(s => s.action === 'trigger-refinement')
      expect(refineStep).toBeDefined()
    })

    it('covers Rejected + escalate-human → escalate-human', () => {
      const ctx = makeContext({
        issue: makeIssue({ status: 'Rejected' }),
        workflowStrategy: 'escalate-human',
      })
      const result = decideAction(ctx)
      expect(result.action).toBe('escalate-human')

      const node = findNode(workflow, 'route-rejected')
      const escalateStep = node?.steps?.find(s => s.action === 'escalate-human')
      expect(escalateStep).toBeDefined()
    })

    it('covers Started → none', () => {
      const ctx = makeContext({ issue: makeIssue({ status: 'Started' }) })
      const result = decideAction(ctx)
      expect(result.action).toBe('none')

      expect(findNode(workflow, 'route-started')).toBeDefined()
    })

    it('all decideAction decision points have corresponding workflow nodes', () => {
      // Comprehensive check: every decision path in decideAction has a matching node
      const nodeNames = workflow.nodes?.map(n => n.name) ?? []

      // Guard nodes
      expect(nodeNames).toContain('guard-active-session')
      expect(nodeNames).toContain('guard-cooldown')
      expect(nodeNames).toContain('guard-hold')
      expect(nodeNames).toContain('guard-gates')
      expect(nodeNames).toContain('guard-circuit-breaker')
      expect(nodeNames).toContain('guard-terminal-status')
      expect(nodeNames).toContain('guard-sub-issue')

      // Routing nodes
      expect(nodeNames).toContain('route-backlog')
      expect(nodeNames).toContain('route-started')
      expect(nodeNames).toContain('route-finished')
      expect(nodeNames).toContain('route-delivered')
      expect(nodeNames).toContain('route-rejected')

      // Top-of-funnel
      expect(nodeNames).toContain('icebox-research')
      expect(nodeNames).toContain('icebox-backlog-creation')
    })
  })
})
