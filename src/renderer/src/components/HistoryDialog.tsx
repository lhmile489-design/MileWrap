import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowCounterClockwise,
  ArrowClockwise,
  Copy,
  DownloadSimple,
  FolderDashed,
  FolderOpen,
  FolderSimple,
  MagnifyingGlass,
  Play,
  Stack,
  Warning,
  Wrench,
  X
} from '@phosphor-icons/react'
import type { HistoryAgent, HistoryExportFormat, HistoryItem, HistoryListResult, HistoryMessage, SessionMeta, Workspace } from '@shared/types'
import { dirKey, winPath } from '@shared/path'
import { useConfig } from '../store/config'
import { useSessions } from '../store/sessions'
import { useUi } from '../store/ui'
import { useOverlay } from '../lib/useOverlay'
import { agentName } from '../lib/agents'
import { errorText } from '../lib/errors'
import { isLive } from '../lib/time'
import { AgentBadge, Button, IconButton } from './ui'
import { confirm, notifyError } from './ConfirmDialog'
import { openMenuAt } from './Menu'
import { placeSession, showSession } from './actions'

const AGENTS: HistoryAgent[] = ['claude', 'codex', 'kimi', 'pi']
const NO_WORKSPACES: Workspace[] = []
/** 列表分批渲染（不引入虚拟滚动库，参考目录栏每批 300 项） */
const BATCH = 200
const ALL = '*'

type Dir = { key: string; cwd: string; label: string; count: number; workspace: boolean }
type Detail = { id: string; tools: boolean; messages: HistoryMessage[]; truncated: boolean; loading: boolean; error: string | null }

function formatTime(t: number): string {
  if (!t) return ''
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function baseName(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

/** 左栏：先列已有工作区的目录（同目录多个工作区合成一项），再列「其他目录」（在 Warp 外面开的会话） */
function buildDirs(items: HistoryItem[], workspaces: Workspace[]): { ws: Dir[]; others: Dir[] } {
  const counts = new Map<string, { n: number; cwd: string; latest: number }>()
  for (const it of items) {
    const k = dirKey(it.cwd)
    const c = counts.get(k)
    if (c) {
      c.n++
      c.latest = Math.max(c.latest, it.updatedAt)
    } else counts.set(k, { n: 1, cwd: it.cwd, latest: it.updatedAt })
  }
  const wsMap = new Map<string, Dir>()
  for (const w of [...workspaces].sort((a, b) => a.order - b.order)) {
    const k = dirKey(w.cwd)
    const hit = wsMap.get(k)
    if (hit) hit.label += ` / ${w.name}`
    else wsMap.set(k, { key: k, cwd: w.cwd, label: w.name, count: counts.get(k)?.n ?? 0, workspace: true })
  }
  const others = [...counts.entries()]
    .filter(([k]) => !wsMap.has(k))
    .sort((a, b) => b[1].latest - a[1].latest)
    .map(([k, c]) => ({ key: k, cwd: c.cwd, label: baseName(c.cwd), count: c.n, workspace: false }))
  return { ws: [...wsMap.values()], others }
}

/**
 * 续接一段历史对话：已在 Warp 里运行就切过去；没有对应工作区时确认后新建一个（未分组），再续接。
 * 续接到当前聚焦格（会话管理升级计划 §3.4）。返回是否已打开。
 */
async function resumeHistory(item: HistoryItem): Promise<boolean> {
  const liveOf = (): SessionMeta | undefined => useSessions.getState().sessions.find((s) => s.resumeId === item.sessionId && isLive(s))
  const live = liveOf()
  if (live) {
    showSession(live)
    return true
  }
  let r = await window.warp.history.resume(item.historyId)
  if (!r.ok && r.needWorkspace) {
    const name = baseName(item.cwd)
    const ok = await confirm({
      title: '新建工作区并续接？',
      body: `「${winPath(item.cwd)}」下还没有 ${agentName(item.agentId)} 的工作区。会新建一个名为「${name}」的工作区（放在未分组），然后续接这段对话。`,
      okLabel: '新建并续接'
    })
    if (!ok) return false
    await useConfig.getState().createWorkspace({ name, agentId: item.agentId, cwd: winPath(item.cwd), argsText: '', note: '', groupId: null })
    const ws = useConfig.getState().config?.workspaces.find((w) => w.agentId === item.agentId && dirKey(w.cwd) === dirKey(item.cwd))
    if (!ws) throw new Error('新建工作区失败')
    r = await window.warp.history.resume(item.historyId, ws.id)
  }
  if (r.ok) {
    useSessions.getState().adopt(r.session)
    placeSession(r.session.id)
    return true
  }
  const again = r.running ? liveOf() : undefined
  if (again) {
    showSession(again)
    return true
  }
  throw new Error(r.reason)
}

/** 会话历史（会话管理升级计划 §3.5）：左目录、中列表、右预览。只读：看、搜、续接、导出 */
export function HistoryDialog(): React.JSX.Element | null {
  const state = useUi((s) => s.history)
  const close = useUi((s) => s.closeHistory)
  if (!state) return null
  return <Panel initialCwd={state.cwd} onClose={close} />
}

function Panel({ initialCwd, onClose }: { initialCwd: string | null; onClose: () => void }): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlay(panelRef, onClose)
  const workspaces = useConfig((s) => s.config?.workspaces) ?? NO_WORKSPACES
  const sessions = useSessions((s) => s.sessions)

  const [data, setData] = useState<HistoryListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [dir, setDir] = useState<string>(initialCwd ? dirKey(initialCwd) : ALL)
  const [query, setQuery] = useState('')
  const [agent, setAgent] = useState<HistoryAgent | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [shown, setShown] = useState(BATCH)
  const [tools, setTools] = useState(false)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const reqRef = useRef(0)

  const load = async (): Promise<void> => {
    setLoading(true)
    setListError(null)
    try {
      setData(await window.warp.history.list())
    } catch (e) {
      setListError(errorText(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    panelRef.current?.querySelector<HTMLInputElement>('[data-testid="history-search"]')?.focus()
  }, [])

  const items = data?.items
  const dirs = useMemo(() => buildDirs(items ?? [], workspaces), [items, workspaces])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (items ?? []).filter(
      (it) =>
        (dir === ALL || dirKey(it.cwd) === dir) &&
        (!agent || it.agentId === agent) &&
        (!q || `${it.title}\n${it.summary}\n${it.sessionId}\n${it.cwd}`.toLowerCase().includes(q))
    )
  }, [items, dir, agent, query])
  const agentCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const it of items ?? []) if (dir === ALL || dirKey(it.cwd) === dir) m[it.agentId] = (m[it.agentId] ?? 0) + 1
    return m
  }, [items, dir])

  // 换目录 / 筛选后回到第一批；选中项不在结果里就选第一条
  useEffect(() => setShown(BATCH), [dir, agent, query])
  useEffect(() => {
    if (!filtered.length) setSelected(null)
    else if (!selected || !filtered.some((x) => x.historyId === selected)) setSelected(filtered[0].historyId)
  }, [filtered, selected])

  const item = filtered.find((x) => x.historyId === selected) ?? null
  // 列表里的 running 是读列表那一刻的；之后在 Warp 里开 / 关了会话，以当前会话列表为准
  const liveIds = useMemo(() => new Set(sessions.filter(isLive).map((s) => s.resumeId).filter(Boolean)), [sessions])
  const running = (it: HistoryItem): boolean => liveIds.has(it.sessionId)

  const fetchPage = async (id: string, withTools: boolean, offset: number): Promise<void> => {
    const token = ++reqRef.current
    setDetail((d) => (offset > 0 && d && d.id === id ? { ...d, loading: true } : { id, tools: withTools, messages: [], truncated: false, loading: true, error: null }))
    try {
      const page = await window.warp.history.detail(id, offset, withTools)
      if (token !== reqRef.current) return
      setDetail((d) => ({
        id,
        tools: withTools,
        messages: offset > 0 && d && d.id === id ? [...d.messages, ...page.messages] : page.messages,
        truncated: page.truncated,
        loading: false,
        error: null
      }))
    } catch (e) {
      if (token !== reqRef.current) return
      setDetail((d) => ({ id, tools: withTools, messages: d && d.id === id ? d.messages : [], truncated: false, loading: false, error: errorText(e) }))
    }
  }

  useEffect(() => {
    setStatus(null)
    if (selected) void fetchPage(selected, tools, 0)
    else setDetail(null)
  }, [selected, tools])

  const doResume = async (it: HistoryItem): Promise<void> => {
    setBusy(true)
    try {
      if (await resumeHistory(it)) onClose()
    } catch (e) {
      notifyError(e, '续接失败')
    } finally {
      setBusy(false)
    }
  }

  const doExport = async (it: HistoryItem, format: HistoryExportFormat, withTools = false): Promise<void> => {
    try {
      const path = await window.warp.history.export(it.historyId, format, withTools)
      if (path) setStatus(`已导出到 ${path}`)
    } catch (e) {
      notifyError(e, '导出失败')
    }
  }

  const exportMenu = (el: HTMLElement, it: HistoryItem): void =>
    openMenuAt(el, [
      { label: 'Markdown', icon: <DownloadSimple size={16} />, onSelect: () => void doExport(it, 'markdown') },
      { label: 'Markdown（含工具输出）', icon: <DownloadSimple size={16} />, onSelect: () => void doExport(it, 'markdown', true) },
      { label: 'JSON', icon: <DownloadSimple size={16} />, onSelect: () => void doExport(it, 'json') },
      { label: '原始文件', icon: <DownloadSimple size={16} />, onSelect: () => void doExport(it, 'raw') }
    ])

  /** 列表里上下键换选中项，焦点跟着走 */
  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const visible = filtered.slice(0, shown)
    const i = visible.findIndex((x) => x.historyId === selected)
    const next = visible[Math.max(0, Math.min(visible.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (!next) return
    setSelected(next.historyId)
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(`[data-history-item="${next.historyId}"]`)?.focus())
  }

  const total = items?.length ?? 0
  const dirButton = (d: { key: string; label: string; title: string; count: number; icon: React.ReactNode }): React.JSX.Element => (
    <button
      key={d.key}
      type="button"
      data-history-dir={d.key}
      aria-pressed={dir === d.key}
      title={d.title}
      onClick={() => setDir(d.key)}
      className={`flex h-8 w-full shrink-0 items-center gap-2 rounded-control px-2 text-left text-[13px] transition-colors duration-150 ${
        dir === d.key ? 'bg-accent-soft font-semibold text-ink-strong' : 'text-ink hover:bg-raised'
      }`}
    >
      <span className="shrink-0 text-ink-muted">{d.icon}</span>
      <span className="min-w-0 flex-1 truncate">{d.label}</span>
      <span className="shrink-0 text-[12px] text-ink-muted">{d.count}</span>
    </button>
  )

  return (
    <div className="dialog-backdrop fixed inset-0 z-40 grid place-items-center" onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
        data-testid="history-dialog"
        className="flex h-[min(720px,calc(100vh-64px))] w-[1120px] max-w-[calc(100vw-48px)] flex-col rounded-card border border-line bg-card shadow-[var(--shadow-float)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-5">
          <h2 id="history-title" className="font-display text-[15px] font-bold text-ink-strong">
            会话历史
          </h2>
          <span className="text-[12px] text-ink-muted">{loading && !data ? '正在读取…' : `共 ${total} 段对话`}</span>
          <div className="flex-1" />
          <IconButton label="重新读取" disabled={loading} onClick={() => void load()}>
            <ArrowClockwise size={16} />
          </IconButton>
          <IconButton label="关闭" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        {(listError || (data?.failed.length ?? 0) > 0) && (
          <div role="alert" data-testid="history-failed" className="flex shrink-0 items-start gap-2 border-b border-line px-5 py-2 text-[12px] text-warn">
            <Warning size={16} aria-hidden="true" className="mt-px shrink-0" />
            <span className="min-w-0">
              {listError ? `读取失败：${listError}` : data?.failed.map((f) => `${agentName(f.agentId)} 读取失败：${f.reason}`).join('；')}
            </span>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          {/* 左：目录 */}
          <nav aria-label="按目录筛选" className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-2">
            {dirButton({ key: ALL, label: '全部目录', title: '全部目录', count: total, icon: <Stack size={16} /> })}
            {dirs.ws.length > 0 && <div className="px-2 pt-3 pb-1 text-[12px] font-semibold text-ink-muted">工作区</div>}
            {dirs.ws.map((d) => dirButton({ key: d.key, label: d.label, title: winPath(d.cwd), count: d.count, icon: <FolderSimple size={16} /> }))}
            {dirs.others.length > 0 && <div className="px-2 pt-3 pb-1 text-[12px] font-semibold text-ink-muted">其他目录</div>}
            {dirs.others.map((d) => dirButton({ key: d.key, label: d.label, title: winPath(d.cwd), count: d.count, icon: <FolderDashed size={16} /> }))}
          </nav>

          {/* 中：会话列表 */}
          <div className="flex w-[340px] shrink-0 flex-col border-r border-line">
            <div className="flex shrink-0 flex-col gap-2 border-b border-line p-3">
              <label className="flex h-8 items-center gap-2 rounded-control border border-line bg-sunken px-2 focus-within:border-accent">
                <MagnifyingGlass size={16} aria-hidden="true" className="shrink-0 text-ink-faint" />
                <input
                  data-testid="history-search"
                  aria-label="搜索标题、首条消息、会话 ID"
                  placeholder="搜索标题、首条消息、会话 ID"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-ink-strong outline-none placeholder:text-ink-faint"
                />
              </label>
              <div role="group" aria-label="按 agent 筛选" className="flex flex-wrap gap-1">
                {[null, ...AGENTS].map((a) => (
                  <button
                    key={a ?? 'all'}
                    type="button"
                    data-history-agent={a ?? 'all'}
                    aria-pressed={agent === a}
                    onClick={() => setAgent(a)}
                    className={`inline-flex h-6 items-center gap-1 rounded-pill border px-2 text-[12px] font-semibold transition-colors duration-150 ${
                      agent === a ? 'border-accent bg-accent-soft text-ink-strong' : 'border-line text-ink-muted hover:bg-raised'
                    }`}
                  >
                    {a ? agentName(a).split(' ')[0] : '全部'}
                    <span className="font-normal">{a ? (agentCounts[a] ?? 0) : Object.values(agentCounts).reduce((n, x) => n + x, 0)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div role="listbox" aria-label="会话" data-testid="history-list" className="min-h-0 flex-1 overflow-y-auto p-2" onKeyDown={onListKey}>
              {loading && !data && <p className="px-2 py-6 text-center text-[13px] text-ink-muted">正在读取各 agent 的会话…</p>}
              {data && filtered.length === 0 && <p className="px-2 py-6 text-center text-[13px] text-ink-muted">没有匹配的会话</p>}
              {filtered.slice(0, shown).map((it) => {
                const on = it.historyId === selected
                return (
                  <button
                    key={it.historyId}
                    type="button"
                    role="option"
                    aria-selected={on}
                    data-history-item={it.historyId}
                    tabIndex={on ? 0 : -1}
                    onClick={() => setSelected(it.historyId)}
                    onDoubleClick={() => void doResume(it)}
                    className={`flex w-full items-start gap-2 rounded-control px-2 py-2 text-left transition-colors duration-150 ${on ? 'bg-accent-soft' : 'hover:bg-raised'}`}
                  >
                    <AgentBadge agentId={it.agentId} size={20} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[13px] font-semibold text-ink-strong">{it.title}</span>
                      {it.summary && it.summary !== it.title && <span className="truncate text-[12px] text-ink-muted">{it.summary}</span>}
                      <span className="flex items-center gap-2 text-[12px] text-ink-faint">
                        <span>{formatTime(it.updatedAt)}</span>
                        <span>{formatSize(it.size)}</span>
                        {dir === ALL && <span className="min-w-0 truncate">{baseName(it.cwd)}</span>}
                        {running(it) && (
                          <span className="inline-flex shrink-0 items-center gap-1 font-semibold text-live">
                            <Play size={12} weight="fill" aria-hidden="true" />
                            运行中
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                )
              })}
              {filtered.length > shown && (
                <button
                  type="button"
                  data-testid="history-more-items"
                  onClick={() => setShown((n) => n + BATCH)}
                  className="mt-1 h-8 w-full rounded-control text-[13px] font-semibold text-accent hover:bg-raised"
                >
                  再显示 {Math.min(BATCH, filtered.length - shown)} 条（还有 {filtered.length - shown} 条）
                </button>
              )}
            </div>
          </div>

          {/* 右：预览 */}
          <section aria-label="对话预览" data-testid="history-preview" className="flex min-w-0 flex-1 flex-col">
            {!item ? (
              <p className="m-auto text-[13px] text-ink-muted">{loading ? '' : '选一段对话查看'}</p>
            ) : (
              <>
                <div className="flex shrink-0 flex-col gap-2 border-b border-line p-4">
                  <div className="flex items-start gap-2">
                    <AgentBadge agentId={item.agentId} size={24} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-bold text-ink-strong" title={item.title}>
                        {item.title}
                      </div>
                      <div className="truncate font-mono text-[12px] text-ink-muted" title={winPath(item.cwd)}>
                        {agentName(item.agentId)} · {winPath(item.cwd)}
                      </div>
                      <div className="truncate font-mono text-[12px] text-ink-faint">
                        {item.sessionId} · 创建 {formatTime(item.createdAt)} · 更新 {formatTime(item.updatedAt)}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="primary" disabled={busy} onClick={() => void doResume(item)} testId="history-resume">
                      <ArrowCounterClockwise size={16} aria-hidden="true" />
                      {running(item) ? '切到这个会话' : '续接到当前格'}
                    </Button>
                    <button
                      type="button"
                      data-testid="history-export"
                      onClick={(e) => exportMenu(e.currentTarget, item)}
                      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control border border-line-strong bg-card px-3 text-[13px] font-semibold text-ink-strong transition-colors duration-150 hover:bg-raised"
                    >
                      <DownloadSimple size={16} aria-hidden="true" />
                      导出…
                    </button>
                    <IconButton label="复制会话 ID" onClick={() => void window.warp.clipboard.write(item.sessionId).then(() => setStatus('已复制会话 ID'))}>
                      <Copy size={16} />
                    </IconButton>
                    <IconButton label="在资源管理器中显示" onClick={() => void window.warp.history.reveal(item.historyId).catch((e: unknown) => notifyError(e, '打开失败'))}>
                      <FolderOpen size={16} />
                    </IconButton>
                    <div className="flex-1" />
                    <label className="inline-flex shrink-0 items-center gap-1.5 text-[12px] text-ink-muted">
                      <input
                        type="checkbox"
                        data-testid="history-tools"
                        checked={tools}
                        onChange={(e) => setTools(e.target.checked)}
                        className="size-4 accent-[var(--signal-accent)]"
                      />
                      显示工具调用
                    </label>
                  </div>
                  {status && (
                    <p role="status" className="truncate text-[12px] text-live" title={status}>
                      {status}
                    </p>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="history-messages">
                  {detail?.error && (
                    <p role="alert" className="text-[13px] text-fault">
                      {detail.error}
                    </p>
                  )}
                  {detail && !detail.loading && !detail.error && detail.messages.length === 0 && (
                    <p className="text-[13px] text-ink-muted">这段会话里没有可显示的对话</p>
                  )}
                  <div className="flex flex-col gap-3">
                    {detail?.messages.map((m, i) => <MessageView key={i} m={m} />)}
                  </div>
                  {detail?.loading && <p className="py-3 text-[13px] text-ink-muted">正在读取…</p>}
                  {detail && detail.truncated && !detail.loading && (
                    <button
                      type="button"
                      data-testid="history-more"
                      onClick={() => void fetchPage(detail.id, detail.tools, detail.messages.length)}
                      className="mt-3 h-8 w-full rounded-control border border-line text-[13px] font-semibold text-accent hover:bg-raised"
                    >
                      继续加载
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

const ROLE_LABEL: Record<HistoryMessage['role'], string> = { user: '用户', assistant: 'Assistant', tool: '工具调用' }

function MessageView({ m }: { m: HistoryMessage }): React.JSX.Element {
  if (m.role === 'tool') {
    return (
      <div data-history-msg="tool" className="flex items-start gap-2 font-mono text-[12px] text-ink-muted">
        <Wrench size={16} aria-hidden="true" className="shrink-0" />
        <span className="sr-only">{ROLE_LABEL.tool}</span>
        <span className="min-w-0 break-words whitespace-pre-wrap">{m.text}</span>
      </div>
    )
  }
  return (
    <div data-history-msg={m.role} className={`flex flex-col gap-1 ${m.role === 'user' ? 'rounded-control bg-raised px-3 py-2' : ''}`}>
      <div className="flex items-center gap-2 text-[12px] font-semibold text-ink-muted">
        {ROLE_LABEL[m.role]}
        {m.time && <span className="font-normal text-ink-faint">{formatTime(m.time)}</span>}
      </div>
      <div className="break-words whitespace-pre-wrap text-[13px] text-ink">{m.text}</div>
    </div>
  )
}
