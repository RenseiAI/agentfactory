#!/usr/bin/env node
/**
 * Stdio MCP Server Entry Point
 *
 * This file is spawned as a child process by the orchestrator.
 * It receives a PluginBootstrap message on stdin, then starts an
 * @modelcontextprotocol/sdk McpServer with stdio transport, exposing
 * the plugin's tools to any MCP client (e.g. Codex app-server).
 *
 * Protocol:
 * 1. Parent sends JSON bootstrap message on first stdin line
 * 2. Child creates McpServer with tool definitions from bootstrap
 * 3. Child connects stdio transport — subsequent stdin/stdout is MCP protocol
 *
 * Tool handlers forward calls back to the parent via a simple
 * request/response protocol over stderr (to avoid mixing with MCP on stdout).
 * However, since the parent holds the ToolPlugin instances, we use a
 * callback-based approach where the parent injects tool handlers.
 *
 * Simpler approach: The entry point re-creates the ToolPlugin from the
 * plugin package and runs tools in-process. This means the child process
 * has the same tool implementations as the parent.
 */

import { createInterface } from 'node:readline'
import type { PluginBootstrap, SerializedToolDef } from './stdio-server.js'

// Dynamic imports for MCP SDK — these are peer dependencies
async function loadMcpSdk() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zod = await import('zod')
  return { McpServer, StdioServerTransport, z: zod.z ?? zod }
}

// ---------------------------------------------------------------------------
// File Reservation Delegate Reconstruction
// ---------------------------------------------------------------------------

/**
 * Reconstruct the file reservation delegate in the child process.
 * When the orchestrator serializes ToolPluginContext over stdin, function
 * references on fileReservation are lost. If REDIS_URL is available we can
 * dynamically import the server package and create a fresh delegate.
 */
async function reconstructFileReservationDelegate(
  env: Record<string, string>,
): Promise<Record<string, Function> | null> {
  try {
    // Dynamic import — server package is available at runtime but is NOT a compile-time
    // dependency of core. Use a variable to prevent TypeScript module resolution.
    const serverPkg = '@donmai/server'
    const serverMod = await import(serverPkg)
    const { reserveFiles, checkFileConflicts, releaseFiles, releaseAllSessionFiles } = serverMod
    // Derive repoId from the working directory name (same convention as CLI runners)
    const { basename } = await import('node:path')
    const repoId = basename(process.cwd())

    return {
      reserveFiles: (sessionId: string, filePaths: string[], reason?: string) =>
        reserveFiles(repoId, sessionId, filePaths, reason),
      checkFileConflicts: (sessionId: string, filePaths: string[]) =>
        checkFileConflicts(repoId, sessionId, filePaths),
      releaseFiles: (sessionId: string, filePaths: string[]) =>
        releaseFiles(repoId, sessionId, filePaths),
      releaseAllSessionFiles: (sessionId: string) =>
        releaseAllSessionFiles(repoId, sessionId),
    }
  } catch {
    // Server package not available in this process — skip file reservation
    console.error('[stdio-server] Could not reconstruct file reservation delegate (server package unavailable)')
    return null
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Read the bootstrap message from the first line of stdin
  const bootstrap = await readBootstrap()

  const { McpServer, StdioServerTransport, z } = await loadMcpSdk()

  // Create the MCP server
  const server = new McpServer({
    name: bootstrap.pluginName,
    version: '1.0.0',
  })

  // Load the actual plugin to get real tool handlers
  const plugin = await loadPlugin(bootstrap.pluginName)

  // Reconstruct file reservation delegate for code-intelligence in stdio servers.
  // The delegate has function references that don't survive JSON serialization
  // from the parent process. Try Redis first (OSS), then platform API proxy (SaaS).
  if (
    bootstrap.pluginName === 'af-code-intelligence' &&
    !bootstrap.context.fileReservation
  ) {
    if (process.env.REDIS_URL) {
      const delegate = await reconstructFileReservationDelegate(bootstrap.context.env)
      if (delegate) {
        ;(bootstrap.context as any).fileReservation = delegate
      }
    } else if (process.env.AGENTFACTORY_API_URL && process.env.WORKER_AUTH_TOKEN) {
      // Platform-proxied mode: use HTTP delegate
      const { createProxyFileReservationDelegate } = await import('../file-reservation/index.js')
      ;(bootstrap.context as any).fileReservation = createProxyFileReservationDelegate({
        apiUrl: process.env.AGENTFACTORY_API_URL,
        apiKey: process.env.WORKER_AUTH_TOKEN,
      })
      console.error('[stdio-server] Reconstructed file reservation delegate via platform API proxy')
    }
  }

  if (plugin) {
    // We have the actual plugin — register real tool handlers
    const tools = plugin.createTools(bootstrap.context)
    for (const tool of tools) {
      const inputSchema = extractZodSchema(tool, z)
      server.tool(
        tool.name,
        tool.description ?? '',
        inputSchema,
        async (args: Record<string, unknown>) => {
          try {
            // Call the tool's handler directly
            const result = await (tool as any).handler(args)
            return result
          } catch (err) {
            return {
              content: [{
                type: 'text' as const,
                text: `Error: ${err instanceof Error ? err.message : String(err)}`,
              }],
              isError: true,
            }
          }
        },
      )
    }
  } else {
    // Fallback: register stub tools from serialized definitions
    registerStubTools(server, bootstrap.tools, z)
  }

  // Connect stdio transport — from here, stdin/stdout is MCP protocol
  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error(`[stdio-server:${bootstrap.pluginName}] MCP server ready with ${bootstrap.tools.length} tools`)
}

// ---------------------------------------------------------------------------
// Plugin Loading
// ---------------------------------------------------------------------------

interface ToolPluginLike {
  name: string
  createTools(context: { env: Record<string, string>; cwd: string; fileReservation?: unknown }): any[]
}

async function loadPlugin(name: string): Promise<ToolPluginLike | null> {
  // Try to import the plugin package based on naming convention
  const pluginPackages: Record<string, { module: string; export: string }> = {
    'af-linear': {
      module: '@donmai/plugin-linear',
      export: 'linearPlugin',
    },
    'af-code-intelligence': {
      module: '@donmai/code-intelligence',
      export: 'codeIntelligencePlugin',
    },
  }

  const pkg = pluginPackages[name]
  if (!pkg) return null

  try {
    const mod = await import(pkg.module)
    return mod[pkg.export] ?? null
  } catch {
    // Plugin package not available in this process — fall back to stubs
    console.error(`[stdio-server:${name}] Could not load plugin package, using stub handlers`)
    return null
  }
}

// ---------------------------------------------------------------------------
// Zod Schema Extraction
// ---------------------------------------------------------------------------

/**
 * Extract a Zod schema from an SDK tool definition for registration
 * with @modelcontextprotocol/sdk McpServer.tool().
 */
function extractZodSchema(
  tool: any,
  z: any,
): Record<string, any> {
  // The SDK tool definitions may carry a zod schema or JSON Schema.
  // For McpServer.tool(), we need a Zod schema object.
  // Since tools from the SDK use z.string(), z.number(), etc., we try
  // to extract the zod shape directly.
  if (tool.inputSchema?.shape) {
    return tool.inputSchema.shape
  }
  // Fallback: return empty shape (no params)
  return {}
}

// ---------------------------------------------------------------------------
// Stub Tools (fallback when plugin package unavailable)
// ---------------------------------------------------------------------------

function registerStubTools(
  server: any,
  tools: SerializedToolDef[],
  z: any,
): void {
  for (const toolDef of tools) {
    // Convert JSON Schema to basic Zod types
    const zodSchema = jsonSchemaToZod(toolDef.inputSchema, z)

    server.tool(
      toolDef.name,
      toolDef.description,
      zodSchema,
      async () => ({
        content: [{
          type: 'text' as const,
          text: 'Error: Tool handler not available. Plugin package could not be loaded in this process.',
        }],
        isError: true,
      }),
    )
  }
}

function jsonSchemaToZod(
  schema: Record<string, unknown>,
  z: any,
): Record<string, any> {
  const properties = schema.properties as Record<string, any> | undefined
  if (!properties) return {}

  const required = new Set((schema.required as string[]) ?? [])
  const shape: Record<string, any> = {}

  for (const [key, prop] of Object.entries(properties)) {
    let zodType: any

    switch (prop.type) {
      case 'string':
        zodType = z.string()
        break
      case 'number':
      case 'integer':
        zodType = z.number()
        break
      case 'boolean':
        zodType = z.boolean()
        break
      case 'array':
        zodType = z.array(z.any())
        break
      default:
        zodType = z.any()
    }

    if (prop.description) {
      zodType = zodType.describe(prop.description)
    }

    if (!required.has(key)) {
      zodType = zodType.optional() as any
    }

    shape[key] = zodType
  }

  return shape
}

// ---------------------------------------------------------------------------
// Bootstrap Reader
// ---------------------------------------------------------------------------

async function readBootstrap(): Promise<PluginBootstrap> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin })
    const timer = setTimeout(() => {
      rl.close()
      reject(new Error('Timeout waiting for bootstrap message'))
    }, 10000)

    rl.once('line', (line) => {
      clearTimeout(timer)
      rl.close()
      try {
        resolve(JSON.parse(line) as PluginBootstrap)
      } catch (err) {
        reject(new Error(`Invalid bootstrap message: ${err}`))
      }
    })

    rl.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(`[stdio-server] Fatal error: ${err.message}`)
  process.exit(1)
})
