/**
 * Tool Permission Adapters
 *
 * Translate abstract tool permissions to provider-native format.
 */

import type { ToolPermission, ToolPermissionAdapter } from './types.js'
import type { AgentProviderName, ToolPermissionFormat } from '../providers/types.js'

// ---------------------------------------------------------------------------
// Codex Permission Config (SUP-1748)
// ---------------------------------------------------------------------------

/**
 * Structured permission config consumed by the Codex approval bridge.
 * Produced by `CodexToolPermissionAdapter.buildPermissionConfig()`.
 */
export interface CodexPermissionConfig {
  /** Allowed command patterns from `tools.allow` */
  allowedCommandPatterns: RegExp[]
  /** Denied command patterns from `tools.disallow` (additive to safety defaults) */
  deniedCommandPatterns: Array<{ pattern: RegExp; reason: string }>
  /** Whether file edits are allowed (default: true) */
  allowFileEdits: boolean
  /** Whether file writes are allowed (default: true) */
  allowFileWrites: boolean
}

/**
 * Claude Code tool permission adapter.
 *
 * Translates abstract permissions to Claude Code's format:
 *   { shell: "pnpm *" }  → "Bash(pnpm:*)"
 *   { shell: "git commit *" } → "Bash(git commit:*)"
 *   "user-input" → "AskUserQuestion"
 */
export class ClaudeToolPermissionAdapter implements ToolPermissionAdapter {
  translatePermissions(permissions: ToolPermission[]): string[] {
    return permissions.map(p => this.translateOne(p))
  }

  private translateOne(permission: ToolPermission): string {
    if (typeof permission === 'string') {
      if (permission === 'user-input') {
        return 'AskUserQuestion'
      }
      // Pass through other string permissions as-is
      return permission
    }

    if ('shell' in permission) {
      // Convert "pnpm *" → "Bash(pnpm:*)"
      // Convert "git commit *" → "Bash(git commit:*)"
      const pattern = permission.shell
      const spaceIndex = pattern.lastIndexOf(' ')
      if (spaceIndex === -1) {
        return `Bash(${pattern}:*)`
      }
      const command = pattern.substring(0, spaceIndex)
      const glob = pattern.substring(spaceIndex + 1)
      return `Bash(${command}:${glob})`
    }

    return String(permission)
  }
}

/**
 * OpenAI Codex tool permission adapter.
 *
 * Codex uses sandbox policies (--full-auto / workspace-write / read-only)
 * and TOML-based sandbox_permissions rather than per-tool allowlists.
 * Shell permissions are passed through as command patterns for documentation
 * and future granular support.
 *
 *   { shell: "pnpm *" }  → "shell:pnpm *"
 *   "user-input" → "user-input" (no-op — Codex exec is non-interactive)
 */
export class CodexToolPermissionAdapter implements ToolPermissionAdapter {
  translatePermissions(permissions: ToolPermission[]): string[] {
    return permissions.map(p => this.translateOne(p))
  }

  /**
   * Build a structured permission config for the Codex approval bridge (SUP-1748).
   *
   * Translates abstract `tools.allow` and `tools.disallow` from templates
   * into regex patterns consumed by `evaluateCommandApproval()` and
   * `evaluateFileChangeApproval()` in the approval bridge.
   */
  buildPermissionConfig(
    allow: ToolPermission[],
    disallow: ToolPermission[],
  ): CodexPermissionConfig {
    const allowedCommandPatterns: RegExp[] = []
    const deniedCommandPatterns: Array<{ pattern: RegExp; reason: string }> = []
    let allowFileEdits = true
    let allowFileWrites = true

    // Process allow list → allowed command patterns
    for (const permission of allow) {
      if (typeof permission !== 'string' && 'shell' in permission) {
        allowedCommandPatterns.push(shellGlobToRegex(permission.shell))
      }
    }

    // Process disallow list → denied patterns + file permission flags
    for (const permission of disallow) {
      if (typeof permission === 'string') {
        if (permission === 'file-edit') {
          allowFileEdits = false
        } else if (permission === 'file-write') {
          allowFileWrites = false
        }
        // 'user-input' is a no-op for Codex (non-interactive)
      } else if ('shell' in permission) {
        deniedCommandPatterns.push({
          pattern: shellGlobToRegex(permission.shell),
          reason: `${permission.shell} blocked by template`,
        })
      }
    }

    return {
      allowedCommandPatterns,
      deniedCommandPatterns,
      allowFileEdits,
      allowFileWrites,
    }
  }

  private translateOne(permission: ToolPermission): string {
    if (typeof permission === 'string') {
      return permission
    }

    if ('shell' in permission) {
      return `shell:${permission.shell}`
    }

    return String(permission)
  }
}

/**
 * Convert a shell glob pattern (e.g., "pnpm *", "git commit *") to a regex.
 *
 * The pattern "pnpm *" matches any command starting with "pnpm".
 * The pattern "git commit *" matches "git commit" followed by anything.
 */
function shellGlobToRegex(glob: string): RegExp {
  // Split on the last space to separate command from glob
  const lastSpace = glob.lastIndexOf(' ')
  if (lastSpace === -1) {
    // No glob part — match command prefix (e.g., "pnpm" matches "pnpm install")
    return new RegExp(`^${escapeRegex(glob)}\\b`)
  }

  const command = glob.substring(0, lastSpace)
  const globPart = glob.substring(lastSpace + 1)

  if (globPart === '*') {
    // "git commit *" → matches "git commit" followed by anything
    return new RegExp(`^${escapeRegex(command)}\\b`)
  }

  // More specific globs: escape and convert * to .*
  const escapedCommand = escapeRegex(command)
  const regexGlob = escapeRegex(globPart).replace(/\\\*/g, '.*')
  return new RegExp(`^${escapedCommand}\\s+${regexGlob}`)
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Spring AI tool permission adapter.
 *
 * Spring AI uses @Tool annotations and ToolCallAdvisor for tool configuration.
 * Shell permissions map to Spring AI's tool-call allowlist format:
 *   { shell: "pnpm *" }  → "spring-tool:shell:pnpm *"
 *   "user-input" → "user-input" (no-op — Spring AI agent is non-interactive)
 */
export class SpringAiToolPermissionAdapter implements ToolPermissionAdapter {
  translatePermissions(permissions: ToolPermission[]): string[] {
    return permissions.map(p => this.translateOne(p))
  }

  private translateOne(permission: ToolPermission): string {
    if (typeof permission === 'string') {
      return permission
    }

    if ('shell' in permission) {
      return `spring-tool:shell:${permission.shell}`
    }

    return String(permission)
  }
}

/**
 * Create a tool permission adapter for the given format.
 *
 * Accepts either a ToolPermissionFormat (capability-based) or an AgentProviderName
 * (legacy) for backward compatibility.
 */
export function createToolPermissionAdapter(format: ToolPermissionFormat | AgentProviderName): ToolPermissionAdapter {
  switch (format) {
    case 'claude':
      return new ClaudeToolPermissionAdapter()
    case 'codex':
      return new CodexToolPermissionAdapter()
    case 'spring-ai':
      return new SpringAiToolPermissionAdapter()
    case 'amp':
    case 'a2a':
      return new ClaudeToolPermissionAdapter()
    default:
      return new ClaudeToolPermissionAdapter()
  }
}
