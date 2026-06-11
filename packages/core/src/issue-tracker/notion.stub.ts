/**
 * NotionIssueTrackerProvider — stub skeleton.
 *
 * Implementation is deferred (tracked as a follow-up).
 * All verbs throw to make the unimplemented state explicit rather than
 * silently returning empty data.
 *
 * Once implemented this class will wrap the Notion API v1 database
 * queries and declare `capabilities.webhookProtocol = 'notion'`.
 *
 * Note: Notion in "tracker mode" represents issues as database rows.
 * Sub-issues, labels, and blocking relations are modelled via relation
 * properties; supportsBlocking is declared true for adapters that configure
 * a dedicated "Blocked by" relation property.
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

export class NotionIssueTrackerProvider implements IssueTrackerProvider {
  readonly capabilities: IssueTrackerCapabilities = {
    supportsSubIssues: true,    // Notion relation properties can model sub-pages
    supportsLabels: true,       // Notion multi-select properties
    supportsBlocking: true,     // Notion relation properties can model blocking
    supportsCustomFields: true,
    identityScheme: 'email',
    webhookProtocol: 'notion',
  }

  async getIssue(_idOrIdentifier: string): Promise<TrackerIssue> {
    throw new Error(
      'NotionIssueTrackerProvider.getIssue not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async listIssues(_filter: ListIssuesFilter): Promise<TrackerIssue[]> {
    throw new Error(
      'NotionIssueTrackerProvider.listIssues not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async createIssue(_input: IssueTrackerCreateInput): Promise<TrackerIssue> {
    throw new Error(
      'NotionIssueTrackerProvider.createIssue not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async updateIssue(_idOrIdentifier: string, _input: IssueTrackerUpdateInput): Promise<TrackerIssue> {
    throw new Error(
      'NotionIssueTrackerProvider.updateIssue not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async listComments(_idOrIdentifier: string): Promise<TrackerComment[]> {
    throw new Error(
      'NotionIssueTrackerProvider.listComments not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async createComment(_idOrIdentifier: string, _body: string): Promise<TrackerComment> {
    throw new Error(
      'NotionIssueTrackerProvider.createComment not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async addRelation(_input: AddRelationInput): Promise<AddRelationResult> {
    throw new Error(
      'NotionIssueTrackerProvider.addRelation not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }
}
