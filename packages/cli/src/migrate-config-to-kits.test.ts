/**
 * Round-trip test: legacy config → kit manifest → equivalent agent behavior
 *
 * Validates that:
 * 1. A RepositoryConfig with projectPaths overrides can be converted to
 *    per-project KitManifests via the legacy bridge.
 * 2. Each generated manifest passes validateKitManifest().
 * 3. The compose pipeline produces the same commands as the original config.
 * 4. The migration CLI writes syntactically valid TOML that round-trips
 *    through parseKitManifest().
 *
 * Linear: REN-1294
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  synthesizeKitsFromLegacyConfig,
  projectConfigToKitManifest,
  serializeKitManifestToToml,
  validateKitManifest,
  parseKitManifest,
  composeKits,
  getProjectConfig,
} from '@donmai/core'
import type { RepositoryConfig, ProjectConfig } from '@donmai/core'
import { runMigration } from './migrate-config-to-kits.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepoConfig(projectPaths: RepositoryConfig['projectPaths']): RepositoryConfig {
  return {
    apiVersion: 'v1',
    kind: 'RepositoryConfig',
    repository: 'github.com/test/repo',
    projectPaths,
  }
}

function makeTmpRepo(): string {
  const dir = join(tmpdir(), `af-migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, '.donmai'), { recursive: true })
  return dir
}

function writeRepoConfig(repoRoot: string, content: string): void {
  writeFileSync(join(repoRoot, '.donmai', 'config.yaml'), content, 'utf-8')
}

// ---------------------------------------------------------------------------
// Unit: projectConfigToKitManifest
// ---------------------------------------------------------------------------

describe('projectConfigToKitManifest', () => {
  it('produces a valid kit manifest from a full ProjectConfig', () => {
    const config: ProjectConfig = {
      path: 'apps/family-ios',
      packageManager: 'none',
      buildCommand: 'make build',
      testCommand: 'make test',
      validateCommand: 'make build',
    }

    const manifest = projectConfigToKitManifest('Family iOS', config)
    const result = validateKitManifest(manifest)

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(manifest.kit.id).toBe('project/family-ios')
    expect(manifest.kit.name).toBe('Family iOS')
    expect(manifest.provide?.commands?.build).toBe('make build')
    expect(manifest.provide?.commands?.test).toBe('make test')
    expect(manifest.provide?.commands?.validate).toBe('make build')
  })

  it('produces a valid kit manifest for a path-only project (no overrides)', () => {
    const config: ProjectConfig = {
      path: 'apps/social',
    }

    const manifest = projectConfigToKitManifest('Social', config)
    const result = validateKitManifest(manifest)

    expect(result.valid).toBe(true)
    expect(manifest.kit.id).toBe('project/social')
    // No commands section when there are no overrides
    expect(manifest.provide?.commands).toBeUndefined()
  })

  it('uses project order group so it overrides foundation/framework kits', () => {
    const config: ProjectConfig = { path: 'apps/web', buildCommand: 'yarn build' }
    const manifest = projectConfigToKitManifest('Web', config)

    expect(manifest.composition?.order).toBe('project')
  })

  it('slugifies project names correctly', () => {
    const cases: Array<[string, string]> = [
      ['Family iOS', 'project/family-ios'],
      ['My Project 2.0', 'project/my-project-2-0'],
      ['API Backend', 'project/api-backend'],
      ['single', 'project/single'],
    ]

    for (const [name, expectedId] of cases) {
      const manifest = projectConfigToKitManifest(name, { path: 'x' })
      expect(manifest.kit.id).toBe(expectedId)
    }
  })

  it('includes the project path in detect.files', () => {
    const config: ProjectConfig = { path: 'apps/family-ios', buildCommand: 'make build' }
    const manifest = projectConfigToKitManifest('Family iOS', config)

    expect(manifest.detect?.files).toBeDefined()
    expect(manifest.detect!.files!.some((f) => f.startsWith('apps/family-ios/'))).toBe(true)
  })

  it('supports declaration defaults to all platforms', () => {
    const manifest = projectConfigToKitManifest('Test', { path: 'test' })

    expect(manifest.supports?.os).toContain('linux')
    expect(manifest.supports?.os).toContain('macos')
    expect(manifest.supports?.arch).toContain('x86_64')
    expect(manifest.supports?.arch).toContain('arm64')
  })
})

// ---------------------------------------------------------------------------
// Unit: synthesizeKitsFromLegacyConfig
// ---------------------------------------------------------------------------

describe('synthesizeKitsFromLegacyConfig', () => {
  it('returns empty array for null config', () => {
    expect(synthesizeKitsFromLegacyConfig(null)).toEqual([])
  })

  it('returns empty array for config without projectPaths', () => {
    const config = makeRepoConfig(undefined)
    expect(synthesizeKitsFromLegacyConfig(config)).toEqual([])
  })

  it('returns one kit per projectPaths entry', () => {
    const config = makeRepoConfig({
      Social: 'apps/social',
      'Family iOS': {
        path: 'apps/family-ios',
        packageManager: 'none',
        buildCommand: 'make build',
        testCommand: 'make test',
        validateCommand: 'make build',
      },
    })

    const kits = synthesizeKitsFromLegacyConfig(config)

    expect(kits).toHaveLength(2)
    expect(kits.map((k) => k.kit.id).sort()).toEqual([
      'project/family-ios',
      'project/social',
    ])
  })

  it('all synthesized kits pass validateKitManifest', () => {
    const config = makeRepoConfig({
      Social: 'apps/social',
      'Family iOS': {
        path: 'apps/family-ios',
        buildCommand: 'make build',
        testCommand: 'make test',
      },
      Extension: { path: 'apps/extension', validateCommand: 'cargo clippy' },
    })

    const kits = synthesizeKitsFromLegacyConfig(config)

    for (const kit of kits) {
      const result = validateKitManifest(kit)
      expect(result.valid, `Kit ${kit.kit.id}: ${result.errors.join('; ')}`).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Round-trip: legacy config → kits → composeKits → equivalent commands
// ---------------------------------------------------------------------------

describe('round-trip: legacy config → kit manifest → compose → equivalent behavior', () => {
  it('compose produces the same commands as the original ProjectConfig', () => {
    const repoConfig = makeRepoConfig({
      'Family iOS': {
        path: 'apps/family-ios',
        packageManager: 'none',
        buildCommand: 'make build',
        testCommand: 'make test',
        validateCommand: 'make build',
      },
    })

    // What the original config says
    const legacyConfig = getProjectConfig(repoConfig, 'Family iOS')!
    expect(legacyConfig.buildCommand).toBe('make build')
    expect(legacyConfig.testCommand).toBe('make test')
    expect(legacyConfig.validateCommand).toBe('make build')

    // Synthesize kits and compose
    const kits = synthesizeKitsFromLegacyConfig(repoConfig)
    const composed = composeKits(kits)

    // Composed commands must match the original config
    expect(composed.commands.build).toBe(legacyConfig.buildCommand)
    expect(composed.commands.test).toBe(legacyConfig.testCommand)
    expect(composed.commands.validate).toBe(legacyConfig.validateCommand)
    expect(composed.errors).toHaveLength(0)
  })

  it('repo-wide defaults are inherited when project has no per-project overrides', () => {
    const repoConfig: RepositoryConfig = {
      apiVersion: 'v1',
      kind: 'RepositoryConfig',
      buildCommand: 'pnpm build',
      testCommand: 'pnpm test',
      validateCommand: 'pnpm typecheck',
      projectPaths: {
        Social: 'apps/social', // no per-project overrides
      },
    }

    const legacyConfig = getProjectConfig(repoConfig, 'Social')!
    // Repo-wide defaults are inherited
    expect(legacyConfig.buildCommand).toBe('pnpm build')
    expect(legacyConfig.testCommand).toBe('pnpm test')

    const kits = synthesizeKitsFromLegacyConfig(repoConfig)
    const composed = composeKits(kits)

    // Kit inherits the repo-wide defaults (getProjectConfig applies them)
    expect(composed.commands.build).toBe('pnpm build')
    expect(composed.commands.test).toBe('pnpm test')
    expect(composed.commands.validate).toBe('pnpm typecheck')
  })

  it('last-applied-wins: per-project kit overrides foundation kit commands', () => {
    const repoConfig = makeRepoConfig({
      'Family iOS': {
        path: 'apps/family-ios',
        buildCommand: 'make build',
        testCommand: 'make test',
      },
    })

    // Foundation kit sets generic defaults
    const foundationKit = projectConfigToKitManifest('foundation', {
      path: '',
      buildCommand: 'pnpm build',
      testCommand: 'pnpm test',
    })
    // Give it a foundation order
    const foundation = {
      ...foundationKit,
      kit: { ...foundationKit.kit, id: 'foundation/generic' },
      composition: { order: 'foundation' as const },
    }

    // Project kit (from legacy config)
    const projectKits = synthesizeKitsFromLegacyConfig(repoConfig)

    const composed = composeKits([foundation, ...projectKits])

    // Project kit wins
    expect(composed.commands.build).toBe('make build')
    expect(composed.commands.test).toBe('make test')
  })
})

// ---------------------------------------------------------------------------
// TOML round-trip: serializeKitManifestToToml → parseKitManifest
// ---------------------------------------------------------------------------

describe('TOML round-trip: serializeKitManifestToToml → parseKitManifest', () => {
  it('serializes and parses back to an equivalent manifest', () => {
    const config: ProjectConfig = {
      path: 'apps/family-ios',
      buildCommand: 'make build',
      testCommand: 'make test',
      validateCommand: 'make build',
    }
    const manifest = projectConfigToKitManifest('Family iOS', config)
    const toml = serializeKitManifestToToml(manifest)

    // Must parse without throwing
    const parsed = parseKitManifest(toml)

    expect(parsed.api).toBe('rensei.dev/v1')
    expect(parsed.kit.id).toBe('project/family-ios')
    expect(parsed.kit.version).toBe('0.0.0')
    expect(parsed.kit.name).toBe('Family iOS')
    expect(parsed.provide?.commands?.build).toBe('make build')
    expect(parsed.provide?.commands?.test).toBe('make test')
    expect(parsed.provide?.commands?.validate).toBe('make build')
  })

  it('parsed TOML passes validateKitManifest', () => {
    const config: ProjectConfig = { path: 'apps/social', buildCommand: 'pnpm build' }
    const manifest = projectConfigToKitManifest('Social', config)
    const toml = serializeKitManifestToToml(manifest)
    const parsed = parseKitManifest(toml)
    const result = validateKitManifest(parsed)

    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('handles project names with special characters', () => {
    const config: ProjectConfig = { path: 'apps/my-app', testCommand: 'npm test -- --ci' }
    const manifest = projectConfigToKitManifest('My "App" (v2)', config)
    const toml = serializeKitManifestToToml(manifest)
    const parsed = parseKitManifest(toml)

    expect(parsed.provide?.commands?.test).toBe('npm test -- --ci')
  })
})

// ---------------------------------------------------------------------------
// Integration: runMigration CLI
// ---------------------------------------------------------------------------

describe('runMigration CLI', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpRepo()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates .donmai/kits/<project>.kit.toml for each projectPaths entry', async () => {
    const yaml = `
apiVersion: v1
kind: RepositoryConfig
repository: github.com/test/repo
projectPaths:
  Social: apps/social
  "Family iOS":
    path: apps/family-ios
    packageManager: none
    buildCommand: "make build"
    testCommand: "make test"
`
    writeRepoConfig(tmpDir, yaml)

    await runMigration(['node', 'af-migrate-config-to-kits', '--repo-root', tmpDir])

    const kitsDir = join(tmpDir, '.donmai', 'kits')
    expect(existsSync(join(kitsDir, 'social.kit.toml'))).toBe(true)
    expect(existsSync(join(kitsDir, 'family-ios.kit.toml'))).toBe(true)
  })

  it('written TOML files pass validateKitManifest', async () => {
    const yaml = `
apiVersion: v1
kind: RepositoryConfig
projectPaths:
  Backend:
    path: services/backend
    buildCommand: "cargo build"
    testCommand: "cargo test"
    validateCommand: "cargo clippy"
`
    writeRepoConfig(tmpDir, yaml)

    await runMigration(['node', 'af-migrate-config-to-kits', '--repo-root', tmpDir])

    const tomlPath = join(tmpDir, '.donmai', 'kits', 'backend.kit.toml')
    expect(existsSync(tomlPath)).toBe(true)

    const { readFileSync } = await import('fs')
    const content = readFileSync(tomlPath, 'utf-8')
    const parsed = parseKitManifest(content)
    const result = validateKitManifest(parsed)

    expect(result.valid).toBe(true)
    expect(parsed.provide?.commands?.build).toBe('cargo build')
    expect(parsed.provide?.commands?.test).toBe('cargo test')
    expect(parsed.provide?.commands?.validate).toBe('cargo clippy')
  })

  it('dry-run does not create any files', async () => {
    const yaml = `
apiVersion: v1
kind: RepositoryConfig
projectPaths:
  Social: apps/social
`
    writeRepoConfig(tmpDir, yaml)

    await runMigration(['node', 'af-migrate-config-to-kits', '--repo-root', tmpDir, '--dry-run'])

    const kitsDir = join(tmpDir, '.donmai', 'kits')
    expect(existsSync(kitsDir)).toBe(false)
  })

  it('skips existing files without overwriting', async () => {
    const yaml = `
apiVersion: v1
kind: RepositoryConfig
projectPaths:
  Social: apps/social
`
    writeRepoConfig(tmpDir, yaml)

    // Create the output directory and pre-existing file
    const kitsDir = join(tmpDir, '.donmai', 'kits')
    mkdirSync(kitsDir, { recursive: true })
    writeFileSync(join(kitsDir, 'social.kit.toml'), 'original content', 'utf-8')

    await runMigration(['node', 'af-migrate-config-to-kits', '--repo-root', tmpDir])

    // File should not be overwritten
    const { readFileSync } = await import('fs')
    expect(readFileSync(join(kitsDir, 'social.kit.toml'), 'utf-8')).toBe('original content')
  })

  it('exits cleanly when no config.yaml is present', async () => {
    // No config.yaml in tmpDir
    await expect(
      runMigration(['node', 'af-migrate-config-to-kits', '--repo-root', tmpDir]),
    ).resolves.toBeUndefined()
  })

  it('exits cleanly when config has no projectPaths', async () => {
    const yaml = `
apiVersion: v1
kind: RepositoryConfig
allowedProjects:
  - MyProject
`
    writeRepoConfig(tmpDir, yaml)

    await expect(
      runMigration(['node', 'af-migrate-config-to-kits', '--repo-root', tmpDir]),
    ).resolves.toBeUndefined()
  })
})
