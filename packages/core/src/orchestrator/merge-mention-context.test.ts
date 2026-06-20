import { describe, it, expect } from 'vitest'
import { mergeMentionContext } from './orchestrator.js'

describe('mergeMentionContext', () => {
  it('returns undefined when both inputs are empty', () => {
    expect(mergeMentionContext(undefined, undefined)).toBeUndefined()
    expect(mergeMentionContext('', '')).toBeUndefined()
    expect(mergeMentionContext(undefined, '')).toBeUndefined()
  })

  it('returns customPrompt when only customPrompt is set', () => {
    expect(mergeMentionContext(undefined, 'Start work on ISSUE-74')).toBe('Start work on ISSUE-74')
  })

  it('returns mentionContext when only mentionContext is set', () => {
    expect(mergeMentionContext('user mention text', undefined)).toBe('user mention text')
  })

  it('joins both with a separator when both are set', () => {
    const result = mergeMentionContext('mention', 'customPrompt')
    expect(result).toBe('mention\n\n---\n\ncustomPrompt')
  })

  it('treats non-string values as absent', () => {
    // @ts-expect-error — runtime defensiveness check
    expect(mergeMentionContext(123, undefined)).toBeUndefined()
    // @ts-expect-error — runtime defensiveness check
    expect(mergeMentionContext(null, 'prompt')).toBe('prompt')
  })
})
