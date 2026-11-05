import { memo, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowsClockwise, ArrowUUpLeft, CaretDown, CaretRight, Check, DotsThree, GitBranch, Minus, Plus, Sparkle, Warning } from '@phosphor-icons/react'
import type { GitDiff, GitFile, GitFileStatus } from '@shared/types'
import { useGit } from '../../store/git'
import { useSessions } from '../../store/sessions'
import { useActivity } from '../../store/activity'
import { useConfig } from '../../store/config'
import { errorText } from '../../lib/errors'
import { openMenu, openMenuAt, type MenuItem } from '../Menu'
import { IconButton, Button, WorkspaceIcon } from '../ui'

/** 状态徽标：字母 + 信号色 + title 文字，不只靠颜色（UI设计约束 §6） */
const BADGE: Record<GitFileStatus, { letter: string; label: string; tone: string }> = {
  added: { letter: 'A', label: '新增', tone: 'text-live border-live' },
  modified: { letter: 'M', label: '修改', tone: 'text-warn border-warn' },
  deleted: { letter: 'D', label: '删除', tone: 'text-fault border-fault' },
  renamed: { letter: 'R', label: '重命名', tone: 'text-accent border-accent' },
  untracked: { letter: 'U', label: '未跟踪', tone: 'text-idle border-idle' },
  conflict: { letter: '!', label: '冲突', tone: 'text-fault border-fault' }
}

const DRAFT_KEY = (id: string): string => `warp.commitDraft.${id}`
const EMPTY_FILES: GitFile[] = []

function splitPath(p: string): { name: string; dir: string } {
  const i = p.lastIndexOf('/')
  return i < 0 ? { name: p, dir: '' } : { name: p.slice(i + 1), dir: p.slice(0, i) }
}

/**
 * Git 栏（Git管理-PRD §3.2 / §4.1）：右栏「Git」页签的内容，整个文件是一个按需加载的 chunk。
 * 跟随会话栏选中的工作区；没有选中时保留上一个（G-03）。
 */
export function GitPanel(): React.JSX.Element {
  const selected = useSessions((s) => s.selectedWorkspaceId)
  const setWorkspace = useGit((s) => s.setWorkspace)
  const workspaceId = useGit((s) => s.workspaceId)
  const view = useGit((s) => s.view)

  useEffect(() => {
    if (selected) setWorkspace(selected)
  }, [selected, setWorkspace])

  // 打开栏位时强制刷新一次；之后焦点回来 / 页面重新可见时静默刷新（节流 2 秒，G-16）
  useEffect(() => {
    void useGit.getState().refresh({ force: true })
    const onFocus = (): void => void useGit.getState().refresh({ silent: true })
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') onFocus()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // 这个工作区里的会话从「对话中」转为安静 / 空闲：agent 大概改完了一轮，静默刷新
  useEffect(() => {
    return useActivity.subscribe((s, prev) => {
      const id = useGit.getState().workspaceId
      if (!id) return
      const sessions = useSessions.getState().sessions
      const done = sessions.some((x) => x.workspaceId === id && prev.state[x.id] === 'active' && s.state[x.id] !== 'active')
      if (done) void useGit.getState().refresh({ silent: true })
    })
  }, [])

  if (!workspaceId) {
    return <Empty icon={<GitBranch size={20} />} title="没有选中工作区" body="在会话栏选一个工作区，这里显示它所在仓库的改动" />
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="git-panel">
      <Header />
      {view.kind === 'diff' ? <DiffPane path={view.path} staged={view.staged} /> : <Body />}
    </div>
  )
}

function Header(): React.JSX.Element {
  const workspaceId = useGit((s) => s.workspaceId)
  const workspace = useConfig((s) => s.config?.workspaces.find((w) => w.id === workspaceId))
  const probe = useGit((s) => s.probe)
  const status = useGit((s) => s.status)
  const loading = useGit((s) => s.loading)
  const refresh = useGit((s) => s.refresh)
  const repo = probe && probe.available ? probe : null
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-line px-3 pt-2 pb-2">
      <div className="flex items-center gap-2">
        <WorkspaceIcon workspaceId={workspaceId} agentId={workspace?.agentId ?? 'shell'} size={20} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ink-strong" data-testid="git-workspace-name">
            {workspace?.name ?? ''}
          </div>
          {repo && (
            <div className="truncate font-mono text-[12px] text-ink-faint" title={repo.relativeDir ? `${repo.repoName}/${repo.relativeDir}` : repo.repoName}>
              {repo.repoName}
              {repo.relativeDir ? `/${repo.relativeDir}` : ''}
            </div>
          )}
        </div>
        <IconButton label="刷新" disabled={loading} onClick={() => void refresh({ force: true })}>
          <ArrowsClockwise size={16} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} />
        </IconButton>
      </div>
      {status && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-pill bg-raised px-2 text-[12px] text-ink-muted"
            title={status.upstream ? `上游 ${status.upstream}` : '没有上游分支'}
            data-testid="git-branch"
          >
            <GitBranch size={12} aria-hidden="true" className="shrink-0" />
            <span className="truncate">{status.detached ? `分离于 ${status.branch}` : status.branch}</span>
          </span>
          {status.ahead > 0 && <span className="text-[12px] text-ink-muted">领先 {status.ahead}</span>}
          {status.behind > 0 && <span className="text-[12px] text-ink-muted">落后 {status.behind}</span>}
        </div>
      )}
    </div>
  )
}

function Body(): React.JSX.Element {
  const probe = useGit((s) => s.probe)
  const status = useGit((s) => s.status)
  const error = useGit((s) => s.error)
  const files = status?.files ?? EMPTY_FILES

  if (error) {
    return <Empty icon={<Warning size={20} />} title="读取仓库失败" body={error} danger />
  }
  if (probe && !probe.available) {
    if (probe.reason === 'not-repo') return <Empty icon={<GitBranch size={20} />} title="这个工作区不是 git 仓库" body="工作区目录及其上级目录里都没有 .git" />
    if (probe.reason === 'no-git') return <Empty icon={<Warning size={20} />} title="找不到 git" body="PATH 里没有 git.exe，安装 Git for Windows 后点刷新" danger />
    if (probe.reason === 'disabled') return <Empty icon={<GitBranch size={20} />} title="未启用 Git 管理" body="在设置 → Git 里打开" />
    return <Empty icon={<Warning size={20} />} title="无法读取仓库" body={probe.reason === 'error' ? probe.message : ''} danger />
  }
  if (!status) {
    return (
      <div className="flex flex-col gap-2 px-3 pt-3" aria-busy="true" aria-label="加载中">
        <span className="h-3 w-3/4 animate-pulse rounded-pill bg-raised motion-reduce:animate-none" />
        <span className="h-3 w-1/2 animate-pulse rounded-pill bg-raised motion-reduce:animate-none" />
        <span className="h-3 w-2/3 animate-pulse rounded-pill bg-raised motion-reduce:animate-none" />
      </div>
    )
  }

  const staged = files.filter((f) => f.staged)
  const conflicts = files.filter((f) => !f.staged && f.status === 'conflict')
  const unstaged = [...conflicts, ...files.filter((f) => !f.staged && f.status !== 'conflict')]
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {conflicts.length > 0 && (
          <div role="alert" className="mx-3 mt-2 flex items-start gap-1.5 rounded-control border border-fault px-2 py-1.5 text-[12px] text-fault" data-testid="git-conflict-bar">
            <Warning size={16} aria-hidden="true" className="mt-px shrink-0" />
            <span>有 {conflicts.length} 个文件冲突，请在编辑器或让 agent 解决后再暂存</span>
          </div>
        )}
        {files.length === 0 ? (
          <Empty icon={<Sparkle size={20} />} title="工作区很干净" body="没有未提交的改动" />
        ) : (
          <>
            <Group title="已暂存" staged files={staged} />
            <Group title="未暂存" staged={false} files={unstaged} />
          </>
        )}
      </div>
      <CommitBox stagedCount={staged.length} />
    </div>
  )
}

function Group({ title, staged, files }: { title: string; staged: boolean; files: GitFile[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(true)
  const busy = useGit((s) => s.busy)
  const stage = useGit((s) => s.stage)
  const unstage = useGit((s) => s.unstage)
  const discard = useGit((s) => s.discard)
  if (files.length === 0) return null
  const all = files.map((f) => f.path)
  // 冲突文件也能暂存：这正是 git 里「标记为已解决」的做法
  const stageable = all
  return (
    <section aria-label={title} data-git-group={staged ? 'staged' : 'unstaged'} className="mt-2">
      <div className="flex h-7 items-center gap-1 pr-2 pl-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-control px-1 text-[12px] font-semibold text-ink-muted hover:text-ink-strong"
        >
          {open ? <CaretDown size={12} aria-hidden="true" /> : <CaretRight size={12} aria-hidden="true" />}
          <span>{title}</span>
          <span className="rounded-pill bg-raised px-1.5 text-[12px] text-ink-muted" data-testid="git-group-count">
            {files.length}
          </span>
        </button>
        {staged ? (
          <IconButton label="全部取消暂存" disabled={busy} onClick={() => void unstage([])}>
            <Minus size={16} />
          </IconButton>
        ) : (
          <>
            <IconButton label="全部丢弃" danger disabled={busy} onClick={() => void discard(all.filter((p) => files.find((f) => f.path === p)?.status !== 'conflict'))}>
              <ArrowUUpLeft size={16} />
            </IconButton>
            <IconButton label="全部暂存" disabled={busy} onClick={() => void stage(stageable)}>
              <Plus size={16} />
            </IconButton>
          </>
        )}
      </div>
      {open && (
        <ul role="list">
          {files.map((f) => (
            <FileRow key={`${staged ? 's' : 'u'}:${f.path}`} file={f} />
          ))}
        </ul>
      )}
    </section>
  )
}

const FileRow = memo(function FileRow({ file }: { file: GitFile }): React.JSX.Element {
  const busy = useGit((s) => s.busy)
  const openDiff = useGit((s) => s.openDiff)
  const stage = useGit((s) => s.stage)
  const unstage = useGit((s) => s.unstage)
  const { name, dir } = splitPath(file.path)
  const b = BADGE[file.status]
  const menu = (): MenuItem[] => fileMenu(file)
  return (
    <li
      className="group/row flex h-7 items-center gap-1 pr-2 pl-3 hover:bg-raised focus-within:bg-raised"
      data-git-file={file.path}
      data-git-staged={file.staged ? 'true' : 'false'}
      onContextMenu={(e) => openMenu(e, menu())}
    >
      <button type="button" onClick={() => openDiff(file.path, file.staged)} className="flex h-7 min-w-0 flex-1 items-center gap-2 text-left" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        <span
          aria-label={b.label}
          title={b.label}
          className={`grid size-[18px] shrink-0 place-items-center rounded-badge border font-mono text-[12px] font-bold ${b.tone}`}
          data-git-badge={b.letter}
        >
          {b.letter}
        </span>
        <span className="min-w-0 shrink truncate text-[13px] text-ink">{name}</span>
        {dir && <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint">{dir}</span>}
        {file.status === 'conflict' && <span className="shrink-0 text-[12px] font-semibold text-fault">冲突</span>}
      </button>
      {/* 行尾按钮：悬停或键盘聚焦到这一行时出现 */}
      <div className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
        <IconButton label="更多操作" onClick={(e) => openMenuAt(e.currentTarget, menu())}>
          <DotsThree size={16} />
        </IconButton>
        {file.staged ? (
          <IconButton label="取消暂存" disabled={busy} onClick={() => void unstage([file.path])}>
            <Minus size={16} />
          </IconButton>
        ) : (
          <IconButton label="暂存" disabled={busy} onClick={() => void stage([file.path])}>
            <Plus size={16} />
          </IconButton>
        )}
      </div>
    </li>
  )
})

function fileMenu(file: GitFile): MenuItem[] {
  const g = useGit.getState()
  const items: MenuItem[] = [{ label: '查看改动', onSelect: () => g.openDiff(file.path, file.staged) }]
  if (file.staged) items.push({ label: '取消暂存', onSelect: () => void g.unstage([file.path]) })
  else items.push({ label: '暂存', onSelect: () => void g.stage([file.path]) })
  items.push({ label: '复制路径', onSelect: () => void window.warp.clipboard.write(file.path) })
  if (!file.staged && file.status !== 'conflict') {
    items.push({ kind: 'separator' })
    items.push({ label: file.status === 'untracked' ? '删除文件…' : '丢弃改动…', danger: true, onSelect: () => void g.discard([file.path]) })
  }
  return items
}

function CommitBox({ stagedCount }: { stagedCount: number }): React.JSX.Element {
  const workspaceId = useGit((s) => s.workspaceId)
  const busy = useGit((s) => s.busy)
  const commit = useGit((s) => s.commit)
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [showDesc, setShowDesc] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const loadedFor = useRef<string | null>(null)

  // 草稿按工作区存 localStorage（G-15），切走再回来还在
  useEffect(() => {
    if (!workspaceId) return
    loadedFor.current = workspaceId
    let d: { summary?: string; description?: string } = {}
    try {
      d = JSON.parse(localStorage.getItem(DRAFT_KEY(workspaceId)) ?? '{}') as typeof d
    } catch {
      d = {}
    }
    setSummary(typeof d.summary === 'string' ? d.summary : '')
    setDescription(typeof d.description === 'string' ? d.description : '')
    setShowDesc(Boolean(d.description))
    setError(null)
  }, [workspaceId])
  useEffect(() => {
    if (!workspaceId || loadedFor.current !== workspaceId) return
    if (!summary && !description) localStorage.removeItem(DRAFT_KEY(workspaceId))
    else localStorage.setItem(DRAFT_KEY(workspaceId), JSON.stringify({ summary, description }))
  }, [workspaceId, summary, description])

  const disabledReason = stagedCount === 0 ? '暂存区为空：先暂存要提交的文件' : !summary.trim() ? '填写提交摘要' : null
  const submit = async (): Promise<void> => {
    if (disabledReason || busy) return
    setError(null)
    try {
      await commit(summary.trim(), description)
      setSummary('')
      setDescription('')
      setShowDesc(false)
      setDone(true)
      window.setTimeout(() => setDone(false), 600)
    } catch (e) {
      setError(errorText(e))
    }
  }
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-line px-3 pt-2 pb-3" data-testid="git-commit-box">
      <div className="flex items-center gap-1">
        <input
          aria-label="提交摘要"
          data-testid="git-commit-summary"
          value={summary}
          maxLength={200}
          placeholder="提交摘要（Ctrl+Enter 提交）"
          onChange={(e) => setSummary(e.target.value.replace(/[\r\n]/g, ' '))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.ctrlKey) {
              e.preventDefault()
              void submit()
            } else onKey(e)
          }}
          className="h-8 min-w-0 flex-1 rounded-control border border-line bg-card px-2 text-[13px] text-ink-strong outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-accent"
        />
        <IconButton label={showDesc ? '收起描述' : '添加描述'} pressed={showDesc} onClick={() => setShowDesc(!showDesc)}>
          {showDesc ? <CaretDown size={16} /> : <CaretRight size={16} />}
        </IconButton>
      </div>
      {showDesc && (
        <textarea
          aria-label="提交描述"
          data-testid="git-commit-description"
          value={description}
          rows={3}
          placeholder="详细描述（可选）"
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={onKey}
          className="min-h-16 resize-y rounded-control border border-line bg-card px-2 py-1.5 text-[13px] text-ink-strong outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-accent"
        />
      )}
      <Button variant="primary" disabled={Boolean(disabledReason) || busy} onClick={() => void submit()} testId="git-commit-button">
        {done ? (
          <>
            <Check size={16} aria-hidden="true" />
            已提交
          </>
        ) : (
          `提交 ${stagedCount} 个文件`
        )}
      </Button>
      {disabledReason && !error && <p className="text-[12px] text-ink-muted" data-testid="git-commit-hint">{disabledReason}</p>}
      {error && (
        <pre role="alert" data-testid="git-commit-error" className="max-h-40 overflow-auto whitespace-pre-wrap wrap-anywhere rounded-control bg-sunken px-2 py-1.5 font-mono text-[12px] text-fault">
          {error}
        </pre>
      )}
    </div>
  )
}

function DiffPane({ path, staged }: { path: string; staged: boolean }): React.JSX.Element {
  const diff = useGit((s) => s.diff)
  const diffError = useGit((s) => s.diffError)
  const busy = useGit((s) => s.busy)
  const backToList = useGit((s) => s.backToList)
  const stage = useGit((s) => s.stage)
  const unstage = useGit((s) => s.unstage)
  const { name } = splitPath(path)
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="git-diff">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line pr-2 pl-1">
        <IconButton label="返回改动列表" onClick={backToList}>
          <ArrowLeft size={16} />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink-strong" title={path}>
          {name}
          <span className="ml-1 font-normal text-ink-faint">{staged ? '已暂存' : '未暂存'}</span>
        </span>
        {diff && !diff.binary && !diff.tooLarge && (
          <span className="shrink-0 font-mono text-[12px]" data-testid="git-diff-stat">
            <span className="text-live">+{diff.added}</span> <span className="text-fault">−{diff.removed}</span>
          </span>
        )}
        {staged ? (
          <IconButton label="取消暂存" disabled={busy} onClick={() => void unstage([path], true)}>
            <Minus size={16} />
          </IconButton>
        ) : (
          <IconButton label="暂存" disabled={busy} onClick={() => void stage([path], true)}>
            <Plus size={16} />
          </IconButton>
        )}
      </div>
      {diffError ? (
        <Empty icon={<Warning size={20} />} title="读取改动失败" body={diffError} danger />
      ) : !diff ? (
        <div className="flex flex-col gap-2 px-3 pt-3" aria-busy="true" aria-label="加载中">
          <span className="h-3 w-3/4 animate-pulse rounded-pill bg-raised motion-reduce:animate-none" />
          <span className="h-3 w-1/2 animate-pulse rounded-pill bg-raised motion-reduce:animate-none" />
        </div>
      ) : diff.binary ? (
        <Empty icon={<GitBranch size={20} />} title="二进制文件" body="不显示二进制文件的改动" />
      ) : diff.tooLarge ? (
        <Empty icon={<Warning size={20} />} title="文件太大" body="改动超过 1MB 或 5000 行，请用编辑器查看" />
      ) : diff.hunks.length === 0 ? (
        <Empty icon={<GitBranch size={20} />} title="没有文本改动" body="可能只改了文件权限，或是空文件" />
      ) : (
        <DiffBody diff={diff} />
      )}
    </div>
  )
}

const LINE_TONE = { added: 'bg-live/10', removed: 'bg-fault/10', context: '' } as const
const SIGN = { added: '+', removed: '−', context: ' ' } as const

const DiffBody = memo(function DiffBody({ diff }: { diff: GitDiff }): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-sunken font-mono text-[12px] leading-[1.6]" data-testid="git-diff-body">
      {diff.hunks.map((h, i) => (
        <div key={i}>
          <div className="sticky top-0 border-y border-line bg-raised px-2 text-ink-muted">{h.header}</div>
          {h.lines.map((l, j) => (
            <div key={j} className={`flex ${LINE_TONE[l.type]}`} data-diff-line={l.type}>
              <span className="w-10 shrink-0 pr-1 text-right text-ink-faint select-none">{l.oldNo ?? ''}</span>
              <span className="w-10 shrink-0 pr-1 text-right text-ink-faint select-none">{l.newNo ?? ''}</span>
              <span className={`w-4 shrink-0 text-center select-none ${l.type === 'added' ? 'text-live' : l.type === 'removed' ? 'text-fault' : 'text-ink-faint'}`}>{SIGN[l.type]}</span>
              <span className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere text-ink">{l.content}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
})

function Empty({ icon, title, body, danger = false }: { icon: React.ReactNode; title: string; body: string; danger?: boolean }): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-1.5 px-3 pt-4" data-testid="git-empty">
      <span className={`flex items-center gap-1.5 text-[13px] font-semibold ${danger ? 'text-fault' : 'text-ink-strong'}`}>
        <span aria-hidden="true" className={danger ? 'text-fault' : 'text-ink-muted'}>
          {icon}
        </span>
        {title}
      </span>
      <span className="text-[12px] text-ink-muted">{body}</span>
    </div>
  )
}
