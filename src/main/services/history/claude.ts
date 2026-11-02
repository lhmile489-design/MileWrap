import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { normDir } from '@shared/path'
import { RESUME_ID_RE } from '../../lib/resume'
import {
  brief,
  eachJsonLine,
  filesIn,
  headLines,
  isInjected,
  mapLimit,
  obj,
  oneLine,
  parseTime,
  str,
  subdirs,
  tailLines,
  textParts,
  type Adapter,
  type Entry,
  type ParsedMsg
} from './common'

const HEAD = 64 * 1024
const TAIL = 256 * 1024
/** 开头是大附件时 cwd 可能在 64K 之外（实测 16 个文件）：再往后多读一些 */
const HEAD_MORE = 4 * 1024 * 1024

/** Claude Code 自己的斜杠命令回显：<command-name>/model</command-name> 显示成 /model */
function userString(s: string): string {
  const t = s.trim()
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(t)
  if (cmd && isInjected(t)) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim()
    return args ? `${cmd[1].trim()} ${args}` : cmd[1].trim()
  }
  return isInjected(t) ? '' : t
}

/** 一行 JSONL → 0..n 条消息。isMeta（注入的说明）与 isSidechain（子任务）不算对话 */
export function claudeMessages(row: Record<string, unknown>): ParsedMsg[] {
  if (row.isMeta === true || row.isSidechain === true) return []
  const type = str(row.type)
  if (type !== 'user' && type !== 'assistant') return []
  const time = parseTime(row.timestamp)
  const content = obj(row.message).content
  const out: ParsedMsg[] = []
  if (type === 'user') {
    if (typeof content === 'string') {
      const t = userString(content)
      if (t) out.push({ role: 'user', text: t, time })
      return out
    }
    if (!Array.isArray(content)) return out
    for (const p of content.map(obj)) {
      if (p.type === 'text') {
        const t = userString(str(p.text))
        if (t) out.push({ role: 'user', text: t, time })
      } else if (p.type === 'image') {
        out.push({ role: 'user', text: '[图片]', time })
      } else if (p.type === 'tool_result') {
        out.push({ role: 'tool-output', text: textParts(p.content, ['text']), time })
      }
    }
    return out
  }
  if (!Array.isArray(content)) return out
  for (const p of content.map(obj)) {
    if (p.type === 'text' && str(p.text).trim()) out.push({ role: 'assistant', text: str(p.text), time })
    else if (p.type === 'tool_use') out.push({ role: 'tool', text: brief(str(p.name), p.input), time })
  }
  return out
}

type Cached = { mtime: number; size: number; entry: Entry | null }

/**
 * Claude Code：~/.claude/projects/<目录编码>/<sessionId>.jsonl（计划 §2.1）。
 * 目录编码不可逆，目录一律取文件内的 cwd 字段；子任务在 <sessionId>/subagents/ 下，不列出。
 */
export class ClaudeAdapter implements Adapter {
  readonly agentId = 'claude' as const
  private cache = new Map<string, Cached>()

  constructor(readonly root: string) {}

  async list(): Promise<Entry[]> {
    const files = (await Promise.all((await subdirs(this.root)).map((d) => filesIn(d, /\.jsonl$/i)))).flat()
    const seen = new Set(files)
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k)
    return mapLimit(files, 16, (f) => this.one(f))
  }

  private async one(file: string): Promise<Entry | null> {
    const st = await stat(file)
    const hit = this.cache.get(file)
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.entry
    const entry = await this.parse(file, st.size, st.mtimeMs, st.birthtimeMs)
    this.cache.set(file, { mtime: st.mtimeMs, size: st.size, entry })
    return entry
  }

  private async parse(file: string, size: number, mtime: number, birth: number): Promise<Entry | null> {
    const sessionId = basename(file, '.jsonl')
    if (!RESUME_ID_RE.test(sessionId)) return null
    const head = await headLines(file, HEAD, size)
    const tail = size > HEAD ? await tailLines(file, TAIL, size) : []
    let cwd = ''
    let created: number | null = null
    let title = ''
    let summary = ''
    let lastPrompt = ''
    const scan = (rows: Record<string, unknown>[], fromHead: boolean): void => {
      for (const r of rows) {
        if (!cwd && typeof r.cwd === 'string') cwd = r.cwd
        if (fromHead && created === null) created = parseTime(r.timestamp)
        if (r.type === 'custom-title' && str(r.customTitle).trim()) title = str(r.customTitle)
        if (r.type === 'last-prompt' && str(r.lastPrompt).trim()) lastPrompt = str(r.lastPrompt)
        if (fromHead && !summary && r.type === 'user') summary = claudeMessages(r).find((m) => m.role === 'user')?.text ?? ''
      }
    }
    scan(head, true)
    // 尾部的改名（custom-title）比开头的新：后扫的覆盖先扫的
    scan(tail, false)
    if (!cwd && size > HEAD) {
      for (const r of await headLines(file, HEAD_MORE, size)) {
        if (typeof r.cwd === 'string') {
          cwd = r.cwd
          break
        }
      }
    }
    if (!cwd) return null
    summary = summary || lastPrompt
    // 只有模式切换之类的空会话：没有可看的内容，也没有续接价值
    if (!summary && !title) return null
    return {
      agentId: 'claude',
      sessionId,
      cwd: normDir(cwd),
      title: oneLine(title || summary, 120),
      summary: oneLine(summary),
      createdAt: created ?? (birth || mtime),
      updatedAt: mtime,
      size,
      file,
      extra: []
    }
  }

  async read(entry: Entry, onMsg: (m: ParsedMsg) => boolean): Promise<void> {
    await eachJsonLine(entry.file, (row) => {
      for (const m of claudeMessages(row)) if (!onMsg(m)) return false
      return true
    })
  }
}
