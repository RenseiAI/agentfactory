/**
 * @donmai/architectural-intelligence — public API
 *
 * Architecture reference: donmai-architecture/007-intelligence-services.md
 * §Architectural Intelligence
 *
 * Package skeleton. Ships:
 *   - Full type vocabulary (types.ts)
 *   - ArchitecturalIntelligence interface (types.ts)
 *   - Single-tenant local implementation: SqliteArchitecturalIntelligence
 *   - Multi-tenant SaaS stub: PostgresArchitecturalIntelligence (throws; see)
 *
 * Observation pipeline. Ships:
 *   - runObservationPass     — main pipeline entry point (pipeline.ts)
 *   - attachPipelineSubscribers — hook bus integration (pipeline.ts)
 *   - PrDiff / readDiffObservations — VCS diff reader (diff-reader.ts)
 *   - clusterObservations / effectiveConfidence — cluster+dedupe (cluster.ts)
 *   - isAuthoredDoc / makeAuthoredObservation — authored intent helpers
 *   - createTestBus          — in-package test hook bus
 *
 * Synthesis prompts. Ships:
 *   - promptRegistry / currentPrompt / versionedPrompt — versioned prompt registry
 *   - v1 prompts: pattern-extraction, convention-identification,
 *                 decision-recording, deviation-detection
 *   - evaluatePrompt / createStubAdapter / createFixedAdapter — eval rubric harness
 *   - compareABPrompts / formatABReport — A/B testing harness
 *
 * Drift detection. Ships:
 *   - assessChange           — core drift detection function (drift.ts)
 *   - DriftGatePolicy / resolveDriftGatePolicy / evaluateGate — threshold gating
 *   - AssessInput            — input type for assessChange
 *   - registerArchitectureVerbs — workflow verb registration (verbs.ts)
 *   - ASSESS_CHANGE_VERB / ARCHITECTURE_VERBS — verb declarations
 *   - handleAssessChange     — workflow verb action handler
 *   - AssessChangeVerbInput / AssessChangeVerbOutput — verb I/O schemas
 *
 * Not yet shipped (separate issues):
 *   - MCP tool exposure
 */

// Types + interface
export type {
  ArchitecturalIntelligence,
  ArchQuerySpec,
  ArchView,
  ArchObservation,
  ArchScope,
  WorkType,
  ArchitecturalPattern,
  Convention,
  Decision,
  Deviation,
  DriftReport,
  Citation,
  CitationConfidence,
  ChangeRef,
} from './types.js'

export { CITATION_CONFIDENCE_RANK, effectiveRepos } from './types.js'

// Implementations
export { SqliteArchitecturalIntelligence } from './sqlite-impl.js'
export type { SqliteArchConfig } from './sqlite-impl.js'

export {
  PostgresArchitecturalIntelligence,
  adapterFromPostgresJs,
  isJsonbParam,
  RLS_DDL_EXAMPLE,
  RLS_ORG_ID_SETTING,
} from './postgres/index.js'
export type {
  PostgresArchConfig,
  PostgresDbAdapter,
  JsonbParam,
  DbRow,
  PostgresJsSqlShape,
  TransactionRunner,
} from './postgres/index.js'

// Observation pipeline
export {
  runObservationPass,
  attachPipelineSubscribers,
  isAuthoredDoc,
  makeAuthoredObservation,
  createTestBus,
  MEMORY_OBSERVATION_KINDS,
} from './pipeline.js'
export type {
  RunObservationPassInput,
  RunObservationPassResult,
  PipelineSubscriberOptions,
  PipelineHookBus,
  PipelineHookEvent,
  PipelineHookHandler,
  MemoryObservationEvent,
  MemoryObservationKind,
} from './pipeline.js'

// VCS diff reader
export { readDiffObservations } from './diff-reader.js'
export type { PrDiff, PrFileDiff, DiffReaderConfig } from './diff-reader.js'

// Cluster + dedupe
export { clusterObservations, effectiveConfidence, _jaccardSimilarity } from './cluster.js'
export type { ClusterConfig, ObservationWithTimestamp, ClusterResult } from './cluster.js'

// Synthesis prompts
export {
  promptRegistry,
  currentPrompt,
  versionedPrompt,
  CURRENT_PROMPT_VERSION,
} from './prompts/index.js'
export type {
  PromptVersion,
  PromptModule,
  PromptRegistry,
  PatternExtractionModule,
  ConventionIdentificationModule,
  DecisionRecordingModule,
  DeviationDetectionModule,
  PatternExtractionInput,
  PatternExtractionOutput,
  ConventionIdentificationInput,
  ConventionIdentificationOutput,
  DecisionRecordingInput,
  DecisionRecordingOutput,
  DeviationDetectionInput,
  DeviationDetectionOutput,
  BaselineEntry,
} from './prompts/index.js'

// Eval rubric harness
export { evaluatePrompt, createStubAdapter, createFixedAdapter } from './eval.js'
export type { ModelAdapter, EvalScore, EvalConfig } from './eval.js'

// A/B test harness
export { compareABPrompts, formatABReport } from './ab-test.js'
export type {
  ABRunResult,
  ABSummary,
  ABTestResult,
  ABTestConfig,
} from './ab-test.js'

// Drift detection
export { assessChange, resolveDriftGatePolicy, evaluateGate } from './drift.js'
export type { DriftGatePolicy, AssessInput } from './drift.js'

// Workflow verb registration
export {
  registerArchitectureVerbs,
  handleAssessChange,
  ASSESS_CHANGE_VERB,
  ARCHITECTURE_VERBS,
  ARCHITECTURE_PLUGIN_ID,
} from './verbs.js'
export type {
  VerbRegistry,
  AssessChangeVerbInput,
  AssessChangeVerbOutput,
  AssessChangeHandlerOptions,
} from './verbs.js'
