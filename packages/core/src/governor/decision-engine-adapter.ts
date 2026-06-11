/**
 * Decision Engine Adapter
 *
 * Translates the full `decideAction()` decision context into a
 * WorkflowDefinition v2 YAML equivalent. Each decision point in the
 * engine becomes a condition node or action node in the v2 graph.
 *
 * This adapter enables the platform to replace the legacy decision engine
 * with a declarative workflow while preserving identical behavior.
 *
 */

import type { GovernorConfig } from './governor-types.js'
import { DEFAULT_GOVERNOR_CONFIG } from './governor-types.js'
import type {
  WorkflowDefinitionV2,
  NodeDefinition,
  StepDefinition,
  WorkflowTriggerDefinition,
  ProviderRequirement,
} from '../workflow/workflow-types.js'
import { MAX_SESSION_ATTEMPTS } from './decision-engine.js'

// ---------------------------------------------------------------------------
// Adapter Configuration
// ---------------------------------------------------------------------------

export interface DecisionEngineAdapterConfig {
  /** Governor configuration to derive workflow from */
  governorConfig?: GovernorConfig
  /** Workflow name (default: "governor-decision-engine") */
  workflowName?: string
  /** Whether to include top-of-funnel nodes (Icebox handling) */
  includeTopOfFunnel?: boolean
  /** Whether to include merge queue handling */
  includeMergeQueue?: boolean
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Converts the Governor's `decideAction()` logic into a WorkflowDefinition v2.
 *
 * The generated workflow mirrors the decision tree exactly:
 *
 * 1. Universal guards: active-session, cooldown, hold, gates, circuit-breaker
 * 2. Terminal statuses: Accepted, Canceled, Duplicate
 * 3. Sub-issue guard
 * 4. Status-specific routing: Icebox, Backlog, Started, Finished, Delivered, Rejected
 * 5. Escalation strategy overrides (decompose, escalate-human)
 * 6. Merge queue handling
 */
export class DecisionEngineAdapter {
  /**
   * Generate a WorkflowDefinition v2 that replicates the full decision engine.
   */
  static toWorkflowDefinition(
    config: DecisionEngineAdapterConfig = {},
  ): WorkflowDefinitionV2 {
    const govConfig = config.governorConfig ?? DEFAULT_GOVERNOR_CONFIG
    const workflowName = config.workflowName ?? 'governor-decision-engine'
    const includeTopOfFunnel = config.includeTopOfFunnel ?? true
    const includeMergeQueue = config.includeMergeQueue ?? false

    const triggers = buildTriggers()
    const providers = buildProviders()
    const nodes = buildNodes(govConfig, includeTopOfFunnel, includeMergeQueue)

    return {
      apiVersion: 'v2',
      kind: 'WorkflowDefinition',
      metadata: {
        name: workflowName,
        description:
          'Auto-generated from Governor DecisionEngine. ' +
          'Replicates the full decideAction() decision tree as v2 workflow nodes.',
      },
      triggers,
      providers,
      config: {
        maxSessionAttempts: MAX_SESSION_ATTEMPTS,
        enableAutoDevelopment: govConfig.enableAutoDevelopment,
        enableAutoQA: govConfig.enableAutoQA,
        enableAutoAcceptance: govConfig.enableAutoAcceptance,
        enableAutoResearch: govConfig.enableAutoResearch,
        enableAutoBacklogCreation: govConfig.enableAutoBacklogCreation,
      },
      nodes,
    }
  }
}

// ---------------------------------------------------------------------------
// Trigger builders
// ---------------------------------------------------------------------------

function buildTriggers(): WorkflowTriggerDefinition[] {
  return [
    {
      name: 'issue-status-change',
      type: 'webhook',
      source: 'linear',
      event: 'issue.status_changed',
    },
    {
      name: 'governor-scan',
      type: 'schedule',
      schedule: '*/1 * * * *', // Every minute
    },
  ]
}

// ---------------------------------------------------------------------------
// Provider builders
// ---------------------------------------------------------------------------

function buildProviders(): ProviderRequirement[] {
  return [
    { name: 'linear', type: 'linear' },
    { name: 'agent', type: 'agent-provider' },
  ]
}

// ---------------------------------------------------------------------------
// Node builders
// ---------------------------------------------------------------------------

function buildNodes(
  config: GovernorConfig,
  includeTopOfFunnel: boolean,
  includeMergeQueue: boolean,
): NodeDefinition[] {
  const nodes: NodeDefinition[] = []

  // --- Universal guard nodes ---
  nodes.push(buildActiveSessionGuard())
  nodes.push(buildCooldownGuard())
  nodes.push(buildHoldGuard())
  nodes.push(buildGateGuard())
  nodes.push(buildCircuitBreakerGuard())
  nodes.push(buildTerminalStatusGuard())
  nodes.push(buildSubIssueGuard())

  // --- Status-specific routing nodes ---
  if (includeTopOfFunnel) {
    nodes.push(buildIceboxResearchNode(config))
    nodes.push(buildIceboxBacklogCreationNode(config))
  }

  nodes.push(buildBacklogNode(config))
  nodes.push(buildStartedNode())
  nodes.push(buildFinishedNode(config, includeMergeQueue))
  nodes.push(buildDeliveredNode(config))
  nodes.push(buildRejectedNode())

  return nodes
}

// ---------------------------------------------------------------------------
// Guard nodes
// ---------------------------------------------------------------------------

function buildActiveSessionGuard(): NodeDefinition {
  return {
    name: 'guard-active-session',
    description: 'Skip if issue already has an active agent session',
    when: '{{ hasActiveSession }}',
    steps: [
      {
        id: 'skip',
        action: 'none',
        with: {
          reason: 'Issue {{ issue.identifier }} already has an active agent session',
        },
      },
    ],
  }
}

function buildCooldownGuard(): NodeDefinition {
  return {
    name: 'guard-cooldown',
    description: 'Skip if issue is within cooldown period',
    when: '{{ isWithinCooldown }}',
    steps: [
      {
        id: 'skip',
        action: 'none',
        with: {
          reason: 'Issue {{ issue.identifier }} is within cooldown period',
        },
      },
    ],
  }
}

function buildHoldGuard(): NodeDefinition {
  return {
    name: 'guard-hold',
    description: 'Skip if HOLD override is active',
    when: '{{ isHeld }}',
    steps: [
      {
        id: 'skip',
        action: 'none',
        with: {
          reason: 'Issue {{ issue.identifier }} is held (HOLD override active)',
        },
      },
    ],
  }
}

function buildGateGuard(): NodeDefinition {
  return {
    name: 'guard-gates',
    description: 'Block when gates are unsatisfied (Phase 4 gate evaluation)',
    when: '{{ gateEvaluation && !gateEvaluation.allSatisfied }}',
    steps: [
      {
        id: 'block',
        action: 'none',
        with: {
          reason: 'Issue {{ issue.identifier }} has unsatisfied gates',
        },
      },
    ],
  }
}

function buildCircuitBreakerGuard(): NodeDefinition {
  return {
    name: 'guard-circuit-breaker',
    description: `Trip circuit breaker when session count >= ${MAX_SESSION_ATTEMPTS}`,
    when: `{{ completedSessionCount >= ${MAX_SESSION_ATTEMPTS} }}`,
    steps: [
      {
        id: 'trip',
        action: 'none',
        with: {
          reason: `Issue {{ issue.identifier }} has had {{ completedSessionCount }} agent sessions — circuit breaker tripped (max ${MAX_SESSION_ATTEMPTS})`,
        },
      },
    ],
  }
}

function buildTerminalStatusGuard(): NodeDefinition {
  return {
    name: 'guard-terminal-status',
    description: 'No action for terminal statuses (Accepted, Canceled, Duplicate)',
    when: "{{ issue.status == 'Accepted' || issue.status == 'Canceled' || issue.status == 'Duplicate' }}",
    steps: [
      {
        id: 'skip',
        action: 'none',
        with: {
          reason: 'Issue {{ issue.identifier }} is in terminal status: {{ issue.status }}',
        },
      },
    ],
  }
}

function buildSubIssueGuard(): NodeDefinition {
  return {
    name: 'guard-sub-issue',
    description: 'Sub-issues managed by coordinator via parent — skip direct dispatch',
    when: '{{ issue.parentId != undefined }}',
    steps: [
      {
        id: 'skip',
        action: 'none',
        with: {
          reason: 'Sub-issue {{ issue.identifier }} skipped — coordinator manages sub-issues via parent',
        },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Status-specific routing nodes
// ---------------------------------------------------------------------------

function buildIceboxResearchNode(config: GovernorConfig): NodeDefinition {
  return {
    name: 'icebox-research',
    description: 'Trigger research for sparse Icebox issues (top-of-funnel)',
    provider: 'agent',
    when: `{{ issue.status == 'Icebox' && config.enableAutoResearch && !researchCompleted && !isParentIssue }}`,
    steps: [
      {
        id: 'evaluate',
        action: 'trigger-research',
        with: {
          enableAutoResearch: config.enableAutoResearch,
        },
      },
    ],
  }
}

function buildIceboxBacklogCreationNode(config: GovernorConfig): NodeDefinition {
  return {
    name: 'icebox-backlog-creation',
    description: 'Trigger backlog creation for well-researched Icebox issues',
    provider: 'agent',
    when: `{{ issue.status == 'Icebox' && config.enableAutoBacklogCreation && !backlogCreationCompleted && !isParentIssue }}`,
    steps: [
      {
        id: 'evaluate',
        action: 'trigger-backlog-creation',
        with: {
          enableAutoBacklogCreation: config.enableAutoBacklogCreation,
        },
      },
    ],
  }
}

function buildBacklogNode(config: GovernorConfig): NodeDefinition {
  return {
    name: 'route-backlog',
    description: 'Backlog → trigger-development (if enabled)',
    provider: 'agent',
    when: "{{ issue.status == 'Backlog' }}",
    steps: [
      {
        id: 'check-enabled',
        action: 'none',
        when: `{{ !config.enableAutoDevelopment }}`,
        with: {
          reason: 'Auto-development is disabled for {{ issue.identifier }}',
        },
      },
      {
        id: 'dispatch',
        action: 'trigger-development',
        when: `{{ config.enableAutoDevelopment }}`,
        with: {
          isParentIssue: '{{ isParentIssue }}',
          reason: '{{ isParentIssue ? "Parent issue" : "Issue" }} {{ issue.identifier }} is in Backlog — triggering {{ isParentIssue ? "coordination " : "" }}development',
        },
      },
    ],
  }
}

function buildStartedNode(): NodeDefinition {
  return {
    name: 'route-started',
    description: 'Started → none (agent already working)',
    when: "{{ issue.status == 'Started' }}",
    steps: [
      {
        id: 'skip',
        action: 'none',
        with: {
          reason: 'Issue {{ issue.identifier }} is in Started status (agent already working)',
        },
      },
    ],
  }
}

function buildFinishedNode(config: GovernorConfig, includeMergeQueue: boolean): NodeDefinition {
  const steps: StepDefinition[] = [
    {
      id: 'check-enabled',
      action: 'none',
      when: '{{ !config.enableAutoQA }}',
      with: {
        reason: 'Auto-QA is disabled for {{ issue.identifier }}',
      },
    },
    {
      id: 'check-escalate-human',
      action: 'escalate-human',
      when: "{{ workflowStrategy == 'escalate-human' }}",
      with: {
        reason: 'Issue {{ issue.identifier }} is in Finished with escalate-human strategy — needs human review',
      },
    },
    {
      id: 'check-decompose',
      action: 'decompose',
      when: "{{ workflowStrategy == 'decompose' }}",
      with: {
        reason: 'Issue {{ issue.identifier }} is in Finished with decompose strategy — triggering decomposition',
      },
    },
  ]

  // Always trigger QA for functional validation — merge queue handles git
  // mechanics at merge time, not as a QA bypass.
  // The includeMergeQueue flag is preserved for the adapter signature but the
  // Finished node no longer short-circuits to trigger-merge.
  void includeMergeQueue

  steps.push({
    id: 'dispatch-qa',
    action: 'trigger-qa',
    when: '{{ config.enableAutoQA }}',
    with: {
      reason: 'Issue {{ issue.identifier }} is in Finished — triggering QA',
    },
  })

  return {
    name: 'route-finished',
    description: 'Finished → trigger-qa (with escalation/merge-queue checks)',
    provider: 'agent',
    when: "{{ issue.status == 'Finished' }}",
    steps,
  }
}

function buildDeliveredNode(config: GovernorConfig): NodeDefinition {
  return {
    name: 'route-delivered',
    description: 'Delivered → trigger-acceptance (if enabled)',
    provider: 'agent',
    when: "{{ issue.status == 'Delivered' }}",
    steps: [
      {
        id: 'check-enabled',
        action: 'none',
        when: '{{ !config.enableAutoAcceptance }}',
        with: {
          reason: 'Auto-acceptance is disabled for {{ issue.identifier }}',
        },
      },
      {
        id: 'dispatch',
        action: 'trigger-acceptance',
        when: '{{ config.enableAutoAcceptance }}',
        with: {
          reason: 'Issue {{ issue.identifier }} is in Delivered — triggering acceptance',
        },
      },
    ],
  }
}

function buildRejectedNode(): NodeDefinition {
  return {
    name: 'route-rejected',
    description: 'Rejected → trigger-refinement (with escalation checks)',
    provider: 'agent',
    when: "{{ issue.status == 'Rejected' }}",
    steps: [
      {
        id: 'check-escalate-human',
        action: 'escalate-human',
        when: "{{ workflowStrategy == 'escalate-human' }}",
        with: {
          reason: 'Issue {{ issue.identifier }} is Rejected with escalate-human strategy — needs human intervention',
        },
      },
      {
        id: 'check-decompose',
        action: 'decompose',
        when: "{{ workflowStrategy == 'decompose' }}",
        with: {
          reason: 'Issue {{ issue.identifier }} is Rejected with decompose strategy — triggering decomposition',
        },
      },
      {
        id: 'dispatch-refinement',
        action: 'trigger-refinement',
        with: {
          reason: 'Issue {{ issue.identifier }} is Rejected — triggering refinement',
        },
      },
    ],
  }
}
