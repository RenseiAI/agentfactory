/**
 * Cross-provider sandbox scheduler
 *
 * Implements the scheduling algorithm from
 * donmai-architecture/004-sandbox-capability-matrix.md §"Scheduling algorithm"
 *
 * Algorithm (pure function, no I/O):
 *  1. Filter by capability constraints from spec (region, os, arch, resources,
 *     gpu, duration, workarea needs).
 *  2. Filter by tenant policy (preferred / forbidden providers).
 *  3. Filter by capacity (drop unhealthy; drop >90% maxConcurrent if known).
 *  4. Score remaining candidates: normalized cost + latency.
 *  5. Pick lowest-scored. Ties: preferredProviders order → lowest providerId.
 *  6. On provision failure: exponential back-off + provider blacklist.
 *
 * The scheduler is deliberately side-effect free. Callers own the provision()
 * call and back-off state (ProviderBlacklist). The scheduler only decides.
 */

import type { SandboxProviderCapabilities } from '../providers/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal sandbox spec fields the scheduler reasons about. */
export interface SchedulerSandboxSpec {
  /** ISO region code requested, or undefined for any region */
  region?: string
  /** OS required by the workload */
  os?: 'linux' | 'macos' | 'windows'
  /** CPU architecture required */
  arch?: 'x86_64' | 'arm64' | 'wasm32'
  /** vCPU requested */
  vCpu?: number
  /** Memory requested in MiB */
  memoryMb?: number
  /** GPU required */
  gpu?: boolean
  /** Maximum session duration in seconds */
  maxDurationSeconds?: number
  /**
   * Whether the session requires pause/resume support from the sandbox
   * (e.g., WorkareaProvider that needs release(pause)).
   */
  requiresPauseResume?: boolean
  /**
   * Estimated active CPU fraction of the workload (0–1).
   * Used for cost normalization: an I/O-heavy agent at 0.15 active-CPU
   * pays very little under active-cpu billing vs wall-clock.
   * Default: 0.2 (typical coding-agent I/O pattern).
   */
  estimatedActiveCpuFraction?: number
  /**
   * Estimated session duration in seconds for cost projection.
   * Default: 1800 (30 min).
   */
  estimatedDurationSeconds?: number
}

/** Capacity snapshot for scheduling decisions. */
export interface CapacitySnapshot {
  provisionedActive: number
  provisionedPaused: number
  maxConcurrent: number | null
  estimatedAvailable: number
  warmPoolReady: number
  capturedAt: Date
}

/** A provider candidate handed to the scheduler. */
export interface SchedulerCandidate {
  /** Globally unique provider identifier */
  providerId: string
  capabilities: SandboxProviderCapabilities
  /** Optional real-time capacity; null if the provider doesn't support capacity queries */
  capacity?: CapacitySnapshot | null
  /** Current health status; undefined treated as 'ready' */
  health?: 'ready' | 'degraded' | 'unhealthy'
  /**
   * Provider's estimate of warm-path acquire latency in milliseconds.
   * Used for latency scoring. Null if unknown.
   */
  estimatedAcquireMs?: number | null
}

/** Tenant-level hints passed alongside the spec. */
export interface TenantSchedulePolicy {
  /**
   * Ordered preference list. Surviving candidates that appear here are
   * scored with a preference bonus (tie-breaking before providerId sort).
   */
  preferredProviders?: string[]
  /**
   * Providers the tenant explicitly forbids. Eliminated before scoring.
   */
  forbiddenProviders?: string[]
  /**
   * 0–1 weight for cost vs latency in scoring. 1.0 = cost-only, 0.0 = latency-only.
   * Default: 0.7 (70% cost / 30% latency per 004 open question §2 default).
   */
  costWeight?: number
}

/**
 * Record of a single scheduling decision step.
 * Emitted as debug log entries for observability / routing panel.
 */
export interface EliminationStep {
  step:
    | 'capability-filter'
    | 'policy-filter'
    | 'capacity-filter'
    | 'scoring'
    | 'winner'
  providerId: string
  /** Why the provider was eliminated (only present when eliminated) */
  reason?: string
  /** Final score (only present at scoring step) */
  score?: number
}

/** Result of a pickProvider call. */
export interface SchedulerResult {
  /** Chosen provider, or null if no viable candidate found */
  winner: SchedulerCandidate | null
  /** Ordered elimination log for observability */
  eliminationChain: EliminationStep[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Capacity threshold above which a provider is considered full */
const CAPACITY_FULL_THRESHOLD = 0.9

/**
 * Default active-CPU fraction for agent workloads.
 * Coding agents are I/O-heavy; ~20% CPU active is typical.
 */
const DEFAULT_ACTIVE_CPU_FRACTION = 0.2

/** Default estimated session duration when not specified (30 min) */
const DEFAULT_ESTIMATED_DURATION_SEC = 1800

/** Default cost/latency weight split (70% cost, 30% latency) */
const DEFAULT_COST_WEIGHT = 0.7

// ---------------------------------------------------------------------------
// Cost normalization
// ---------------------------------------------------------------------------

/**
 * Normalize billing model to a comparable "expected cost units" for a
 * given workload shape.
 *
 * Returns a dimensionless score (higher = more expensive). The absolute
 * magnitude doesn't matter; what matters is the relative ordering between
 * providers so the scheduler can pick the cheapest viable option.
 *
 * Normalization formula:
 *   wall-clock:  duration × 1.0  (charged for every second)
 *   active-cpu:  duration × activeCpuFraction  (I/O wait is free)
 *   invocation:  1.0  (flat per-call; duration irrelevant)
 *   fixed:       0.0  (BYOH — no per-use cost)
 *
 * An idle cost surcharge is added for metered idle models:
 *   zero:         0
 *   storage-only: 0.05 × duration  (small constant for storage)
 *   metered:      0.3 × duration   (continuous charge even at rest)
 */
export function normalizeCost(
  caps: SandboxProviderCapabilities,
  estimatedDurationSec: number,
  estimatedActiveCpuFraction: number,
): number {
  let activeCost: number
  switch (caps.billingModel) {
    case 'wall-clock':
      activeCost = estimatedDurationSec
      break
    case 'active-cpu':
      activeCost = estimatedDurationSec * estimatedActiveCpuFraction
      break
    case 'invocation':
      activeCost = 1.0
      break
    case 'fixed':
      activeCost = 0.0
      break
  }

  let idleSurcharge: number
  switch (caps.idleCostModel) {
    case 'zero':
      idleSurcharge = 0
      break
    case 'storage-only':
      idleSurcharge = 0.05 * estimatedDurationSec
      break
    case 'metered':
      idleSurcharge = 0.3 * estimatedDurationSec
      break
  }

  return activeCost + idleSurcharge
}

// ---------------------------------------------------------------------------
// Capability filter
// ---------------------------------------------------------------------------

/**
 * Returns a reason string if the candidate is eliminated by capability
 * constraints, or null if it passes.
 */
function checkCapabilities(
  spec: SchedulerSandboxSpec,
  caps: SandboxProviderCapabilities,
): string | null {
  // Region match: '*' in capabilities means any region
  if (spec.region != null) {
    const regionOk =
      caps.regions.includes('*') || caps.regions.includes(spec.region)
    if (!regionOk) {
      return `region '${spec.region}' not in provider regions [${caps.regions.join(', ')}]`
    }
  }

  // OS match
  if (spec.os != null) {
    if (!caps.os.includes(spec.os)) {
      return `os '${spec.os}' not in provider os [${caps.os.join(', ')}]`
    }
  }

  // Arch match
  if (spec.arch != null) {
    if (!caps.arch.includes(spec.arch)) {
      return `arch '${spec.arch}' not in provider arch [${caps.arch.join(', ')}]`
    }
  }

  // vCPU ceiling
  if (spec.vCpu != null && caps.maxVCpu != null) {
    if (spec.vCpu > caps.maxVCpu) {
      return `requested vCpu ${spec.vCpu} exceeds provider maxVCpu ${caps.maxVCpu}`
    }
  }

  // Memory ceiling
  if (spec.memoryMb != null && caps.maxMemoryMb != null) {
    if (spec.memoryMb > caps.maxMemoryMb) {
      return `requested memoryMb ${spec.memoryMb} exceeds provider maxMemoryMb ${caps.maxMemoryMb}`
    }
  }

  // GPU requirement
  if (spec.gpu === true && !caps.supportsGpu) {
    return 'GPU requested but provider does not support GPU'
  }

  // Duration constraint
  if (
    spec.maxDurationSeconds != null &&
    caps.maxSessionDurationSeconds != null
  ) {
    if (spec.maxDurationSeconds > caps.maxSessionDurationSeconds) {
      return (
        `requested maxDurationSeconds ${spec.maxDurationSeconds} exceeds ` +
        `provider maxSessionDurationSeconds ${caps.maxSessionDurationSeconds}`
      )
    }
  }

  // Pause/resume requirement
  if (spec.requiresPauseResume === true && !caps.supportsPauseResume) {
    return 'pause/resume required but provider does not support it'
  }

  return null
}

// ---------------------------------------------------------------------------
// Capacity filter
// ---------------------------------------------------------------------------

function checkCapacity(candidate: SchedulerCandidate): string | null {
  // Drop unhealthy providers
  if (candidate.health === 'unhealthy') {
    return 'provider health is unhealthy'
  }

  // Drop providers above 90% maxConcurrent if capacity is known
  const cap = candidate.capacity
  if (cap != null && cap.maxConcurrent != null) {
    const utilization = cap.provisionedActive / cap.maxConcurrent
    if (utilization >= CAPACITY_FULL_THRESHOLD) {
      return `provider at ${Math.round(utilization * 100)}% capacity (≥${CAPACITY_FULL_THRESHOLD * 100}% threshold)`
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute a score for a candidate (lower = better).
 *
 * Score = costWeight × normalizedCost + (1 − costWeight) × normalizedLatency
 *
 * Both components are normalized to [0, 1] relative to the candidate set,
 * but since this is per-candidate we use raw values and the relative ordering
 * is what matters (all candidates are compared in the caller).
 *
 * Latency component: uses estimatedAcquireMs when available; null/missing
 * providers get a mid-range latency penalty (5000ms default) so unknown
 * latency doesn't win over known-fast providers.
 */
function scoreCandidate(
  candidate: SchedulerCandidate,
  spec: SchedulerSandboxSpec,
  costWeight: number,
): number {
  const duration = spec.estimatedDurationSeconds ?? DEFAULT_ESTIMATED_DURATION_SEC
  const activeCpuFraction = spec.estimatedActiveCpuFraction ?? DEFAULT_ACTIVE_CPU_FRACTION

  const rawCost = normalizeCost(candidate.capabilities, duration, activeCpuFraction)

  // Latency: use estimatedAcquireMs when known; default to 5000ms
  const latencyMs = candidate.estimatedAcquireMs ?? 5000

  const latencyWeight = 1 - costWeight

  return costWeight * rawCost + latencyWeight * latencyMs
}

// ---------------------------------------------------------------------------
// Main entry point: pickProvider
// ---------------------------------------------------------------------------

/**
 * Pure scheduling function. Returns the cheapest viable provider for the
 * given spec + policy, plus a detailed elimination chain for debugging.
 *
 * Does NOT provision — callers invoke provider.provision() on the winner.
 * On provision failure, add the winner to a ProviderBlacklist and re-call
 * pickProvider() with the remaining candidates.
 *
 * @param spec - Workload requirements
 * @param candidates - All known providers with their live capability + capacity data
 * @param policy - Tenant-level scheduling preferences (optional)
 * @returns { winner, eliminationChain }
 */
export function pickProvider(
  spec: SchedulerSandboxSpec,
  candidates: SchedulerCandidate[],
  policy?: TenantSchedulePolicy,
): SchedulerResult {
  const eliminationChain: EliminationStep[] = []

  // -------------------------------------------------------------------------
  // Step 1: Filter by capability constraints
  // -------------------------------------------------------------------------
  const afterCapabilityFilter: SchedulerCandidate[] = []
  for (const candidate of candidates) {
    const reason = checkCapabilities(spec, candidate.capabilities)
    if (reason != null) {
      eliminationChain.push({
        step: 'capability-filter',
        providerId: candidate.providerId,
        reason,
      })
    } else {
      afterCapabilityFilter.push(candidate)
    }
  }

  if (afterCapabilityFilter.length === 0) {
    return { winner: null, eliminationChain }
  }

  // -------------------------------------------------------------------------
  // Step 2: Filter by tenant policy
  // -------------------------------------------------------------------------
  const forbidden = new Set(policy?.forbiddenProviders ?? [])
  const afterPolicyFilter: SchedulerCandidate[] = []
  for (const candidate of afterCapabilityFilter) {
    if (forbidden.has(candidate.providerId)) {
      eliminationChain.push({
        step: 'policy-filter',
        providerId: candidate.providerId,
        reason: 'provider is in tenant forbiddenProviders list',
      })
    } else {
      afterPolicyFilter.push(candidate)
    }
  }

  if (afterPolicyFilter.length === 0) {
    return { winner: null, eliminationChain }
  }

  // -------------------------------------------------------------------------
  // Step 3: Filter by capacity
  // -------------------------------------------------------------------------
  const afterCapacityFilter: SchedulerCandidate[] = []
  for (const candidate of afterPolicyFilter) {
    const reason = checkCapacity(candidate)
    if (reason != null) {
      eliminationChain.push({
        step: 'capacity-filter',
        providerId: candidate.providerId,
        reason,
      })
    } else {
      afterCapacityFilter.push(candidate)
    }
  }

  if (afterCapacityFilter.length === 0) {
    return { winner: null, eliminationChain }
  }

  // -------------------------------------------------------------------------
  // Step 4: Score remaining candidates by cost + latency
  // -------------------------------------------------------------------------
  const costWeight = policy?.costWeight ?? DEFAULT_COST_WEIGHT
  const preferred = policy?.preferredProviders ?? []

  const scored = afterCapacityFilter.map((candidate) => ({
    candidate,
    score: scoreCandidate(candidate, spec, costWeight),
  }))

  // Record scores in elimination chain
  for (const { candidate, score } of scored) {
    eliminationChain.push({
      step: 'scoring',
      providerId: candidate.providerId,
      score,
    })
  }

  // -------------------------------------------------------------------------
  // Step 5: Sort and pick winner
  //   Primary: lowest score
  //   Tie-break 1: position in preferredProviders (lower index wins)
  //   Tie-break 2: lexicographic providerId (determinism)
  // -------------------------------------------------------------------------
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score

    const aIdx = preferred.indexOf(a.candidate.providerId)
    const bIdx = preferred.indexOf(b.candidate.providerId)
    const aRank = aIdx === -1 ? Infinity : aIdx
    const bRank = bIdx === -1 ? Infinity : bIdx
    if (aRank !== bRank) return aRank - bRank

    return a.candidate.providerId.localeCompare(b.candidate.providerId)
  })

  const winner = scored[0].candidate
  eliminationChain.push({ step: 'winner', providerId: winner.providerId })

  return { winner, eliminationChain }
}

// ---------------------------------------------------------------------------
// Provider blacklist with exponential back-off
// ---------------------------------------------------------------------------

/**
 * Tracks provision failures and implements exponential back-off blacklisting.
 *
 * Back-off schedule: 250ms → 500ms → 1000ms → ... → 300_000ms (5 min cap).
 *
 * Spec key is used as the blacklist granularity. This allows a provider that
 * fails for one workload shape to still be offered for a different spec (e.g.,
 * K8s cluster full for GPU jobs but available for CPU-only work).
 *
 * Usage:
 *   const bl = new ProviderBlacklist()
 *   // after provision failure:
 *   bl.recordFailure(providerId, specKey)
 *   // when scheduling next attempt:
 *   const ok = bl.isAvailable(providerId, specKey)
 */
export class ProviderBlacklist {
  private readonly entries = new Map<string, BlacklistEntry>()

  private makeKey(providerId: string, specKey: string): string {
    return `${providerId}::${specKey}`
  }

  /**
   * Record a provision failure for provider+specKey.
   * Calculates the next back-off window and stores the entry.
   */
  recordFailure(providerId: string, specKey: string): void {
    const key = this.makeKey(providerId, specKey)
    const existing = this.entries.get(key)

    const failureCount = (existing?.failureCount ?? 0) + 1
    const backoffMs = Math.min(250 * Math.pow(2, failureCount - 1), 300_000)
    const unavailableUntil = new Date(Date.now() + backoffMs)

    this.entries.set(key, {
      providerId,
      specKey,
      failureCount,
      backoffMs,
      unavailableUntil,
      lastFailedAt: new Date(),
    })
  }

  /**
   * Returns true if the provider is available for this spec key (not blacklisted
   * or back-off window has expired).
   */
  isAvailable(providerId: string, specKey: string): boolean {
    const key = this.makeKey(providerId, specKey)
    const entry = this.entries.get(key)
    if (!entry) return true
    return Date.now() >= entry.unavailableUntil.getTime()
  }

  /**
   * Clear a blacklist entry (e.g., after successful health check).
   */
  clearEntry(providerId: string, specKey: string): void {
    this.entries.delete(this.makeKey(providerId, specKey))
  }

  /**
   * Get the current blacklist state for debugging / observability.
   */
  getEntries(): ReadonlyMap<string, Readonly<BlacklistEntry>> {
    return this.entries
  }
}

export interface BlacklistEntry {
  providerId: string
  specKey: string
  failureCount: number
  backoffMs: number
  unavailableUntil: Date
  lastFailedAt: Date
}

// ---------------------------------------------------------------------------
// Health-check integration helper
// ---------------------------------------------------------------------------

/**
 * Filter a candidate list against an active ProviderBlacklist for a given
 * spec key. Candidates that are currently blacked out are excluded.
 *
 * Use alongside pickProvider() to incorporate back-off state into candidate
 * selection:
 *
 *   const viable = filterBlacklisted(allCandidates, blacklist, specKey)
 *   const result = pickProvider(spec, viable, policy)
 *   if (!result.winner) { ... handle no candidates }
 *   try {
 *     await result.winner.provision(spec)
 *   } catch {
 *     blacklist.recordFailure(result.winner.providerId, specKey)
 *     // retry with remaining candidates
 *   }
 */
export function filterBlacklisted(
  candidates: SchedulerCandidate[],
  blacklist: ProviderBlacklist,
  specKey: string,
): SchedulerCandidate[] {
  return candidates.filter((c) => blacklist.isAvailable(c.providerId, specKey))
}
