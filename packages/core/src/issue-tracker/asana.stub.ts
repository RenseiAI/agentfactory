/**
 * AsanaIssueTrackerProvider — stub skeleton.
 *
 * Implementation is deferred (tracked as a follow-up).
 * All verbs throw to make the unimplemented state explicit rather than
 * silently returning empty data.
 *
 * Once implemented this class will wrap the Asana REST API v1
 * and declare `capabilities.webhookProtocol = 'asana'`.
 *
 * Note: Asana does not have first-class blocking relations; `supportsBlocking`
 * is false. `addRelation` with type 'blocks' will throw accordingly.
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

export class AsanaIssueTrackerProvider implements IssueTrackerProvider {
  readonly capabilities: IssueTrackerCapabilities = {
    supportsSubIssues: true,    // Asana has subtasks
    supportsLabels: true,       // Asana has tags
    supportsBlocking: false,    // Asana has no native blocking relation
    supportsCustomFields: true,
    identityScheme: 'email',
    webhookProtocol: 'asana',
  }

  async getIssue(_idOrIdentifier: string): Promise<TrackerIssue> {
    throw new Error(
      'AsanaIssueTrackerProvider.getIssue not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async listIssues(_filter: ListIssuesFilter): Promise<TrackerIssue[]> {
    throw new Error(
      'AsanaIssueTrackerProvider.listIssues not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async createIssue(_input: IssueTrackerCreateInput): Promise<TrackerIssue> {
    throw new Error(
      'AsanaIssueTrackerProvider.createIssue not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async updateIssue(_idOrIdentifier: string, _input: IssueTrackerUpdateInput): Promise<TrackerIssue> {
    throw new Error(
      'AsanaIssueTrackerProvider.updateIssue not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async listComments(_idOrIdentifier: string): Promise<TrackerComment[]> {
    throw new Error(
      'AsanaIssueTrackerProvider.listComments not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async createComment(_idOrIdentifier: string, _body: string): Promise<TrackerComment> {
    throw new Error(
      'AsanaIssueTrackerProvider.createComment not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }

  async addRelation(_input: AddRelationInput): Promise<AddRelationResult> {
    throw new Error(
      'AsanaIssueTrackerProvider.addRelation not implemented; ' +
      'implementation deferred — tracked as a follow-up'
    )
  }
}
