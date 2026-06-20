/**
 * Tests for the unified Provider<F> base contract.
 *
 * Coverage:
 * - Scope conflict resolution (same-level throws, most-specific wins)
 * - Signature verification (mocked / stub)
 * - Nested-capability rejection (flat-only enforced)
 * - Manifest validation
 * - canonicalJson / hashManifest helpers
 */

import { describe, it, expect } from 'vitest'
import type {
  Provider,
  ProviderFamily,
  ProviderManifest,
  ProviderCapabilities,
  ProviderScope,
  ProviderSignature,
  ProviderHost,
  ProviderHealth,
} from './base.js'
import {
  validateManifest,
  verifySignature,
  resolveScope,
  isFlatCapabilities,
  canonicalJson,
  hashManifest,
} from './base.js'

// ---------------------------------------------------------------------------
// Test helpers — minimal valid manifest + provider builders
// ---------------------------------------------------------------------------

function makeManifest<F extends ProviderFamily>(
  family: F,
  id: string,
  caps: ProviderCapabilities<F>,
  overrides?: Partial<ProviderManifest<F>>,
): ProviderManifest<F> {
  return {
    apiVersion: 'rensei.dev/v1',
    family,
    id,
    version: '1.0.0',
    name: `Test ${id}`,
    requires: { rensei: '>=0.8' },
    entry: { kind: 'static', modulePath: `./dist/${id}.js` },
    capabilitiesDeclared: caps,
    ...overrides,
  } as ProviderManifest<F>
}

type SandboxCaps = ProviderCapabilities<'sandbox'>

const validSandboxCaps: SandboxCaps = {
  transportModel: 'dial-in',
  supportsFsSnapshot: true,
  supportsPauseResume: false,
  idleCostModel: 'zero',
  billingModel: 'wall-clock',
  regions: ['us-east-1'],
  maxConcurrent: null,
  maxSessionDurationSeconds: 3600,
}

function makeProvider<F extends ProviderFamily>(
  family: F,
  id: string,
  scope: ProviderScope,
  caps: ProviderCapabilities<F>,
  sig: ProviderSignature | null = null,
): Provider<F> {
  const manifest = makeManifest(family, id, caps)
  return {
    manifest,
    capabilities: caps,
    scope,
    signature: sig,
    async activate(_host: ProviderHost): Promise<void> {},
    async deactivate(): Promise<void> {},
    async health(): Promise<ProviderHealth> {
      return { status: 'ready' }
    },
  }
}

function makeSandboxProvider(id: string, scope: ProviderScope): Provider<'sandbox'> {
  return makeProvider('sandbox', id, scope, validSandboxCaps)
}

// ---------------------------------------------------------------------------
// 1. canonicalJson
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  it('produces sorted-key JSON for a flat object', () => {
    const result = canonicalJson({ z: 1, a: 2, m: 'hello' })
    expect(result).toBe('{"a":2,"m":"hello","z":1}')
  })

  it('sorts keys recursively (nested objects)', () => {
    const result = canonicalJson({ b: { z: 1, a: 2 }, a: 'top' })
    expect(result).toBe('{"a":"top","b":{"a":2,"z":1}}')
  })

  it('handles arrays without sorting their elements', () => {
    const result = canonicalJson([3, 1, 2])
    expect(result).toBe('[3,1,2]')
  })

  it('handles null', () => {
    expect(canonicalJson(null)).toBe('null')
  })

  it('handles primitives', () => {
    expect(canonicalJson(42)).toBe('42')
    expect(canonicalJson('hello')).toBe('"hello"')
    expect(canonicalJson(true)).toBe('true')
  })

  it('produces the same output for the same object regardless of key insertion order', () => {
    const a = canonicalJson({ x: 1, y: 2 })
    const b = canonicalJson({ y: 2, x: 1 })
    expect(a).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// 2. hashManifest
// ---------------------------------------------------------------------------

describe('hashManifest', () => {
  it('returns a 64-char hex sha256 digest', () => {
    const manifest = makeManifest('sandbox', 'local-mac', validSandboxCaps)
    const hash = hashManifest(manifest)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('returns the same hash for identical manifests', () => {
    const m1 = makeManifest('sandbox', 'local-mac', validSandboxCaps)
    const m2 = makeManifest('sandbox', 'local-mac', validSandboxCaps)
    expect(hashManifest(m1)).toBe(hashManifest(m2))
  })

  it('returns a different hash when any manifest field changes', () => {
    const m1 = makeManifest('sandbox', 'local-mac', validSandboxCaps)
    const m2 = makeManifest('sandbox', 'local-mac', { ...validSandboxCaps, regions: ['eu-west-1'] })
    expect(hashManifest(m1)).not.toBe(hashManifest(m2))
  })
})

// ---------------------------------------------------------------------------
// 3. isFlatCapabilities
// ---------------------------------------------------------------------------

describe('isFlatCapabilities', () => {
  it('returns true for a flat object with only primitive values', () => {
    expect(isFlatCapabilities({ a: 1, b: 'hello', c: true, d: null })).toBe(true)
  })

  it('returns true for a flat object with array values', () => {
    expect(isFlatCapabilities({ regions: ['us-east-1', 'eu-west-1'], maxConcurrent: null })).toBe(true)
  })

  it('returns false when any value is a nested plain object', () => {
    expect(isFlatCapabilities({ nested: { foo: 'bar' } })).toBe(false)
  })

  it('returns false for deeply nested objects', () => {
    expect(isFlatCapabilities({ a: { b: { c: 1 } } })).toBe(false)
  })

  it('returns true for an empty object', () => {
    expect(isFlatCapabilities({})).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Manifest validation
// ---------------------------------------------------------------------------

describe('validateManifest', () => {
  it('accepts a fully valid manifest', () => {
    const manifest = makeManifest('sandbox', 'local-mac', validSandboxCaps)
    const result = validateManifest(manifest)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects wrong apiVersion', () => {
    const manifest = makeManifest('sandbox', 'local-mac', validSandboxCaps, {
      // @ts-expect-error intentional bad value for test
      apiVersion: 'rensei.dev/v2',
    })
    const result = validateManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('apiVersion'))).toBe(true)
  })

  it('rejects empty id', () => {
    const manifest = makeManifest('sandbox', '', validSandboxCaps)
    const result = validateManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('id'))).toBe(true)
  })

  it('rejects non-semver version', () => {
    const manifest = makeManifest('sandbox', 'test', validSandboxCaps, { version: 'not-a-version' })
    const result = validateManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('version'))).toBe(true)
  })

  it('rejects empty name', () => {
    const manifest = makeManifest('sandbox', 'test', validSandboxCaps, { name: '' })
    const result = validateManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('name'))).toBe(true)
  })

  it('rejects missing requires.rensei', () => {
    const manifest = makeManifest('sandbox', 'test', validSandboxCaps, {
      // @ts-expect-error intentional bad value for test
      requires: {},
    })
    const result = validateManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('requires.rensei'))).toBe(true)
  })

  it('rejects nested capabilities (flat structure enforced)', () => {
    const nestedCaps = {
      nested: { foo: 'bar' }, // violates flat requirement
      transportModel: 'dial-in',
    } as unknown as SandboxCaps

    const manifest = makeManifest('sandbox', 'test', nestedCaps)
    const result = validateManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('flat'))).toBe(true)
  })

  it('accepts capabilities with array values (arrays are allowed)', () => {
    const caps: SandboxCaps = { ...validSandboxCaps, regions: ['us-east-1', 'eu-west-1'] }
    const manifest = makeManifest('sandbox', 'test', caps)
    const result = validateManifest(manifest)
    expect(result.valid).toBe(true)
  })

  it('accepts all valid entry kinds', () => {
    const entryKinds: Array<ProviderManifest<'sandbox'>['entry']> = [
      { kind: 'static', modulePath: './dist/provider.js' },
      { kind: 'npm', package: '@acme/sandbox-provider' },
      { kind: 'binary', command: 'sandbox-daemon', args: ['--port', '8080'] },
      { kind: 'remote', url: 'https://sandbox.acme.dev', protocol: 'a2a' },
    ]

    for (const entry of entryKinds) {
      const manifest = makeManifest('sandbox', 'test', validSandboxCaps, { entry })
      const result = validateManifest(manifest)
      expect(result.valid).toBe(true)
    }
  })

  it('returns multiple errors when multiple fields are invalid', () => {
    const manifest = makeManifest('sandbox', '', validSandboxCaps, {
      name: '',
      // @ts-expect-error intentional bad value for test
      apiVersion: 'bad',
      version: 'bad',
    })
    const result = validateManifest(manifest)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// 5. Signature verification (mocked / stub)
// ---------------------------------------------------------------------------

describe('verifySignature', () => {
  function makeValidSig(manifest: ProviderManifest<'sandbox'>): ProviderSignature {
    return {
      signer: 'did:example:publisher',
      publicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA',
      algorithm: 'ed25519',
      signatureValue: 'STUB_VALID_base64-signature',
      manifestHash: hashManifest(manifest),
      attestedAt: '2026-04-27T00:00:00.000Z',
    }
  }

  it('passes when hash matches and signatureValue starts with STUB_VALID', () => {
    const manifest = makeManifest('sandbox', 'local-mac', validSandboxCaps)
    const sig = makeValidSig(manifest)
    const result = verifySignature(sig, manifest, sig.publicKey)
    expect(result.valid).toBe(true)
  })

  it('fails when manifestHash does not match the manifest', () => {
    const manifest = makeManifest('sandbox', 'local-mac', validSandboxCaps)
    const sig = makeValidSig(manifest)
    // Tamper with the sig's stored hash
    const tamperedSig: ProviderSignature = { ...sig, manifestHash: 'deadbeef' }
    const result = verifySignature(tamperedSig, manifest, sig.publicKey)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/manifestHash mismatch/)
  })

  it('fails when the manifest has been tampered after signing', () => {
    const manifest = makeManifest('sandbox', 'local-mac', validSandboxCaps)
    const sig = makeValidSig(manifest)
    // Modify the manifest after signing
    const tamperedManifest = makeManifest('sandbox', 'local-mac', {
      ...validSandboxCaps,
      regions: ['ap-southeast-1'],
    })
    const result = verifySignature(sig, tamperedManifest, sig.publicKey)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/manifestHash mismatch/)
  })

  it('fails when signatureValue is empty', () => {
    const manifest = makeManifest('sandbox', 'local-mac', validSandboxCaps)
    const sig: ProviderSignature = {
      ...makeValidSig(manifest),
      signatureValue: '',
    }
    const result = verifySignature(sig, manifest, sig.publicKey)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/signatureValue is empty/)
  })

  it('fails when publicKey is empty', () => {
    const manifest = makeManifest('sandbox', 'local-mac', validSandboxCaps)
    const sig: ProviderSignature = {
      ...makeValidSig(manifest),
      publicKey: '',
    }
    const result = verifySignature(sig, manifest, sig.publicKey)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/publicKey is empty/)
  })

  it('fails when signatureValue does not start with STUB_VALID (directs callers to async path)', () => {
    const manifest = makeManifest('sandbox', 'local-mac', validSandboxCaps)
    const sig: ProviderSignature = {
      ...makeValidSig(manifest),
      signatureValue: 'REAL_SIG_NOT_YET_SUPPORTED',
    }
    const result = verifySignature(sig, manifest, sig.publicKey)
    expect(result.valid).toBe(false)
    // REN-1314 ships real async verifier dispatch in signing.ts;
    // the synchronous verifySignature() directs callers to the async path.
    expect(result.reason).toMatch(/signing\.ts|async/)
  })

  it('passes with _testBypassVerify even without STUB_VALID prefix', () => {
    const manifest = makeManifest('sandbox', 'local-mac', validSandboxCaps)
    const sig: ProviderSignature = {
      ...makeValidSig(manifest),
      signatureValue: 'REAL_SIG_BYPASS_FOR_TEST',
    }
    const result = verifySignature(sig, manifest, sig.publicKey, { _testBypassVerify: true })
    expect(result.valid).toBe(true)
  })

  it('verifies signatures for all supported algorithms (structural check)', () => {
    const manifest = makeManifest('sandbox', 'local-mac', validSandboxCaps)
    const algorithms: ProviderSignature['algorithm'][] = ['sigstore', 'cosign', 'minisign', 'ed25519']
    for (const algorithm of algorithms) {
      const sig: ProviderSignature = {
        signer: 'did:example:publisher',
        publicKey: 'some-public-key',
        algorithm,
        signatureValue: 'STUB_VALID_for_' + algorithm,
        manifestHash: hashManifest(manifest),
        attestedAt: '2026-04-27T00:00:00.000Z',
      }
      const result = verifySignature(sig, manifest, sig.publicKey)
      expect(result.valid).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Scope resolution
// ---------------------------------------------------------------------------

describe('resolveScope', () => {
  describe('empty candidate list', () => {
    it('returns null chosen and empty rejected', () => {
      const result = resolveScope<'sandbox'>([])
      expect(result.chosen).toBeNull()
      expect(result.rejected).toHaveLength(0)
    })
  })

  describe('single provider', () => {
    it('returns the only provider as chosen', () => {
      const p = makeSandboxProvider('local', { level: 'global' })
      const result = resolveScope([p])
      expect(result.chosen).toBe(p)
      expect(result.rejected).toHaveLength(0)
    })

    it('rejects a non-global provider with no selector', () => {
      const p = makeSandboxProvider('local', { level: 'project' })
      const result = resolveScope([p])
      expect(result.chosen).toBeNull()
      expect(result.rejected).toHaveLength(1)
      expect(result.rejected[0].reason).toMatch(/selector/)
    })
  })

  describe('most-specific scope wins', () => {
    it('project beats global', () => {
      const global = makeSandboxProvider('global', { level: 'global' })
      const project = makeSandboxProvider('project', {
        level: 'project',
        selector: { project: 'my-app' },
      })
      const result = resolveScope([global, project])
      expect(result.chosen).toBe(project)
      expect(result.rejected.some((r) => r.provider === global)).toBe(true)
    })

    it('org beats tenant', () => {
      const tenant = makeSandboxProvider('tenant', {
        level: 'tenant',
        selector: { tenant: 'acme' },
      })
      const org = makeSandboxProvider('org', {
        level: 'org',
        selector: { org: 'acme-engineering' },
      })
      const result = resolveScope([tenant, org])
      expect(result.chosen).toBe(org)
    })

    it('project beats tenant and global', () => {
      const global = makeSandboxProvider('global', { level: 'global' })
      const tenant = makeSandboxProvider('tenant', {
        level: 'tenant',
        selector: { tenant: 'acme' },
      })
      const project = makeSandboxProvider('project', {
        level: 'project',
        selector: { project: 'my-app' },
      })
      const result = resolveScope([global, tenant, project])
      expect(result.chosen).toBe(project)
      expect(result.rejected).toHaveLength(2)
    })

    it('priority order: project > org > tenant > global', () => {
      const global = makeSandboxProvider('g', { level: 'global' })
      const tenant = makeSandboxProvider('t', {
        level: 'tenant',
        selector: { tenant: 'acme' },
      })
      const org = makeSandboxProvider('o', {
        level: 'org',
        selector: { org: 'eng' },
      })
      const project = makeSandboxProvider('p', {
        level: 'project',
        selector: { project: 'my-app' },
      })

      // Remove project — org wins
      const r1 = resolveScope([global, tenant, org])
      expect(r1.chosen).toBe(org)

      // Remove org — tenant wins
      const r2 = resolveScope([global, tenant])
      expect(r2.chosen).toBe(tenant)

      // All four — project wins
      const r3 = resolveScope([global, tenant, org, project])
      expect(r3.chosen).toBe(project)
    })
  })

  describe('same-level conflicts (error)', () => {
    it('throws when two providers share the same scope level', () => {
      const p1 = makeSandboxProvider('sandbox-a', {
        level: 'project',
        selector: { project: 'my-app' },
      })
      const p2 = makeSandboxProvider('sandbox-b', {
        level: 'project',
        selector: { project: 'my-app' },
      })

      expect(() => resolveScope([p1, p2])).toThrow(/scope conflict/)
    })

    it('throws when two global providers are candidates', () => {
      const p1 = makeSandboxProvider('sandbox-a', { level: 'global' })
      const p2 = makeSandboxProvider('sandbox-b', { level: 'global' })

      expect(() => resolveScope([p1, p2])).toThrow(/scope conflict/)
    })

    it('includes both conflicting provider IDs in the error message', () => {
      const p1 = makeSandboxProvider('sandbox-a', {
        level: 'org',
        selector: { org: 'acme' },
      })
      const p2 = makeSandboxProvider('sandbox-b', {
        level: 'org',
        selector: { org: 'acme' },
      })

      expect(() => resolveScope([p1, p2])).toThrow(/sandbox-a/)
      expect(() => resolveScope([p1, p2])).toThrow(/sandbox-b/)
    })

    it('does not throw when same-level conflict is shadowed by a higher scope', () => {
      // p1 and p2 both at 'tenant' scope — normally a conflict.
      // But p3 is at 'project' scope, which is higher, so it wins and
      // the tenant-level comparison never triggers a conflict error.
      const p1 = makeSandboxProvider('sandbox-a', {
        level: 'tenant',
        selector: { tenant: 'acme' },
      })
      const p2 = makeSandboxProvider('sandbox-b', {
        level: 'tenant',
        selector: { tenant: 'acme' },
      })
      const p3 = makeSandboxProvider('sandbox-c', {
        level: 'project',
        selector: { project: 'my-app' },
      })

      // p3 is the unique winner at the highest level (project), so no conflict
      expect(() => resolveScope([p1, p2, p3])).not.toThrow()
      const result = resolveScope([p1, p2, p3])
      expect(result.chosen).toBe(p3)
    })
  })

  describe('mixed valid and invalid scopes', () => {
    it('rejects invalid scopes and resolves among valid ones', () => {
      const invalid = makeSandboxProvider('invalid', { level: 'org' }) // no selector
      const valid = makeSandboxProvider('valid', { level: 'global' })

      const result = resolveScope([invalid, valid])
      expect(result.chosen).toBe(valid)
      expect(result.rejected.some((r) => r.provider === invalid)).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// 7. Provider<F> generic typing checks (compile-time via type assertions)
// ---------------------------------------------------------------------------

describe('Provider<F> generic typing', () => {
  it('Provider<"sandbox"> compiles with sandbox capabilities', () => {
    const p: Provider<'sandbox'> = makeSandboxProvider('test', { level: 'global' })
    expect(p.manifest.family).toBe('sandbox')
    expect(p.capabilities.transportModel).toBe('dial-in')
  })

  it('Provider<"vcs"> compiles with vcs capabilities', () => {
    const vcsCaps: ProviderCapabilities<'vcs'> = {
      mergeStrategy: 'three-way-text',
      mergeModel: 'three-way-text',
      conflictGranularity: 'line',
      patchModel: 'commit-graph',
      hasPullRequests: true,
      hasReviewWorkflow: true,
      branchSemantics: 'git-branches',
      supportsBranches: true,
      supportsRebase: true,
      identityScheme: 'email',
      remoteProtocol: 'git-smart-http',
      provenanceNative: false,
      auditModel: 'commit-trailer',
      supportsAttest: true,
      supportsBinary: true,
      supportsStructuredContent: false,
      supportsLargeFiles: false,
    }
    const p: Provider<'vcs'> = makeProvider('vcs', 'github', { level: 'global' }, vcsCaps)
    expect(p.manifest.family).toBe('vcs')
    expect(p.capabilities.mergeStrategy).toBe('three-way-text')
  })

  it('Provider<"agent-runtime"> compiles with agent-runtime capabilities', () => {
    const caps: ProviderCapabilities<'agent-runtime'> = {
      supportsMessageInjection: true,
      supportsSessionResume: true,
      supportsToolPlugins: true,
      emitsSubagentEvents: true,
      toolPermissionFormat: 'claude',
      // REN-1245: per-step reasoning-effort capability flag.
      supportsReasoningEffort: true,
    }
    const p: Provider<'agent-runtime'> = makeProvider('agent-runtime', 'claude', { level: 'global' }, caps)
    expect(p.capabilities.emitsSubagentEvents).toBe(true)
    expect(p.capabilities.supportsReasoningEffort).toBe(true)
  })

  it('Provider without signature has null signature', () => {
    const p = makeSandboxProvider('no-sig', { level: 'global' })
    expect(p.signature).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 8. Provider lifecycle (activate / deactivate / health)
// ---------------------------------------------------------------------------

describe('Provider lifecycle', () => {
  it('activate resolves without throwing', async () => {
    const p = makeSandboxProvider('test', { level: 'global' })
    const host: ProviderHost = { emit: () => {} }
    await expect(p.activate(host)).resolves.toBeUndefined()
  })

  it('deactivate resolves without throwing', async () => {
    const p = makeSandboxProvider('test', { level: 'global' })
    await expect(p.deactivate()).resolves.toBeUndefined()
  })

  it('health() returns a valid ProviderHealth value', async () => {
    const p = makeSandboxProvider('test', { level: 'global' })
    const health = await p.health!()
    expect(['ready', 'degraded', 'unhealthy']).toContain(health.status)
  })
})
