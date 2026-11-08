import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LAYOUT, LAYOUT_LIMITS, RIGHT_RAIL_TABS, type Cells, type GridMode, type Layout, type RightRailTab } from '@shared/types'
import { atomicWrite } from '../lib/atomicWrite'

const GRID_MODES: GridMode[] = ['single', 'dual', 'quad']
const SESSION_ID_RE = /^s\d+-[a-z0-9]+$/
const WRITE_DEBOUNCE_MS = 400

/**
 * 界面布局（技术设计 §4 LayoutState）：window-state.json，原子写。
 * 纯展示偏好，读坏了直接用默认值，不做 .bak。
 * 渲染层的补丁逐字段校形，窗口尺寸位置只由主进程 setBounds 写入。
 */
export class LayoutStore {
  private readonly file: string
  private data: Layout
  private timer: NodeJS.Timeout | null = null

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'window-state.json')
    this.data = this.load()
  }

  get(): Layout {
    return this.data
  }

  /** 渲染层补丁：未知字段忽略，非法值抛错且不落盘 */
  update(input: unknown): Layout {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('布局参数不合法')
    const r = input as Record<string, unknown>
    const next: Layout = { ...this.data, cells: [...this.data.cells] as Cells }
    if (r.sessionRailWidth !== undefined) next.sessionRailWidth = int(r.sessionRailWidth, LAYOUT_LIMITS.sessionRail)
    if (r.fileRailWidth !== undefined) next.fileRailWidth = int(r.fileRailWidth, LAYOUT_LIMITS.fileRail)
    if (r.sessionRailCollapsed !== undefined) next.sessionRailCollapsed = bool(r.sessionRailCollapsed)
    if (r.fileRailVisible !== undefined) next.fileRailVisible = bool(r.fileRailVisible)
    if (r.previewRailWidth !== undefined) next.previewRailWidth = int(r.previewRailWidth, LAYOUT_LIMITS.previewRail)
    if (r.previewRailVisible !== undefined) next.previewRailVisible = bool(r.previewRailVisible)
    if (r.rightRailTab !== undefined) {
      if (!RIGHT_RAIL_TABS.includes(r.rightRailTab as RightRailTab)) throw new Error('右栏页签不合法')
      next.rightRailTab = r.rightRailTab as RightRailTab
    }
    if (r.gridMode !== undefined) {
      if (!GRID_MODES.includes(r.gridMode as GridMode)) throw new Error('宫格模式不合法')
      next.gridMode = r.gridMode as GridMode
    }
    if (r.cells !== undefined) next.cells = cells(r.cells)
    if (r.splitRatioH !== undefined) next.splitRatioH = ratio(r.splitRatioH)
    if (r.splitRatioV !== undefined) next.splitRatioV = ratio(r.splitRatioV)
    this.data = next
    this.schedule()
    return this.data
  }

  /** 窗口尺寸位置：主进程在 resize / move / maximize 时调用 */
  setBounds(b: { width: number; height: number; x: number; y: number; maximized: boolean }): void {
    this.data = b.maximized
      ? { ...this.data, maximized: true }
      : { ...this.data, width: b.width, height: b.height, x: b.x, y: b.y, maximized: false }
    this.schedule()
  }

  /** 退出前立刻落盘 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    try {
      atomicWrite(this.file, JSON.stringify(this.data, null, 2))
    } catch {
      // 布局写不进去不影响使用，下次启动用默认值
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), WRITE_DEBOUNCE_MS)
  }

  private load(): Layout {
    if (!existsSync(this.file)) return structuredClone(DEFAULT_LAYOUT)
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
      return normalize(raw)
    } catch {
      return structuredClone(DEFAULT_LAYOUT)
    }
  }
}

/** 读盘时逐字段宽松校正：坏字段退回默认值，不整份作废 */
function normalize(r: Record<string, unknown>): Layout {
  const d = DEFAULT_LAYOUT
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch {
      return fallback
    }
  }
  const dim = (v: unknown, fallback: number, min: number): number =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= 20000 ? (v as number) : fallback
  const pos = (v: unknown): number | null => (Number.isInteger(v) && Math.abs(v as number) <= 100000 ? (v as number) : null)
  return {
    width: dim(r.width, d.width, 1024),
    height: dim(r.height, d.height, 640),
    x: pos(r.x),
    y: pos(r.y),
    maximized: r.maximized === true,
    sessionRailWidth: safe(() => int(r.sessionRailWidth, LAYOUT_LIMITS.sessionRail), d.sessionRailWidth),
    sessionRailCollapsed: r.sessionRailCollapsed === true,
    fileRailWidth: safe(() => int(r.fileRailWidth, LAYOUT_LIMITS.fileRail), d.fileRailWidth),
    fileRailVisible: r.fileRailVisible !== false,
    previewRailWidth: safe(() => int(r.previewRailWidth, LAYOUT_LIMITS.previewRail), d.previewRailWidth),
    previewRailVisible: r.previewRailVisible === true,
    rightRailTab: RIGHT_RAIL_TABS.includes(r.rightRailTab as RightRailTab) ? (r.rightRailTab as RightRailTab) : d.rightRailTab,
    gridMode: GRID_MODES.includes(r.gridMode as GridMode) ? (r.gridMode as GridMode) : d.gridMode,
    cells: safe(() => cells(r.cells), [null, null, null, null]),
    splitRatioH: safe(() => ratio(r.splitRatioH), d.splitRatioH),
    splitRatioV: safe(() => ratio(r.splitRatioV), d.splitRatioV)
  }
}

function int(v: unknown, range: { min: number; max: number }): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('宽度不合法')
  return Math.min(range.max, Math.max(range.min, Math.round(v)))
}

function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new Error('布局开关不合法')
  return v
}

function ratio(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('分隔比例不合法')
  return Math.min(LAYOUT_LIMITS.ratio.max, Math.max(LAYOUT_LIMITS.ratio.min, v))
}

/** 恰好 4 个元素，每个是会话 id 或 null，同一会话不能出现在两格 */
function cells(v: unknown): Cells {
  if (!Array.isArray(v) || v.length !== 4) throw new Error('格位不合法')
  const out = v.map((x) => {
    if (x === null) return null
    if (typeof x !== 'string' || !SESSION_ID_RE.test(x)) throw new Error('格位里的会话 id 不合法')
    return x
  })
  const ids = out.filter((x): x is string => x !== null)
  if (new Set(ids).size !== ids.length) throw new Error('同一会话不能放在两个格里')
  return out as Cells
}
