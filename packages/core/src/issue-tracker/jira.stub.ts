/**
 * JiraIssueTrackerProvider — stub skeleton.
 *
 * Implementation is deferred (tracked as a follow-up).
 * All verbs throw to make the unimplemented state explicit rather than
 * silently returning empty data.
 *
 * Once implemented this class will wrap the Jira REST v3 / Atlassian
 * Connect API and declare `capabilities.webhookProtocol = 'jira'`.
 */

import type {
  IssueTrackerProvider,
  IssueTrackerCapabilities,
  TrackerIssue,
  TrackerComment,
  IssueTrackerCreateInput,
  IssueTrackerUpdateInput,
  ListIssuesFilter,
  AddRelationInput,
  AddRelationResult,
} from './types.js'

export class JiraIssueTrackerProvider implements IssueTrackerProvider {
  readonly capabilities: IssueTrackerCapabilities = {
    supportsSubIssues: true,    // Jira has epics/sub-tasks
    supportsLabels: true,
    supportsBlocking: true,
    supportsCustomFields: true,
    identityScheme: 'email',
    webhookProtocol: 'jira',
  }

  async getIssue(_idOrIdentifier: string): Promise<TrackerIssue> {
    throw new Error(
      'JiraIssueTrackerProvider.getIssue not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async listIssues(_filter: ListIssuesFilter): Promise<TrackerIssue[]> {
    throw new Error(
      'JiraIssueTrackerProvider.listIssues not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async createIssue(_input: IssueTrackerCreateInput): Promise<TrackerIssue> {
    throw new Error(
      'JiraIssueTrackerProvider.createIssue not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async updateIssue(_idOrIdentifier: string, _input: IssueTrackerUpdateInput): Promise<TrackerIssue> {
    throw new Error(
      'JiraIssueTrackerProvider.updateIssue not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async listComments(_idOrIdentifier: string): Promise<TrackerComment[]> {
    throw new Error(
      'JiraIssueTrackerProvider.listComments not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async createComment(_idOrIdentifier: string, _body: string): Promise<TrackerComment> {
    throw new Error(
      'JiraIssueTrackerProvider.createComment not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async addRelation(_input: AddRelationInput): Promise<AddRelationResult> {
    throw new Error(
      'JiraIssueTrackerProvider.addRelation not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }
}
