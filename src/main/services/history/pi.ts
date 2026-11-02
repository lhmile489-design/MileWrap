import { stat } from 'node:fs/promises'
import { normDir } from '@shared/path'
import { RESUME_ID_RE } from '../../lib/resume'
import { brief, eachJsonLine, filesIn, headLines, mapLimit, obj, oneLine, parseTime, str, subdirs, textParts, type Adapter, type Entry, type ParsedMsg } from './common'

const HEAD = 128 * 1024

/** 一行 → 0..n 条消息：user / assistant 的文字、assistant 的 toolCall、toolResult；thinking 不要 */
function piMessages(row: Record<string, unknown>): ParsedMsg[] {
  if (row.type !== 'message') return []
  const m = obj(row.message)
  const time = parseTime(row.timestamp) ?? parseTime(m.timestamp)
  const role = str(m.role)
  if (role === 'user') {
    const text = textParts(m.content, ['text'])
    return text.trim() ? [{ role: 'user', text, time }] : []
  }
  if (role === 'toolResult') return [{ role: 'tool-output', text: textParts(m.content, ['text']), time }]
  if (role !== 'assistant' || !Array.isArray(m.content)) return []
  const out: ParsedMsg[] = []
  for (const p of m.content.map(obj)) {
    if (p.type === 'text' && str(p.text).trim()) out.push({ role: 'assistant', text: str(p.text), time })
    else if (p.type === 'toolCall') out.push({ role: 'tool', text: brief(str(p.name) || 'tool', p.arguments ?? p.input), time })
  }
  return out
}

type Cached = { mtime: number; size: number; entry: Entry | null }

/**
 * Pi：~/.pi/agent/sessions/--<目录编码>--/<时间>_<uuid>.jsonl（计划 §2.4）。
 * 首行 {type:'session', id, cwd}；没有标题字段（P0 未找到），用首条用户消息顶替。
 */
export class PiAdapter implements Adapter {
  readonly agentId = 'pi' as const
  private cache = new Map<string, Cached>()

  constructor(readonly root: string) {}

  async list(): Promise<Entry[]> {
    const files = (await Promise.all((await subdirs(this.root)).map((d) => filesIn(d, /\.jsonl$/i)))).flat()
    return mapLimit(files, 16, (f) => this.one(f))
  }

  private async one(file: string): Promise<Entry | null> {
    const st = await stat(file)
    const hit = this.cache.get(file)
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.entry
    const rows = await headLines(file, HEAD, st.size)
    const s = rows[0] ?? {}
    let entry: Entry | null = null
    if (s.type === 'session' && RESUME_ID_RE.test(str(s.id)) && str(s.cwd)) {
      let summary = ''
      for (const r of rows) {
        summary = piMessages(r).find((m) => m.role === 'user')?.text ?? ''
        if (summary) break
      }
      entry = {
        agentId: 'pi',
        sessionId: str(s.id),
        cwd: normDir(str(s.cwd)),
        title: oneLine(summary, 120),
        summary: oneLine(summary),
        createdAt: parseTime(s.timestamp) ?? (st.birthtimeMs || st.mtimeMs),
        updatedAt: st.mtimeMs,
        size: st.size,
        file,
        extra: []
      }
    }
    this.cache.set(file, { mtime: st.mtimeMs, size: st.size, entry })
    return entry
  }

  async read(entry: Entry, onMsg: (m: ParsedMsg) => boolean): Promise<void> {
    await eachJsonLine(entry.file, (row) => {
      for (const m of piMessages(row)) if (!onMsg(m)) return false
      return true
    })
  }
}
