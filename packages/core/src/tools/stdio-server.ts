/**
 * MCP Stdio Server Abstraction Layer
 *
 * Converts ToolPlugin instances into standalone @modelcontextprotocol/sdk
 * McpServer processes using stdio transport. This allows MCP clients like
 * Codex to discover and invoke in-process tools (af_code_*, af_linear_*)
 * through the standard MCP protocol over stdio.
 *
 * Architecture:
 *   ToolPlugin (in-process tools via @anthropic-ai/claude-agent-sdk)
 *     → StdioToolServer (standalone @modelcontextprotocol/sdk server)
 *       → Codex app-server (MCP client consuming tools)
 *
 * Each plugin becomes a separate stdio server child process so failures
 * are isolated and Codex can manage them independently.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { ToolPlugin, ToolPluginContext } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for a single stdio MCP server that Codex can consume */
export interface StdioMcpServerConfig {
  /** Server name (matches plugin name, e.g. 'af-linear') */
  name: string
  /** Command to spawn the server */
  command: string
  /** Arguments to pass to the command */
  args: string[]
  /** Environment variables for the server process */
  env: Record<string, string>
  /** Tool names provided by this server */
  toolNames: string[]
}

/** Result from creating stdio server configs for all registered plugins */
export interface CreateStdioServersResult {
  /** Per-server configurations keyed by plugin name */
  servers: StdioMcpServerConfig[]
  /** All tool names across all servers */
  toolNames: string[]
}

/** A running stdio MCP server process */
export interface StdioServerHandle {
  /** Plugin name */
  name: string
  /** The child process */
  process: ChildProcess
  /** Tool names served by this process */
  toolNames: string[]
  /** Stop the server */
  stop(): Promise<void>
}

// ---------------------------------------------------------------------------
// Server Entry Point Protocol
// ---------------------------------------------------------------------------

/**
 * Message protocol between parent (orchestrator) and stdio server child.
 * The parent sends a JSON-serialized PluginBootstrap on the child's stdin
 * on startup, then the child runs the MCP stdio transport loop.
 */
export interface PluginBootstrap {
  /** Plugin name */
  pluginName: string
  /** Serialized tool definitions (JSON-compatible subset) */
  tools: SerializedToolDef[]
  /** Plugin context for tool creation */
  context: ToolPluginContext
}

export interface SerializedToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Registry Extension: Create stdio server configurations
// ---------------------------------------------------------------------------

/**
 * Create stdio MCP server configurations from ToolPlugin instances.
 *
 * This does NOT spawn processes — it returns the configuration that
 * the Codex app-server needs to register and spawn the servers itself
 * via `config/batchWrite`.
 *
 * The server entry point is `packages/core/src/tools/stdio-server-entry.ts`
 * which is compiled to `dist/src/tools/stdio-server-entry.js`.
 */
export function createStdioServerConfigs(
  plugins: ToolPlugin[],
  context: ToolPluginContext,
): CreateStdioServersResult {
  const servers: StdioMcpServerConfig[] = []
  const allToolNames: string[] = []

  // Resolve path to the compiled server entry point
  const entryPoint = resolveEntryPoint()

  for (const plugin of plugins) {
    const tools = plugin.createTools(context)
    if (tools.length === 0) continue

    const toolNames = tools.map(t => t.name)
    allToolNames.push(...toolNames)

    servers.push({
      name: plugin.name,
      command: 'node',
      args: [entryPoint, '--plugin', plugin.name],
      env: { ...context.env },
      toolNames,
    })
  }

  return { servers, toolNames: allToolNames }
}

/**
 * Resolve the path to the compiled stdio server entry point.
 * Works in both source (src/) and compiled (dist/) contexts.
 */
function resolveEntryPoint(): string {
  const thisFile = fileURLToPath(import.meta.url)
  const thisDir = dirname(thisFile)

  // In compiled output: dist/src/tools/stdio-server.js → dist/src/tools/stdio-server-entry.js
  // In source: src/tools/stdio-server.ts → need to compile first
  return join(thisDir, 'stdio-server-entry.js')
}

// ---------------------------------------------------------------------------
// Spawn a stdio MCP server for a plugin
// ---------------------------------------------------------------------------

/**
 * Spawn a stdio MCP server child process for a ToolPlugin.
 *
 * This is used by the orchestrator to create actual running servers
 * that Codex can connect to. The child process runs the MCP protocol
 * over its stdin/stdout.
 */
export function spawnStdioServer(
  plugin: ToolPlugin,
  context: ToolPluginContext,
): StdioServerHandle {
  const tools = plugin.createTools(context)
  const toolNames = tools.map(t => t.name)
  const entryPoint = resolveEntryPoint()

  const child = spawn('node', [entryPoint, '--plugin', plugin.name], {
    cwd: context.cwd,
    env: { ...process.env, ...context.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Send bootstrap message with serialized tool definitions
  const bootstrap: PluginBootstrap = {
    pluginName: plugin.name,
    tools: tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: extractInputSchema(t),
    })),
    context,
  }

  child.stdin!.write(JSON.stringify(bootstrap) + '\n')

  child.on('error', (err) => {
    console.error(`[stdio-server:${plugin.name}] Process error:`, err.message)
  })

  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim()
    if (msg) {
      console.error(`[stdio-server:${plugin.name}] ${msg}`)
    }
  })

  return {
    name: plugin.name,
    process: child,
    toolNames,
    async stop() {
      if (!child.killed) {
        child.kill('SIGTERM')
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve())
          setTimeout(() => {
            if (!child.killed) child.kill('SIGKILL')
            resolve()
          }, 3000)
        })
      }
    },
  }
}

/**
 * Extract the JSON Schema input schema from an SDK tool definition.
 * The SDK tool definitions use zod schemas internally, but expose
 * a jsonSchema property for MCP protocol serialization.
 */
function extractInputSchema(tool: { inputSchema?: unknown; schema?: unknown }): Record<string, unknown> {
  // The @anthropic-ai/claude-agent-sdk tool() function produces objects
  // with an inputSchema property that is a JSON Schema object
  if (tool.inputSchema && typeof tool.inputSchema === 'object') {
    return tool.inputSchema as Record<string, unknown>
  }
  if (tool.schema && typeof tool.schema === 'object') {
    return tool.schema as Record<string, unknown>
  }
  return { type: 'object', properties: {} }
}
