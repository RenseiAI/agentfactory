import type { AgentEvent } from '../providers/types.js'
import type { StructuredSummary, FileModification, FileAction } from './state-types.js'
import { SUMMARY_SCHEMA_VERSION } from './state-types.js'
import type { ArtifactIndex } from './artifact-tracker.js'

/**
 * Builds and merges structured summaries from agent event spans.
 * Implements Factory.ai-style incremental compression.
 *
 * Currently uses structural extraction from events.
 * LLM-based summarization can be added in the future.
 */
export class SummaryBuilder {
  /**
   * Generate a structured summary from a span of agent events.
   * Extracts file modifications, decisions, and next steps structurally.
   *
   * @param events - The events being dropped from context (not the full history)
   * @param existingSummary - The current persisted summary (if any)
   * @param artifacts - The current artifact index
   */
  summarizeSpan(
    events: AgentEvent[],
    existingSummary: StructuredSummary | null,
    artifacts: ArtifactIndex
  ): StructuredSummary {
    const now = Date.now()

    // Extract file modifications from tool_use events in the span
    const fileModifications = this.extractFileModifications(events)

    // Extract intent from assistant text (first substantial message)
    const sessionIntent = this.extractSessionIntent(events) || existingSummary?.sessionIntent || ''

    // Extract next steps from assistant text
    const nextSteps = this.extractNextSteps(events)

    const summary: StructuredSummary = {
      schemaVersion: SUMMARY_SCHEMA_VERSION,
      sessionIntent,
      fileModifications,
      decisionsMade: [], // Decisions require LLM extraction — structural extraction not reliable
      nextSteps,
      compactionCount: (existingSummary?.compactionCount ?? 0) + 1,
      lastCompactedAt: now,
      tokenEstimate: 0,
    }

    // Estimate token count (rough: 4 chars per token)
    summary.tokenEstimate = Math.ceil(JSON.stringify(summary).length / 4)

    return summary
  }

  /**
   * Merge a newly generated span summary into the existing persisted summary.
   * Deduplicates file modifications, preserves decision chronology,
   * updates next steps (removing completed ones, adding new ones).
   */
  mergeSummaries(
    existing: StructuredSummary,
    incoming: StructuredSummary
  ): StructuredSummary {
    // Session intent: keep existing unless incoming explicitly redefines it
    const sessionIntent = incoming.sessionIntent || existing.sessionIntent

    // File modifications: union by path, keep latest action per file
    const fileMap = new Map<string, FileModification>()
    for (const mod of existing.fileModifications) {
      fileMap.set(mod.path, mod)
    }
    for (const mod of incoming.fileModifications) {
      const existingMod = fileMap.get(mod.path)
      if (existingMod) {
        // Merge: keep latest action, combine reasons
        fileMap.set(mod.path, {
          path: mod.path,
          action: mod.action,
          reason: existingMod.reason !== mod.reason
            ? `${existingMod.reason}; ${mod.reason}`
            : mod.reason,
          lastModifiedAt: Math.max(existingMod.lastModifiedAt, mod.lastModifiedAt),
        })
      } else {
        fileMap.set(mod.path, mod)
      }
    }

    // Decisions: append chronologically, never drop
    const decisionsMade = [
      ...existing.decisionsMade,
      ...incoming.decisionsMade,
    ]

    // Next steps: remove completed items (ones that appear in incoming file mods),
    // add new items from incoming
    const completedPaths = new Set(incoming.fileModifications.map(m => m.path))
    const existingSteps = existing.nextSteps.filter(
      step => !completedPaths.has(step) && !incoming.nextSteps.includes(step)
    )
    const nextSteps = [...existingSteps, ...incoming.nextSteps]

    const merged: StructuredSummary = {
      schemaVersion: SUMMARY_SCHEMA_VERSION,
      sessionIntent,
      fileModifications: Array.from(fileMap.values()),
      decisionsMade,
      nextSteps,
      compactionCount: incoming.compactionCount,
      lastCompactedAt: incoming.lastCompactedAt,
      tokenEstimate: 0,
    }

    merged.tokenEstimate = Math.ceil(JSON.stringify(merged).length / 4)
    return merged
  }

  /**
   * Generate the context injection string from a summary + artifacts.
   * Uses neutral framing to avoid "context anxiety" (from prior research).
   */
  toPromptSection(
    summary: StructuredSummary,
    artifacts: ArtifactIndex
  ): string {
    const lines: string[] = []

    lines.push('<context-summary>')

    // Session Intent
    if (summary.sessionIntent) {
      lines.push('## Session Intent')
      lines.push(summary.sessionIntent)
      lines.push('')
    }

    // Files Modified
    if (summary.fileModifications.length > 0) {
      lines.push(`## Files Modified (${summary.fileModifications.length} files)`)
      for (const mod of summary.fileModifications) {
        lines.push(`- \`${mod.path}\` — ${capitalize(mod.action)}: ${mod.reason}`)
      }
      lines.push('')
    }

    // Key Decisions
    if (summary.decisionsMade.length > 0) {
      lines.push('## Key Decisions')
      for (let i = 0; i < summary.decisionsMade.length; i++) {
        const d = summary.decisionsMade[i]
        let line = `${i + 1}. ${d.description} — ${d.rationale}`
        if (d.alternatives && d.alternatives.length > 0) {
          line += ` (rejected: ${d.alternatives.join(', ')})`
        }
        lines.push(line)
      }
      lines.push('')
    }

    // Next Steps
    if (summary.nextSteps.length > 0) {
      lines.push('## Next Steps')
      for (const step of summary.nextSteps) {
        lines.push(`- [ ] ${step}`)
      }
      lines.push('')
    }

    // Tracked Files (from ArtifactTracker)
    const trackedFiles = Object.values(artifacts.files)
    if (trackedFiles.length > 0) {
      const modified = trackedFiles.filter(f => f.actions.some(a => a === 'created' || a === 'modified' || a === 'deleted'))
      const readOnly = trackedFiles.filter(f => !f.actions.some(a => a === 'created' || a === 'modified' || a === 'deleted') && f.actions.includes('read'))

      lines.push('## Tracked Files')
      if (modified.length > 0) {
        lines.push(`Modified: ${modified.map(f => f.relativePath).join(', ')}`)
      }
      if (readOnly.length > 0) {
        lines.push(`Read: ${readOnly.map(f => f.relativePath).join(', ')}`)
      }
      lines.push('')
    }

    lines.push('</context-summary>')

    return lines.join('\n')
  }

  /**
   * Extract file modifications from tool_use events in the span
   */
  private extractFileModifications(events: AgentEvent[]): FileModification[] {
    const fileMap = new Map<string, FileModification>()

    for (const event of events) {
      if (event.type !== 'tool_use') continue

      let filePath: string | undefined
      let action: FileAction | undefined

      switch (event.toolName) {
        case 'Read':
          filePath = event.input.file_path as string | undefined
          action = 'read'
          break
        case 'Write':
          filePath = event.input.file_path as string | undefined
          action = 'created'
          break
        case 'Edit':
          filePath = event.input.file_path as string | undefined
          action = 'modified'
          break
      }

      if (filePath && action) {
        const existing = fileMap.get(filePath)
        if (existing) {
          // Update to latest action
          existing.action = action
          existing.lastModifiedAt = Date.now()
        } else {
          fileMap.set(filePath, {
            path: filePath,
            action,
            reason: `${capitalize(action)} during session`,
            lastModifiedAt: Date.now(),
          })
        }
      }
    }

    return Array.from(fileMap.values())
  }

  /**
   * Extract session intent from assistant text events.
   * Looks for the first substantial text that describes what the agent is doing.
   */
  private extractSessionIntent(events: AgentEvent[]): string {
    for (const event of events) {
      if (event.type !== 'assistant_text') continue
      const text = event.text.trim()
      // Skip very short messages (acknowledgments, etc.)
      if (text.length > 50) {
        // Take first sentence or first 200 chars
        const firstSentence = text.match(/^[^.!?]+[.!?]/)
        return firstSentence ? firstSentence[0].trim() : text.slice(0, 200)
      }
    }
    return ''
  }

  /**
   * Extract next steps from assistant text events.
   * Looks for bullet points, numbered lists, or "TODO" markers.
   */
  private extractNextSteps(events: AgentEvent[]): string[] {
    const steps: string[] = []

    for (const event of events) {
      if (event.type !== 'assistant_text') continue

      const lines = event.text.split('\n')
      for (const line of lines) {
        const trimmed = line.trim()
        // Match common todo/next step patterns
        const match = trimmed.match(/^(?:[-*]|\d+[.)]\s*)\s*\[?\s*[x ]?\s*\]?\s*(.+)/)
        if (match && match[1] && (trimmed.toLowerCase().includes('todo') || trimmed.toLowerCase().includes('next'))) {
          steps.push(match[1].trim())
        }
      }
    }

    return steps
  }
}

/**
 * Capitalize the first letter of a string
 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
