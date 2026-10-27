/**
 * How a document is opened.
 * - edit: full editing
 * - comment: read and comment only
 * - suggest: initiator; every edit is a tracked change in the user's name
 * - approve: approver; accept/reject changes, and own edits are tracked in the approver's name
 * - view: read only
 */
export type DocumentMode = 'edit' | 'comment' | 'suggest' | 'approve' | 'view';

export const DOCUMENT_MODES: readonly DocumentMode[] = ['edit', 'comment', 'suggest', 'approve', 'view'];

/** Document row from the sample DocumentsController (GET /api/documents). Your platform may use its own DTO. */
export interface DocumentInfo {
  id: string;
  name: string;
  size: number;
  version: number;
  modified: string;
  modifiedBy: string;
}

export interface DocumentVersion {
  version: number;
  savedAt: string;
  savedBy: string;
  size: number;
}

/** Returned by GET /api/documents/{id}/access. */
export interface DocumentAccess {
  id: string;
  name: string;
  version: number;
  /** The mode actually granted (the server refuses modes the user's rights don't allow). */
  mode: DocumentMode;
  /** Every mode this user may open the document in, e.g. to show a mode switcher. */
  allowedModes: DocumentMode[];
  userName: string;
}
