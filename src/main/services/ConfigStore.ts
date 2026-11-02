import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { safeStorage } from 'electron'
import {
  CONFIG_VERSION,
  DEFAULT_SETTINGS,
  type AgentDef,
  type Config,
  type LayoutPreset,
  type PublicConfig,
  type SessionRecord,
  type Settings
} from '@shared/types'
import { atomicWrite } from '../lib/atomicWrite'

function emptyConfig(): Config {
  return {
    version: CONFIG_VERSION,
    groups: [],
    workspaces: [],
    customAgents: [],
    settings: { ...DEFAULT_SETTINGS },
    sessionRecords: [],
    layoutPresets: []
  }
}

/**
 * 配置读写。纪律照抄 Mile Terminal：
 * - 原子写；每次成功写入前把上一份良好版本轮转到 .bak
 * - 主文件读坏了另存 .corrupt，再从 .bak 恢复，不覆盖 .bak
 * - 版本迁移走显式分支，不用对象展开铺默认值（否则 version 永远停在旧值）
 */
export class ConfigStore {
  private readonly file: string
  private data: Config

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'config.json')
    this.data = this.load()
  }

  get(): Config {
    return this.data
  }

  update(mut: (c: Config) => void): Config {
    const next = structuredClone(this.data)
    mut(next)
    this.persist(next)
    this.data = next
    return next
  }

  toPublic(): PublicConfig {
    return {
      groups: this.data.groups,
      workspaces: this.data.workspaces.map(({ envEnc: _envEnc, ...w }) => w),
      settings: this.data.settings,
      customAgents: this.data.customAgents,
      layoutPresets: this.data.layoutPresets
    }
  }

  /**
   * 加密环境变量。safeStorage 不可用（极少数无 DPAPI 的环境）时拒绝保存，
   * 不退回明文落盘（PRD §6 安全）。空对象返回 null。
   */
  encryptEnv(env: Record<string, string>): string | null {
    if (Object.keys(env).length === 0) return null
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密不可用，无法保存环境变量')
    return safeStorage.encryptString(JSON.stringify(env)).toString('base64')
  }

  /** 解密某个工作区的环境变量；只在主进程启动会话时调用 */
  decryptEnv(envEnc: string | null): Record<string, string> {
    if (!envEnc || !safeStorage.isEncryptionAvailable()) return {}
    try {
      const raw = safeStorage.decryptString(Buffer.from(envEnc, 'base64'))
      const obj = JSON.parse(raw) as unknown
      if (!obj || typeof obj !== 'object') return {}
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(obj)) if (typeof v === 'string') out[k] = v
      return out
    } catch {
      return {}
    }
  }

  private load(): Config {
    const primary = this.tryRead(this.file)
    if (primary) return primary
    if (existsSync(this.file)) {
      try {
        renameSync(this.file, `${this.file}.corrupt`)
      } catch {
        // 改名失败就留着，下面的写入会覆盖它
      }
    }
    const bak = this.tryRead(`${this.file}.bak`)
    if (bak) {
      this.persist(bak, false)
      return bak
    }
    return emptyConfig()
  }

  private tryRead(file: string): Config | null {
    if (!existsSync(file)) return null
    try {
      const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
      return migrate(JSON.parse(text) as unknown)
    } catch {
      return null
    }
  }

  private persist(next: Config, rotate = true): void {
    if (rotate && existsSync(this.file) && this.tryRead(this.file)) {
      try {
        copyFileSync(this.file, `${this.file}.bak`)
      } catch {
        // .bak 轮转失败不阻塞写入
      }
    }
    atomicWrite(this.file, JSON.stringify(next, null, 2))
  }
}

const MAX_RECORDS = 50
const RECORD_ID_RE = /^s\d+-[a-z0-9]+$/
const RESUME_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

/**
 * settings:update 的校形（PRD S-02）：只认已知字段，类型或范围不对直接抛错、不落盘。
 */
export function sanitizeSettingsPatch(input: unknown): Partial<Settings> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置参数不合法')
  const r = input as Record<string, unknown>
  const out: Partial<Settings> = {}
  const bool = (k: keyof Settings): void => {
    if (r[k] === undefined) return
    if (typeof r[k] !== 'boolean') throw new Error(`设置项 ${k} 不合法`)
    ;(out as Record<string, unknown>)[k] = r[k]
  }
  const int = (k: 'fontSize' | 'scrollback' | 'activityBurstSec' | 'activityQuietSec' | 'dndStart' | 'dndEnd', min: number, max: number): void => {
    if (r[k] === undefined) return
    const v = r[k]
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new Error(`设置项 ${k} 应为 ${min}–${max} 的整数`)
    out[k] = v as number
  }
  const oneOf = <K extends 'theme' | 'closeAction' | 'cursorStyle'>(k: K, allowed: Settings[K][]): void => {
    if (r[k] === undefined) return
    if (!allowed.includes(r[k] as Settings[K])) throw new Error(`设置项 ${k} 不合法`)
    out[k] = r[k] as Settings[K]
  }
  oneOf('theme', ['light', 'dark', 'system'])
  oneOf('closeAction', ['ask', 'tray', 'quit'])
  oneOf('cursorStyle', ['block', 'bar', 'underline'])
  int('fontSize', 10, 24)
  int('scrollback', 500, 50000)
  int('activityBurstSec', 1, 120)
  int('activityQuietSec', 2, 120)
  int('dndStart', 0, 23)
  int('dndEnd', 0, 23)
  for (const k of ['copyOnSelect', 'keepShellOnAgentExit', 'restoreOnStartup', 'resumeConversation', 'notifyIdle', 'notifyExit', 'cursorBlink'] as const) bool(k)
  if (r.lineHeight !== undefined) {
    const v = r.lineHeight
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 2) throw new Error('行高应为 1–2')
    out.lineHeight = Math.round(v * 10) / 10
  }
  if (r.fontFamily !== undefined) {
    const v = r.fontFamily
    if (typeof v !== 'string' || !v.trim() || v.length > 200 || /[\u0000-\u001f]/.test(v)) throw new Error('终端字体不合法')
    out.fontFamily = v.trim()
  }
  if (r.shellPath !== undefined) {
    const v = r.shellPath
    if (v !== null && (typeof v !== 'string' || !isAbsolute(v) || v.length > 260)) throw new Error('Shell 路径必须是绝对路径')
    if (typeof v === 'string') {
      let ok = false
      try {
        ok = statSync(v).isFile()
      } catch {
        ok = false
      }
      if (!ok) throw new Error(`找不到 Shell：${v}`)
    }
    out.shellPath = v as string | null
  }
  return out
}

/** 读盘时逐条校正快照记录：坏记录丢掉，缺的字段补默认值，最多保留 50 条 */
function normalizeRecords(raw: unknown): SessionRecord[] {
  if (!Array.isArray(raw)) return []
  const out: SessionRecord[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const r = x as Record<string, unknown>
    if (typeof r.id !== 'string' || !RECORD_ID_RE.test(r.id)) continue
    if (typeof r.workspaceId !== 'string' || typeof r.agentId !== 'string' || typeof r.cwd !== 'string') continue
    out.push({
      id: r.id,
      workspaceId: r.workspaceId,
      agentId: r.agentId,
      kind: r.kind === 'shell' ? 'shell' : 'agent',
      cwd: r.cwd,
      args: Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string') : [],
      title: typeof r.title === 'string' ? r.title.slice(0, 80) : '',
      cell: Number.isInteger(r.cell) && (r.cell as number) >= 0 && (r.cell as number) <= 3 ? (r.cell as number) : null,
      lastStartedAt: typeof r.lastStartedAt === 'number' ? r.lastStartedAt : 0,
      lastExitCode: Number.isInteger(r.lastExitCode) ? (r.lastExitCode as number) : null,
      resumeId: typeof r.resumeId === 'string' && RESUME_ID_RE.test(r.resumeId) ? r.resumeId : null,
      resumeMode: r.resumeMode === 'exact' || r.resumeMode === 'continue' ? r.resumeMode : 'fresh',
      open: r.open === true,
      pid: Number.isInteger(r.pid) && (r.pid as number) > 0 ? (r.pid as number) : null,
      exe: typeof r.exe === 'string' && isAbsolute(r.exe) && r.exe.length <= 260 ? r.exe : null
    })
  }
  return out.slice(-MAX_RECORDS)
}

/**
 * 版本迁移：每一版一个分支。
 * - v1 → v2：新增 layoutPresets（布局预设）、快照记录的 pid / exe、自定义 agent 的参数字段；
 *   旧字段全部原样保留，新字段由 normalize* 补默认值
 */
function migrate(raw: unknown): Config {
  if (!raw || typeof raw !== 'object') throw new Error('配置不是对象')
  const r = raw as Partial<Config>
  const base = emptyConfig()
  const version = typeof r.version === 'number' ? r.version : 0
  if (version > CONFIG_VERSION) throw new Error(`配置版本 ${version} 高于应用支持的 ${CONFIG_VERSION}`)
  return {
    version: CONFIG_VERSION,
    groups: Array.isArray(r.groups) ? r.groups : base.groups,
    // 旧配置没有 icon 字段：补成 null（用 agent 徽章）
    workspaces: Array.isArray(r.workspaces)
      ? r.workspaces.map((w) => ({ ...w, icon: typeof w.icon === 'string' && /^[0-9a-f]{12}$/.test(w.icon) ? w.icon : null }))
      : base.workspaces,
    customAgents: normalizeAgents(r.customAgents),
    settings: { ...base.settings, ...safeSettings(r.settings) },
    sessionRecords: normalizeRecords(r.sessionRecords),
    // v1 没有这个字段（version < 2）：从空列表开始
    layoutPresets: version >= 2 ? normalizePresets((r as Partial<Config>).layoutPresets) : []
  }
}

const AGENT_ID_RE = /^custom-[a-z0-9]{6,16}$/
const COLOR_RE = /^#[0-9a-f]{6}$/i
const strArr = (v: unknown, max = 64): string[] =>
  Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string' && a.length <= 1000).slice(0, max) : []

/** 读盘时校正自定义 agent：id、命令不合法的整条丢掉 */
function normalizeAgents(raw: unknown): AgentDef[] {
  if (!Array.isArray(raw)) return []
  const out: AgentDef[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const a = x as Record<string, unknown>
    if (typeof a.id !== 'string' || !AGENT_ID_RE.test(a.id)) continue
    if (typeof a.name !== 'string' || !a.name.trim() || typeof a.command !== 'string' || !a.command.trim()) continue
    out.push({
      id: a.id,
      name: a.name.trim().slice(0, 40),
      command: a.command.trim(),
      builtin: false,
      defaultArgs: strArr(a.defaultArgs),
      color: typeof a.color === 'string' && COLOR_RE.test(a.color) ? a.color.toLowerCase() : null,
      resumeArgs: strArr(a.resumeArgs, 16),
      continueArgs: strArr(a.continueArgs, 16)
    })
  }
  return out.slice(0, 32)
}

const PRESET_ID_RE = /^p-[a-z0-9]{6,16}$/

function normalizePresets(raw: unknown): LayoutPreset[] {
  if (!Array.isArray(raw)) return []
  const out: LayoutPreset[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const p = x as Record<string, unknown>
    if (typeof p.id !== 'string' || !PRESET_ID_RE.test(p.id) || typeof p.name !== 'string' || !p.name.trim()) continue
    const gridMode = p.gridMode === 'dual' || p.gridMode === 'quad' ? p.gridMode : 'single'
    const cells = Array.isArray(p.cells) ? p.cells : []
    out.push({
      id: p.id,
      name: p.name.trim().slice(0, 40),
      gridMode,
      cells: [0, 1, 2, 3].map((i) => (typeof cells[i] === 'string' && (cells[i] as string).length <= 64 ? (cells[i] as string) : null))
    })
  }
  return out.slice(0, 20)
}

/** 读盘时的设置：逐项校形，坏的那一项退回默认值，其余保留 */
function safeSettings(raw: unknown): Partial<Settings> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Partial<Settings> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    try {
      Object.assign(out, sanitizeSettingsPatch({ [k]: v }))
    } catch {
      // 这一项作废，用默认值
    }
  }
  return out
}
