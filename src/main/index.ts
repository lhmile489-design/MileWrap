import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, screen, shell, type IpcMainInvokeEvent } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { CH } from '@shared/channels'
import type { HistoryResumeResult, Layout, SessionData } from '@shared/types'
import { dirKey } from '@shared/path'
import { LayoutStore } from './services/LayoutStore'
import { ConfigStore, sanitizeSettingsPatch } from './services/ConfigStore'
import { TrayService } from './services/TrayService'
import { AgentService } from './services/AgentService'
import { SessionService } from './services/SessionService'
import { WorkspaceService } from './services/WorkspaceService'
import { WorkspaceIcons } from './services/WorkspaceIcons'
import { FileTreeService } from './services/FileTreeService'
import { FilePreviewService } from './services/FilePreviewService'
import { SkillsService } from './services/SkillsService'
import { installFromGithub, installFromZip, parseGithubUrl } from './lib/githubInstall'
import { GitInfoService } from './services/GitInfoService'
import { GitService } from './services/GitService'
import { HISTORY_ID_RE, SessionHistoryService } from './services/SessionHistory'
import { openExternalTerminal } from './platform/win32/terminal'
import { initLog, log, logDir } from './lib/log'
import { countBadge } from './lib/badge'
import { editorExe, openInEditor } from './lib/editor'

let mainWindow: BrowserWindow | null = null
let quitting = false
/** 渲染进程最近 1 分钟内的崩溃时间（升级建议 1.3）：连续 3 次就不再自动重载 */
let rendererCrashes: number[] = []
/** 第二个实例启动时把已有窗口带回前台（whenReady 后赋值） */
let secondInstance: () => void = () => undefined

const CELL_COUNT = { single: 1, dual: 2, quad: 4 } as const

// 配置目录覆盖：MILE_WARP_DATA_DIR 指定一个绝对路径时，配置、布局与 Chromium 缓存都放在那里
// （隔离测试安装包、便携使用）。Windows 上 appData 取自系统已知文件夹，改 APPDATA 环境变量不生效
const dataDir = process.env['MILE_WARP_DATA_DIR']
if (dataDir && isAbsolute(dataDir)) {
  app.setPath('appData', dataDir)
  app.setPath('userData', join(dataDir, 'mile-warp'))
}

// 单实例锁只在打包后启用：开发期与 harness 会并行起多个实例（技术设计 §5.6）
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.exit(0)
}
app.on('second-instance', () => secondInstance())

/** 推送一律走这里：窗口销毁后输出仍在推，直接 send 会抛 Object has been destroyed */
function sendToRenderer(channel: string, payload: unknown): void {
  const win = mainWindow
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

/** IPC 只认主窗口主框架（技术设计 §8 第 6 条） */
function isTrustedSender(e: { sender: Electron.WebContents; senderFrame: Electron.WebFrameMain | null }): boolean {
  const win = mainWindow
  if (!win || win.isDestroyed()) return false
  return e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame
}

function handle(channel: string, fn: (arg: unknown, e: IpcMainInvokeEvent) => unknown): void {
  ipcMain.handle(channel, async (e, arg: unknown) => {
    if (!isTrustedSender(e)) {
      log('ipc.untrusted', { channel })
      throw new Error('不受信任的调用方')
    }
    try {
      return await fn(arg, e)
    } catch (err) {
      log('ipc.reject', { channel, reason: err instanceof Error ? err.message : String(err) })
      throw err
    }
  })
}

function on(channel: string, fn: (arg: unknown) => void): void {
  ipcMain.on(channel, (e, arg: unknown) => {
    if (!isTrustedSender(e)) return
    fn(arg)
  })
}

function obj(arg: unknown): Record<string, unknown> {
  return arg && typeof arg === 'object' ? (arg as Record<string, unknown>) : {}
}

function sessionIdOf(arg: unknown): string {
  const id = obj(arg).id
  if (typeof id !== 'string' || !/^s\d+-[a-z0-9]+$/.test(id)) throw new Error('会话 id 不合法')
  return id
}

function dims(arg: unknown): { cols?: number; rows?: number } {
  const r = obj(arg)
  const n = (v: unknown): number | undefined => (Number.isInteger(v) ? (v as number) : undefined)
  return { cols: n(r.cols), rows: n(r.rows) }
}

/** 应用图标 PNG：开发期在仓库 resources/，打包后经 extraResources 放在 resources 目录下 */
function appIconPath(): string {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../resources/icon.png')
}

/** 上次的窗口位置还在某块屏幕上才沿用；拔掉副屏后不让窗口开到屏幕外 */
function visiblePosition(l: Layout): { x?: number; y?: number } {
  if (l.x === null || l.y === null) return {}
  const { x, y } = l
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return x + 100 > a.x && x < a.x + a.width - 100 && y >= a.y - 8 && y < a.y + a.height - 40
  })
  return onScreen ? { x, y } : {}
}

function createWindow(layoutStore: LayoutStore): void {
  const l = layoutStore.get()
  mainWindow = new BrowserWindow({
    width: l.width,
    height: l.height,
    ...visiblePosition(l),
    // 任务栏与 Alt+Tab 用的窗口图标；打包后 exe 自身图标来自 build/icon.ico
    icon: appIconPath(),
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1219' : '#f6f7fb',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (l.maximized) mainWindow?.maximize()
    mainWindow?.show()
  })
  // 窗口尺寸位置记忆（PRD S-03）；最大化时只记标志，还原尺寸保留最大化之前的
  const win = mainWindow
  const saveBounds = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return
    const b = win.getNormalBounds()
    layoutStore.setBounds({ ...b, maximized: win.isMaximized() })
  }
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('maximize', saveBounds)
  win.on('unmaximize', saveBounds)
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('focus', () => win.flashFrame(false))
  // 渲染进程崩溃（升级建议 1.3）：会话还在主进程里跑，重载后布局从 window-state.json、画面从 session:buffer 回放。
  // 1 分钟内第 3 次崩溃就停下，让用户决定，免得无限重载
  win.webContents.on('render-process-gone', (_e, details) => {
    log('renderer.gone', { reason: details.reason, exitCode: details.exitCode })
    if (details.reason === 'clean-exit' || quitting || win.isDestroyed()) return
    const now = Date.now()
    rendererCrashes = rendererCrashes.filter((t) => now - t < 60_000)
    rendererCrashes.push(now)
    if (rendererCrashes.length < 3) {
      win.webContents.reload()
      return
    }
    void dialog
      .showMessageBox(win, {
        type: 'error',
        title: 'Mile Warp',
        message: '界面连续崩溃了 3 次',
        detail: '运行中的会话没有受影响。可以重新加载界面，或者打开日志目录看看原因。',
        buttons: ['重新加载', '打开日志目录'],
        defaultId: 0,
        noLink: true
      })
      .then((r) => {
        rendererCrashes = []
        if (r.response === 1) {
          const dir = logDir()
          if (dir) void shell.openPath(dir)
        }
        if (!win.isDestroyed()) win.webContents.reload()
      })
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (!dev || !url.startsWith(dev)) e.preventDefault()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.setAppUserModelId('com.mile.warp')

app.whenReady().then(() => {
  initLog(join(app.getPath('appData'), 'mile-warp', 'logs'))
  log('app.start', { version: app.getVersion(), packaged: app.isPackaged })
  const config = new ConfigStore(join(app.getPath('appData'), 'mile-warp'))
  const agents = new AgentService()
  agents.setCustomSource(() => config.get().customAgents)
  // 开发期验证脚本可把 agent 会话目录指到沙箱（打包后不认这个变量，只读真实主目录）
  const agentHome = !app.isPackaged ? process.env['MILE_WARP_AGENT_HOME'] || undefined : undefined
  const sessions = new SessionService(config, agents, agentHome)
  const history = new SessionHistoryService(agentHome, () => sessions.liveResumeIds())
  const testSave = !app.isPackaged ? process.env['MILE_WARP_TEST_SAVE'] || undefined : undefined
  // MILE_WARP_TEST_ICON：开发期验证脚本用来绕过系统文件对话框；打包后不认
  const testIcon = !app.isPackaged ? process.env['MILE_WARP_TEST_ICON'] || undefined : undefined
  const icons = new WorkspaceIcons(join(app.getPath('appData'), 'mile-warp'), testIcon)
  const workspaces = new WorkspaceService(config, icons)
  const files = new FileTreeService(config, (id) => sendToRenderer(CH.fsChanged, id))
  const preview = new FilePreviewService(files)
  const git = new GitInfoService(config)
  const gitOps = new GitService(config)
  const layout = new LayoutStore(join(app.getPath('appData'), 'mile-warp'))
  sessions.setCellResolver((id) => {
    const l = layout.get()
    const i = l.cells.indexOf(id)
    return i >= 0 && i < CELL_COUNT[l.gridMode] ? i : null
  })
  // 孤儿进程检查必须在任何新会话启动之前读快照（升级建议 1.1）；渲染层经 app:orphans 等结果
  const orphansReady = sessions.detectOrphans().catch(() => [])
  /** 用户主动结束的会话：退出时不发「进程已退出」通知 */
  const userStopped = new Set<string>()

  const showWindow = (): void => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  /** 全部结束并退出（技术设计 §5.7）：先写快照，再结束全部进程树，最后退出 */
  const quitAll = async (): Promise<void> => {
    if (quitting) return
    quitting = true
    log('quit.begin', { live: sessions.liveCount() })
    // 顺序（升级建议 1.1）：快照 → 结束全部进程树并等 onExit（超时按 pid 补杀）→ 布局落盘 → 托盘 → 退出
    await sessions.shutdown()
    layout.flush()
    files.unwatchAll()
    tray.destroy()
    log('quit.end', { stillLive: sessions.liveCount() })
    app.quit()
  }
  /** 最小化到托盘：写快照，隐藏窗口，会话继续运行 */
  const minimizeToTray = (): void => {
    sessions.snapshot()
    mainWindow?.hide()
    tray.refresh()
  }
  const tray = new TrayService({
    showWindow,
    showSession: (id) => {
      showWindow()
      sendToRenderer(CH.traySessionShow, id)
    },
    quitAll: () => void quitAll(),
    sessions: () => sessions.list(),
    candidateCount: () => sessions.restoreCandidates().length
  }, appIconPath())
  secondInstance = showWindow

  /** 按 workspaceId 取校验过的工作区目录；渲染层给不出任何路径（技术设计 §8 第 4 条） */
  const workspaceDir = (arg: unknown): string => {
    const id = obj(arg).workspaceId
    if (typeof id !== 'string') throw new Error('workspaceId 不合法')
    const ws = config.get().workspaces.find((w) => w.id === id)
    if (!ws) throw new Error('工作区不存在')
    return ws.cwd
  }

  sessions.on('data', (d: SessionData) => sendToRenderer(CH.sessionData, d))
  sessions.on('exit', (d: unknown) => sendToRenderer(CH.sessionExit, d))
  sessions.on('changed', (list: unknown) => {
    sendToRenderer(CH.sessionChanged, list)
    tray.refresh()
  })
  sessions.on('activity', (a: unknown) => sendToRenderer(CH.sessionActivity, a))
  // 任务栏数字角标（升级建议 2.3）：显示「等你处理」的会话数
  sessions.on('attention', (n: number) => {
    const win = mainWindow
    if (!win || win.isDestroyed()) return
    win.setOverlayIcon(countBadge(n), n > 0 ? `${n} 个会话在等你` : '')
  })

  /** 窗口在前台、且会话就在可见格里：用户看得见，不发通知 */
  const userCanSee = (sessionId: string): boolean => {
    const win = mainWindow
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused()) return false
    const l = layout.get()
    const i = l.cells.indexOf(sessionId)
    return i >= 0 && i < CELL_COUNT[l.gridMode]
  }
  const inDnd = (): boolean => {
    const { dndStart, dndEnd } = config.get().settings
    if (dndStart === dndEnd) return false
    const h = new Date().getHours()
    return dndStart < dndEnd ? h >= dndStart && h < dndEnd : h >= dndStart || h < dndEnd
  }
  /** 系统通知（升级建议 2.2，PRD T-16）：点通知把窗口带到前台并切到这个会话 */
  const notify = (sessionId: string, title: string, body: string): void => {
    if (quitting || userCanSee(sessionId) || inDnd()) return
    const win = mainWindow
    if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true)
    // 未打包时进程是 electron.exe：toast 抬头显示「Electron」，点击按 AUMID 激活会拉起一个空的
    // Electron 壳（com.mile.warp 只在安装后注册）。开发期用任务栏闪烁提示，不发系统通知
    if (!Notification.isSupported() || !app.isPackaged) return
    const n = new Notification({ title, body, icon: appIconPath(), silent: false })
    n.on('click', () => {
      showWindow()
      sendToRenderer(CH.traySessionShow, sessionId)
    })
    n.show()
  }
  sessions.on('idle', (m: { id: string; title: string }) => {
    if (config.get().settings.notifyIdle) notify(m.id, m.title, '看起来在等你')
  })
  sessions.on('exit', (d: { id: string; exitCode: number }) => {
    if (userStopped.delete(d.id)) return
    if (!config.get().settings.notifyExit) return
    const m = sessions.list().find((x) => x.id === d.id)
    if (m) notify(d.id, m.title, `进程已退出，代码 ${d.exitCode}`)
  })

  handle(CH.appInfo, () => ({ version: app.getVersion(), platform: process.platform }))
  handle(CH.themeGet, () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'))

  handle(CH.configGet, () => config.toPublic())
  handle(CH.groupCreate, (arg) => workspaces.createGroup(arg))
  handle(CH.groupRename, (arg) => workspaces.renameGroup(arg))
  handle(CH.groupRemove, (arg) => workspaces.removeGroup(arg))
  handle(CH.groupReorder, (arg) => workspaces.reorderGroups(arg))
  handle(CH.groupToggle, (arg) => workspaces.toggleGroup(arg))
  handle(CH.groupSetColor, (arg) => workspaces.setGroupColor(arg))
  handle(CH.configExport, async () => {
    const win = mainWindow
    const opts = { defaultPath: 'mile-warp-workspaces.json', filters: [{ name: 'JSON', extensions: ['json'] }] }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    await writeFile(res.filePath, workspaces.exportData(), { encoding: 'utf8' })
    log('config.export')
    return res.filePath
  })
  handle(CH.configImport, async () => {
    const win = mainWindow
    const opts = { properties: ['openFile' as const], filters: [{ name: 'JSON', extensions: ['json'] }] }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    const text = await readFile(res.filePaths[0], { encoding: 'utf8' })
    if (text.length > 5_000_000) throw new Error('文件太大')
    const out = workspaces.importData(text)
    agents.invalidate()
    void agents.detect()
    log('config.import', { imported: out.imported, skipped: out.skipped.length })
    return out
  })
  handle(CH.workspaceCreate, (arg) => workspaces.create(arg))
  handle(CH.workspaceEdit, (arg) => workspaces.edit(arg))
  handle(CH.workspaceDuplicate, (arg) => workspaces.duplicate(arg))
  handle(CH.workspaceMove, (arg) => workspaces.move(arg))
  handle(CH.workspacePickIcon, () => icons.pick(mainWindow))
  handle(CH.workspaceIcon, (arg) => {
    const id = arg && typeof arg === 'object' ? (arg as Record<string, unknown>).id : undefined
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error('id 不合法')
    return icons.read(id)
  })

  handle(CH.fsListDir, (arg) => files.list(arg))
  handle(CH.fsReveal, async (arg) => shell.showItemInFolder(await files.resolvePath(arg)))
  handle(CH.gitBranch, (arg) => git.branch(arg))
  handle(CH.gitProbe, (arg) => gitOps.probe(arg))
  handle(CH.gitStatus, (arg) => gitOps.status(arg))
  handle(CH.gitStage, (arg) => gitOps.stage(arg))
  handle(CH.gitUnstage, (arg) => gitOps.unstage(arg))
  handle(CH.gitDiscardPrepare, (arg) => gitOps.discardPrepare(arg))
  handle(CH.gitDiscard, (arg) => gitOps.discard(arg))
  handle(CH.gitDiff, (arg) => gitOps.diff(arg))
  handle(CH.gitCommit, (arg) => gitOps.commit(arg))
  handle(CH.shellOpenPath, async (arg) => {
    const err = await shell.openPath(workspaceDir(arg))
    if (err) throw new Error(err)
  })
  handle(CH.shellOpenExternalTerminal, (arg) => openExternalTerminal(workspaceDir(arg)))
  handle(CH.workspaceRemove, async (arg) => {
    const id = obj(arg).id
    // 删除前结束该工作区的全部会话；运行中的确认由渲染层先弹（PRD W-06）
    for (const s of sessions.list()) {
      if (s.workspaceId !== id) continue
      userStopped.add(s.id)
      await sessions.close(s.id)
    }
    return workspaces.remove(arg)
  })

  handle(CH.layoutGet, () => layout.get())
  handle(CH.layoutUpdate, (arg) => {
    const next = layout.update(arg)
    // 格位变了：快照里的 cell 跟着更新，应用崩溃时也能按原格恢复
    sessions.snapshot()
    return next
  })
  handle(CH.settingsUpdate, (arg) => {
    const patch = sanitizeSettingsPatch(arg)
    // 默认 Shell 只能从本机探测到的几项里选，渲染层给不出任意可执行文件（§8 第 1 条）
    if (typeof patch.shellPath === 'string' && !agents.shells().some((s) => s.path.toLowerCase() === patch.shellPath?.toLowerCase())) {
      throw new Error('只能选择本机已安装的 Shell')
    }
    config.update((c) => {
      c.settings = { ...c.settings, ...patch }
    })
    if (patch.theme) nativeTheme.themeSource = patch.theme
    // 打开 Git 开关时重新找 git.exe（用户可能刚装好 Git）
    if (patch.gitEnabled !== undefined) gitOps.resetBinary()
    return config.toPublic()
  })
  handle(CH.agentShells, () => agents.shells())

  handle(CH.sessionRestoreCandidates, () => sessions.restoreCandidates())
  handle(CH.sessionRestore, (arg) => {
    const r = obj(arg)
    const recordId = sessionIdOf({ id: r.recordId })
    if (r.resume !== undefined && typeof r.resume !== 'boolean') throw new Error('resume 不合法')
    return sessions.restore(recordId, r.resume as boolean | undefined)
  })
  handle(CH.sessionDismissCandidates, (arg) => {
    const ids = obj(arg).ids
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string'))) throw new Error('ids 不合法')
    sessions.dismissCandidates(ids as string[] | undefined)
    tray.refresh()
  })
  handle(CH.sessionResumeWorkspace, (arg) => {
    const r = obj(arg)
    if (typeof r.workspaceId !== 'string') throw new Error('workspaceId 不合法')
    return sessions.resumeWorkspace(r.workspaceId, dims(arg))
  })
  handle(CH.sessionResumable, () => sessions.resumable())

  handle(CH.appMinimizeToTray, () => minimizeToTray())
  handle(CH.appQuitAll, () => quitAll())

  handle(CH.agentList, () => agents.detect())
  handle(CH.agentRedetect, () => agents.detect(true))

  handle(CH.sessionStart, (arg) => {
    const r = obj(arg)
    if (typeof r.workspaceId !== 'string') throw new Error('workspaceId 不合法')
    return sessions.start(r.workspaceId, 'agent', dims(arg))
  })
  handle(CH.sessionOpenShell, (arg) => {
    const r = obj(arg)
    if (typeof r.workspaceId !== 'string') throw new Error('workspaceId 不合法')
    return sessions.start(r.workspaceId, 'shell', dims(arg))
  })
  handle(CH.sessionList, () => sessions.list())
  handle(CH.sessionBuffer, (arg) => sessions.buffer(sessionIdOf(arg)))
  const stopping = (arg: unknown): string => {
    const id = sessionIdOf(arg)
    userStopped.add(id)
    setTimeout(() => userStopped.delete(id), 10_000)
    return id
  }
  handle(CH.sessionKill, (arg) => sessions.kill(stopping(arg)))
  handle(CH.sessionRestart, (arg) => sessions.restart(stopping(arg)))
  handle(CH.sessionClose, (arg) => sessions.close(stopping(arg)))
  handle(CH.sessionRename, (arg) => {
    const title = obj(arg).title
    if (typeof title !== 'string') throw new Error('标题不合法')
    return sessions.rename(sessionIdOf(arg), title)
  })
  on(CH.sessionWrite, (arg) => {
    const data = obj(arg).data
    if (typeof data !== 'string' || data.length > 1_000_000) return
    try {
      sessions.write(sessionIdOf(arg), data)
    } catch {
      // 非法 id 丢弃
    }
  })
  on(CH.sessionResize, (arg) => {
    const { cols, rows } = dims(arg)
    if (cols === undefined || rows === undefined) return
    try {
      sessions.resize(sessionIdOf(arg), cols, rows)
    } catch {
      // 非法 id 丢弃
    }
  })

  // ---------- 升级建议：活动指示、孤儿进程、路径、自定义 agent、布局预设、导出 ----------

  handle(CH.sessionActivityList, () => sessions.activityList())
  on(CH.sessionMarkSeen, (arg) => {
    try {
      sessions.markSeen(sessionIdOf(arg))
    } catch {
      // 非法 id 丢弃
    }
  })

  handle(CH.appOrphans, async () => {
    await orphansReady
    return sessions.orphanList()
  })
  handle(CH.appKillOrphans, (arg) => {
    const pids = obj(arg).pids
    if (!Array.isArray(pids) || pids.length > 64 || !pids.every((p) => Number.isInteger(p) && (p as number) > 0)) throw new Error('pid 列表不合法')
    return sessions.killOrphans(pids as number[])
  })
  handle(CH.appDismissOrphans, () => sessions.dismissOrphans())
  handle(CH.appOpenLogDir, async () => {
    const dir = logDir()
    if (!dir) throw new Error('日志目录不可用')
    const err = await shell.openPath(dir)
    if (err) throw new Error(err)
  })

  /**
   * 把渲染层给的路径（相对工作区目录，或 agent 输出里的绝对路径）变成校验过的绝对路径。
   * 绝对路径先换算成相对路径，再走 FileTreeService 的 realpath 越界校验；越界一律拒绝（技术设计 §8 第 4 条）
   */
  const workspacePath = async (arg: unknown): Promise<string> => {
    const r = obj(arg)
    const raw = r.path ?? r.relativePath
    if (typeof raw !== 'string' || raw.length > 1024 || raw.includes('\0')) throw new Error('路径不合法')
    let rel = raw.replace(/\\/g, '/')
    if (isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
      rel = relative(workspaceDir(arg), raw).replace(/\\/g, '/')
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('路径越出工作区目录')
    }
    return files.resolvePath({ workspaceId: r.workspaceId, relativePath: rel.replace(/^\.\//, '') })
  }
  handle(CH.fsResolve, (arg) => workspacePath(arg))
  handle(CH.fsEditorAvailable, () => editorExe() !== null)
  handle(CH.fsOpenInEditor, async (arg) => {
    const line = obj(arg).line
    if (line !== undefined && line !== null && (!Number.isInteger(line) || (line as number) < 1 || (line as number) > 10_000_000)) throw new Error('行号不合法')
    const abs = await workspacePath(arg)
    if (openInEditor(abs, (line as number | null | undefined) ?? null)) return 'editor'
    shell.showItemInFolder(abs)
    return 'reveal'
  })
  handle(CH.fsWatch, (arg) => files.watchDirs(arg))
  handle(CH.fsReadText, (arg) => preview.readText(arg))
  handle(CH.fsReadImage, (arg) => preview.readImage(arg))

  const skills = new SkillsService(homedir())
  handle(CH.skillsScan, () => skills.scan())
  handle(CH.skillsDetail, (arg) => skills.detail(arg))
  handle(CH.skillsUninstall, (arg) => skills.uninstall(arg))
  handle(CH.skillsInstallTo, (arg) => skills.installTo(arg))
  handle(CH.skillsReveal, (arg) => {
    const dir = skills.dirOf(arg)
    shell.showItemInFolder(join(dir, 'SKILL.md'))
    return 'reveal'
  })
  handle(CH.skillsParseGithubUrl, (arg) => {
    const r = arg && typeof arg === 'object' ? (arg as Record<string, unknown>) : {}
    return parseGithubUrl(r.url)
  })
  handle(CH.skillsInstallGithub, (arg) => installFromGithub(arg))
  handle(CH.skillsPickZip, async () => {
    if (!mainWindow) return null
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择 skill 压缩包',
      filters: [{ name: 'Skill 压缩包', extensions: ['zip'] }],
      properties: ['openFile']
    })
    if (r.canceled || r.filePaths.length === 0) return null
    return r.filePaths[0]
  })
  handle(CH.skillsInstallZip, (arg) => installFromZip(arg))

  handle(CH.agentSaveCustom, (arg) => {
    const next = workspaces.saveCustomAgent(arg)
    agents.invalidate()
    void agents.detect()
    return next
  })
  handle(CH.agentRemoveCustom, (arg) => {
    const next = workspaces.removeCustomAgent(arg)
    agents.invalidate()
    return next
  })
  handle(CH.agentPickCommand, async () => {
    const win = mainWindow
    const opts = { properties: ['openFile' as const], filters: [{ name: '可执行文件', extensions: ['exe', 'cmd', 'bat', 'com'] }] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })
  handle(CH.presetSave, (arg) => workspaces.savePreset(arg))
  handle(CH.presetRemove, (arg) => workspaces.removePreset(arg))

  /** 导出终端内容（升级建议 4.3）：渲染层给已去掉控制符的文本，主进程弹保存对话框，路径由用户选 */
  handle(CH.dialogSaveText, async (arg) => {
    const r = obj(arg)
    if (typeof r.text !== 'string' || r.text.length > 50_000_000) throw new Error('内容不合法')
    const name = typeof r.defaultName === 'string' ? r.defaultName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) : 'terminal.txt'
    const win = mainWindow
    const opts = { defaultPath: name || 'terminal.txt', filters: [{ name: '文本文件', extensions: ['txt'] }] }
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    await writeFile(res.filePath, r.text, { encoding: 'utf8' })
    return res.filePath
  })

  // ---------- 历史会话（会话管理升级计划 P1 / P2）：渲染层只给 historyId，路径不出主进程 ----------

  const historyIdOf = (arg: unknown): string => {
    const id = obj(arg).historyId
    if (typeof id !== 'string' || !HISTORY_ID_RE.test(id)) throw new Error('historyId 不合法')
    return id
  }
  handle(CH.historyList, () => history.list())
  handle(CH.historyDetail, (arg) => {
    const { offset = 0, tools = false } = obj(arg)
    if (!Number.isInteger(offset) || (offset as number) < 0 || (offset as number) > 1_000_000) throw new Error('offset 不合法')
    if (typeof tools !== 'boolean') throw new Error('tools 不合法')
    return history.detail(historyIdOf(arg), offset as number, tools)
  })
  handle(CH.historyExport, async (arg) => {
    const r = obj(arg)
    const id = historyIdOf(arg)
    const format = r.format
    if (format !== 'markdown' && format !== 'json' && format !== 'raw') throw new Error('导出格式不合法')
    if (r.includeTools !== undefined && typeof r.includeTools !== 'boolean') throw new Error('includeTools 不合法')
    const filters =
      format === 'markdown'
        ? [{ name: 'Markdown', extensions: ['md'] }]
        : format === 'json'
          ? [{ name: 'JSON', extensions: ['json'] }]
          : [{ name: 'JSON Lines', extensions: ['jsonl'] }]
    const win = mainWindow
    const opts = { defaultPath: history.defaultExportName(id, format), filters }
    // MILE_WARP_TEST_SAVE（开发期）：harness 点不了系统保存对话框，直接存进这个目录；打包后不认
    const res = testSave
      ? { canceled: false, filePath: join(testSave, opts.defaultPath) }
      : win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts)
    if (res.canceled || !res.filePath) return null
    await history.exportTo(id, format, r.includeTools === true, res.filePath)
    return res.filePath
  })
  handle(CH.historyReveal, async (arg) => shell.showItemInFolder(await history.filePath(historyIdOf(arg))))
  /**
   * 续接：找同 agent、同目录的工作区，复用会话启动路径（续接参数由 lib/resume 按 agent 给出）。
   * 没有对应工作区时返回 needWorkspace，由渲染层确认后新建工作区再调一次；正在 Warp 里运行的不再开第二个
   */
  handle(CH.historyResume, async (arg): Promise<HistoryResumeResult> => {
    const r = obj(arg)
    const e = history.entry(historyIdOf(arg))
    if (r.workspaceId !== undefined && typeof r.workspaceId !== 'string') throw new Error('workspaceId 不合法')
    const matches = config
      .get()
      .workspaces.filter((w) => w.agentId === e.agentId && dirKey(w.cwd) === dirKey(e.cwd))
      .sort((a, b) => a.order - b.order)
    const ws = r.workspaceId ? matches.find((w) => w.id === r.workspaceId) : matches[0]
    if (r.workspaceId && !ws) throw new Error('这个工作区的目录或 agent 与该对话不一致')
    if (history.isRunning(e)) return { ok: false, reason: '这个对话正在 Warp 的会话里运行', needWorkspace: false, running: true }
    if (!ws) return { ok: false, reason: '这个目录下没有对应 agent 的工作区', needWorkspace: true, running: false }
    try {
      const session = await sessions.start(ws.id, 'agent', dims(arg), { mode: 'exact', resumeId: e.sessionId, title: e.title.slice(0, 80) })
      log('history.resume', { agent: e.agentId })
      return { ok: true, session }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err), needWorkspace: false, running: false }
    }
  })

  handle(CH.dialogPickDirectory, async () => {
    const win = mainWindow
    const r = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })
  handle(CH.shellOpenUrl, (arg) => {
    const url = obj(arg).url
    if (typeof url !== 'string' || url.length > 2048) throw new Error('链接不合法')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('链接不合法')
    }
    // 只放行 http/https（技术设计 §7「外部链接」）
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只允许打开 http/https 链接')
    return shell.openExternal(parsed.toString())
  })
  handle(CH.clipboardRead, () => clipboard.readText())
  handle(CH.clipboardWrite, (arg) => {
    const text = obj(arg).text
    if (typeof text === 'string' && text.length <= 10_000_000) clipboard.writeText(text)
  })

  on(CH.windowMinimize, () => mainWindow?.minimize())
  on(CH.windowMaximize, () => {
    const win = mainWindow
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  on(CH.windowClose, () => mainWindow?.close())

  // 主题（PRD S-01）：交给 nativeTheme，'system' 跟随系统；变化经 'updated' 推给渲染层
  nativeTheme.themeSource = config.get().settings.theme
  // 去掉默认应用菜单：它的加速键（Ctrl+R 重载、Ctrl+W 关窗、Ctrl+= / - / 0 缩放）会抢走终端按键（PRD T-18）
  Menu.setApplicationMenu(null)
  createWindow(layout)
  if (!app.isPackaged) {
    // 开发期仍可用 F12 打开开发者工具
    mainWindow?.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') mainWindow?.webContents.toggleDevTools()
    })
  }
  tray.create()
  void agents.detect()
  app.on('will-quit', () => layout.flush())

  // 关闭窗口（PRD S-05，技术设计 §5.7）：无运行中会话直接退出；否则按「关闭窗口时」设置分流，
  // 'ask' 交给渲染层弹确认框，用户选了再调 app:minimizeToTray / app:quitAll
  mainWindow?.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    if (sessions.liveCount() === 0) {
      void quitAll()
      return
    }
    const action = config.get().settings.closeAction
    if (action === 'tray') minimizeToTray()
    else if (action === 'quit') void quitAll()
    else {
      showWindow()
      sendToRenderer(CH.appQuitRequested, sessions.list().filter((s) => s.status === 'running' || s.status === 'starting'))
    }
  })
  // 托盘菜单退出、系统注销关机：同样先写快照再结束进程
  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    void quitAll()
  })

  nativeTheme.on('updated', () => {
    sendToRenderer(CH.themeChanged, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  })
})

// 托盘存在期间不随窗口关闭退出；真正退出只走 quitAll（技术设计 §5.7）
app.on('window-all-closed', () => undefined)
