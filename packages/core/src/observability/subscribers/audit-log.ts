/**
 * Audit-log subscriber — writes NDJSON audit records for every hook event.
 *
 * Architecture reference: rensei-architecture/002-provider-base-contract.md §Lifecycle hooks
 *
 * Configuration:
 *   DONMAI_AUDIT_LOG_PATH — path to the NDJSON file.
 *     Default: ./.donmai/audit/<YYYY-MM-DD>.ndjson
 *
 * The subscriber is opt-in: call registerAuditLogSubscriber(bus) to attach it.
 * Default behavior (auto-attach) is only enabled when DONMAI_AUDIT_ENABLE=true.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ProviderHookEvent } from '../../providers/base.js'
import type { HookBus, SubscriberFilter } from '../hooks.js'

// ---------------------------------------------------------------------------
// Audit record shape
// ---------------------------------------------------------------------------

/** Each line in the NDJSON audit log is an AuditRecord. */
export interface AuditRecord {
  /** ISO-8601 timestamp */
  ts: string
  /** The hook event kind */
  kind: ProviderHookEvent['kind']
  /** Provider id, family, and version (when the event carries a provider ref) */
  provider?: {
    id: string
    family: string
    version: string
  }
  /** Any additional event-specific fields (duration, verb, error message, etc.) */
  payload: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function defaultAuditLogPath(): string {
  const date = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  return resolve(process.cwd(), '.donmai', 'audit', `${date}.ndjson`)
}

function resolveAuditLogPath(): string {
  return process.env.DONMAI_AUDIT_LOG_PATH
    ? resolve(process.env.DONMAI_AUDIT_LOG_PATH)
    : defaultAuditLogPath()
}

// ---------------------------------------------------------------------------
// Event → AuditRecord conversion
// ---------------------------------------------------------------------------

function eventToRecord(event: ProviderHookEvent): AuditRecord {
  const ts = new Date().toISOString()
  const base: AuditRecord = { ts, kind: event.kind, payload: {} }

  // Attach provider ref when present
  if ('provider' in event && event.provider) {
    base.provider = {
      id: event.provider.id,
      family: event.provider.family,
      version: event.provider.version,
    }
  }

  // Build payload from event-specific fields
  switch (event.kind) {
    case 'pre-activate':
      // No extra fields beyond provider ref
      break

    case 'post-activate':
      base.payload = { durationMs: event.durationMs }
      break

    case 'pre-deactivate':
      base.payload = { reason: event.reason }
      break

    case 'post-deactivate':
      break

    case 'pre-verb':
      // Avoid logging sensitive args verbatim — truncate/redact deep objects.
      base.payload = { verb: event.verb, argsType: typeof event.args }
      break

    case 'post-verb':
      base.payload = { verb: event.verb, durationMs: event.durationMs }
      break

    case 'verb-error':
      base.payload = {
        verb: event.verb,
        error: event.error.message,
        stack: event.error.stack,
      }
      break

    case 'pre-tool-use':
      base.payload = {
        sessionId: event.sessionId,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        toolCategory: event.toolCategory,
        toolInputType: typeof event.toolInput,
      }
      break

    case 'post-tool-use':
      base.payload = {
        sessionId: event.sessionId,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        durationMs: event.durationMs,
        isError: event.isError,
        toolOutputLength: event.toolOutput.length,
      }
      break

    case 'tool-use-error':
      base.payload = {
        sessionId: event.sessionId,
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        error: event.error,
      }
      break

    case 'capability-mismatch':
      base.payload = { declared: event.declared, observed: event.observed }
      break

    case 'scope-resolved': {
      base.payload = {
        chosen: event.chosen.map((r) => `${r.family}/${r.id}@${r.version}`),
        rejected: event.rejected.map((r) => ({
          provider: `${r.provider.family}/${r.provider.id}@${r.provider.version}`,
          reason: r.reason,
        })),
      }
      break
    }

    default: {
      // Exhaustive: TypeScript will catch missing cases at compile time.
      const _exhaustive: never = event
      void _exhaustive
    }
  }

  return base
}

// ---------------------------------------------------------------------------
// Writer — appends a single NDJSON line
// ---------------------------------------------------------------------------

function writeRecord(record: AuditRecord, filePath: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, JSON.stringify(record) + '\n', { encoding: 'utf-8', flag: 'a' })
  } catch (err) {
    // Write failure should never crash the subscriber — log to stderr and continue.
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[audit-log] Failed to write to ${filePath}: ${message}`)
  }
}

// ---------------------------------------------------------------------------
// Subscriber registration
// ---------------------------------------------------------------------------

/** Options for the audit-log subscriber. */
export interface AuditLogSubscriberOptions {
  /**
   * Path to the NDJSON audit log file.
   * Defaults to DONMAI_AUDIT_LOG_PATH env var, then ./.donmai/audit/<date>.ndjson.
   */
  logPath?: string

  /**
   * Filter to apply to events. Defaults to all events.
   */
  filter?: SubscriberFilter

  /**
   * Override the writer function (for testing).
   */
  _writer?: (record: AuditRecord, filePath: string) => void
}

/**
 * Register the audit-log subscriber on the given bus.
 * Returns an unsubscribe function.
 *
 * @example
 * import { globalHookBus } from '../hooks.js'
 * import { registerAuditLogSubscriber } from './audit-log.js'
 *
 * const unsubscribe = registerAuditLogSubscriber(globalHookBus)
 * // ... later ...
 * unsubscribe()
 */
export function registerAuditLogSubscriber(
  bus: HookBus,
  options: AuditLogSubscriberOptions = {},
): () => void {
  const writer = options._writer ?? writeRecord
  const filter = options.filter ?? {}

  return bus.subscribe(filter, async (event) => {
    const filePath = options.logPath ?? resolveAuditLogPath()
    const record = eventToRecord(event)
    writer(record, filePath)
  })
}
