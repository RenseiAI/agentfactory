/**
 * Structured JSON Logger for AgentFactory Server
 *
 * Provides consistent, structured logging with:
 * - JSON output format for log aggregation
 * - Log levels (debug, info, warn, error)
 * - Context fields (requestId, sessionId, issueId, etc.)
 * - Automatic timestamps
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogContext {
  /** Unique request identifier for tracing */
  requestId?: string
  /** Linear agent session ID */
  sessionId?: string
  /** Linear issue ID */
  issueId?: string
  /** Linear issue identifier (e.g., ABC-123) */
  issueIdentifier?: string
  /** Linear workspace/organization ID */
  workspaceId?: string
  /** Duration in milliseconds */
  durationMs?: number
  /** Error object for error logs */
  error?: Error | unknown
  /** Any additional context fields */
  [key: string]: unknown
}

interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  service: string
  context?: Record<string, unknown>
}

/**
 * Log level priority for filtering
 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

/**
 * Get the minimum log level from environment
 * Defaults to 'info' in production, 'debug' in development
 */
function getMinLogLevel(): LogLevel {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase() as LogLevel | undefined
  if (envLevel && envLevel in LOG_LEVEL_PRIORITY) {
    return envLevel
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug'
}

/**
 * Check if JSON logging is enabled
 * Defaults to true in production, false in development for readability
 */
function isJsonLoggingEnabled(): boolean {
  const envValue = process.env.LOG_JSON
  if (envValue !== undefined) {
    return envValue === 'true' || envValue === '1'
  }
  return process.env.NODE_ENV === 'production'
}

/**
 * Format an error for logging
 */
function formatError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(error.cause ? { cause: formatError(error.cause) } : {}),
    }
  }
  return { message: String(error) }
}

/**
 * Format context for logging, handling special cases
 */
function formatContext(context: LogContext): Record<string, unknown> {
  const formatted: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue

    if (key === 'error') {
      formatted.error = formatError(value)
    } else if (value instanceof Error) {
      formatted[key] = formatError(value)
    } else {
      formatted[key] = value
    }
  }

  return formatted
}

/**
 * Logger class for structured logging
 */
class Logger {
  private service: string
  private defaultContext: LogContext
  private minLevel: LogLevel
  private jsonEnabled: boolean

  constructor(service: string, defaultContext: LogContext = {}) {
    this.service = service
    this.defaultContext = defaultContext
    this.minLevel = getMinLogLevel()
    this.jsonEnabled = isJsonLoggingEnabled()
  }

  /**
   * Create a child logger with additional default context
   */
  child(context: LogContext): Logger {
    const child = new Logger(this.service, {
      ...this.defaultContext,
      ...context,
    })
    return child
  }

  /**
   * Check if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.minLevel]
  }

  /**
   * Format and output a log entry
   */
  private log(level: LogLevel, message: string, context: LogContext = {}): void {
    if (!this.shouldLog(level)) return

    const mergedContext = { ...this.defaultContext, ...context }
    const formattedContext = formatContext(mergedContext)

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      service: this.service,
      ...(Object.keys(formattedContext).length > 0
        ? { context: formattedContext }
        : {}),
    }

    if (this.jsonEnabled) {
      this.outputJson(level, entry)
    } else {
      this.outputPretty(level, entry)
    }
  }

  /**
   * Output JSON formatted log
   */
  private outputJson(level: LogLevel, entry: LogEntry): void {
    const output = JSON.stringify(entry)
    switch (level) {
      case 'error':
        console.error(output)
        break
      case 'warn':
        console.warn(output)
        break
      default:
        console.log(output)
    }
  }

  /**
   * Output human-readable log for development
   */
  private outputPretty(level: LogLevel, entry: LogEntry): void {
    const levelColors: Record<LogLevel, string> = {
      debug: '\x1b[36m', // cyan
      info: '\x1b[32m', // green
      warn: '\x1b[33m', // yellow
      error: '\x1b[31m', // red
    }
    const reset = '\x1b[0m'
    const dim = '\x1b[2m'

    const color = levelColors[level]
    const levelStr = level.toUpperCase().padEnd(5)
    const time = entry.timestamp.split('T')[1].replace('Z', '')

    let output = `${dim}${time}${reset} ${color}${levelStr}${reset} [${entry.service}] ${entry.message}`

    if (entry.context && Object.keys(entry.context).length > 0) {
      const contextStr = Object.entries(entry.context)
        .filter(([key]) => key !== 'error')
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ')

      if (contextStr) {
        output += ` ${dim}${contextStr}${reset}`
      }

      // Print error details on separate lines
      if (entry.context.error) {
        const err = entry.context.error as Record<string, unknown>
        output += `\n  ${color}${err.name}: ${err.message}${reset}`
        if (err.stack) {
          const stackLines = (err.stack as string).split('\n').slice(1, 4)
          output += `\n${dim}${stackLines.join('\n')}${reset}`
        }
      }
    }

    switch (level) {
      case 'error':
        console.error(output)
        break
      case 'warn':
        console.warn(output)
        break
      default:
        console.log(output)
    }
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context)
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context)
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context)
  }

  error(message: string, context?: LogContext): void {
    this.log('error', message, context)
  }
}

/**
 * Create a logger instance for a service
 */
export function createLogger(
  service: string,
  defaultContext: LogContext = {}
): Logger {
  return new Logger(service, defaultContext)
}

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Default logger instance for the server
 */
export const logger = createLogger('agentfactory-server')
