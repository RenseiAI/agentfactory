/**
 * VCS module — VersionControlProvider abstraction + GitHub + Atomic adapters
 *
 * Architecture reference: donmai-architecture/008-version-control-providers.md
 */

export type {
  VersionControlProvider,
  VersionControlProviderCapabilities,
  Workspace,
  CloneOpts,
  CellChange,
  KitProviderId,
  WorkareaSnapshotRef,
  SessionAttestation,
  ChangeRequest,
  ChangeRef,
  PushTarget,
  PushResult,
  PullSource,
  VCSMergeResult,
  ProposalOpts,
  ProposalRef,
  MergeStrategy,
  MergeQueueOpts,
  QueueTicket,
  Conflict,
  AutoResolution,
  Resolution,
  AttestationRef,
} from './types.js'

export { UnsupportedOperationError, assertCapability } from './types.js'
export { GitHubVCSProvider, GITHUB_VCS_CAPABILITIES, buildCommitMessageWithTrailers, buildAttestationTrailers } from './github.js'
export {
  AtomicVCSProvider,
  ATOMIC_VCS_CAPABILITIES,
  executeAtomicCommand,
  executeAtomicCommandWithOutput,
  parseAtomicPullOutput,
  parseAutoResolutions,
  parseAtomicConflicts,
  classifyAtomicPushError,
  buildAtomicAttestationMessage,
} from './atomic.js'
export type { OpenProposalResult, UnsupportedOperationError as AtomicUnsupportedOperationError, AtomicCommandOpts } from './atomic.js'
