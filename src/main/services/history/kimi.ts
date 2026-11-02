import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { normDir } from '@shared/path'
import { RESUME_ID_RE } from '../../lib/resume'
import { brief, eachJsonLine, mapLimit, obj, oneLine, parseTime, str, subdirs, textParts, type Adapter, type Entry, type ParsedMsg } from './common'

/** key = state.json 与 wire.jsonl 的修改时间加大小 */
type Cached = { key: string; entry: Entry | null }

/**
 * Kimi Code：~/.kimi-code/sessions/wd_<目录>_<哈希>/session_<uuid>/（计划 §2.3，P0 修正）。
 * state.json 有标题、目录、时间；对话本体在 agents/main/wire.jsonl（不是 main/wire.jsonl），
 * agents/agent-N/ 是子 agent，不读。
 */
export class KimiAdapter implements Adapter {
  readonly agentId = 'kimi' as const
  private cache = new Map<string, Cached>()

  constructor(readonly root: string) {}

  async list(): Promise<Entry[]> {
    const dirs = (await Promise.all((await subdirs(this.root)).map((w) => subdirs(w)))).flat().filter((d) => basename(d).startsWith('session_'))
    return mapLimit(dirs, 16, (d) => this.one(d))
  }

  private async one(dir: string): Promise<Entry | null> {
    const stateFile = join(dir, 'state.json')
    const wire = join(dir, 'agents', 'main', 'wire.jsonl')
    const st = await stat(stateFile)
    const wst = await stat(wire).catch(() => null)
    const key = `${st.mtimeMs}:${wst?.mtimeMs ?? 0}:${wst?.size ?? 0}`
    const hit = this.cache.get(dir)
    if (hit && hit.key === key) return hit.entry
    const s = obj(JSON.parse(await readFile(stateFile, 'utf8')))
    const sessionId = basename(dir)
    const cwd = str(s.workDir)
    let entry: Entry | null = null
    if (RESUME_ID_RE.test(sessionId) && cwd) {
      const updated = Math.max(parseTime(s.updatedAt) ?? 0, wst?.mtimeMs ?? 0) || st.mtimeMs
      const summary = oneLine(s.lastPrompt)
      entry = {
        agentId: 'kimi',
        sessionId,
        cwd: normDir(cwd),
        title: oneLine(str(s.title) || summary, 120),
        summary,
        createdAt: parseTime(s.createdAt) ?? updated,
        updatedAt: updated,
        size: wst?.size ?? 0,
        file: wire,
        extra: [stateFile]
      }
    }
    this.cache.set(dir, { key, entry })
    return entry
  }

  async read(entry: Entry, onMsg: (m: ParsedMsg) => boolean): Promise<void> {
    // 同一步（stepUuid）的多段文字合成一条
    let pending: { step: string; msg: ParsedMsg } | null = null
    let stopped = false
    const flush = (): boolean => {
      if (!pending) return true
      const m = pending.msg
      pending = null
      return onMsg(m)
    }
    const emit = (m: ParsedMsg): boolean => flush() && onMsg(m)
    await eachJsonLine(entry.file, (row) => {
      const time = parseTime(row.time)
      if (row.type === 'turn.prompt') {
        const origin = str(obj(row.origin).kind)
        if (origin && origin !== 'user') return true
        const text = textParts(row.input, ['text'])
        if (!text.trim()) return true
        stopped = !emit({ role: 'user', text, time })
        return !stopped
      }
      if (row.type !== 'context.append_loop_event') return true
      const ev = obj(row.event)
      const t = str(ev.type)
      if (t === 'content.part') {
        const part = obj(ev.part)
        if (part.type !== 'text' || !str(part.text)) return true
        const step = str(ev.stepUuid)
        if (pending && pending.step === step) {
          pending.msg.text += str(part.text)
          return true
        }
        if (!flush()) return !(stopped = true)
        pending = { step, msg: { role: 'assistant', text: str(part.text), time } }
        return true
      }
      if (t === 'tool.call') {
        stopped = !emit({ role: 'tool', text: brief(str(ev.name), ev.args), time })
        return !stopped
      }
      if (t === 'tool.result') {
        const r = ev.result
        stopped = !emit({ role: 'tool-output', text: typeof r === 'string' ? r : str(obj(r).output) || JSON.stringify(r ?? ''), time })
        return !stopped
      }
      return true
    })
    if (!stopped) flush()
  }
}
