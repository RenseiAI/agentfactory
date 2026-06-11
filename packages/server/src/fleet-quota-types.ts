/**
 * Fleet Quota Types
 *
 * Kueue-inspired per-project/team fleet quotas with concurrent session limits,
 * daily cost budgets, per-session cost ceilings, and cohort borrowing/lending.
 *
 * See the design notes for design background.
 */

/**
 * Fleet quota configuration for a project, team, or global scope.
 * Defines resource limits and optional cohort membership for borrowing/lending.
 */
export interface FleetQuota {
  /** Quota name, e.g., "team-alpha", "project-dashboard" */
  name: string
  /** Scope of this quota */
  scope: 'project' | 'team' | 'global'
  /** Maximum concurrent sessions allowed in this quota pool */
  maxConcurrentSessions: number
  /** Maximum total cost (USD) allowed per day */
  maxDailyCostUsd: number
  /** Maximum cost (USD) for a single session */
  maxSessionCostUsd: number
  /** Cohort group name for borrowing/lending (optional) */
  cohort?: string
  /** Max additional sessions this quota can borrow from cohort peers */
  borrowingLimit?: number
  /** Max sessions this quota makes available to cohort peers */
  lendingLimit?: number
}

/**
 * Real-time usage snapshot for a fleet quota.
 * Aggregated from Redis counters.
 */
export interface FleetQuotaUsage {
  /** Number of currently active sessions in this quota pool */
  currentSessions: number
  /** Accumulated cost (USD) for today */
  dailyCostUsd: number
  /** Timestamp when daily counters were last reset */
  lastResetAt: number
}

/**
 * Cohort configuration grouping projects that can share capacity.
 */
export interface CohortConfig {
  /** Cohort name, e.g., "engineering" */
  name: string
  /** Member project/quota names in this cohort */
  projects: string[]
}

/**
 * Result of a quota admission check.
 */
export interface QuotaCheck {
  /** Whether the request is allowed */
  allowed: boolean
  /** Reason for rejection (or 'ok' if allowed) */
  reason?: 'concurrent_limit' | 'daily_budget' | 'session_cost' | 'ok'
  /** Current usage at time of check */
  currentUsage?: FleetQuotaUsage
}
