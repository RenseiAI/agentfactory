/**
 * Worker Fleet Runner — Programmatic API for the worker fleet manager CLI.
 *
 * Spawns and manages multiple worker processes for parallel agent execution.
 * Each worker runs as a separate OS process with its own resources.
 */

import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { getVersion, checkForUpdate, printUpdateNotification } from './version.js'
import { maybeAutoUpdate, isAutoUpdateEnabled } from './auto-updater.js'

// ---------------------------------------------------------------------------
// Public config interface
// ---------------------------------------------------------------------------

export interface FleetRunnerConfig {
  /** Number of worker processes (default: CPU cores / 2) */
  workers?: number
  /** Agents per worker (default: 3) */
  capacity?: number
  /** Show configuration without starting workers (default: false) */
  dryRun?: boolean
  /** Coordinator API URL (required) */
  apiUrl: string
  /** API key for authentication (required) */
  apiKey: string
  /** Path to the worker script/binary (default: auto-detect from this package) */
  workerScript?: string
  /** Linear project names for workers to accept (undefined = all) */
  projects?: string[]
  /** Enable auto-update (CLI flag override) */
  autoUpdate?: boolean
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WorkerInfo {
  id: number
  process: ChildProcess
  color: string
  startedAt: Date
  restartCount: number
}

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
}

const workerColors = [
  colors.cyan,
  colors.magenta,
  colors.yellow,
  colors.green,
  colors.blue,
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false })
}

/**
 * Sanitize child process output for re-printing with a prefix.
 *
 * Child processes (Claude CLI, git, etc.) may emit:
 * - \r carriage returns (spinners, progress bars)
 * - ANSI cursor-position sequences (\x1b[nG, \x1b[nC, \x1b[K, etc.)
 *
 * When we re-print each line with a [W##] prefix, leftover \r causes the
 * prefix to be overwritten and cursor-position escapes shift text to random
 * columns. Strip these so each line renders cleanly at column 0.
 */
function sanitizeWorkerOutput(raw: string): string {
  return raw
    // For lines containing \r (spinner updates), keep only the last segment
    .replace(/[^\n]*\r(?!\n)/g, '')
    // Strip ANSI cursor-position sequences: CSI n G (absolute), CSI n C (forward),
    // CSI n D (backward), CSI K (erase line), CSI n J (erase display)
    .replace(/\x1b\[\d*[GCDKJ]/g, '')
    .trim()
}

function fleetLog(
  workerId: number | null,
  color: string,
  level: string,
  message: string,
): void {
  const prefix =
    workerId !== null
      ? `[W${workerId.toString().padStart(2, '0')}]`
      : '[FLEET]'
  const levelColor =
    level === 'ERR' ? colors.red : level === 'WRN' ? colors.yellow : colors.gray
  // Use \r\n explicitly — child processes (Claude CLI) can disable the
  // terminal's onlcr setting via /dev/tty, causing bare \n to LF without CR.
  process.stdout.write(
    `${colors.gray}${timestamp()}${colors.reset} ${color}${prefix}${colors.reset} ${levelColor}${level}${colors.reset} ${message}\r\n`,
  )
}

/**
 * Resolve when the given child process has exited. If it has *already* exited
 * by the time this is called, the returned promise resolves immediately.
 *
 * Exported for testing. The naive
 *
 *   new Promise<void>((resolve) => child.on('exit', () => resolve()))
 *
 * pattern deadlocks when the exit event has already fired: Node does not
 * re-emit `exit` to handlers registered after the fact. That matters for the
 * fleet's shutdown path because SIGINT reaches worker children directly
 * through the process group, so they often exit before the parent's shutdown
 * code gets to register its listener.
 */
export function waitForProcessExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
  })
}

function getDefaultWorkerScript(): string {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  // Runner lives in lib/, worker entry is one level up.
  // When running from compiled dist/ the .js file exists; when running from
  // source via tsx only the .ts file exists.
  const jsPath = path.resolve(__dirname, '..', 'worker.js')
  if (fs.existsSync(jsPath)) return jsPath
  return path.resolve(__dirname, '..', 'worker.ts')
}

// ---------------------------------------------------------------------------
// WorkerFleet class (internal)
// ---------------------------------------------------------------------------

class WorkerFleet {
  private workers: Map<number, WorkerInfo> = new Map()
  private readonly fleetConfig: {
    workers: number
    capacity: number
    dryRun: boolean
    apiUrl: string
    apiKey: string
    projects?: string[]
  }
  private shuttingDown = false
  private readonly workerScript: string
  private readonly autoUpdateFlag?: boolean
  private resolveRunning: (() => void) | null = null
  private updateInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    fleetConfig: {
      workers: number
      capacity: number
      dryRun: boolean
      apiUrl: string
      apiKey: string
      projects?: string[]
    },
    workerScript: string,
    autoUpdateFlag?: boolean,
  ) {
    this.fleetConfig = fleetConfig
    this.workerScript = workerScript
    this.autoUpdateFlag = autoUpdateFlag
  }

  async start(signal?: AbortSignal): Promise<void> {
    const { workers, capacity, dryRun } = this.fleetConfig
    const totalCapacity = workers * capacity
    const version = getVersion()

    // Use \r\n throughout — child processes can disable onlcr via /dev/tty
    process.stdout.write(`\r\n${colors.cyan}================================================================${colors.reset}\r\n${colors.cyan}  AgentFactory Worker Fleet Manager${colors.reset} ${colors.gray}v${version}${colors.reset}\r\n${colors.cyan}================================================================${colors.reset}\r\n  Workers:         ${colors.green}${workers}${colors.reset}\r\n  Capacity/Worker: ${colors.green}${capacity}${colors.reset}\r\n  Total Capacity:  ${colors.green}${totalCapacity}${colors.reset} concurrent agents\r\n  Projects:        ${colors.green}${this.fleetConfig.projects?.length ? this.fleetConfig.projects.join(', ') : 'all'}${colors.reset}\r\n  Auto-update:     ${isAutoUpdateEnabled(this.autoUpdateFlag) ? `${colors.green}enabled${colors.reset}` : `${colors.gray}disabled${colors.reset}`}\r\n\r\n  System:\r\n    CPU Cores:    ${os.cpus().length}\r\n    Total RAM:    ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB\r\n    Free RAM:     ${Math.round(os.freemem() / 1024 / 1024 / 1024)} GB\r\n${colors.cyan}================================================================${colors.reset}\r\n`)

    // Update check
    const updateCheck = await checkForUpdate()
    printUpdateNotification(updateCheck)

    if (dryRun) {
      process.stdout.write(`${colors.yellow}Dry run mode - not starting workers${colors.reset}\r\n`)
      return
    }

    // Wire up AbortSignal for graceful shutdown.
    //
    // The `shuttingDown` flag is set SYNCHRONOUSLY here, not inside the async
    // `shutdown()` body. Otherwise when SIGINT hits the process group
    // (terminal Ctrl+C), worker children receive the signal and exit before
    // the parent's `shutdown()` has a chance to run — and the exit handler
    // at spawnWorker() misinterprets those clean exits as crashes and
    // schedules restarts. Setting the flag here closes that race window.
    const onAbort = () => {
      this.shuttingDown = true
      void this.shutdown('AbortSignal')
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      // Spawn workers with staggered start to avoid thundering herd
      for (let i = 0; i < workers; i++) {
        if (signal?.aborted) break
        await this.spawnWorker(i)
        if (i < workers - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }

      if (signal?.aborted) return

      fleetLog(null, colors.green, 'INF', `All ${workers} workers started`)

      // Periodic auto-update check (every 4 hours)
      if (isAutoUpdateEnabled(this.autoUpdateFlag)) {
        this.updateInterval = setInterval(async () => {
          const check = await checkForUpdate()
          await maybeAutoUpdate(check, {
            cliFlag: this.autoUpdateFlag,
            hasActiveWorkers: async () => this.workers.size > 0 && !this.shuttingDown,
            onBeforeRestart: async () => this.shutdown('auto-update'),
          })
        }, 4 * 60 * 60 * 1000) // 4 hours
      }

      // Keep the fleet manager running until shutdown
      await new Promise<void>((resolve) => {
        this.resolveRunning = resolve
      })
    } finally {
      if (this.updateInterval) clearInterval(this.updateInterval)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async spawnWorker(id: number): Promise<void> {
    const color = workerColors[id % workerColors.length]
    const existingWorker = this.workers.get(id)
    const restartCount = existingWorker?.restartCount ?? 0

    fleetLog(
      id,
      color,
      'INF',
      `Starting worker (capacity: ${this.fleetConfig.capacity})${restartCount > 0 ? ` [restart #${restartCount}]` : ''}`,
    )

    const nodeArgs: string[] = []
    // When running a .ts worker script, register tsx so Node can load it
    if (this.workerScript.endsWith('.ts')) {
      nodeArgs.push('--import', 'tsx')
    }
    nodeArgs.push(
      this.workerScript,
      '--capacity',
      String(this.fleetConfig.capacity),
      '--api-url',
      this.fleetConfig.apiUrl,
      '--api-key',
      this.fleetConfig.apiKey,
    )
    if (this.fleetConfig.projects?.length) {
      nodeArgs.push('--projects', this.fleetConfig.projects.join(','))
    }

    const workerProcess = spawn(
      'node',
      nodeArgs,
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          WORKER_FLEET_ID: String(id),
        },
        cwd: process.cwd(),
      },
    )

    const workerInfo: WorkerInfo = {
      id,
      process: workerProcess,
      color,
      startedAt: new Date(),
      restartCount,
    }

    this.workers.set(id, workerInfo)

    // Handle stdout — prefix with worker ID
    // Child processes (especially Claude CLI) may emit \r for spinners/progress
    // and ANSI cursor-position sequences. Strip these so each line starts clean
    // at column 0 when re-printed with the [W##] prefix.
    const workerPrefix = `${color}[W${id.toString().padStart(2, '0')}]${colors.reset}`
    workerProcess.stdout?.on('data', (data: Buffer) => {
      const lines = sanitizeWorkerOutput(data.toString()).split('\n')
      for (const line of lines) {
        if (line.trim()) {
          process.stdout.write(`${workerPrefix} ${line}\r\n`)
        }
      }
    })

    // Handle stderr
    workerProcess.stderr?.on('data', (data: Buffer) => {
      const lines = sanitizeWorkerOutput(data.toString()).split('\n')
      for (const line of lines) {
        if (line.trim()) {
          process.stdout.write(`${workerPrefix} ${colors.red}${line}${colors.reset}\r\n`)
        }
      }
    })

    // Handle worker exit
    workerProcess.on('exit', (code, sig) => {
      if (this.shuttingDown) {
        fleetLog(id, color, 'INF', `Worker stopped (code: ${code}, signal: ${sig})`)
        return
      }

      fleetLog(
        id,
        color,
        'WRN',
        `Worker exited unexpectedly (code: ${code}, signal: ${sig}) - restarting in 5s`,
      )

      const worker = this.workers.get(id)
      if (worker) {
        worker.restartCount++
      }

      setTimeout(() => {
        if (!this.shuttingDown) {
          this.spawnWorker(id)
        }
      }, 5000)
    })

    workerProcess.on('error', (err) => {
      fleetLog(id, color, 'ERR', `Worker error: ${err.message}`)
    })
  }

  private shutdownStarted = false

  private async shutdown(reason: string): Promise<void> {
    if (this.shutdownStarted) return
    this.shutdownStarted = true
    // Also set `shuttingDown` — onAbort sets it synchronously on signal-driven
    // shutdown, but shutdown() can also be invoked directly (e.g., auto-update)
    // where that hasn't happened yet. Idempotent either way.
    this.shuttingDown = true

    process.stdout.write(
      `\r\n${colors.yellow}Received ${reason} - shutting down fleet...${colors.reset}\r\n`,
    )

    for (const [id, worker] of this.workers) {
      fleetLog(id, worker.color, 'INF', 'Stopping worker...')
      try {
        worker.process.kill('SIGTERM')
      } catch {
        // Process may already be dead — no-op.
      }
    }

    // Wait for workers to exit (max 30 seconds).
    const forceKillTimeout = setTimeout(() => {
      process.stdout.write(
        `${colors.red}Timeout waiting for workers - force killing${colors.reset}\r\n`,
      )
      for (const worker of this.workers.values()) {
        try {
          worker.process.kill('SIGKILL')
        } catch {
          // Already dead.
        }
      }
    }, 30000)

    await Promise.all(
      Array.from(this.workers.values()).map((worker) => waitForProcessExit(worker.process)),
    )

    clearTimeout(forceKillTimeout)

    process.stdout.write(`${colors.green}All workers stopped${colors.reset}\r\n`)

    // Resolve the running promise so start() returns
    this.resolveRunning?.()
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a fleet of worker processes.
 *
 * The caller can cancel via the optional {@link AbortSignal}. The function
 * returns once all workers have been stopped.
 */
export async function runWorkerFleet(
  config: FleetRunnerConfig,
  signal?: AbortSignal,
): Promise<void> {
  const workers =
    config.workers ?? Math.max(1, Math.floor(os.cpus().length / 2))
  const capacity = config.capacity ?? 3
  const dryRun = config.dryRun ?? false
  const workerScript = config.workerScript ?? getDefaultWorkerScript()

  const fleet = new WorkerFleet(
    {
      workers,
      capacity,
      dryRun,
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      projects: config.projects?.length ? config.projects : undefined,
    },
    workerScript,
    config.autoUpdate,
  )

  await fleet.start(signal)
}
