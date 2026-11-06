import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import type { SessionData, Settings } from '@shared/types'
import { useConfig } from '../store/config'
import { useSessions } from '../store/sessions'
import { railsOf, useLayout } from '../store/layout'

/**
 * 每个会话一个 xterm 实例，切走不销毁（技术设计 §6.2）：
 * - 不在格里的会话挂在屏外的隐藏池里，输出照常写入，xterm 自己暂停渲染
 * - 挂载 = 把容器节点挪进格的宿主节点，不 open() 第二次
 * - WebGL 只给挂载中的会话加载，卸载即释放上下文
 */

const THEMES: Record<'light' | 'dark', ITheme> = {
  light: {
    background: '#ffffff',
    foreground: '#2b3142',
    cursor: '#1b1f2e',
    cursorAccent: '#ffffff',
    selectionBackground: '#cfdcf7',
    black: '#2b3142',
    red: '#b91c1c',
    green: '#15803d',
    yellow: '#92400e',
    blue: '#1d4ed8',
    magenta: '#7c3aed',
    cyan: '#0e7490',
    white: '#5f6678',
    brightBlack: '#6b7280',
    brightRed: '#dc2626',
    brightGreen: '#16a34a',
    brightYellow: '#a16207',
    brightBlue: '#2563eb',
    brightMagenta: '#9333ea',
    brightCyan: '#0891b2',
    brightWhite: '#1b1f2e'
  },
  dark: {
    background: '#0f1419',
    foreground: '#e4e8f0',
    cursor: '#f1f4f9',
    cursorAccent: '#0f1419',
    selectionBackground: '#2b4170',
    black: '#3a4556',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#fbbf24',
    blue: '#7aa7ff',
    magenta: '#c4a1ff',
    cyan: '#5eead4',
    white: '#a3acbc',
    brightBlack: '#6b7689',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#a5c3ff',
    brightMagenta: '#ddc8ff',
    brightCyan: '#99f6e4',
    brightWhite: '#f1f4f9'
  }
}

type Slot = {
  term: Terminal
  fit: FitAddon
  /** 终端内搜索（PRD T-12） */
  search: SearchAddon
  el: HTMLDivElement
  webgl: WebglAddon | null
  /** 已写入的输出属于第几代进程、写到了第几个字符 */
  gen: number
  end: number
  /** 回放完成前到达的事件先排队 */
  ready: boolean
  queue: SessionData[]
  mounted: boolean
  cols: number
  rows: number
  copyTimer: number | null
  /** 视口是否停在最底部；不在底部时有新输出记为 unseen（升级建议 4.1） */
  atBottom: boolean
  unseen: boolean
  scrollListeners: Set<(s: ScrollState) => void>
}

export type ScrollState = { atBottom: boolean; unseen: boolean }

/** 输入钩子（广播输入，升级建议 3.4）：返回 true = 已处理，不再按普通方式写入 */
let inputHook: ((id: string, data: string) => boolean) | null = null
/** 调试计数：onData 触发次数与 hook 拦截次数，返回 false 时记下当时的格位快照（验证脚本用） */
export const dbgHook = {
  calls: 0,
  handled: 0,
  lastMiss: null as string | null,
  writes: [] as string[],
  drops: [] as string[]
}

function emitScroll(slot: Slot): void {
  const st = { atBottom: slot.atBottom, unseen: slot.unseen }
  for (const cb of slot.scrollListeners) cb(st)
}

/**
 * 终端里的文件路径（升级建议 2.6）：相对路径（含 / 或带 :行号）与 Windows 绝对路径，可带 :行号[:列号]。
 * 只按文本形状识别，点了由主进程校验是否在工作区内，越界拒绝。
 */
const PATH_RE =
  /(?:[A-Za-z]:[\\/](?:[^\s:'"<>|*?`]+[\\/])*[^\s:'"<>|*?`]+|(?:\.{1,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8}|[\w.@-]+\.[A-Za-z0-9]{1,8}(?=:\d))(?::(\d+))?(?::\d+)?/g

function pathLinks(id: string, term: Terminal): void {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
      const links = []
      PATH_RE.lastIndex = 0
      for (let m = PATH_RE.exec(text); m; m = PATH_RE.exec(text)) {
        let raw = m[0]
        // URL 交给 WebLinks；尾部标点不算路径
        if (/^[a-z]+:\/\//i.test(text.slice(Math.max(0, m.index - 8), m.index + raw.length))) continue
        raw = raw.replace(/[.,;)\]]+$/, '')
        const line = m[1] ? Number(m[1]) : null
        const path = raw.replace(/(?::\d+){1,2}$/, '')
        links.push({
          range: { start: { x: m.index + 1, y }, end: { x: m.index + raw.length, y } },
          text: raw,
          decorations: { pointerCursor: true, underline: true },
          activate: () => {
            const ws = useSessions.getState().sessions.find((x) => x.id === id)?.workspaceId
            if (ws) void window.warp.fs.openInEditor(ws, path, line).catch(() => undefined)
          }
        })
      }
      callback(links.length ? links : undefined)
    }
  })
}

/**
 * WebGL 插件单独成块、按需加载：首屏不解析它；第一次挂载终端时开始加载，
 * 加载完成前先用 DOM 渲染器顶上，到了再补挂（main.tsx 在空闲时也会预取一次）。
 */
type WebglCtor = typeof import('@xterm/addon-webgl').WebglAddon
let webglCtor: WebglCtor | null = null
let webglLoading: Promise<WebglCtor | null> | null = null

export function preloadWebgl(): Promise<WebglCtor | null> {
  webglLoading ??= import('@xterm/addon-webgl').then(
    (m) => (webglCtor = m.WebglAddon),
    () => null
  )
  return webglLoading
}

function attachWebgl(id: string, slot: Slot): void {
  if (slot.webgl || !slot.mounted || slots.get(id) !== slot) return
  if (!webglCtor) {
    void preloadWebgl().then(() => {
      if (!webglCtor) return
      attachWebgl(id, slot)
      // 换了渲染器，字符格尺寸可能差一点：重新算一次行列
      slot.cols = -1
      syncSize(id, slot)
    })
    return
  }
  try {
    const webgl = new webglCtor()
    webgl.onContextLoss(() => {
      webgl.dispose()
      slot.webgl = null
    })
    slot.term.loadAddon(webgl)
    slot.webgl = webgl
  } catch {
    // 驱动不支持 WebGL 时退回 DOM 渲染器
    slot.webgl = null
  }
}

const slots = new Map<string, Slot>()
let pool: HTMLDivElement | null = null
let unsubscribe: (() => void) | null = null

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function ensurePool(): HTMLDivElement {
  if (!pool) {
    pool = document.createElement('div')
    pool.className = 'terminal-pool'
    pool.setAttribute('aria-hidden', 'true')
    document.body.appendChild(pool)
  }
  return pool
}

function ensureSubscribed(): void {
  if (unsubscribe) return
  unsubscribe = window.warp.session.onData((d) => {
    const slot = slots.get(d.id)
    if (!slot) return
    if (!slot.ready) slot.queue.push(d)
    else apply(slot, d, d.id)
  })
}

/** 按 gen / end 衔接回放与实时事件：旧代丢弃，新代清屏，重叠部分只写尾巴 */
function apply(slot: Slot, d: SessionData, id = ''): void {
  if (d.gen < slot.gen) {
    dbgHook.drops.push(`${id} oldgen ${d.gen}<${slot.gen}`)
    return
  }
  if (d.gen > slot.gen) {
    slot.term.reset()
    slot.gen = d.gen
    slot.end = 0
  }
  if (d.end <= slot.end) {
    dbgHook.drops.push(`${id} dup end=${d.end} slotEnd=${slot.end}`)
    return
  }
  const start = d.end - d.chunk.length
  if (start < slot.end) dbgHook.drops.push(`${id} slice start=${start} slotEnd=${slot.end} end=${d.end}`)
  slot.term.write(start < slot.end ? d.chunk.slice(slot.end - start) : d.chunk)
  slot.end = d.end
}

function copySelection(term: Terminal): void {
  const text = term.getSelection()
  if (text) void window.warp.clipboard.write(text)
}

async function paste(term: Terminal): Promise<void> {
  const text = await window.warp.clipboard.read()
  // paste() 会按 bracketed paste 模式包裹，agent 能区分粘贴与键入
  if (text) {
    term.paste(text)
    return
  }
  // 剪贴板不是文本：试试图片（截图粘给能读图的 agent，路径作为文本送进终端）
  try {
    const file = await window.warp.clipboard.readImage()
    if (file) term.paste(file)
  } catch {
    // 读图失败就当没东西可粘
  }
}

function create(id: string): Slot {
  ensureSubscribed()
  const settings = useConfig.getState().config?.settings
  const el = document.createElement('div')
  el.className = 'terminal-host'
  ensurePool().appendChild(el)

  const term = new Terminal({
    fontFamily: settings?.fontFamily,
    fontSize: settings?.fontSize ?? 13,
    lineHeight: settings?.lineHeight ?? 1.5,
    scrollback: settings?.scrollback ?? 5000,
    cursorBlink: settings?.cursorBlink ?? true,
    cursorStyle: settings?.cursorStyle ?? 'block',
    theme: THEMES[currentTheme()]
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon((_e, uri) => void window.warp.shell.openUrl(uri).catch(() => undefined)))
  term.open(el)

  const slot: Slot = {
    term,
    fit,
    search,
    el,
    webgl: null,
    gen: 0,
    end: 0,
    ready: false,
    queue: [],
    mounted: false,
    cols: term.cols,
    rows: term.rows,
    copyTimer: null,
    atBottom: true,
    unseen: false,
    scrollListeners: new Set()
  }
  slots.set(id, slot)
  pathLinks(id, term)

  term.onData((data) => {
    dbgHook.calls++
    const hook = inputHook
    if (hook && hook(id, data)) {
      dbgHook.handled++
      return
    }
    if (hook) {
      const l = useLayout.getState()
      dbgHook.lastMiss = `id=${id} focused=${l.focused} cells=${JSON.stringify(l.cells)}`
    }
    window.warp.session.write(id, data)
  })
  term.onScroll(() => {
    const b = term.buffer.active
    const atBottom = b.viewportY >= b.baseY
    if (atBottom === slot.atBottom) return
    slot.atBottom = atBottom
    if (atBottom) slot.unseen = false
    emitScroll(slot)
  })
  term.onWriteParsed(() => {
    const b = term.buffer.active
    const atBottom = b.viewportY >= b.baseY
    if (!atBottom && !slot.unseen) {
      slot.atBottom = false
      slot.unseen = true
      emitScroll(slot)
    }
  })

  // 快捷键规则（PRD T-07 / T-18）：只拦 Ctrl+Shift 组合与「有选区的 Ctrl+C」，其余交给 agent；
  // 设置开了 pasteOnCtrlV 时 Ctrl+V 也粘贴（抢占 agent 的 quoted-insert / 翻页键）
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    const key = e.key.toLowerCase()
    if (e.ctrlKey && e.shiftKey && !e.altKey && (key === 'c' || key === 'v')) {
      e.preventDefault()
      if (key === 'c') copySelection(term)
      else void paste(term)
      return false
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'v') {
      // Ctrl+V：zustand 的 config 里 pasteOnCtrlV 是 true 才拦；
      // 没开（false）或 config 还没加载（null）就放行走原行为（quoted-insert / PageDown）
      const memCfg = useConfig.getState().config
      if (memCfg?.settings.pasteOnCtrlV === true) {
        e.preventDefault()
        void paste(term)
        return false
      }
      // 没开 → 不拦
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'c' && term.hasSelection()) {
      e.preventDefault()
      copySelection(term)
      term.clearSelection()
      return false
    }
    return true
  })

  // 右键：有选区复制，无选区粘贴（技术设计 §6.5）
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (term.hasSelection()) {
      copySelection(term)
      term.clearSelection()
    } else {
      void paste(term)
    }
  })

  // 选中即复制：拖选时选区连续变化，停下 150ms 再写剪贴板
  term.onSelectionChange(() => {
    if (!useConfig.getState().config?.settings.copyOnSelect) return
    if (slot.copyTimer !== null) window.clearTimeout(slot.copyTimer)
    slot.copyTimer = window.setTimeout(() => {
      slot.copyTimer = null
      if (term.hasSelection()) copySelection(term)
    }, 150)
  })

  void window.warp.session
    .buffer(id)
    .then((b) => {
      if (slots.get(id) !== slot) return
      if (b) {
        slot.gen = b.gen
        if (b.data) term.write(b.data)
        slot.end = b.end
      }
    })
    .finally(() => {
      if (slots.get(id) !== slot) return
      slot.ready = true
      for (const d of slot.queue) apply(slot, d, d.id)
      slot.queue = []
    })

  return slot
}

function syncSize(id: string, slot: Slot): void {
  if (!slot.mounted) return
  try {
    slot.fit.fit()
  } catch {
    // 宿主尺寸为 0 时 fit 会失败，下次 ResizeObserver 回调再来
    return
  }
  if (slot.term.cols !== slot.cols || slot.term.rows !== slot.rows) {
    slot.cols = slot.term.cols
    slot.rows = slot.term.rows
    window.warp.session.resize(id, slot.cols, slot.rows)
  }
}

export const terminals = {
  mount(id: string, host: HTMLElement): void {
    const slot = slots.get(id) ?? create(id)
    host.appendChild(slot.el)
    slot.mounted = true
    attachWebgl(id, slot)
    // 挂载后强制同步一次尺寸：后台期间 PTY 尺寸可能和格子不一致
    slot.cols = -1
    syncSize(id, slot)
  },

  unmount(id: string, host: HTMLElement): void {
    const slot = slots.get(id)
    if (!slot || slot.el.parentElement !== host) return
    ensurePool().appendChild(slot.el)
    slot.mounted = false
    slot.webgl?.dispose()
    slot.webgl = null
  },

  fit(id: string): void {
    const slot = slots.get(id)
    if (slot) syncSize(id, slot)
  },

  focus(id: string): void {
    slots.get(id)?.term.focus()
  },

  clear(id: string): void {
    slots.get(id)?.term.clear()
  },

  /** 会话重启后 gen 加一：先清屏，免得新进程的输出叠在旧画面上 */
  syncGen(id: string, gen: number): void {
    const slot = slots.get(id)
    if (!slot || !slot.ready || gen <= slot.gen) return
    slot.term.reset()
    slot.gen = gen
    slot.end = 0
  },

  dispose(id: string): void {
    const slot = slots.get(id)
    if (!slot) return
    if (slot.copyTimer !== null) window.clearTimeout(slot.copyTimer)
    slot.webgl?.dispose()
    slot.term.dispose()
    slot.el.remove()
    slots.delete(id)
  },

  /** 会话已不在主进程列表里的实例全部释放 */
  retain(ids: Set<string>): void {
    for (const id of [...slots.keys()]) if (!ids.has(id)) this.dispose(id)
  },

  applyTheme(theme: 'light' | 'dark'): void {
    for (const slot of slots.values()) slot.term.options.theme = THEMES[theme]
  },

  /** 设置页改了字号 / 字体 / 滚动行数：已有终端立即生效，挂载中的重新算行列 */
  applySettings(s: Pick<Settings, 'fontSize' | 'fontFamily' | 'scrollback' | 'lineHeight' | 'cursorStyle' | 'cursorBlink'>): void {
    for (const [id, slot] of slots) {
      const o = slot.term.options
      o.cursorStyle = s.cursorStyle
      o.cursorBlink = s.cursorBlink
      if (o.fontSize === s.fontSize && o.fontFamily === s.fontFamily && o.scrollback === s.scrollback && o.lineHeight === s.lineHeight) continue
      o.fontSize = s.fontSize
      o.fontFamily = s.fontFamily
      o.scrollback = s.scrollback
      o.lineHeight = s.lineHeight
      if (slot.mounted) {
        slot.cols = -1
        syncSize(id, slot)
      }
    }
  },

  /** 在滚动缓冲区里找下一个 / 上一个匹配（PRD T-12），找到时选中；返回是否找到 */
  find(id: string, query: string, backwards = false): boolean {
    const slot = slots.get(id)
    if (!slot || !query) return false
    const opts = { caseSensitive: false, incremental: false }
    return backwards ? slot.search.findPrevious(query, opts) : slot.search.findNext(query, opts)
  },

  clearFind(id: string): void {
    const slot = slots.get(id)
    if (!slot) return
    slot.search.clearDecorations()
    slot.term.clearSelection()
  },

  /** 滚动状态订阅（「↓ 新输出」按钮）；立即回调一次当前值 */
  onScroll(id: string, cb: (s: ScrollState) => void): () => void {
    const slot = slots.get(id)
    if (!slot) return () => undefined
    slot.scrollListeners.add(cb)
    cb({ atBottom: slot.atBottom, unseen: slot.unseen })
    return () => slot.scrollListeners.delete(cb)
  },

  scrollToBottom(id: string): void {
    const slot = slots.get(id)
    if (!slot) return
    slot.term.scrollToBottom()
    slot.atBottom = true
    slot.unseen = false
    emitScroll(slot)
  },

  /** 广播输入的钩子；null = 关闭 */
  setInputHook(fn: ((id: string, data: string) => boolean) | null): void {
    inputHook = fn
  },

  /** 以 bracketed paste 发送多行文本（长文本输入框，升级建议 4.2）；agent 没开 bracketed paste 时 xterm 原样发送 */
  paste(id: string, text: string): void {
    slots.get(id)?.term.paste(text)
  },

  /** 供验证脚本读取可见文本；导出终端内容也用它（已是纯文本，不含控制符） */
  text(id: string): string {
    const slot = slots.get(id)
    if (!slot) return ''
    const buf = slot.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n')
  }
}

/**
 * 验证脚本用的只读钩子：WebGL 渲染时 DOM 里没有终端文字，harness 只能从这里读。
 * 只读渲染层自己的缓冲区，不暴露任何主进程能力。
 * 只在主进程判定的调试模式下挂（window.warp.debug：开发期且 MILE_WARP_DEBUG=1）；打包后与普通启动都没有。
 */
if (window.warp.debug) {
  ;(
    window as unknown as {
      __warpDebug?: {
        text: (id: string) => string
        size: (id: string) => { cols: number; rows: number } | null
        font: (id: string) => { size: number; family: string } | null
        selection: (id: string) => string
        layout: () => Record<string, unknown>
        inputHookActive: () => boolean
        hookStats: () => { calls: number; handled: number; lastMiss: string | null; writes: string[]; drops: string[] }
        sessionStore: () => { id: string; status: string }[]
      }
    }
  ).__warpDebug = {
    text: (id) => terminals.text(id),
    size: (id) => {
      const slot = slots.get(id)
      return slot ? { cols: slot.term.cols, rows: slot.term.rows } : null
    },
    font: (id) => {
      const slot = slots.get(id)
      return slot ? { size: slot.term.options.fontSize ?? 0, family: slot.term.options.fontFamily ?? '' } : null
    },
    selection: (id) => slots.get(id)?.term.getSelection() ?? '',
    layout: () => {
      const l = useLayout.getState()
      const { viewport, fileOverride, railOverride, fileRailVisible, fileRailWidth, sessionRailWidth, sessionRailCollapsed, gridMode, cells, focused } = l
      return { viewport, fileOverride, railOverride, fileRailVisible, fileRailWidth, sessionRailWidth, sessionRailCollapsed, gridMode, cells, focused, ...railsOf(l) }
    },
    inputHookActive: () => inputHook !== null,
    hookStats: () => ({ ...dbgHook, writes: [...dbgHook.writes], drops: [...dbgHook.drops] }),
    sessionStore: () => useSessions.getState().sessions.map((s) => ({ id: s.id, status: s.status }))
  }
}

// 设置变化时同步到所有终端（字号快捷键、设置页）
useConfig.subscribe((s, prev) => {
  const a = s.config?.settings
  const b = prev.config?.settings
  if (
    a &&
    (a.fontSize !== b?.fontSize ||
      a.fontFamily !== b?.fontFamily ||
      a.scrollback !== b?.scrollback ||
      a.lineHeight !== b?.lineHeight ||
      a.cursorStyle !== b?.cursorStyle ||
      a.cursorBlink !== b?.cursorBlink)
  )
    terminals.applySettings(a)
})
