/**
 * A2A Server Handlers
 *
 * Framework-agnostic utilities for exposing AgentFactory fleet capabilities
 * via the Agent-to-Agent (A2A) protocol. Provides AgentCard generation,
 * JSON-RPC request routing, and SSE event formatting.
 *
 * Consuming applications wire these handlers into their own HTTP server
 * (Express, Hono, Next.js, etc.) — this module has no framework dependency.
 */

import { extractBearerToken, verifyApiKey } from './worker-auth.js'
import type { AgentWorkType } from './types.js'
import type {
  A2aAgentCard,
  A2aAuthScheme,
  A2aMessage,
  A2aSkill,
  A2aTask,
  A2aTaskEvent,
  JsonRpcRequest,
  JsonRpcResponse,
} from './a2a-types.js'

// ---------------------------------------------------------------------------
// AgentCard builder
// ---------------------------------------------------------------------------

/** Configuration for building an AgentCard */
export interface A2aServerConfig {
  /** Human-readable agent name */
  name: string
  /** Short description of the agent's purpose */
  description: string
  /** Base URL where A2A endpoints are exposed */
  url: string
  /** Semantic version of the agent (defaults to '1.0.0') */
  version?: string
  /** Explicit skill list; when omitted skills are derived from AgentWorkType */
  skills?: A2aSkill[]
  /** Whether the agent supports SSE streaming (defaults to false) */
  streaming?: boolean
  /** Authentication schemes the endpoint accepts */
  authSchemes?: A2aAuthScheme[]
}

/**
 * Mapping from AgentWorkType values to auto-generated skill descriptors.
 * Used when the caller does not supply an explicit skill list.
 */
const WORK_TYPE_SKILLS: Record<AgentWorkType, A2aSkill> = {
  development: {
    id: 'code-development',
    name: 'Code Development',
    description: 'Implement features, fix bugs, and write code changes',
    tags: ['coding', 'development'],
  },
  qa: {
    id: 'quality-assurance',
    name: 'Quality Assurance',
    description: 'Run tests, review code quality, and verify changes',
    tags: ['testing', 'qa'],
  },
  research: {
    id: 'research-analysis',
    name: 'Research & Analysis',
    description: 'Investigate topics, gather information, and produce research reports',
    tags: ['research', 'analysis'],
  },
  'backlog-creation': {
    id: 'backlog-creation',
    name: 'Backlog Creation',
    description: 'Create and prioritize backlog items from requirements',
    tags: ['planning', 'backlog'],
  },
  'backlog-groomer': {
    id: 'backlog-groomer',
    name: 'Backlog Groomer',
    description: 'Triage one icebox issue per invocation: discard, refine, or escalate-human (PM agent)',
    tags: ['planning', 'backlog', 'pm'],
  },
  inflight: {
    id: 'inflight-work',
    name: 'In-Flight Work',
    description: 'Continue work on in-progress tasks',
    tags: ['workflow'],
  },
  acceptance: {
    id: 'acceptance-review',
    name: 'Acceptance Review',
    description: 'Review completed work against acceptance criteria',
    tags: ['review', 'acceptance'],
  },
  refinement: {
    id: 'refinement',
    name: 'Refinement',
    description: 'Refine and improve existing work based on feedback',
    tags: ['refinement', 'iteration'],
  },
  'refinement-coordination': {
    id: 'refinement-coordination',
    name: 'Refinement Coordination',
    description: 'Coordinate refinement across sub-issues after QA/acceptance failure',
    tags: ['refinement', 'coordination'],
  },
  merge: {
    id: 'merge-queue',
    name: 'Merge Queue',
    description: 'Add approved PRs to the merge queue for automated merging',
    tags: ['merge', 'automation'],
  },
  security: {
    id: 'security-scan',
    name: 'Security Scan',
    description: 'Run SAST and dependency audit scans, output structured vulnerability data',
    tags: ['security', 'scanning'],
  },
  'outcome-auditor': {
    id: 'outcome-auditor',
    name: 'Outcome Auditor',
    description: 'Audit recently accepted issues for delivery gaps; author follow-up issues for missed AC items',
    tags: ['audit', 'pm', 'quality'],
  },
  'improvement-loop': {
    id: 'improvement-loop',
    name: 'Improvement Loop',
    description: 'Analyze recent session outcomes and author meta-issues for systemic patterns',
    tags: ['pm', 'improvement', 'meta'],
  },
  'ga-readiness': {
    id: 'ga-readiness',
    name: 'GA-Readiness Assessor',
    description: 'Assess feature GA readiness: AC coverage, architectural drift, observability, and security review status',
    tags: ['pm', 'ga', 'readiness', 'release'],
  },
  'documentation-steward': {
    id: 'documentation-steward',
    name: 'Documentation Steward',
    description: 'Scan repo docs for stale references and undocumented surfaces; author refinement issues for gaps',
    tags: ['pm', 'docs', 'documentation', 'steward'],
  },
  'operational-scanner-vercel': {
    id: 'operational-scanner-vercel',
    name: 'Operational Scanner — Vercel',
    description: 'Scan Vercel deploy logs for failures, function timeouts, and cold-start regressions; author bug-report issues (live binding pending)',
    tags: ['pm', 'operational', 'vercel', 'scanning'],
  },
  'operational-scanner-audit': {
    id: 'operational-scanner-audit',
    name: 'Operational Scanner — Audit',
    description: 'Scan audit chains for anomalies per 006 Seam 6 (missing entries, broken chains, unexpected actors); author bug-report issues',
    tags: ['pm', 'operational', 'audit', 'scanning'],
  },
  'operational-scanner-ci': {
    id: 'operational-scanner-ci',
    name: 'Operational Scanner — CI',
    description: 'Scan CI run logs for flaky tests, slow steps, and optimization opportunities; author bug-report and improvement issues',
    tags: ['pm', 'operational', 'ci', 'scanning'],
  },
}

/**
 * Build an A2A AgentCard from the supplied configuration.
 *
 * If no explicit skills are provided the card is populated with skills
 * derived from every known {@link AgentWorkType}.
 *
 * @param config - Server configuration
 * @returns A fully-formed AgentCard
 */
export function buildAgentCard(config: A2aServerConfig): A2aAgentCard {
  const skills: A2aSkill[] =
    config.skills ?? Object.values(WORK_TYPE_SKILLS)

  return {
    name: config.name,
    description: config.description,
    url: config.url,
    version: config.version ?? '1.0.0',
    capabilities: {
      streaming: config.streaming ?? false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    skills,
    ...(config.authSchemes && { authentication: config.authSchemes }),
    defaultInputContentTypes: ['text/plain'],
    defaultOutputContentTypes: ['text/plain'],
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC request handler
// ---------------------------------------------------------------------------

/** Callbacks that the consuming application must supply */
export interface A2aHandlerOptions {
  /** Handle an incoming message, optionally targeting an existing task */
  onSendMessage: (message: A2aMessage, taskId?: string) => Promise<A2aTask>
  /** Retrieve an existing task by ID */
  onGetTask: (taskId: string) => Promise<A2aTask | null>
  /** Cancel an existing task by ID */
  onCancelTask: (taskId: string) => Promise<A2aTask | null>
  /**
   * Verify the Authorization header.
   * Defaults to Bearer-token verification via {@link verifyApiKey}.
   */
  verifyAuth?: (authHeader: string | undefined) => boolean
}

/**
 * A framework-agnostic function that accepts a parsed JSON-RPC request
 * (plus an optional Authorization header) and returns a JSON-RPC response.
 */
export type A2aRequestHandler = (
  request: JsonRpcRequest,
  authHeader?: string,
) => Promise<JsonRpcResponse>

// ---- JSON-RPC error helpers ------------------------------------------------

const JSON_RPC_VERSION = '2.0' as const

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: { code, message, ...(data !== undefined && { data }) },
  }
}

function rpcResult(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  }
}

// ---- Default auth verifier --------------------------------------------------

function defaultVerifyAuth(authHeader: string | undefined): boolean {
  const token = extractBearerToken(authHeader ?? null)
  if (!token) return false
  return verifyApiKey(token)
}

// ---- Factory ----------------------------------------------------------------

/**
 * Create a framework-agnostic A2A request handler.
 *
 * The returned function processes a single JSON-RPC request and returns
 * the corresponding response. The consuming application is responsible
 * for HTTP parsing, serialisation, and transport.
 *
 * Supported methods:
 * - `message/send` — send a message (optionally to an existing task)
 * - `tasks/get`    — retrieve a task by ID
 * - `tasks/cancel` — cancel a task by ID
 *
 * @param options - Callbacks for task lifecycle and (optional) auth
 * @returns An async handler function
 */
export function createA2aRequestHandler(options: A2aHandlerOptions): A2aRequestHandler {
  const { onSendMessage, onGetTask, onCancelTask } = options
  const verifyAuth = options.verifyAuth ?? defaultVerifyAuth

  return async (request: JsonRpcRequest, authHeader?: string): Promise<JsonRpcResponse> => {
    const id = request.id ?? null

    // --- Auth check ---
    if (!verifyAuth(authHeader)) {
      return rpcError(id, -32000, 'Unauthorized')
    }

    // --- Method routing ---
    switch (request.method) {
      case 'message/send': {
        const params = request.params
        if (!params || !params.message) {
          return rpcError(id, -32602, 'Invalid params: message is required')
        }
        const message = params.message as A2aMessage
        const taskId = params.taskId as string | undefined
        try {
          const task = await onSendMessage(message, taskId)
          return rpcResult(id, task)
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Internal error'
          return rpcError(id, -32603, msg)
        }
      }

      case 'tasks/get': {
        const params = request.params
        if (!params || typeof params.taskId !== 'string') {
          return rpcError(id, -32602, 'Invalid params: taskId is required')
        }
        try {
          const task = await onGetTask(params.taskId)
          if (!task) {
            return rpcError(id, -32001, 'Task not found')
          }
          return rpcResult(id, task)
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Internal error'
          return rpcError(id, -32603, msg)
        }
      }

      case 'tasks/cancel': {
        const params = request.params
        if (!params || typeof params.taskId !== 'string') {
          return rpcError(id, -32602, 'Invalid params: taskId is required')
        }
        try {
          const task = await onCancelTask(params.taskId)
          if (!task) {
            return rpcError(id, -32001, 'Task not found')
          }
          return rpcResult(id, task)
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Internal error'
          return rpcError(id, -32603, msg)
        }
      }

      default:
        return rpcError(id, -32601, `Method not found: ${request.method}`)
    }
  }
}

// ---------------------------------------------------------------------------
// SSE event formatter
// ---------------------------------------------------------------------------

/**
 * Format an A2A task event as a Server-Sent Events (SSE) message.
 *
 * The output follows the SSE text/event-stream format:
 * ```
 * event: <type>
 * data: <JSON payload>
 *
 * ```
 *
 * @param event - The task event to format
 * @returns A string ready to write to an SSE response stream
 */
export function formatSseEvent(event: A2aTaskEvent): string {
  const data = JSON.stringify(event)
  return `event: ${event.type}\ndata: ${data}\n\n`
}
