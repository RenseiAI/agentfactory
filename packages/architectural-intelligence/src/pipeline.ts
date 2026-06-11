/**
 * Architectural Intelligence — observation pipeline
 *
 * Architecture reference: donmai-architecture/007-intelligence-services.md
 * §"Architectural Intelligence" — Inference pipeline
 *
 * Implements the writer-side of Architectural Intelligence.
 *
 * Responsibilities:
 *   1. Subscribe to Memory observation events (kind: memory.observation.*)
 *      on a HookBus-compatible bus. Memory implementation is separate
 *     ; this pipeline handles the event-driven side by listening
 *      on the bus via `attachPipelineSubscribers`.
 *   2. Subscribe to workarea lifecycle hooks (workarea-acquired,
 *      post-verb on workarea verbs) for session-level observation capture.
 *   3. Read merged PR + commit history via the `PrDiff` value objects
 *      provided by the caller (no direct GitHub calls — tests inject synthetics).
 *   4. Cluster and deduplicate similar observations using Jaccard similarity.
 *      Weak signals (decayed past TTL) are filtered below a confidence floor.
 *   5. Assign confidence scores:
 *      - Authored intent (CLAUDE.md, ADR-*.md) → confidence 1.0
 *      - Inferences → capped at 0.95 (DEFAULT_INFERENCE_CAP)
 *   6. Write all surviving observations through `ai.contribute()`.
 *
 * Entry point: `runObservationPass(input)`
 *
 * Hook subscription: `attachPipelineSubscribers(bus, ai, opts)`
 * Returns an unsubscribe function. Call it to detach (e.g., at shutdown).
 *
 * Hook bus compatibility:
 *   The pipeline declares its own minimal `PipelineHookBus` interface so it
 *   stays a zero-dependency standalone package. In production the host passes
 *   the core HookBus (which satisfies the interface). In tests pass a
 *   `PipelineHookBus` mock or the `createTestBus()` helper below.
 *
 * Memory observation events:
 *   The pipeline handles events whose kind starts with `memory.observation.`
 *   These are emitted by the Memory layer. For test injection,
 *   emit events onto the bus with kind = 'memory.observation.pattern' etc.
 *   and an `observation` field conforming to ArchObservation.
 *
 * Authored document detection:
 *   - Files named CLAUDE.md → confidence 1.0, authoredDoc.kind = 'claude-md'
 *   - Files matching ADR-*.md → confidence 1.0, authoredDoc.kind = 'adr'
 *   These bypass clustering and are contributed at full authored confidence.
 */

import type { ArchitecturalIntelligence, ArchObservation, ArchScope } from './types.js'
import {
  readDiffObservations,
  type PrDiff,
  type DiffReaderConfig,
} from './diff-reader.js'
import {
  clusterObservations,
  type ObservationWithTimestamp,
  type ClusterConfig,
} from './cluster.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default confidence cap for inferences (from 007 §"non-negotiable principles") */
const DEFAULT_INFERENCE_CAP = 0.95

/** Minimum confidence floor below which observations are discarded. */
const DEFAULT_CONFIDENCE_FLOOR = 0.05

// ---------------------------------------------------------------------------
// PipelineHookBus — minimal bus interface
//
// The pipeline declares only what it needs from the hook bus. This keeps
// @donmai/architectural-intelligence a zero-dependency standalone package.
// In production: pass the core HookBus instance (it satisfies this interface).
// In tests: use createTestBus() below or any compatible mock.
// ---------------------------------------------------------------------------

export interface PipelineHookEvent {
  kind: string
  [key: string]: unknown
}

export type PipelineHookHandler = (event: PipelineHookEvent) => void | Promise<void>

export interface PipelineHookBus {
  /**
   * Subscribe to all events (no filter — the pipeline filters internally
   * on event.kind). Returns an unsubscribe function.
   */
  subscribe(filter: Record<string, never>, handler: PipelineHookHandler): () => void
}

// ---------------------------------------------------------------------------
// Memory observation event shape
// ---------------------------------------------------------------------------

/**
 * Event kinds emitted by the Memory layer on the hook bus.
 * The pipeline subscribes to all of them.
 */
export const MEMORY_OBSERVATION_KINDS = [
  'memory.observation.pattern',
  'memory.observation.convention',
  'memory.observation.decision',
  'memory.observation.deviation',
] as const

export type MemoryObservationKind = (typeof MEMORY_OBSERVATION_KINDS)[number]

/**
 * Shape of a memory observation event emitted on the hook bus.
 * Tests use this to inject events without a real Memory implementation.
 */
export interface MemoryObservationEvent extends PipelineHookEvent {
  kind: MemoryObservationKind
  /** The observation — must conform to ArchObservation. */
  observation: ArchObservation
}

// ---------------------------------------------------------------------------
// RunObservationPassInput
// ---------------------------------------------------------------------------

/**
 * Input for a single observation pipeline pass.
 *
 * A "pass" processes all available diffs in the `since` window and any
 * buffered observations accumulated since the last pass.
 */
export interface RunObservationPassInput {
  /**
   * Time window start. Used for decay calculations — observations older
   * than `since` may be subject to decay depending on the cluster config.
   */
  since: Date

  /**
   * Pre-fetched PR diffs to process in this pass.
   * Callers are responsible for fetching these from the VCS provider.
   * Tests inject synthetic PrDiff values.
   */
  prDiffs: PrDiff[]

  /**
   * Additional raw observations to process alongside the diff-derived ones
   * (e.g., injected from memory event buffer or manual observation input).
   */
  extraObservations?: ObservationWithTimestamp[]

  /**
   * The Architectural Intelligence instance to write observations into.
   */
  ai: ArchitecturalIntelligence

  /**
   * Scope for all contributed observations.
   */
  scope: ArchScope

  /**
   * Override default cluster + decay configuration.
   */
  clusterConfig?: ClusterConfig

  /**
   * Override default diff reader configuration.
   */
  diffConfig?: DiffReaderConfig

  /**
   * Minimum confidence for contributed observations.
   * Observations below this threshold are discarded without contributing.
   * Default: 0.05.
   */
  confidenceFloor?: number

  /**
   * Reference time for decay calculation. Defaults to current time.
   * Pass a fixed Date in tests for deterministic decay behavior.
   */
  now?: Date
}

// ---------------------------------------------------------------------------
// RunObservationPassResult
// ---------------------------------------------------------------------------

export interface RunObservationPassResult {
  /** Total observations contributed to the graph in this pass. */
  contributed: number
  /** Observations discarded (below confidence floor after decay). */
  discarded: number
  /** Number of PR diffs processed. */
  diffsProcessed: number
  /** Number of cluster merges that occurred (clusters with > 1 member). */
  clusterMerges: number
}

// ---------------------------------------------------------------------------
// runObservationPass — main entry point
// ---------------------------------------------------------------------------

/**
 * Run a single observation pipeline pass.
 *
 * Processing steps:
 *   1. Extract observations from PR diffs via `readDiffObservations`.
 *   2. Merge with any `extraObservations` provided.
 *   3. Run cluster + dedupe + decay via `clusterObservations`.
 *   4. Filter observations below the `confidenceFloor`.
 *   5. Write survivors through `ai.contribute()`.
 *
 * @returns Summary of the pass (contributed, discarded, etc.).
 */
export async function runObservationPass(
  input: RunObservationPassInput,
): Promise<RunObservationPassResult> {
  const {
    prDiffs,
    extraObservations = [],
    ai,
    scope,
    clusterConfig,
    diffConfig,
    confidenceFloor = DEFAULT_CONFIDENCE_FLOOR,
    now = new Date(),
  } = input

  let contributed = 0
  let discarded = 0
  let clusterMerges = 0

  // Step 1: Derive observations from each PR diff
  const diffObservations: ObservationWithTimestamp[] = []
  for (const diff of prDiffs) {
    const obs = readDiffObservations(diff, scope, diffConfig)
    for (const o of obs) {
      // Use `now` as recordedAt for diff-derived observations in this pass
      diffObservations.push({ observation: o, recordedAt: now })
    }
  }

  // Step 2: Merge diff observations with any buffered extras
  const allObservations: ObservationWithTimestamp[] = [
    ...diffObservations,
    ...extraObservations,
  ]

  if (allObservations.length === 0) {
    return {
      contributed: 0,
      discarded: 0,
      diffsProcessed: prDiffs.length,
      clusterMerges: 0,
    }
  }

  // Step 3: Cluster + dedupe + decay
  const clusters = clusterObservations(allObservations, now, clusterConfig)
  for (const c of clusters) {
    if (c.clusterSize > 1) clusterMerges++
  }

  // Step 4 + 5: Filter by confidence floor, then contribute
  for (const cluster of clusters) {
    const obs = cluster.representative

    if (obs.confidence < confidenceFloor) {
      discarded++
      continue
    }

    await ai.contribute(obs)
    contributed++
  }

  return {
    contributed,
    discarded,
    diffsProcessed: prDiffs.length,
    clusterMerges,
  }
}

// ---------------------------------------------------------------------------
// Authored document helpers
// ---------------------------------------------------------------------------

/**
 * Return the authored document kind for a file path, or false if not authored.
 *
 * Authored sources (CLAUDE.md, ADRs) are always contributed with confidence 1.0
 * regardless of inference signals, per 007 §"non-negotiable principles".
 */
export function isAuthoredDoc(
  path: string,
): false | { kind: 'claude-md' | 'adr' | 'spec' } {
  const basename = path.split('/').pop() ?? path

  // CLAUDE.md at any path level
  if (basename === 'CLAUDE.md') return { kind: 'claude-md' }

  // ADR files: ADR-*.md, adr-*.md
  if (/^ADR-/i.test(basename) && basename.endsWith('.md')) return { kind: 'adr' }
  if (/^adr-/i.test(basename) && basename.endsWith('.md')) return { kind: 'adr' }

  // docs/decisions/*.md
  if (/decisions\/[^/]+\.md$/i.test(path)) return { kind: 'adr' }

  // Architecture spec files: NNN-*.md in architecture/ directories
  if (/architecture\/\d+-[^/]+\.md$/i.test(path)) return { kind: 'spec' }

  return false
}

/**
 * Create an authored ArchObservation from a human-authored document.
 *
 * Authored observations:
 *   - Have confidence = 1.0 (per 007 §"non-negotiable principles")
 *   - Bypass clustering in `clusterObservations` (they go through at 1.0)
 *   - Are stored with CitationConfidence = 'authored' in the graph
 *
 * Returns null if `path` is not recognized as an authored document.
 */
export function makeAuthoredObservation(
  path: string,
  title: string,
  description: string,
  scope: ArchScope,
  changeRef?: ArchObservation['source']['changeRef'],
): ArchObservation | null {
  const docKind = isAuthoredDoc(path)
  if (!docKind) return null

  return {
    kind: 'convention',
    payload: {
      title,
      description,
      examples: [{ path }],
    },
    source: {
      authoredDoc: { path, kind: docKind.kind },
      ...(changeRef ? { changeRef } : {}),
    },
    confidence: 1.0,
    scope,
  }
}

// ---------------------------------------------------------------------------
// attachPipelineSubscribers — hook bus integration
// ---------------------------------------------------------------------------

export interface PipelineSubscriberOptions {
  /**
   * Scope to assign to observations produced from hook events.
   */
  scope: ArchScope

  /**
   * Confidence cap for inferred observations from hook events.
   * Default: 0.95 (DEFAULT_INFERENCE_CAP).
   */
  inferenceConfidenceCap?: number

  /**
   * Observations below this floor are discarded without contributing.
   * Default: 0.05 (DEFAULT_CONFIDENCE_FLOOR).
   */
  confidenceFloor?: number
}

/**
 * Attach Architectural Intelligence subscribers to a hook bus.
 *
 * Subscribes to:
 *   - `memory.observation.*` events → contributed directly via ai.contribute()
 *     These are emitted by the Memory layer. For tests, emit
 *     MemoryObservationEvent values onto the bus.
 *   - `post-activate` events for workarea providers → lightweight pattern obs.
 *   - `post-verb` events for workarea providers → track significant verbs.
 *
 * In production: pass `globalHookBus` from `@donmai/core` core.
 * In tests: pass a `createTestBus()` instance and emit events manually.
 *
 * @returns Unsubscribe function — call to detach all subscribers.
 */
export function attachPipelineSubscribers(
  bus: PipelineHookBus,
  ai: ArchitecturalIntelligence,
  opts: PipelineSubscriberOptions,
): () => void {
  const cap = opts.inferenceConfidenceCap ?? DEFAULT_INFERENCE_CAP
  const floor = opts.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR

  const unsub = bus.subscribe({}, async (event: PipelineHookEvent) => {
    const kind = event['kind']
    if (typeof kind !== 'string') return

    // ── Memory observation events ──────────────────────────────────────────
    if (MEMORY_OBSERVATION_KINDS.includes(kind as MemoryObservationKind)) {
      if (!_isMemoryObservationEvent(event)) return

      const obs = event.observation
      if (obs.confidence < floor) return

      const safeObs: ArchObservation = obs.source.authoredDoc
        ? { ...obs, confidence: 1.0 }
        : { ...obs, confidence: Math.min(obs.confidence, cap) }

      await ai.contribute(safeObs)
      return
    }

    // ── Workarea lifecycle: post-activate ──────────────────────────────────
    if (kind === 'post-activate') {
      const provider = event['provider'] as Record<string, unknown> | undefined
      if (!provider || provider['family'] !== 'workarea') return

      const durationMs = typeof event['durationMs'] === 'number' ? event['durationMs'] : 0
      const providerId = typeof provider['id'] === 'string' ? provider['id'] : 'unknown'

      const obs: ArchObservation = {
        kind: 'pattern',
        payload: {
          title: 'Workarea provider activated',
          description:
            `Workarea provider '${providerId}' was activated` +
            (durationMs ? ` in ${durationMs}ms` : '') +
            '.',
          tags: ['workarea', 'lifecycle', 'inferred'],
          locations: [],
        },
        source: { sessionId: providerId },
        confidence: Math.min(0.30, cap),
        scope: opts.scope,
      }

      if (obs.confidence >= floor) {
        await ai.contribute(obs)
      }
      return
    }

    // ── Workarea lifecycle: post-verb ──────────────────────────────────────
    if (kind === 'post-verb') {
      const provider = event['provider'] as Record<string, unknown> | undefined
      if (!provider || provider['family'] !== 'workarea') return

      const verb = typeof event['verb'] === 'string' ? event['verb'] : ''
      if (!['acquire', 'clone', 'provision'].includes(verb)) return

      const durationMs = typeof event['durationMs'] === 'number' ? event['durationMs'] : 0
      const providerId = typeof provider['id'] === 'string' ? provider['id'] : 'unknown'

      const obs: ArchObservation = {
        kind: 'pattern',
        payload: {
          title: `Workarea verb: ${verb}`,
          description:
            `Workarea provider '${providerId}' executed '${verb}'` +
            (durationMs ? ` in ${durationMs}ms` : '') +
            '.',
          tags: ['workarea', 'lifecycle', verb, 'inferred'],
          locations: [],
        },
        source: { sessionId: `${providerId}:${verb}` },
        confidence: Math.min(0.25, cap),
        scope: opts.scope,
      }

      if (obs.confidence >= floor) {
        await ai.contribute(obs)
      }
    }
  })

  return unsub
}

// ---------------------------------------------------------------------------
// createTestBus — in-package hook bus for tests
// ---------------------------------------------------------------------------

/**
 * Create a minimal PipelineHookBus for use in tests.
 *
 * Usage:
 * ```ts
 * const bus = createTestBus()
 * const unsub = attachPipelineSubscribers(bus, ai, opts)
 * await bus.emit({ kind: 'memory.observation.pattern', observation: obs })
 * ```
 */
export function createTestBus(): PipelineHookBus & {
  emit(event: PipelineHookEvent): Promise<void>
  clear(): void
  subscriberCount: number
} {
  type HandlerEntry = { handler: PipelineHookHandler }
  const handlers: HandlerEntry[] = []
  let nextId = 0

  return {
    subscribe(_filter, handler) {
      const id = nextId++
      handlers.push({ handler })
      return () => {
        const idx = handlers.findIndex((_, i) => i === id - (nextId - handlers.length))
        // Simple removal by index tracking
        const entry = handlers.find((h) => h.handler === handler)
        if (entry) {
          const i = handlers.indexOf(entry)
          if (i !== -1) handlers.splice(i, 1)
        }
      }
    },
    async emit(event) {
      for (const entry of [...handlers]) {
        try {
          await entry.handler(event)
        } catch (err) {
          console.error('[createTestBus] handler threw:', err)
        }
      }
    },
    clear() {
      handlers.length = 0
    },
    get subscriberCount() {
      return handlers.length
    },
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _isMemoryObservationEvent(event: PipelineHookEvent): event is MemoryObservationEvent {
  const obs = event['observation']
  if (typeof obs !== 'object' || obs === null) return false
  const o = obs as Record<string, unknown>
  if (typeof o['kind'] !== 'string') return false
  if (!['pattern', 'convention', 'decision', 'deviation'].includes(o['kind'] as string)) {
    return false
  }
  if (typeof o['confidence'] !== 'number') return false
  if (typeof o['scope'] !== 'object' || o['scope'] === null) return false
  return true
}
