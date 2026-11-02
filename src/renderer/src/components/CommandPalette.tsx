import { useEffect, useMemo, useRef, useState } from 'react'
import { MagnifyingGlass } from '@phosphor-icons/react'
import type { Settings } from '@shared/types'
import { useConfig } from '../store/config'
import { useLayout, visibleCount } from '../store/layout'
import { useRestore } from '../store/restore'
import { useSessions } from '../store/sessions'
import { useUi } from '../store/ui'
import { useActivity } from '../store/activity'
import { agentName } from '../lib/agents'
import { useOverlay } from '../lib/useOverlay'
import { initials } from '../lib/pinyin'
import { applyPreset, createGroupPrompt, focusedSession, openWorkspace, savePresetPrompt, showSession, toggleBroadcast } from './actions'
import { confirm, notifyError } from './ConfirmDialog'
import { AgentBadge, WorkspaceIcon, statusText } from './ui'

type Kind = 'workspace' | 'session' | 'action'
type Item = {
  kind: Kind
  id: string
  label: string
  sub: string
  keywords: string
  agentId?: string
  run: () => void
  /** 选了之后面板不关（「在第 N 格打开…」接着选工作区） */
  keepOpen?: boolean
  /** 显示在「最近使用」段 */
  recent?: boolean
}

type Section = Kind | 'recent'
const SECTION_LABEL: Record<Section, string> = { recent: '最近使用', workspace: '工作区', session: '会话', action: '动作' }
const sectionOf = (item: Item): Section => (item.recent ? 'recent' : item.kind)

/** 最近使用（升级建议 3.5）：只记 id，存本机 localStorage，最多 5 条 */
const RECENT_KEY = 'warp.recent'
function recentIds(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function remember(id: string): void {
  localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentIds().filter((x) => x !== id)].slice(0, 5)))
}
/** 没输入时：最近用过的工作区与会话排最前 */
function withRecent(items: Item[]): Item[] {
  const top = recentIds()
    .map((id) => items.find((x) => x.id === id && x.kind !== 'action'))
    .filter((x): x is Item => Boolean(x))
  if (!top.length) return items
  const ids = new Set(top.map((x) => x.id))
  return [...top.map((x) => ({ ...x, recent: true })), ...items.filter((x) => !ids.has(x.id))]
}

/** 「在第 N 格打开…」选中后由面板接手：换成工作区列表 */
let pickCellHandler: ((cell: number) => void) | null = null

const MAX_ITEMS = 60

/** 每个词都要命中；名称开头命中排最前，其次名称包含，其余按原顺序 */
function filterItems(items: Item[], query: string): Item[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return withRecent(items)
  const scored: { item: Item; score: number; i: number }[] = []
  items.forEach((item, i) => {
    const label = item.label.toLowerCase()
    // 拼音首字母：输入 khd 能搜到「客户端」
    const hay = `${label} ${initials(item.label)} ${item.sub} ${item.keywords}`.toLowerCase()
    if (!words.every((w) => hay.includes(w))) return
    const score = label.startsWith(words[0]) ? 0 : label.includes(words[0]) ? 1 : 2
    scored.push({ item, score, i })
  })
  // 分类内按得分排，分类之间保持「工作区 → 会话 → 动作」，分组标题才不会重复出现
  const order: Record<Kind, number> = { workspace: 0, session: 1, action: 2 }
  return scored.sort((a, b) => order[a.item.kind] - order[b.item.kind] || a.score - b.score || a.i - b.i).map((x) => x.item)
}

function setTheme(theme: Settings['theme']): void {
  void useConfig
    .getState()
    .updateSettings({ theme })
    .catch((e: unknown) => notifyError(e))
}

/** 打开面板那一刻的全部条目：工作区、会话、可执行的动作 */
function buildItems(): Item[] {
  const cfg = useConfig.getState().config
  const sessions = useSessions.getState().sessions
  const l = useLayout.getState()
  const ui = useUi.getState()
  const items: Item[] = []
  for (const w of [...(cfg?.workspaces ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const agent = agentName(w.agentId)
    items.push({ kind: 'workspace', id: w.id, label: w.name, sub: `${agent} · ${w.cwd}`, keywords: `${w.note} ${w.agentId}`, agentId: w.agentId, run: () => openWorkspace(w) })
  }
  for (const s of [...sessions].sort((a, b) => b.startedAt - a.startedAt)) {
    const ws = cfg?.workspaces.find((w) => w.id === s.workspaceId)
    items.push({
      kind: 'session',
      id: s.id,
      label: s.title,
      sub: `#${s.index} · ${statusText(s.status, s.exitCode, useActivity.getState().state[s.id] === 'active')} · ${ws?.name ?? ''}`,
      keywords: `${s.agentId} ${agentName(s.agentId)} ${s.cwd}`,
      agentId: s.agentId,
      run: () => showSession(s)
    })
  }
  const act = (id: string, label: string, keywords: string, run: () => void): void => {
    items.push({ kind: 'action', id, label, sub: '', keywords, run })
  }
  act('new-workspace', '新建工作区', 'create workspace xinjian', () => ui.openCreate(null))
  act('new-group', '新建分组', 'create group fenzu', createGroupPrompt)
  act('grid-single', '布局：单格', 'grid layout 1 single', () => l.setGridMode('single'))
  act('grid-dual', '布局：左右两格', 'grid layout 2 dual split', () => l.setGridMode('dual'))
  act('grid-quad', '布局：四宫格', 'grid layout 4 quad', () => l.setGridMode('quad'))
  act('toggle-rail', '显示 / 收起会话栏', 'sidebar rail ctrl+shift+b', () => l.toggleRail())
  act('toggle-files', '显示 / 隐藏目录栏', 'files tree ctrl+shift+e', () => l.toggleFileRail())
  const fs = focusedSession()
  if (fs) act('find', '在当前终端中搜索', 'search find ctrl+shift+f', () => ui.setSearchCell(l.focused))
  act('theme-system', '主题：跟随系统', 'theme system', () => setTheme('system'))
  act('theme-light', '主题：浅色', 'theme light', () => setTheme('light'))
  act('theme-dark', '主题：深色', 'theme dark', () => setTheme('dark'))
  const n = useRestore.getState().candidates.length
  if (n > 0) act('restore', `恢复上次的 ${n} 个会话…`, 'restore resume huifu', () => useRestore.getState().setDialogOpen(true))
  act('history', '会话历史…', 'history lishi huihua ctrl+shift+h', () => ui.openHistory())
  act('settings', '打开设置', 'settings preferences ctrl+,', () => ui.openSettings())
  act('shortcuts', '快捷键速查', 'shortcuts keys ctrl+/ kuaijiejian', () => ui.setShortcutsOpen(true))
  act('broadcast', ui.broadcast ? '关闭广播输入' : '开启广播输入…', 'broadcast guangbo', () => void toggleBroadcast())
  for (let i = 0; i < visibleCount(l) && visibleCount(l) > 1; i++) {
    items.push({ kind: 'action', id: `pick-${i}`, label: `在第 ${i + 1} 格打开…`, sub: '', keywords: `open cell ${i + 1}`, keepOpen: true, run: () => pickCellHandler?.(i) })
  }
  for (const p of cfg?.layoutPresets ?? []) {
    act(`preset-${p.id}`, `布局预设：${p.name}`, 'preset layout yushe', () => void applyPreset(p))
  }
  act('preset-save', '把当前布局存为预设…', 'preset save layout yushe', savePresetPrompt)
  for (const p of cfg?.layoutPresets ?? []) {
    act(`preset-del-${p.id}`, `删除布局预设：${p.name}`, 'preset delete remove', () => {
      void confirm({ title: `删除布局预设「${p.name}」？`, okLabel: '删除', danger: true }).then((ok) => {
        if (ok) void useConfig.getState().removePreset(p.id).catch((e: unknown) => notifyError(e))
      })
    })
  }
  return items
}

/** 选好格之后的第二步：只列工作区，回车在那一格打开 */
function pickItems(cell: number): Item[] {
  const cfg = useConfig.getState().config
  return [...(cfg?.workspaces ?? [])]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((w) => ({
      kind: 'workspace' as const,
      id: w.id,
      label: w.name,
      sub: `${agentName(w.agentId)} · ${w.cwd}`,
      keywords: `${w.note} ${w.agentId}`,
      agentId: w.agentId,
      run: () => openWorkspace(w, cell)
    }))
}

/**
 * 命令面板（PRD W-09，UI设计约束 §4.4）：标题栏搜索框或 Ctrl+Shift+K 打开，
 * 搜工作区、会话与可执行动作；↑↓ 选择，回车执行，Esc 关闭。文件搜索留 P2。
 */
export function CommandPalette(): React.JSX.Element | null {
  const open = useUi((s) => s.paletteOpen)
  const setOpen = useUi((s) => s.setPaletteOpen)
  if (!open) return null
  return <Palette onClose={() => setOpen(false)} />
}

function Palette({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [base] = useState(buildItems)
  const [cellPick, setCellPick] = useState<number | null>(null)
  const items = useMemo(() => (cellPick === null ? base : pickItems(cellPick)), [base, cellPick])
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useOverlay(panelRef, onClose)
  useEffect(() => {
    pickCellHandler = (cell) => {
      setCellPick(cell)
      setQuery('')
      setActive(0)
    }
    return () => {
      pickCellHandler = null
    }
  }, [])

  const shown = useMemo(() => filterItems(items, query).slice(0, MAX_ITEMS), [items, query])
  useEffect(() => setActive(0), [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (item: Item | undefined): void => {
    if (!item) return
    if (item.keepOpen) {
      item.run()
      return
    }
    if (item.kind !== 'action') remember(item.id)
    onClose()
    // 先关面板（焦点还回去），再执行，避免动作里打开的对话框被面板的焦点恢复抢走焦点
    requestAnimationFrame(() => item.run())
  }

  return (
    <div className="fixed inset-0 z-40" onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        data-testid="palette"
        className="absolute top-14 left-1/2 flex max-h-[min(520px,calc(100vh-96px))] w-[560px] max-w-[calc(100vw-48px)] -translate-x-1/2 flex-col rounded-card border border-line bg-card shadow-[var(--shadow-float)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <MagnifyingGlass size={16} aria-hidden="true" className="shrink-0 text-ink-faint" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[active] ? `palette-${active}` : undefined}
            aria-label="搜索工作区、会话与动作"
            data-testid="palette-input"
            placeholder={cellPick === null ? '搜索工作区、会话与动作…（支持拼音首字母）' : `选择要在第 ${cellPick + 1} 格打开的工作区…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const n = shown.length
                if (n) setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(shown[active])
              }
            }}
            className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-ink-strong outline-none placeholder:text-ink-faint"
          />
        </div>
        <div ref={listRef} id="palette-list" role="listbox" aria-label="结果" className="min-h-0 flex-1 overflow-y-auto p-2">
          {shown.length === 0 && <p className="px-3 py-6 text-center text-[13px] text-ink-muted">没有匹配「{query.trim()}」的结果</p>}
          {shown.map((item, i) => {
            const header = i === 0 || sectionOf(shown[i - 1]) !== sectionOf(item)
            return (
              <div key={`${item.kind}-${item.id}`}>
                {header && <div className="px-3 pt-2 pb-1 text-[12px] font-semibold text-ink-muted">{SECTION_LABEL[sectionOf(item)]}</div>}
                <div
                  id={`palette-${i}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  data-kind={item.kind}
                  data-item-id={item.id}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => run(item)}
                  className={`flex h-10 items-center gap-2 rounded-control px-3 transition-colors duration-150 ${i === active ? 'bg-raised' : ''}`}
                >
                  {item.agentId &&
                    (item.kind === 'workspace' ? (
                      <WorkspaceIcon workspaceId={item.id} agentId={item.agentId} size={20} />
                    ) : (
                      <AgentBadge agentId={item.agentId} size={20} />
                    ))}
                  <span className="min-w-0 shrink truncate text-[13px] font-semibold text-ink-strong">{item.label}</span>
                  {item.sub && <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-faint">{item.sub}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
