#!/usr/bin/env node
/**
 * AgentFactory Config → Kits Migration CLI
 *
 * One-shot migration that converts per-project overrides in
 * `.donmai/config.yaml` (`projectPaths` with buildCommand /
 * testCommand / validateCommand / packageManager) into per-project
 * `.donmai/kits/<project>.kit.toml` manifests.
 *
 * After migration the legacy config is still valid (read-only bridge
 * continues to synthesize in-memory kits), so migration is opt-in.
 *
 * Usage:
 *   af-migrate-config-to-kits [options]
 *
 * Options:
 *   --repo-root <path>   Git repo root (default: git rev-parse --show-toplevel)
 *   --dry-run            Print what would be written without writing files
 *   --help, -h           Show this help message
 *
 * Linear: REN-1294
 */

import { execSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { resolve, join } from 'path'
import {
  loadRepositoryConfig,
  getProjectConfig,
  projectConfigToKitManifest,
  serializeKitManifestToToml,
  validateKitManifest,
} from '@donmai/core'

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  repoRoot: string | null
  dryRun: boolean
  help: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2)
  const result: CliArgs = { repoRoot: null, dryRun: false, help: false }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--repo-root':
        result.repoRoot = args[++i] ?? null
        break
      case '--dry-run':
        result.dryRun = true
        break
      case '--help':
      case '-h':
        result.help = true
        break
      default:
        console.error(`Unknown argument: ${arg}`)
        process.exit(1)
    }
  }

  return result
}

function printHelp(): void {
  console.log(`
AgentFactory Config → Kits Migration

Converts projectPaths overrides in .donmai/config.yaml into
per-project .donmai/kits/<project>.kit.toml manifests.

Usage:
  af-migrate-config-to-kits [options]

Options:
  --repo-root <path>   Git repo root directory (default: auto-detected via git)
  --dry-run            Preview what would be written without writing any files
  --help, -h           Show this help message

Examples:
  # Preview migration
  af-migrate-config-to-kits --dry-run

  # Run migration
  af-migrate-config-to-kits

  # Specify repo root explicitly
  af-migrate-config-to-kits --repo-root /path/to/repo
`)
}

// ---------------------------------------------------------------------------
// Git root detection
// ---------------------------------------------------------------------------

function detectGitRoot(hint: string | null): string {
  if (hint) return resolve(hint)
  try {
    return execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return process.cwd()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface MigrationResult {
  projectName: string
  outputPath: string
  status: 'written' | 'skipped' | 'dry-run' | 'error'
  reason?: string
}

export async function runMigration(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv)

  if (args.help) {
    printHelp()
    return
  }

  const repoRoot = detectGitRoot(args.repoRoot)
  console.log(`\n=== AgentFactory Config → Kits Migration ===\n`)
  console.log(`Repo root: ${repoRoot}`)

  if (args.dryRun) {
    console.log('[DRY RUN MODE — no files will be written]\n')
  } else {
    console.log('')
  }

  // Load legacy config
  const repoConfig = loadRepositoryConfig(repoRoot)

  if (!repoConfig) {
    console.log(`No .donmai/config.yaml found at ${repoRoot}`)
    console.log('Nothing to migrate.\n')
    return
  }

  if (!repoConfig.projectPaths || Object.keys(repoConfig.projectPaths).length === 0) {
    console.log('No projectPaths entries found in config.yaml')
    console.log('Nothing to migrate.\n')
    return
  }

  const projectNames = Object.keys(repoConfig.projectPaths)
  console.log(`Found ${projectNames.length} project(s) in projectPaths:\n`)

  // Output directory: .donmai/kits/ at the repo root
  const kitsDir = join(repoRoot, '.donmai', 'kits')

  if (!args.dryRun && !existsSync(kitsDir)) {
    mkdirSync(kitsDir, { recursive: true })
    console.log(`Created directory: ${kitsDir}\n`)
  }

  const results: MigrationResult[] = []

  for (const projectName of projectNames) {
    const config = getProjectConfig(repoConfig, projectName)
    if (!config) {
      results.push({
        projectName,
        outputPath: '',
        status: 'error',
        reason: 'getProjectConfig returned null unexpectedly',
      })
      continue
    }

    // Generate the kit manifest
    const manifest = projectConfigToKitManifest(projectName, config)

    // Validate before writing
    const validation = validateKitManifest(manifest)
    if (!validation.valid) {
      results.push({
        projectName,
        outputPath: '',
        status: 'error',
        reason: `Kit manifest validation failed: ${validation.errors.join('; ')}`,
      })
      continue
    }

    // Slugify name to a safe filename
    const slug = projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    const fileName = `${slug}.kit.toml`
    const outputPath = join(kitsDir, fileName)

    const tomlContent = serializeKitManifestToToml(manifest)

    if (args.dryRun) {
      console.log(`  [DRY RUN] Would write: ${outputPath}`)
      console.log(`  kit.id:      ${manifest.kit.id}`)
      console.log(`  path:        ${config.path}`)
      if (config.buildCommand) console.log(`  build:       ${config.buildCommand}`)
      if (config.testCommand) console.log(`  test:        ${config.testCommand}`)
      if (config.validateCommand) console.log(`  validate:    ${config.validateCommand}`)
      if (config.packageManager) console.log(`  packageMgr:  ${config.packageManager}`)
      console.log('')
      results.push({ projectName, outputPath, status: 'dry-run' })
      continue
    }

    if (existsSync(outputPath)) {
      console.log(`  SKIPPED (already exists): ${outputPath}`)
      results.push({ projectName, outputPath, status: 'skipped', reason: 'file already exists' })
      continue
    }

    try {
      writeFileSync(outputPath, tomlContent, 'utf-8')
      console.log(`  WRITTEN: ${outputPath}`)
      results.push({ projectName, outputPath, status: 'written' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  ERROR: ${outputPath} — ${msg}`)
      results.push({ projectName, outputPath, status: 'error', reason: msg })
    }
  }

  // Summary
  const written = results.filter((r) => r.status === 'written').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  const dryRun = results.filter((r) => r.status === 'dry-run').length
  const errors = results.filter((r) => r.status === 'error')

  console.log('\n=== Summary ===\n')
  if (args.dryRun) {
    console.log(`  Would write: ${dryRun}`)
  } else {
    console.log(`  Written:  ${written}`)
    if (skipped > 0) console.log(`  Skipped:  ${skipped} (already exist)`)
  }

  if (errors.length > 0) {
    console.log(`  Errors:   ${errors.length}`)
    for (const e of errors) {
      console.log(`    ${e.projectName}: ${e.reason}`)
    }
  }

  console.log('')

  if (!args.dryRun && written > 0) {
    console.log('Migration complete. The legacy .donmai/config.yaml remains valid.')
    console.log('Generated kit manifests are in: ' + kitsDir)
    console.log(
      'The kit composition pipeline will now use both the legacy bridge and the new manifests.\n',
    )
  }

  if (errors.length > 0) {
    process.exit(1)
  }
}

// Only run main when executed directly (not imported in tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigration().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
