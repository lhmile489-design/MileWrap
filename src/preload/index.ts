import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CH } from '@shared/channels'
import type {
  AgentInfo,
  CustomAgentInput,
  GridMode,
  OrphanProcess,
  SessionActivity,
  FileEntry,
  FileImagePreview,
  FileTextPreview,
  GitProbe,
  GitBranch,
  GitCommitDetail,
  GitLogPage,
  GitProgress,
  GitRisk,
  GitRemoteResult,
  GitDiff,
  GitDiscardPlan,
  GitStatus,
  HistoryDetail,
  HistoryExportFormat,
  HistoryListResult,
  HistoryResumeResult,
  Layout,
  LayoutPatch,
  PublicConfig,
  RestoreCandidate,
  RestoreResult,
  SkillDetail,
  SkillsInstallResult,
  SkillsScanResult,
  Settings,
  SessionBuffer,
  SessionData,
  SessionMeta,
  WorkspaceInput
} from '@shared/types'

type Off = () => void

function subscribe<T>(channel: string, cb: (payload: T) => void): Off {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

type Dims = { cols?: number; rows?: number }

const api = {
  theme: {
    get: (): Promise<'light' | 'dark'> => ipcRenderer.invoke(CH.themeGet),
    onChange: (cb: (theme: 'light' | 'dark') => void): Off => subscribe(CH.themeChanged, cb)
  },
  config: {
    get: (): Promise<PublicConfig> => ipcRenderer.invoke(CH.configGet),
    /** 导出分组与工作区（不含环境变量值）；返回保存路径，取消返回 null */
    exportData: (): Promise<string | null> => ipcRenderer.invoke(CH.configExport),
    /** 导入；取消返回 null */
    importData: (): Promise<{ config: PublicConfig; imported: number; skipped: string[] } | null> => ipcRenderer.invoke(CH.configImport)
  },
  group: {
    create: (name: string): Promise<PublicConfig> => ipcRenderer.invoke(CH.groupCreate, { name }),
    rename: (id: string, name: string): Promise<PublicConfig> => ipcRenderer.invoke(CH.groupRename, { id, name }),
    remove: (id: string): Promise<PublicConfig> => ipcRenderer.invoke(CH.groupRemove, { id }),
    reorder: (ids: string[]): Promise<PublicConfig> => ipcRenderer.invoke(CH.groupReorder, { ids }),
    toggle: (id: string, collapsed?: boolean): Promise<PublicConfig> =>
      ipcRenderer.invoke(CH.groupToggle, { id, collapsed }),
    setColor: (id: string, color: string | null): Promise<PublicConfig> => ipcRenderer.invoke(CH.groupSetColor, { id, color })
  },
  workspace: {
    create: (input: WorkspaceInput): Promise<PublicConfig> => ipcRenderer.invoke(CH.workspaceCreate, input),
    edit: (id: string, patch: Partial<WorkspaceInput>): Promise<PublicConfig> =>
      ipcRenderer.invoke(CH.workspaceEdit, { ...patch, id }),
    remove: (id: string): Promise<PublicConfig> => ipcRenderer.invoke(CH.workspaceRemove, { id }),
    duplicate: (id: string): Promise<PublicConfig> => ipcRenderer.invoke(CH.workspaceDuplicate, { id }),
    move: (id: string, groupId: string | null, index: number): Promise<PublicConfig> =>
      ipcRenderer.invoke(CH.workspaceMove, { id, groupId, index }),
    /** 弹系统文件对话框选图；取消返回 null。token 交给 create / edit 的 iconToken */
    pickIcon: (): Promise<{ token: string; dataUrl: string } | null> => ipcRenderer.invoke(CH.workspacePickIcon),
    icon: (id: string): Promise<string | null> => ipcRenderer.invoke(CH.workspaceIcon, { id })
  },
  fs: {
    listDir: (workspaceId: string, relativePath: string): Promise<FileEntry[]> =>
      ipcRenderer.invoke(CH.fsListDir, { workspaceId, relativePath }),
    reveal: (workspaceId: string, relativePath: string): Promise<void> =>
      ipcRenderer.invoke(CH.fsReveal, { workspaceId, relativePath }),
    /** 相对路径或工作区内的绝对路径 -> 校验过的绝对路径；越界抛错 */
    resolve: (workspaceId: string, path: string): Promise<string> => ipcRenderer.invoke(CH.fsResolve, { workspaceId, path }),
    editorAvailable: (): Promise<boolean> => ipcRenderer.invoke(CH.fsEditorAvailable),
    /** 用 VS Code 打开到某行；没装就在资源管理器中显示 */
    openInEditor: (workspaceId: string, path: string, line?: number | null): Promise<'editor' | 'reveal'> =>
      ipcRenderer.invoke(CH.fsOpenInEditor, { workspaceId, path, line: line ?? null }),
    /** 设定要 watch 的已展开目录（替换上一次）；变化经 onChanged 推送 */
    watch: (workspaceId: string, relativePaths: string[]): Promise<void> =>
      ipcRenderer.invoke(CH.fsWatch, { workspaceId, relativePaths }),
    onChanged: (cb: (workspaceId: string) => void): Off => subscribe(CH.fsChanged, cb),
    /** 单击文件预览：文本按 UTF-8 读（>2MB 拒、>1MB 截断）；图片缩放后给 data URL */
    readText: (workspaceId: string, path: string): Promise<FileTextPreview> =>
      ipcRenderer.invoke(CH.fsReadText, { workspaceId, relativePath: path }),
    readImage: (workspaceId: string, path: string): Promise<FileImagePreview> =>
      ipcRenderer.invoke(CH.fsReadImage, { workspaceId, relativePath: path }),
    /** 拖进来的文件 / 文件夹的本机路径（沙箱下 File.path 读不到）；只用来预填表单，主进程再校验 */
    pathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    }
  },
  git: {
    branch: (workspaceId: string): Promise<string | null> => ipcRenderer.invoke(CH.gitBranch, { workspaceId }),
    /** Git 管理（Git管理-PRD）：settings.gitEnabled 为 false 时 probe 返回 disabled，其它调用直接拒绝 */
    probe: (workspaceId: string): Promise<GitProbe> => ipcRenderer.invoke(CH.gitProbe, { workspaceId }),
    status: (workspaceId: string): Promise<GitStatus> => ipcRenderer.invoke(CH.gitStatus, { workspaceId }),
    /** paths 相对仓库根；空数组 = 全部 */
    stage: (workspaceId: string, paths: string[]): Promise<void> => ipcRenderer.invoke(CH.gitStage, { workspaceId, paths }),
    unstage: (workspaceId: string, paths: string[]): Promise<void> => ipcRenderer.invoke(CH.gitUnstage, { workspaceId, paths }),
    /** 丢弃两步走：先拿确认用的文件列表与一次性 token，用户确认后再用 token 执行 */
    discardPrepare: (workspaceId: string, paths: string[]): Promise<GitDiscardPlan> =>
      ipcRenderer.invoke(CH.gitDiscardPrepare, { workspaceId, paths }),
    discard: (workspaceId: string, token: string): Promise<void> => ipcRenderer.invoke(CH.gitDiscard, { workspaceId, token }),
    diff: (workspaceId: string, path: string, staged: boolean): Promise<GitDiff> => ipcRenderer.invoke(CH.gitDiff, { workspaceId, path, staged }),
    commit: (workspaceId: string, summary: string, description: string): Promise<{ hash: string }> =>
      ipcRenderer.invoke(CH.gitCommit, { workspaceId, summary, description }),
    /** G2：只列本地分支；切换 / 新建只收分支名，主进程校形 */
    branches: (workspaceId: string): Promise<GitBranch[]> => ipcRenderer.invoke(CH.gitBranches, { workspaceId }),
    checkout: (workspaceId: string, branch: string): Promise<void> => ipcRenderer.invoke(CH.gitCheckout, { workspaceId, branch }),
    createBranch: (workspaceId: string, name: string): Promise<void> => ipcRenderer.invoke(CH.gitCreateBranch, { workspaceId, name }),
    fetch: (workspaceId: string): Promise<GitRemoteResult> => ipcRenderer.invoke(CH.gitFetch, { workspaceId }),
    pull: (workspaceId: string): Promise<GitRemoteResult> => ipcRenderer.invoke(CH.gitPull, { workspaceId }),
    push: (workspaceId: string): Promise<GitRemoteResult> => ipcRenderer.invoke(CH.gitPush, { workspaceId }),
    cancel: (workspaceId: string): Promise<void> => ipcRenderer.invoke(CH.gitCancel, { workspaceId }),
    /** G3 历史：当前 HEAD，offset 分页，limit ≤ 100 */
    log: (workspaceId: string, offset: number, limit = 50): Promise<GitLogPage> => ipcRenderer.invoke(CH.gitLog, { workspaceId, offset, limit }),
    commitDetail: (workspaceId: string, hash: string): Promise<GitCommitDetail> => ipcRenderer.invoke(CH.gitCommitDetail, { workspaceId, hash }),
    commitFileDiff: (workspaceId: string, hash: string, path: string, oldPath?: string): Promise<GitDiff> =>
      ipcRenderer.invoke(CH.gitCommitFileDiff, { workspaceId, hash, path, oldPath }),
    /** 仓库里会执行命令的配置 / 钩子：未确认时返回风险项，已确认或没有返回 null */
    risk: (workspaceId: string): Promise<GitRisk | null> => ipcRenderer.invoke(CH.gitRisk, { workspaceId }),
    /** 确认信任：带回 risk 给的指纹，主进程重扫一致才记下 */
    trust: (workspaceId: string, fingerprint: string): Promise<void> => ipcRenderer.invoke(CH.gitTrust, { workspaceId, fingerprint }),
    onProgress: (cb: (p: GitProgress) => void): Off => subscribe(CH.gitProgress, cb)
  },
  agent: {
    list: (): Promise<AgentInfo[]> => ipcRenderer.invoke(CH.agentList),
    redetect: (): Promise<AgentInfo[]> => ipcRenderer.invoke(CH.agentRedetect),
    shells: (): Promise<{ label: string; path: string }[]> => ipcRenderer.invoke(CH.agentShells),
    saveCustom: (input: CustomAgentInput): Promise<PublicConfig> => ipcRenderer.invoke(CH.agentSaveCustom, input),
    removeCustom: (id: string): Promise<PublicConfig> => ipcRenderer.invoke(CH.agentRemoveCustom, { id }),
    /** 系统文件对话框选可执行文件；取消返回 null */
    pickCommand: (): Promise<string | null> => ipcRenderer.invoke(CH.agentPickCommand)
  },
  preset: {
    save: (name: string, gridMode: GridMode, cells: (string | null)[]): Promise<PublicConfig> =>
      ipcRenderer.invoke(CH.presetSave, { name, gridMode, cells }),
    remove: (id: string): Promise<PublicConfig> => ipcRenderer.invoke(CH.presetRemove, { id })
  },
  session: {
    start: (workspaceId: string, dims: Dims = {}): Promise<SessionMeta> =>
      ipcRenderer.invoke(CH.sessionStart, { workspaceId, ...dims }),
    openShell: (workspaceId: string, dims: Dims = {}): Promise<SessionMeta> =>
      ipcRenderer.invoke(CH.sessionOpenShell, { workspaceId, ...dims }),
    list: (): Promise<SessionMeta[]> => ipcRenderer.invoke(CH.sessionList),
    buffer: (id: string): Promise<SessionBuffer | null> => ipcRenderer.invoke(CH.sessionBuffer, { id }),
    kill: (id: string): Promise<SessionMeta | null> => ipcRenderer.invoke(CH.sessionKill, { id }),
    restart: (id: string): Promise<SessionMeta | null> => ipcRenderer.invoke(CH.sessionRestart, { id }),
    close: (id: string): Promise<void> => ipcRenderer.invoke(CH.sessionClose, { id }),
    rename: (id: string, title: string): Promise<SessionMeta | null> =>
      ipcRenderer.invoke(CH.sessionRename, { id, title }),
    write: (id: string, data: string): void => ipcRenderer.send(CH.sessionWrite, { id, data }),
    resize: (id: string, cols: number, rows: number): void => ipcRenderer.send(CH.sessionResize, { id, cols, rows }),
    restoreCandidates: (): Promise<RestoreCandidate[]> => ipcRenderer.invoke(CH.sessionRestoreCandidates),
    restore: (recordId: string, resume?: boolean): Promise<RestoreResult> =>
      ipcRenderer.invoke(CH.sessionRestore, { recordId, resume }),
    dismissCandidates: (ids?: string[]): Promise<void> => ipcRenderer.invoke(CH.sessionDismissCandidates, { ids }),
    resumeWorkspace: (workspaceId: string, dims: Dims = {}): Promise<SessionMeta> =>
      ipcRenderer.invoke(CH.sessionResumeWorkspace, { workspaceId, ...dims }),
    resumable: (): Promise<string[]> => ipcRenderer.invoke(CH.sessionResumable),
    onData: (cb: (d: SessionData) => void): Off => subscribe(CH.sessionData, cb),
    onExit: (cb: (d: { id: string; gen: number; exitCode: number }) => void): Off => subscribe(CH.sessionExit, cb),
    onChanged: (cb: (list: SessionMeta[]) => void): Off => subscribe(CH.sessionChanged, cb),
    activityList: (): Promise<SessionActivity[]> => ipcRenderer.invoke(CH.sessionActivityList),
    onActivity: (cb: (a: SessionActivity) => void): Off => subscribe(CH.sessionActivity, cb),
    markSeen: (id: string): void => ipcRenderer.send(CH.sessionMarkSeen, { id })
  },
  layout: {
    get: (): Promise<Layout> => ipcRenderer.invoke(CH.layoutGet),
    update: (patch: LayoutPatch): Promise<Layout> => ipcRenderer.invoke(CH.layoutUpdate, patch)
  },
  settings: {
    update: (patch: Partial<Settings>): Promise<PublicConfig> => ipcRenderer.invoke(CH.settingsUpdate, patch)
  },
  app: {
    info: (): Promise<{ version: string; platform: string }> => ipcRenderer.invoke(CH.appInfo),
    minimizeToTray: (): Promise<void> => ipcRenderer.invoke(CH.appMinimizeToTray),
    quitAll: (): Promise<void> => ipcRenderer.invoke(CH.appQuitAll),
    /** 关闭窗口且仍有运行中会话、设置为「每次询问」时触发 */
    onQuitRequested: (cb: (live: SessionMeta[]) => void): Off => subscribe(CH.appQuitRequested, cb),
    orphans: (): Promise<OrphanProcess[]> => ipcRenderer.invoke(CH.appOrphans),
    killOrphans: (pids: number[]): Promise<number> => ipcRenderer.invoke(CH.appKillOrphans, { pids }),
    dismissOrphans: (): Promise<void> => ipcRenderer.invoke(CH.appDismissOrphans),
    openLogDir: (): Promise<void> => ipcRenderer.invoke(CH.appOpenLogDir)
  },
  tray: {
    onShowSession: (cb: (sessionId: string) => void): Off => subscribe(CH.traySessionShow, cb)
  },
  dialog: {
    pickDirectory: (): Promise<string | null> => ipcRenderer.invoke(CH.dialogPickDirectory),
    /** 导出终端内容：返回保存的路径，取消返回 null */
    saveText: (text: string, defaultName: string): Promise<string | null> =>
      ipcRenderer.invoke(CH.dialogSaveText, { text, defaultName })
  },
  /** 本机 agent 的历史会话（会话管理升级计划）：只传 historyId，路径不出主进程 */
  history: {
    list: (): Promise<HistoryListResult> => ipcRenderer.invoke(CH.historyList),
    /** 从第 offset 条起取一页预览；tools = 是否计入工具调用；truncated = 后面还有 */
    detail: (historyId: string, offset = 0, tools = false): Promise<HistoryDetail> =>
      ipcRenderer.invoke(CH.historyDetail, { historyId, offset, tools }),
    /** 主进程弹保存对话框；返回保存路径，取消返回 null */
    export: (historyId: string, format: HistoryExportFormat, includeTools = false): Promise<string | null> =>
      ipcRenderer.invoke(CH.historyExport, { historyId, format, includeTools }),
    reveal: (historyId: string): Promise<void> => ipcRenderer.invoke(CH.historyReveal, { historyId }),
    /** 续接到同 agent、同目录的工作区；workspaceId 缺省由主进程挑 */
    resume: (historyId: string, workspaceId?: string, dims: Dims = {}): Promise<HistoryResumeResult> =>
      ipcRenderer.invoke(CH.historyResume, { historyId, workspaceId, ...dims })
  },
  skills: {
    scan: (): Promise<SkillsScanResult> => ipcRenderer.invoke(CH.skillsScan),
    detail: (agentId: string, name: string): Promise<SkillDetail> => ipcRenderer.invoke(CH.skillsDetail, { agentId, name }),
    installTo: (agentId: string, name: string, targets: string[], onConflict: 'skip' | 'overwrite'): Promise<SkillsInstallResult> =>
      ipcRenderer.invoke(CH.skillsInstallTo, { agentId, name, targets, onConflict }),
    uninstall: (agentId: string, name: string): Promise<{ ok: true }> => ipcRenderer.invoke(CH.skillsUninstall, { agentId, name }),
    reveal: (agentId: string, name: string): Promise<void> => ipcRenderer.invoke(CH.skillsReveal, { agentId, name }),
    /** 解析 GitHub URL（不下载），给「安装预览」用 */
    parseGithubUrl: (url: string): Promise<{ owner: string; repo: string; branch: string; subpath: string; canonical: string }> =>
      ipcRenderer.invoke(CH.skillsParseGithubUrl, { url }),
    installGithub: (url: string, targets: string[], onConflict: 'skip' | 'overwrite'): Promise<SkillsInstallResult & { parsed: { canonical: string } }> =>
      ipcRenderer.invoke(CH.skillsInstallGithub, { url, targets, onConflict }),
    /** 主进程弹对话框选 zip；取消返回 null，路径不出渲染层 */
    pickZip: (): Promise<string | null> => ipcRenderer.invoke(CH.skillsPickZip),
    installZip: (zipPath: string, targets: string[], onConflict: 'skip' | 'overwrite'): Promise<SkillsInstallResult> =>
      ipcRenderer.invoke(CH.skillsInstallZip, { zipPath, targets, onConflict })
  },
  shell: {
    openUrl: (url: string): Promise<void> => ipcRenderer.invoke(CH.shellOpenUrl, { url }),
    openPath: (workspaceId: string): Promise<void> => ipcRenderer.invoke(CH.shellOpenPath, { workspaceId }),
    openExternalTerminal: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke(CH.shellOpenExternalTerminal, { workspaceId })
  },
  clipboard: {
    read: (): Promise<string> => ipcRenderer.invoke(CH.clipboardRead),
    write: (text: string): Promise<void> => ipcRenderer.invoke(CH.clipboardWrite, { text })
  },
  window: {
    minimize: (): void => ipcRenderer.send(CH.windowMinimize),
    maximize: (): void => ipcRenderer.send(CH.windowMaximize),
    close: (): void => ipcRenderer.send(CH.windowClose)
  }
}

contextBridge.exposeInMainWorld('warp', api)

export type WarpApi = typeof api
