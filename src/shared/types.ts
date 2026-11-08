/** 配置文件版本；改结构时加显式迁移分支，见技术设计 §4 */
export const CONFIG_VERSION = 2

export type BuiltinAgentId = 'claude' | 'codex' | 'kimi' | 'pi' | 'shell'

export type Group = {
  id: string
  name: string
  color: string | null
  collapsed: boolean
  order: number
}

/** 渲染层看到的工作区：只有环境变量的键名，没有值 */
export type Workspace = {
  id: string
  groupId: string | null
  name: string
  note: string
  agentId: string
  /** 覆盖自动探测的可执行文件（PRD Q7） */
  agentPath: string | null
  cwd: string
  args: string[]
  envKeys: string[]
  /** 自定义图标的内容哈希；null = 用 agent 徽章。图片本身经 workspace:icon 取 */
  icon: string | null
  order: number
  createdAt: number
  updatedAt: number
}

/** 主进程落盘形态：环境变量值经 safeStorage 加密成 base64，永不下发渲染层 */
export type StoredWorkspace = Workspace & { envEnc: string | null }

export type AgentDef = {
  id: string
  name: string
  command: string
  builtin: boolean
  /** 自定义 agent（PRD A-03）：默认参数，切分好的数组 */
  defaultArgs?: string[]
  /** 徽章底色 #rrggbb；前景色由对比度自动选 */
  color?: string | null
  /** 续接模板：{id} 是会话 ID 占位符；为空 = 不支持按 ID 续接 */
  resumeArgs?: string[]
  /** 拿不到 ID 时的兜底续接参数；为空 = 不支持 */
  continueArgs?: string[]
}

/** 设置页与工作区弹窗用的自定义 agent 入参；参数以原始字符串传入，由主进程切分 */
export type CustomAgentInput = {
  id?: string
  name: string
  command: string
  argsText: string
  color: string | null
  resumeArgsText: string
  continueArgsText: string
}

/** 布局预设（升级建议 3.1）：宫格模式 + 每格放哪个工作区 */
export type LayoutPreset = {
  id: string
  name: string
  gridMode: GridMode
  /** 长度 4；null = 空格 */
  cells: (string | null)[]
}

/** 会话活动状态（升级建议 2.1）：只看有没有输出和时间，不看输出内容 */
export type ActivityState = 'active' | 'quiet' | 'idle'

/** session:activity 推送：attention = 跑完一轮在等用户（用户看过之后清掉） */
export type SessionActivity = { id: string; state: ActivityState; attention: boolean }

/** 上次没结束的 agent 进程（升级建议 1.1）：pid 与可执行文件都对得上才列出 */
export type OrphanProcess = { pid: number; exe: string; title: string; recordId: string }

export type Settings = {
  theme: 'light' | 'dark' | 'system'
  shellPath: string | null
  fontSize: number
  fontFamily: string
  scrollback: number
  copyOnSelect: boolean
  /** Ctrl+V 直接粘贴（升级：抢占 agent 的 quoted-insert / 翻页键）；默认 false 保持 T-18 */
  pasteOnCtrlV: boolean
  keepShellOnAgentExit: boolean
  restoreOnStartup: boolean
  resumeConversation: boolean
  closeAction: 'ask' | 'tray' | 'quit'
  /** 活动指示阈值（秒）：连续输出超过 burstSec、再安静 quietSec，判为「等你处理」 */
  activityBurstSec: number
  activityQuietSec: number
  /** 系统通知：等待输入 / 进程退出 */
  notifyIdle: boolean
  notifyExit: boolean
  /** 免打扰时段（0–23 点）；两者相等 = 不启用 */
  dndStart: number
  dndEnd: number
  /** 终端外观（升级建议 4.4） */
  lineHeight: number
  cursorStyle: 'block' | 'bar' | 'underline'
  cursorBlink: boolean
  /** Git 管理总开关（Git管理-PRD G-01）：false 时主进程不执行任何 git 命令 */
  gitEnabled: boolean
  /** push 自动设上游时用的远端名（G-24），只允许 [A-Za-z0-9._-] 且不以 - 开头 */
  gitDefaultRemote: string
}

export type ResumeMode = 'exact' | 'continue' | 'fresh'

/** 会话快照：只用于下次启动一键恢复（技术设计 §5.7），不代表进程可恢复 */
export type SessionRecord = {
  /** 等于当时的会话 id；恢复后由新会话的记录替换 */
  id: string
  workspaceId: string
  agentId: string
  /** agent 会话还是「在此目录打开 Shell」 */
  kind: 'agent' | 'shell'
  cwd: string
  args: string[]
  title: string
  /** 0–3，上次所在的格；在后台为 null */
  cell: number | null
  lastStartedAt: number
  /** null = 仍在运行时应用被关掉 / 崩溃（自动恢复只拉起这类） */
  lastExitCode: number | null
  resumeId: string | null
  resumeMode: ResumeMode
  /** 会话还在列表里（用户没有手动关闭）。应用退出时保持 true，下次启动即为恢复候选 */
  open: boolean
  /** 运行中进程的 pid 与可执行文件；进程退出后清空。下次启动据此找没结束的孤儿进程 */
  pid: number | null
  exe: string | null
}

/** session:restoreCandidates 的单项：已过滤掉工作区被删、目录不存在的记录 */
export type RestoreCandidate = SessionRecord & {
  workspaceName: string
  /** 能否续接对话；false 时恢复卡片标「新开」 */
  canResume: boolean
  /** 不能续接的原因（给卡片上的提示用） */
  resumeNote: string | null
}

export type RestoreResult =
  | { ok: true; session: SessionMeta; mode: ResumeMode }
  | { ok: false; reason: string }

export type Config = {
  version: number
  groups: Group[]
  workspaces: StoredWorkspace[]
  customAgents: AgentDef[]
  settings: Settings
  sessionRecords: SessionRecord[]
  layoutPresets: LayoutPreset[]
}

/** config:get 的返回值：脱敏后的配置 */
export type PublicConfig = {
  groups: Group[]
  workspaces: Workspace[]
  settings: Settings
  customAgents: AgentDef[]
  layoutPresets: LayoutPreset[]
}

/** workspace:create 的入参；args 以用户输入的原始字符串传入，由主进程切分 */
export type WorkspaceInput = {
  name: string
  agentId: string
  cwd: string
  argsText: string
  note: string
  groupId: string | null
  /** 环境变量：新建时为全量；编辑时为补丁，字符串 = 新增或覆盖，null = 删除 */
  env?: Record<string, string | null>
  /** 自定义图标：workspace:pickIcon 返回的一次性 token；null = 恢复默认；不传 = 不变 */
  iconToken?: string | null
}

/** workspace:edit 的入参：只传要改的字段 */
export type WorkspaceEdit = { id: string } & Partial<WorkspaceInput>

/** fs:listDir 的单项 */
export type FileEntry = {
  name: string
  kind: 'dir' | 'file'
  size: number
  mtime: number
  /** 符号链接 / 联接点：指向工作区目录之外时不允许展开 */
  link: boolean
}

/** fs:readText 的返回值：UTF-8 读文本文件；binary = 内容不是文本（前 8KB 含空字节） */
export type FileTextPreview = {
  content: string
  truncated: boolean
  binary: boolean
  size: number
  mtime: number
}

/** git:probe 的返回值（Git管理-PRD G-04）。路径不出主进程：只给仓库根名与工作区相对仓库根的子目录 */
export type GitProbe =
  | { available: true; repoName: string; relativeDir: string }
  | { available: false; reason: 'disabled' | 'no-git' | 'not-repo' }
  | { available: false; reason: 'error'; message: string }

/** 仓库里会执行任意命令的一项配置或钩子（审查 2026-11-06 高危项） */
export type GitRiskItem = { kind: 'config' | 'hook'; name: string; detail: string; why: string }
/** git:risk 的返回值：未确认信任（或确认后内容变了）时给出；fingerprint 确认时原样带回 */
export type GitRisk = { fingerprint: string; items: GitRiskItem[] }

export type GitFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict'

/** 改动列表的一行。path / oldPath 相对仓库根，斜杠统一为 / */
export type GitFile = {
  path: string
  oldPath?: string
  status: GitFileStatus
  staged: boolean
}

/** git:status 的返回值 */
export type GitStatus = {
  /** 当前分支；detached 时为短哈希 */
  branch: string
  detached: boolean
  ahead: number
  behind: number
  /** 上游分支名（如 origin/main），没有为 null */
  upstream: string | null
  hasRemote: boolean
  /** HEAD 的完整哈希；还没有提交时为 null。历史页据此判断要不要重读 */
  head: string | null
  files: GitFile[]
}

/** git:diff 的一行；oldNo / newNo 只有对应一侧存在时才有 */
export type GitDiffLine = { type: 'context' | 'added' | 'removed'; content: string; oldNo: number | null; newNo: number | null }
export type GitDiffHunk = { header: string; lines: GitDiffLine[] }
/** git:diff 的返回值：binary / tooLarge（>1MB 或 >5000 行）时 hunks 为空 */
export type GitDiff = { hunks: GitDiffHunk[]; binary: boolean; tooLarge: boolean; added: number; removed: number }

/** git:discardPrepare 的返回值：确认框列出的文件；token 一次性、60 秒内有效 */
export type GitDiscardPlan = { token: string; files: { path: string; untracked: boolean }[] }

/** git:branches 的一项（只列本地分支，G-20） */
export type GitBranch = {
  name: string
  current: boolean
  /** 上游（如 origin/main），没有为 null */
  upstream: string | null
  subject: string
  /** 最近一次提交时间（毫秒） */
  time: number
}

export type GitRemoteOp = 'fetch' | 'pull' | 'push'

/** fetch / pull / push 的返回值：pull 产生冲突时 conflict 为 true，不抛错（G-25） */
export type GitRemoteResult = { conflict: boolean; rebase?: boolean }

/** git:progress 推送（G-23）：stage 是 git 进度行的首词（receiving / writing …），percent 0–100 */
export type GitProgress = { workspaceId: string; op: GitRemoteOp; stage: string; percent: number }

/** git:log 的一条（G-31）。time 毫秒 */
export type GitCommit = {
  hash: string
  shortHash: string
  subject: string
  author: string
  time: number
  /** 指向这个提交的分支 / 标签短名（%D 去掉 HEAD ->） */
  refs: string[]
}

export type GitLogPage = { commits: GitCommit[]; hasMore: boolean }

/** git:commitDetail 的一个文件；path / oldPath 相对仓库根 */
export type GitCommitFile = {
  path: string
  oldPath?: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  added: number
  removed: number
  binary: boolean
}

/** git:commitDetail 的返回值（G-32） */
export type GitCommitDetail = GitCommit & { body: string; email: string; parents: string[]; files: GitCommitFile[] }

/** fs:readImage 的返回值：最长边超 1600px 由主进程等比缩放后的 data URL */
export type FileImagePreview = {
  dataUrl: string
  width: number
  height: number
  size: number
  mtime: number
}

/** Skills 管理（Skills管理-PRD §5）：一次扫描出的一个 skill */
export type SkillInfo = {
  /** skill 根的标识：'claude' | 'codex' | 'agents'（全局仓） */
  agentId: string
  /** frontmatter name，缺省用目录名；跨 agent 对照与 IPC 入参都用这个 */
  name: string
  description: string | null
  /** 相对 skill 根目录的路径（/ 分隔）；详情读取走 skills:detail，路径本身不出主进程校验范围 */
  rel: string
  sizeBytes: number
  mtime: number
  /** 内置 / 受保护 skill 不可卸载 */
  isBuiltin: boolean
  source: 'github' | 'zip' | 'copy' | 'manual' | 'builtin'
  installedAt: number | null
}

export type SkillsScanResult = {
  skills: SkillInfo[]
  scannedAt: number
  /** 某个 agent 目录读不了不阻塞其他 agent */
  errors: { agentId: string; message: string }[]
}

/** skills:detail 的返回值：剥了 frontmatter 的 SKILL.md 正文（>1MB 拒） */
export type SkillDetail = {
  filename: string
  body: string
  truncated: boolean
}

/** skills:installTo / skills:installZip 的执行结果 */
export type SkillsInstallResult = {
  installed: string[]
  skipped: string[]
  failed: { agentId: string; reason: string }[]
}

/** 会话状态：主进程内存里的运行时状态 */
export type SessionStatus = 'starting' | 'running' | 'exited' | 'crashed'

export type SessionMeta = {
  id: string
  workspaceId: string
  agentId: string
  /** 同一工作区内的序号，显示为 #2 */
  index: number
  title: string
  cwd: string
  pid: number
  status: SessionStatus
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  cols: number
  rows: number
  /** 每次重启加一；渲染层据此丢弃旧进程的残留输出 */
  gen: number
  /** agent 自己的会话 ID，用于续接；拿不到时为 null */
  resumeId: string | null
  /** 本次启动是续接、兜底续接还是新开 */
  resumeMode: ResumeMode
  kind: 'agent' | 'shell'
}

/** session:data 事件；end 是本代输出累计到这一块末尾的字符数 */
export type SessionData = { id: string; gen: number; chunk: string; end: number }

/** session:buffer 返回值：回放用的原始输出 */
export type SessionBuffer = { gen: number; data: string; end: number }

export type AgentInfo = {
  id: string
  name: string
  resolvedPath: string | null
  /** 解析链路：exe 直接启动 / 还原 shim / 经 cmd 包装 */
  via: 'exe' | 'shim-exe' | 'shim-node' | 'cmd-wrap' | null
  version: string | null
  available: boolean
}

export type GridMode = 'single' | 'dual' | 'quad'

/** 四个格的会话 id；null = 空格。dual 只用 0 / 1，single 只用 0，其余位置保留以便切回时接上 */
export type Cells = [string | null, string | null, string | null, string | null]

/**
 * 界面布局（技术设计 §4 LayoutState），独立存 window-state.json。
 * 窗口尺寸与位置只由主进程记录；渲染层经 layout:update 只能改界面字段。
 */
export type Layout = {
  width: number
  height: number
  x: number | null
  y: number | null
  maximized: boolean
  sessionRailWidth: number
  sessionRailCollapsed: boolean
  fileRailWidth: number
  fileRailVisible: boolean
  /** 文件预览栏（目录栏右侧）：宽度与显隐持久化，预览的文件本身不持久化 */
  previewRailWidth: number
  previewRailVisible: boolean
  /** 右栏显示哪个页签（Git管理-PRD §4.1）：预览与 Git 共用右栏槽位、显隐与宽度 */
  rightRailTab: RightRailTab
  gridMode: GridMode
  cells: Cells
  splitRatioH: number
  splitRatioV: number
}

export type RightRailTab = 'preview' | 'git'
export const RIGHT_RAIL_TABS: RightRailTab[] = ['preview', 'git']

/** layout:update 的入参：渲染层能改的字段 */
export type LayoutPatch = Partial<Omit<Layout, 'width' | 'height' | 'x' | 'y' | 'maximized'>>

export const LAYOUT_LIMITS = {
  sessionRail: { min: 160, max: 320 },
  fileRail: { min: 180, max: 400 },
  previewRail: { min: 280, max: 640 },
  ratio: { min: 0.2, max: 0.8 },
  /** 每格最小尺寸（PRD T-02） */
  cell: { width: 360, height: 240 }
} as const

export const DEFAULT_LAYOUT: Layout = {
  width: 1440,
  height: 900,
  x: null,
  y: null,
  maximized: false,
  sessionRailWidth: 200,
  sessionRailCollapsed: false,
  fileRailWidth: 240,
  fileRailVisible: true,
  previewRailWidth: 380,
  previewRailVisible: false,
  rightRailTab: 'preview',
  gridMode: 'single',
  cells: [null, null, null, null],
  splitRatioH: 0.5,
  splitRatioV: 0.5
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  shellPath: null,
  fontSize: 13,
  fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Microsoft YaHei UI', monospace",
  scrollback: 5000,
  copyOnSelect: true,
  pasteOnCtrlV: false,
  keepShellOnAgentExit: false,
  restoreOnStartup: false,
  resumeConversation: true,
  closeAction: 'ask',
  activityBurstSec: 10,
  activityQuietSec: 5,
  notifyIdle: true,
  notifyExit: true,
  dndStart: 0,
  dndEnd: 0,
  lineHeight: 1.5,
  cursorStyle: 'block',
  cursorBlink: true,
  gitEnabled: false,
  gitDefaultRemote: 'origin'
}

/** 本机 agent 的历史会话（会话管理升级计划 §3.1）。路径不出主进程，渲染层只拿 historyId */
export type HistoryAgent = 'claude' | 'codex' | 'kimi' | 'pi'

export type HistoryItem = {
  /** 主进程生成的不透明 ID，只在本次运行有效 */
  historyId: string
  agentId: HistoryAgent
  /** agent 自己的会话 ID（续接用） */
  sessionId: string
  /** 规范化后的工作目录（斜杠统一、去掉 \?\ 前缀） */
  cwd: string
  title: string
  /** 摘要：首条用户消息；Kimi 是最近一次输入 */
  summary: string
  createdAt: number
  updatedAt: number
  size: number
  /** 正被 Warp 里运行中的会话占用 */
  running: boolean
}

export type HistoryMessage = {
  role: 'user' | 'assistant' | 'tool'
  text: string
  time: number | null
}

export type HistoryDetail = {
  messages: HistoryMessage[]
  /** 读到的消息超过上限时为 true（预览只取前 N 条） */
  truncated: boolean
}

export type HistoryExportFormat = 'markdown' | 'json' | 'raw'

export type HistoryListResult = {
  items: HistoryItem[]
  /** 某个 agent 整体读不出来（目录权限、数据库被锁）；其余照常返回 */
  failed: { agentId: HistoryAgent; reason: string }[]
}

export type HistoryResumeResult =
  | { ok: true; session: SessionMeta }
  | { ok: false; reason: string; needWorkspace: boolean; running: boolean }
