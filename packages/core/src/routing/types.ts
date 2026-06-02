import { z } from 'zod'
import type { AgentProviderName } from '../providers/types.js'
import type { AgentWorkType } from '../orchestrator/work-types.js'

const AgentProviderNameSchema = z.enum(['claude', 'codex', 'amp', 'spring-ai', 'a2a'])

const AgentWorkTypeSchema = z.enum([
  'research',
  'backlog-creation',
  'development',
  'inflight',
  'qa',
  'acceptance',
  'refinement',
  'refinement-coordination',
])

export interface RoutingObservation {
  id: string
  provider: AgentProviderName
  workType: AgentWorkType
  project?: string
  issueIdentifier: string
  sessionId: string
  reward: number
  taskCompleted: boolean
  prCreated: boolean
  qaResult: 'passed' | 'failed' | 'unknown'
  totalCostUsd: number
  wallClockMs: number
  timestamp: number
  confidence: number
  explorationReason?: string
}

export const RoutingObservationSchema = z.object({
  id: z.string().uuid(),
  provider: AgentProviderNameSchema,
  workType: AgentWorkTypeSchema,
  project: z.string().optional(),
  issueIdentifier: z.string(),
  sessionId: z.string(),
  reward: z.number().min(0).max(1),
  taskCompleted: z.boolean(),
  prCreated: z.boolean(),
  qaResult: z.enum(['passed', 'failed', 'unknown']),
  totalCostUsd: z.number().min(0),
  wallClockMs: z.number().min(0),
  timestamp: z.number(),
  confidence: z.number().min(0).max(1),
  explorationReason: z.string().optional(),
})

export interface RoutingPosterior {
  provider: AgentProviderName
  workType: AgentWorkType
  alpha: number
  beta: number
  totalObservations: number
  avgReward: number
  avgCostUsd: number
  lastUpdated: number
}

export const RoutingPosteriorSchema = z.object({
  provider: AgentProviderNameSchema,
  workType: AgentWorkTypeSchema,
  alpha: z.number().min(1),
  beta: z.number().min(1),
  totalObservations: z.number().int().min(0),
  avgReward: z.number().min(0).max(1),
  avgCostUsd: z.number().min(0),
  lastUpdated: z.number(),
})

export interface RoutingDecision {
  selectedProvider: AgentProviderName
  confidence: number
  expectedReward: number
  explorationReason?: string
  source: 'mab-routing'
  alternatives: Array<{
    provider: AgentProviderName
    expectedReward: number
    confidence: number
  }>
}

export const RoutingDecisionSchema = z.object({
  selectedProvider: AgentProviderNameSchema,
  confidence: z.number().min(0).max(1),
  expectedReward: z.number().min(0).max(1),
  explorationReason: z.string().optional(),
  source: z.literal('mab-routing'),
  alternatives: z.array(
    z.object({
      provider: AgentProviderNameSchema,
      expectedReward: z.number().min(0).max(1),
      confidence: z.number().min(0).max(1),
    }),
  ),
})

export interface RoutingConfig {
  enabled: boolean
  explorationRate: number
  windowSize: number
  discountFactor: number
  minObservationsForExploit: number
  changeDetectionThreshold: number
}

export const RoutingConfigSchema = z.object({
  enabled: z.boolean(),
  explorationRate: z.number().min(0).max(1),
  windowSize: z.number().int().positive(),
  discountFactor: z.number().min(0).max(1),
  minObservationsForExploit: z.number().int().min(0),
  changeDetectionThreshold: z.number().min(0),
})

export const ROUTING_KEYS = {
  posteriors: (provider: AgentProviderName, workType: AgentWorkType) =>
    `routing:posteriors:${provider}:${workType}`,
  observations: 'routing:observations',
  config: 'routing:config',
} as const
