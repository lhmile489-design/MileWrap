import { useEffect, useRef, useState } from 'react'
import { Copy, GitCommit, GitDiff as GitDiffIcon, Warning, X } from '@phosphor-icons/react'
import type { GitCommit as GitCommitInfo, GitCommitDetail, GitCommitFile, GitDiff } from '@shared/types'
import { useOverlay } from '../../lib/useOverlay'
import { errorText } from '../../lib/errors'
import { useGit } from '../../store/git'
import { useSessions } from '../../store/sessions'
import { useConfig } from '../../store/config'
import { useUi } from '../../store/ui'
import { notifyError } from '../ConfirmDialog'
import { Button, IconButton, WorkspaceIcon } from '../ui'
import { BADGE, Body, DiffBody, DiffPane, Empty, splitPath } from './GitPanel'

const PAGE = 50

type Tab = 'changes' | 'history'

/**
 * Git 工作台（Git管理-PRD G-30–G-32）：宽屏看改动与提交历史。整包按需加载，和 Git 栏共用 store/git。
 * 「改动」页左列表右 diff；「历史」页左提交列表（每页 50 条，加载更多）、右提交详情与文件 diff。
 */
export function GitWorkbench(): React.JSX.Element | null {
  const tab = useUi((s) => s.gitWorkbench)
  const open = useUi((s) => s.openGitWorkbench)
  const close = useUi((s) => s.closeGitWorkbench)
  const selected = useSessions((s) => s.selectedWorkspaceId)
  const workspaceId = useGit((s) => s.workspaceId)
  const workspace = useConfig((s) => s.config?.workspaces.find((w) => w.id === workspaceId))
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlay(panelRef, close)

  // 从命令面板直接打开时 Git 栏可能没挂过：跟随会话栏选中的工作区
  useEffect(() => {
    // 和 Git 栏一样跟随会话栏选中（审查 2026-11-06：原来 store 里有旧工作区时不切）
    const g = useGit.getState()
    if (selected && selected !== g.workspaceId) g.setWorkspace(selected)
    else void g.refresh({ force: true, silent: true })
  }, [selected])

  // 工作台和 Git 栏共用 store 的 view：打开时记下 Git 栏原来的视图，关掉时还原，两边不互相串
  useEffect(() => {
    const before = useGit.getState().view
    const beforeId = useGit.getState().workspaceId
    return () => {
      const g = useGit.getState()
      // 工作台开着时切了工作区：setWorkspace 已重置视图，不把旧工作区的 diff 带回来
      if (g.workspaceId !== beforeId || before.kind === 'list') g.backToList()
      else g.openDiff(before.path, before.staged)
    }
  }, [])

  if (!tab) return null
  const tabs: { id: Tab; label: string }[] = [
    { id: 'changes', label: '改动' },
    { id: 'history', label: '历史' }
  ]
  return (
    <div className="dialog-backdrop fixed inset-0 z-40 grid place-items-center" onMouseDown={close}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="git-workbench-title"
        data-testid="git-workbench"
        className="flex h-[min(720px,calc(100vh-64px))] w-[min(1060px,calc(100vw-64px))] flex-col overflow-hidden rounded-card border border-line bg-panel shadow-[var(--shadow-float)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
          <WorkspaceIcon workspaceId={workspaceId} agentId={workspace?.agentId ?? 'shell'} size={20} />
          <h2 id="git-workbench-title" className="min-w-0 truncate font-display text-[15px] font-bold text-ink-strong">
            Git · {workspace?.name ?? '未选择工作区'}
          </h2>
          <div
            role="tablist"
            aria-label="工作台页签"
            className="ml-2 flex h-8 items-center gap-0.5 rounded-pill bg-raised p-0.5"
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
              e.preventDefault()
              const next = tab === 'changes' ? 'history' : 'changes'
              open(next)
              requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-workbench-tab="${next}"]`)?.focus())
            }}
          >
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === tab}
                tabIndex={t.id === tab ? 0 : -1}
                data-workbench-tab={t.id}
                onClick={() => open(t.id)}
                className={`h-7 rounded-pill px-3 text-[12px] transition-colors duration-150 ${
                  t.id === tab ? 'bg-card font-semibold text-ink-strong shadow-[var(--shadow-lift)]' : 'text-ink-muted hover:text-ink-strong'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <IconButton label="关闭" onClick={close}>
            <X size={16} />
          </IconButton>
        </div>
        {!workspaceId ? (
          <Empty icon={<GitCommit size={20} />} title="没有选中工作区" body="在会话栏选一个工作区再打开" />
        ) : tab === 'changes' ? (
          <ChangesTab />
        ) : (
          <HistoryTab workspaceId={workspaceId} />
        )}
      </div>
    </div>
  )
}

/** 「改动」页：左边是 Git 栏同一份改动列表与提交框，右边是选中文件的 diff */
function ChangesTab(): React.JSX.Element {
  const view = useGit((s) => s.view)
  return (
    <div className="flex min-h-0 flex-1" data-testid="git-workbench-changes">
      <div className="flex w-[340px] shrink-0 flex-col border-r border-line">
        <Body />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {view.kind === 'diff' ? (
          <DiffPane path={view.path} staged={view.staged} />
        ) : (
          <Empty icon={<GitDiffIcon size={20} />} title="选择文件查看改动" body="点左侧改动列表里的文件" />
        )}
      </div>
    </div>
  )
}

/** 「历史」页（G-31 / G-32） */
function HistoryTab({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const [commits, setCommits] = useState<GitCommitInfo[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const req = useRef(0)
  // HEAD 变了（界面或终端里提交、切分支、拉取）才重读；暂存 / 改文件不重读（审查 2026-11-06）
  const headKey = useGit((s) => (s.status ? `${s.status.branch}:${s.status.head ?? ''}` : ''))
  const listRef = useRef<HTMLUListElement>(null)
  // 方向键 / Home / End 移动选中（listbox 键盘导航）
  const onListKey = (e: React.KeyboardEvent): void => {
    if (!commits.length) return
    const i = Math.max(0, commits.findIndex((c) => c.hash === selected))
    let n = i
    if (e.key === 'ArrowDown') n = Math.min(commits.length - 1, i + 1)
    else if (e.key === 'ArrowUp') n = Math.max(0, i - 1)
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = commits.length - 1
    else return
    e.preventDefault()
    const hash = commits[n].hash
    setSelected(hash)
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-commit="${hash}"]`)?.focus())
  }

  const load = async (offset: number): Promise<void> => {
    const r = ++req.current
    setLoading(true)
    try {
      const page = await window.warp.git.log(workspaceId, offset, PAGE)
      if (r !== req.current) return
      setCommits((prev) => (offset === 0 ? page.commits : [...prev, ...page.commits]))
      setHasMore(page.hasMore)
      setError(null)
      if (offset === 0) setSelected((s) => (s && page.commits.some((c) => c.hash === s) ? s : (page.commits[0]?.hash ?? null)))
    } catch (e) {
      if (r === req.current) setError(errorText(e))
    } finally {
      if (r === req.current) setLoading(false)
    }
  }

  useEffect(() => {
    void load(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, headKey])

  return (
    <div className="flex min-h-0 flex-1" data-testid="git-workbench-history">
      <div className="flex w-[360px] shrink-0 flex-col border-r border-line">
        {error ? (
          <Empty icon={<Warning size={20} />} title="读取历史失败" body={error} danger />
        ) : commits.length === 0 && !loading ? (
          <Empty icon={<GitCommit size={20} />} title="暂无提交记录" body="这个分支还没有提交" />
        ) : (
          <ul ref={listRef} role="listbox" aria-label="提交历史" className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="git-history-list" onKeyDown={onListKey}>
            {commits.map((c, i) => (
              <li key={c.hash} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={c.hash === selected}
                  tabIndex={c.hash === selected || (!selected && i === 0) ? 0 : -1}
                  data-commit={c.hash}
                  onClick={() => setSelected(c.hash)}
                  className={`flex w-full items-stretch gap-2 px-3 text-left transition-colors duration-150 ${c.hash === selected ? 'bg-accent-soft' : 'hover:bg-raised'}`}
                >
                  {/* 单列时间线：竖线 + 圆点 */}
                  <span aria-hidden="true" className="relative w-3 shrink-0">
                    <span className={`absolute left-1/2 w-px -translate-x-1/2 bg-line-strong ${i === 0 ? 'top-1/2' : 'top-0'} ${i === commits.length - 1 && !hasMore ? 'bottom-1/2' : 'bottom-0'}`} />
                    <span className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-pill border-2 border-accent bg-card" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="min-w-0 truncate text-[13px] text-ink-strong">{c.subject || '（无标题）'}</span>
                      {c.refs.slice(0, 2).map((r) => (
                        <span key={r} className="shrink-0 rounded-badge border border-accent px-1 text-[12px] text-accent">
                          {r}
                        </span>
                      ))}
                    </span>
                    <span className="truncate text-[12px] text-ink-muted">
                      <span className="font-mono">{c.shortHash}</span> · {c.author} · {relTime(c.time)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {hasMore && (
              <li className="px-3 py-2">
                <Button disabled={loading} onClick={() => void load(commits.length)} testId="git-history-more">
                  {loading ? '加载中…' : '加载更多'}
                </Button>
              </li>
            )}
          </ul>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <CommitDetailPane key={selected} workspaceId={workspaceId} hash={selected} />
        ) : (
          <Empty icon={<GitCommit size={20} />} title="选择提交查看详情" body="点左侧的提交" />
        )}
      </div>
    </div>
  )
}

function CommitDetailPane({ workspaceId, hash }: { workspaceId: string; hash: string }): React.JSX.Element {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<GitCommitFile | null>(null)
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.warp.git.commitDetail(workspaceId, hash).then(
      (d) => alive && setDetail(d),
      (e: unknown) => alive && setError(errorText(e))
    )
    return () => {
      alive = false
    }
  }, [workspaceId, hash])

  useEffect(() => {
    if (!file) return
    let alive = true
    setDiff(null)
    setDiffError(null)
    window.warp.git.commitFileDiff(workspaceId, hash, file.path, file.oldPath).then(
      (d) => alive && setDiff(d),
      (e: unknown) => alive && setDiffError(errorText(e))
    )
    return () => {
      alive = false
    }
  }, [workspaceId, hash, file])

  if (error) return <Empty icon={<Warning size={20} />} title="读取提交失败" body={error} danger />
  if (!detail) {
    return (
      <div className="flex flex-col gap-2 px-4 pt-4" aria-busy="true" aria-label="加载中">
        <span className="h-3 w-2/3 animate-pulse rounded-pill bg-raised motion-reduce:animate-none" />
        <span className="h-3 w-1/3 animate-pulse rounded-pill bg-raised motion-reduce:animate-none" />
      </div>
    )
  }
  const copy = (): void => {
    void window.warp.clipboard.write(detail.hash).catch((e: unknown) => notifyError(e, '复制失败'))
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="git-commit-detail">
      <div className="flex shrink-0 flex-col gap-1 border-b border-line px-4 py-3">
        <div className="text-[14px] font-semibold text-ink-strong" data-testid="git-commit-subject">
          {detail.subject || '（无标题）'}
        </div>
        {detail.body && <pre className="max-h-28 overflow-auto font-sans text-[13px] whitespace-pre-wrap wrap-anywhere text-ink">{detail.body}</pre>}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-muted">
          <span>
            {detail.author}
            {detail.email ? ` <${detail.email}>` : ''}
          </span>
          <span>· {new Date(detail.time).toLocaleString()}</span>
          {detail.parents.length > 1 && <span>· 合并提交（与第一父提交比较）</span>}
          <button
            type="button"
            onClick={copy}
            data-testid="git-copy-hash"
            title="复制完整哈希"
            className="inline-flex h-6 items-center gap-1 rounded-pill border border-line px-2 font-mono text-[12px] text-ink-strong transition-colors duration-150 hover:bg-raised"
          >
            <Copy size={12} aria-hidden="true" />
            {detail.shortHash}
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <ul role="list" aria-label="改动文件" className="w-[260px] shrink-0 overflow-y-auto border-r border-line py-1" data-testid="git-commit-files">
          {detail.files.length === 0 && <li className="px-3 py-1.5 text-[12px] text-ink-muted">这个提交没有文件改动</li>}
          {detail.files.map((f) => {
            const b = BADGE[f.status]
            const { name, dir } = splitPath(f.path)
            return (
              <li key={f.path}>
                <button
                  type="button"
                  data-commit-file={f.path}
                  onClick={() => setFile(f)}
                  title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                  className={`flex h-7 w-full items-center gap-2 px-3 text-left transition-colors duration-150 ${file?.path === f.path ? 'bg-accent-soft' : 'hover:bg-raised'}`}
                >
                  <span aria-label={b.label} title={b.label} className={`grid size-[18px] shrink-0 place-items-center rounded-badge border font-mono text-[12px] font-bold ${b.tone}`}>
                    {b.letter}
                  </span>
                  <span className="min-w-0 shrink truncate text-[13px] text-ink">{name}</span>
                  {dir && <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint">{dir}</span>}
                  {!f.binary && (
                    <span className="ml-auto shrink-0 font-mono text-[12px]">
                      <span className="text-live">+{f.added}</span> <span className="text-fault">−{f.removed}</span>
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
        <div className="flex min-w-0 flex-1 flex-col">
          {!file ? (
            <Empty icon={<GitDiffIcon size={20} />} title="选择文件查看这次提交的改动" body="点左侧的文件" />
          ) : diffError ? (
            <Empty icon={<Warning size={20} />} title="读取改动失败" body={diffError} danger />
          ) : !diff ? (
            <p className="px-3 pt-3 text-[12px] text-ink-muted">读取中…</p>
          ) : diff.binary ? (
            <Empty icon={<GitDiffIcon size={20} />} title="二进制文件" body="不显示二进制文件的改动" />
          ) : diff.tooLarge ? (
            <Empty icon={<Warning size={20} />} title="文件太大" body="改动超过 1MB 或 5000 行，请用编辑器查看" />
          ) : diff.hunks.length === 0 ? (
            <Empty icon={<GitDiffIcon size={20} />} title="没有文本改动" body="可能只改了文件权限" />
          ) : (
            <DiffBody diff={diff} />
          )}
        </div>
      </div>
    </div>
  )
}

function relTime(ms: number): string {
  if (!ms) return ''
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`
  return new Date(ms).toLocaleDateString()
}
