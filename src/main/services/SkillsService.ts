import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, rmSync, renameSync, cpSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import type { SkillDetail, SkillInfo, SkillsInstallResult, SkillsScanResult } from '@shared/types'
import { inside } from './history/common'

/** skill 根目录声明：渲染层只传 agentId + name，真实路径从这里查（Skills管理-PRD §5） */
export type SkillRoot = {
  agentId: string
  /** 用户主目录下的相对路径；实测定稿见 PRD §5 映射表 */
  rel: string
  /** builtin 目录只读不可卸载（预留） */
  builtin?: boolean
}

/** 2026-11-04 探针（scripts/probe-skills.cjs）定稿：kimi / pi 无 skill 目录，不列 */
export const SKILL_ROOTS: SkillRoot[] = [
  { agentId: 'claude', rel: '.claude/skills' },
  { agentId: 'codex', rel: '.codex/skills' },
  { agentId: 'agents', rel: '.agents/skills' }
]

const SKILL_FILES = ['SKILL.md', 'AGENTS.md'] as const
const SCAN_MAX_DEPTH = 2
const DETAIL_MAX_BYTES = 1_000_000
/** 安装目标 agent（有 skill 目录声明的才可写入） */
const INSTALLABLE = SKILL_ROOTS.map((r) => r.agentId)

export function agentRootsOf(agentId: string): SkillRoot | null {
  return SKILL_ROOTS.find((r) => r.agentId === agentId) ?? null
}

export function isInstallable(agentId: string): boolean {
  return INSTALLABLE.includes(agentId)
}

/** 无依赖 frontmatter 解析（语义对齐 skillkit skill-md.ts）：`---` 起始 + `\n---` 闭合 + 扁平 key: value */
export function parseFrontmatter(text: string): Record<string, string> | null {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end < 0) return null
  const block = text.slice(3, end).replace(/\r\n/g, '\n')
  const out: Record<string, string> = {}
  let currentKey: string | null = null
  for (const lineRaw of block.split('\n')) {
    const line = lineRaw.replace(/\s+$/g, '')
    if (!line.trim()) continue
    if (currentKey && /^\s+\S/.test(line)) {
      out[currentKey] += ' ' + line.trim()
      continue
    }
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const value = m[2].trim()
    out[m[1]] = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")) ? value.slice(1, -1) : value
    currentKey = m[1]
  }
  return out
}

export class SkillsService {
  constructor(private home: string) {}

  /** 全量扫描：文件系统是真相，即扫即用，不落盘（PRD §5） */
  scan(): SkillsScanResult {
    const skills: SkillInfo[] = []
    const errors: { agentId: string; message: string }[] = []
    for (const root of SKILL_ROOTS) {
      const abs = join(this.home, root.rel)
      try {
        this.scanDir(abs, abs, 0, root, skills)
      } catch (e) {
        errors.push({ agentId: root.agentId, message: codeOf(e) })
      }
    }
    return { skills, scannedAt: Date.now(), errors }
  }

  /** 两级扫描：一级有 SKILL.md 即 skill，无则当分组目录下沉（对齐 skillkit scan.ts） */
  private scanDir(topRoot: string, dir: string, depth: number, root: SkillRoot, out: SkillInfo[]): void {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      if (e.name.startsWith('.')) continue
      const sub = join(dir, e.name)
      let st
      try {
        st = statSync(sub) // 跟随 symlink；trae/qoder 的 skills 是指向全局仓的链接，按实体读
      } catch {
        continue // 悬空链接跳过
      }
      if (!st.isDirectory()) continue
      const rel = sub.slice(topRoot.length + 1).split('\\').join('/')
      const mdFile = SKILL_FILES.find((f) => existsSync(join(sub, f)))
      if (mdFile) {
        const fm = parseFrontmatter(readFileSync(join(sub, mdFile), 'utf8'))
        out.push({
          agentId: root.agentId,
          name: fm?.name?.trim() || e.name,
          description: fm?.description?.trim() || null,
          rel,
          sizeBytes: dirSize(sub),
          mtime: st.mtimeMs,
          isBuiltin: root.builtin === true,
          source: root.builtin === true ? 'builtin' : 'manual',
          installedAt: null
        })
      } else if (depth < SCAN_MAX_DEPTH - 1) {
        this.scanDir(topRoot, sub, depth + 1, root, out)
      }
    }
  }

  /** 详情：剥 frontmatter 的 SKILL.md 正文；name 必须落在声明根内（防构造 name 越界） */
  detail(input: unknown): SkillDetail {
    const { agentId, name } = parseSkillRef(input)
    const root = agentRootsOf(agentId)
    if (!root) throw new Error('未知 skill 根')
    const dir = this.locate(root, name)
    const file = SKILL_FILES.map((f) => join(dir, f)).find((f) => existsSync(f))
    if (!file) throw new Error('目录里没有 SKILL.md')
    const st = statSync(file)
    if (st.size > DETAIL_MAX_BYTES) throw new Error('SKILL.md 太大，不做详情渲染')
    let text = readFileSync(file, 'utf8')
    let truncated = false
    if (text.length > DETAIL_MAX_BYTES) {
      text = text.slice(0, DETAIL_MAX_BYTES)
      truncated = true
    }
    // 剥 frontmatter（渲染层拿到的就是纯正文）
    if (text.startsWith('---')) {
      const end = text.indexOf('\n---', 3)
      if (end >= 0) {
        const nextLf = text.indexOf('\n', end + 1)
        text = nextLf >= 0 ? text.slice(nextLf + 1) : ''
      }
    }
    return { filename: basename(file), body: text.trim(), truncated }
  }

  /** 卸载：删整个 skill 目录；builtin 一律拒绝；name 校验同 detail */
  uninstall(input: unknown): { ok: true } {
    const { agentId, name } = parseSkillRef(input)
    const root = agentRootsOf(agentId)
    if (!root) throw new Error('未知 skill 根')
    if (root.builtin) throw new Error('内置 skill 不可卸载')
    const dir = this.locate(root, name)
    rmSync(dir, { recursive: true, force: false })
    return { ok: true }
  }

  /** 跨 agent 安装：复制目录到目标根下；同名冲突按 onConflict 处理，覆盖先留 .bak */
  installTo(input: unknown): SkillsInstallResult {
    const r = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const { agentId, dir: srcDir } = this.parseRefAndLocate(r)
    const targets = r.targets
    if (!Array.isArray(targets) || targets.length === 0 || targets.some((t) => typeof t !== 'string')) throw new Error('targets 不合法')
    const conflict = r.onConflict === 'overwrite' ? 'overwrite' : 'skip'
    const result: SkillsInstallResult = { installed: [], skipped: [], failed: [] }
    for (const t of targets) {
      if (typeof t !== 'string' || t === agentId) {
        result.skipped.push(String(t))
        continue
      }
      const targetRoot = agentRootsOf(t)
      if (!targetRoot) {
        result.failed.push({ agentId: t, reason: '未知 skill 根' })
        continue
      }
      const targetParent = resolve(this.home, targetRoot.rel)
      try {
        if (!existsSync(targetParent)) mkdirSync(targetParent, { recursive: true })
        const target = join(targetParent, basename(srcDir))
        if (!inside(targetParent, target)) {
          result.failed.push({ agentId: t, reason: '目标路径越出根目录' })
          continue
        }
        if (existsSync(target)) {
          if (conflict === 'skip') {
            result.skipped.push(t)
            continue
          }
          // 覆盖前把旧目录改名保留（对齐项目 .bak 惯例；PRD §9 风险 4）
          renameSync(target, `${target}.bak-${Date.now()}`)
        }
        cpSync(srcDir, target, { recursive: true })
        result.installed.push(t)
      } catch (e) {
        result.failed.push({ agentId: t, reason: codeOf(e) })
      }
    }
    return result
  }

  /** reveal：资源管理器定位（复用 shell:revealPath 的思路但按 skill 根校验） */
  dirOf(input: unknown): string {
    const { dir } = this.parseRefAndLocate(input && typeof input === 'object' ? (input as Record<string, unknown>) : {})
    return dir
  }

  /** 解析 agentId + name 并返回实际目录：name 不接受路径分隔符（渲染层只传名字，rel 由扫描算） */
  private parseRefAndLocate(r: Record<string, unknown>): { agentId: string; name: string; dir: string } {
    const { agentId, name } = parseSkillRef(r)
    const root = agentRootsOf(agentId)
    if (!root) throw new Error('未知 skill 根')
    const dir = this.locate(root, name)
    return { agentId, name, dir }
  }

  /** name → 实际目录：只允许一层名字（扫描结果的顶层），越界 / 多级路径一律拒绝 */
  private locate(root: SkillRoot, name: string): string {
    if (typeof name !== 'string' || !name || name.length > 128) throw new Error('skill 名不合法')
    if (name.includes('/') || name.includes('\\') || name.includes('..')) throw new Error('skill 名不合法')
    const parent = resolve(this.home, root.rel)
    const dir = resolve(parent, name)
    if (!inside(parent, dir)) throw new Error('路径越出 skill 根目录')
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('skill 目录不存在')
    return dir
  }
}

function parseSkillRef(input: unknown): { agentId: string; name: string } {
  const r = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const agentId = r.agentId
  const name = r.name
  if (typeof agentId !== 'string' || !agentId) throw new Error('agentId 不合法')
  if (typeof name !== 'string' || !name) throw new Error('skill 名不合法')
  return { agentId, name }
}

function codeOf(e: unknown): string {
  const c = (e as { code?: string })?.code
  if (c === 'ENOENT') return '目录不存在'
  if (c === 'EPERM' || c === 'EACCES') return '没有权限'
  if (c === 'ENOTEMPTY' || c === 'EEXIST') return '目录非空或已存在'
  return e instanceof Error ? e.message : String(e)
}

/** 目录大小（扫描用，浅层不递归太深；skill 目录 < 几 MB 量级） */
function dirSize(dir: string): number {
  let total = 0
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) total += dirSize(p)
      else total += statSync(p).size
    }
  } catch {
    // 读不了的子项跳过
  }
  return total
}
