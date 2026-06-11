/**
 * Drift detection — unit and integration tests
 *
 * Architecture reference: rensei-architecture/007-intelligence-services.md
 * §"Architectural Intelligence" — Drift detection
 *
 * REN-1326: Tests for drift.ts and sqlite-impl.ts assessWithAdapter().
 *
 * Verifies:
 *   1. Known-divergent PR → DriftReport with expected deviations.
 *   2. Clean PR → empty DriftReport (no deviations).
 *   3. Threshold gating: zero-deviations, no-severity-high, max:N.
 *   4. resolveDriftGatePolicy reads DONMAI_DRIFT_GATE env.
 *   5. assessChange persists deviations via ai.contribute().
 *   6. SqliteArchitecturalIntelligence.assessWithAdapter() integration.
 *   7. Empty baseline → informational report (no crash).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { SqliteArchitecturalIntelligence } from './sqlite-impl.js'
import { assessChange, resolveDriftGatePolicy, evaluateGate } from './drift.js'
import { createFixedAdapter, createStubAdapter } from './eval.js'
import type { ArchScope, ChangeRef, Deviation, ArchObservation } from './types.js'
import type { PrDiff } from './diff-reader.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_SCOPE: ArchScope = { level: 'project', projectId: 'test-project' }

const CLEAN_PR_CHANGE: ChangeRef = {
  repository: 'github.com/test/repo',
  kind: 'pr',
  prNumber: 100,
  description: 'Add unit tests for auth module',
}

const DIVERGENT_PR_CHANGE: ChangeRef = {
  repository: 'github.com/test/repo',
  kind: 'pr',
  prNumber: 101,
  description: 'Add new API route with inline auth',
}

/**
 * A PR diff that aligns with existing patterns.
 * Files: auth layer and tests only — consistent with established patterns.
 */
const CLEAN_PR_DIFF: PrDiff = {
  repository: 'github.com/test/repo',
  prNumber: 100,
  title: 'Add unit tests for auth module',
  body: 'Adds comprehensive unit tests for the auth middleware. No functional changes.',
  files: [
    {
      path: 'src/__tests__/auth.test.ts',
      patch: `
+import { describe, it, expect } from 'vitest'
+describe('auth middleware', () => {
+  it('delegates to lib/auth/middleware.ts', () => {
+    expect(true).toBe(true)
+  })
+})
`,
      added: true,
    },
  ],
}

/**
 * A PR diff that introduces auth inline — diverges from established pattern.
 * The baseline pattern says "auth is centralized in lib/auth/middleware.ts".
 */
const DIVERGENT_PR_DIFF: PrDiff = {
  repository: 'github.com/test/repo',
  prNumber: 101,
  title: 'Add new public API endpoint',
  body: 'Adds a new public endpoint. Implements auth inline for simplicity.',
  files: [
    {
      path: 'src/api/routes/public-data.ts',
      patch: `
+export async function handler(req: Request) {
+  // Inline auth check — bypasses central middleware for performance
+  const token = req.headers.get('authorization')
+  if (!token || !validateToken(token)) {
+    return new Response('Unauthorized', { status: 401 })
+  }
+  return new Response(JSON.stringify({ data: [] }))
+}
`,
      added: true,
    },
  ],
}

// ---------------------------------------------------------------------------
// Golden DriftReport: what we expect for a divergent PR
// ---------------------------------------------------------------------------

/**
 * JSON the stub adapter returns for the divergent PR.
 * Simulates the LLM detecting that inline auth deviates from the central-auth pattern.
 */
function makeGoldenDeviationOutput(patternId: string): string {
  const deviations: ArchObservation[] = [
    {
      kind: 'deviation',
      payload: {
        title: 'Inline auth bypasses central auth middleware',
        description:
          'The new route /api/public-data implements auth inline instead of delegating ' +
          'to lib/auth/middleware.ts. This contradicts the established auth-centralization pattern.',
        deviatesFrom: { kind: 'pattern', id: patternId },
        severity: 'high',
      },
      source: {
        changeRef: DIVERGENT_PR_CHANGE,
      },
      confidence: 0.85,
      scope: PROJECT_SCOPE,
    },
  ]
  return JSON.stringify(deviations)
}

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `drift-test-${randomUUID().slice(0, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeImpl(dir: string): SqliteArchitecturalIntelligence {
  return new SqliteArchitecturalIntelligence({ dbPath: join(dir, 'db.sqlite') })
}

/**
 * Seed the baseline with one auth-centralization pattern.
 * Returns the pattern's id so it can be referenced in golden outputs.
 */
async function seedBaseline(ai: SqliteArchitecturalIntelligence): Promise<string> {
  // Contribute a pattern observation
  await ai.contribute({
    kind: 'pattern',
    payload: {
      title: 'Auth centralized in middleware',
      description:
        'All API routes delegate to lib/auth/middleware.ts for authentication. ' +
        'No route may implement auth logic inline.',
      locations: [{ path: 'lib/auth/middleware.ts', role: 'central auth' }],
      tags: ['auth', 'middleware', 'security'],
    },
    source: { sessionId: 'seed-session' },
    confidence: 0.9,
    scope: PROJECT_SCOPE,
  })

  // Return the pattern id (first stored pattern)
  const view = await ai.query({ workType: 'qa', scope: PROJECT_SCOPE })
  const pattern = view.patterns[0]
  if (!pattern) throw new Error('Baseline seeding failed — no pattern stored')
  return pattern.id
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string
let ai: SqliteArchitecturalIntelligence

beforeEach(() => {
  tmpDir = makeTmpDir()
  ai = makeImpl(tmpDir)
})

afterEach(() => {
  try { ai.close() } catch { /* already closed */ }
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// TEST GROUP 1: Clean PR → empty DriftReport
// ---------------------------------------------------------------------------

describe('clean PR → empty DriftReport', () => {
  it('stub adapter returning [] produces empty deviations', async () => {
    await seedBaseline(ai)

    // Stub adapter: always returns empty array (no deviations detected)
    const adapter = createFixedAdapter('[]')

    const report = await assessChange(ai, adapter, {
      change: CLEAN_PR_CHANGE,
      prDiff: CLEAN_PR_DIFF,
      scope: PROJECT_SCOPE,
    })

    expect(report.deviations).toHaveLength(0)
    expect(report.hasCriticalDrift).toBe(false)
    expect(report.change.prNumber).toBe(100)
  })

  it('clean PR report summary mentions no deviations', async () => {
    await seedBaseline(ai)
    const adapter = createFixedAdapter('[]')

    const report = await assessChange(ai, adapter, {
      change: CLEAN_PR_CHANGE,
      scope: PROJECT_SCOPE,
    })

    expect(report.summary).toMatch(/no architectural deviations/i)
  })

  it('clean PR reinforces existing patterns', async () => {
    await seedBaseline(ai)
    const adapter = createFixedAdapter('[]')

    const report = await assessChange(ai, adapter, {
      change: CLEAN_PR_CHANGE,
      scope: PROJECT_SCOPE,
    })

    // All known patterns are in the reinforced list
    expect(report.reinforced.length).toBeGreaterThan(0)
    expect(report.reinforced[0]?.kind).toBe('pattern')
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP 2: Divergent PR → expected DriftReport
// ---------------------------------------------------------------------------

describe('divergent PR → DriftReport with expected deviations', () => {
  it('produces one high-severity deviation for inline auth', async () => {
    const patternId = await seedBaseline(ai)

    // Stub adapter: returns the golden deviation for this pattern id
    const adapter = createFixedAdapter(makeGoldenDeviationOutput(patternId))

    const report = await assessChange(ai, adapter, {
      change: DIVERGENT_PR_CHANGE,
      prDiff: DIVERGENT_PR_DIFF,
      scope: PROJECT_SCOPE,
    })

    expect(report.deviations).toHaveLength(1)
    expect(report.deviations[0]?.severity).toBe('high')
    expect(report.deviations[0]?.title).toContain('auth')
    expect(report.hasCriticalDrift).toBe(true)
    expect(report.change.prNumber).toBe(101)
  })

  it('deviation has correct deviatesFrom reference', async () => {
    const patternId = await seedBaseline(ai)
    const adapter = createFixedAdapter(makeGoldenDeviationOutput(patternId))

    const report = await assessChange(ai, adapter, {
      change: DIVERGENT_PR_CHANGE,
      scope: PROJECT_SCOPE,
    })

    const deviation = report.deviations[0]!
    expect(deviation.deviatesFrom.kind).toBe('pattern')
    if (deviation.deviatesFrom.kind === 'pattern') {
      expect(deviation.deviatesFrom.patternId).toBe(patternId)
    }
  })

  it('deviation is persisted via ai.contribute()', async () => {
    const patternId = await seedBaseline(ai)
    const adapter = createFixedAdapter(makeGoldenDeviationOutput(patternId))

    await assessChange(ai, adapter, {
      change: DIVERGENT_PR_CHANGE,
      scope: PROJECT_SCOPE,
    })

    // Verify the deviation was materialized into the DB
    const storedDeviations = ai._getAllDeviations()
    expect(storedDeviations.length).toBeGreaterThan(0)
    expect(storedDeviations[0]?.severity).toBe('high')
  })

  it('summary mentions critical drift when high-severity found', async () => {
    const patternId = await seedBaseline(ai)
    const adapter = createFixedAdapter(makeGoldenDeviationOutput(patternId))

    const report = await assessChange(ai, adapter, {
      change: DIVERGENT_PR_CHANGE,
      scope: PROJECT_SCOPE,
    })

    expect(report.summary).toMatch(/1 deviation/i)
    expect(report.summary).toMatch(/critical/i)
  })

  it('divergent pattern is not in reinforced list', async () => {
    const patternId = await seedBaseline(ai)
    const adapter = createFixedAdapter(makeGoldenDeviationOutput(patternId))

    const report = await assessChange(ai, adapter, {
      change: DIVERGENT_PR_CHANGE,
      scope: PROJECT_SCOPE,
    })

    // The deviated pattern id should NOT be in reinforced
    const reinforcedPatternIds = report.reinforced
      .filter((r) => r.kind === 'pattern')
      .map((r) => (r as { kind: 'pattern'; patternId: string }).patternId)

    expect(reinforcedPatternIds).not.toContain(patternId)
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP 3: Threshold gating
// ---------------------------------------------------------------------------

describe('threshold gating', () => {
  it("'none' policy never gates", () => {
    const deviations = [makeDeviation('high')] as Deviation[]
    expect(evaluateGate(deviations, 'none')).toBe(false)
  })

  it("'zero-deviations' gates on any deviation", () => {
    const deviations = [makeDeviation('low')] as Deviation[]
    expect(evaluateGate(deviations, 'zero-deviations')).toBe(true)
    expect(evaluateGate([], 'zero-deviations')).toBe(false)
  })

  it("'no-severity-high' gates only on high-severity deviations", () => {
    expect(evaluateGate([makeDeviation('high')], 'no-severity-high')).toBe(true)
    expect(evaluateGate([makeDeviation('medium')], 'no-severity-high')).toBe(false)
    expect(evaluateGate([makeDeviation('low')], 'no-severity-high')).toBe(false)
    expect(evaluateGate([], 'no-severity-high')).toBe(false)
  })

  it("{ maxCount: 2 } gates when count > 2", () => {
    const one = [makeDeviation('low')]
    const two = [makeDeviation('low'), makeDeviation('low')]
    const three = [makeDeviation('low'), makeDeviation('low'), makeDeviation('low')]

    expect(evaluateGate(one, { maxCount: 2 })).toBe(false)
    expect(evaluateGate(two, { maxCount: 2 })).toBe(false)
    expect(evaluateGate(three, { maxCount: 2 })).toBe(true)
  })

  it("{ maxCount: 0 } gates on any deviation", () => {
    expect(evaluateGate([makeDeviation('low')], { maxCount: 0 })).toBe(true)
    expect(evaluateGate([], { maxCount: 0 })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP 4: resolveDriftGatePolicy
// ---------------------------------------------------------------------------

describe('resolveDriftGatePolicy', () => {
  afterEach(() => {
    delete process.env['DONMAI_DRIFT_GATE']
  })

  it('explicit policy takes precedence over env', () => {
    process.env['DONMAI_DRIFT_GATE'] = 'none'
    expect(resolveDriftGatePolicy('zero-deviations')).toBe('zero-deviations')
  })

  it('reads DONMAI_DRIFT_GATE env when no explicit policy', () => {
    process.env['DONMAI_DRIFT_GATE'] = 'zero-deviations'
    expect(resolveDriftGatePolicy()).toBe('zero-deviations')
  })

  it("defaults to 'no-severity-high' when env is unset", () => {
    delete process.env['DONMAI_DRIFT_GATE']
    expect(resolveDriftGatePolicy()).toBe('no-severity-high')
  })

  it("parses 'max:3' into { maxCount: 3 }", () => {
    process.env['DONMAI_DRIFT_GATE'] = 'max:3'
    const policy = resolveDriftGatePolicy()
    expect(policy).toEqual({ maxCount: 3 })
  })

  it("parses 'max:0' into { maxCount: 0 }", () => {
    process.env['DONMAI_DRIFT_GATE'] = 'max:0'
    const policy = resolveDriftGatePolicy()
    expect(policy).toEqual({ maxCount: 0 })
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP 5: Empty baseline → informational report
// ---------------------------------------------------------------------------

describe('empty baseline → informational report', () => {
  it('returns an informational report when no patterns/conventions/decisions exist', async () => {
    // Don't seed the baseline — ai is fresh
    const adapter = createFixedAdapter('[]')

    const report = await assessChange(ai, adapter, {
      change: CLEAN_PR_CHANGE,
      scope: PROJECT_SCOPE,
    })

    expect(report.deviations).toHaveLength(0)
    expect(report.hasCriticalDrift).toBe(false)
    expect(report.summary).toMatch(/no established architectural baseline/i)
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP 6: SqliteArchitecturalIntelligence.assessWithAdapter()
// ---------------------------------------------------------------------------

describe('SqliteArchitecturalIntelligence.assessWithAdapter()', () => {
  it('assessWithAdapter() runs full drift detection flow', async () => {
    const patternId = await seedBaseline(ai)
    const adapter = createFixedAdapter(makeGoldenDeviationOutput(patternId))

    const report = await ai.assessWithAdapter(
      DIVERGENT_PR_CHANGE,
      adapter,
      DIVERGENT_PR_DIFF,
      PROJECT_SCOPE,
    )

    expect(report.deviations).toHaveLength(1)
    expect(report.hasCriticalDrift).toBe(true)
  })

  it('assess() without adapter returns informational report', async () => {
    const report = await ai.assess(CLEAN_PR_CHANGE)
    expect(report.deviations).toHaveLength(0)
    expect(report.summary).toMatch(/no model adapter/i)
  })

  it('assess() with adapter set via setModelAdapter() uses it', async () => {
    await seedBaseline(ai)
    const adapter = createFixedAdapter('[]')
    ai.setModelAdapter(adapter)

    const report = await ai.assess(CLEAN_PR_CHANGE)
    expect(report.deviations).toHaveLength(0)
    expect(report.summary).toMatch(/no architectural deviations/i)
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP 7: Multiple deviations — severity mix
// ---------------------------------------------------------------------------

describe('multiple deviations — severity mix', () => {
  it('report correctly counts by severity', async () => {
    await seedBaseline(ai)

    // Adapter returns 3 deviations with mixed severity
    const view = await ai.query({ workType: 'qa', scope: PROJECT_SCOPE })
    const patternId = view.patterns[0]!.id

    const multiDeviationOutput = JSON.stringify([
      {
        kind: 'deviation',
        payload: {
          title: 'High deviation',
          description: 'Critical issue',
          deviatesFrom: { kind: 'pattern', id: patternId },
          severity: 'high',
        },
        source: {},
        confidence: 0.9,
        scope: PROJECT_SCOPE,
      },
      {
        kind: 'deviation',
        payload: {
          title: 'Medium deviation',
          description: 'Moderate issue',
          deviatesFrom: { kind: 'pattern', id: patternId },
          severity: 'medium',
        },
        source: {},
        confidence: 0.7,
        scope: PROJECT_SCOPE,
      },
      {
        kind: 'deviation',
        payload: {
          title: 'Low deviation',
          description: 'Minor issue',
          deviatesFrom: { kind: 'pattern', id: patternId },
          severity: 'low',
        },
        source: {},
        confidence: 0.5,
        scope: PROJECT_SCOPE,
      },
    ])

    const adapter = createFixedAdapter(multiDeviationOutput)
    const report = await assessChange(ai, adapter, {
      change: DIVERGENT_PR_CHANGE,
      scope: PROJECT_SCOPE,
    })

    expect(report.deviations).toHaveLength(3)
    expect(report.hasCriticalDrift).toBe(true)

    const highCount = report.deviations.filter((d) => d.severity === 'high').length
    const medCount = report.deviations.filter((d) => d.severity === 'medium').length
    const lowCount = report.deviations.filter((d) => d.severity === 'low').length

    expect(highCount).toBe(1)
    expect(medCount).toBe(1)
    expect(lowCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// TEST GROUP 8: Model adapter errors are surfaced
// ---------------------------------------------------------------------------

describe('model adapter errors are surfaced', () => {
  it('throws when adapter.complete() rejects', async () => {
    await seedBaseline(ai)

    const failingAdapter: import('./eval.js').ModelAdapter = {
      async complete(): Promise<string> {
        throw new Error('Network timeout')
      },
    }

    await expect(
      assessChange(ai, failingAdapter, {
        change: CLEAN_PR_CHANGE,
        scope: PROJECT_SCOPE,
      }),
    ).rejects.toThrow(/Network timeout/)
  })

  it('throws when adapter returns malformed JSON', async () => {
    await seedBaseline(ai)

    const badAdapter = createFixedAdapter('not valid json {{{')

    await expect(
      assessChange(ai, badAdapter, {
        change: CLEAN_PR_CHANGE,
        scope: PROJECT_SCOPE,
      }),
    ).rejects.toThrow(/parse deviation-detection output/i)
  })
})

// ---------------------------------------------------------------------------
// Private helper: create a Deviation fixture
// ---------------------------------------------------------------------------

function makeDeviation(severity: 'high' | 'medium' | 'low'): Deviation {
  return {
    id: randomUUID(),
    title: `${severity} deviation`,
    description: 'Test deviation',
    deviatesFrom: { kind: 'pattern', patternId: 'test-pattern-id' },
    status: 'pending',
    severity,
    citations: [],
    scope: PROJECT_SCOPE,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}
