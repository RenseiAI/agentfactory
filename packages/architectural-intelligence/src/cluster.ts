/**
 * Observation cluster + dedupe logic for the Architectural Intelligence pipeline.
 *
 * Architecture reference: donmai-architecture/007-intelligence-services.md
 * §"Architectural Intelligence" — Inference pipeline
 *
 * Design decisions:
 *
 * - Text similarity uses Jaccard coefficient over normalized token sets.
 *   No heavy ML deps — fast, deterministic, zero external dependencies.
 *   Similarity threshold: >= 0.6 → same cluster. Tunable via ClusterConfig.
 *
 * - Decay: observations not reinforced for N days (default: 30) are considered
 *   "weak signals" and their effective confidence is reduced before they feed
 *   the contribute() path. They are NOT deleted — decay is soft (confidence
 *   reduction only). The pipeline caller decides whether to skip them.
 *
 * - Cluster merging: when two observations are similar, the one with higher
 *   confidence is the "representative"; weaker is treated as reinforcement
 *   (boosts representative's effective confidence slightly, capped at 0.95
 *   for inferences, 1.0 only for authored intent sources).
 *
 * - Authored intent (CLAUDE.md, ADRs) bypasses clustering — they are always
 *   emitted as-is with confidence 1.0. The authored-intent constraint from
 *   007 §"non-negotiable principles" is upheld here too.
 */

import type { ArchObservation } from './types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ClusterConfig {
  /**
   * Jaccard similarity threshold for merging two observations into the same
   * cluster. Range: 0..1. Default: 0.6.
   */
  similarityThreshold?: number

  /**
   * Number of days after which an un-reinforced observation is considered
   * to have decayed. Default: 30.
   */
  decayDays?: number

  /**
   * Maximum confidence for inferred (non-authored) observations after
   * cluster merging. Default: 0.95.
   */
  inferenceConfidenceCap?: number
}

const DEFAULT_THRESHOLD = 0.6
const DEFAULT_DECAY_DAYS = 30
const DEFAULT_INFERENCE_CAP = 0.95

// ---------------------------------------------------------------------------
// ObservationWithTimestamp — input type for the clusterer
// ---------------------------------------------------------------------------

export interface ObservationWithTimestamp {
  observation: ArchObservation
  /** When this observation was first recorded. Used for decay calculation. */
  recordedAt: Date
  /** How many times this observation has been reinforced (seen again). */
  reinforcementCount?: number
}

// ---------------------------------------------------------------------------
// ClusterResult — output of the clusterer
// ---------------------------------------------------------------------------

export interface ClusterResult {
  /**
   * Representative observation for this cluster (highest confidence member,
   * with confidence possibly boosted by reinforcements).
   */
  representative: ArchObservation
  /**
   * Number of source observations merged into this cluster.
   * 1 = singleton (no merging occurred).
   */
  clusterSize: number
  /**
   * Whether this cluster was decayed (representative's effective confidence
   * was reduced due to staleness). The caller may choose to skip decayed
   * clusters below a confidence floor.
   */
  decayed: boolean
}

// ---------------------------------------------------------------------------
// clusterObservations — main entry point
// ---------------------------------------------------------------------------

/**
 * Cluster and deduplicate a list of timestamped observations.
 *
 * Authored observations (source.authoredDoc present) bypass clustering and
 * are returned as-is with confidence 1.0. All other observations are
 * subject to Jaccard similarity clustering and decay.
 *
 * @param observations - Input observations (typically from a time window).
 * @param now - Reference time for decay calculation (defaults to Date.now()).
 * @param config - Tunable parameters.
 * @returns One ClusterResult per cluster (deduplicated, merged).
 */
export function clusterObservations(
  observations: ObservationWithTimestamp[],
  now: Date = new Date(),
  config: ClusterConfig = {},
): ClusterResult[] {
  const threshold = config.similarityThreshold ?? DEFAULT_THRESHOLD
  const decayDays = config.decayDays ?? DEFAULT_DECAY_DAYS
  const inferenceCap = config.inferenceConfidenceCap ?? DEFAULT_INFERENCE_CAP

  const results: ClusterResult[] = []

  // Partition: authored observations bypass clustering entirely.
  const authored: ObservationWithTimestamp[] = []
  const inferred: ObservationWithTimestamp[] = []

  for (const item of observations) {
    if (item.observation.source.authoredDoc) {
      authored.push(item)
    } else {
      inferred.push(item)
    }
  }

  // Authored: emit directly with confidence = 1.0
  for (const item of authored) {
    results.push({
      representative: { ...item.observation, confidence: 1.0 },
      clusterSize: 1,
      decayed: false,
    })
  }

  // Inferred: cluster by Jaccard similarity over text tokens
  const clusters = _buildClusters(inferred, threshold)

  for (const cluster of clusters) {
    // Representative: highest confidence member
    const sorted = [...cluster].sort(
      (a, b) => b.observation.confidence - a.observation.confidence,
    )
    const representative = sorted[0]!
    const remainingCount = sorted.length - 1

    // Merge boost: each additional member adds 0.02 to confidence (capped)
    const mergeBoost = Math.min(remainingCount * 0.02, 0.1)
    let effectiveConfidence = Math.min(
      representative.observation.confidence + mergeBoost,
      inferenceCap,
    )

    // Decay: reduce confidence if the representative hasn't been reinforced recently
    const ageMs = now.getTime() - representative.recordedAt.getTime()
    const ageDays = ageMs / (1000 * 60 * 60 * 24)
    const decayed = ageDays > decayDays
    if (decayed) {
      // Linear decay: full decay at 2x the decayDays threshold
      const decayFactor = Math.max(0, 1 - (ageDays - decayDays) / decayDays)
      effectiveConfidence = effectiveConfidence * decayFactor
    }

    // Reinforcement boost: bump confidence slightly per extra seen count
    const reinforcements = representative.reinforcementCount ?? 0
    if (reinforcements > 0) {
      const reinforcementBoost = Math.min(reinforcements * 0.01, 0.05)
      effectiveConfidence = Math.min(effectiveConfidence + reinforcementBoost, inferenceCap)
    }

    results.push({
      representative: {
        ...representative.observation,
        confidence: effectiveConfidence,
      },
      clusterSize: cluster.length,
      decayed,
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Internal: clustering algorithm
// ---------------------------------------------------------------------------

/**
 * Greedy single-pass clustering by Jaccard similarity.
 *
 * For each observation, find an existing cluster whose representative
 * has similarity >= threshold. If found, merge into that cluster.
 * Otherwise, start a new cluster.
 *
 * O(n²) in the worst case — acceptable for the expected observation volumes
 * (tens to hundreds per pass, not millions).
 */
function _buildClusters(
  items: ObservationWithTimestamp[],
  threshold: number,
): ObservationWithTimestamp[][] {
  const clusters: ObservationWithTimestamp[][] = []
  const representativeTokens: Set<string>[] = []

  for (const item of items) {
    const tokens = _tokenize(_observationText(item.observation))
    let merged = false

    for (let i = 0; i < clusters.length; i++) {
      const sim = _jaccardSimilarity(tokens, representativeTokens[i]!)
      if (sim >= threshold) {
        clusters[i]!.push(item)
        // Update representative tokens to be the union (represents the cluster)
        representativeTokens[i] = new Set([...representativeTokens[i]!, ...tokens])
        merged = true
        break
      }
    }

    if (!merged) {
      clusters.push([item])
      representativeTokens.push(new Set(tokens))
    }
  }

  return clusters
}

// ---------------------------------------------------------------------------
// Text extraction from an observation
// ---------------------------------------------------------------------------

/**
 * Extract a searchable text representation from an observation.
 * Uses the payload's title + description fields if present,
 * falling back to JSON-stringified payload.
 */
function _observationText(obs: ArchObservation): string {
  const payload = obs.payload as Record<string, unknown> | null | undefined
  if (payload && typeof payload === 'object') {
    const title = typeof payload['title'] === 'string' ? payload['title'] : ''
    const desc =
      typeof payload['description'] === 'string' ? payload['description'] : ''
    return `${obs.kind} ${title} ${desc}`.trim()
  }
  return `${obs.kind} ${JSON.stringify(obs.payload)}`
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Normalize and tokenize a string into a set of lowercase alpha tokens.
 *
 * - Lowercased.
 * - Split on non-alphanumeric characters.
 * - Tokens < 2 chars are discarded (noise removal).
 * - Common English stop words discarded.
 */
function _tokenize(text: string): Set<string> {
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for',
    'of', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has',
    'had', 'do', 'does', 'did', 'with', 'that', 'this', 'from',
    'by', 'as', 'it', 'its', 'not', 'but', 'all', 'we', 'they',
  ])
  const tokens = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 2 && !STOP_WORDS.has(raw)) {
      tokens.add(raw)
    }
  }
  return tokens
}

// ---------------------------------------------------------------------------
// Jaccard similarity
// ---------------------------------------------------------------------------

/**
 * Jaccard coefficient: |intersection| / |union|
 *
 * Returns 0 when both sets are empty (undefined similarity → not similar).
 */
export function _jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0

  let intersectionSize = 0
  for (const token of a) {
    if (b.has(token)) intersectionSize++
  }

  const unionSize = a.size + b.size - intersectionSize
  return unionSize === 0 ? 0 : intersectionSize / unionSize
}

// ---------------------------------------------------------------------------
// Decay check helper (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Return the effective confidence for a single observation given its age.
 * Authored observations always return 1.0.
 * Inferences decay linearly to 0 between decayDays and 2*decayDays.
 */
export function effectiveConfidence(
  obs: ArchObservation,
  recordedAt: Date,
  now: Date = new Date(),
  config: ClusterConfig = {},
): number {
  if (obs.source.authoredDoc) return 1.0

  const decayDays = config.decayDays ?? DEFAULT_DECAY_DAYS
  const inferenceCap = config.inferenceConfidenceCap ?? DEFAULT_INFERENCE_CAP

  const ageDays = (now.getTime() - recordedAt.getTime()) / (1000 * 60 * 60 * 24)
  const capped = Math.min(obs.confidence, inferenceCap)

  if (ageDays <= decayDays) return capped

  const decayFactor = Math.max(0, 1 - (ageDays - decayDays) / decayDays)
  return capped * decayFactor
}
