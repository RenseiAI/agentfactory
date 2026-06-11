/**
 * Plugin Loader Runtime — test suite
 *
 * Coverage per acceptance criteria (REN-1283):
 * - Signature verification fail
 * - Namespace mismatch (verb id doesn't start with <plugin-id>.)
 * - Scope-set mismatch on re-install
 * - Hot-reload disabled in production
 * - Programmatic registration round-trip
 * - Provider-family registration
 * - Full lifecycle (install → configure → enable → disable → uninstall)
 * - discoverManifestFiles from bundled + project-local sources
 * - Multi-source discovery
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PluginLoader } from './loader.js'
import { PluginRegistry, setDefaultRegistry } from './registry.js'
import {
  hashPluginManifest,
  validatePluginManifest,
  verifyPluginSignature,
  parsePluginManifest,
} from './manifest.js'
import type { PluginManifest } from './manifest.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeManifest(
  id: string,
  overrides: Partial<PluginManifest> = {}
): PluginManifest {
  return {
    apiVersion: 'rensei.dev/v1',
    kind: 'Plugin',
    metadata: {
      id,
      name: `Test ${id} Plugin`,
      version: '1.0.0',
    },
    engines: { rensei: '>=0.9' },
    ...overrides,
  } as PluginManifest
}

function makeManifestWithVerbs(id: string): PluginManifest {
  return makeManifest(id, {
    verbs: [
      {
        id: `${id}.do_thing`,
        description: 'Does a thing',
        kind: 'action',
        sideEffectClass: 'external-write',
      },
      {
        id: `${id}.list_things`,
        description: 'Lists things',
        kind: 'action',
        sideEffectClass: 'read-only',
      },
    ],
    providers: {
      deployment: [
        {
          id: `${id}.deployer`,
          class: `./dist/${id}-deployer.js#Deployer`,
          capabilities: { supportsPreviewUrls: true },
        },
      ],
    },
    auth: {
      type: 'oauth2',
      scopes: ['deployments:read', 'deployments:write'],
    },
  })
}

function makeSignedManifest(id: string): PluginManifest {
  const base = makeManifest(id)
  const expectedHash = hashPluginManifest(base)
  return {
    ...base,
    signature: {
      signer: 'did:web:rensei.dev',
      publicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA',
      algorithm: 'ed25519',
      signatureValue: 'STUB_VALID_signature_for_test',
      manifestHash: expectedHash,
      attestedAt: '2026-04-27T00:00:00.000Z',
    },
  }
}

// ---------------------------------------------------------------------------
// 1. Manifest validation
// ---------------------------------------------------------------------------

describe('validatePluginManifest', () => {
  it('accepts a fully valid manifest', () => {
    const m = makeManifest('acme')
    const result = validatePluginManifest(m)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects wrong apiVersion', () => {
    const m = makeManifest('acme', { apiVersion: 'rensei.dev/v2' as 'rensei.dev/v1' })
    const result = validatePluginManifest(m)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('apiVersion'))).toBe(true)
  })

  it('rejects wrong kind', () => {
    const m = makeManifest('acme', { kind: 'Kit' as 'Plugin' })
    const result = validatePluginManifest(m)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('kind'))).toBe(true)
  })

  it('rejects empty metadata.id', () => {
    const m: PluginManifest = {
      ...makeManifest('acme'),
      metadata: { id: '', name: 'Acme', version: '1.0.0' },
    }
    const result = validatePluginManifest(m)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('metadata.id'))).toBe(true)
  })

  it('rejects non-semver version', () => {
    const m: PluginManifest = {
      ...makeManifest('acme'),
      metadata: { id: 'acme', name: 'Acme', version: 'not-semver' },
    }
    const result = validatePluginManifest(m)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('version'))).toBe(true)
  })

  it('rejects missing engines.rensei', () => {
    const m = makeManifest('acme', {
      engines: { rensei: '' },
    })
    const result = validatePluginManifest(m)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('engines.rensei'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Namespace enforcement
// ---------------------------------------------------------------------------

describe('namespace enforcement', () => {
  it('rejects a verb that does not start with <plugin-id>.', () => {
    const m = makeManifest('vercel', {
      verbs: [{ id: 'deploy', description: 'Deploy', kind: 'action' }],
    })
    const result = validatePluginManifest(m)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("must start with 'vercel.'"))).toBe(true)
  })

  it("rejects a verb from a different plugin's namespace", () => {
    const m = makeManifest('slack', {
      verbs: [{ id: 'vercel.deploy', description: 'Mismatched', kind: 'action' }],
    })
    const result = validatePluginManifest(m)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("must start with 'slack.'"))).toBe(true)
  })

  it("accepts verbs with sub-namespacing like '<id>.<resource>.<verb>'", () => {
    const m = makeManifest('vercel', {
      verbs: [{ id: 'vercel.deployment.completed', kind: 'gate' }],
    })
    const result = validatePluginManifest(m)
    expect(result.valid).toBe(true)
  })

  it('rejects a provider id that does not start with <plugin-id>.', () => {
    const m = makeManifest('vercel', {
      providers: {
        deployment: [
          { id: 'not-vercel.deployer', class: './deployer.js#D', capabilities: {} },
        ],
      },
    })
    const result = validatePluginManifest(m)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes("must start with 'vercel.'"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. Signature verification
// ---------------------------------------------------------------------------

describe('verifyPluginSignature', () => {
  it('accepts unsigned manifests in OSS mode (no requireSignatures)', () => {
    const m = makeManifest('acme')
    const result = verifyPluginSignature(m)
    expect(result.valid).toBe(true)
    expect(result.reason).toMatch(/no signature/)
  })

  it('accepts a manifest with STUB_VALID signature', () => {
    const m = makeSignedManifest('acme')
    const result = verifyPluginSignature(m)
    expect(result.valid).toBe(true)
  })

  it('fails when manifestHash is wrong', () => {
    const m = makeManifest('acme')
    const withBadSig: PluginManifest = {
      ...m,
      signature: {
        signer: 'did:web:rensei.dev',
        publicKey: 'some-key',
        algorithm: 'ed25519',
        signatureValue: 'STUB_VALID_test',
        manifestHash: 'deadbeef',
        attestedAt: '2026-04-27T00:00:00.000Z',
      },
    }
    const result = verifyPluginSignature(withBadSig)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/manifestHash mismatch/)
  })

  it('fails when the manifest is tampered after signing', () => {
    const m = makeSignedManifest('acme')
    // Tamper the manifest after the hash was computed
    const tampered: PluginManifest = {
      ...m,
      metadata: { ...m.metadata, version: '9.9.9' },
    }
    const result = verifyPluginSignature(tampered)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/manifestHash mismatch/)
  })

  it('fails when signatureValue is empty', () => {
    const m = makeManifest('acme')
    const expectedHash = hashPluginManifest(m)
    const withEmptySig: PluginManifest = {
      ...m,
      signature: {
        signer: 'did:web:rensei.dev',
        publicKey: 'some-key',
        algorithm: 'ed25519',
        signatureValue: '',
        manifestHash: expectedHash,
        attestedAt: '2026-04-27T00:00:00.000Z',
      },
    }
    const result = verifyPluginSignature(withEmptySig)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/signatureValue is empty/)
  })

  it('fails when signatureValue is not STUB_VALID (directs to async path)', () => {
    const m = makeManifest('acme')
    const expectedHash = hashPluginManifest(m)
    const withRealSig: PluginManifest = {
      ...m,
      signature: {
        signer: 'did:web:rensei.dev',
        publicKey: 'some-key',
        algorithm: 'ed25519',
        signatureValue: 'REAL_SIGNATURE_VALUE',
        manifestHash: expectedHash,
        attestedAt: '2026-04-27T00:00:00.000Z',
      },
    }
    const result = verifyPluginSignature(withRealSig)
    expect(result.valid).toBe(false)
    // REN-1314 ships real async verifier dispatch in providers/signing.ts.
    // The synchronous verifyPluginSignature() directs callers to the async path.
    expect(result.reason).toMatch(/signing\.ts|async/)
  })

  it('passes with _testBypassVerify even for non-STUB_VALID signature', () => {
    const m = makeManifest('acme')
    const expectedHash = hashPluginManifest(m)
    const withRealSig: PluginManifest = {
      ...m,
      signature: {
        signer: 'did:web:rensei.dev',
        publicKey: 'some-key',
        algorithm: 'ed25519',
        signatureValue: 'REAL_SIG_BYPASS',
        manifestHash: expectedHash,
        attestedAt: '2026-04-27T00:00:00.000Z',
      },
    }
    const result = verifyPluginSignature(withRealSig, { _testBypassVerify: true })
    expect(result.valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Loader — full lifecycle tests
// ---------------------------------------------------------------------------

describe('PluginLoader', () => {
  let registry: PluginRegistry
  let loader: PluginLoader

  beforeEach(() => {
    registry = new PluginRegistry()
    setDefaultRegistry(registry)
    loader = new PluginLoader({ registry })
  })

  // ── 4.1 Install ────────────────────────────────────────────────────────

  it('installs a valid plugin successfully', async () => {
    const m = makeManifest('vercel')
    const result = await loader.installPlugin(m)
    expect(result.success).toBe(true)
    expect(result.pluginId).toBe('vercel')
    expect(registry.getPlugin('vercel')).toBeDefined()
    expect(registry.getPlugin('vercel')?.state).toBe('installed')
  })

  it('returns errors for an invalid manifest (namespace mismatch)', async () => {
    const m = makeManifest('vercel', {
      verbs: [{ id: 'deploy', kind: 'action' }], // missing namespace prefix
    })
    const result = await loader.installPlugin(m)
    expect(result.success).toBe(false)
    expect(result.errors.some((e) => e.includes("must start with 'vercel.'"))).toBe(true)
  })

  it('registers providers into the family resolver', async () => {
    const m = makeManifestWithVerbs('acme')
    const result = await loader.installPlugin(m)
    expect(result.success).toBe(true)
    const providers = registry.listProvidersForFamily('deployment')
    expect(providers.length).toBe(1)
    expect(providers[0].registration.id).toBe('acme.deployer')
  })

  it('registers verbs into the verb registry', async () => {
    const m = makeManifestWithVerbs('acme')
    await loader.installPlugin(m)
    const verbs = registry.listVerbs()
    expect(verbs.map((v) => v.declaration.id)).toContain('acme.do_thing')
    expect(verbs.map((v) => v.declaration.id)).toContain('acme.list_things')
  })

  it('verbs are not available before enablePlugin', async () => {
    const m = makeManifestWithVerbs('acme')
    await loader.installPlugin(m)
    const verbs = registry.listVerbs()
    expect(verbs.every((v) => !v.available)).toBe(true)
  })

  // ── 4.2 Signature verification fail ────────────────────────────────────

  it('rejects a plugin with a bad signature hash when requireSignatures=true', async () => {
    const m = makeManifest('acme')
    const withBadSig: PluginManifest = {
      ...m,
      signature: {
        signer: 'did:web:rensei.dev',
        publicKey: 'some-key',
        algorithm: 'ed25519',
        signatureValue: 'STUB_VALID_test',
        manifestHash: 'deadbeef',
        attestedAt: '2026-04-27T00:00:00.000Z',
      },
    }
    const strictLoader = new PluginLoader({ registry, requireSignatures: true })
    const result = await strictLoader.installPlugin(withBadSig)
    expect(result.success).toBe(false)
    // The schema validation step catches the hash mismatch first
    expect(
      result.errors.some(
        (e) => e.includes('signature') || e.includes('manifestHash') || e.includes('Signature')
      )
    ).toBe(true)
  })

  it('rejects a plugin with invalid signature even when requireSignatures=false', async () => {
    const m = makeManifest('acme')
    // Signature present but with wrong hash — always fatal (caught at validation or verify stage)
    const withBadHash: PluginManifest = {
      ...m,
      signature: {
        signer: 'did:web:rensei.dev',
        publicKey: 'some-key',
        algorithm: 'ed25519',
        signatureValue: 'STUB_VALID_test',
        manifestHash: 'deadbeef_wrong',
        attestedAt: '2026-04-27T00:00:00.000Z',
      },
    }
    const result = await loader.installPlugin(withBadHash)
    expect(result.success).toBe(false)
    // Hash mismatch is caught either in validatePluginManifest or verifyPluginSignature
    expect(
      result.errors.some(
        (e) => e.includes('manifestHash') || e.includes('signature') || e.includes('Signature')
      )
    ).toBe(true)
  })

  it('accepts an unsigned plugin in OSS mode (requireSignatures=false)', async () => {
    const m = makeManifest('acme')
    const result = await loader.installPlugin(m)
    expect(result.success).toBe(true)
  })

  // ── 4.3 Scope-set mismatch on re-install ───────────────────────────────

  it('allows re-install with the same scope set', async () => {
    const m = makeManifestWithVerbs('vercel')
    await loader.installPlugin(m)
    // Re-install with same manifest
    const result = await loader.installPlugin(m)
    expect(result.success).toBe(true)
  })

  it('rejects re-install with a different scope set', async () => {
    const m = makeManifestWithVerbs('vercel')
    await loader.installPlugin(m)

    // Attempt re-install with different scopes
    const mNewScopes = makeManifest('vercel', {
      auth: {
        type: 'oauth2',
        scopes: ['deployments:read', 'deployments:write', 'admin:full'], // added scope
      },
    })
    const result = await loader.installPlugin(mNewScopes)
    expect(result.success).toBe(false)
    expect(result.errors.some((e) => e.includes('scope-set mismatch'))).toBe(true)
  })

  it('rejects re-install with scopes removed', async () => {
    const m = makeManifestWithVerbs('vercel')
    await loader.installPlugin(m)

    const mFewerScopes = makeManifest('vercel', {
      auth: { type: 'oauth2', scopes: ['deployments:read'] }, // removed write scope
    })
    const result = await loader.installPlugin(mFewerScopes)
    expect(result.success).toBe(false)
    expect(result.errors.some((e) => e.includes('scope-set mismatch'))).toBe(true)
  })

  // ── 4.4 Enable / Disable ───────────────────────────────────────────────

  it('enables a plugin and marks verbs available', async () => {
    const m = makeManifestWithVerbs('vercel')
    await loader.installPlugin(m)
    await loader.enablePlugin('vercel')

    expect(registry.getPlugin('vercel')?.state).toBe('enabled')
    const available = registry.listAvailableVerbs()
    expect(available.length).toBe(2)
    expect(available.map((v) => v.declaration.id)).toContain('vercel.do_thing')
  })

  it('disables a plugin and marks verbs unavailable', async () => {
    const m = makeManifestWithVerbs('vercel')
    await loader.installPlugin(m)
    await loader.enablePlugin('vercel')
    await loader.disablePlugin('vercel')

    expect(registry.getPlugin('vercel')?.state).toBe('disabled')
    const available = registry.listAvailableVerbs()
    expect(available.length).toBe(0)
  })

  it('disable is idempotent', async () => {
    const m = makeManifest('vercel')
    await loader.installPlugin(m)
    await loader.enablePlugin('vercel')
    await loader.disablePlugin('vercel')
    await expect(loader.disablePlugin('vercel')).resolves.not.toThrow()
  })

  // ── 4.5 Hot-reload disabled in production ──────────────────────────────

  it('hotReload returns false in production mode', async () => {
    const prodLoader = new PluginLoader({
      registry,
      _testNodeEnv: 'production',
    })
    const m = makeManifest('vercel')
    const reloaded = await prodLoader.hotReload(m)
    expect(reloaded).toBe(false)
  })

  it('enablePlugin is a no-op in production when already enabled', async () => {
    const prodLoader = new PluginLoader({
      registry,
      _testNodeEnv: 'production',
    })
    const m = makeManifest('vercel')
    await prodLoader.installPlugin(m)
    await prodLoader.enablePlugin('vercel')
    // Should not throw or change state (no-op in prod)
    await expect(prodLoader.enablePlugin('vercel')).resolves.not.toThrow()
    expect(registry.getPlugin('vercel')?.state).toBe('enabled')
  })

  it('hotReload returns true and re-registers in development mode', async () => {
    const devLoader = new PluginLoader({
      registry,
      _testNodeEnv: 'development',
    })
    const m = makeManifestWithVerbs('vercel')
    await devLoader.installPlugin(m)
    await devLoader.enablePlugin('vercel')

    // Hot-reload with a new verb added
    const updated = makeManifest('vercel', {
      verbs: [
        { id: 'vercel.do_thing', kind: 'action' },
        { id: 'vercel.new_verb', kind: 'action' }, // new verb
      ],
    })
    const reloaded = await devLoader.hotReload(updated)
    expect(reloaded).toBe(true)
    expect(registry.getPlugin('vercel')?.state).toBe('enabled')
    const verbIds = registry.listVerbs().map((v) => v.declaration.id)
    expect(verbIds).toContain('vercel.new_verb')
  })

  // ── 4.6 Programmatic registration round-trip ───────────────────────────

  it('programmatic round-trip: registerPlugin returns a successful result', async () => {
    const m = makeManifestWithVerbs('my-plugin')
    const result = await loader.registerPlugin(m, { _testBypassSignatureVerify: true })
    expect(result.success).toBe(true)
    expect(result.source).toBe('programmatic')
    expect(registry.getPlugin('my-plugin')).toBeDefined()
  })

  it('programmatic round-trip: registerAndEnable activates verbs', async () => {
    const m = makeManifestWithVerbs('my-plugin')
    const result = await loader.registerAndEnable(m)
    expect(result.success).toBe(true)
    expect(registry.getPlugin('my-plugin')?.state).toBe('enabled')
    const available = registry.listAvailableVerbs()
    expect(available.some((v) => v.declaration.id === 'my-plugin.do_thing')).toBe(true)
  })

  it('programmatic round-trip stores providerFactories for later', async () => {
    let factoryCalled = false
    const m = makeManifestWithVerbs('my-plugin')
    await loader.registerPlugin(m, {
      providerFactories: {
        'my-plugin.deployer': (_reg) => {
          factoryCalled = true
          return {}
        },
      },
    })
    // Factory is stored but not yet called during install
    expect(factoryCalled).toBe(false)
    // Verify provider is registered
    expect(registry.getProvider('deployment', 'my-plugin.deployer')).toBeDefined()
  })

  // ── 4.7 Uninstall ──────────────────────────────────────────────────────

  it('uninstall removes all providers, verbs, and the plugin record', async () => {
    const m = makeManifestWithVerbs('vercel')
    await loader.registerAndEnable(m)
    expect(registry.hasPlugin('vercel')).toBe(true)

    await loader.uninstallPlugin('vercel')
    expect(registry.hasPlugin('vercel')).toBe(false)
    expect(registry.listProvidersForFamily('deployment')).toHaveLength(0)
    expect(registry.listVerbs()).toHaveLength(0)
  })

  it('uninstall is idempotent for non-existent plugins', async () => {
    await expect(loader.uninstallPlugin('non-existent')).resolves.not.toThrow()
  })

  // ── 4.8 Configure ──────────────────────────────────────────────────────

  it('configurePlugin stores runtime config', async () => {
    const m = makeManifest('vercel')
    await loader.installPlugin(m)
    loader.configurePlugin('vercel', { defaultProject: 'my-project' })
    expect(registry.getPlugin('vercel')?.runtimeConfig).toEqual({ defaultProject: 'my-project' })
  })

  it('configurePlugin throws for unknown plugin', () => {
    expect(() => loader.configurePlugin('unknown', {})).toThrow("Plugin 'unknown' is not installed")
  })

  it('configurePlugin throws when plugin is not in installed/configuring state', async () => {
    const m = makeManifest('vercel')
    await loader.installPlugin(m)
    await loader.enablePlugin('vercel')
    expect(() => loader.configurePlugin('vercel', {})).toThrow(/Cannot configure/)
  })

  // ── 4.9 enableAll / discoverAndInstallAll ──────────────────────────────

  it('enableAll enables all installed plugins', async () => {
    await loader.installPlugin(makeManifest('plugin-a'))
    await loader.installPlugin(makeManifest('plugin-b'))
    const results = await loader.enableAll()
    expect(results.every((r) => !r.error)).toBe(true)
    expect(registry.getPlugin('plugin-a')?.state).toBe('enabled')
    expect(registry.getPlugin('plugin-b')?.state).toBe('enabled')
  })
})

// ---------------------------------------------------------------------------
// 5. PluginRegistry unit tests
// ---------------------------------------------------------------------------

describe('PluginRegistry', () => {
  let registry: PluginRegistry

  beforeEach(() => {
    registry = new PluginRegistry()
  })

  it('throws when a provider is registered by two different plugins', () => {
    registry.registerProvider({
      pluginId: 'plugin-a',
      family: 'deployment',
      registration: { id: 'plugin-a.deployer', class: './a.js#A', capabilities: {} },
      state: 'installed',
    })
    expect(() =>
      registry.registerProvider({
        pluginId: 'plugin-b',
        family: 'deployment',
        registration: { id: 'plugin-a.deployer', class: './b.js#B', capabilities: {} },
        state: 'installed',
      })
    ).toThrow(/already registered by plugin 'plugin-a'/)
  })

  it('allows same plugin to re-register a provider (hot-reload)', () => {
    const reg = {
      pluginId: 'plugin-a',
      family: 'deployment',
      registration: { id: 'plugin-a.deployer', class: './a.js#A', capabilities: {} },
      state: 'installed' as const,
    }
    registry.registerProvider(reg)
    expect(() => registry.registerProvider(reg)).not.toThrow()
  })

  it('throws when a verb is registered by two different plugins', () => {
    registry.registerVerb({
      pluginId: 'plugin-a',
      declaration: { id: 'plugin-a.deploy', kind: 'action' },
      available: false,
    })
    expect(() =>
      registry.registerVerb({
        pluginId: 'plugin-b',
        declaration: { id: 'plugin-a.deploy', kind: 'action' },
        available: false,
      })
    ).toThrow(/already registered by plugin 'plugin-a'/)
  })

  it('isScopeSetCompatible returns true for identical sets (order-independent)', () => {
    expect(
      PluginRegistry.isScopeSetCompatible(
        ['read', 'write'],
        ['write', 'read']
      )
    ).toBe(true)
  })

  it('isScopeSetCompatible returns false when scope is added', () => {
    expect(
      PluginRegistry.isScopeSetCompatible(['read'], ['read', 'admin'])
    ).toBe(false)
  })

  it('isScopeSetCompatible returns false when scope is removed', () => {
    expect(
      PluginRegistry.isScopeSetCompatible(['read', 'write'], ['read'])
    ).toBe(false)
  })

  it('snapshot reflects the current state of the registry', async () => {
    const loader = new PluginLoader({ registry })
    await loader.installPlugin(makeManifest('snap-test'))
    const snap = registry.snapshot()
    expect(snap.pluginCount).toBe(1)
    expect(snap.plugins[0].id).toBe('snap-test')
  })
})

// ---------------------------------------------------------------------------
// 6. Manifest discovery from file system
// ---------------------------------------------------------------------------

describe('discoverManifestFiles', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rensei-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('discovers rensei-plugin.yaml in bundled plugins dir', () => {
    const bundledDir = path.join(tmpDir, 'plugins')
    fs.mkdirSync(bundledDir)
    const manifest = makeManifest('bundled-plugin')
    fs.writeFileSync(
      path.join(bundledDir, 'rensei-plugin.yaml'),
      `apiVersion: rensei.dev/v1\nkind: Plugin\nmetadata:\n  id: bundled-plugin\n  name: Bundled\n  version: 1.0.0\nengines:\n  rensei: ">=0.9"\n`
    )

    const loader = new PluginLoader({ hostRoot: tmpDir, registry: new PluginRegistry() })
    const files = loader.discoverManifestFiles()
    expect(files.some((f) => f.source === 'bundled')).toBe(true)
    expect(files.some((f) => f.filePath.includes('rensei-plugin.yaml'))).toBe(true)
  })

  it('discovers *.plugin.yaml in project-local .donmai/plugins dir', () => {
    const localDir = path.join(tmpDir, '.donmai', 'plugins')
    fs.mkdirSync(localDir, { recursive: true })
    fs.writeFileSync(
      path.join(localDir, 'my-plugin.plugin.yaml'),
      `apiVersion: rensei.dev/v1\nkind: Plugin\nmetadata:\n  id: my-plugin\n  name: My Plugin\n  version: 1.0.0\nengines:\n  rensei: ">=0.9"\n`
    )

    const loader = new PluginLoader({ projectRoot: tmpDir, registry: new PluginRegistry() })
    const files = loader.discoverManifestFiles()
    expect(files.some((f) => f.source === 'project-local')).toBe(true)
  })

  it('returns empty list when directories do not exist', () => {
    const loader = new PluginLoader({
      hostRoot: path.join(tmpDir, 'nonexistent-host'),
      projectRoot: path.join(tmpDir, 'nonexistent-project'),
      registry: new PluginRegistry(),
    })
    const files = loader.discoverManifestFiles()
    expect(files).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 7. parsePluginManifest
// ---------------------------------------------------------------------------

describe('parsePluginManifest', () => {
  it('parses a valid YAML string into a PluginManifest', () => {
    const yaml = `
apiVersion: rensei.dev/v1
kind: Plugin
metadata:
  id: vercel
  name: Rensei Vercel Integration
  version: 1.4.0
  description: Vercel deploys and more
engines:
  rensei: ">=0.9 <2.0"
auth:
  type: oauth2
  scopes:
    - deployments:read
    - deployments:write
`
    const manifest = parsePluginManifest(yaml)
    expect(manifest.metadata.id).toBe('vercel')
    expect(manifest.metadata.version).toBe('1.4.0')
    expect(manifest.auth?.scopes).toContain('deployments:read')
  })

  it('throws on invalid YAML', () => {
    expect(() => parsePluginManifest('{ broken yaml }')).not.toThrow() // actually valid YAML object
    expect(() => parsePluginManifest('just a string')).toThrow(/must be a YAML object/)
  })
})
