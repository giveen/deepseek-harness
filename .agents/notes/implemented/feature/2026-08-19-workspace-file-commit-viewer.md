# Agent Note: Workspace file and commit viewers

Status: implemented

English | [中文](2026-08-19-workspace-file-commit-viewer.zh.md)

## Problem

A selected Workspace currently provides session grouping and a directory picker, but the conversation has no direct view of the selected directory or its Git history. Operators must leave the Harness to identify files or inspect the changes that produced a workspace.

## Decision

The Workspace plugin contributes two additive `conversation.view` entries beside Chat and Trajectory: **Files** and **Commits**. The file view loads a Host-owned recursive listing for the Workspace associated with the current Session, expands directories locally, and sends file paths back through the existing Host opener. The commit view loads newest-first pages, expands each commit's full message in place, and uses the last commit id as the cursor for older pages.

The Host owns filesystem and Git inspection. It resolves the Workspace id from its registry rather than accepting an arbitrary client path, excludes `.git` and `node_modules` from the file tree, does not follow directory symlinks, limits depth and entry count, and reads Git with `execFile('git', args)` without a shell. A missing directory or Git repository is an inline view error; it does not fail the conversation or mutate the workspace.

The view is session-bound and re-resolves when the Session or Workspace baseline changes. File entries carry absolute paths only for the existing Host open-path handoff; relative paths are the display identity. Commit messages are returned as Host-computed text and are not model-visible content.

## Alternatives considered

**Put the tree in the sidebar.** Rejected because the requested interaction belongs beside the conversation's Chat and Trajectory context, and the sidebar already owns Workspace/session navigation.

**Send arbitrary client paths to a generic filesystem endpoint.** Rejected because the Host registry already knows the authorized Workspace root; accepting paths would widen the API and make traversal policy a client responsibility.

**Stream Git history continuously.** Rejected because commit history is paginated, user-paced inspection data. A bounded unary page is sufficient and avoids a second live stream.

## Consequences

A user can inspect the active Workspace without leaving the conversation and can open a file in the host application. Large repositories remain bounded, non-Git Workspaces remain usable, and older history is loaded only when requested. The feature depends on the existing connection, Workspace registry, conversation view slot, and native opener; deployments without a Workspace show a localized empty state.

## Testing

Focused UI coverage verifies directory expansion, file opening, commit-message expansion, and cursor-based older-page loading. Host workspace API and in-process carrier tests cover the added method routes and schemas. Typechecking covers the browser and Host contract faces.
