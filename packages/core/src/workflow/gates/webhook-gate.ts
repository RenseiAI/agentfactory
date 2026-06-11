/**
 * Webhook Gate Executor
 *
 * Pure logic for webhook gate evaluation, token generation, and callback URL
 * management. Webhook gates pause workflow execution until an external HTTP
 * callback is received, enabling integration with external approval systems,
 * CI/CD pipelines, and other services.
 *
 * This module handles the evaluation and state management logic only.
 * The actual HTTP endpoint registration happens in the server layer.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { GateState } from '../gate-state.js'
import { parseDuration } from '../gate-state.js'
import type { GateDefinition, WorkflowDefinition } from '../workflow-types.js'

const log = {
  info: (msg: string, data?: Record<string, unknown>) => console.log(`[webhook-gate] ${msg}`, data ? JSON.stringify(data) : ''),
  warn: (msg: string, data?: Record<string, unknown>) => console.warn(`[webhook-gate] ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg: string, data?: Record<string, unknown>) => console.error(`[webhook-gate] ${msg}`, data ? JSON.stringify(data) : ''),
  debug: (_msg: string, _data?: Record<string, unknown>) => {},
}

// ============================================
// Types
// ============================================

/**
 * Trigger configuration for a webhook gate.
 * Defines the base endpoint path for webhook callbacks.
 */
export interface WebhookGateTrigger {
  /** Base path for webhook callbacks (e.g., "/api/gates") */
  endpoint: string
}

/**
 * Result of evaluating a webhook gate's current status.
 */
export interface WebhookGateResult {
  /** Whether the gate condition has been satisfied */
  satisfied: boolean
  /** The callback URL for an active webhook gate */
  callbackUrl?: string
  /** Whether the gate has timed out */
  timedOut?: boolean
}

/**
 * Activation data for a webhook gate, including the authentication token,
 * callback URL, and optional expiration timestamp.
 */
export interface WebhookGateActivation {
  /** Cryptographically random token for webhook authentication */
  token: string
  /** Full callback URL including token query parameter */
  callbackUrl: string
  /** When the gate activation expires, epoch ms */
  expiresAt?: number
}

// ============================================
// Token Generation
// ============================================

/**
 * Generate a cryptographically random token for webhook authentication.
 *
 * Uses Node.js `crypto.randomBytes()` to generate a 32-byte hex token.
 * This token is stored in gate state and verified on callback receipt
 * to ensure only authorized callers can satisfy the gate.
 *
 * @returns A 64-character hex string token
 */
export function generateWebhookToken(): string {
  return randomBytes(32).toString('hex')
}

// ============================================
// Callback URL
// ============================================

/**
 * Build the callback URL for an activated webhook gate.
 *
 * The URL follows the format:
 *   `{baseUrl}/api/gates/{issueId}/{gateName}?token={token}`
 *
 * @param baseUrl - The base URL of the server (e.g., "https://api.example.com")
 * @param issueId - The issue identifier this gate is associated with
 * @param gateName - The unique gate name from the gate definition
 * @param token - The authentication token for this gate activation
 * @returns The fully-qualified callback URL
 */
export function buildCallbackUrl(
  baseUrl: string,
  issueId: string,
  gateName: string,
  token: string,
): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const encodedIssueId = encodeURIComponent(issueId)
  const encodedGateName = encodeURIComponent(gateName)
  const encodedToken = encodeURIComponent(token)
  return `${normalizedBase}/api/gates/${encodedIssueId}/${encodedGateName}?token=${encodedToken}`
}

// ============================================
// Token Validation
// ============================================

/**
 * Validate that a webhook callback's token matches the expected token.
 *
 * Uses timing-safe comparison via `crypto.timingSafeEqual` to prevent
 * timing attacks that could leak token information through response times.
 *
 * @param token - The token received in the webhook callback
 * @param expectedToken - The expected token stored in gate state
 * @returns `true` if the tokens match, `false` otherwise
 */
export function validateWebhookCallback(
  token: string,
  expectedToken: string,
): boolean {
  if (!token || !expectedToken) {
    log.warn('Token validation failed: empty token provided')
    return false
  }

  const tokenBuffer = Buffer.from(token, 'utf8')
  const expectedBuffer = Buffer.from(expectedToken, 'utf8')

  // timingSafeEqual requires buffers of equal length
  if (tokenBuffer.length !== expectedBuffer.length) {
    return false
  }

  return timingSafeEqual(tokenBuffer, expectedBuffer)
}

// ============================================
// Gate Evaluation
// ============================================

/**
 * Pure function to evaluate a webhook gate's current status based on its
 * definition and persisted state.
 *
 * Evaluation logic:
 * - If gate state is `satisfied` -> return `{ satisfied: true }`
 * - If gate state is `timed-out` -> return `{ satisfied: false, timedOut: true }`
 * - If gate state is `active` and has a timeout deadline that has passed ->
 *   return `{ satisfied: false, timedOut: true }`
 * - If gate state is `active` -> return `{ satisfied: false, callbackUrl }`
 *   where callbackUrl is reconstructed from state's signalSource if available
 * - If gate state is `null` (not yet activated) -> return `{ satisfied: false }`
 *
 * @param gate - The gate definition from the workflow
 * @param gateState - The persisted gate state, or null if the gate has not been activated
 * @returns The evaluated webhook gate result
 */
export function evaluateWebhookGate(
  gate: GateDefinition,
  gateState: GateState | null,
): WebhookGateResult {
  if (!gateState) {
    log.debug('Webhook gate not yet activated', { gateName: gate.name })
    return { satisfied: false }
  }

  if (gateState.status === 'satisfied') {
    log.debug('Webhook gate satisfied', { gateName: gate.name })
    return { satisfied: true }
  }

  if (gateState.status === 'timed-out') {
    log.debug('Webhook gate timed out', { gateName: gate.name })
    return { satisfied: false, timedOut: true }
  }

  if (gateState.status === 'active') {
    // Check if the gate has exceeded its timeout deadline
    if (gateState.timeoutDeadline && Date.now() > gateState.timeoutDeadline) {
      log.info('Webhook gate timeout deadline exceeded', {
        gateName: gate.name,
        issueId: gateState.issueId,
        timeoutDeadline: gateState.timeoutDeadline,
      })
      return { satisfied: false, timedOut: true }
    }

    // Gate is active and waiting for callback
    return {
      satisfied: false,
      callbackUrl: gateState.signalSource,
    }
  }

  // Pending or unknown status
  return { satisfied: false }
}

// ============================================
// Type Guards
// ============================================

/**
 * Type guard to check if a gate trigger configuration is a webhook trigger.
 *
 * A valid webhook trigger must have an `endpoint` property of type string.
 *
 * @param trigger - The trigger configuration to check
 * @returns `true` if the trigger is a WebhookGateTrigger
 */
export function isWebhookGateTrigger(
  trigger: Record<string, unknown>,
): trigger is Record<string, unknown> & WebhookGateTrigger {
  return (
    typeof trigger === 'object' &&
    trigger !== null &&
    typeof trigger.endpoint === 'string' &&
    trigger.endpoint.length > 0
  )
}

// ============================================
// Gate Filtering
// ============================================

/**
 * Get all webhook gates that apply to a given workflow phase.
 *
 * Filters the workflow's gate definitions to return only those that:
 * 1. Have type `webhook`
 * 2. Either have no `appliesTo` restriction, or include the specified phase
 *
 * @param workflow - The workflow definition containing gate configurations
 * @param phase - The phase name to filter gates for
 * @returns Array of gate definitions that are webhook type and apply to the phase
 */
export function getApplicableWebhookGates(
  workflow: WorkflowDefinition,
  phase: string,
): GateDefinition[] {
  if (!workflow.gates || workflow.gates.length === 0) {
    return []
  }

  return workflow.gates.filter((gate) => {
    if (gate.type !== 'webhook') {
      return false
    }

    // If no appliesTo is specified, the gate applies to all phases
    if (!gate.appliesTo || gate.appliesTo.length === 0) {
      return true
    }

    return gate.appliesTo.includes(phase)
  })
}

// ============================================
// Gate Activation
// ============================================

/**
 * Creates the activation data for a webhook gate including a cryptographically
 * random token, callback URL, and optional expiration timestamp.
 *
 * This function generates all the data needed to activate a webhook gate,
 * but does not persist any state. The caller is responsible for storing the
 * activation data (token in gate state, URL communicated to external system).
 *
 * @param issueId - The issue identifier this gate is associated with
 * @param gateDef - The gate definition from the workflow
 * @param baseUrl - The base URL of the server for building callback URLs
 * @returns The webhook gate activation data
 */
export function createWebhookGateActivation(
  issueId: string,
  gateDef: GateDefinition,
  baseUrl: string,
): WebhookGateActivation {
  const token = generateWebhookToken()
  const callbackUrl = buildCallbackUrl(baseUrl, issueId, gateDef.name, token)

  const activation: WebhookGateActivation = {
    token,
    callbackUrl,
  }

  // Compute expiration from gate timeout if configured
  if (gateDef.timeout) {
    const durationMs = parseDuration(gateDef.timeout.duration)
    activation.expiresAt = Date.now() + durationMs
  }

  log.info('Webhook gate activation created', {
    issueId,
    gateName: gateDef.name,
    callbackUrl,
    expiresAt: activation.expiresAt,
  })

  return activation
}
