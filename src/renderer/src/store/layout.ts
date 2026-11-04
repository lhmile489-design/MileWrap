import { create } from 'zustand'
import { DEFAULT_LAYOUT, LAYOUT_LIMITS, type Cells, type GridMode, type LayoutPatch } from '@shared/types'

export const CELL_COUNT: Record<GridMode, number> = { single: 1, dual: 2, quad: 4 }
const NEXT_MODE: Record<GridMode, GridMode> = { single: 'dual', dual: 'quad', quad: 'single' }

/** 两列格子需要的控制台宽度：2 × 360 + 格间距 8 + 内边距 16（UI设计约束 §3） */
export const MIN_CONSOLE_FOR_COLUMNS = 2 * LAYOUT_LIMITS.cell.width + 8 + 16
export const COLLAPSED_RAIL_WIDTH = 56

type Persisted = Required<LayoutPatch>

type LayoutState = Persisted & {
  loaded: boolean
  /** 接收键盘输入的格（0–3），不持久化 */
  focused: number
  /** 多格时临时最大化的格（PRD T-10），不持久化 */
  maximized: number | null
  /** 窗口内容宽度，自动收栏用 */
  viewport: number
  /** 窄窗口里用户手动展开过：这段时间不再自动收（UI设计约束 §3「用户的选择优先」） */
  railOverride: boolean
  fileOverride: boolean
  previewOverride: boolean

  load: () => Promise<void>
  setViewport: (width: number) => void
  setGridMode: (mode: GridMode) => void
  cycleGridMode: () => void
  focusCell: (cell: number) => void
  /** 把会话放进某格：它已在另一可见格时两格互换；原占用者转入后台 */
  place: (sessionId: string, cell: number) => void
  swap: (a: number, b: number) => void
  /** 主进程列表里已经没有的会话，从格里清掉 */
  prune: (ids: Set<string>) => void
  setRatio: (axis: 'H' | 'V', ratio: number) => void
  setRailWidth: (which: 'session' | 'file' | 'preview', px: number) => void
  toggleRail: () => void
  toggleFileRail: () => void
  togglePreviewRail: () => void
  toggleMaximize: (cell: number) => void
}

const PERSIST_KEYS: (keyof Persisted)[] = [
  'sessionRailWidth',
  'sessionRailCollapsed',
  'fileRailWidth',
  'fileRailVisible',
  'previewRailWidth',
  'previewRailVisible',
  'gridMode',
  'cells',
  'splitRatioH',
  'splitRatioV'
]

type RailInput = Pick<
  LayoutState,
  'gridMode' | 'viewport' | 'sessionRailWidth' | 'sessionRailCollapsed' | 'fileRailWidth' | 'fileRailVisible' | 'previewRailWidth' | 'previewRailVisible' | 'railOverride' | 'fileOverride' | 'previewOverride'
>

/**
 * 栏位的实际显隐（UI设计约束 §3）：多格时控制台不足 744px，先临时收目录栏，仍不够再把会话栏收成 56px。
 * 只影响显示，不改用户偏好；窗口变宽后自动弹回。
 */
export function railsOf(s: RailInput): { fileShown: boolean; railCollapsed: boolean; previewShown: boolean } {
  const need = s.gridMode === 'single' ? 0 : MIN_CONSOLE_FOR_COLUMNS
  const railW = s.sessionRailCollapsed ? COLLAPSED_RAIL_WIDTH : s.sessionRailWidth
  // 收让顺序：预览栏最先收，其次目录栏，最后把会话栏收成 56px（预览是附属，空间先还给终端）
  let previewShown = s.previewRailVisible
  if (need && previewShown && !s.previewOverride && s.viewport - railW - s.fileRailWidth - s.previewRailWidth < need) previewShown = false
  const previewW = previewShown ? s.previewRailWidth : 0
  let fileShown = s.fileRailVisible
  if (need && fileShown && !s.fileOverride && s.viewport - railW - s.fileRailWidth - previewW < need) fileShown = false
  const fileW = fileShown ? s.fileRailWidth : 0
  let railCollapsed = s.sessionRailCollapsed
  if (need && !railCollapsed && !s.railOverride && s.viewport - s.sessionRailWidth - fileW - previewW < need) railCollapsed = true
  return { fileShown, railCollapsed, previewShown }
}

export function visibleCount(s: { gridMode: GridMode }): number {
  return CELL_COUNT[s.gridMode]
}

/** 第一个空的可见格；都占满返回 -1（恢复卡片放这里） */
export function firstEmptyCell(s: { gridMode: GridMode; cells: Cells }): number {
  for (let i = 0; i < CELL_COUNT[s.gridMode]; i++) if (!s.cells[i]) return i
  return -1
}

/** 会话所在的可见格；后台会话返回 -1 */
export function cellOf(s: { gridMode: GridMode; cells: Cells }, sessionId: string): number {
  const i = s.cells.indexOf(sessionId)
  return i >= 0 && i < CELL_COUNT[s.gridMode] ? i : -1
}

function clampRatio(r: number): number {
  return Math.min(LAYOUT_LIMITS.ratio.max, Math.max(LAYOUT_LIMITS.ratio.min, r))
}

export const useLayout = create<LayoutState>((set, get) => ({
  ...pickPersisted(DEFAULT_LAYOUT),
  loaded: false,
  focused: 0,
  maximized: null,
  viewport: typeof window === 'undefined' ? 1440 : window.innerWidth,
  railOverride: false,
  fileOverride: false,
  previewOverride: false,

  load: async () => {
    const l = await window.warp.layout.get()
    set({ ...pickPersisted(l), loaded: true, focused: 0 })
  },

  setViewport: (width) => {
    set({ viewport: width })
    // 窗口变宽到不需要自动收了：用户的临时展开选择随之失效
    const s = get()
    if (s.fileOverride && railsOf({ ...s, fileOverride: false }).fileShown) set({ fileOverride: false })
    if (s.previewOverride && railsOf({ ...s, previewOverride: false }).previewShown) set({ previewOverride: false })
    if (s.railOverride && !railsOf({ ...s, railOverride: false }).railCollapsed) set({ railOverride: false })
  },

  setGridMode: (mode) => {
    const count = CELL_COUNT[mode]
    set({ gridMode: mode, focused: Math.min(get().focused, count - 1), maximized: null })
  },
  cycleGridMode: () => get().setGridMode(NEXT_MODE[get().gridMode]),

  focusCell: (cell) => {
    if (cell >= 0 && cell < visibleCount(get())) set({ focused: cell })
  },

  place: (sessionId, cell) => {
    const s = get()
    const count = visibleCount(s)
    const target = cell >= 0 && cell < count ? cell : s.focused
    const cells = [...s.cells] as Cells
    const from = cells.indexOf(sessionId)
    if (from === target) {
      set({ focused: target })
      return
    }
    const occupant = cells[target]
    // 从另一可见格拖过来 = 两格互换；从隐藏位置（如 4 格切回 2 格后的第 3 格）拿出来则原位置空出
    if (from >= 0) cells[from] = from < count ? occupant : null
    cells[target] = sessionId
    set({ cells, focused: target, maximized: s.maximized === null || s.maximized === target ? s.maximized : null })
  },

  swap: (a, b) => {
    const s = get()
    const count = visibleCount(s)
    if (a === b || a < 0 || b < 0 || a >= count || b >= count) return
    const cells = [...s.cells] as Cells
    ;[cells[a], cells[b]] = [cells[b], cells[a]]
    set({ cells, focused: b })
  },

  prune: (ids) => {
    const s = get()
    if (s.cells.every((c) => c === null || ids.has(c))) return
    set({ cells: s.cells.map((c) => (c && ids.has(c) ? c : null)) as Cells })
  },

  setRatio: (axis, ratio) => set(axis === 'H' ? { splitRatioH: clampRatio(ratio) } : { splitRatioV: clampRatio(ratio) }),

  setRailWidth: (which, px) => {
    const lim = which === 'session' ? LAYOUT_LIMITS.sessionRail : which === 'file' ? LAYOUT_LIMITS.fileRail : LAYOUT_LIMITS.previewRail
    const w = Math.round(Math.min(lim.max, Math.max(lim.min, px)))
    set(which === 'session' ? { sessionRailWidth: w } : which === 'file' ? { fileRailWidth: w } : { previewRailWidth: w })
  },

  toggleRail: () => {
    const s = get()
    if (!railsOf(s).railCollapsed) {
      set({ sessionRailCollapsed: true, railOverride: false })
      return
    }
    // 展开：若当前宽度下会被自动收起，记为用户坚持展开
    const probe = { ...s, sessionRailCollapsed: false, railOverride: false }
    set({ sessionRailCollapsed: false, railOverride: railsOf(probe).railCollapsed })
  },

  toggleFileRail: () => {
    const s = get()
    if (railsOf(s).fileShown) {
      set({ fileRailVisible: false, fileOverride: false })
      return
    }
    const probe = { ...s, fileRailVisible: true, fileOverride: false }
    set({ fileRailVisible: true, fileOverride: !railsOf(probe).fileShown })
  },

  togglePreviewRail: () => {
    const s = get()
    if (railsOf(s).previewShown) {
      set({ previewRailVisible: false, previewOverride: false })
      return
    }
    const probe = { ...s, previewRailVisible: true, previewOverride: false }
    set({ previewRailVisible: true, previewOverride: !railsOf(probe).previewShown })
  },

  toggleMaximize: (cell) => {
    const s = get()
    if (visibleCount(s) === 1) return
    set({ maximized: s.maximized === cell ? null : cell, focused: cell })
  }
}))

function pickPersisted(l: Persisted): Persisted {
  return {
    sessionRailWidth: l.sessionRailWidth,
    sessionRailCollapsed: l.sessionRailCollapsed,
    fileRailWidth: l.fileRailWidth,
    fileRailVisible: l.fileRailVisible,
    previewRailWidth: l.previewRailWidth,
    previewRailVisible: l.previewRailVisible,
    gridMode: l.gridMode,
    cells: [...l.cells] as Cells,
    splitRatioH: l.splitRatioH,
    splitRatioV: l.splitRatioV
  }
}

// 持久化：布局字段变化后 300ms 写一次（拖分隔条时不逐帧写盘）
let saveTimer: number | null = null
useLayout.subscribe((s, prev) => {
  if (!s.loaded || !prev.loaded) return
  if (!PERSIST_KEYS.some((k) => s[k] !== prev[k])) return
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void window.warp.layout.update(pickPersisted(useLayout.getState())).catch(() => undefined)
  }, 300)
})
