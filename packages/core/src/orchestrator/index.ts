// Work Types (platform-agnostic)
export type { AgentWorkType, WorkflowStatus, WorkTypeStatusMappings, EnvironmentIssueType } from './work-types.js'
export { ENVIRONMENT_ISSUE_TYPES } from './work-types.js'

// Issue Tracker Client Interface (platform-agnostic)
export type {
  IssueTrackerClient,
  IssueTrackerIssue,
  IssueTrackerSession,
  SessionConfig,
  CommentChunk,
} from './issue-tracker-client.js'

// Null Issue Tracker Client (for platform-delegated workers without LINEAR_API_KEY)
export { NullIssueTrackerClient } from './null-issue-tracker-client.js'

// Log Analyzer Issue Creator Interface
export type { IssueCreator } from './log-analyzer.js'

// Types
export type {
  OrchestratorConfig,
  OrchestratorIssue,
  AgentProcess,
  OrchestratorEvents,
  SpawnAgentOptions,
  OrchestratorResult,
  OrchestratorStreamConfig,
  StopAgentResult,
  ForwardPromptResult,
  InjectMessageResult,
  SpawnAgentWithResumeOptions,
  WorkTypeTimeoutConfig,
  AgentWorkResult,
} from './types.js'

// Stream Parser Types
export type {
  ClaudeStreamEvent,
  ClaudeInitEvent,
  ClaudeSystemEvent,
  ClaudeAssistantEvent,
  ClaudeToolUseEvent,
  ClaudeToolResultEvent,
  ClaudeResultEvent,
  ClaudeErrorEvent,
  ClaudeTodoItem,
  ClaudeUserEvent,
  ClaudeEvent,
  ClaudeStreamHandlers,
} from './stream-parser.js'

// Activity Emitter Types
export type { ActivityEmitterConfig } from './activity-emitter.js'

// API Activity Emitter Types
export type { ApiActivityEmitterConfig, ProgressMilestone } from './api-activity-emitter.js'

// State Types (for durable agent hosting)
export type {
  WorktreeState,
  WorktreeStatus,
  HeartbeatState,
  HeartbeatActivityType,
  TodosState,
  TodoItem,
  TodoStatus,
  ProgressLogEntry,
  ProgressEventType,
  RecoveryCheckResult,
  HeartbeatWriterConfig,
  ProgressLoggerConfig,
  FileAction,
  FileModification,
  Decision,
  StructuredSummary,
} from './state-types.js'
export { SUMMARY_SCHEMA_VERSION } from './state-types.js'

// Log Config Types (for session logging)
export type { LogAnalysisConfig } from './log-config.js'

// Session Logger Types (for verbose logging)
export type {
  SessionEventType,
  SessionEvent,
  SessionMetadata,
  SessionLoggerConfig,
} from './session-logger.js'

// Log Analyzer Types (for analysis and issue creation)
export type {
  PatternType,
  PatternSeverity,
  AnalyzedPattern,
  AnalysisResult,
  SuggestedIssue,
  TrackedIssue,
  DeduplicationStore,
} from './log-analyzer.js'

// Orchestrator
export { AgentOrchestrator, createOrchestrator, getWorktreeIdentifier, validateGitRemote, resolveWorktreePath } from './orchestrator.js'

// Stream Parser
export { ClaudeStreamParser, createStreamParser } from './stream-parser.js'

// Activity Emitter
export { ActivityEmitter, createActivityEmitter } from './activity-emitter.js'

// API Activity Emitter (for remote workers proxying through API)
export { ApiActivityEmitter, createApiActivityEmitter } from './api-activity-emitter.js'

// Heartbeat Writer (for crash detection)
export {
  HeartbeatWriter,
  createHeartbeatWriter,
  getHeartbeatIntervalFromEnv,
} from './heartbeat-writer.js'

// Progress Logger (for debugging)
export { ProgressLogger, createProgressLogger } from './progress-logger.js'

// State Recovery (for crash recovery)
export {
  getAgentDir,
  getStatePath,
  getHeartbeatPath,
  getTodosPath,
  isHeartbeatFresh,
  readWorktreeState,
  readHeartbeat,
  readTodos,
  checkRecovery,
  initializeAgentDir,
  writeState,
  updateState,
  writeTodos,
  createInitialState,
  buildRecoveryPrompt,
  buildResumeContext,
  getHeartbeatTimeoutFromEnv,
  getMaxRecoveryAttemptsFromEnv,
  getTaskListId,
  getSummaryPath,
  readSummary,
  writeSummary,
} from './state-recovery.js'

// Log Config
export {
  getLogAnalysisConfig,
  isSessionLoggingEnabled,
  isAutoAnalyzeEnabled,
} from './log-config.js'

// Session Logger
export {
  SessionLogger,
  createSessionLogger,
  readSessionMetadata,
  readSessionEvents,
} from './session-logger.js'

// Work Result Parser (for QA/acceptance pass/fail detection)
export { parseWorkResult } from './parse-work-result.js'

// Security Scan Event (structured vulnerability data from security station)
export type { SecurityScanEvent } from './security-scan-event.js'
export {
  SecurityScanEventSchema,
  parseSecurityScanOutput,
  parseSemgrepOutput,
  parseNpmAuditOutput,
} from './security-scan-event.js'

// Completion Contracts & Session Backstop
export {
  getCompletionContract,
  validateCompletion,
  formatMissingFields,
} from './completion-contracts.js'
export type {
  CompletionContract,
  CompletionField,
  CompletionFieldType,
  CompletionValidationResult,
  SessionOutputs,
  BackstopAction,
  BackstopResult,
} from './completion-contracts.js'
export {
  runBackstop,
  collectSessionOutputs,
  formatBackstopComment,
} from './session-backstop.js'
export type {
  SessionContext,
  BackstopOptions,
  BackstopRunResult,
} from './session-backstop.js'

// Quality Baseline & Ratchet
export {
  captureQualityBaseline,
  computeQualityDelta,
  formatQualityReport,
  saveBaseline,
  loadBaseline,
} from './quality-baseline.js'
export type {
  QualityBaseline,
  QualityDelta,
  QualityConfig,
} from './quality-baseline.js'
export {
  loadQualityRatchet,
  checkQualityRatchet,
  updateQualityRatchet,
  initializeQualityRatchet,
  formatRatchetResult,
} from './quality-ratchet.js'
export type {
  QualityRatchet,
  RatchetCheckResult,
} from './quality-ratchet.js'

// Log Analyzer
export { LogAnalyzer, createLogAnalyzer } from './log-analyzer.js'

// Artifact Tracker (for context window management)
export {
  ArtifactTracker,
} from './artifact-tracker.js'
export type {
  TrackedFileAction,
  TrackedFile,
  ArtifactIndex,
} from './artifact-tracker.js'

// Summary Builder (for context window management)
export { SummaryBuilder } from './summary-builder.js'

// Context Manager (coordinates context window management)
export { ContextManager } from './context-manager.js'
export type { ContextManagerConfig } from './context-manager.js'

// Sandbox scheduler — cross-provider capability-based routing
// Architecture reference: donmai-architecture/004-sandbox-capability-matrix.md
export {
  pickProvider,
  normalizeCost,
  ProviderBlacklist,
  filterBlacklisted,
} from './scheduler.js'
export type {
  SchedulerSandboxSpec,
  CapacitySnapshot,
  SchedulerCandidate,
  TenantSchedulePolicy,
  EliminationStep,
  SchedulerResult,
  BlacklistEntry,
} from './scheduler.js'
