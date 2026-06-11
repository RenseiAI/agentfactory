/**
 * VCS diff reader for the Architectural Intelligence observation pipeline.
 *
 * Architecture reference: donmai-architecture/007-intelligence-services.md
 * §"Architectural Intelligence" — Inference pipeline
 * Architecture reference: donmai-architecture/008-version-control-providers.md
 *
 * This module reads merged PRs and commit diffs via the VCS provider and
 * converts them into ArchObservation candidates that the pipeline can
 * cluster, score, and contribute to the graph.
 *
 * Design decisions:
 *
 * - The diff reader is provider-orthogonal: it accepts a `PrDiff` value
 *   object (not a GitHub-specific type) so test code can inject synthetic
 *   diffs without touching GitHub.
 *
 * - Pattern inference from diffs is heuristic and intentionally simple:
 *   file-path regex patterns detect architectural zones (auth, db, api, test,
 *   migration); keyword patterns detect conventions (Result<T,E>, try/catch,
 *   async/await, etc.). These are "weak signal" observations at inferred-low
 *   or inferred-medium confidence.
 *
 * - Decision inference: PR titles/descriptions that match ADR-style keywords
 *   ("chose X over Y", "picked X because", "migrating from X to Y") produce
 *   'decision' observations.
 *
 * - The reader never makes real VCS calls. Its job is to analyze already-
 *   fetched diff text. Callers (pipeline.ts) are responsible for obtaining
 *   the diffs.
 *
 * - Confidence caps:
 *   - File-path zone detection → 0.45 (inferred-medium boundary)
 *   - Keyword convention detection → 0.50
 *   - ADR-style decision detection → 0.60
 *   All capped at 0.95 maximum (inference cap from 007).
 */

import type { ArchObservation, ArchScope, ChangeRef } from './types.js'

// ---------------------------------------------------------------------------
// PrDiff — provider-orthogonal diff input
// ---------------------------------------------------------------------------

/**
 * A merged pull request's diff data.
 * Callers (pipeline.ts) populate this from their VCS provider.
 * Tests inject synthetic values.
 */
export interface PrDiff {
  /** Repository identifier (used to build ChangeRef) */
  repository: string

  /** PR number in the source VCS */
  prNumber: number

  /** PR title */
  title: string

  /**
   * PR body / description. May contain acceptance criteria, rationale,
   * design notes — the most information-dense field for architectural inference.
   */
  body: string

  /** List of files changed in this PR */
  files: PrFileDiff[]

  /** Acceptance criteria extracted from the PR body (optional, pre-parsed) */
  acceptanceCriteria?: string[]
}

export interface PrFileDiff {
  /** Relative path of the changed file */
  path: string

  /** Unified diff patch text (the +/- lines) */
  patch: string

  /** Whether the file was added (true) or modified/deleted (false) */
  added: boolean
}

// ---------------------------------------------------------------------------
// DiffReaderConfig
// ---------------------------------------------------------------------------

export interface DiffReaderConfig {
  /** Override the default inference confidence cap (default: 0.95) */
  inferenceConfidenceCap?: number
}

// ---------------------------------------------------------------------------
// readDiffObservations — main entry point
// ---------------------------------------------------------------------------

/**
 * Analyze a PR diff and produce ArchObservation candidates.
 *
 * This function does NOT write to the graph — it returns raw candidates.
 * The pipeline is responsible for clustering + contributing.
 *
 * @param diff   - The PR diff to analyze.
 * @param scope  - The architectural scope to assign to produced observations.
 * @param config - Optional tuning.
 * @returns Array of ArchObservation candidates (may be empty if no signals found).
 */
export function readDiffObservations(
  diff: PrDiff,
  scope: ArchScope,
  config: DiffReaderConfig = {},
): ArchObservation[] {
  const cap = config.inferenceConfidenceCap ?? 0.95
  const changeRef: ChangeRef = {
    repository: diff.repository,
    kind: 'pr',
    prNumber: diff.prNumber,
    description: diff.title,
  }

  const observations: ArchObservation[] = []

  // 1. File-path zone inference → pattern observations
  const zoneObs = _inferZonePatterns(diff.files, changeRef, scope, cap)
  observations.push(...zoneObs)

  // 2. Convention detection from diff patches → convention observations
  const conventionObs = _inferConventions(diff.files, changeRef, scope, cap)
  observations.push(...conventionObs)

  // 3. Decision inference from PR title + body → decision observations
  const decisionObs = _inferDecisions(diff, changeRef, scope, cap)
  observations.push(...decisionObs)

  // 4. Acceptance criteria → pattern/convention observations (higher confidence)
  if (diff.acceptanceCriteria && diff.acceptanceCriteria.length > 0) {
    const acObs = _inferFromAcceptanceCriteria(
      diff.acceptanceCriteria,
      changeRef,
      scope,
      cap,
    )
    observations.push(...acObs)
  }

  return observations
}

// ---------------------------------------------------------------------------
// Zone pattern inference
// ---------------------------------------------------------------------------

/** Architectural zone definitions: regex on file path → zone label */
const ZONE_PATTERNS: Array<{ regex: RegExp; zone: string; tag: string }> = [
  { regex: /\/(auth|authentication|authorization|middleware)\//i, zone: 'Auth layer', tag: 'auth' },
  { regex: /\/(db|database|orm|migrations?|schema)\//i, zone: 'Database layer', tag: 'database' },
  { regex: /\/(api|routes?|endpoints?|controllers?|handlers?)\//i, zone: 'API layer', tag: 'api' },
  { regex: /\/(tests?|spec|__tests?__|e2e|integration)\//i, zone: 'Test layer', tag: 'testing' },
  { regex: /\/(domain|core|entities|models)\//i, zone: 'Domain layer', tag: 'domain' },
  { regex: /\/(adapters?|providers?|infra|infrastructure)\//i, zone: 'Infrastructure layer', tag: 'infra' },
  { regex: /\/(components?|ui|views?|pages?)\//i, zone: 'UI layer', tag: 'ui' },
  { regex: /\/(hooks?|composables?|stores?)\//i, zone: 'State layer', tag: 'state' },
  { regex: /\/(config|configs?|settings?)\//i, zone: 'Config layer', tag: 'config' },
  { regex: /\/(utils?|helpers?|lib|shared)\//i, zone: 'Shared utilities', tag: 'utils' },
]

function _inferZonePatterns(
  files: PrFileDiff[],
  changeRef: ChangeRef,
  scope: ArchScope,
  cap: number,
): ArchObservation[] {
  // Count files per zone
  const zoneCounts = new Map<string, { count: number; paths: string[]; tag: string }>()

  for (const file of files) {
    for (const zp of ZONE_PATTERNS) {
      if (zp.regex.test('/' + file.path)) {
        const existing = zoneCounts.get(zp.zone) ?? { count: 0, paths: [], tag: zp.tag }
        existing.count++
        existing.paths.push(file.path)
        zoneCounts.set(zp.zone, existing)
      }
    }
  }

  const observations: ArchObservation[] = []

  for (const [zone, data] of zoneCounts) {
    if (data.count < 1) continue

    // Confidence scales with evidence: 1 file = 0.35, 3+ files = 0.45
    const confidence = Math.min(0.35 + data.count * 0.03, Math.min(0.55, cap))

    observations.push({
      kind: 'pattern',
      payload: {
        title: `${zone} pattern`,
        description:
          `Files in the ${zone.toLowerCase()} zone were modified in PR #${changeRef.prNumber}: ` +
          `${data.paths.slice(0, 3).join(', ')}${data.paths.length > 3 ? ` (+${data.paths.length - 3} more)` : ''}.`,
        locations: data.paths.slice(0, 5).map((path) => ({ path })),
        tags: [data.tag, 'inferred', 'pr-analysis'],
      },
      source: { changeRef },
      confidence,
      scope,
    })
  }

  return observations
}

// ---------------------------------------------------------------------------
// Convention detection from patches
// ---------------------------------------------------------------------------

/** Keyword patterns for convention detection */
const CONVENTION_SIGNALS: Array<{
  regex: RegExp
  title: string
  description: string
  tag: string
  confidence: number
}> = [
  {
    regex: /Result<[A-Za-z,\s]+>/g,
    title: 'Result<T, E> error handling',
    description: 'Code uses Result<T, E> pattern for error propagation instead of throwing.',
    tag: 'error-handling',
    confidence: 0.55,
  },
  {
    regex: /\basync\b.*\bawait\b/,
    title: 'Async/await concurrency',
    description: 'Code consistently uses async/await for asynchronous operations.',
    tag: 'async',
    confidence: 0.40,
  },
  {
    regex: /interface\s+[A-Z][A-Za-z]+\s*\{/,
    title: 'TypeScript interface-first typing',
    description: 'New types are defined as interfaces rather than type aliases or classes.',
    tag: 'typescript',
    confidence: 0.45,
  },
  {
    regex: /export\s+(const|function|class|interface|type)\s+[A-Z]/,
    title: 'Named exports convention',
    description: 'Modules use named exports for public API surface.',
    tag: 'modules',
    confidence: 0.40,
  },
  {
    regex: /describe\s*\(|it\s*\(|test\s*\(/,
    title: 'Vitest/Jest test structure',
    description: 'Tests use describe/it/test block structure.',
    tag: 'testing',
    confidence: 0.50,
  },
  {
    regex: /\.toThrow\(|expect\.assertions\(/,
    title: 'Explicit error assertion testing',
    description: 'Tests explicitly assert on thrown errors.',
    tag: 'testing',
    confidence: 0.45,
  },
]

function _inferConventions(
  files: PrFileDiff[],
  changeRef: ChangeRef,
  scope: ArchScope,
  cap: number,
): ArchObservation[] {
  // Aggregate added lines from all patches
  const addedLines = files
    .flatMap((f) => f.patch.split('\n').filter((l) => l.startsWith('+')))
    .join('\n')

  const observations: ArchObservation[] = []
  const seen = new Set<string>()

  for (const signal of CONVENTION_SIGNALS) {
    if (seen.has(signal.title)) continue
    if (signal.regex.test(addedLines)) {
      seen.add(signal.title)
      observations.push({
        kind: 'convention',
        payload: {
          title: signal.title,
          description: signal.description,
          examples: files
            .filter((f) => signal.regex.test(f.patch))
            .slice(0, 3)
            .map((f) => ({ path: f.path })),
        },
        source: { changeRef },
        confidence: Math.min(signal.confidence, cap),
        scope,
      })
    }
  }

  return observations
}

// ---------------------------------------------------------------------------
// Decision inference from PR metadata
// ---------------------------------------------------------------------------

/** Patterns that indicate an architectural decision was made in this PR */
const DECISION_SIGNALS: Array<{
  regex: RegExp
  extract: (match: RegExpMatchArray, text: string) => { title: string; chosen: string; rationale: string } | null
}> = [
  {
    // "chose X over Y" / "picked X over Y" / "selected X over Y"
    regex: /\b(chose|picked|selected|choosing|picking|using|switched?(?:\s+to)?)\s+([A-Za-z0-9_\-.@/]+)\s+(?:over|instead\s+of|rather\s+than)\s+([A-Za-z0-9_\-.@/]+)/i,
    extract: (match) => ({
      title: `${match[2]} chosen over ${match[3]}`,
      chosen: match[2] ?? '',
      rationale: `${match[1]} ${match[2]} over ${match[3]} (inferred from PR title/body)`,
    }),
  },
  {
    // "migrated? from X to Y"
    regex: /\b(migrat(?:e|ed|ing|ion))\s+(?:from\s+)?([A-Za-z0-9_\-.@/]+)\s+to\s+([A-Za-z0-9_\-.@/]+)/i,
    extract: (match) => ({
      title: `Migration from ${match[2]} to ${match[3]}`,
      chosen: match[3] ?? '',
      rationale: `Migration from ${match[2]} to ${match[3]} (inferred from PR title/body)`,
    }),
  },
  {
    // "replaced X with Y"
    regex: /\b(replac(?:e|ed|ing))\s+([A-Za-z0-9_\-.@/]+)\s+with\s+([A-Za-z0-9_\-.@/]+)/i,
    extract: (match) => ({
      title: `${match[3]} replaces ${match[2]}`,
      chosen: match[3] ?? '',
      rationale: `Replaced ${match[2]} with ${match[3]} (inferred from PR title/body)`,
    }),
  },
]

function _inferDecisions(
  diff: PrDiff,
  changeRef: ChangeRef,
  scope: ArchScope,
  cap: number,
): ArchObservation[] {
  const text = `${diff.title}\n${diff.body}`
  const observations: ArchObservation[] = []

  for (const signal of DECISION_SIGNALS) {
    const match = text.match(signal.regex)
    if (!match) continue
    const extracted = signal.extract(match, text)
    if (!extracted) continue

    observations.push({
      kind: 'decision',
      payload: {
        title: extracted.title,
        chosen: extracted.chosen,
        alternatives: [],
        rationale: extracted.rationale,
        status: 'active',
      },
      source: { changeRef },
      confidence: Math.min(0.60, cap),
      scope,
    })
  }

  return observations
}

// ---------------------------------------------------------------------------
// Acceptance criteria inference
// ---------------------------------------------------------------------------

/**
 * Infer pattern/convention observations from structured acceptance criteria.
 *
 * AC items that describe behaviours (must, should, always, never) are
 * treated as convention observations at slightly higher confidence (0.65)
 * since they represent explicit intent.
 */
function _inferFromAcceptanceCriteria(
  ac: string[],
  changeRef: ChangeRef,
  scope: ArchScope,
  cap: number,
): ArchObservation[] {
  const observations: ArchObservation[] = []

  for (const item of ac) {
    const trimmed = item.trim()
    if (trimmed.length < 10) continue

    // Convention signal: AC items with normative language
    const normative = /\b(must|should|always|never|required|shall)\b/i.test(trimmed)
    const kind: ArchObservation['kind'] = normative ? 'convention' : 'pattern'
    const confidence = Math.min(normative ? 0.65 : 0.50, cap)

    observations.push({
      kind,
      payload: {
        title: _acTitle(trimmed),
        description: `Acceptance criterion from PR #${changeRef.prNumber}: ${trimmed}`,
        ...(kind === 'convention' ? { examples: [{ path: `PR #${changeRef.prNumber}` }] } : {}),
        ...(kind === 'pattern' ? { locations: [], tags: ['ac', 'pr-analysis'] } : {}),
      },
      source: { changeRef },
      confidence,
      scope,
    })
  }

  return observations
}

/** Truncate and clean an AC item into a short title */
function _acTitle(ac: string): string {
  const cleaned = ac
    .replace(/^[-*[\]#\s]+/, '') // strip leading list markers
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length <= 80 ? cleaned : cleaned.slice(0, 77) + '...'
}
