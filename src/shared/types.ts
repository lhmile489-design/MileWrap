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
  gridMode: GridMode
  cells: Cells
  splitRatioH: number
  splitRatioV: number
}

/** layout:update 的入参：渲染层能改的字段 */
export type LayoutPatch = Partial<Omit<Layout, 'width' | 'height' | 'x' | 'y' | 'maximized'>>

export const LAYOUT_LIMITS = {
  sessionRail: { min: 160, max: 320 },
  fileRail: { min: 180, max: 400 },
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
  cursorBlink: true
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
