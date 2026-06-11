/**
 * Tests for the audit-log subscriber.
 *
 * Coverage:
 * - Registers and receives events
 * - Converts each event kind to an AuditRecord
 * - Calls the writer with the correct record and file path
 * - Custom logPath option
 * - Unsubscribe stops delivery
 * - Default path uses today's date
 */

import { describe, it, expect, vi } from 'vitest'
import { HookBus } from '../hooks.js'
import { registerAuditLogSubscriber } from './audit-log.js'
import type { AuditRecord } from './audit-log.js'
import type { ProviderHookEvent, ProviderRef } from '../../providers/base.js'

function makeRef(id = 'test-provider'): ProviderRef {
  return { id, family: 'sandbox', version: '1.0.0' }
}

describe('registerAuditLogSubscriber', () => {
  it('writes an AuditRecord for a pre-activate event', async () => {
    const bus = new HookBus()
    const written: Array<[AuditRecord, string]> = []

    registerAuditLogSubscriber(bus, {
      logPath: '/tmp/test-audit.ndjson',
      _writer: (record, path) => { written.push([record, path]) },
    })

    await bus.emit({ kind: 'pre-activate', provider: makeRef() })

    expect(written).toHaveLength(1)
    const [record, path] = written[0]
    expect(record.kind).toBe('pre-activate')
    expect(record.provider?.id).toBe('test-provider')
    expect(path).toBe('/tmp/test-audit.ndjson')
  })

  it('writes records for all 12 event kinds', async () => {
    const bus = new HookBus()
    const written: AuditRecord[] = []

    registerAuditLogSubscriber(bus, {
      logPath: '/tmp/test-audit.ndjson',
      _writer: (record) => { written.push(record) },
    })

    const runtimeRef: ProviderRef = { id: 'claude', family: 'agent-runtime', version: 'v1' }
    const events: ProviderHookEvent[] = [
      { kind: 'pre-activate', provider: makeRef() },
      { kind: 'post-activate', provider: makeRef(), durationMs: 50 },
      { kind: 'pre-deactivate', provider: makeRef(), reason: 'shutdown' },
      { kind: 'post-deactivate', provider: makeRef() },
      { kind: 'pre-verb', provider: makeRef(), verb: 'provision', args: {} },
      { kind: 'post-verb', provider: makeRef(), verb: 'provision', result: {}, durationMs: 10 },
      { kind: 'verb-error', provider: makeRef(), verb: 'provision', error: new Error('fail') },
      { kind: 'pre-tool-use', provider: runtimeRef, sessionId: 'sess_1', toolUseId: 'tu_1', toolName: 'Read', toolInput: { file_path: 'a.ts' } },
      { kind: 'post-tool-use', provider: runtimeRef, sessionId: 'sess_1', toolUseId: 'tu_1', toolName: 'Read', toolOutput: 'contents', durationMs: 4, isError: false },
      { kind: 'tool-use-error', provider: runtimeRef, sessionId: 'sess_1', toolUseId: 'tu_2', toolName: 'Bash', error: 'permission denied' },
      { kind: 'capability-mismatch', provider: makeRef(), declared: {}, observed: {} },
      { kind: 'scope-resolved', chosen: [makeRef()], rejected: [] },
    ]

    for (const ev of events) {
      await bus.emit(ev)
    }

    expect(written).toHaveLength(12)
    const kinds = written.map((r) => r.kind)
    expect(kinds).toContain('pre-activate')
    expect(kinds).toContain('pre-tool-use')
    expect(kinds).toContain('post-tool-use')
    expect(kinds).toContain('tool-use-error')
    expect(kinds).toContain('scope-resolved')
  })

  it('post-tool-use record includes toolName/durationMs/isError + correlation id', async () => {
    const bus = new HookBus()
    const written: AuditRecord[] = []

    registerAuditLogSubscriber(bus, {
      logPath: '/tmp/test-audit.ndjson',
      _writer: (r) => { written.push(r) },
    })

    await bus.emit({
      kind: 'post-tool-use',
      provider: { id: 'claude', family: 'agent-runtime', version: 'v1' },
      sessionId: 'sess_42',
      toolUseId: 'tu_abc',
      toolName: 'Bash',
      toolOutput: 'ok',
      durationMs: 123,
      isError: false,
    })

    expect(written).toHaveLength(1)
    expect(written[0].kind).toBe('post-tool-use')
    expect(written[0].payload).toMatchObject({
      sessionId: 'sess_42',
      toolUseId: 'tu_abc',
      toolName: 'Bash',
      durationMs: 123,
      isError: false,
    })
  })

  it('post-activate record includes durationMs in payload', async () => {
    const bus = new HookBus()
    const written: AuditRecord[] = []

    registerAuditLogSubscriber(bus, {
      logPath: '/tmp/test-audit.ndjson',
      _writer: (r) => { written.push(r) },
    })

    await bus.emit({ kind: 'post-activate', provider: makeRef(), durationMs: 123 })
    expect(written[0].payload.durationMs).toBe(123)
  })

  it('pre-deactivate record includes reason in payload', async () => {
    const bus = new HookBus()
    const written: AuditRecord[] = []

    registerAuditLogSubscriber(bus, {
      logPath: '/tmp/test-audit.ndjson',
      _writer: (r) => { written.push(r) },
    })

    await bus.emit({ kind: 'pre-deactivate', provider: makeRef(), reason: 'shutdown' })
    expect(written[0].payload.reason).toBe('shutdown')
  })

  it('verb-error record includes error message', async () => {
    const bus = new HookBus()
    const written: AuditRecord[] = []

    registerAuditLogSubscriber(bus, {
      logPath: '/tmp/test-audit.ndjson',
      _writer: (r) => { written.push(r) },
    })

    await bus.emit({ kind: 'verb-error', provider: makeRef(), verb: 'provision', error: new Error('quota exceeded') })
    expect(written[0].payload.error).toBe('quota exceeded')
    expect(written[0].payload.verb).toBe('provision')
  })

  it('scope-resolved record includes chosen/rejected lists in payload', async () => {
    const bus = new HookBus()
    const written: AuditRecord[] = []

    registerAuditLogSubscriber(bus, {
      logPath: '/tmp/test-audit.ndjson',
      _writer: (r) => { written.push(r) },
    })

    await bus.emit({
      kind: 'scope-resolved',
      chosen: [makeRef('chosen-provider')],
      rejected: [{ provider: makeRef('rejected-provider'), reason: 'shadowed' }],
    })

    expect(Array.isArray(written[0].payload.chosen)).toBe(true)
    expect(Array.isArray(written[0].payload.rejected)).toBe(true)
    expect((written[0].payload.chosen as string[])[0]).toContain('chosen-provider')
  })

  it('record includes a valid ISO timestamp', async () => {
    const bus = new HookBus()
    const written: AuditRecord[] = []

    registerAuditLogSubscriber(bus, {
      logPath: '/tmp/test-audit.ndjson',
      _writer: (r) => { written.push(r) },
    })

    await bus.emit({ kind: 'pre-activate', provider: makeRef() })
    expect(() => new Date(written[0].ts)).not.toThrow()
    expect(isNaN(new Date(written[0].ts).getTime())).toBe(false)
  })

  it('unsubscribe stops delivery', async () => {
    const bus = new HookBus()
    const written: AuditRecord[] = []

    const unsubscribe = registerAuditLogSubscriber(bus, {
      logPath: '/tmp/test-audit.ndjson',
      _writer: (r) => { written.push(r) },
    })

    await bus.emit({ kind: 'pre-activate', provider: makeRef() })
    unsubscribe()
    await bus.emit({ kind: 'pre-activate', provider: makeRef() })

    expect(written).toHaveLength(1)
  })

  it('custom filter narrows received events', async () => {
    const bus = new HookBus()
    const written: AuditRecord[] = []

    registerAuditLogSubscriber(bus, {
      logPath: '/tmp/test-audit.ndjson',
      filter: { kinds: ['post-activate'] },
      _writer: (r) => { written.push(r) },
    })

    await bus.emit({ kind: 'pre-activate', provider: makeRef() })
    await bus.emit({ kind: 'post-activate', provider: makeRef(), durationMs: 10 })

    expect(written).toHaveLength(1)
    expect(written[0].kind).toBe('post-activate')
  })

  it('default logPath contains today\'s date', async () => {
    const bus = new HookBus()
    const paths: string[] = []

    // Use a writer that captures the path but does not write to disk
    const mockWriter = (_record: AuditRecord, filePath: string) => { paths.push(filePath) }
    registerAuditLogSubscriber(bus, { _writer: mockWriter })

    await bus.emit({ kind: 'pre-activate', provider: makeRef() })

    expect(paths).toHaveLength(1)
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    expect(paths[0]).toContain(today)
    expect(paths[0]).toContain('.donmai/audit')
    expect(paths[0].endsWith('.ndjson')).toBe(true)
  })

  it('writer failure does not crash the subscriber', async () => {
    const bus = new HookBus()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    registerAuditLogSubscriber(bus, {
      logPath: '/tmp/test-audit.ndjson',
      _writer: () => { throw new Error('disk full') },
    })

    // Should not throw
    await expect(bus.emit({ kind: 'pre-activate', provider: makeRef() })).resolves.toBeUndefined()
    errorSpy.mockRestore()
  })
})
