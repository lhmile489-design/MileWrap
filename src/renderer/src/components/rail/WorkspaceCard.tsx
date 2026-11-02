import { useState } from 'react'
import { GitBranch } from '@phosphor-icons/react'
import type { SessionMeta, Workspace } from '@shared/types'
import { useBranches } from '../../store/branches'
import { cellOf, useLayout } from '../../store/layout'
import { useSessions } from '../../store/sessions'
import { useUi } from '../../store/ui'
import { useActivity } from '../../store/activity'
import { agentName } from '../../lib/agents'
import { isLive, useUptime } from '../../lib/time'
import { openWorkspace, sessionMenu, showSession, workspaceMenu } from '../actions'
import { notifyError } from '../ConfirmDialog'
import { InlineEdit } from '../InlineEdit'
import { openMenu, openMenuAt } from '../Menu'
import { StatusIcon, WorkspaceIcon, statusText, type DisplayStatus } from '../ui'
import { DRAG_WS, beginDrag, carries, draggingId, dropSide, endDrag, placeWorkspace, type DropAt } from './drag'

/** 工作区卡片的状态：有活着的会话算运行中，否则看最近结束的会话，没有会话算未启动 */
export function workspaceStatus(list: SessionMeta[]): { status: DisplayStatus; exitCode: number | null } {
  if (list.length === 0) return { status: 'idle', exitCode: null }
  const live = list.find(isLive)
  if (live) return { status: live.status, exitCode: null }
  const last = [...list].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]
  return { status: last.status, exitCode: last.exitCode }
}

export function lastSegment(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** 菜单键 / Shift+F10 打开右键菜单（键盘可达，UI设计约束 §6） */
function isMenuKey(e: React.KeyboardEvent): boolean {
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')
}

/**
 * 工作区卡片（UI设计约束 §4.1）：48px。左徽章，右上状态 + 名称，右下分支（非 git 显示备注 / 目录末段），
 * 最右格号小标与会话数胶囊。2 个及以上会话时胶囊可展开会话子行。
 */
export function WorkspaceCard({ w, list, filtering }: { w: Workspace; list: SessionMeta[]; filtering: boolean }): React.JSX.Element {
  const selected = useSessions((s) => s.selectedWorkspaceId === w.id)
  // 该工作区的会话显示在哪几格；拼成字符串，选择器才返回原始值（数组每次都是新引用，会无限重渲染）
  const cellKey = useLayout((s) =>
    list
      .map((x) => cellOf(s, x.id))
      .filter((i) => i >= 0)
      .sort()
      .join(',')
  )
  const branch = useBranches((s) => s.branches[w.id])
  const expandedFlag = useUi((s) => s.expanded[w.id])
  const setExpanded = useUi((s) => s.setExpanded)
  // 该工作区有会话跑完一轮在等用户（升级建议 2.1）；选择器只返回布尔值
  const attention = useActivity((s) => list.some((x) => Boolean(s.attention[x.id])))
  // 有任一活着的会话正在输出 = 对话中
  const busy = useActivity((s) => list.some((x) => isLive(x) && s.state[x.id] === 'active'))
  const [dropAt, setDropAt] = useState<DropAt>(null)
  const [dragging, setDragging] = useState(false)

  const st = workspaceStatus(list)
  const shownCells = cellKey ? cellKey.split(',').map(Number) : []
  const multi = list.length > 1
  const expanded = multi && (expandedFlag ?? true)
  const agentLabel = agentName(w.agentId)

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        data-workspace-id={w.id}
        aria-current={selected || undefined}
        aria-label={`${w.name}，${agentLabel}，${statusText(st.status, st.exitCode, busy)}`}
        title={w.cwd}
        draggable={!filtering}
        onClick={() => openWorkspace(w)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openWorkspace(w)
          } else if (isMenuKey(e)) {
            e.preventDefault()
            openMenuAt(e.currentTarget, workspaceMenu(w))
          }
        }}
        onContextMenu={(e) => openMenu(e, workspaceMenu(w))}
        onDragStart={(e) => {
          beginDrag(e, 'workspace', w.id)
          setDragging(true)
        }}
        onDragEnd={() => {
          endDrag()
          setDragging(false)
          setDropAt(null)
        }}
        onDragOver={(e) => {
          if (!carries(e, DRAG_WS) || draggingId('workspace') === w.id) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const at = dropSide(e)
          if (at !== dropAt) setDropAt(at)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropAt(null)
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(DRAG_WS)
          const at = dropAt
          setDropAt(null)
          if (!id || !at) return
          e.preventDefault()
          e.stopPropagation()
          placeWorkspace(id, w, at)
        }}
        className={`group relative flex h-12 items-center gap-2 rounded-control px-2.5 transition-[background-color,opacity] duration-150 ${
          selected ? 'bg-raised text-ink-strong' : 'text-ink hover:bg-sunken'
        } ${dragging ? 'opacity-60' : ''}`}
      >
        {selected && <span aria-hidden="true" className="absolute top-2 left-0 h-8 w-0.5 rounded-pill bg-accent" />}
        {dropAt && (
          <span
            aria-hidden="true"
            data-drop-at={dropAt}
            className={`pointer-events-none absolute right-1 left-1 h-0.5 rounded-pill bg-accent ${dropAt === 'before' ? '-top-0.5' : '-bottom-0.5'}`}
          />
        )}
        <WorkspaceIcon workspaceId={w.id} agentId={w.agentId} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <StatusIcon status={st.status} exitCode={st.exitCode} active={busy} />
            <span className="truncate text-[13px] font-semibold">{w.name}</span>
          </div>
          <div className="flex items-center gap-1 text-[12px] text-ink-faint" data-branch={branch ?? ''}>
            {branch ? (
              <>
                <GitBranch size={12} aria-label="分支" className="shrink-0" />
                <span className="truncate">{branch}</span>
              </>
            ) : (
              <span className="truncate">{w.note || lastSegment(w.cwd)}</span>
            )}
          </div>
        </div>
        {attention && (
          <span role="img" aria-label="有会话在等你" title="有会话在等你" data-attention="" className="size-2 shrink-0 rounded-pill bg-accent" />
        )}
        {shownCells.length > 0 && (
          <span
            title={`显示在第 ${shownCells.map((i) => i + 1).join('、')} 格`}
            aria-label={`显示在第 ${shownCells.map((i) => i + 1).join('、')} 格`}
            data-cell-badge={shownCells.map((i) => i + 1).join(',')}
            className={`grid h-5 min-w-5 shrink-0 place-items-center rounded-badge px-1 text-[12px] font-semibold tabular-nums text-ink-muted ${
              selected ? 'bg-card' : 'bg-raised'
            }`}
          >
            {/* 两格以上只列前两个，避免挤掉名称 */}
            {shownCells
              .slice(0, 2)
              .map((i) => i + 1)
              .join(' ')}
            {shownCells.length > 2 ? '…' : ''}
          </span>
        )}
        {multi && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${list.length} 个会话，点击${expanded ? '收起' : '展开'}`}
            data-session-count={list.length}
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(w.id, !expanded)
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className="h-5 shrink-0 rounded-pill border border-line-strong px-1.5 text-[12px] leading-none tabular-nums text-ink-muted transition-colors duration-150 hover:text-ink-strong"
          >
            {list.length}
          </button>
        )}
      </div>

      {expanded && (
        <ul className="mt-0.5 flex flex-col" aria-label={`${w.name} 的会话`}>
          {list.map((s) => (
            <SessionRow key={s.id} s={s} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** 会话子行（UI设计约束 §4.1）：32px，缩进 32px；双击 / F2 改名 */
function SessionRow({ s }: { s: SessionMeta }): React.JSX.Element {
  // 高亮：显示在聚焦格里的会话
  const active = useLayout((l) => l.cells[l.focused] === s.id)
  const rename = useSessions((x) => x.rename)
  const busy = useActivity((x) => x.state[s.id] === 'active')
  const uptime = useUptime(s)
  const [renaming, setRenaming] = useState(false)
  const menu = (): ReturnType<typeof sessionMenu> => sessionMenu(s, () => setRenaming(true))

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        data-session-row={s.id}
        draggable={!renaming}
        onDragStart={(e) => beginDrag(e, 'session', s.id)}
        onDragEnd={endDrag}
        aria-current={active || undefined}
        aria-label={`#${s.index} ${s.title}，${statusText(s.status, s.exitCode, busy)}`}
        title={statusText(s.status, s.exitCode, busy)}
        onClick={() => showSession(s)}
        onDoubleClick={() => setRenaming(true)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            showSession(s)
          } else if (e.key === 'F2') {
            e.preventDefault()
            setRenaming(true)
          } else if (isMenuKey(e)) {
            e.preventDefault()
            openMenuAt(e.currentTarget, menu())
          }
        }}
        onContextMenu={(e) => openMenu(e, menu())}
        className={`flex h-8 items-center gap-2 rounded-control pr-2 pl-8 transition-colors duration-150 ${
          active ? 'bg-raised text-ink-strong' : 'text-ink hover:bg-sunken'
        }`}
      >
        <StatusIcon status={s.status} exitCode={s.exitCode} active={busy} />
        <span className="shrink-0 text-[12px] tabular-nums text-ink-faint">#{s.index}</span>
        {renaming ? (
          <InlineEdit
            initial={s.title}
            label="会话标题"
            className="text-[13px]"
            onCommit={(v) => {
              setRenaming(false)
              void rename(s.id, v).catch((e: unknown) => notifyError(e, '重命名失败'))
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[13px]">{s.title}</span>
        )}
        <span className="shrink-0 text-[12px] tabular-nums text-ink-faint">{uptime}</span>
      </div>
    </li>
  )
}

/** 56px 图标栏里的工作区：只有徽章与状态图标，名称放 tooltip（UI设计约束 §4.1 折叠态） */
export function CollapsedCard({ w, list }: { w: Workspace; list: SessionMeta[] }): React.JSX.Element {
  const selected = useSessions((s) => s.selectedWorkspaceId === w.id)
  const busy = useActivity((s) => list.some((x) => isLive(x) && s.state[x.id] === 'active'))
  const st = workspaceStatus(list)
  return (
    <button
      type="button"
      data-workspace-id={w.id}
      aria-current={selected || undefined}
      aria-label={`${w.name}，${statusText(st.status, st.exitCode, busy)}`}
      title={`${w.name} · ${statusText(st.status, st.exitCode, busy)}`}
      draggable
      onDragStart={(e) => beginDrag(e, 'workspace', w.id)}
      onDragEnd={endDrag}
      onClick={() => openWorkspace(w)}
      onContextMenu={(e) => openMenu(e, workspaceMenu(w))}
      onKeyDown={(e) => {
        if (isMenuKey(e)) {
          e.preventDefault()
          openMenuAt(e.currentTarget, workspaceMenu(w))
        }
      }}
      className={`relative grid h-12 w-10 shrink-0 place-items-center rounded-control transition-colors duration-150 ${
        selected ? 'bg-raised' : 'hover:bg-sunken'
      }`}
    >
      {selected && <span aria-hidden="true" className="absolute top-2 -left-2 h-8 w-0.5 rounded-pill bg-accent" />}
      <WorkspaceIcon workspaceId={w.id} agentId={w.agentId} />
      <span className="absolute right-1 bottom-1.5">
        <StatusIcon status={st.status} exitCode={st.exitCode} active={busy} />
      </span>
    </button>
  )
}

