import { EventEmitter } from 'node:events'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'
import { spawn as spawnPty, type IPty } from 'node-pty'
import type {
  ActivityState,
  AgentDef,
  OrphanProcess,
  RestoreCandidate,
  RestoreResult,
  ResumeMode,
  SessionBuffer,
  SessionData,
  SessionMeta,
  SessionActivity,
  SessionRecord,
  StoredWorkspace
} from '@shared/types'
import { spawnArgs, type LaunchSpec } from '../lib/commandResolver'
import { resumePrefix } from '../lib/resume'
import { stripLeadingCommand } from '../lib/launchArgs'
import type { AgentService } from './AgentService'
import type { ConfigStore } from './ConfigStore'
import { ResumeDiscovery } from './ResumeDiscovery'
import { SessionRecords } from './SessionRecords'
import { log } from '../lib/log'

const MAX_BUFFER_CHARS = 400_000
const FLUSH_INTERVAL_MS = 16
const FINAL_FLUSH_MS = 50
const RESIZE_DEBOUNCE_MS = 50
const KILL_TIMEOUT_MS = 6000
/** 活动判定的节拍：每秒检查一次各会话的「最后输出时间」 */
const ACTIVITY_TICK_MS = 1000
/** 最近这么久内有输出算「活跃」 */
const ACTIVE_WINDOW_MS = 3000
/** 剥 ANSI 转义与控制字符：OSC（BEL 或 ST 结尾）、CSI、字符集指定、单字符转义、C0/C1 */
const ANSI_STRIP_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b[()#%][0-9A-Za-z]?|\x1b[@-Z\\-_]|[\x00-\x1f\x7f-\x9f]/g

/**
 * 这段输出有没有可见文字：空闲的 TUI 会周期性重绘状态栏（纯光标定位/擦除/换行），
 * 这种噪声不该把会话一直顶在「对话中」（踩坑记录）。
 */
function hasVisibleOutput(s: string): boolean {
  return /[^\s]/.test(s.replace(ANSI_STRIP_RE, ''))
}

/** 子进程不该继承的 Electron 注入变量 */
const STRIP_ENV = ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_RENDERER_URL']

/** 用户自己写了这些参数时，不再替 Claude 指定会话 ID，避免参数冲突 */
const CLAUDE_SESSION_FLAGS = ['--session-id', '--resume', '-r', '--continue', '-c']
/** Pi 同理：用户自己指定会话相关参数时不再替它生成 ID */
const PI_SESSION_FLAGS = ['--session-id', '--session', '--resume', '-r', '--continue', '-c', '--fork', '--no-session']

/** 启动方式：普通启动是 fresh；一键恢复 / 续接启动带上续接方式与要替换的旧记录 */
export type Launch = {
  mode: ResumeMode
  resumeId: string | null
  title?: string
  /** 恢复时被新会话接替的旧快照记录 */
  replaceRecord?: string
}

interface Entry {
  meta: SessionMeta
  pty: IPty | null
  /** 本代输出（环形缓冲，超出上限丢最旧的） */
  buffer: string
  /** 本代累计输出字符数，渲染层据此判断回放与事件的衔接点 */
  total: number
  pending: string
  flushTimer: NodeJS.Timeout | null
  resizeTimer: NodeJS.Timeout | null
  /** 重启时复用：工作区、启动规格 */
  workspace: StoredWorkspace
  kind: 'agent' | 'shell'
  /** 本代进程的可执行文件；孤儿检查按 pid + 可执行文件匹配 */
  exe: string | null
  /** 活动指示（升级建议 2.1）：只记时间，不看输出内容 */
  lastOutputAt: number
  burstStartAt: number
  activity: ActivityState
  attention: boolean
}

let seq = 0
const nextId = (): string => `s${++seq}-${Date.now().toString(36)}`

export type StartOptions = { cols?: number; rows?: number }

/**
 * node-pty 会话生命周期 + 会话快照（技术设计 §5、§5.7、§5.8）。
 * 渲染层只能给 workspaceId / 记录 id，可执行文件、参数、目录全部由主进程从配置解析（§8 第 1 条）。
 */
export class SessionService extends EventEmitter {
  private entries = new Map<string, Entry>()
  private records: SessionRecords
  private discovery: ResumeDiscovery
  /** 退出应用期间：进程被我们结束，退出码不写进快照（否则自动恢复认不出「上次还在跑」） */
  private shuttingDown = false
  /** Kimi 靠「启动前后 index 新增行」认领 ID：同一目录的 Kimi 会话逐个启动（§5.8 规则 2） */
  private kimiTurns = new Map<string, Promise<void>>()
  /** 会话当前所在的格（由 index.ts 从 LayoutStore 提供） */
  private cellOf: (sessionId: string) => number | null = () => null
  private activityTimer: NodeJS.Timeout | null = null
  /** 启动时从快照里找到、仍活着的上次进程（升级建议 1.1）；只提示，不自动结束 */
  private orphans: OrphanProcess[] = []

  constructor(
    private config: ConfigStore,
    private agents: AgentService,
    /** agent 会话目录（~/.codex、~/.kimi-code）所在的主目录；harness 指到沙箱 */
    agentHome?: string
  ) {
    super()
    this.records = new SessionRecords(config)
    this.discovery = new ResumeDiscovery((sid, rid) => this.foundResumeId(sid, rid), agentHome)
    this.activityTimer = setInterval(() => this.tickActivity(), ACTIVITY_TICK_MS)
    this.activityTimer.unref?.()
  }

  setCellResolver(fn: (sessionId: string) => number | null): void {
    this.cellOf = fn
  }

  async start(workspaceId: string, kind: 'agent' | 'shell', opts: StartOptions = {}, launch?: Launch): Promise<SessionMeta> {
    const workspace = this.config.get().workspaces.find((w) => w.id === workspaceId)
    if (!workspace) throw new Error('工作区不存在')
    assertDirectory(workspace.cwd)

    const sameWorkspace = [...this.entries.values()].filter((e) => e.meta.workspaceId === workspaceId)
    const index = sameWorkspace.reduce((m, e) => Math.max(m, e.meta.index), 0) + 1
    const agentId = kind === 'shell' ? 'shell' : workspace.agentId
    const mode: ResumeMode = kind === 'shell' ? 'fresh' : (launch?.mode ?? 'fresh')

    const meta: SessionMeta = {
      id: nextId(),
      workspaceId,
      agentId,
      index,
      title: launch?.title || (index > 1 ? `${workspace.name} #${index}` : workspace.name),
      cwd: workspace.cwd,
      pid: 0,
      status: 'starting',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      cols: clampDim(opts.cols, 120),
      rows: clampDim(opts.rows, 30),
      gen: 0,
      resumeId: mode === 'exact' ? (launch?.resumeId ?? null) : null,
      resumeMode: mode,
      kind
    }
    const entry: Entry = {
      meta,
      pty: null,
      buffer: '',
      total: 0,
      pending: '',
      flushTimer: null,
      resizeTimer: null,
      workspace,
      kind,
      exe: null,
      lastOutputAt: 0,
      burstStartAt: 0,
      activity: 'idle',
      attention: false
    }
    const prefix = kind === 'agent' ? resumePrefix(agentId, mode, meta.resumeId, this.customAgent(agentId)) : []
    this.entries.set(meta.id, entry)
    try {
      await this.spawnInTurn(entry, prefix)
    } catch (e) {
      this.entries.delete(meta.id)
      throw e
    }
    this.records.upsert(this.recordOf(entry), launch?.replaceRecord)
    this.emitChanged()
    return { ...meta }
  }

  /** 重启：结束旧进程（如仍在跑），用最新配置在同一会话里再起一代；总是新开对话（§5.8 规则 4） */
  async restart(id: string): Promise<SessionMeta | null> {
    const entry = this.entries.get(id)
    if (!entry) return null
    await this.killEntry(entry)
    const latest = this.config.get().workspaces.find((w) => w.id === entry.workspace.id)
    if (!latest) throw new Error('工作区已被删除')
    assertDirectory(latest.cwd)
    this.discovery.unwatch(id)
    entry.workspace = latest
    entry.meta.cwd = latest.cwd
    if (entry.kind === 'agent') entry.meta.agentId = latest.agentId
    entry.meta.gen += 1
    entry.meta.status = 'starting'
    entry.meta.startedAt = Date.now()
    entry.meta.endedAt = null
    entry.meta.exitCode = null
    entry.meta.resumeId = null
    entry.meta.resumeMode = 'fresh'
    entry.buffer = ''
    entry.total = 0
    entry.pending = ''
    entry.lastOutputAt = 0
    entry.burstStartAt = 0
    entry.attention = false
    await this.spawnInTurn(entry, [])
    this.records.upsert(this.recordOf(entry))
    this.emitChanged()
    return { ...entry.meta }
  }

  async kill(id: string): Promise<SessionMeta | null> {
    const entry = this.entries.get(id)
    if (!entry) return null
    await this.killEntry(entry)
    return { ...entry.meta }
  }

  /** 关闭：结束进程并从列表移除；快照里标记为已关闭，下次不再作为恢复候选 */
  async close(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    await this.killEntry(entry)
    this.discovery.unwatch(id)
    this.entries.delete(id)
    if (!this.shuttingDown) {
      this.records.patch(id, (r) => {
        r.open = false
      })
    }
    this.emitChanged()
  }

  /** 重命名会话标题（PRD W-15）；只改显示，不影响进程 */
  rename(id: string, title: string): SessionMeta | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    const t = title.trim()
    if (!t) throw new Error('标题不能为空')
    if (t.length > 80) throw new Error('标题不能超过 80 个字符')
    entry.meta.title = t
    this.records.patch(id, (r) => {
      r.title = t
    })
    this.emitChanged()
    return { ...entry.meta }
  }

  write(id: string, data: string): void {
    const entry = this.entries.get(id)
    if (!entry?.pty || !isLive(entry)) return
    try {
      entry.pty.write(data)
    } catch {
      // pty 已退出
    }
  }

  /** 50ms 去抖，拖动分隔条时不刷屏 SIGWINCH（技术设计 §5.5） */
  resize(id: string, cols: number, rows: number): void {
    const entry = this.entries.get(id)
    if (!entry || cols < 2 || rows < 2) return
    entry.meta.cols = cols
    entry.meta.rows = rows
    if (entry.resizeTimer) clearTimeout(entry.resizeTimer)
    entry.resizeTimer = setTimeout(() => {
      entry.resizeTimer = null
      if (!entry.pty || !isLive(entry)) return
      try {
        entry.pty.resize(entry.meta.cols, entry.meta.rows)
      } catch {
        // pty 已退出
      }
    }, RESIZE_DEBOUNCE_MS)
  }

  buffer(id: string): SessionBuffer | null {
    const entry = this.entries.get(id)
    if (!entry) return null
    // 把待发的那段也算进来，否则回放会缺最后 16ms 的输出、随后的事件又对不上 end
    this.flush(entry)
    return { gen: entry.meta.gen, data: entry.buffer, end: entry.total }
  }

  list(): SessionMeta[] {
    return [...this.entries.values()].map((e) => ({ ...e.meta }))
  }

  liveCount(): number {
    return [...this.entries.values()].filter(isLive).length
  }

  /** 结束全部进程树；每个 taskkill 返回才 resolve，总时长 6 秒封顶 */
  async disposeAll(): Promise<void> {
    const list = [...this.entries.values()]
    const all = Promise.all(list.map((e) => this.killEntry(e)))
    const timedOut = await Promise.race([
      all.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), KILL_TIMEOUT_MS))
    ])
    // 超时还没退的：按 pid 再补一次 taskkill，然后等它真正退出（最多 2 秒），最后才 pty.kill()
    const stuck = list.filter(isLive)
    if (timedOut || stuck.length) {
      log('session.disposeAll.stuck', { timedOut, pids: stuck.map((e) => e.meta.pid) })
      await Promise.all(stuck.map((e) => killTree(e.meta.pid)))
      const deadline = Date.now() + 2000
      while (list.some(isLive) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      for (const e of list.filter(isLive)) {
        try {
          e.pty?.kill()
        } catch {
          // 已退出
        }
      }
    }
  }

  /** 把当前各会话的格位与标题写进快照（最小化到托盘、退出前、布局变化后） */
  snapshot(): void {
    const changes = new Map<string, (r: SessionRecord) => void>()
    for (const e of this.entries.values()) {
      const cell = this.cellOf(e.meta.id)
      const title = e.meta.title
      changes.set(e.meta.id, (r) => {
        r.cell = cell
        r.title = title
      })
    }
    this.records.patchMany(changes)
  }

  /** 退出应用：先写快照，再结束全部进程；期间的退出事件不改快照 */
  async shutdown(): Promise<void> {
    if (!this.shuttingDown) {
      log('shutdown.begin', { sessions: this.entries.size, live: this.liveCount() })
      this.snapshot()
      this.records.archiveStale(this.entries.size > 0)
      this.shuttingDown = true
      this.discovery.dispose()
      if (this.activityTimer) clearInterval(this.activityTimer)
      this.activityTimer = null
    }
    const t0 = Date.now()
    await this.disposeAll()
    log('shutdown.killed', { ms: Date.now() - t0, stillLive: this.liveCount() })
  }

  // ---------- 活动指示（升级建议 2.1 / 2.2） ----------

  /** 当前全部会话的活动状态（渲染层启动时拉一次，之后靠 activity 推送） */
  activityList(): SessionActivity[] {
    return [...this.entries.values()].map((e) => ({ id: e.meta.id, state: e.activity, attention: e.attention }))
  }

  /** 用户看过了（切到 / 聚焦到这个会话）：清掉「等你处理」 */
  markSeen(id: string): void {
    const e = this.entries.get(id)
    if (e && e.attention) this.setActivity(e, e.activity, false)
  }

  /** 「等你处理」的会话数（任务栏角标用） */
  attentionCount(): number {
    let n = 0
    for (const e of this.entries.values()) if (e.attention) n++
    return n
  }

  private tickActivity(): void {
    const s = this.config.get().settings
    const now = Date.now()
    for (const e of this.entries.values()) {
      if (!isLive(e) || !e.lastOutputAt) continue
      const sinceOut = now - e.lastOutputAt
      if (sinceOut < ACTIVE_WINDOW_MS) {
        if (e.activity !== 'active') this.setActivity(e, 'active', e.attention)
        continue
      }
      if (sinceOut >= s.activityQuietSec * 1000 && e.activity !== 'quiet') {
        // 先连续输出超过 burstSec，再安静 quietSec：这一轮跑完了，多半在等输入
        const wait = e.lastOutputAt - e.burstStartAt >= s.activityBurstSec * 1000
        this.setActivity(e, 'quiet', e.attention || wait)
        if (wait) this.emit('idle', { ...e.meta })
      }
    }
  }

  private setActivity(e: Entry, state: ActivityState, attention: boolean): void {
    if (e.activity === state && e.attention === attention) return
    const attentionChanged = e.attention !== attention
    e.activity = state
    e.attention = attention
    const payload: SessionActivity = { id: e.meta.id, state, attention }
    this.emit('activity', payload)
    if (attentionChanged) this.emit('attention', this.attentionCount())
  }

  // ---------- 孤儿进程（升级建议 1.1） ----------

  /**
   * 启动时调一次：快照里还记着 pid 的记录（上次退出时没结束干净），
   * 查这个 pid 现在是否还活着、可执行文件是否与记录一致。两者都对上才列出，等用户确认，绝不自动结束。
   */
  async detectOrphans(): Promise<OrphanProcess[]> {
    const recs = this.config.get().sessionRecords.filter((r) => r.pid && r.exe)
    const found: OrphanProcess[] = []
    for (const r of recs) {
      const exe = await processExe(r.pid as number)
      if (exe && exe.toLowerCase() === (r.exe as string).toLowerCase()) {
        found.push({ pid: r.pid as number, exe: r.exe as string, title: r.title, recordId: r.id })
      }
    }
    // 记录里的 pid 只用这一次：清掉，免得下次启动又拿一个被复用的 pid 来比
    if (recs.length) {
      const clear = (r: SessionRecord): void => {
        r.pid = null
        r.exe = null
      }
      this.records.patchMany(new Map(recs.map((r) => [r.id, clear])))
    }
    this.orphans = found
    log('orphans.detect', { checked: recs.length, found: found.map((o) => o.pid) })
    return found
  }

  orphanList(): OrphanProcess[] {
    return this.orphans
  }

  /** 用户确认后结束孤儿进程：动手前再核对一次 pid 与可执行文件，防 pid 被系统复用 */
  async killOrphans(pids: number[]): Promise<number> {
    let n = 0
    for (const pid of pids) {
      const o = this.orphans.find((x) => x.pid === pid)
      if (!o) continue
      const exe = await processExe(pid)
      if (!exe || exe.toLowerCase() !== o.exe.toLowerCase()) continue
      await killTree(pid)
      n++
    }
    log('orphans.kill', { requested: pids.length, killed: n })
    this.orphans = this.orphans.filter((o) => !pids.includes(o.pid))
    return n
  }

  dismissOrphans(): void {
    this.orphans = []
  }

  // ---------- 一键恢复与续接（§5.7 / §5.8） ----------

  restoreCandidates(): RestoreCandidate[] {
    return this.records.candidatesList()
  }

  /**
   * 恢复一条快照：重新启动 agent，能续接就续接。resume 缺省按设置「恢复时续接对话」。
   * 目录不存在、工作区被删时跳过并给原因，不回退到别的目录。
   */
  async restore(recordId: string, resume?: boolean): Promise<RestoreResult> {
    const c = this.restoreCandidates().find((x) => x.id === recordId)
    if (!c) return { ok: false, reason: '这条记录已失效：工作区被删除或目录不存在' }
    const want = resume ?? this.config.get().settings.resumeConversation
    const mode: ResumeMode = !want || !c.canResume ? 'fresh' : c.resumeId ? 'exact' : 'continue'
    try {
      const session = await this.start(c.workspaceId, c.kind, {}, { mode, resumeId: c.resumeId, title: c.title, replaceRecord: c.id })
      return { ok: true, session, mode }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  dismissCandidates(ids?: string[]): void {
    this.records.dismiss(ids)
  }

  /** S-10：用该工作区最近一条快照的会话 ID 续接启动 */
  async resumeWorkspace(workspaceId: string, opts: StartOptions = {}): Promise<SessionMeta> {
    const ws = this.config.get().workspaces.find((w) => w.id === workspaceId)
    if (!ws) throw new Error('工作区不存在')
    const rec = this.records.latestResumable(ws, this.liveResumeIds())
    if (!rec) throw new Error('这个工作区没有可续接的对话')
    return this.start(ws.id, 'agent', opts, { mode: 'exact', resumeId: rec.resumeId, title: rec.title, replaceRecord: rec.id })
  }

  resumable(): string[] {
    return this.records.resumableWorkspaces(this.liveResumeIds())
  }

  /** 本次运行里正被运行中会话占用的续接 ID（历史会话判断「运行中」也用它） */
  liveResumeIds(): Set<string> {
    const ids = new Set<string>()
    for (const e of this.entries.values()) if (isLive(e) && e.meta.resumeId) ids.add(e.meta.resumeId)
    return ids
  }

  /** 自定义 agent 的定义；内置 agent 返回 undefined */
  private customAgent(agentId: string): AgentDef | undefined {
    return this.config.get().customAgents.find((a) => a.id === agentId)
  }

  private recordOf(entry: Entry): SessionRecord {
    const m = entry.meta
    return {
      id: m.id,
      workspaceId: m.workspaceId,
      agentId: m.agentId,
      kind: entry.kind,
      cwd: m.cwd,
      args: [...entry.workspace.args],
      title: m.title,
      cell: this.cellOf(m.id),
      lastStartedAt: m.startedAt,
      lastExitCode: null,
      resumeId: m.resumeId,
      resumeMode: m.resumeMode,
      open: true,
      pid: isLive(entry) && m.pid > 0 ? m.pid : null,
      exe: isLive(entry) ? entry.exe : null
    }
  }

  /** 事后发现的续接 ID：立刻写进快照，不等退出（§5.8 规则 1） */
  private foundResumeId(sessionId: string, resumeId: string): void {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    entry.meta.resumeId = resumeId
    this.records.patch(sessionId, (r) => {
      r.resumeId = resumeId
    })
    this.emitChanged()
  }

  /** Kimi 新开：同一目录排队，上一个拿到 ID（或 5 秒超时）后才启动下一个 */
  private async spawnInTurn(entry: Entry, prefix: string[]): Promise<void> {
    const kimiFresh = entry.kind === 'agent' && entry.meta.agentId === 'kimi' && entry.meta.resumeMode === 'fresh'
    if (!kimiFresh) {
      this.spawn(entry, prefix)
      return
    }
    const key = entry.workspace.cwd.replace(/\\/g, '/').toLowerCase()
    const prev = this.kimiTurns.get(key) ?? Promise.resolve()
    let release: () => void = () => undefined
    const mine = new Promise<void>((r) => (release = r))
    const chain = prev.then(() => mine)
    this.kimiTurns.set(key, chain)
    await prev
    let baseline: number
    try {
      baseline = this.discovery.kimiBaseline()
      this.spawn(entry, prefix)
    } catch (e) {
      release()
      throw e
    }
    const gen = entry.meta.gen
    void this.discovery
      .waitKimi(baseline, entry.workspace.cwd)
      .then((id) => {
        if (id && entry.meta.gen === gen && this.entries.get(entry.meta.id) === entry) this.foundResumeId(entry.meta.id, id)
      })
      .finally(() => {
        release()
        if (this.kimiTurns.get(key) === chain) this.kimiTurns.delete(key)
      })
  }

  private spawn(entry: Entry, prefix: string[]): void {
    const { workspace, meta } = entry
    const settings = this.config.get().settings
    // 启动参数开头误写了命令名（"claude --permission-mode ..."）会被 agent 当成第一条消息，这里去掉
    const command = this.agents.all().find((a) => a.id === meta.agentId)?.command ?? meta.agentId
    const own = entry.kind === 'agent' ? stripLeadingCommand(workspace.args, meta.agentId, command) : workspace.args
    const args = [...prefix, ...own]

    const ownFlags = meta.agentId === 'claude' ? CLAUDE_SESSION_FLAGS : meta.agentId === 'pi' ? PI_SESSION_FLAGS : null
    if (entry.kind === 'agent' && ownFlags && meta.resumeMode === 'fresh' && !args.some((a) => ownFlags.includes(a))) {
      // Claude / Pi 支持启动时指定会话 ID：自己生成，一键恢复时按各自的续接参数带上（技术设计 §5.8）
      meta.resumeId = randomUUID()
      args.unshift('--session-id', meta.resumeId)
    }

    const spec: LaunchSpec | null =
      entry.kind === 'shell'
        ? this.agents.shellLaunch(settings.shellPath)
        : this.agents.resolve(meta.agentId, args, workspace.agentPath, settings.shellPath)
    if (!spec) throw new Error(`找不到 ${meta.agentId} 的可执行文件，请确认已安装并在 PATH 中`)

    const pty = spawnPty(spec.file, spawnArgs(spec), {
      name: 'xterm-256color',
      cols: meta.cols,
      rows: meta.rows,
      cwd: workspace.cwd,
      env: buildEnv(this.config.decryptEnv(workspace.envEnc)),
      useConpty: true
    })
    entry.pty = pty
    meta.pid = pty.pid
    const gen = meta.gen
    // 孤儿进程检查用（升级建议 1.1）：pid 与可执行文件随快照记录写盘，下次启动按两者匹配
    entry.exe = spec.file
    log('session.spawn', { id: meta.id, agent: meta.agentId, kind: entry.kind, pid: pty.pid, via: spec.via, mode: meta.resumeMode, gen })

    // Codex 首条消息后才建 rollout：会话期间持续监视（M0 实测，§5.8）
    if (entry.kind === 'agent' && meta.agentId === 'codex' && meta.resumeMode === 'fresh') {
      this.discovery.watchCodex(meta.id, workspace.cwd, meta.startedAt)
    }

    pty.onData((chunk) => {
      if (meta.gen !== gen) return
      entry.pending += chunk
      if (!entry.flushTimer) entry.flushTimer = setTimeout(() => this.flush(entry), FLUSH_INTERVAL_MS)
    })
    pty.onExit(({ exitCode }) => {
      if (meta.gen !== gen) return
      this.flush(entry)
      meta.status = exitCode === 0 ? 'exited' : 'crashed'
      meta.exitCode = exitCode
      meta.endedAt = Date.now()
      entry.pty = null
      this.discovery.unwatch(meta.id)
      log('session.exit', { id: meta.id, agent: meta.agentId, pid: pty.pid, exitCode, shuttingDown: this.shuttingDown })
      if (!this.shuttingDown) {
        this.records.patch(meta.id, (r) => {
          r.lastExitCode = exitCode
          r.pid = null
          r.exe = null
        })
      }
      this.setActivity(entry, 'idle', false)
      // 退出事件不保证晚于最后一块输出，50ms 后再补一次（技术设计 §5.4）
      setTimeout(() => {
        if (meta.gen !== gen) return
        this.flush(entry)
        this.emit('exit', { id: meta.id, gen, exitCode })
        this.emitChanged()
      }, FINAL_FLUSH_MS)
    })
  }

  private flush(entry: Entry): void {
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    if (!entry.pending) return
    const chunk = entry.pending
    entry.pending = ''
    entry.total += chunk.length
    entry.buffer = (entry.buffer + chunk).slice(-MAX_BUFFER_CHARS)
    const firstOutput = entry.meta.status === 'starting'
    if (firstOutput) entry.meta.status = 'running'
    const now = Date.now()
    // 只有带可见文字的输出才刷新活动时间：空闲 TUI 周期性发纯转义序列重绘状态栏，不算对话
    if (hasVisibleOutput(chunk)) {
      // 安静超过 quietSec 后又有输出：算新一轮的开始
      if (now - entry.lastOutputAt > this.config.get().settings.activityQuietSec * 1000) entry.burstStartAt = now
      entry.lastOutputAt = now
    }
    const data: SessionData = { id: entry.meta.id, gen: entry.meta.gen, chunk, end: entry.total }
    this.emit('data', data)
    if (firstOutput) this.emitChanged()
  }

  /**
   * 先 taskkill 整棵进程树，等 onExit；仍没退才 pty.kill()。
   * 顺序反过来会让 node-pty 的 console-list 辅助进程报 AttachConsole failed（见踩坑记录）。
   */
  private async killEntry(entry: Entry): Promise<void> {
    const pty = entry.pty
    if (!pty || !isLive(entry)) return
    const exited = new Promise<void>((r) => {
      const sub = pty.onExit(() => {
        sub.dispose()
        r()
      })
    })
    await killTree(pty.pid)
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))])
    if (entry.pty === pty) {
      try {
        pty.kill()
      } catch {
        // 已退出
      }
    }
    // 等 onExit 的 50ms 收尾跑完，调用方拿到的 meta 才是退出后的状态
    await new Promise((r) => setTimeout(r, FINAL_FLUSH_MS + 10))
  }

  private emitChanged(): void {
    this.emit('changed', this.list())
  }
}

function isLive(entry: Entry): boolean {
  return entry.meta.status === 'starting' || entry.meta.status === 'running'
}

function clampDim(v: number | undefined, fallback: number): number {
  return Number.isInteger(v) && (v as number) >= 2 && (v as number) <= 1000 ? (v as number) : fallback
}

function assertDirectory(cwd: string): void {
  if (!isAbsolute(cwd)) throw new Error('工作目录必须是绝对路径')
  let ok = false
  try {
    ok = statSync(cwd).isDirectory()
  } catch {
    ok = false
  }
  if (!ok) throw new Error(`工作目录不存在：${cwd}`)
}

function buildEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  for (const k of STRIP_ENV) delete env[k]
  return {
    ...env,
    ...extra,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  }
}

/** taskkill /T /F 结束整棵进程树；execFile 数组传参，不拼命令字符串 */
function killTree(pid: number): Promise<void> {
  return new Promise((done) => {
    try {
      execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => done())
    } catch {
      done()
    }
  })
}

/**
 * 查某个 pid 当前的可执行文件路径；进程不存在返回 null。
 * PowerShell 以数组参数调用，pid 已校验为正整数，没有注入面。
 */
function processExe(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null)
  return new Promise((done) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`],
        { windowsHide: true, timeout: 8000 },
        (err, stdout) => {
          const p = String(stdout ?? '').trim()
          done(err || !p ? null : p)
        }
      )
    } catch {
      done(null)
    }
  })
}
