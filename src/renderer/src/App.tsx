import { Suspense, lazy, useEffect } from 'react'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useConfig } from './store/config'
import { useFileTree } from './store/fileTree'
import { useLayout, visibleCount } from './store/layout'
import { useSessions } from './store/sessions'
import { useUi } from './store/ui'
import { terminals, dbgHook } from './terminal/TerminalRegistry'
import { TitleBar } from './components/TitleBar'
import { SessionRail } from './components/SessionRail'
import { FileRail } from './components/FileRail'
import { Grid } from './components/Grid'
import { MenuHost } from './components/Menu'
import { PromptHost } from './components/PromptDialog'
import { ConfirmHost, notifyError } from './components/ConfirmDialog'
import { QuitDialog, useQuitRequest } from './components/QuitDialog'
import { RestoreDialog } from './components/RestoreCard'
import { focusCell, showSession } from './components/actions'
import { useRestore } from './store/restore'
import { useActivity } from './store/activity'
import { ShortcutsSheet } from './components/ShortcutsSheet'
import { confirm } from './components/ConfirmDialog'

/**
 * 不常开的大弹窗按需加载：首屏不解析它们；空闲时由 main.tsx 预取，第一次打开基本无等待。
 * 关闭确认、恢复卡片、确认框体积小且启动 / 关闭时就要用，仍随主包。
 */
const loadSettings = (): Promise<typeof import('./components/SettingsDialog')> => import('./components/SettingsDialog')
const loadPalette = (): Promise<typeof import('./components/CommandPalette')> => import('./components/CommandPalette')
const loadWorkspaceDialog = (): Promise<typeof import('./components/WorkspaceDialog')> => import('./components/WorkspaceDialog')
const loadHistory = (): Promise<typeof import('./components/HistoryDialog')> => import('./components/HistoryDialog')
const SettingsDialog = lazy(() => loadSettings().then((m) => ({ default: m.SettingsDialog })))
const HistoryDialog = lazy(() => loadHistory().then((m) => ({ default: m.HistoryDialog })))
const CommandPalette = lazy(() => loadPalette().then((m) => ({ default: m.CommandPalette })))
const WorkspaceDialog = lazy(() => loadWorkspaceDialog().then((m) => ({ default: m.WorkspaceDialog })))

export function preloadDialogs(): void {
  void loadSettings()
  void loadPalette()
  void loadWorkspaceDialog()
  void loadHistory()
}

/**
 * 应用级快捷键（UI设计约束 §5）。在窗口捕获阶段处理：焦点在终端里也生效，
 * 处理过的按键不会再交给 xterm，也就不会进 PTY（PRD T-18：只拦 Ctrl+Shift 组合与少数应用键）。
 */
/** 终端字号（PRD T-14）：±1，0 = 复位；写进设置，所有终端同步 */
function bumpFont(delta: number): void {
  const cur = useConfig.getState().config?.settings.fontSize ?? DEFAULT_SETTINGS.fontSize
  const next = delta === 0 ? DEFAULT_SETTINGS.fontSize : Math.min(24, Math.max(10, cur + delta))
  if (next !== cur) void useConfig.getState().updateSettings({ fontSize: next }).catch((err: unknown) => notifyError(err))
}

function onShortcut(e: KeyboardEvent): void {
  if (!e.ctrlKey || e.altKey || e.metaKey) return
  const l = useLayout.getState()
  const ui = useUi.getState()
  const count = visibleCount(l)
  const code = e.code
  if (code === 'Tab') {
    // Ctrl+Tab / Ctrl+Shift+Tab：在可见格之间循环
    if (count < 2) return
    focusCell((l.focused + (e.shiftKey ? count - 1 : 1)) % count)
  } else if (!e.shiftKey && code === 'Comma') {
    ui.openSettings()
  } else if (!e.shiftKey && code === 'Slash') {
    // 快捷键速查（升级建议 3.6）
    ui.setShortcutsOpen(!ui.shortcutsOpen)
  } else if (code === 'Equal' || code === 'NumpadAdd') {
    // Ctrl+= 与 Ctrl++（Shift+=）都放大
    bumpFont(1)
  } else if (!e.shiftKey && (code === 'Minus' || code === 'NumpadSubtract')) {
    bumpFont(-1)
  } else if (!e.shiftKey && (code === 'Digit0' || code === 'Numpad0')) {
    bumpFont(0)
  } else if (!e.shiftKey) {
    return
  } else if (code === 'KeyK') {
    ui.setPaletteOpen(!ui.paletteOpen)
  } else if (code === 'KeyH') {
    // 会话历史（会话管理升级计划 §3.5）
    if (ui.history) ui.closeHistory()
    else ui.openHistory()
  } else if (code === 'KeyF') {
    // 终端内搜索（PRD T-12）：只对聚焦格里有会话时生效
    if (!l.cells[l.focused]) return
    ui.setSearchCell(l.focused)
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-search-cell="${l.focused}"] input`)?.focus())
  } else if (code === 'KeyI') {
    // 长文本输入框（升级建议 4.2）：按格手动打开，发完自动收起
    if (!l.cells[l.focused]) return
    ui.setComposerCell(ui.composerCell === l.focused ? null : l.focused)
  } else if (e.code === 'KeyB') {
    l.toggleRail()
  } else if (e.code === 'KeyE') {
    l.toggleFileRail()
  } else if (e.code === 'KeyD') {
    l.cycleGridMode()
  } else if (/^Digit[1-4]$/.test(e.code)) {
    const n = Number(e.code.slice(5)) - 1
    if (n >= count) return
    focusCell(n)
  } else {
    return
  }
  e.preventDefault()
  e.stopPropagation()
}

/**
 * 主窗口：标题栏 + 会话栏 + 目录栏 + 宫格控制台（UI设计约束 §3）。托盘与恢复在 M4。
 */
export default function App(): React.JSX.Element {
  const loadConfig = useConfig((s) => s.load)
  const config = useConfig((s) => s.config)
  const init = useSessions((s) => s.init)
  const sessions = useSessions((s) => s.sessions)
  const sessionsReady = useSessions((s) => s.ready)
  const selectedWorkspaceId = useSessions((s) => s.selectedWorkspaceId)
  const selectWorkspace = useSessions((s) => s.selectWorkspace)
  const loadLayout = useLayout((s) => s.load)
  const layoutLoaded = useLayout((s) => s.loaded)
  const prune = useLayout((s) => s.prune)
  const dialog = useUi((s) => s.workspaceDialog)
  const closeDialog = useUi((s) => s.closeDialog)
  const settingsOpen = useUi((s) => s.settingsTab !== null)
  const paletteOpen = useUi((s) => s.paletteOpen)
  const historyOpen = useUi((s) => s.history !== null)

  useEffect(() => {
    void loadConfig()
    void loadLayout()
    let off: (() => void) | null = null
    let cancelled = false
    void init().then((unsub) => {
      if (cancelled) unsub()
      else off = unsub
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [loadConfig, loadLayout, init])

  // 主题切换时同步终端配色（data-theme 由 main.tsx 维护）
  useEffect(() => {
    const observer = new MutationObserver(() => {
      terminals.applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  // 活动指示（升级建议 2.1）与目录栏「有更新」（3.7）：主进程推送，渲染层只镜像
  useEffect(() => {
    let offActivity: (() => void) | null = null
    let cancelled = false
    void useActivity
      .getState()
      .init()
      .then((off) => {
        if (cancelled) off()
        else offActivity = off
      })
    const offFs = window.warp.fs.onChanged((id) => useFileTree.getState().markStale(id))
    return () => {
      cancelled = true
      offActivity?.()
      offFs()
    }
  }, [])

  // 广播输入（升级建议 3.4）：聚焦格里的键入同时发给其余可见格中运行着、没被排除的会话
  const broadcast = useUi((s) => s.broadcast)
  useEffect(() => {
    if (!broadcast) {
      terminals.setInputHook(null)
      return
    }
    terminals.setInputHook((id, data) => {
      const l = useLayout.getState()
      if (l.cells[l.focused] !== id) return false
      const ui = useUi.getState()
      const live = new Set(useSessions.getState().sessions.filter((s) => s.status === 'running' || s.status === 'starting').map((s) => s.id))
      for (let i = 0; i < visibleCount(l); i++) {
        const sid = l.cells[i]
        if (sid && live.has(sid) && (sid === id || !ui.broadcastExcluded[sid])) {
          dbgHook.writes.push(`${sid}:${data}`)
          window.warp.session.write(sid, data)
        }
      }
      return true
    })
    return () => terminals.setInputHook(null)
  }, [broadcast])

  // 上次没结束的 agent 进程（升级建议 1.1）：pid 与可执行文件都对得上才列出；只提示，用户确认后才结束
  useEffect(() => {
    void (async () => {
      const list = await window.warp.app.orphans().catch(() => [])
      if (!list.length) return
      const ok = await confirm({
        title: `上次有 ${list.length} 个 agent 进程没结束`,
        body: list.map((o) => `${o.title || '未命名会话'} · PID ${o.pid} · ${o.exe}`).join('\n'),
        okLabel: '结束这些进程',
        cancelLabel: '不管它们',
        danger: true
      })
      if (ok) {
        const n = await window.warp.app.killOrphans(list.map((o) => o.pid)).catch((e: unknown) => {
          notifyError(e, '结束失败')
          return 0
        })
        if (n < list.length) notifyError(new Error(`结束了 ${n} 个，其余的进程已退出或已不是原来的程序`), '部分进程没有结束')
      } else {
        await window.warp.app.dismissOrphans().catch(() => undefined)
      }
    })()
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', onShortcut, true)
    return () => window.removeEventListener('keydown', onShortcut, true)
  }, [])

  // 窗口宽度：多格时控制台不够宽就临时收栏（store/layout railsOf）
  useEffect(() => {
    const onResize = (): void => useLayout.getState().setViewport(window.innerWidth)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 主进程列表里已经没有的会话：释放 xterm 实例、从格里清掉。
  // 布局读回来之前不清，否则渲染层重载后格位会被误清（会话其实还在主进程里）
  useEffect(() => {
    const ids = new Set(sessions.map((s) => s.id))
    terminals.retain(ids)
    if (layoutLoaded && sessionsReady) prune(ids)
  }, [sessions, sessionsReady, layoutLoaded, prune])

  // 关闭确认、托盘点会话（技术设计 §5.7）
  useEffect(() => {
    const offQuit = window.warp.app.onQuitRequested((live) => useQuitRequest.getState().show(live))
    const offTray = window.warp.tray.onShowSession((id) => {
      const s = useSessions.getState().sessions.find((x) => x.id === id)
      if (s) showSession(s)
    })
    return () => {
      offQuit()
      offTray()
    }
  }, [])

  // 一键恢复（PRD S-07 / S-08）：配置、布局、会话列表都就绪后读候选；设置为自动恢复时只拉起上次没正常退出的
  const settingsReady = config !== null
  useEffect(() => {
    if (!settingsReady || !layoutLoaded || !sessionsReady) return
    let cancelled = false
    void (async () => {
      await useRestore.getState().load()
      if (cancelled || !useConfig.getState().config?.settings.restoreOnStartup) return
      const failures = await useRestore.getState().restore({ onlyUnfinished: true })
      if (failures.length) notifyError(new Error(failures.join('\n')), `有 ${failures.length} 个会话没能自动恢复`)
    })()
    return () => {
      cancelled = true
    }
  }, [settingsReady, layoutLoaded, sessionsReady])

  // 「续接上次对话启动」菜单项的数据（PRD S-10）：会话变化后刷新
  useEffect(() => {
    if (sessionsReady) void useRestore.getState().refreshResumable()
  }, [sessions, sessionsReady])

  // 工作区被删：丢掉目录树缓存，取消选中
  useEffect(() => {
    if (!config) return
    const ids = new Set(config.workspaces.map((w) => w.id))
    useFileTree.getState().retain(ids)
    if (selectedWorkspaceId && !ids.has(selectedWorkspaceId)) selectWorkspace(null)
  }, [config, selectedWorkspaceId, selectWorkspace])

  return (
    <div className="flex h-full flex-col bg-canvas font-sans text-ink">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <SessionRail />
        <FileRail />
        <Grid />
      </div>
      {/* 各自一个 Suspense：一个还在加载时不会把另一个已打开的弹窗藏起来 */}
      <Suspense fallback={null}>{dialog && <WorkspaceDialog state={dialog} onClose={closeDialog} />}</Suspense>
      <Suspense fallback={null}>{settingsOpen && <SettingsDialog />}</Suspense>
      <Suspense fallback={null}>{paletteOpen && <CommandPalette />}</Suspense>
      <Suspense fallback={null}>{historyOpen && <HistoryDialog />}</Suspense>
      <PromptHost />
      <RestoreDialog />
      <QuitDialog />
      <ShortcutsSheet />
      <ConfirmHost />
      <MenuHost />
    </div>
  )
}
