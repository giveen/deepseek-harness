// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SessionId, WorkspaceId, WorkspaceListState, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { WorkspaceCommitsView, WorkspaceFilesView } from '../src/client/WorkspaceViews.tsx'
import type { WorkspaceKey } from '../src/client/locales.ts'

afterEach(cleanup)

const sid = (value: string) => value as SessionId
const wid = (value: string) => value as WorkspaceId

const workspace: WorkspaceView = {
  workspaceId: wid('workspace-1'),
  path: '/projects/example',
  title: 'example',
  sessionIds: [sid('session-1')],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const workspaces: WorkspaceListState = {
  items: [workspace],
  archivedSessionIds: [],
  state: 'idle',
  phase: 'ready',
  error: null,
  baselinesReady: true,
  recentWorkspaceId: workspace.workspaceId,
}

function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S {
    return selector(snapshot)
  }
}

const useSessions = hook({
  byId: { 'session-1': { id: sid('session-1'), cwd: workspace.path } },
}) as unknown as ConvViewProps['useSessions']
const useWorkspaces = hook(workspaces)
const t = ((key: WorkspaceKey, values?: Record<string, string | number>) => {
  const copy: Record<string, string> = {
    'viewer.files.title': 'Workspace files',
    'viewer.commits.title': 'Commit history',
    'viewer.noWorkspace': 'This session has no workspace',
    'viewer.loading': 'Loading…',
    'viewer.failed': 'Load failed: {message}',
    'viewer.files.count': '{n} entries',
    'viewer.files.empty': 'This workspace is empty',
    'viewer.files.truncated': 'The file list reached its display limit.',
    'viewer.files.expandHint': 'Click a folder to expand it',
    'viewer.commits.count': '{n} commits',
    'viewer.commits.empty': 'No commit history',
    'viewer.commits.loadOlder': 'Load older commits',
  }
  return (copy[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => String(values?.[name] ?? `{${name}}`))
}) as never

type TestViewProps = {
  sessionId: SessionId
  useSessions: ConvViewProps['useSessions']
  useWorkspaces: ConvViewProps['useWorkspaces']
  t: never
}

function viewProps<T extends Record<string, unknown>>(extra: T): TestViewProps & T {
  return {
    sessionId: sid('session-1'),
    useSessions,
    useWorkspaces,
    t,
    ...extra,
  }
}

describe('Workspace conversation views', () => {
  it('expands directories and opens files through the Host action', async () => {
    const openPath = vi.fn()
    const loadFiles = vi.fn(async () => ({
      entries: [
        { path: '/projects/example/README.md', relativePath: 'README.md', name: 'README.md', kind: 'file' as const, size: 128 },
        { path: '/projects/example/src', relativePath: 'src', name: 'src', kind: 'directory' as const },
        { path: '/projects/example/src/index.ts', relativePath: 'src/index.ts', name: 'index.ts', kind: 'file' as const, size: 256 },
      ],
      truncated: false,
    }))
    render(<WorkspaceFilesView {...viewProps({ loadFiles, openPath })} />)

    await waitFor(() => { expect(screen.getByText('README.md')).toBeTruthy() })
    expect(screen.queryByText('index.ts')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'src' }))
    expect(screen.getByText('index.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /README\.md/ }))
    expect(openPath).toHaveBeenCalledWith('/projects/example/README.md')
  })

  it('expands commit messages and requests older pages with the returned cursor', async () => {
    const before = '0123456' as never
    const loadCommits = vi.fn()
      .mockResolvedValueOnce({
        commits: [{
          id: 'abcdef1' as never,
          summary: 'Current commit',
          message: 'Current commit\n\nDetails',
          authoredAt: '2026-01-02T00:00:00.000Z',
        }],
        hasMore: true,
        nextBefore: before,
      })
      .mockResolvedValueOnce({
        commits: [{
          id: '1234567' as never,
          summary: 'Older commit',
          message: 'Older details',
          authoredAt: '2026-01-01T00:00:00.000Z',
        }],
        hasMore: false,
      })
    render(<WorkspaceCommitsView {...viewProps({ loadCommits })} />)

    await waitFor(() => { expect(screen.getByText('Current commit')).toBeTruthy() })
    expect(screen.queryByText('Current commit\n\nDetails')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Current commit/ }))
    expect(document.querySelector('pre')?.textContent).toContain('Details')
    fireEvent.click(screen.getByRole('button', { name: 'Load older commits' }))
    await waitFor(() => { expect(screen.getByText('Older commit')).toBeTruthy() })
    expect(loadCommits).toHaveBeenLastCalledWith(workspace.workspaceId, before, expect.any(AbortSignal))
  })
})
