import { Fragment, useEffect, useMemo, useState } from 'react'
import { FolderPlus, MagnifyingGlass, Plus, X } from '@phosphor-icons/react'
import type { Group, SessionMeta, Workspace } from '@shared/types'
import { useBranches } from '../store/branches'
import { LAYOUT_LIMITS } from '@shared/types'
import { useConfig } from '../store/config'
import { railsOf, useLayout } from '../store/layout'
import { useSessions } from '../store/sessions'
import { useUi } from '../store/ui'
import { agentName } from '../lib/agents'
import { createGroupPrompt } from './actions'
import { openMenuAt, type MenuItem } from './Menu'
import { RailResizer } from './Splitter'
import { IconButton } from './ui'
import { GroupLabel, UngroupedLabel } from './rail/GroupLabel'
import { CollapsedCard, WorkspaceCard } from './rail/WorkspaceCard'
import { DRAG_WS, appendWorkspace, byOrder, carries } from './rail/drag'

const NO_SESSIONS: SessionMeta[] = []

/**
 * 拖进来或粘贴的目录路径 → 打开新建弹窗并预填（升级建议 2.5）。
 * 只认 Windows 绝对路径的形状；是否存在、是不是目录由主进程 sanitizeCwd 校验。
 */
function prefillFromPath(raw: string): boolean {
  const p = raw.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '')
  if (!/^[A-Za-z]:[\\/]/.test(p) || /[\r\n]/.test(p)) return false
  const name = p.split(/[\\/]+/).filter(Boolean).pop() ?? p
  useUi.getState().openCreate(null, { cwd: p, name })
  return true
}

type Section = { group: Group | null; items: Workspace[] }

/** 筛选（PRD W-09）：名称、备注、目录、agent，不区分大小写 */
function matches(w: Workspace, q: string): boolean {
  const agent = agentName(w.agentId)
  return [w.name, w.note, w.cwd, agent, w.agentId].some((x) => x.toLowerCase().includes(q))
}

/**
 * 会话栏（UI设计约束 §4.1）：分组 > 工作区 > 会话，视觉上压平——
 * 分组是一行标签，工作区是一张卡片，会话只在多开时展开成子行。「未分组」固定在最后。
 */
export function SessionRail(): React.JSX.Element {
  const config = useConfig((s) => s.config)
  const sessions = useSessions((s) => s.sessions)
  // 实际显隐：用户偏好 + 多格时窗口太窄的临时自动收起（store/layout railsOf）
  const collapsed = useLayout((s) => railsOf(s).railCollapsed)
  const width = useLayout((s) => s.sessionRailWidth)
  const setRailWidth = useLayout((s) => s.setRailWidth)
  const openCreate = useUi((s) => s.openCreate)
  const refreshAll = useBranches((s) => s.refreshAll)
  const [filter, setFilter] = useState('')

  const groups = useMemo(() => [...(config?.groups ?? [])].sort(byOrder), [config])
  const workspaces = useMemo(
    () => [...(config?.workspaces ?? [])].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt),
    [config]
  )
  const byWorkspace = useMemo(() => {
    const m = new Map<string, SessionMeta[]>()
    for (const s of sessions) m.set(s.workspaceId, [...(m.get(s.workspaceId) ?? []), s])
    for (const list of m.values()) list.sort((a, b) => a.index - b.index)
    return m
  }, [sessions])

  // 分支（W-16）：工作区变化时读一次，窗口重新获得焦点时再读（agent 可能切了分支）
  const idsKey = workspaces.map((w) => w.id).join('|')
  useEffect(() => {
    const ids = idsKey ? idsKey.split('|') : []
    refreshAll(ids)
    const onFocus = (): void => refreshAll(ids)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [idsKey, refreshAll])

  const q = filter.trim().toLowerCase()
  const filtering = q.length > 0
  const sections = useMemo<Section[]>(() => {
    const visible = filtering ? workspaces.filter((w) => matches(w, q)) : workspaces
    const known = new Set(groups.map((g) => g.id))
    return [
      ...groups.map((g) => ({ group: g, items: visible.filter((w) => w.groupId === g.id) })),
      { group: null, items: visible.filter((w) => w.groupId === null || !known.has(w.groupId)) }
    ]
  }, [groups, workspaces, filtering, q])

  const newMenu = (): MenuItem[] => [
    { label: '新建工作区', icon: <Plus size={16} />, onSelect: () => openCreate(null) },
    { label: '新建分组', icon: <FolderPlus size={16} />, onSelect: createGroupPrompt }
  ]
  const sessionsOf = (id: string): SessionMeta[] => byWorkspace.get(id) ?? NO_SESSIONS

  if (collapsed) {
    return (
      <aside aria-label="会话栏" data-rail="sessions" data-collapsed="true" className="flex w-14 shrink-0 flex-col items-center border-r border-line bg-panel">
        <div className="flex h-9 shrink-0 items-center">
          <IconButton label="新建" onClick={(e) => openMenuAt(e.currentTarget, newMenu())}>
            <Plus size={16} />
          </IconButton>
        </div>
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto pb-2">
          {sections
            .filter((s) => s.items.length > 0)
            .map((sec, i) => (
              <Fragment key={sec.group?.id ?? 'none'}>
                {i > 0 && <div role="separator" className="my-1 h-px w-8 shrink-0 bg-line" />}
                {sec.items.map((w) => (
                  <CollapsedCard key={w.id} w={w} list={sessionsOf(w.id)} />
                ))}
              </Fragment>
            ))}
        </div>
      </aside>
    )
  }

  const visibleCount = sections.reduce((n, s) => n + s.items.length, 0)

  return (
    <aside
      aria-label="会话栏"
      data-rail="sessions"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(e) => {
        const f = e.dataTransfer.files[0]
        if (!f) return
        e.preventDefault()
        prefillFromPath(window.warp.fs.pathForFile(f))
      }}
      onPaste={(e) => {
        // 输入框里的粘贴照常；焦点在卡片上时，粘贴目录路径 = 新建工作区
        if ((e.target as HTMLElement).closest('input, textarea')) return
        if (prefillFromPath(e.clipboardData.getData('text'))) e.preventDefault()
      }}
      style={{ '--rail-w': `${width}px` } as React.CSSProperties}
      className="relative flex w-[var(--rail-w)] shrink-0 flex-col border-r border-line bg-panel"
    >
      <RailResizer
        label="调整会话栏宽度"
        width={width}
        min={LAYOUT_LIMITS.sessionRail.min}
        max={LAYOUT_LIMITS.sessionRail.max}
        onResize={(px) => setRailWidth('session', px)}
        testId="resize-session-rail"
      />
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <div className="relative flex min-w-0 flex-1 items-center">
          <MagnifyingGlass size={16} aria-hidden="true" className="pointer-events-none absolute left-2 text-ink-faint" />
          <input
            aria-label="筛选会话"
            data-testid="rail-filter"
            placeholder="筛选会话…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.preventDefault()
                e.stopPropagation()
                setFilter('')
              }
            }}
            className="h-7 w-full rounded-control border border-line bg-sunken pr-7 pl-8 text-[13px] text-ink-strong outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-accent"
          />
          {filter && (
            <button
              type="button"
              aria-label="清空筛选"
              onClick={() => setFilter('')}
              className="absolute right-1 grid size-5 place-items-center rounded-control text-ink-faint hover:text-ink-strong"
            >
              <X size={16} />
            </button>
          )}
        </div>
        <IconButton label="新建" onClick={(e) => openMenuAt(e.currentTarget, newMenu())}>
          <Plus size={16} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {workspaces.length === 0 && (
          <div className="mt-2 rounded-control border border-dashed border-line-strong p-3 text-[12px] text-ink-muted">
            <p className="mb-2">还没有工作区。把项目目录和 agent 保存下来，以后一键启动。</p>
            <button type="button" onClick={() => openCreate(null)} className="font-semibold text-accent hover:underline">
              新建第一个工作区
            </button>
          </div>
        )}
        {filtering && visibleCount === 0 && (
          <p className="mt-3 px-1 text-[12px] text-ink-muted" data-testid="rail-no-match">
            没有匹配「{filter.trim()}」的工作区
          </p>
        )}
        {sections.map((sec) => {
          // 筛选时只留有命中的段；「未分组」在没有任何分组时不画标签
          if (filtering && sec.items.length === 0) return null
          if (!sec.group && sec.items.length === 0 && groups.length === 0) return null
          return (
            <SectionBlock
              key={sec.group?.id ?? 'none'}
              section={sec}
              filtering={filtering}
              showLabel={sec.group !== null || groups.length > 0}
              sessionsOf={sessionsOf}
            />
          )
        })}
      </div>
    </aside>
  )
}

/** 一个分组段：标签 + 卡片列表。拖到段内空白处 = 放到该组末尾 */
function SectionBlock({
  section,
  filtering,
  showLabel,
  sessionsOf
}: {
  section: Section
  filtering: boolean
  showLabel: boolean
  sessionsOf: (id: string) => SessionMeta[]
}): React.JSX.Element {
  const { group, items } = section
  const [overEnd, setOverEnd] = useState(false)
  const open = filtering || !group?.collapsed
  const groupId = group?.id ?? null

  return (
    <section
      data-group-section={groupId ?? 'none'}
      aria-label={group?.name ?? '未分组'}
      onDragOver={(e) => {
        if (!carries(e, DRAG_WS) || filtering) return
        // 卡片和标签自己处理落点；只有落在段内空白处才算「放到末尾」
        if ((e.target as HTMLElement).closest('[data-workspace-id], [data-group-label]')) {
          if (overEnd) setOverEnd(false)
          return
        }
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!overEnd) setOverEnd(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverEnd(false)
      }}
      onDrop={(e) => {
        const was = overEnd
        setOverEnd(false)
        const id = e.dataTransfer.getData(DRAG_WS)
        if (!id || !was) return
        e.preventDefault()
        appendWorkspace(id, groupId)
      }}
      className="pb-1"
    >
      {showLabel && (group ? <GroupLabel group={group} filtering={filtering} /> : <UngroupedLabel />)}
      {open && (
        <ul className="mt-1 flex flex-col gap-1">
          {items.map((w) => (
            <WorkspaceCard key={w.id} w={w} list={sessionsOf(w.id)} filtering={filtering} />
          ))}
        </ul>
      )}
      {open && group && items.length === 0 && !filtering && (
        <p className="py-1.5 pl-5 text-[12px] text-ink-faint">空分组，把工作区拖到这里</p>
      )}
      {overEnd && <div aria-hidden="true" className="mx-1 mt-1 h-0.5 rounded-pill bg-accent" />}
    </section>
  )
}
