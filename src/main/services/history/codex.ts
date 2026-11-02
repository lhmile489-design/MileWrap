import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { normDir } from '@shared/path'
import { RESUME_ID_RE } from '../../lib/resume'
import { brief, eachJsonLine, exists, inside, isInjected, mapLimit, obj, oneLine, parseTime, str, textParts, type Adapter, type Entry, type ParsedMsg } from './common'

type Row = Record<string, unknown>

const WANT = ['id', 'rollout_path', 'cwd', 'title', 'name', 'first_user_message', 'created_at', 'created_at_ms', 'updated_at', 'updated_at_ms', 'archived', 'source']

/** Codex 把路径存成 \\?\E:\...；文件操作用去掉前缀的 Windows 路径 */
function plainPath(p: string): string {
  if (/^\\\\\?\\UNC\\/i.test(p)) return '\\\\' + p.slice(8)
  return p.replace(/^\\\\\?\\/, '')
}

function ms(row: Row, key: string): number | null {
  return parseTime(row[`${key}_ms`]) ?? parseTime(row[key])
}

/**
 * Codex CLI：索引在 ~/.codex/state_N.sqlite 的 threads 表，对话本体是 rollout_path 指向的 jsonl（计划 §2.2）。
 * 只读打开数据库（node:sqlite，Electron 自带的 Node 24 内置，不加依赖）。
 * 不列出：已归档的线程、子 agent 线程（source 是 {"subagent":…}，不能单独续接）。
 */
export class CodexAdapter implements Adapter {
  readonly agentId = 'codex' as const

  constructor(readonly root: string) {}

  /** 版本号最大的 state_N.sqlite（Codex 升级会换文件名） */
  private async database(): Promise<string | null> {
    let best: { n: number; f: string } | null = null
    for (const name of await readdir(this.root)) {
      const m = /^state_(\d+)\.sqlite$/.exec(name)
      if (m && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), f: join(this.root, name) }
    }
    return best?.f ?? null
  }

  async list(): Promise<Entry[]> {
    if (!(await exists(this.root))) return []
    const dbFile = await this.database()
    if (!dbFile) return []
    const sqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite') | undefined
    if (!sqlite) throw new Error('当前运行时不支持读取 SQLite')
    let rows: Row[]
    const db = new sqlite.DatabaseSync(dbFile, { readOnly: true, timeout: 2000 })
    try {
      const cols = new Set(db.prepare('PRAGMA table_info(threads)').all().map((c) => String(c.name)))
      if (!cols.has('id') || !cols.has('rollout_path') || !cols.has('cwd')) throw new Error('Codex 索引的表结构不认识，可能是 Codex 升级了')
      rows = db.prepare(`SELECT ${WANT.filter((c) => cols.has(c)).join(', ')} FROM threads`).all() as Row[]
    } finally {
      db.close()
    }
    const picked = rows.filter((r) => Number(r.archived ?? 0) !== 1 && !str(r.source).startsWith('{') && RESUME_ID_RE.test(str(r.id)))
    return mapLimit(picked, 32, async (r) => {
      const file = plainPath(str(r.rollout_path))
      if (!file || !inside(this.root, file)) return null
      // 索引里有记录、文件可能还没写出来或被删了：照样列出，大小记 0（计划 §3.4）
      const size = await stat(file).then((s) => s.size, () => 0)
      const first = str(r.first_user_message)
      const title = str(r.name).trim() || str(r.title).trim() || first
      const updated = ms(r, 'updated_at') ?? 0
      return {
        agentId: 'codex',
        sessionId: str(r.id),
        cwd: normDir(str(r.cwd)),
        title: oneLine(title, 120),
        summary: oneLine(first || title),
        createdAt: ms(r, 'created_at') ?? updated,
        updatedAt: updated,
        size,
        file,
        extra: []
      } satisfies Entry
    })
  }

  async read(entry: Entry, onMsg: (m: ParsedMsg) => boolean): Promise<void> {
    await eachJsonLine(entry.file, (row) => {
      if (row.type !== 'response_item') return true
      const p = obj(row.payload)
      const time = parseTime(row.timestamp)
      const t = str(p.type)
      if (t === 'message') {
        const role = str(p.role)
        const text = textParts(p.content)
        if (role === 'user' && !isInjected(text)) return onMsg({ role: 'user', text, time })
        if (role === 'assistant' && text.trim()) return onMsg({ role: 'assistant', text, time })
        return true
      }
      if (t === 'function_call' || t === 'custom_tool_call' || t === 'local_shell_call') {
        return onMsg({ role: 'tool', text: brief(str(p.name) || 'shell', p.arguments ?? p.input ?? p.action), time })
      }
      if (t.endsWith('_call_output')) {
        const out = p.output
        return onMsg({ role: 'tool-output', text: typeof out === 'string' ? out : str(obj(out).output) || JSON.stringify(out ?? ''), time })
      }
      return true
    })
  }
}
