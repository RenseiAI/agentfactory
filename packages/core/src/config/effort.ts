/**
 * Effort Level Mapping
 *
 * Maps the normalized EffortLevel enum to provider-specific parameters.
 * Each provider has different mechanisms for controlling reasoning depth:
 * - Claude: effort level string
 * - Codex/OpenAI: reasoning_effort string
 * - Gemini: thinkingBudget number
 */

import type { EffortLevel } from './profiles.js'

/** Map effort to Anthropic Claude options */
export function effortToClaudeOptions(effort: EffortLevel): { effort: string } {
  // Claude supports: low, medium, high, xhigh, max
  // We map our enum 1:1 (no 'max' in our enum — xhigh is the highest)
  return { effort }
}

/** Map effort to OpenAI/Codex options */
export function effortToCodexOptions(effort: EffortLevel): { reasoningEffort: string } {
  // Codex supports: minimal, low, medium, high, xhigh
  // Our 'low' maps to 'low', etc. — 1:1 for our range
  return { reasoningEffort: effort }
}

/** Map effort to Google Gemini options */
export function effortToGeminiOptions(effort: EffortLevel): { thinkingBudget: number } {
  const budgetMap: Record<EffortLevel, number> = {
    low: 4096,
    medium: 16384,
    high: 32768,
    xhigh: 65536,
  }
  return { thinkingBudget: budgetMap[effort] }
}

/**
 * Extract the provider-specific config block from a profile based on the resolved provider.
 * Maps provider names to their corresponding config key in the profile.
 */
export function extractProviderConfig(
  profile: { openai?: Record<string, unknown>; anthropic?: Record<string, unknown>; codex?: Record<string, unknown>; gemini?: Record<string, unknown> },
  providerName: string,
): Record<string, unknown> | undefined {
  const keyMap: Record<string, keyof typeof profile> = {
    'codex': 'openai',     // Codex uses OpenAI API
    'claude': 'anthropic',
    'amp': 'anthropic',    // Amp uses Anthropic models primarily
    'a2a': 'gemini',       // A2A is typically Gemini
    'spring-ai': 'openai', // Spring AI typically wraps OpenAI
  }
  const key = keyMap[providerName]
  if (!key) return undefined
  return profile[key] as Record<string, unknown> | undefined
}
