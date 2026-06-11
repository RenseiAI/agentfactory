/**
 * Operational Scanner — Vercel template tests (REN-1328)
 *
 * Verifies that the operational-scanner-vercel YAML template:
 *   1. Loads and renders correctly via the TemplateRegistry.
 *   2. Carries the correct tool allow/disallow configuration
 *      (Principle 1: --parentId is disallowed).
 *   3. Instructs the agent to scan for deploy failures, function timeouts,
 *      and cold-start regressions.
 *   4. Instructs the agent to dedupe against existing issues before authoring.
 *   5. Documents the mock-data note.
 *
 * Data source note: the live Vercel plugin is NOT done. All tests use
 * fixture data that simulates what a live Vercel source would return.
 * The scanner prompt explicitly documents this.
 */

import { describe, it, expect } from 'vitest'
import { TemplateRegistry } from '../../templates/registry.js'

// ---------------------------------------------------------------------------
// Fixtures — mock Vercel deploy events
// ---------------------------------------------------------------------------

/** A Vercel deploy event fixture representing a build failure. */
interface VercelDeployEvent {
  deployId: string
  projectName: string
  status: 'ready' | 'error' | 'cancelled'
  buildError?: string
  branch: string
  commitSha: string
  timestamp: string
}

/** A Vercel function metrics fixture representing a timeout or cold-start regression. */
interface VercelFunctionMetrics {
  functionName: string
  deployId: string
  timeoutCount: number
  coldStartP95Ms: number
  coldStartBaselineP95Ms: number
  timestamp: string
}

/** Fixture: 3 deploy failures all sharing the same build error signature. */
const FIXTURE_DEPLOY_FAILURES: VercelDeployEvent[] = [
  {
    deployId: 'dpl_001',
    projectName: 'rensei-app',
    status: 'error',
    buildError: 'Module not found: Error: Can\'t resolve \'@renseiai/plugin-vercel\'',
    branch: 'main',
    commitSha: 'abc123',
    timestamp: '2026-04-26T10:00:00Z',
  },
  {
    deployId: 'dpl_002',
    projectName: 'rensei-app',
    status: 'error',
    buildError: 'Module not found: Error: Can\'t resolve \'@renseiai/plugin-vercel\'',
    branch: 'main',
    commitSha: 'def456',
    timestamp: '2026-04-26T11:00:00Z',
  },
  {
    deployId: 'dpl_003',
    projectName: 'rensei-app',
    status: 'error',
    buildError: 'Module not found: Error: Can\'t resolve \'@renseiai/plugin-vercel\'',
    branch: 'main',
    commitSha: 'ghi789',
    timestamp: '2026-04-26T12:00:00Z',
  },
]

/** Fixture: function timeout events for the same function. */
const FIXTURE_FUNCTION_TIMEOUTS: VercelFunctionMetrics[] = [
  {
    functionName: '/api/agent-session',
    deployId: 'dpl_100',
    timeoutCount: 5,
    coldStartP95Ms: 800,
    coldStartBaselineP95Ms: 600,
    timestamp: '2026-04-26T09:00:00Z',
  },
  {
    functionName: '/api/agent-session',
    deployId: 'dpl_101',
    timeoutCount: 3,
    coldStartP95Ms: 850,
    coldStartBaselineP95Ms: 600,
    timestamp: '2026-04-26T13:00:00Z',
  },
]

/** Fixture: cold-start regression exceeding threshold (>50% increase). */
const FIXTURE_COLD_START_REGRESSION: VercelFunctionMetrics = {
  functionName: '/api/webhook-handler',
  deployId: 'dpl_200',
  timeoutCount: 0,
  coldStartP95Ms: 3200,      // Current p95: 3.2s
  coldStartBaselineP95Ms: 1100, // Baseline: 1.1s (~190% regression)
  timestamp: '2026-04-26T14:00:00Z',
}

// ---------------------------------------------------------------------------
// Helpers — minimal scanner logic for fixture-driven tests
// ---------------------------------------------------------------------------

interface VercelCluster {
  type: 'deploy-failure' | 'function-timeout' | 'cold-start-regression'
  key: string
  count: number
  examples: string[]
}

/**
 * Cluster Vercel deploy failures by build-error signature.
 * In production the agent does this via LLM reasoning; here we do it
 * deterministically for test coverage.
 */
function clusterDeployFailures(events: VercelDeployEvent[]): VercelCluster[] {
  const map = new Map<string, string[]>()
  for (const ev of events) {
    if (ev.status !== 'error' || !ev.buildError) continue
    // Use first 60 chars as cluster key (signature)
    const key = ev.buildError.slice(0, 60)
    const ids = map.get(key) ?? []
    ids.push(ev.deployId)
    map.set(key, ids)
  }
  return Array.from(map.entries())
    .filter(([, ids]) => ids.length >= 2)
    .map(([key, ids]) => ({
      type: 'deploy-failure' as const,
      key,
      count: ids.length,
      examples: ids,
    }))
}

/**
 * Cluster function timeout events by function name.
 */
function clusterFunctionTimeouts(events: VercelFunctionMetrics[]): VercelCluster[] {
  const map = new Map<string, string[]>()
  for (const ev of events) {
    if (ev.timeoutCount === 0) continue
    const ids = map.get(ev.functionName) ?? []
    ids.push(ev.deployId)
    map.set(ev.functionName, ids)
  }
  return Array.from(map.entries())
    .filter(([, ids]) => ids.length >= 2)
    .map(([key, ids]) => ({
      type: 'function-timeout' as const,
      key,
      count: ids.length,
      examples: ids,
    }))
}

/**
 * Detect cold-start regressions (p95 increased by >50% vs baseline).
 */
function detectColdStartRegressions(events: VercelFunctionMetrics[]): VercelCluster[] {
  return events
    .filter(ev => {
      const ratio = ev.coldStartP95Ms / ev.coldStartBaselineP95Ms
      return ratio > 1.5 // >50% regression threshold
    })
    .map(ev => ({
      type: 'cold-start-regression' as const,
      key: ev.functionName,
      count: 1,
      examples: [ev.deployId],
    }))
}

/**
 * Build a bug-report issue spec from a Vercel cluster.
 * Mirrors what the agent prompt instructs — no --parentId.
 */
function buildBugReportSpec(cluster: VercelCluster, scanRunId: string): {
  title: string
  state: string
  labels: string[]
  hasParentId: false
} {
  return {
    title: `${cluster.type}: ${cluster.key.slice(0, 50)}`,
    state: 'Backlog',
    labels: ['bug', 'source:vercel', `provenance:scan-${scanRunId}`],
    hasParentId: false as const,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRegistry(): TemplateRegistry {
  return TemplateRegistry.create({ useBuiltinDefaults: true })
}

function render(registry: TemplateRegistry, extras: Record<string, unknown> = {}): string {
  const result = registry.renderPrompt('operational-scanner-vercel' as never, {
    identifier: 'REN-SCAN',
    ...extras,
  })
  expect(result, 'operational-scanner-vercel template must be registered and renderable').not.toBeNull()
  return result as string
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('operational-scanner-vercel template (REN-1328)', () => {
  // -------------------------------------------------------------------------
  // 1. Template loading and rendering
  // -------------------------------------------------------------------------
  describe('template loading and rendering', () => {
    it('loads via TemplateRegistry built-in defaults', () => {
      const registry = buildRegistry()
      expect(registry.hasTemplate('operational-scanner-vercel' as never)).toBe(true)
    })

    it('renders with identifier variable', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('REN-SCAN')
    })

    it('has a non-empty prompt', () => {
      const registry = buildRegistry()
      const template = registry.getTemplate('operational-scanner-vercel' as never)
      expect(template?.prompt.trim().length).toBeGreaterThan(100)
    })

    it('rendered prompt includes mentionContext when provided', () => {
      const registry = buildRegistry()
      const result = render(registry, { mentionContext: 'Focus on prod project only' })
      expect(result).toContain('Focus on prod project only')
    })

    it('rendered prompt omits mentionContext section when not provided', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).not.toContain('Additional context from the user')
    })
  })

  // -------------------------------------------------------------------------
  // 2. Tool permissions (Principle 1 enforcement)
  // -------------------------------------------------------------------------
  describe('tool permissions (Principle 1 enforcement)', () => {
    it('allows af-linear create-issue (standalone bug-report issues)', () => {
      const registry = buildRegistry()
      const { allow } = registry.getRawToolPermissions('operational-scanner-vercel' as never)
      const shellPatterns = allow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellPatterns.some(p => p.includes('create-issue'))).toBe(true)
    })

    it('disallows af-linear create-issue --parentId * (no sub-issues per Principle 1)', () => {
      const registry = buildRegistry()
      const { disallow } = registry.getRawToolPermissions('operational-scanner-vercel' as never)
      const shellDisallowed = disallow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellDisallowed.some(p => p.includes('--parentId'))).toBe(true)
    })

    it('disallows user-input (fully autonomous, cron-safe)', () => {
      const registry = buildRegistry()
      const { disallow } = registry.getRawToolPermissions('operational-scanner-vercel' as never)
      expect(disallow).toContain('user-input')
    })

    it('allows af-linear list-issues (needed for dedupe check)', () => {
      const registry = buildRegistry()
      const { allow } = registry.getRawToolPermissions('operational-scanner-vercel' as never)
      const shellPatterns = allow
        .filter((p): p is { shell: string } => typeof p === 'object' && 'shell' in p)
        .map(p => p.shell)
      expect(shellPatterns.some(p => p.includes('list-issues'))).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // 3. Signal types — prompt coverage
  // -------------------------------------------------------------------------
  describe('signal types covered in prompt', () => {
    it('prompt references deploy failures', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/deploy.*(fail|error)|fail.*deploy/i)
    })

    it('prompt references function timeouts', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/timeout/i)
    })

    it('prompt references cold-start regressions', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/cold.start/i)
    })
  })

  // -------------------------------------------------------------------------
  // 4. Mock-data note
  // -------------------------------------------------------------------------
  describe('mock-data documentation', () => {
    it('prompt documents that live Vercel binding is pending the live Vercel plugin', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('live Vercel plugin')
    })

    it('prompt instructs use of mock data source when live source is unavailable', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/mock|mocked/i)
    })
  })

  // -------------------------------------------------------------------------
  // 5. Dedupe instruction
  // -------------------------------------------------------------------------
  describe('dedupe against existing issues', () => {
    it('prompt instructs agent to search Linear for existing issues before creating', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('list-issues')
      // Should mention source:vercel or similar dedup key
      expect(result).toMatch(/source:vercel|vercel.*deploy.id/i)
    })

    it('prompt instructs agent to comment (not create) when duplicate found', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('create-comment')
      expect(result).toMatch(/duplicate|already.*exist|existing issue/i)
    })
  })

  // -------------------------------------------------------------------------
  // 6. Provenance tags
  // -------------------------------------------------------------------------
  describe('provenance tagging', () => {
    it('prompt instructs to tag issues with source:vercel', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('source:vercel')
    })

    it('prompt instructs to tag issues with provenance:scan-', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('provenance:scan-')
    })
  })

  // -------------------------------------------------------------------------
  // 7. Issue cap
  // -------------------------------------------------------------------------
  describe('issue cap enforcement', () => {
    it('prompt enforces a cap on issues created per scan', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toMatch(/cap|limit|at most|maximum|10 issue/i)
    })
  })

  // -------------------------------------------------------------------------
  // 8. WORK_RESULT markers
  // -------------------------------------------------------------------------
  describe('WORK_RESULT markers', () => {
    it('rendered prompt contains WORK_RESULT:passed marker', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('WORK_RESULT:passed')
    })

    it('rendered prompt contains WORK_RESULT:failed marker', () => {
      const registry = buildRegistry()
      const result = render(registry)
      expect(result).toContain('WORK_RESULT:failed')
    })
  })

  // -------------------------------------------------------------------------
  // 9. Fixture-driven clustering tests (no LLM needed)
  // -------------------------------------------------------------------------
  describe('Vercel fixture: deploy failure clustering', () => {
    it('clusters 3 deploy failures with identical build error into 1 cluster', () => {
      const clusters = clusterDeployFailures(FIXTURE_DEPLOY_FAILURES)
      expect(clusters).toHaveLength(1)
      expect(clusters[0].type).toBe('deploy-failure')
      expect(clusters[0].count).toBe(3)
    })

    it('drops single-event clusters (below minimum threshold of 2)', () => {
      const singleEvent: VercelDeployEvent[] = [FIXTURE_DEPLOY_FAILURES[0]]
      const clusters = clusterDeployFailures(singleEvent)
      expect(clusters).toHaveLength(0)
    })

    it('does not cluster successful deploys', () => {
      const successEvents: VercelDeployEvent[] = [
        { ...FIXTURE_DEPLOY_FAILURES[0], status: 'ready', buildError: undefined },
        { ...FIXTURE_DEPLOY_FAILURES[1], status: 'ready', buildError: undefined },
      ]
      const clusters = clusterDeployFailures(successEvents)
      expect(clusters).toHaveLength(0)
    })
  })

  describe('Vercel fixture: function timeout clustering', () => {
    it('clusters 2 timeout events for the same function', () => {
      const clusters = clusterFunctionTimeouts(FIXTURE_FUNCTION_TIMEOUTS)
      expect(clusters).toHaveLength(1)
      expect(clusters[0].type).toBe('function-timeout')
      expect(clusters[0].key).toBe('/api/agent-session')
      expect(clusters[0].count).toBe(2)
    })
  })

  describe('Vercel fixture: cold-start regression detection', () => {
    it('detects cold-start regression when p95 exceeds 150% of baseline', () => {
      const regressions = detectColdStartRegressions([FIXTURE_COLD_START_REGRESSION])
      expect(regressions).toHaveLength(1)
      expect(regressions[0].type).toBe('cold-start-regression')
      expect(regressions[0].key).toBe('/api/webhook-handler')
    })

    it('does not flag functions within normal range (<150% of baseline)', () => {
      const normalMetrics: VercelFunctionMetrics = {
        ...FIXTURE_COLD_START_REGRESSION,
        coldStartP95Ms: 1500,      // 1.5x baseline — exactly at threshold, not above
        coldStartBaselineP95Ms: 1100,
      }
      // 1500/1100 = 1.36 — under the 1.5 threshold
      const regressions = detectColdStartRegressions([normalMetrics])
      expect(regressions).toHaveLength(0)
    })
  })

  describe('Vercel fixture: bug-report issue spec', () => {
    it('builds a valid bug-report spec from a deploy-failure cluster', () => {
      const clusters = clusterDeployFailures(FIXTURE_DEPLOY_FAILURES)
      expect(clusters.length).toBeGreaterThan(0)

      const spec = buildBugReportSpec(clusters[0], 'REN-SCAN')

      expect(spec.state).toBe('Backlog')
      expect(spec.labels).toContain('bug')
      expect(spec.labels).toContain('source:vercel')
      expect(spec.labels.some(l => l.startsWith('provenance:scan-'))).toBe(true)
      expect(spec.hasParentId).toBe(false)
    })

    it('bug-report spec never carries a parentId (Principle 1 hard constraint)', () => {
      const clusters = clusterDeployFailures(FIXTURE_DEPLOY_FAILURES)
      for (const cluster of clusters) {
        const spec = buildBugReportSpec(cluster, 'REN-SCAN')
        expect(spec.hasParentId).toBe(false)
        expect(spec.title).not.toContain('--parentId')
      }
    })
  })
})
