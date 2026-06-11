/**
 * Log Analyzer
 *
 * Analyzes session logs for errors and improvement opportunities.
 * Can automatically create deduplicated Linear issues.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'fs'
import { resolve, join } from 'path'
import { createHash } from 'crypto'
import type { IssueTrackerClient } from './issue-tracker-client.js'
import {
  readSessionMetadata,
  readSessionEvents,
  type SessionMetadata,
  type SessionEvent,
} from './session-logger.js'
import { getLogAnalysisConfig, type LogAnalysisConfig } from './log-config.js'

/**
 * Pattern types for categorization
 */
export type PatternType =
  | 'permission' // Sandbox/permission errors
  | 'tool_issue' // Tool execution failures
  | 'tool_misuse' // Agent using tools incorrectly
  | 'performance' // Timeouts, rate limits
  | 'repeated_failure' // Same error multiple times
  | 'approval_required' // Commands needing approval in autonomous mode

/**
 * Severity levels for patterns
 */
export type PatternSeverity = 'low' | 'medium' | 'high' | 'critical'

/**
 * An analyzed pattern/issue from session logs
 */
export interface AnalyzedPattern {
  /** Type of pattern */
  type: PatternType
  /** Severity level */
  severity: PatternSeverity
  /** Short title for the issue */
  title: string
  /** Detailed description */
  description: string
  /** Example error messages */
  examples: string[]
  /** How many times this occurred */
  occurrences: number
  /** Related tool (if applicable) */
  tool?: string
}

/**
 * Result of analyzing a session
 */
export interface AnalysisResult {
  /** Session ID that was analyzed */
  sessionId: string
  /** Session metadata */
  metadata: SessionMetadata
  /** Detected patterns */
  patterns: AnalyzedPattern[]
  /** Total events analyzed */
  eventsAnalyzed: number
  /** Total errors found */
  errorsFound: number
  /** Suggested issues to create */
  suggestedIssues: SuggestedIssue[]
  /** Unix timestamp of analysis */
  analyzedAt: number
}

/**
 * A suggested issue to create in Linear
 */
export interface SuggestedIssue {
  /** Deterministic signature for deduplication */
  signature: string
  /** Issue title */
  title: string
  /** Issue description (markdown) */
  description: string
  /** Work type (Bug, Feature, Chore) */
  workType: 'Bug' | 'Feature' | 'Chore'
  /** Labels to apply */
  labels: string[]
  /** Source patterns that led to this suggestion */
  sourcePatterns: PatternType[]
}

/**
 * Tracked issue in the deduplication store
 */
export interface TrackedIssue {
  /** Linear issue ID (UUID) */
  linearIssueId: string
  /** Human-readable identifier (e.g., ABC-123) */
  linearIdentifier: string
  /** Unix timestamp when first created */
  createdAt: number
  /** Unix timestamp when last seen */
  lastSeenAt: number
  /** How many sessions have had this issue */
  sessionCount: number
  /** Session IDs that had this issue */
  sessionIds: string[]
}

/**
 * Deduplication store structure
 */
export interface DeduplicationStore {
  issues: Record<string, TrackedIssue>
}

/**
 * Pattern detection rules
 */
const PATTERN_RULES: Array<{
  pattern: RegExp
  type: PatternType
  severity: PatternSeverity
  title: (match: string) => string
}> = [
  // Command requires approval (critical in autonomous mode)
  {
    pattern: /This command requires approval|requires approval/i,
    type: 'approval_required',
    severity: 'critical',
    title: () => 'Command requires approval in autonomous mode',
  },
  // Specific tool misuse patterns (before generic tool_use_error)
  // File not read before write
  {
    pattern: /File has not been read yet/i,
    type: 'tool_misuse',
    severity: 'high',
    title: () => 'Write attempted before read',
  },
  // File does not exist (tool use)
  {
    pattern: /File does not exist/i,
    type: 'tool_misuse',
    severity: 'medium',
    title: () => 'File does not exist',
  },
  // Path does not exist (tool use)
  {
    pattern: /Path does not exist/i,
    type: 'tool_misuse',
    severity: 'medium',
    title: () => 'Path does not exist',
  },
  // Unknown JSON field (malformed tool input)
  {
    pattern: /Unknown JSON field/i,
    type: 'tool_misuse',
    severity: 'high',
    title: () => 'Invalid tool parameter',
  },
  // Glob pattern in write operation
  {
    pattern: /Glob patterns are not allowed in write/i,
    type: 'tool_misuse',
    severity: 'medium',
    title: () => 'Glob pattern used in write operation',
  },
  // Generic tool use errors from Claude Code API (catch-all for unmatched errors)
  {
    pattern: /<tool_use_error>.*<\/tool_use_error>/i,
    type: 'tool_misuse',
    severity: 'high',
    title: () => 'Tool API error',
  },
  // File too large
  {
    pattern: /exceeds maximum allowed tokens/i,
    type: 'tool_issue',
    severity: 'medium',
    title: () => 'File too large to read',
  },
  // Directory blocked (sandbox cd restriction)
  {
    pattern: /cd in .* was blocked|only change directories to the allowed/i,
    type: 'permission',
    severity: 'high',
    title: () => 'Directory change blocked by sandbox',
  },
  // Sandbox violations
  {
    pattern: /sandbox.*not allowed|operation not permitted/i,
    type: 'permission',
    severity: 'high',
    title: () => 'Sandbox permission error',
  },
  // Permission denied
  {
    pattern: /permission denied|EACCES|access denied/i,
    type: 'permission',
    severity: 'high',
    title: () => 'File permission denied',
  },
  // File not found (filesystem)
  {
    pattern: /ENOENT|no such file or directory/i,
    type: 'tool_issue',
    severity: 'medium',
    title: () => 'File not found error',
  },
  // Network timeouts
  {
    pattern: /timeout|ETIMEDOUT|connection timed out/i,
    type: 'performance',
    severity: 'medium',
    title: () => 'Network timeout',
  },
  // Rate limiting
  {
    pattern: /rate limit|429|too many requests/i,
    type: 'performance',
    severity: 'high',
    title: () => 'Rate limit exceeded',
  },
  // Network errors
  {
    pattern: /ECONNREFUSED|ENOTFOUND|connection refused/i,
    type: 'tool_issue',
    severity: 'medium',
    title: () => 'Network connection error',
  },
  // Worktree conflicts
  {
    pattern: /is already used by worktree|already checked out/i,
    type: 'tool_issue',
    severity: 'high',
    title: () => 'Git worktree conflict',
  },
  // Tool failures
  {
    pattern: /tool.*error|tool.*failed|command failed/i,
    type: 'tool_issue',
    severity: 'medium',
    title: () => 'Tool execution failed',
  },
]

/**
 * Generate a deterministic signature for deduplication
 */
function generateSignature(issueType: PatternType, title: string): string {
  const normalized = `${issueType}:${title.toLowerCase().substring(0, 100)}`
  const hash = createHash('sha256').update(normalized).digest('hex').substring(0, 16)
  return `agent-env-${hash}`
}

/**
 * Callback for creating issues in the issue tracker.
 * Injected by the caller to decouple from any specific issue tracker.
 */
export interface IssueCreator {
  createIssue(options: {
    title: string
    description: string
    labels: string[]
  }): Promise<{ id: string; identifier: string } | null>
  createComment(issueId: string, body: string): Promise<void>
}

/**
 * LogAnalyzer class for analyzing session logs
 */
export class LogAnalyzer {
  private readonly config: LogAnalysisConfig
  private readonly sessionsDir: string
  private readonly processedDir: string
  private readonly analysisDir: string
  private readonly deduplicationPath: string
  private issueCreator?: IssueCreator

  constructor(config?: Partial<LogAnalysisConfig>) {
    this.config = { ...getLogAnalysisConfig(), ...config }
    this.sessionsDir = resolve(this.config.logsDir, 'sessions')
    this.processedDir = resolve(this.config.logsDir, 'processed')
    this.analysisDir = resolve(this.config.logsDir, 'analysis')
    this.deduplicationPath = resolve(this.analysisDir, 'issues-created.json')
  }

  /**
   * Initialize directories and optional issue creator
   */
  initialize(issueCreator?: IssueCreator): void {
    // Create directories if needed
    for (const dir of [this.sessionsDir, this.processedDir, this.analysisDir]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
    }

    this.issueCreator = issueCreator
  }

  /**
   * Get list of session IDs that haven't been analyzed yet
   */
  getUnprocessedSessions(): string[] {
    if (!existsSync(this.sessionsDir)) {
      return []
    }

    const sessions: string[] = []
    const entries = readdirSync(this.sessionsDir, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const sessionId = entry.name
        const processedPath = resolve(this.processedDir, `${sessionId}.json`)

        // Check if already processed
        if (!existsSync(processedPath)) {
          // Check if session is completed (has endedAt in metadata)
          const metadata = readSessionMetadata(resolve(this.sessionsDir, sessionId))
          if (metadata?.endedAt) {
            sessions.push(sessionId)
          }
        }
      }
    }

    return sessions
  }

  /**
   * Analyze a single session
   */
  analyzeSession(sessionId: string): AnalysisResult | null {
    const sessionDir = resolve(this.sessionsDir, sessionId)
    const metadata = readSessionMetadata(sessionDir)

    if (!metadata) {
      return null
    }

    // Collect events
    const events: SessionEvent[] = []
    for (const event of readSessionEvents(sessionDir)) {
      events.push(event)
    }

    // Detect patterns
    const patterns = this.detectPatterns(events)

    // Check for repeated failures
    const repeatedFailures = this.detectRepeatedFailures(events)
    patterns.push(...repeatedFailures)

    // Generate suggested issues
    const suggestedIssues = this.generateSuggestedIssues(patterns, metadata)

    const result: AnalysisResult = {
      sessionId,
      metadata,
      patterns,
      eventsAnalyzed: events.length,
      errorsFound: events.filter((e) => e.isError).length,
      suggestedIssues,
      analyzedAt: Date.now(),
    }

    return result
  }

  /**
   * Detect patterns in events
   */
  private detectPatterns(events: SessionEvent[]): AnalyzedPattern[] {
    const patternMap = new Map<string, AnalyzedPattern>()

    for (const event of events) {
      if (!event.isError) continue

      const content =
        typeof event.content === 'string' ? event.content : JSON.stringify(event.content)

      for (const rule of PATTERN_RULES) {
        if (rule.pattern.test(content)) {
          const key = `${rule.type}:${rule.title('')}`

          if (patternMap.has(key)) {
            const existing = patternMap.get(key)!
            existing.occurrences++
            if (existing.examples.length < 3) {
              existing.examples.push(content.substring(0, 200))
            }
          } else {
            patternMap.set(key, {
              type: rule.type,
              severity: rule.severity,
              title: rule.title(''),
              description: `Detected ${rule.type} issue: ${rule.title('')}`,
              examples: [content.substring(0, 200)],
              occurrences: 1,
              tool: event.tool,
            })
          }
          break // Only match first rule per event
        }
      }
    }

    return Array.from(patternMap.values())
  }

  /**
   * Detect repeated failures (same error 3+ times)
   */
  private detectRepeatedFailures(events: SessionEvent[]): AnalyzedPattern[] {
    const errorCounts = new Map<string, { count: number; examples: string[]; tool?: string }>()

    for (const event of events) {
      if (!event.isError) continue

      const content =
        typeof event.content === 'string' ? event.content : JSON.stringify(event.content)

      // Normalize error message for grouping
      const normalized = content.toLowerCase().substring(0, 100)

      if (errorCounts.has(normalized)) {
        const data = errorCounts.get(normalized)!
        data.count++
        if (data.examples.length < 3) {
          data.examples.push(content.substring(0, 200))
        }
      } else {
        errorCounts.set(normalized, {
          count: 1,
          examples: [content.substring(0, 200)],
          tool: event.tool,
        })
      }
    }

    const patterns: AnalyzedPattern[] = []
    for (const [normalized, data] of errorCounts) {
      if (data.count >= 3) {
        patterns.push({
          type: 'repeated_failure',
          severity: 'high',
          title: `Repeated error: ${normalized.substring(0, 50)}...`,
          description: `The same error occurred ${data.count} times in this session`,
          examples: data.examples,
          occurrences: data.count,
          tool: data.tool,
        })
      }
    }

    return patterns
  }

  /**
   * Generate suggested issues from patterns
   */
  private generateSuggestedIssues(
    patterns: AnalyzedPattern[],
    metadata: SessionMetadata
  ): SuggestedIssue[] {
    const suggestions: SuggestedIssue[] = []

    // Group patterns by type
    const byType = new Map<PatternType, AnalyzedPattern[]>()
    for (const pattern of patterns) {
      const existing = byType.get(pattern.type) ?? []
      existing.push(pattern)
      byType.set(pattern.type, existing)
    }

    // Generate issue for each pattern type
    for (const [type, typePatterns] of byType) {
      const totalOccurrences = typePatterns.reduce((sum, p) => sum + p.occurrences, 0)
      const highSeverity = typePatterns.filter(
        (p) => p.severity === 'high' || p.severity === 'critical'
      )

      // Create issues for:
      // 1. Any critical/high severity patterns
      // 2. Medium severity with 2+ total occurrences
      // 3. Multiple distinct patterns of the same type (2+)
      const hasHighSeverity = highSeverity.length > 0
      const hasMediumWithOccurrences = totalOccurrences >= 2
      const hasMultiplePatterns = typePatterns.length >= 2

      if (!hasHighSeverity && !hasMediumWithOccurrences && !hasMultiplePatterns) continue

      const primaryPattern = highSeverity[0] ?? typePatterns[0]

      // Determine category prefix and labels based on pattern type
      let categoryPrefix: string
      let labels: string[]
      switch (type) {
        case 'tool_misuse':
          categoryPrefix = '[Agent Behavior]'
          labels = ['Agent', 'Tool Usage']
          break
        case 'approval_required':
          categoryPrefix = '[Agent Permissions]'
          labels = ['Agent', 'Permissions']
          break
        case 'permission':
          categoryPrefix = '[Agent Environment]'
          labels = ['Agent', 'Sandbox']
          break
        default:
          categoryPrefix = '[Agent Environment]'
          labels = ['Agent', 'Infrastructure']
      }

      const title = `${categoryPrefix} ${primaryPattern.title}`
      const signature = generateSignature(type, primaryPattern.title)

      // Build description
      const description = [
        '## Summary',
        primaryPattern.description,
        '',
        `**Session:** ${metadata.issueIdentifier}`,
        `**Work Type:** ${metadata.workType}`,
        `**Occurrences:** ${totalOccurrences}`,
        `**Severity:** ${primaryPattern.severity}`,
        '',
        '## Examples',
        ...primaryPattern.examples.map((e) => `\`\`\`\n${e}\n\`\`\``),
        '',
        '## Analysis',
        `This issue was detected by the automated log analyzer.`,
        `Pattern type: ${type}`,
      ].join('\n')

      suggestions.push({
        signature,
        title,
        description,
        workType: type === 'tool_misuse' ? 'Bug' : 'Chore',
        labels,
        sourcePatterns: [type],
      })
    }

    return suggestions
  }

  /**
   * Mark a session as processed
   */
  markProcessed(sessionId: string, result: AnalysisResult): void {
    const processedPath = resolve(this.processedDir, `${sessionId}.json`)
    writeFileSync(processedPath, JSON.stringify(result, null, 2))
  }

  /**
   * Load the deduplication store
   */
  loadDeduplicationStore(): DeduplicationStore {
    if (!existsSync(this.deduplicationPath)) {
      return { issues: {} }
    }
    try {
      const content = readFileSync(this.deduplicationPath, 'utf-8')
      return JSON.parse(content) as DeduplicationStore
    } catch {
      return { issues: {} }
    }
  }

  /**
   * Save the deduplication store
   */
  saveDeduplicationStore(store: DeduplicationStore): void {
    writeFileSync(this.deduplicationPath, JSON.stringify(store, null, 2))
  }

  /**
   * Create or update issues in Linear
   * Returns created/updated issue identifiers
   */
  async createIssues(
    suggestions: SuggestedIssue[],
    sessionId: string,
    dryRun = false
  ): Promise<Array<{ signature: string; identifier: string; created: boolean }>> {
    if (!this.issueCreator) {
      throw new Error('Issue creator not initialized. Provide an IssueCreator when calling initialize().')
    }

    const store = this.loadDeduplicationStore()
    const results: Array<{ signature: string; identifier: string; created: boolean }> = []

    for (const suggestion of suggestions) {
      const existing = store.issues[suggestion.signature]

      if (existing) {
        // Update existing issue - add comment
        try {
          if (!dryRun) {
            await this.issueCreator.createComment(
              existing.linearIssueId,
              `+1 - Detected again in session. Total occurrences: ${existing.sessionCount + 1}`
            )
          }

          // Update store
          existing.lastSeenAt = Date.now()
          existing.sessionCount++
          if (!existing.sessionIds.includes(sessionId)) {
            existing.sessionIds.push(sessionId)
          }

          results.push({
            signature: suggestion.signature,
            identifier: existing.linearIdentifier,
            created: false,
          })
        } catch (error) {
          console.warn(`Failed to update issue ${existing.linearIdentifier}:`, error)
        }
      } else {
        // Create new issue
        try {
          if (!dryRun) {
            const issue = await this.issueCreator.createIssue({
              title: suggestion.title,
              description: suggestion.description,
              labels: suggestion.labels,
            })

            if (issue) {
              // Track in store
              store.issues[suggestion.signature] = {
                linearIssueId: issue.id,
                linearIdentifier: issue.identifier,
                createdAt: Date.now(),
                lastSeenAt: Date.now(),
                sessionCount: 1,
                sessionIds: [sessionId],
              }

              results.push({
                signature: suggestion.signature,
                identifier: issue.identifier,
                created: true,
              })
            }
          } else {
            // Dry run - just report what would be created
            results.push({
              signature: suggestion.signature,
              identifier: '[DRY RUN]',
              created: true,
            })
          }
        } catch (error) {
          console.warn(`Failed to create issue "${suggestion.title}":`, error)
        }
      }
    }

    // Save updated store
    if (!dryRun) {
      this.saveDeduplicationStore(store)
    }

    return results
  }

  /**
   * Cleanup old logs based on retention policy
   */
  cleanupOldLogs(): number {
    const cutoff = Date.now() - this.config.retentionDays * 24 * 60 * 60 * 1000
    let deleted = 0

    // Clean up old session directories
    if (existsSync(this.sessionsDir)) {
      const entries = readdirSync(this.sessionsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const sessionDir = join(this.sessionsDir, entry.name)
          const metadataPath = join(sessionDir, 'metadata.json')

          try {
            if (existsSync(metadataPath)) {
              const stats = statSync(metadataPath)
              if (stats.mtimeMs < cutoff) {
                rmSync(sessionDir, { recursive: true, force: true })
                deleted++
              }
            }
          } catch {
            // Skip on error
          }
        }
      }
    }

    // Clean up old processed files
    if (existsSync(this.processedDir)) {
      const entries = readdirSync(this.processedDir)
      for (const entry of entries) {
        const filePath = join(this.processedDir, entry)
        try {
          const stats = statSync(filePath)
          if (stats.mtimeMs < cutoff) {
            rmSync(filePath, { force: true })
            deleted++
          }
        } catch {
          // Skip on error
        }
      }
    }

    return deleted
  }
}

/**
 * Create and initialize a log analyzer
 */
export function createLogAnalyzer(
  config?: Partial<LogAnalysisConfig>,
  issueCreator?: IssueCreator
): LogAnalyzer {
  const analyzer = new LogAnalyzer(config)
  analyzer.initialize(issueCreator)
  return analyzer
}
