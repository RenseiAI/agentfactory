/**
 * IssueTrackerProvider — canonical typed contract for all issue tracker adapters.
 *
 * Per 002-provider-base-contract.md, Linear becomes one of N implementations.
 * Jira, Asana, Notion are sibling adapters with stub skeletons.
 *
 * Design notes:
 * - Capabilities are declared at the type level so schedulers can reason without
 *   loading the implementation.
 * - `supportsSubIssues: true` for Linear is declared for non-Rensei consumers and
 *   the canonical contract. Rensei agents MUST NOT use `parentId`; the capability
 *   flag is informational only.
 * - Verbs mirror the CLI surface: getIssue, listIssues, createIssue, updateIssue,
 *   listComments, createComment, addRelation.
 */

// ---------------------------------------------------------------------------
// Capability struct
// ---------------------------------------------------------------------------

/**
 * Identity scheme used by the tracker for user references.
 * - 'email' — users addressed by email address (Jira, Asana, Notion)
 * - 'username' — opaque username/handle (Linear, GitHub)
 * - 'oauth' — OAuth subject identifier
 * - 'iam' — cloud IAM principal (enterprise Jira/Asana)
 */
export type IssueTrackerIdentityScheme = 'email' | 'username' | 'oauth' | 'iam'

/**
 * Webhook protocol the tracker uses when pushing real-time events.
 * - 'linear' — Linear's signed webhook payload format
 * - 'jira' — Atlassian Connect / Jira webhook format
 * - 'asana' — Asana event webhook format
 * - 'notion' — Notion webhook format (planned; as of 2026 in beta)
 * - 'none' — tracker does not support inbound webhooks
 */
export type IssueTrackerWebhookProtocol = 'linear' | 'jira' | 'asana' | 'notion' | 'none'

/**
 * Declared capability flags for an IssueTrackerProvider.
 *
 * Kept flat (per 002 guidance) so the scheduler can index and query without
 * deserializing nested structures.
 */
export interface IssueTrackerCapabilities {
  /**
   * Whether the tracker supports parent-child issue hierarchies.
   * Note for Rensei agents: the Rensei platform FORBIDS calling parentId-based
   * APIs. This flag exists for the canonical contract and non-Rensei consumers.
   */
  supportsSubIssues: boolean

  /** Whether the tracker supports issue labels / tags. */
  supportsLabels: boolean

  /** Whether the tracker supports blocking relations between issues. */
  supportsBlocking: boolean

  /** Whether the tracker supports custom fields on issues. */
  supportsCustomFields: boolean

  /** How users are addressed in this tracker. */
  identityScheme: IssueTrackerIdentityScheme

  /** Webhook protocol emitted by this tracker for real-time events. */
  webhookProtocol: IssueTrackerWebhookProtocol
}

// ---------------------------------------------------------------------------
// Domain types used by verbs
// ---------------------------------------------------------------------------

/** Platform-agnostic issue representation. */
export interface TrackerIssue {
  id: string
  identifier: string
  title: string
  description?: string
  url: string
  priority?: number
  status?: string
  labels: string[]
  teamName?: string
  projectName?: string
  /** Parent issue ID, if this issue is a sub-issue. */
  parentId?: string
}

/** Minimal comment representation. */
export interface TrackerComment {
  id: string
  body: string
  createdAt: Date | string
  authorName?: string
}

/** Input for creating an issue via IssueTrackerProvider. */
export interface IssueTrackerCreateInput {
  title: string
  description?: string
  teamId?: string
  projectId?: string
  labelIds?: string[]
  stateId?: string
  /** Intentionally omitted from Rensei agent usage; declared for contract completeness. */
  parentId?: string
}

/** Input for updating an issue via IssueTrackerProvider. */
export interface IssueTrackerUpdateInput {
  title?: string
  description?: string
  stateId?: string
  labelIds?: string[]
}

/** Filter options for listing issues. */
export interface ListIssuesFilter {
  project?: string
  status?: string
  label?: string
  teamId?: string
  assigneeId?: string
  maxResults?: number
}

/** Relation type between issues. */
export type IssueRelationType = 'related' | 'blocks' | 'duplicate'

/** Input for creating an issue relation. */
export interface AddRelationInput {
  issueId: string
  relatedIssueId: string
  type: IssueRelationType
}

/** Result of adding a relation. */
export interface AddRelationResult {
  success: boolean
  relationId?: string
}

// ---------------------------------------------------------------------------
// IssueTrackerProvider interface
// ---------------------------------------------------------------------------

/**
 * The canonical typed contract every issue tracker adapter must implement.
 *
 * Implementations: LinearIssueTrackerProvider (packages/linear),
 * JiraIssueTrackerProvider (stub), AsanaIssueTrackerProvider (stub),
 * NotionIssueTrackerProvider (stub).
 */
export interface IssueTrackerProvider {
  /** Declared capability flags — read without loading code. */
  readonly capabilities: IssueTrackerCapabilities

  /**
   * Fetch a single issue by ID or provider-native identifier.
   * @param idOrIdentifier — UUID or human-readable key (e.g., "ABC-1295")
   */
  getIssue(idOrIdentifier: string): Promise<TrackerIssue>

  /**
   * List issues matching the provided filter.
   */
  listIssues(filter: ListIssuesFilter): Promise<TrackerIssue[]>

  /**
   * Create a new issue.
   * Rensei agents MUST NOT pass `input.parentId`; the field is in the input type
   * for non-Rensei consumers that declare `supportsSubIssues: true`.
   */
  createIssue(input: IssueTrackerCreateInput): Promise<TrackerIssue>

  /**
   * Update fields on an existing issue.
   */
  updateIssue(idOrIdentifier: string, input: IssueTrackerUpdateInput): Promise<TrackerIssue>

  /**
   * List all comments on an issue.
   */
  listComments(idOrIdentifier: string): Promise<TrackerComment[]>

  /**
   * Add a comment to an issue.
   */
  createComment(idOrIdentifier: string, body: string): Promise<TrackerComment>

  /**
   * Add a relation between two issues.
   * Only valid when `capabilities.supportsBlocking === true` for 'blocks' type.
   */
  addRelation(input: AddRelationInput): Promise<AddRelationResult>
}
