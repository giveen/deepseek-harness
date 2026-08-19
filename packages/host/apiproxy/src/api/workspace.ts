/**
 * workspace domain contract. Wire projection of the host-side workspace
 * entity (@deepseek-ai/dsh-workspace): a stable id over a directory path,
 * a display title, and the ordered session account. Method signatures are the
 * source of truth, same as the sessions domain.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Opaque Git object id returned by the Host's repository inspection API. */
export type GitCommitId = Branded<'GitCommitId'>

/** One bounded file-system entry in a Workspace. */
export interface WorkspaceFileEntry {
  /** Absolute Host path used only for the native open-path hand-off. */
  path: string
  /** Workspace-relative path displayed by the client. */
  relativePath: string
  /** Base name of the entry. */
  name: string
  /** Directory or regular file. */
  kind: 'directory' | 'file'
  /** Regular-file byte size when available. */
  size?: number
}

/** One commit in the Workspace's Git history. */
export interface WorkspaceCommit {
  /** Stable Git object id used as the pagination cursor. */
  id: GitCommitId
  /** Commit subject shown in the collapsed history row. */
  summary: string
  /** Full commit message shown when the row is expanded. */
  message: string
  /** Commit author timestamp in ISO-8601 form. */
  authoredAt: string
}

/** Workspace file listing response. */
export interface WorkspaceFilesPage {
  entries: WorkspaceFileEntry[]
  truncated: boolean
}

/** Workspace Git history response. */
export interface WorkspaceCommitsPage {
  commits: WorkspaceCommit[]
  hasMore: boolean
  /** Cursor to pass as `before` for the next older page. */
  nextBefore?: GitCommitId
}

/**
 * Import the RPC types once above the domain declarations; this duplicate-free
 * local alias keeps the method signatures below easy to scan.
 */
/**
 * Wire-side workspace id brand. Deliberately re-declared here rather than
 * imported from dsh-workspace: api/ must stay browser-importable with zero
 * host-package dependencies, and the brand string matches, so both sides
 * agree structurally.
 */
export type WorkspaceId = Branded<'WorkspaceId'>

/** One workspace row: the record projection every workspace.* value carries. */
export interface WorkspaceView {
  workspaceId: WorkspaceId
  /** Canonical directory path (host-side realpath canon). */
  path: string
  /** Display title (defaults to the path basename at create). */
  title: string
  /**
   * Sessions accounted under this workspace, in manually owned order
   * (attach prepends, insertSessionBefore reorders; activity never does).
   */
  sessionIds: SessionId[]
  /** ISO-8601 creation instant. */
  createdAt: string
  /** ISO-8601 last-mutation instant. */
  updatedAt: string
}

/** Workspace-domain unary methods (the map keys workspace.* of RpcMethodMap). */
export interface WorkspaceApi {
  /**
   * Lists all workspaces in the registry's durable display order, plus the
   * registry-global archive set (the reconnect baseline of
   * `host/archived-sessions-changed`). Archived sessions stay in their
   * workspace's `sessionIds` account; grouping surfaces hide them.
   */
  list(request: RpcRequest<{}>): Promise<RpcResponse<{ items: WorkspaceView[]; archivedSessionIds: SessionId[] }>>

  /**
   * Creates (or idempotently resolves) a workspace over an EXISTING directory
   * (no mkdir — a missing or non-directory path fails with
   * `workspace-invalid-path`). A path resolving to a directory already owned
   * by a workspace returns that workspace (`created: false`). Adoption allows
   * distinct canonical paths whose basenames produce the same display title;
   * the registry's basename title default names the new workspace.
   */
  create(request: RpcRequest<{ path: string }>):
  Promise<RpcResponse<{ workspace: WorkspaceView; created: boolean }>>

  /**
   * Renames a workspace. `title` is trimmed and must be non-empty
   * (schema-enforced). An unknown id fails with `workspace-not-found`; a
   * title equal to another workspace's fails with `workspace-name-conflict`.
   * Renaming to the current title is a no-op success (no durable write).
   */
  rename(request: RpcRequest<{ workspaceId: WorkspaceId; title: string }>):
  Promise<RpcResponse<{ workspace: WorkspaceView }>>

  /**
   * Removes one Workspace registration. The directory, every user file, and
   * every session log remain untouched; those Sessions consequently become
   * ungrouped. An unknown id fails with `workspace-not-found`.
   */
  delete(request: RpcRequest<{ workspaceId: WorkspaceId }>):
  Promise<RpcResponse<{ deleted: true }>>

  /**
   * Moves one Workspace within the registry display order,
   * DOM-insertBefore-like. An omitted anchor appends to the end.
   */
  insertBefore(request: RpcRequest<{
    workspaceId: WorkspaceId
    beforeWorkspaceId?: WorkspaceId
  }>): Promise<RpcResponse<{ workspaceIds: WorkspaceId[] }>>

  /**
   * Moves an accounted session within its workspace's manual order,
   * DOM-insertBefore-like: with `beforeSessionId` the session is inserted
   * before that anchor; omitted appends to the end. An unknown workspace
   * fails with `workspace-not-found`; a session or anchor not accounted by
   * the workspace fails with `workspace-move-invalid`. A move to the current
   * position is a no-op success.
   */
  insertSessionBefore(request: RpcRequest<{
    workspaceId: WorkspaceId
    sessionId: SessionId
    beforeSessionId?: SessionId
  }>): Promise<RpcResponse<{ workspace: WorkspaceView }>>

  /**
   * Adds one session to the registry-global archive set: the session
   * disappears from every grouping surface but keeps its session log and its
   * workspace accounting slot (a future unarchive restores its position).
   * Idempotent for an already archived id. A session neither live nor in
   * session persistence fails with `session-not-found`. Returns the full
   * updated set (same snapshot the changed frame carries).
   */
  archiveSession(request: RpcRequest<{ sessionId: SessionId }>):
  Promise<RpcResponse<{ archivedSessionIds: SessionId[] }>>

  /**
   * Lists a bounded recursive view of the Workspace directory. The Host owns
   * traversal limits and omits its `.git` metadata directory; the client never
   * sends arbitrary paths for this capability.
   */
  files(request: RpcRequest<{ workspaceId: WorkspaceId }>):
  Promise<RpcResponse<WorkspaceFilesPage>>

  /**
   * Returns one newest-first Git history page. `before` is the last commit id
   * from the previous page and `limit` is a client display hint bounded by the
   * Host.
   */
  commits(request: RpcRequest<{ workspaceId: WorkspaceId; before?: GitCommitId; limit?: number }>):
  Promise<RpcResponse<WorkspaceCommitsPage>>
}
