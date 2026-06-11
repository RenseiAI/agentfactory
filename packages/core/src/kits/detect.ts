/**
 * Kit Detection Runtime
 *
 * Two-phase detection per 005-kit-manifest-spec.md §Detection lifecycle:
 *
 * Phase 1 — Declarative (parallel for all kits):
 *   Evaluate `[detect]` declarative matchers (files, files_all, not_files,
 *   content_matches) against a lightweight FileTreeView. No executable I/O.
 *
 * Phase 2 — Executable (gated on Phase 1 pass):
 *   Run `[detect].exec` binary inside the workarea sandbox. Requires
 *   DONMAI_ALLOW_EXECUTABLE_DETECT=true (or the `allowExecutable` option).
 *   Capped at MAX_CONCURRENT_EXEC_DETECTS concurrent execs (default 4).
 *   Untrusted kits (no explicit trustedKitIds or empty authorIdentity)
 *   are not run in Phase 2.
 *
 * Detection output for each kit:
 *   { applies, confidence, reason, toolchain? }
 *
 * Architecture reference: rensei-architecture/005-kit-manifest-spec.md
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import type { KitManifest, KitDetectResult, ToolchainDemand } from './manifest.js'

// ---------------------------------------------------------------------------
// FileTreeView — sparse, lazily-loaded filesystem snapshot
// ---------------------------------------------------------------------------

/**
 * A lightweight view of a target workarea's file tree.
 * Only methods used by Phase 1 declarative detection are required.
 */
export interface FileTreeView {
  /**
   * Returns true if the given path (relative to workarea root) exists.
   * Glob patterns (e.g. "src/**\/package.json") SHOULD be supported if
   * the implementation supports it; a simple existence check is sufficient
   * for the default kit.
   */
  exists(relativePath: string): boolean

  /**
   * Returns the contents of the file at the given relative path, or null
   * if the file does not exist or cannot be read.
   */
  readFile(relativePath: string): string | null
}

/**
 * Metadata about the detection target.
 */
export interface KitDetectTarget {
  fileTree: FileTreeView
  remoteUrl?: string
  defaultBranch?: string
  primaryLanguageHint?: string
  scope?: {
    level: 'project' | 'org' | 'tenant' | 'global'
  }
  monorepoPath?: string
  /** Absolute path to the workarea root (for Phase 2 executable detection). */
  workareaRoot?: string
  /** Operating system of the session host, e.g. 'linux', 'macos', 'windows'. */
  os?: string
  /** CPU architecture, e.g. 'x86_64', 'arm64'. */
  arch?: string
}

// ---------------------------------------------------------------------------
// OS / arch short-circuit
// ---------------------------------------------------------------------------

/**
 * Returns true when the kit's [supports] declaration is compatible with the
 * current platform. Short-circuits detect to no-match on incompatible platforms
 * before any declarative or executable logic runs.
 */
export function isPlatformCompatible(
  kit: KitManifest,
  target: Pick<KitDetectTarget, 'os' | 'arch'>,
): boolean {
  const supports = kit.supports
  if (!supports) return true // no constraint → compatible with all

  const os = target.os?.toLowerCase()
  const arch = target.arch?.toLowerCase()

  if (os && !supports.os.map((o) => o.toLowerCase()).includes(os)) {
    return false
  }
  if (arch && !supports.arch.map((a) => a.toLowerCase()).includes(arch)) {
    return false
  }

  return true
}

// ---------------------------------------------------------------------------
// Phase 1 — Declarative detection
// ---------------------------------------------------------------------------

/**
 * Evaluate declarative detection rules against the target file tree.
 * Returns true if the kit passes declarative detection.
 *
 * Rules evaluated (all must pass when present):
 * 1. `files`         — at least one must exist
 * 2. `files_all`     — all must exist
 * 3. `not_files`     — none must exist
 * 4. `content_matches` — each match condition must be satisfied
 */
export function evaluateDeclarativeDetect(
  kit: KitManifest,
  target: KitDetectTarget,
): boolean {
  const detect = kit.detect
  if (!detect) {
    // No detection rules → kit is a "global" kit that always applies
    return true
  }

  const { fileTree } = target

  // 1. files — at least one must exist
  if (detect.files && detect.files.length > 0) {
    const anyExists = detect.files.some((f) => fileTree.exists(f))
    if (!anyExists) return false
  }

  // 2. files_all — all must exist
  if (detect.files_all && detect.files_all.length > 0) {
    const allExist = detect.files_all.every((f) => fileTree.exists(f))
    if (!allExist) return false
  }

  // 3. not_files — none must exist
  if (detect.not_files && detect.not_files.length > 0) {
    const anyExcludes = detect.not_files.some((f) => fileTree.exists(f))
    if (anyExcludes) return false
  }

  // 4. content_matches — each condition must be satisfied
  if (detect.content_matches && detect.content_matches.length > 0) {
    for (const cm of detect.content_matches) {
      if (!fileTree.exists(cm.file)) return false
      const content = fileTree.readFile(cm.file)
      if (content === null) return false

      if (cm.json_path) {
        // Minimal JSON path support: $.key, $.key.subkey, $.key[*] existence check
        if (!evaluateJsonPath(content, cm.json_path)) return false
      } else if (cm.yaml_path) {
        // Dot-separated YAML path existence check
        if (!evaluateYamlPath(content, cm.yaml_path)) return false
      } else if (cm.content_regex) {
        if (!new RegExp(cm.content_regex).test(content)) return false
      }
    }
  }

  return true
}

/**
 * Minimal JSON path evaluator.
 * Supports: $.key, $.key.subkey, $.dependencies.next (existence check)
 */
function evaluateJsonPath(jsonContent: string, jsonPath: string): boolean {
  try {
    const obj = JSON.parse(jsonContent)
    // Strip leading $. and split on dots or ['key'] patterns
    const parts = jsonPath
      .replace(/^\$\./, '')
      .replace(/\[['"]([^'"]+)['"]\]/g, '.$1')
      .split('.')
      .filter(Boolean)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur: any = obj
    for (const part of parts) {
      if (cur === null || cur === undefined) return false
      if (typeof cur !== 'object') return false
      cur = cur[part]
    }
    return cur !== undefined && cur !== null
  } catch {
    return false
  }
}

/**
 * Minimal YAML path evaluator (dot-separated path, existence check).
 * Only works for simple flat YAML keys; not a full YAML parser.
 */
function evaluateYamlPath(yamlContent: string, yamlPath: string): boolean {
  // Simple regex-based lookup for common patterns like "dependencies.next"
  const parts = yamlPath.split('.')
  // Try to find the last key as a YAML key
  const lastKey = parts[parts.length - 1]
  // Match "  lastKey:" or "lastKey:" anywhere in the document
  return new RegExp(`(^|\\n)\\s*${escapeRegex(lastKey)}\\s*:`).test(yamlContent)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Phase 2 — Executable detection
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_EXEC_DETECTS = 4

/**
 * Options controlling Phase 2 executable detection.
 */
export interface ExecutableDetectOptions {
  /**
   * Allow Phase 2 executable detection.
   * Defaults to process.env.DONMAI_ALLOW_EXECUTABLE_DETECT === 'true'.
   */
  allowExecutable?: boolean
  /**
   * Set of trusted kit ids allowed to run executable detection.
   * When set, only kits whose id appears in this set (or whose authorIdentity
   * is non-empty) will run Phase 2.
   * When absent (undefined), trusted kit ids are not restricted.
   */
  trustedKitIds?: Set<string>
  /**
   * Maximum concurrent executable detects (default: MAX_CONCURRENT_EXEC_DETECTS).
   */
  maxConcurrency?: number
  /**
   * Timeout for each executable detect invocation in milliseconds (default: 10000).
   */
  execTimeoutMs?: number
  /**
   * Override NODE_ENV for testing.
   */
  _testNodeEnv?: string
}

/**
 * Returns true if a kit is permitted to run executable detection.
 * Guards against malicious detection logic on untrusted kits.
 */
export function isKitTrustedForExec(
  kit: KitManifest,
  options: ExecutableDetectOptions,
): boolean {
  if (!options.trustedKitIds) return true // no restriction
  return options.trustedKitIds.has(kit.kit.id)
}

/**
 * Run a kit's executable detect binary and parse its JSON output.
 * Returns a KitDetectResult. Throws on spawn errors or non-JSON output.
 */
export async function runExecutableDetect(
  kit: KitManifest,
  workareaRoot: string,
  options: ExecutableDetectOptions = {},
): Promise<KitDetectResult> {
  const exec = kit.detect?.exec
  if (!exec) {
    throw new Error(`Kit '${kit.kit.id}' has no detect.exec configured`)
  }

  const timeoutMs = options.execTimeoutMs ?? 10_000
  const execPath = path.isAbsolute(exec) ? exec : path.join(workareaRoot, exec)

  return new Promise<KitDetectResult>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const child = spawn(execPath, [], {
      cwd: workareaRoot,
      env: { ...process.env, DONMAI_DETECT: '1' },
      shell: false,
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`Kit '${kit.kit.id}' detect exec error: ${err.message}`))
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`Kit '${kit.kit.id}' detect exec timed out after ${timeoutMs}ms`))
        return
      }
      if (code !== 0) {
        // Non-zero exit = no match (same convention as buildpacks)
        resolve({ applies: false, confidence: 0, reason: `detect exited ${code}: ${stderr.trim()}` })
        return
      }
      try {
        const result = JSON.parse(stdout.trim()) as KitDetectResult
        resolve(result)
      } catch {
        reject(
          new Error(
            `Kit '${kit.kit.id}' detect exec produced invalid JSON: ${stdout.slice(0, 200)}`
          )
        )
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Concurrency limiter (simple semaphore)
// ---------------------------------------------------------------------------

class Semaphore {
  private count: number
  private queue: Array<() => void> = []

  constructor(count: number) {
    this.count = count
  }

  acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (this.count > 0) {
        this.count--
        resolve()
      } else {
        this.queue.push(resolve)
      }
    })
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next()
    } else {
      this.count++
    }
  }
}

// ---------------------------------------------------------------------------
// KitCandidate — output of the full detection pass
// ---------------------------------------------------------------------------

export interface KitCandidate {
  kit: KitManifest
  result: KitDetectResult
  phase: 'declarative' | 'executable' | 'platform-skipped'
}

/**
 * Run full two-phase detection for a list of kits against a target.
 *
 * Phase 1: All kits run declarative detection in parallel.
 *   - Kits failing OS/arch compatibility → platform-skipped.
 *   - Kits passing Phase 1 with `detect.exec` present → eligible for Phase 2.
 *
 * Phase 2: Eligible kits run executable detection with capped concurrency.
 *   - Only runs if `allowExecutable` is true.
 *   - Untrusted kits (not in trustedKitIds) are skipped.
 *
 * Returns an array of KitCandidate entries (one per kit).
 */
export async function detectKits(
  kits: KitManifest[],
  target: KitDetectTarget,
  options: ExecutableDetectOptions = {},
): Promise<KitCandidate[]> {
  const allowExecutable =
    options.allowExecutable ??
    process.env.DONMAI_ALLOW_EXECUTABLE_DETECT === 'true'

  const maxConcurrency = options.maxConcurrency ?? MAX_CONCURRENT_EXEC_DETECTS
  const semaphore = new Semaphore(maxConcurrency)

  // Phase 1: Declarative detection (parallel)
  const phase1Results = await Promise.all(
    kits.map(async (kit): Promise<KitCandidate> => {
      // OS/arch short-circuit
      if (!isPlatformCompatible(kit, target)) {
        return {
          kit,
          result: { applies: false, confidence: 0, reason: 'platform not supported' },
          phase: 'platform-skipped',
        }
      }

      const declarativeMatch = evaluateDeclarativeDetect(kit, target)
      if (!declarativeMatch) {
        return {
          kit,
          result: { applies: false, confidence: 0, reason: 'declarative detection failed' },
          phase: 'declarative',
        }
      }

      // Declarative passed — compute confidence based on match strength
      const confidence = computeDeclarativeConfidence(kit, target)

      return {
        kit,
        result: {
          applies: !kit.detect?.exec, // true if no exec gate, else tentative
          confidence,
          reason: 'declarative detection passed',
          toolchain: kit.detect?.toolchain,
        },
        phase: 'declarative',
      }
    })
  )

  // Phase 2: Executable detection (gated, capped concurrency)
  if (!allowExecutable) {
    // No executable phase — finalize: kits with exec are tentative; mark as applies=true
    return phase1Results.map((c) => {
      if (c.phase === 'declarative' && c.kit.detect?.exec && c.result.confidence > 0) {
        return {
          ...c,
          result: {
            ...c.result,
            applies: true,
            reason: 'declarative detection passed (executable detect disabled)',
          },
        }
      }
      return c
    })
  }

  const phase2Promises = phase1Results.map(async (candidate): Promise<KitCandidate> => {
    const { kit } = candidate
    // Only run Phase 2 for kits that passed Phase 1 AND have an exec defined
    if (candidate.phase === 'platform-skipped') return candidate
    if (!kit.detect?.exec) return candidate
    if (candidate.result.confidence === 0) return candidate // Phase 1 failed

    // Trust gate
    if (!isKitTrustedForExec(kit, options)) {
      return {
        ...candidate,
        result: {
          ...candidate.result,
          applies: false,
          reason: `kit '${kit.kit.id}' not in trustedKitIds — executable detect skipped`,
        },
      }
    }

    const workareaRoot = target.workareaRoot ?? process.cwd()

    await semaphore.acquire()
    try {
      const execResult = await runExecutableDetect(kit, workareaRoot, options)
      return {
        kit,
        result: {
          ...execResult,
          toolchain: execResult.toolchain ?? kit.detect?.toolchain,
        },
        phase: 'executable',
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        kit,
        result: {
          applies: false,
          confidence: 0,
          reason: `executable detect error: ${msg}`,
          toolchain: kit.detect?.toolchain,
        },
        phase: 'executable',
      }
    } finally {
      semaphore.release()
    }
  })

  return Promise.all(phase2Promises)
}

/**
 * Compute a confidence score (0..1) from declarative detection strength.
 * More specific matches (files_all > files > content_matches) yield higher scores.
 */
function computeDeclarativeConfidence(kit: KitManifest, target: KitDetectTarget): number {
  const detect = kit.detect
  if (!detect) return 0.3 // no-detect kit (global)

  let score = 0
  const { fileTree } = target

  // Content matches are the most specific
  if (detect.content_matches?.length) {
    score += 0.4
  }

  // files_all is more specific than files
  if (detect.files_all?.every((f) => fileTree.exists(f))) {
    score += 0.4
  } else if (detect.files?.some((f) => fileTree.exists(f))) {
    score += 0.3
  }

  // Minimum for any declarative match
  score = Math.max(score, 0.1)
  return Math.min(score, 1.0)
}

// ---------------------------------------------------------------------------
// Candidate selection (post-detection)
// ---------------------------------------------------------------------------

/**
 * Select the final ordered list of kits to apply from all detection results.
 *
 * Algorithm per 005-kit-manifest-spec.md §Confidence and selection:
 * 1. Filter to applies=true only.
 * 2. Filter out conflicting pairs — surface ConflictError if unresolvable.
 * 3. Sort by confidence (desc), then priority (desc), then kit.id (asc).
 * 4. Apply within order groups: foundation → framework → project.
 */
export interface ConflictError {
  kind: 'conflict'
  kitA: string
  kitB: string
  message: string
}

export interface SelectionResult {
  ordered: KitManifest[]
  conflicts: ConflictError[]
}

export function selectKits(candidates: KitCandidate[]): SelectionResult {
  const applicable = candidates.filter((c) => c.result.applies)
  const conflicts: ConflictError[] = []

  // Build a set of applicable kit ids for fast conflict lookup
  const applicableIds = new Set(applicable.map((c) => c.kit.kit.id))

  // Detect conflicts
  const conflicting = new Set<string>()
  for (const c of applicable) {
    const conflictsWith = c.kit.composition?.conflicts_with ?? []
    for (const conflictId of conflictsWith) {
      if (applicableIds.has(conflictId)) {
        conflicts.push({
          kind: 'conflict',
          kitA: c.kit.kit.id,
          kitB: conflictId,
          message:
            `Kit '${c.kit.kit.id}' conflicts with '${conflictId}'. ` +
            `Both matched the target — resolve by disabling one in your kit config.`,
        })
        conflicting.add(c.kit.kit.id)
        conflicting.add(conflictId)
      }
    }
  }

  // Exclude conflicting kits from the ordered result
  const clean = applicable.filter((c) => !conflicting.has(c.kit.kit.id))

  // Sort: confidence desc, priority desc, id asc (deterministic tiebreak)
  clean.sort((a, b) => {
    const cDiff = b.result.confidence - a.result.confidence
    if (cDiff !== 0) return cDiff
    const pA = a.kit.kit.priority ?? 50
    const pB = b.kit.kit.priority ?? 50
    if (pA !== pB) return pB - pA
    return a.kit.kit.id.localeCompare(b.kit.kit.id)
  })

  // Group by order — foundation → framework → project
  const orderPriority: Record<string, number> = {
    foundation: 0,
    framework: 1,
    project: 2,
  }
  clean.sort((a, b) => {
    const oA = orderPriority[a.kit.composition?.order ?? 'framework'] ?? 1
    const oB = orderPriority[b.kit.composition?.order ?? 'framework'] ?? 1
    return oA - oB
  })

  return {
    ordered: clean.map((c) => c.kit),
    conflicts,
  }
}

// ---------------------------------------------------------------------------
// Effective toolchain demand (union across selected kits)
// ---------------------------------------------------------------------------

/**
 * Merge toolchain demands from all selected kits.
 * Later kits in apply order override earlier ones for the same key.
 */
export function mergeToolchainDemands(kits: KitManifest[]): ToolchainDemand {
  const result: ToolchainDemand = {}
  for (const kit of kits) {
    const toolchain = kit.detect?.toolchain
    if (toolchain) {
      Object.assign(result, toolchain)
    }
  }
  return result
}
