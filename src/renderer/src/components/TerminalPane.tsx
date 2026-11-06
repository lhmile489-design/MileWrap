import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowClockwise,
  ArrowDown,
  Broadcast,
  Broom,
  CornersIn,
  CornersOut,
  DotsThree,
  Export,
  GitBranch,
  MagnifyingGlass,
  NotePencil,
  Stop,
  TerminalWindow,
  Timer,
  X
} from '@phosphor-icons/react'
import { openMenuAt, type MenuItem } from './Menu'
import type { SessionMeta, Workspace } from '@shared/types'
import { useBranches } from '../store/branches'
import { useConfig } from '../store/config'
import { firstEmptyCell, useLayout, visibleCount } from '../store/layout'
import { useSessions } from '../store/sessions'
import { useUi } from '../store/ui'
import { useRestore } from '../store/restore'
import { useActivity } from '../store/activity'
import { RestoreCard } from './RestoreCard'
import { TerminalSearch } from './TerminalSearch'
import { terminals } from '../terminal/TerminalRegistry'
import { errorText } from '../lib/errors'
import { isLive, useUptime } from '../lib/time'
import { Button, IconButton, SessionIcon, StatusPill, WorkspaceIcon } from './ui'
import { closeSession, focusCell, openGitFor, openShellIn, openWorkspace, placeSession } from './actions'
import { DRAG_FILE, DRAG_SESSION, DRAG_WS, beginDrag, carries, draggingId, endDrag } from './rail/drag'
import { insertPath } from './fileActions'

/** zustand 5 的 selector 每次返回新 [] 会无限重渲染（React #185），空值必须是稳定引用 */
const NO_WORKSPACES: Workspace[] = []

/**
 * 终端格（UI设计约束 §4.2）。按格号从 layout.cells 取会话；空格显示空态。
 * xterm 实例由 TerminalRegistry 持有，这里只负责把它挂进宿主节点。
 * 整格是拖放目标：工作区拖进来 = 在此格打开；会话（子行或另一格的格头）拖进来 = 放到此格 / 两格互换。
 */
export function TerminalPane({ index }: { index: number }): React.JSX.Element {
  const sessionId = useLayout((s) => s.cells[index])
  const session = useSessions((s) => (sessionId ? s.sessions.find((x) => x.id === sessionId) : undefined))
  const focused = useLayout((s) => s.focused === index)
  const [dropOver, setDropOver] = useState(false)
  const broadcastOn = useUi((s) => s.broadcast)

  const accepts = (e: React.DragEvent): boolean =>
    carries(e, DRAG_WS) || (carries(e, DRAG_SESSION) && draggingId('session') !== sessionId) || (Boolean(sessionId) && carries(e, DRAG_FILE))

  return (
    <section
      data-cell={index}
      data-focused={focused || undefined}
      aria-label={`终端格 ${index + 1}`}
      onMouseDownCapture={() => {
        if (!focused) focusCell(index)
      }}
      onDragOver={(e) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!dropOver) setDropOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOver(false)
      }}
      onDrop={(e) => {
        setDropOver(false)
        const sid = e.dataTransfer.getData(DRAG_SESSION)
        const wid = e.dataTransfer.getData(DRAG_WS)
        const file = e.dataTransfer.getData(DRAG_FILE)
        if (file && sessionId) {
          e.preventDefault()
          const [fileWs, rel] = file.split('\n')
          void insertPath(fileWs, rel, sessionId)
          return
        }
        if (!sid && !wid) return
        e.preventDefault()
        if (sid) {
          placeSession(sid, index)
          return
        }
        const w = useConfig.getState().config?.workspaces.find((x) => x.id === wid)
        if (w) openWorkspace(w, index)
      }}
      className={`@container relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-card border bg-card transition-shadow duration-200 ${
        focused
          ? broadcastOn
            ? 'border-warn shadow-[0_0_0_1px_var(--signal-warn),var(--shadow-raise)]'
            : 'border-accent shadow-[0_0_0_1px_var(--signal-accent),var(--shadow-raise)]'
          : 'border-line shadow-[var(--shadow-lift-lg)]'
      }`}
    >
      {session ? <SessionView key={session.id} session={session} index={index} focused={focused} /> : <EmptyCell index={index} />}
      {dropOver && (
        <div aria-hidden="true" data-drop-hint className="pointer-events-none absolute inset-0 rounded-card border-2 border-dashed border-accent">
          <span className="absolute top-12 left-1/2 -translate-x-1/2 rounded-pill bg-accent px-3 py-0.5 text-[12px] font-semibold text-ink-inverse">
            放到此格
          </span>
        </div>
      )}
    </section>
  )
}

function SessionView({ session, index, focused }: { session: SessionMeta; index: number; focused: boolean }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const workspace = useConfig((s) => s.config?.workspaces.find((w) => w.id === session.workspaceId))
  const branch = useBranches((s) => s.branches[session.workspaceId])
  const gitEnabled = useConfig((s) => s.config?.settings.gitEnabled === true)
  const multi = useLayout((s) => visibleCount(s) > 1)
  const maximized = useLayout((s) => s.maximized === index)
  const toggleMaximize = useLayout((s) => s.toggleMaximize)
  const uptime = useUptime(session)
  const [error, setError] = useState<string | null>(null)
  const live = isLive(session)
  // 挂载时只有聚焦格抢键盘焦点；用 ref 读，避免聚焦变化导致重新挂载
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const attention = useActivity((s) => Boolean(s.attention[session.id]))
  const busy = useActivity((s) => s.state[session.id] === 'active')
  const broadcast = useUi((s) => s.broadcast)
  const excluded = useUi((s) => Boolean(s.broadcastExcluded[session.id]))
  const composerOpen = useUi((s) => s.composerCell === index)
  // 格头色带（升级建议 4.5）：所属分组的颜色
  const bandColor = useConfig((s) => {
    const gid = s.config?.workspaces.find((w) => w.id === session.workspaceId)?.groupId
    return gid ? (s.config?.groups.find((g) => g.id === gid)?.color ?? null) : null
  })
  const [scroll, setScroll] = useState({ atBottom: true, unseen: false })

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    terminals.mount(session.id, host)
    if (focusedRef.current) terminals.focus(session.id)
    const ro = new ResizeObserver(() => terminals.fit(session.id))
    ro.observe(host)
    return () => {
      ro.disconnect()
      terminals.unmount(session.id, host)
    }
  }, [session.id])

  // 重启后换了一代进程：清掉旧画面
  useEffect(() => {
    terminals.syncGen(session.id, session.gen)
  }, [session.id, session.gen])

  // 用户看到了（会话在聚焦格里）：清掉「等你处理」（升级建议 2.1）
  useEffect(() => {
    if (focused && attention) useActivity.getState().seen(session.id)
  }, [focused, attention, session.id])

  // 往上翻看历史时有新输出：右下角出现「新输出」按钮（升级建议 4.1）
  useEffect(() => terminals.onScroll(session.id, setScroll), [session.id])

  /** 导出终端内容（升级建议 4.3）：缓冲区文本已是纯文本，不解析内容 */
  const exportText = async (): Promise<void> => {
    setError(null)
    try {
      await window.warp.dialog.saveText(terminals.text(session.id), `${session.title}.txt`)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await fn()
      terminals.focus(session.id)
    } catch (e) {
      setError(errorText(e))
    }
  }

  /** 窄格里收起来的次要操作 */
  const moreMenu = (): MenuItem[] => [
    { label: `运行时长 ${uptime}`, icon: <Timer size={16} />, disabled: true, onSelect: () => undefined },
    { kind: 'separator' },
    { label: '重启', icon: <ArrowClockwise size={16} />, onSelect: () => void run(() => window.warp.session.restart(session.id)) },
    { label: '结束进程', icon: <Stop size={16} />, disabled: !live, onSelect: () => void run(() => window.warp.session.kill(session.id)) },
    { label: '清屏', icon: <Broom size={16} />, onSelect: () => terminals.clear(session.id) },
    { label: '在终端中搜索', icon: <MagnifyingGlass size={16} />, onSelect: () => useUi.getState().setSearchCell(index) },
    { kind: 'separator' },
    { label: '长文本输入', icon: <NotePencil size={16} />, disabled: !live, onSelect: () => useUi.getState().setComposerCell(index) },
    { label: '导出为文本', icon: <Export size={16} />, onSelect: () => void exportText() },
    ...(broadcast
      ? [{ label: excluded ? '加入广播' : '不参与广播', icon: <Broadcast size={16} />, onSelect: () => useUi.getState().toggleBroadcastExclude(session.id) }]
      : [])
  ]

  return (
    <>
      <header
        draggable={multi}
        onDragStart={(e) => {
          // 从按钮上拖不算换格
          if ((e.target as HTMLElement).closest('button')) {
            e.preventDefault()
            return
          }
          beginDrag(e, 'session', session.id)
        }}
        onDragEnd={endDrag}
        data-cell-head={index}
        className={`relative flex h-10 shrink-0 items-center gap-2 border-b border-line px-3 ${multi ? 'cursor-grab active:cursor-grabbing' : ''}`}
      >
        {bandColor && (
          <span aria-hidden="true" data-cell-band={bandColor} className="absolute top-0 right-0 left-0 h-0.5" style={{ backgroundColor: bandColor }} />
        )}
        <SessionIcon kind={session.kind} workspaceId={session.workspaceId} agentId={session.agentId} />
        <span className="min-w-0 shrink truncate text-[13px] font-semibold text-ink-strong">{session.title}</span>
        {attention && (
          <span role="img" aria-label="等你处理" title="等你处理" data-attention className="size-2 shrink-0 rounded-pill bg-accent" />
        )}
        {broadcast && !excluded && (
          <span data-broadcast-pill className="inline-flex h-6 shrink-0 items-center gap-1 rounded-pill border border-warn px-2 text-[12px] font-semibold text-warn">
            <Broadcast size={16} aria-hidden="true" />
            广播中
          </span>
        )}
        {branch &&
          (gitEnabled ? (
            // G-05：Git 管理打开时分支 pill 可点，右栏切到这个工作区的 Git 页签
            <button
              type="button"
              data-testid="cell-branch"
              aria-label={`分支 ${branch}，打开 Git 栏`}
              title="打开 Git 栏"
              onClick={() => openGitFor(session.workspaceId)}
              className="hidden h-6 min-w-0 shrink items-center gap-1 rounded-pill bg-raised px-2 text-[12px] text-ink-muted transition-colors duration-150 hover:text-ink-strong @min-[360px]:inline-flex"
            >
              <GitBranch size={12} aria-hidden="true" className="shrink-0" />
              <span className="truncate">{branch}</span>
            </button>
          ) : (
            <span className="hidden h-6 min-w-0 shrink items-center gap-1 rounded-pill bg-raised px-2 text-[12px] text-ink-muted @min-[360px]:inline-flex">
              <GitBranch size={12} aria-label="分支" className="shrink-0" />
              <span className="truncate">{branch}</span>
            </span>
          ))}
        <span className="hidden min-w-0 flex-1 truncate font-mono text-[12px] text-ink-faint @min-[480px]:block" title={session.cwd}>
          {session.cwd}
        </span>
        <span className="flex-1 @min-[480px]:hidden" />
        {/* 窄格（四宫格、小窗口）里依次收起：运行时长 → 状态文字 → 次要按钮进「⋯」菜单，保证标题不被挤没 */}
        <span className="hidden shrink-0 font-mono text-[12px] tabular-nums text-ink-muted @min-[440px]:inline">{uptime}</span>
        <StatusPill status={session.status} exitCode={session.exitCode} active={busy} compact />
        <div className="flex shrink-0 items-center">
          <span className="hidden items-center @min-[560px]:flex">
            <IconButton label="重启" onClick={() => void run(() => window.warp.session.restart(session.id))}>
              <ArrowClockwise size={16} />
            </IconButton>
            <IconButton label="结束进程" disabled={!live} onClick={() => void run(() => window.warp.session.kill(session.id))}>
              <Stop size={16} />
            </IconButton>
            <IconButton label="清屏" onClick={() => terminals.clear(session.id)}>
              <Broom size={16} />
            </IconButton>
          </span>
          <span className="flex">
            <IconButton label="更多操作" onClick={(e) => openMenuAt(e.currentTarget, moreMenu())}>
              <DotsThree size={16} />
            </IconButton>
          </span>
          {multi && (
            <IconButton label={maximized ? '还原' : '最大化'} pressed={maximized} onClick={() => toggleMaximize(index)}>
              {maximized ? <CornersIn size={16} /> : <CornersOut size={16} />}
            </IconButton>
          )}
          <IconButton label="关闭会话" onClick={() => void closeSession(session)}>
            <X size={16} />
          </IconButton>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1 bg-terminal" ref={hostRef} data-session-id={session.id} />
        {scroll.unseen && !scroll.atBottom && (
          <button
            type="button"
            data-scroll-bottom
            onClick={() => {
              terminals.scrollToBottom(session.id)
              terminals.focus(session.id)
            }}
            className="absolute right-4 bottom-3 z-10 inline-flex h-8 items-center gap-1.5 rounded-pill bg-accent px-3 text-[12px] font-semibold text-ink-inverse shadow-[var(--shadow-raise)] transition-transform duration-150 active:scale-[0.98]"
          >
            <ArrowDown size={16} aria-hidden="true" />
            新输出
          </button>
        )}
      </div>
      <TerminalSearch index={index} sessionId={session.id} />
      {composerOpen && live && <Composer sessionId={session.id} index={index} />}

      {error && (
        <div role="alert" className="border-t border-line px-3 py-2 text-[13px] text-fault">
          {error}
        </div>
      )}

      {!live && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-t border-line bg-sunken px-3">
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-muted">进程已退出，代码 {session.exitCode ?? '未知'}</span>
          <Button onClick={() => void run(() => window.warp.session.restart(session.id))}>
            <ArrowClockwise size={16} />
            重新启动
          </Button>
          {workspace && (
            <Button onClick={() => openShellIn(workspace.id, index)}>
              <TerminalWindow size={16} />
              打开 Shell
            </Button>
          )}
        </div>
      )}
    </>
  )
}

function EmptyCell({ index }: { index: number }): React.JSX.Element {
  const workspaces = useConfig((s) => s.config?.workspaces ?? NO_WORKSPACES)
  const openCreate = useUi((s) => s.openCreate)
  const recent = [...workspaces].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3)
  // 恢复卡片只放在第一个空的可见格里，避免四个空格各出现一张
  const firstEmpty = useLayout(firstEmptyCell)
  const hasCandidates = useRestore((s) => s.candidates.length > 0)

  // 四宫格里有几个空格时，只有第一个放完整卡片，其余只给一行提示，不再重复四遍同样的按钮
  if (firstEmpty !== index && workspaces.length > 0) {
    return (
      <div className="console-dots flex flex-1 flex-col items-center justify-center gap-3 p-6" data-empty-cell={index} data-compact>
        <p className="text-center text-[13px] text-ink-muted">空格 · 把工作区或会话拖到这里</p>
        <Button
          variant="ghost"
          onClick={() => {
            focusCell(index)
            useUi.getState().setPaletteOpen(true)
          }}
        >
          选择工作区…
        </Button>
      </div>
    )
  }

  return (
    <div className="console-dots flex flex-1 flex-col items-center justify-center gap-4 overflow-auto p-6" data-empty-cell={index}>
      {hasCandidates && firstEmpty === index && <RestoreCard />}
      <div className="flex w-full max-w-[360px] flex-col gap-4 rounded-card border border-line bg-card p-6 shadow-[var(--shadow-lift)]">
        <div className="font-display text-[15px] font-bold text-ink-strong">
          {workspaces.length ? '把工作区拖到这里，或从左侧选择' : '新建第一个工作区'}
        </div>
        {recent.length > 0 ? (
          <div className="flex flex-col gap-2">
            {recent.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => openWorkspace(w, index)}
                className="flex h-10 items-center gap-2 rounded-control border border-line px-3 text-left transition-colors duration-150 hover:bg-raised"
              >
                <WorkspaceIcon workspaceId={w.id} agentId={w.agentId} size={20} />
                <span className="truncate text-[13px] font-semibold text-ink-strong">{w.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-ink-muted">工作区保存项目目录和要启动的 agent，点一下就能在这里开终端。</p>
        )}
        <div>
          <Button variant={workspaces.length ? 'secondary' : 'primary'} onClick={() => openCreate(null)}>
            新建工作区
          </Button>
        </div>
      </div>
    </div>
  )
}

const HISTORY_KEY = 'mile-warp.composer-history'
const HISTORY_MAX = 20

function loadHistory(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, HISTORY_MAX) : []
  } catch {
    return []
  }
}

function pushHistory(text: string): void {
  const next = [text, ...loadHistory().filter((x) => x !== text)].slice(0, HISTORY_MAX)
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
  } catch {
    // 存不下就不存
  }
}

/**
 * 长文本输入框（升级建议 4.2，PRD Q10）：按格手动打开，发完自动收起，不抢终端焦点。
 * Ctrl+Enter 以 bracketed paste 粘贴后回车；「只粘贴」不回车。Ctrl+↑ / ↓ 翻最近 20 条历史。
 */
function Composer({ sessionId, index }: { sessionId: string; index: number }): React.JSX.Element {
  const [text, setText] = useState('')
  const [pos, setPos] = useState(-1)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  const close = (): void => {
    useUi.getState().setComposerCell(null)
    terminals.focus(sessionId)
  }
  const send = (enter: boolean): void => {
    const t = text.replace(/\r\n/g, '\n')
    if (!t.trim()) return
    pushHistory(t)
    terminals.paste(sessionId, t)
    // 粘贴和回车分开发：有的 agent 在同一块数据里收到回车会当成粘贴内容的一部分
    if (enter) window.setTimeout(() => window.warp.session.write(sessionId, '\r'), 30)
    close()
  }
  const browse = (dir: 1 | -1): void => {
    const h = loadHistory()
    const next = Math.max(-1, Math.min(h.length - 1, pos + dir))
    setPos(next)
    setText(next < 0 ? '' : h[next])
  }

  return (
    <div data-composer={index} className="flex shrink-0 flex-col gap-2 border-t border-line bg-sunken p-2">
      <textarea
        ref={ref}
        aria-label="长文本输入"
        rows={4}
        value={text}
        placeholder="多行提示词：Ctrl+Enter 发送，Esc 收起"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          } else if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault()
            send(true)
          } else if (e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault()
            browse(e.key === 'ArrowUp' ? 1 : -1)
          }
        }}
        className="w-full resize-y rounded-control border border-line bg-card px-3 py-2 font-mono text-[13px] text-ink-strong outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-accent"
      />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">Ctrl+Enter 发送 · Ctrl+↑ / ↓ 历史</span>
        <Button variant="ghost" onClick={close}>
          取消
        </Button>
        <Button onClick={() => send(false)}>只粘贴</Button>
        <Button variant="primary" onClick={() => send(true)} testId="composer-send">
          发送
        </Button>
      </div>
    </div>
  )
}
