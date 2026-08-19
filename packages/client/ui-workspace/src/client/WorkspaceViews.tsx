/** Conversation view entries for the Workspace file tree, Git history, and code graph. */

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import type {
  GitCommitId, WorkspaceCommit, WorkspaceFileEntry,
} from '@deepseek-ai/dsh-client-connection/client'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, IconChevronRightOutline14, IconTriangleRightFill14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import css from './WorkspaceViews.module.css'

/** Data and actions shared by the file viewer view entry. */
export interface WorkspaceFilesInjected {
  /** Load the current workspace's bounded file tree. */
  loadFiles: (workspaceId: WorkspaceId, signal: AbortSignal) => Promise<{ entries: WorkspaceFileEntry[]; truncated: boolean }>
  /** Open a host path in the operating system's default application. */
  openPath: (path: string) => void
}

/** Data and actions shared by the commit viewer view entry. */
export interface WorkspaceCommitsInjected {
  /** Load one newest-first commit page. */
  loadCommits: (
    workspaceId: WorkspaceId,
    before: GitCommitId | undefined,
    signal: AbortSignal,
  ) => Promise<{ commits: WorkspaceCommit[]; hasMore: boolean; nextBefore?: GitCommitId }>
}

type WorkspaceViewContext = Pick<ConvViewProps, 'sessionId' | 'useSessions' | 'useWorkspaces'>

function currentWorkspace(
  sessionId: SessionId,
  useSessions: ConvViewProps['useSessions'],
  useWorkspaces: ConvViewProps['useWorkspaces'],
): WorkspaceId | undefined {
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  return useWorkspaces(state => state.items.find(workspace =>
    workspace.sessionIds.includes(sessionId)
    || (cwd !== undefined && workspace.path === cwd),
  )?.workspaceId)
}

function formatSize(size: number | undefined): string {
  if (size === undefined) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function formatCommitDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Workspace file tree view shown in the conversation tab ring. */
export function WorkspaceFilesView({
  sessionId, useSessions, useWorkspaces, loadFiles, openPath, t,
}: WorkspaceViewContext & InjectFace<WorkspaceFilesInjected> & PropsLocale<'workspace'>) {
  const workspaceId = currentWorkspace(sessionId, useSessions, useWorkspaces)
  const [entries, setEntries] = useState<readonly WorkspaceFileEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    if (workspaceId === undefined) {
      setEntries([])
      setTruncated(false)
      setStatus('idle')
      setError(null)
      return
    }
    const controller = new AbortController()
    setStatus('loading')
    setError(null)
    void loadFiles(workspaceId, controller.signal).then((page) => {
      if (controller.signal.aborted) return
      setEntries(page.entries)
      setTruncated(page.truncated)
      setStatus('ready')
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      setEntries([])
      setTruncated(false)
      setStatus('error')
      setError(errorText(reason))
    })
    return () => { controller.abort() }
  }, [loadFiles, workspaceId])

  const directories = useMemo(
    () => new Set(entries.filter(entry => entry.kind === 'directory').map(entry => entry.relativePath)),
    [entries],
  )
  const visible = useMemo(() => entries.filter((entry) => {
    const parts = entry.relativePath.split('/')
    return parts.slice(0, -1).every((_part: string, index: number) => expanded.has(parts.slice(0, index + 1).join('/')))
  }), [entries, expanded])

  if (workspaceId === undefined) return <div className={css.empty}>{t('viewer.noWorkspace')}</div>
  return (
    <section className={css.root} aria-label={t('viewer.files.title')}>
      <header className={css.toolbar}>
        <strong>{t('viewer.files.title')}</strong>
        {status === 'ready' && <span className={css.count}>{t('viewer.files.count', { n: entries.length })}</span>}
      </header>
      {status === 'loading' && <div className={css.status} role="status">{t('viewer.loading')}</div>}
      {status === 'error' && <div className={css.error} role="alert">{t('viewer.failed', { message: error ?? '' })}</div>}
      {status === 'ready' && visible.length === 0 && <div className={css.empty}>{t('viewer.files.empty')}</div>}
      <div className={css.scroll} role="tree" aria-label={t('viewer.files.title')}>
        {visible.map((entry) => {
          const depth = entry.relativePath.split('/').length - 1
          const isDirectory = entry.kind === 'directory'
          const isExpanded = expanded.has(entry.relativePath)
          return (
            <div key={entry.relativePath} className={css.fileRow} role="treeitem" aria-expanded={isDirectory ? isExpanded : undefined}>
              {isDirectory ? (
                <button
                  type="button"
                  className={css.fileButton}
                  style={{ paddingLeft: `${8 + depth * 18}px` }}
                  onClick={() => {
                    setExpanded((current) => {
                      const next = new Set(current)
                      if (next.has(entry.relativePath)) next.delete(entry.relativePath)
                      else next.add(entry.relativePath)
                      return next
                    })
                  }}
                >
                  {isExpanded ? <IconChevronDownOutline14 /> : <IconChevronRightOutline14 />}
                  <IconTriangleRightFill14 />
                  <span>{entry.name}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className={css.fileButton}
                  style={{ paddingLeft: `${28 + depth * 18}px` }}
                  onClick={() => { openPath(entry.path) }}
                >
                  <span className={css.fileGlyph} aria-hidden="true">·</span>
                  <span>{entry.name}</span>
                  <span className={css.size}>{formatSize(entry.size)}</span>
                </button>
              )}
            </div>
          )
        })}
      </div>
      {truncated && <div className={css.notice}>{t('viewer.files.truncated')}</div>}
      {directories.size > 0 && <span className={css.srOnly}>{t('viewer.files.expandHint')}</span>}
    </section>
  )
}

/** Embedded codebase-memory graph UI shown in the conversation tab ring. */
export function WorkspaceCodebaseView({ t }: PropsLocale<'workspace'>) {
  return (
    <section className={css.root} aria-label={t('viewer.codebase.title')}>
      <header className={css.toolbar}>
        <strong>{t('viewer.codebase.title')}</strong>
        <span className={css.count}>{t('viewer.codebase.description')}</span>
      </header>
      <iframe
        className={css.embed}
        title={t('viewer.codebase.frameTitle')}
        src="/codebase-memory/"
        loading="lazy"
        referrerPolicy="same-origin"
        sandbox="allow-scripts allow-same-origin"
      />
    </section>
  )
}

/** Paginated Git commit history view shown in the conversation tab ring. */
export function WorkspaceCommitsView({
  sessionId, useSessions, useWorkspaces, loadCommits, t,
}: WorkspaceViewContext & InjectFace<WorkspaceCommitsInjected> & PropsLocale<'workspace'>) {
  const workspaceId = currentWorkspace(sessionId, useSessions, useWorkspaces)
  const [commits, setCommits] = useState<readonly WorkspaceCommit[]>([])
  const [nextBefore, setNextBefore] = useState<GitCommitId | undefined>()
  const [hasMore, setHasMore] = useState(false)
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    if (workspaceId === undefined) {
      setCommits([])
      setNextBefore(undefined)
      setHasMore(false)
      setStatus('idle')
      return
    }
    const controller = new AbortController()
    setStatus('loading')
    setError(null)
    void loadCommits(workspaceId, undefined, controller.signal).then((page) => {
      if (controller.signal.aborted) return
      setCommits(page.commits)
      setNextBefore(page.nextBefore)
      setHasMore(page.hasMore)
      setStatus('ready')
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return
      setCommits([])
      setNextBefore(undefined)
      setHasMore(false)
      setStatus('error')
      setError(errorText(reason))
    })
    return () => { controller.abort() }
  }, [loadCommits, workspaceId])

  const loadOlder = (): void => {
    if (workspaceId === undefined || !hasMore || nextBefore === undefined || status === 'loading') return
    const controller = new AbortController()
    setStatus('loading')
    void loadCommits(workspaceId, nextBefore, controller.signal).then((page) => {
      setCommits(current => [...current, ...page.commits])
      setNextBefore(page.nextBefore)
      setHasMore(page.hasMore)
      setStatus('ready')
    }).catch((reason: unknown) => {
      setStatus('error')
      setError(errorText(reason))
    })
  }

  if (workspaceId === undefined) return <div className={css.empty}>{t('viewer.noWorkspace')}</div>
  return (
    <section className={css.root} aria-label={t('viewer.commits.title')}>
      <header className={css.toolbar}>
        <strong>{t('viewer.commits.title')}</strong>
        {status === 'ready' && <span className={css.count}>{t('viewer.commits.count', { n: commits.length })}</span>}
      </header>
      {status === 'loading' && commits.length === 0 && <div className={css.status} role="status">{t('viewer.loading')}</div>}
      {status === 'error' && <div className={css.error} role="alert">{t('viewer.failed', { message: error ?? '' })}</div>}
      {status === 'ready' && commits.length === 0 && <div className={css.empty}>{t('viewer.commits.empty')}</div>}
      <div className={css.scroll} role="list" aria-label={t('viewer.commits.title')}>
        {commits.map((commit) => {
          const isExpanded = expanded.has(commit.id)
          return (
            <article key={commit.id} className={clsx(css.commit, isExpanded && css.commitExpanded)}>
              <button
                type="button"
                className={css.commitButton}
                aria-expanded={isExpanded}
                onClick={() => {
                  setExpanded((current) => {
                    const next = new Set(current)
                    if (next.has(commit.id)) next.delete(commit.id)
                    else next.add(commit.id)
                    return next
                  })
                }}
              >
                <span className={css.commitMarker} aria-hidden="true" />
                <span className={css.commitSummary}>{commit.summary}</span>
                <time dateTime={commit.authoredAt}>{formatCommitDate(commit.authoredAt)}</time>
              </button>
              {isExpanded && <pre className={css.commitMessage}>{commit.message}</pre>}
            </article>
          )
        })}
      </div>
      {hasMore && (
        <button type="button" className={css.moreButton} disabled={status === 'loading'} onClick={loadOlder}>
          {status === 'loading' ? t('viewer.loading') : t('viewer.commits.loadOlder')}
        </button>
      )}
    </section>
  )
}
