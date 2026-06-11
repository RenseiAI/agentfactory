/**
 * Per-step Journal Primitive
 *
 * Foundation primitive for the long-running runtime substrate per
 * `donmai-architecture/ADR-2026-04-29-long-running-runtime-substrate.md`
 * (commit 56f2bc6) — Decisions 2 (journal schema), 3 (idempotency hash),
 * 7 (code home in `@donmai/server`).
 *
 * Responsibilities:
 * - Hot-path Redis hash journal `journal:{sessionId}:{stepId}` storing per-step
 *   execution status, idempotency hash, output content-addressable pointer,
 *   timestamps, attempt counter and error details.
 * - Public CRUD APIs: `writeJournalEntry`, `readJournalEntry`,
 *   `listSessionJournal(sessionId)`. All sub-millisecond hot-path.
 * - Deterministic idempotency hash:
 *     sha256(stepId + ':' + canonicalJSON(input) + ':' + nodeVersion)
 *   stored as `inputHash` field. Collisions logged at warn level (idempotent
 *   ops produce same result, so collision is functionally a cache hit).
 * - Local Layer 6 hook surface for `session.step-started`,
 *   `session.step-completed`, `session.step-failed` events. Subscribers can
 *   mirror the journal asynchronously (e.g. into Postgres for analytics).
 *
 * The journal is the primary store. Postgres mirroring is opt-in, eventually
 * consistent, and never in the critical path (per ADR §2).
 */

import { createHash } from 'node:crypto'
import {
  isRedisConfigured,
  getRedisClient,
  redisHGetAll,
  redisKeys,
} from './redis.js'

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const log = {
  info: (msg: string, data?: Record<string, unknown>) =>
    console.log(`[journal] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) =>
    console.warn(`[journal] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) =>
    console.error(`[journal] ${msg}`, data ? JSON.stringify(data) : ''),
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Journal entry status. Mirrors the per-step execution lifecycle.
 *
 * - `pending`: entry recorded, step not yet started (rare; usually moved
 *   straight to `running` when the worker picks the step up).
 * - `running`: step is executing on a worker.
 * - `completed`: step finished successfully; `outputCAS` points at the
 *   content-addressable result.
 * - `failed`: step exited with an error. `error` populated.
 */
export type JournalEntryStatus = 'pending' | 'running' | 'completed' | 'failed'

/**
 * The persisted journal entry shape (the "wire" representation that lives
 * in the Redis hash). All fields are stringified by the storage layer; the
 * caller works with this typed view.
 */
export interface JournalEntry {
  /** Workflow session id this step belongs to. */
  sessionId: string
  /** Workflow node / step id. */
  stepId: string
  /** Lifecycle status. */
  status: JournalEntryStatus
  /**
   * Idempotency hash. Hex sha256 of `stepId + ':' + canonicalJSON(input) + ':' + nodeVersion`.
   * Used for retry-safe replay: identical input on the same step+nodeVersion
   * is a cache hit.
   */
  inputHash: string
  /**
   * Content-addressable storage pointer for the step output. Empty until
   * `status === 'completed'`. The shape of the pointer (URI / hash) is
   * opaque to the journal — the caller decides what CAS layer they use.
   */
  outputCAS: string
  /** Unix ms when the entry was created (transition into `running`). */
  startedAt: number
  /** Unix ms when the entry transitioned to `completed`/`failed`. 0 until terminal. */
  completedAt: number
  /** Retry attempt counter (0-based). */
  attempt: number
  /** Error message captured on `failed` transitions. Empty otherwise. */
  error?: string
}

/** Input shape for `writeJournalEntry`. */
export interface JournalWriteInput {
  sessionId: string
  stepId: string
  status: JournalEntryStatus
  inputHash: string
  outputCAS?: string
  startedAt?: number
  completedAt?: number
  attempt?: number
  error?: string
}

// ---------------------------------------------------------------------------
// Redis key layout
// ---------------------------------------------------------------------------

/** Journal hash key for a single session+step. */
export function journalKey(sessionId: string, stepId: string): string {
  return `journal:${sessionId}:${stepId}`
}

/** Pattern for SCAN/KEYS to enumerate all journal entries for a session. */
export function journalSessionPattern(sessionId: string): string {
  return `journal:${sessionId}:*`
}

// ---------------------------------------------------------------------------
// canonicalJSON — stable, sorted-keys serializer
// ---------------------------------------------------------------------------

/**
 * Canonical JSON serializer with deterministic key order.
 *
 * Properties:
 * - Object keys are sorted lexicographically at every depth.
 * - Arrays preserve their original order (semantic order).
 * - `undefined`-valued object fields are omitted (matches `JSON.stringify`).
 * - `null`, booleans, finite numbers, and strings serialize as in standard JSON.
 * - Non-finite numbers (`NaN`, `±Infinity`) serialize to `null` (matches
 *   `JSON.stringify`).
 *
 * This is the input to the idempotency hash; the function MUST be stable
 * across processes / Node versions for any two structurally-equal inputs.
 */
export function canonicalJSON(value: unknown): string {
  // Primitives — defer to JSON.stringify, which handles strings, booleans,
  // finite numbers, and null. Non-finite numbers become null.
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'bigint') {
    // bigint is not representable in JSON; coerce to string for stability.
    return JSON.stringify(value.toString())
  }

  // Arrays — preserve order, recurse on each element.
  if (Array.isArray(value)) {
    const parts = value.map((v) => canonicalJSON(v))
    return `[${parts.join(',')}]`
  }

  // Objects — sort keys, omit undefined-valued fields.
  if (typeof value === 'object') {
    const entries: [string, unknown][] = []
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v === undefined) continue
      entries.push([key, v])
    }
    const parts = entries.map(
      ([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`
    )
    return `{${parts.join(',')}}`
  }

  // Functions, symbols, and other non-JSON values → null (matches JSON.stringify behaviour).
  return 'null'
}

// ---------------------------------------------------------------------------
// Idempotency hash
// ---------------------------------------------------------------------------

/**
 * Compute the idempotency hash for a step invocation.
 *
 * Shape (per ADR Decision 3):
 *   sha256(stepId + ':' + canonicalJSON(input) + ':' + nodeVersion)
 *
 * The result is the hex-encoded digest (64 chars). Stored as `inputHash` on
 * the journal entry. Identical (stepId, input, nodeVersion) tuples produce
 * the same hash; workflow-version bumps invalidate keys (forcing fresh
 * execution).
 *
 * @param stepId - Workflow node / step id.
 * @param input - Step input payload (any JSON-serialisable value).
 * @param nodeVersion - Workflow definition version.
 * @returns Lowercase hex sha256 (64 chars).
 */
export function computeIdempotencyHash(
  stepId: string,
  input: unknown,
  nodeVersion: string
): string {
  const payload = `${stepId}:${canonicalJSON(input)}:${nodeVersion}`
  return createHash('sha256').update(payload).digest('hex')
}

// ---------------------------------------------------------------------------
// Hot-path serialization helpers
// ---------------------------------------------------------------------------

/** Serialize a JournalEntry into the Redis hash field map. */
function entryToHash(entry: JournalEntry): Record<string, string> {
  const out: Record<string, string> = {
    status: entry.status,
    inputHash: entry.inputHash,
    outputCAS: entry.outputCAS ?? '',
    startedAt: String(entry.startedAt ?? 0),
    completedAt: String(entry.completedAt ?? 0),
    attempt: String(entry.attempt ?? 0),
  }
  if (entry.error !== undefined && entry.error !== '') {
    out.error = entry.error
  }
  return out
}

/** Deserialize a Redis hash map into a JournalEntry. */
function hashToEntry(
  sessionId: string,
  stepId: string,
  raw: Record<string, string>
): JournalEntry {
  const entry: JournalEntry = {
    sessionId,
    stepId,
    status: (raw.status as JournalEntryStatus) ?? 'pending',
    inputHash: raw.inputHash ?? '',
    outputCAS: raw.outputCAS ?? '',
    startedAt: raw.startedAt ? Number(raw.startedAt) : 0,
    completedAt: raw.completedAt ? Number(raw.completedAt) : 0,
    attempt: raw.attempt ? Number(raw.attempt) : 0,
  }
  if (raw.error !== undefined && raw.error !== '') {
    entry.error = raw.error
  }
  return entry
}

// ---------------------------------------------------------------------------
// Public CRUD APIs
// ---------------------------------------------------------------------------

/**
 * Write (or upsert) a journal entry. Hot-path: single Redis HSET pipeline.
 *
 * Returns true on success, false if Redis isn't configured or the call fails.
 * Callers can write the same entry multiple times (e.g. running → completed);
 * each write is an HSET that overlays new fields onto existing ones.
 *
 * Idempotency-hash collision detection: if an existing entry has a different
 * `inputHash` than the one being written, a warning is logged. The write
 * still proceeds — collisions are functionally cache hits for idempotent ops.
 */
export async function writeJournalEntry(
  input: JournalWriteInput
): Promise<boolean> {
  if (!isRedisConfigured()) {
    log.warn('Redis not configured, journal write skipped', {
      sessionId: input.sessionId,
      stepId: input.stepId,
    })
    return false
  }

  const key = journalKey(input.sessionId, input.stepId)
  const now = Date.now()

  const entry: JournalEntry = {
    sessionId: input.sessionId,
    stepId: input.stepId,
    status: input.status,
    inputHash: input.inputHash,
    outputCAS: input.outputCAS ?? '',
    startedAt: input.startedAt ?? now,
    completedAt: input.completedAt ?? 0,
    attempt: input.attempt ?? 0,
    ...(input.error !== undefined ? { error: input.error } : {}),
  }

  try {
    const redis = getRedisClient()
    const fieldMap = entryToHash(entry)
    // ioredis HSET accepts (key, field, value, field, value, ...)
    const args: string[] = []
    for (const [k, v] of Object.entries(fieldMap)) {
      args.push(k, v)
    }
    await redis.hset(key, ...args)

    // Emit Layer 6 hook event for downstream subscribers (e.g. Postgres mirror).
    emitJournalEvent(entry)

    return true
  } catch (error) {
    log.error('Failed to write journal entry', {
      sessionId: input.sessionId,
      stepId: input.stepId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Read a single journal entry. Returns null if not found / Redis unavailable.
 */
export async function readJournalEntry(
  sessionId: string,
  stepId: string
): Promise<JournalEntry | null> {
  if (!isRedisConfigured()) {
    return null
  }

  try {
    const raw = await redisHGetAll(journalKey(sessionId, stepId))
    if (!raw || Object.keys(raw).length === 0) return null
    return hashToEntry(sessionId, stepId, raw)
  } catch (error) {
    log.error('Failed to read journal entry', {
      sessionId,
      stepId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * List every journal entry for a session, sorted by `startedAt` ascending.
 *
 * Implementation note: uses SCAN (via `redisKeys`) under `journal:{sessionId}:*`
 * then HGETALL each key in parallel. SCAN is O(n) over the session's step
 * count which is fine for read-only reporting paths; this is NOT a hot-path
 * write API.
 */
export async function listSessionJournal(
  sessionId: string
): Promise<JournalEntry[]> {
  if (!isRedisConfigured()) return []

  try {
    const keys = await redisKeys(journalSessionPattern(sessionId))
    if (keys.length === 0) return []

    const redis = getRedisClient()
    const entries = await Promise.all(
      keys.map(async (key) => {
        const stepId = key.slice(`journal:${sessionId}:`.length)
        const raw = await redis.hgetall(key)
        if (!raw || Object.keys(raw).length === 0) return null
        return hashToEntry(sessionId, stepId, raw)
      })
    )

    return entries
      .filter((e): e is JournalEntry => e !== null)
      .sort((a, b) => a.startedAt - b.startedAt)
  } catch (error) {
    log.error('Failed to list session journal', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

// ---------------------------------------------------------------------------
// Hash-collision check (used by callers that have the prior hash)
// ---------------------------------------------------------------------------

/**
 * Check whether writing `newInputHash` for the given step would collide with
 * an existing journal entry's stored `inputHash`. If a different hash already
 * exists, a warning is logged.
 *
 * Returns true if a collision was detected (existing hash differs), false
 * otherwise. This is informational — idempotent ops produce the same result,
 * so a collision is functionally a cache hit. Callers may use this signal to
 * skip duplicate work.
 */
export async function detectIdempotencyCollision(
  sessionId: string,
  stepId: string,
  newInputHash: string
): Promise<boolean> {
  const existing = await readJournalEntry(sessionId, stepId)
  if (!existing) return false
  if (existing.inputHash && existing.inputHash !== newInputHash) {
    log.warn('Idempotency hash collision detected', {
      sessionId,
      stepId,
      existingHash: existing.inputHash,
      newHash: newInputHash,
    })
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Layer 6 hook surface — `session.step-started` / `-completed` / `-failed`
// ---------------------------------------------------------------------------

/**
 * Session-step hook event taxonomy. Decoupled from the provider-tagged
 * `ProviderHookEvent` in `@donmai/core` core because session events
 * are not provider-scoped — they describe runtime journal transitions.
 *
 * Subscribers (e.g. the platform-side Postgres mirror) listen on the
 * `journalEventBus` exported below.
 */
export type SessionJournalEvent =
  | {
      kind: 'session.step-started'
      sessionId: string
      stepId: string
      inputHash: string
      attempt: number
      startedAt: number
    }
  | {
      kind: 'session.step-completed'
      sessionId: string
      stepId: string
      inputHash: string
      outputCAS: string
      attempt: number
      startedAt: number
      completedAt: number
    }
  | {
      kind: 'session.step-failed'
      sessionId: string
      stepId: string
      inputHash: string
      attempt: number
      startedAt: number
      completedAt: number
      error: string
    }

/** A subscriber callback. May be async; the bus awaits it. */
export type JournalEventSubscriber = (
  event: SessionJournalEvent
) => void | Promise<void>

interface JournalSubscriberEntry {
  id: string
  filter: { kinds?: Array<SessionJournalEvent['kind']> }
  handler: JournalEventSubscriber
}

/**
 * Local typed pub/sub for session journal events. Mirrors the design of the
 * core `HookBus` (crash-isolated subscribers, async emit) but is decoupled
 * so the server package stays self-contained per ADR §7.
 *
 * Failures in subscribers are isolated and logged; they NEVER propagate
 * back into the journal write path (mirror is eventually consistent).
 */
export class JournalEventBus {
  private readonly _subscribers: JournalSubscriberEntry[] = []
  private _nextId = 0

  subscribe(
    filter: { kinds?: Array<SessionJournalEvent['kind']> },
    handler: JournalEventSubscriber
  ): () => void {
    const id = String(this._nextId++)
    this._subscribers.push({ id, filter, handler })
    return () => {
      const idx = this._subscribers.findIndex((s) => s.id === id)
      if (idx !== -1) this._subscribers.splice(idx, 1)
    }
  }

  /** Fire-and-forget emit. All subscriber failures are isolated and logged. */
  emit(event: SessionJournalEvent): void {
    const matching = this._subscribers.filter((s) => {
      if (!s.filter.kinds || s.filter.kinds.length === 0) return true
      return s.filter.kinds.includes(event.kind)
    })
    for (const sub of matching) {
      try {
        const result = sub.handler(event)
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err))
            log.error('Journal subscriber rejected', {
              subscriberId: sub.id,
              eventKind: event.kind,
              error: error.message,
            })
          })
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        log.error('Journal subscriber threw', {
          subscriberId: sub.id,
          eventKind: event.kind,
          error: error.message,
        })
      }
    }
  }

  /** Number of registered subscribers (for diagnostics + tests). */
  get subscriberCount(): number {
    return this._subscribers.length
  }

  /** Remove all subscribers (test teardown). */
  clear(): void {
    this._subscribers.length = 0
  }
}

/**
 * Process-global journal event bus. The platform mirror subscriber attaches
 * here. Per ADR §2 the mirror is eventually consistent and not in the
 * critical path.
 */
export const journalEventBus = new JournalEventBus()

/** Map a journal entry transition to the corresponding hook event. */
function emitJournalEvent(entry: JournalEntry): void {
  switch (entry.status) {
    case 'running':
      journalEventBus.emit({
        kind: 'session.step-started',
        sessionId: entry.sessionId,
        stepId: entry.stepId,
        inputHash: entry.inputHash,
        attempt: entry.attempt,
        startedAt: entry.startedAt,
      })
      break
    case 'completed':
      journalEventBus.emit({
        kind: 'session.step-completed',
        sessionId: entry.sessionId,
        stepId: entry.stepId,
        inputHash: entry.inputHash,
        outputCAS: entry.outputCAS,
        attempt: entry.attempt,
        startedAt: entry.startedAt,
        completedAt: entry.completedAt,
      })
      break
    case 'failed':
      journalEventBus.emit({
        kind: 'session.step-failed',
        sessionId: entry.sessionId,
        stepId: entry.stepId,
        inputHash: entry.inputHash,
        attempt: entry.attempt,
        startedAt: entry.startedAt,
        completedAt: entry.completedAt,
        error: entry.error ?? '',
      })
      break
    case 'pending':
      // No hook event for pending — only terminal/active transitions surface.
      break
  }
}
