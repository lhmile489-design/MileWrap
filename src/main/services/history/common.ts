import { createReadStream } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { isAbsolute, join, relative } from 'node:path'
import type { HistoryAgent } from '@shared/types'

/** tool-output 只进导出（勾选时），不进预览 */
export type MsgRole = 'user' | 'assistant' | 'tool' | 'tool-output'
export type ParsedMsg = { role: MsgRole; text: string; time: number | null }

/** 适配器 list 的单项。路径只在主进程里，渲染层只拿 historyId */
export type Entry = {
  agentId: HistoryAgent
  sessionId: string
  cwd: string
  title: string
  summary: string
  createdAt: number
  updatedAt: number
  size: number
  /** 对话本体文件：detail / export / reveal 都用它 */
  file: string
  /** 导出原始文件时一起带上的文件（Kimi 的 state.json） */
  extra: string[]
}

export interface Adapter {
  readonly agentId: HistoryAgent
  /** 本 agent 允许访问的根目录：所有文件必须落在它下面（会话管理升级计划 §3.2） */
  readonly root: string
  /** 根目录不存在（没装这个 agent）时返回空数组；读不出来时抛错，由服务记进 failed */
  list(): Promise<Entry[]>
  /** 逐条给出消息；onMsg 返回 false 时停止读取（预览只读到够一页为止） */
  read(entry: Entry, onMsg: (m: ParsedMsg) => boolean): Promise<void>
}

/** 压成一行并截断（标题、摘要用） */
export function oneLine(s: unknown, max = 200): string {
  if (typeof s !== 'string') return ''
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n…（已截断，共 ${s.length} 字）` : s
}

/** 毫秒数或 ISO 字符串 → 毫秒；认不出返回 null */
export function parseTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string' && v) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? null : t
  }
  return null
}

export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function parseLines(text: string, dropFirst: boolean, dropLast: boolean): Record<string, unknown>[] {
  const parts = text.split('\n')
  if (dropFirst) parts.shift()
  if (dropLast) parts.pop()
  const out: Record<string, unknown>[] = []
  for (const p of parts) {
    if (!p.trim()) continue
    try {
      out.push(obj(JSON.parse(p)))
    } catch {
      // 半行或坏行跳过
    }
  }
  return out
}

/** 读文件开头 bytes 字节里的完整行（列表只读头尾，不整个解析，计划 §2.5） */
export async function headLines(file: string, bytes: number, size: number): Promise<Record<string, unknown>[]> {
  const n = Math.min(bytes, size)
  if (n <= 0) return []
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return parseLines(buf.subarray(0, bytesRead).toString('utf8'), false, bytesRead < size)
  } finally {
    await fh.close()
  }
}

/** 读文件末尾 bytes 字节里的完整行 */
export async function tailLines(file: string, bytes: number, size: number): Promise<Record<string, unknown>[]> {
  const start = Math.max(0, size - bytes)
  if (size - start <= 0) return []
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    const { bytesRead } = await fh.read(buf, 0, buf.length, start)
    return parseLines(buf.subarray(0, bytesRead).toString('utf8'), start > 0, false)
  } finally {
    await fh.close()
  }
}

/** 逐行流式读 JSONL；fn 返回 false 时提前结束（不把 40MB 的文件整个读进内存） */
export async function eachJsonLine(file: string, fn: (row: Record<string, unknown>) => boolean | void): Promise<void> {
  const stream = createReadStream(file, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      let row: Record<string, unknown>
      try {
        row = obj(JSON.parse(line))
      } catch {
        continue
      }
      if (fn(row) === false) break
    }
  } finally {
    rl.close()
    stream.destroy()
  }
}

/** 词法判断 p 是否在 root 下（列表阶段用；真正读写前再用 realpath 校验） */
export function inside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** realpath 之后仍在根目录下才放行（符号链接、联接点指到外面一律拒绝） */
export async function ensureInside(root: string, p: string): Promise<string> {
  const [r, f] = await Promise.all([realpath(root), realpath(p)])
  if (!inside(r, f)) throw new Error('路径越出 agent 的会话目录')
  return f
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/** 子目录名（读不了返回空数组） */
export async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => join(dir, d.name))
  } catch {
    return []
  }
}

export async function filesIn(dir: string, re: RegExp): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && re.test(d.name)).map((d) => join(dir, d.name))
  } catch {
    return []
  }
}

/** 并发上限 n 的 map；单项抛错按 null 处理，不影响其余 */
export async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R | null>): Promise<R[]> {
  const out: (R | null)[] = new Array(items.length).fill(null)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i])
      } catch {
        out[i] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out.filter((x): x is R => x !== null)
}

/** 整段都是 <tag>…</tag> 块：agent 注入的上下文（环境信息、命令回显、系统提醒），不是用户输入 */
export function isInjected(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (t.startsWith('# AGENTS.md instructions')) return true
  return /^(?:\s*<([a-z][a-z0-9_-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*)+$/.test(t)
}

/** 工具调用的一行摘要：优先取常见字段，其余截断 JSON */
export function brief(name: string, input: unknown): string {
  let v = input
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return oneLine(`${name} ${v}`, 300)
    }
  }
  const o = obj(v)
  for (const k of ['command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const x = o[k]
    if (typeof x === 'string' && x) return oneLine(`${name} ${x}`, 300)
    if (Array.isArray(x) && x.every((y) => typeof y === 'string')) return oneLine(`${name} ${x.join(' ')}`, 300)
  }
  const json = v === undefined ? '' : JSON.stringify(v)
  return oneLine(`${name} ${json ?? ''}`, 300)
}

/** 内容块数组里的文本（type 为 text / input_text / output_text） */
export function textParts(content: unknown, types = ['text', 'input_text', 'output_text']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => obj(c))
    .filter((c) => types.includes(str(c.type)))
    .map((c) => str(c.text))
    .filter(Boolean)
    .join('\n')
}
