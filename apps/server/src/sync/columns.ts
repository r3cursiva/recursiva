import type { Equal, IssueModelName, IssueModels, ModelName, Models } from "@rsva/schema/models";
import { sql as dsql } from "drizzle-orm";
import { schema } from "../db.ts";

const { user, member, project, workflowState, label, cycle, issue, attachment, comment, reaction, document } = schema;

/** Columns sent to the client. Their order is the order of values in snapshot rows. */
export const COLUMNS = {
  /** Selected with the member row joined: the role is the workspace's. */
  User: { id: user.id, email: user.email, name: user.name, kind: user.kind, picture: user.picture, avatar: user.avatar, role: member.role },
  Project: {
    id: project.id, key: project.key, name: project.name, color: project.color, formerKeys: project.formerKeys, issueCounter: project.issueCounter,
    createdAt: project.createdAt, archivedAt: project.archivedAt, cycleRollover: project.cycleRollover,
  },
  WorkflowState: { id: workflowState.id, projectId: workflowState.projectId, name: workflowState.name, group: workflowState.group, color: workflowState.color, position: workflowState.position, isDefault: workflowState.isDefault, onlyPeople: workflowState.onlyPeople },
  Label: { id: label.id, projectId: label.projectId, parentId: label.parentId, name: label.name, color: label.color, position: label.position, onlyPeople: label.onlyPeople },
  Cycle: {
    id: cycle.id, projectId: cycle.projectId, number: cycle.number, name: cycle.name, description: cycle.description, startDate: cycle.startDate,
    endDate: cycle.endDate, leadId: cycle.leadId, createdById: cycle.createdById, createdAt: cycle.createdAt, completedAt: cycle.completedAt, summary: cycle.summary,
  },
  Issue: {
    id: issue.id, projectId: issue.projectId, number: issue.number, title: issue.title, stateId: issue.stateId, priority: issue.priority,
    assigneeIds: issue.assigneeIds, delegateId: issue.delegateId, labelIds: issue.labelIds, parentId: issue.parentId,
    blockedByIds: issue.blockedByIds, relatedIds: issue.relatedIds, duplicateOfId: issue.duplicateOfId,
    startDate: issue.startDate, dueDate: issue.dueDate, cycleId: issue.cycleId, sortOrder: issue.sortOrder, createdById: issue.createdById,
    createdAt: issue.createdAt, updatedAt: issue.updatedAt, completedAt: issue.completedAt, archivedAt: issue.archivedAt,
    deletedAt: issue.deletedAt, formerKeys: issue.formerKeys,
  },
  Attachment: {
    id: attachment.id, issueId: attachment.issueId, kind: attachment.kind, url: attachment.url, title: attachment.title,
    sha256: attachment.sha256, size: attachment.size, mime: attachment.mime, createdById: attachment.createdById, createdAt: attachment.createdAt,
  },
} as const satisfies Record<ModelName, object>;
// Every field of a model's type is sent, and nothing else: a column added to db.ts reaches the client or fails here.
true satisfies Equal<{ [M in ModelName]: keyof (typeof COLUMNS)[M] }, { [M in ModelName]: keyof Models[M] }>;

export const issueColumns = COLUMNS.Issue;
export const stateColumns = COLUMNS.WorkflowState;
export const labelColumns = COLUMNS.Label;
export const cycleColumns = COLUMNS.Cycle;
export const attachmentColumns = COLUMNS.Attachment;

/** Spelled out: drizzle leaves a one-table select's columns bare, and inside this subquery a bare `id` is the log's. */
const DOCUMENT_TX = dsql<string | null>`(select a.tx_id from sync_action a where a.workspace_id = "document"."workspace_id" and a.model_id = "document"."id" and a.model = 'Document' order by a.id desc limit 1)`;

/** Columns of the models an opened issue loads (GET /sync/history/:issueId) and their I actions carry. GithubLink rows are joined: github/pull.ts. */
export const ISSUE_MODEL_COLUMNS = {
  Comment: {
    id: comment.id, issueId: comment.issueId, parentId: comment.parentId, authorId: comment.authorId, body: comment.body,
    createdAt: comment.createdAt, editedAt: comment.editedAt, deletedAt: comment.deletedAt, via: comment.via,
  },
  Reaction: { id: reaction.id, issueId: reaction.issueId, commentId: reaction.commentId, userId: reaction.userId, emoji: reaction.emoji, createdAt: reaction.createdAt },
  // `tx`: which save this text is, for the next save to name as its base (write.ts, updateDocument).
  Document: { id: document.id, doc: document.doc, updatedAt: document.updatedAt, tx: DOCUMENT_TX },
} as const satisfies Record<Exclude<IssueModelName, "GithubLink">, object>;
true satisfies Equal<{ [M in keyof typeof ISSUE_MODEL_COLUMNS]: keyof (typeof ISSUE_MODEL_COLUMNS)[M] }, { [M in keyof typeof ISSUE_MODEL_COLUMNS]: keyof IssueModels[M] }>;

export const commentColumns = ISSUE_MODEL_COLUMNS.Comment;
export const reactionColumns = ISSUE_MODEL_COLUMNS.Reaction;
