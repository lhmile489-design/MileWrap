import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { statSync } from 'node:fs'
import type { AgentDef, Config, Group, LayoutPreset, PublicConfig, StoredWorkspace } from '@shared/types'
import { tokenizeArgs } from '../lib/argTokenizer'
import { badgeReadable } from '@shared/color'
import { BUILTIN_AGENTS } from './AgentService'
import type { ConfigStore } from './ConfigStore'
import type { WorkspaceIcons } from './WorkspaceIcons'

const MAX_NAME = 80
const MAX_NOTE = 500
const MAX_ARGS_TEXT = 2000
const MAX_ENV_KEYS = 64
const MAX_ENV_VALUE = 8192
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const ID_RE = /^[A-Za-z0-9-]{1,64}$/
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const COLOR_RE = /^#[0-9a-f]{6}$/i
const MAX_CUSTOM_AGENTS = 32
const MAX_PRESETS = 20
/** 自定义 agent 的命令：只认命令名（在 PATH 里找），或系统文件对话框选出的绝对路径 */
const COMMAND_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/

/**
 * 分组与工作区 CRUD。入参一律在这里校形（技术设计 §7「sanitize*」），
 * 非法值抛错且不落盘。所有修改都经 ConfigStore.update，失败时内存与磁盘都不变。
 */
export class WorkspaceService {
  constructor(
    private config: ConfigStore,
    private icons: WorkspaceIcons
  ) {}

  // ---------- 分组 ----------

  createGroup(input: unknown): PublicConfig {
    const name = sanitizeName(obj(input).name)
    this.config.update((c) => {
      c.groups.push({ id: randomUUID(), name, color: null, collapsed: false, order: nextOrder(c.groups) })
    })
    return this.config.toPublic()
  }

  renameGroup(input: unknown): PublicConfig {
    const r = obj(input)
    const id = sanitizeId(r.id)
    const name = sanitizeName(r.name)
    this.config.update((c) => {
      findGroup(c, id).name = name
    })
    return this.config.toPublic()
  }

  /** 删除分组：其下工作区移到「未分组」末尾（PRD W-02） */
  removeGroup(input: unknown): PublicConfig {
    const id = sanitizeId(obj(input).id)
    this.config.update((c) => {
      findGroup(c, id)
      c.groups = c.groups.filter((g) => g.id !== id)
      let order = nextOrder(c.workspaces.filter((w) => w.groupId === null))
      for (const w of c.workspaces) {
        if (w.groupId !== id) continue
        w.groupId = null
        w.order = order++
      }
      renumber(c.groups)
    })
    return this.config.toPublic()
  }

  /** 分组色点（PRD W-13）：#rrggbb 或 null；只用于识别，不承载状态 */
  setGroupColor(input: unknown): PublicConfig {
    const r = obj(input)
    const id = sanitizeId(r.id)
    const color = r.color === null ? null : typeof r.color === 'string' && COLOR_RE.test(r.color) ? r.color.toLowerCase() : undefined
    if (color === undefined) throw new Error('颜色应为 #rrggbb')
    this.config.update((c) => {
      findGroup(c, id).color = color
    })
    return this.config.toPublic()
  }

  /**
   * 导出分组与工作区（PRD S-04，升级建议 4.7）：不含环境变量的值、图标、快照记录。
   * 环境变量只导出键名，导入后需要重新填值。
   */
  exportData(): string {
    const c = this.config.get()
    const data = {
      app: 'mile-warp',
      kind: 'workspaces',
      version: 1,
      exportedAt: new Date().toISOString(),
      groups: c.groups.map((g) => ({ id: g.id, name: g.name, color: g.color, order: g.order })),
      workspaces: c.workspaces.map((w) => ({
        groupId: w.groupId,
        name: w.name,
        note: w.note,
        agentId: w.agentId,
        cwd: w.cwd,
        args: w.args,
        envKeys: w.envKeys,
        order: w.order
      })),
      customAgents: c.customAgents.map((a) => ({ ...a }))
    }
    return JSON.stringify(data, null, 2)
  }

  /**
   * 导入：逐个校验，目录不存在、agent 未知、名称不合法的工作区跳过并给原因；
   * 分组按名称合并（同名就并进去），自定义 agent 按 id 合并（已存在的不覆盖）。
   */
  importData(text: string): { config: PublicConfig; imported: number; skipped: string[] } {
    let raw: unknown
    try {
      raw = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch {
      throw new Error('文件不是合法的 JSON')
    }
    const r = obj(raw)
    if (r.app !== 'mile-warp' || r.kind !== 'workspaces' || !Array.isArray(r.workspaces)) throw new Error('这不是 Mile Warp 导出的工作区文件')
    const skipped: string[] = []
    let imported = 0
    this.config.update((c) => {
      // 自定义 agent
      for (const x of Array.isArray(r.customAgents) ? r.customAgents : []) {
        const a = obj(x)
        if (typeof a.id !== 'string' || !AGENT_ID_RE.test(a.id)) continue
        if (BUILTIN_AGENTS.some((b) => b.id === a.id) || c.customAgents.some((b) => b.id === a.id)) continue
        if (c.customAgents.length >= MAX_CUSTOM_AGENTS) break
        try {
          const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 64) : [])
          const color = typeof a.color === 'string' && COLOR_RE.test(a.color) && badgeReadable(a.color) ? a.color.toLowerCase() : null
          c.customAgents.push({
            id: a.id,
            name: sanitizeName(a.name),
            command: sanitizeCommand(a.command),
            builtin: false,
            color,
            defaultArgs: strs(a.defaultArgs),
            resumeArgs: strs(a.resumeArgs),
            continueArgs: strs(a.continueArgs)
          })
        } catch (e) {
          skipped.push(`agent ${String(a.name ?? a.id)}：${e instanceof Error ? e.message : String(e)}`)
        }
      }
      // 分组：旧 id -> 新 id
      const groupMap = new Map<string, string>()
      for (const x of Array.isArray(r.groups) ? r.groups : []) {
        const g = obj(x)
        if (typeof g.id !== 'string') continue
        let name: string
        try {
          name = sanitizeName(g.name)
        } catch {
          continue
        }
        const same = c.groups.find((y) => y.name === name)
        if (same) {
          groupMap.set(g.id, same.id)
          continue
        }
        const id = randomUUID()
        const color = typeof g.color === 'string' && COLOR_RE.test(g.color) ? g.color.toLowerCase() : null
        c.groups.push({ id, name, color, collapsed: false, order: nextOrder(c.groups) })
        groupMap.set(g.id, id)
      }
      const now = Date.now()
      for (const x of r.workspaces as unknown[]) {
        const w = obj(x)
        const label = typeof w.name === 'string' ? w.name : '（未命名）'
        try {
          const name = sanitizeName(w.name)
          const cwd = sanitizeCwd(w.cwd)
          const agentId = typeof w.agentId === 'string' ? w.agentId : ''
          assertAgent(c, agentId)
          const args = Array.isArray(w.args) ? w.args.filter((a): a is string => typeof a === 'string').slice(0, 200) : []
          const groupId = typeof w.groupId === 'string' ? (groupMap.get(w.groupId) ?? null) : null
          c.workspaces.push({
            id: randomUUID(),
            icon: null,
            groupId,
            name,
            note: typeof w.note === 'string' ? w.note.trim().slice(0, MAX_NOTE) : '',
            agentId,
            agentPath: null,
            cwd,
            args,
            // 环境变量值不在导出文件里：不带键名过来，免得界面上显示「有值」
            envKeys: [],
            envEnc: null,
            order: nextOrder(c.workspaces.filter((y) => y.groupId === groupId)),
            createdAt: now,
            updatedAt: now
          })
          imported++
        } catch (e) {
          skipped.push(`${label}：${e instanceof Error ? e.message : String(e)}`)
        }
      }
    })
    return { config: this.config.toPublic(), imported, skipped }
  }

  toggleGroup(input: unknown): PublicConfig {
    const r = obj(input)
    const id = sanitizeId(r.id)
    this.config.update((c) => {
      const g = findGroup(c, id)
      g.collapsed = typeof r.collapsed === 'boolean' ? r.collapsed : !g.collapsed
    })
    return this.config.toPublic()
  }

  /** 按给定 id 顺序重排分组；必须恰好是现有分组的一个排列 */
  reorderGroups(input: unknown): PublicConfig {
    const ids = obj(input).ids
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new Error('排序参数不合法')
    this.config.update((c) => {
      const set = new Set(ids)
      if (set.size !== ids.length || ids.length !== c.groups.length || !c.groups.every((g) => set.has(g.id))) {
        throw new Error('排序参数与分组不一致')
      }
      for (const g of c.groups) g.order = ids.indexOf(g.id)
    })
    return this.config.toPublic()
  }

  // ---------- 工作区 ----------

  create(input: unknown): PublicConfig {
    const w = sanitizeWorkspaceInput(input)
    const now = Date.now()
    const id = randomUUID()
    // 先写图标文件；配置写失败时再删掉，不留孤儿文件
    const icon = w.iconToken ? this.icons.commit(id, w.iconToken) : null
    try {
      this.config.update((c) => {
        if (w.groupId && !c.groups.some((g) => g.id === w.groupId)) throw new Error('分组不存在')
        assertAgent(c, w.agentId)
        const env = applyEnvPatch({}, w.env)
        c.workspaces.push({
          id,
          icon,
          groupId: w.groupId,
          name: w.name,
          note: w.note,
          agentId: w.agentId,
          agentPath: null,
          cwd: w.cwd,
          args: w.args,
          envKeys: Object.keys(env).sort(),
          envEnc: this.config.encryptEnv(env),
          order: nextOrder(c.workspaces.filter((x) => x.groupId === w.groupId)),
          createdAt: now,
          updatedAt: now
        })
      })
    } catch (e) {
      if (icon) this.icons.remove(id)
      throw e
    }
    this.icons.consume(w.iconToken)
    return this.config.toPublic()
  }

  /**
   * 编辑：只改传了的字段；运行中的会话下次启动生效（PRD W-05）。
   * 图标文件在配置落盘前就改了：配置写失败时把文件还原成改动前，token 也不作废。
   */
  edit(input: unknown): PublicConfig {
    const r = obj(input)
    const id = sanitizeId(r.id)
    const patch = sanitizeWorkspaceInput(r, true)
    const restoreIcon = patch.iconToken !== undefined ? this.icons.snapshot(id) : null
    try {
      this.applyEdit(id, patch)
    } catch (e) {
      restoreIcon?.()
      throw e
    }
    this.icons.consume(patch.iconToken)
    return this.config.toPublic()
  }

  private applyEdit(id: string, patch: Partial<CleanInput>): void {
    this.config.update((c) => {
      const w = findWorkspace(c, id)
      if (patch.name !== undefined) w.name = patch.name
      if (patch.note !== undefined) w.note = patch.note
      if (patch.agentId !== undefined) {
        assertAgent(c, patch.agentId)
        w.agentId = patch.agentId
      }
      if (patch.cwd !== undefined) w.cwd = patch.cwd
      if (patch.args !== undefined) w.args = patch.args
      if (patch.groupId !== undefined && patch.groupId !== w.groupId) {
        if (patch.groupId && !c.groups.some((g) => g.id === patch.groupId)) throw new Error('分组不存在')
        w.groupId = patch.groupId
        w.order = nextOrder(c.workspaces.filter((x) => x.groupId === patch.groupId && x.id !== w.id))
      }
      if (patch.env) {
        const env = applyEnvPatch(this.config.decryptEnv(w.envEnc), patch.env)
        w.envKeys = Object.keys(env).sort()
        w.envEnc = this.config.encryptEnv(env)
      }
      // 图标：token = 换图（先校验工作区存在再写盘）；null = 恢复默认；undefined = 不变
      if (patch.iconToken === null) {
        this.icons.remove(id)
        w.icon = null
      } else if (patch.iconToken !== undefined) {
        w.icon = this.icons.commit(id, patch.iconToken)
      }
      w.updatedAt = Date.now()
    })
  }

  remove(input: unknown): PublicConfig {
    const id = sanitizeId(obj(input).id ?? input)
    this.config.update((c) => {
      const w = findWorkspace(c, id)
      c.workspaces = c.workspaces.filter((x) => x.id !== id)
      renumber(c.workspaces.filter((x) => x.groupId === w.groupId))
    })
    this.icons.remove(id)
    return this.config.toPublic()
  }

  /** 复制（PRD W-10）：放在原工作区之后，名称加「副本」，环境变量一并复制；配置写失败时删掉复制出的图标 */
  duplicate(input: unknown): PublicConfig {
    const id = sanitizeId(obj(input).id)
    const newId = randomUUID()
    try {
      this.applyDuplicate(id, newId)
    } catch (e) {
      this.icons.remove(newId)
      throw e
    }
    return this.config.toPublic()
  }

  private applyDuplicate(id: string, newId: string): void {
    this.config.update((c) => {
      const src = findWorkspace(c, id)
      const now = Date.now()
      for (const x of c.workspaces) if (x.groupId === src.groupId && x.order > src.order) x.order++
      // 图标文件一起复制；源文件丢了就退回默认徽章
      const icon = src.icon && this.icons.copy(src.id, newId) ? src.icon : null
      const copy: StoredWorkspace = {
        ...structuredClone(src),
        id: newId,
        icon,
        name: `${src.name} 副本`.slice(0, MAX_NAME),
        order: src.order + 1,
        createdAt: now,
        updatedAt: now
      }
      c.workspaces.push(copy)
    })
  }

  /**
   * 移动到分组的指定位置（拖拽排序与跨组移动共用，PRD W-08）。
   * groupId 为 null 表示「未分组」；index 越界时夹到末尾。
   */
  move(input: unknown): PublicConfig {
    const r = obj(input)
    const id = sanitizeId(r.id)
    const groupId = r.groupId === null ? null : sanitizeId(r.groupId)
    const index = Number.isInteger(r.index) ? Math.max(0, r.index as number) : Number.MAX_SAFE_INTEGER
    this.config.update((c) => {
      const w = findWorkspace(c, id)
      if (groupId && !c.groups.some((g) => g.id === groupId)) throw new Error('分组不存在')
      const from = w.groupId
      const target = c.workspaces.filter((x) => x.groupId === groupId && x.id !== id).sort(byOrder)
      target.splice(Math.min(index, target.length), 0, w)
      w.groupId = groupId
      target.forEach((x, i) => (x.order = i))
      if (from !== groupId) renumber(c.workspaces.filter((x) => x.groupId === from))
      w.updatedAt = Date.now()
    })
    return this.config.toPublic()
  }

  // ---------- 自定义 agent（PRD A-03，升级建议 3.3） ----------

  /**
   * 新增或修改自定义 agent。命令只接受命令名或绝对路径（指向存在的文件）；参数照旧经 argTokenizer 切成数组。
   * 绝对路径只能来自 agent:pickCommand 的系统文件对话框，渲染层手填的绝对路径也照样校验存在性。
   */
  saveCustomAgent(input: unknown): PublicConfig {
    const r = obj(input)
    const name = sanitizeName(r.name)
    const command = sanitizeCommand(r.command)
    const color = r.color === null || r.color === undefined || r.color === '' ? null : String(r.color)
    if (color !== null && !COLOR_RE.test(color)) throw new Error('徽章颜色应为 #rrggbb')
    // UI设计约束 §4.3：徽章字与底色对比度 ≥ 4.5:1
    if (color !== null && !badgeReadable(color)) throw new Error('这个颜色上的徽章文字对比度不到 4.5:1，换深一点或浅一点的颜色')
    const args = (k: string): string[] => {
      const t = typeof r[k] === 'string' ? (r[k] as string) : ''
      if (t.length > MAX_ARGS_TEXT) throw new Error('参数过长')
      return tokenizeArgs(t)
    }
    const defaultArgs = args('argsText')
    const resumeArgs = args('resumeArgsText')
    const continueArgs = args('continueArgsText')
    if (resumeArgs.length && !resumeArgs.some((a) => a.includes('{id}'))) throw new Error('续接模板里要有 {id} 占位符')
    this.config.update((c) => {
      if (typeof r.id === 'string' && r.id) {
        const a = c.customAgents.find((x) => x.id === r.id)
        if (!a) throw new Error('自定义 agent 不存在')
        Object.assign(a, { name, command, color, defaultArgs, resumeArgs, continueArgs })
        return
      }
      if (c.customAgents.length >= MAX_CUSTOM_AGENTS) throw new Error(`自定义 agent 最多 ${MAX_CUSTOM_AGENTS} 个`)
      const id = uniqueAgentId(c, name)
      const def: AgentDef = { id, name, command, builtin: false, color, defaultArgs, resumeArgs, continueArgs }
      c.customAgents.push(def)
    })
    return this.config.toPublic()
  }

  /** 删除自定义 agent：还有工作区在用就拒绝，免得工作区启动不了 */
  removeCustomAgent(input: unknown): PublicConfig {
    const id = obj(input).id
    if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) throw new Error('id 不合法')
    this.config.update((c) => {
      if (!c.customAgents.some((a) => a.id === id)) throw new Error('自定义 agent 不存在')
      const users = c.workspaces.filter((w) => w.agentId === id)
      if (users.length) throw new Error(`还有 ${users.length} 个工作区在用这个 agent，先把它们改成别的 agent`)
      c.customAgents = c.customAgents.filter((a) => a.id !== id)
    })
    return this.config.toPublic()
  }

  // ---------- 布局预设（升级建议 3.1） ----------

  /** 保存预设：同名覆盖。cells 里只能是存在的工作区 id 或 null */
  savePreset(input: unknown): PublicConfig {
    const r = obj(input)
    const name = sanitizeName(r.name)
    const gridMode = r.gridMode
    if (gridMode !== 'single' && gridMode !== 'dual' && gridMode !== 'quad') throw new Error('宫格模式不合法')
    if (!Array.isArray(r.cells) || r.cells.length !== 4) throw new Error('格位不合法')
    const cells = r.cells.map((x) => (x === null ? null : sanitizeId(x)))
    this.config.update((c) => {
      for (const id of cells) if (id && !c.workspaces.some((w) => w.id === id)) throw new Error('预设里有不存在的工作区')
      const existing = c.layoutPresets.find((p) => p.name === name)
      if (existing) {
        existing.gridMode = gridMode
        existing.cells = cells
        return
      }
      if (c.layoutPresets.length >= MAX_PRESETS) throw new Error(`布局预设最多 ${MAX_PRESETS} 个`)
      const p: LayoutPreset = { id: randomUUID(), name, gridMode, cells }
      c.layoutPresets.push(p)
    })
    return this.config.toPublic()
  }

  removePreset(input: unknown): PublicConfig {
    const id = sanitizeId(obj(input).id)
    this.config.update((c) => {
      c.layoutPresets = c.layoutPresets.filter((p) => p.id !== id)
    })
    return this.config.toPublic()
  }
}

// ---------- 校形 ----------

function obj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

function sanitizeId(raw: unknown): string {
  if (typeof raw !== 'string' || !ID_RE.test(raw)) throw new Error('id 不合法')
  return raw
}

function sanitizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name) throw new Error('名称不能为空')
  if (name.length > MAX_NAME) throw new Error(`名称不能超过 ${MAX_NAME} 个字符`)
  return name
}

function sanitizeCwd(raw: unknown): string {
  const cwdRaw = typeof raw === 'string' ? raw.trim() : ''
  if (!cwdRaw || !isAbsolute(cwdRaw)) throw new Error('工作目录必须是绝对路径')
  const cwd = resolve(cwdRaw)
  let isDir = false
  try {
    isDir = statSync(cwd).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) throw new Error(`工作目录不存在：${cwd}`)
  return cwd
}

function sanitizeEnv(raw: unknown): Record<string, string | null> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('环境变量格式不合法')
  const out: Record<string, string | null> = {}
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_ENV_KEYS) throw new Error(`环境变量最多 ${MAX_ENV_KEYS} 个`)
  for (const [k, v] of entries) {
    if (!ENV_KEY_RE.test(k)) throw new Error(`环境变量名不合法：${k}`)
    if (v === null) out[k] = null
    else if (typeof v === 'string' && v.length <= MAX_ENV_VALUE && !v.includes('\0')) out[k] = v
    else throw new Error(`环境变量 ${k} 的值不合法`)
  }
  return out
}

type CleanInput = {
  name: string
  agentId: string
  cwd: string
  args: string[]
  note: string
  groupId: string | null
  env: Record<string, string | null> | undefined
  /** 字符串由 WorkspaceIcons.commit 再校验格式与是否存在 */
  iconToken: string | null | undefined
}

function sanitizeWorkspaceInput(input: unknown): CleanInput
function sanitizeWorkspaceInput(input: unknown, partial: true): Partial<CleanInput>
function sanitizeWorkspaceInput(input: unknown, partial = false): Partial<CleanInput> {
  if (!input || typeof input !== 'object') throw new Error('参数不合法')
  const r = input as Record<string, unknown>
  const has = (k: string): boolean => !partial || r[k] !== undefined
  const out: Partial<CleanInput> = {}

  if (has('name')) out.name = sanitizeName(r.name)
  if (has('agentId')) {
    const agentId = typeof r.agentId === 'string' ? r.agentId : ''
    if (!AGENT_ID_RE.test(agentId)) throw new Error('未知的 agent')
    out.agentId = agentId
  }
  if (has('cwd')) out.cwd = sanitizeCwd(r.cwd)
  if (has('argsText')) {
    const argsText = typeof r.argsText === 'string' ? r.argsText : ''
    if (argsText.length > MAX_ARGS_TEXT) throw new Error('启动参数过长')
    const tokens = tokenizeArgs(argsText)
    // 开头误写的命令名（"claude --xxx"）保存时就去掉，界面上也看得到被清理
    const agent = typeof r.agentId === 'string' ? r.agentId : ''
    out.args = agent && tokens[0]?.toLowerCase() === agent ? tokens.slice(1) : tokens
  }
  if (has('note')) out.note = typeof r.note === 'string' ? r.note.trim().slice(0, MAX_NOTE) : ''
  if (has('groupId')) out.groupId = typeof r.groupId === 'string' && r.groupId ? sanitizeId(r.groupId) : null
  if (r.env !== undefined) out.env = sanitizeEnv(r.env)
  if (r.iconToken === null) out.iconToken = null
  else if (r.iconToken !== undefined) {
    if (typeof r.iconToken !== 'string') throw new Error('图标参数不合法')
    out.iconToken = r.iconToken
  }
  return out
}

/** agent 必须是内置或已登记的自定义 agent */
function assertAgent(c: Config, agentId: string): void {
  if (BUILTIN_AGENTS.some((a) => a.id === agentId)) return
  if (c.customAgents.some((a) => a.id === agentId)) return
  throw new Error('未知的 agent')
}

function sanitizeCommand(raw: unknown): string {
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (!v) throw new Error('命令不能为空')
  if (COMMAND_NAME_RE.test(v)) return v
  if (!isAbsolute(v) || v.length > 260 || /[\u0000-\u001f"<>|]/.test(v)) throw new Error('命令只能是命令名，或可执行文件的绝对路径')
  let ok = false
  try {
    ok = statSync(v).isFile()
  } catch {
    ok = false
  }
  if (!ok) throw new Error(`找不到可执行文件：${v}`)
  if (!/\.(exe|cmd|bat|com)$/i.test(v)) throw new Error('只支持 .exe / .cmd / .bat / .com')
  return v
}

/** 由名称生成 id：小写字母数字与短横线，和内置 / 已有的不重复 */
function uniqueAgentId(c: Config, name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'agent'
  const taken = new Set([...BUILTIN_AGENTS.map((a) => a.id), ...c.customAgents.map((a) => a.id)])
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
  return `agent-${randomUUID().slice(0, 8)}`
}

// ---------- 小工具 ----------

function applyEnvPatch(base: Record<string, string>, patch: Record<string, string | null> | undefined): Record<string, string> {
  const env = { ...base }
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) delete env[k]
    else env[k] = v
  }
  return env
}

function byOrder(a: { order: number }, b: { order: number }): number {
  return a.order - b.order
}

function nextOrder(list: { order: number }[]): number {
  return list.reduce((m, x) => Math.max(m, x.order + 1), 0)
}

function renumber(list: { order: number }[]): void {
  ;[...list].sort(byOrder).forEach((x, i) => (x.order = i))
}

function findGroup(c: Config, id: string): Group {
  const g = c.groups.find((x) => x.id === id)
  if (!g) throw new Error('分组不存在')
  return g
}

function findWorkspace(c: Config, id: string): StoredWorkspace {
  const w = c.workspaces.find((x) => x.id === id)
  if (!w) throw new Error('工作区不存在')
  return w
}
