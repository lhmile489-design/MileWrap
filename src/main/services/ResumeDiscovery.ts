import { openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isValidResumeId } from '../lib/resume'

const CODEX_POLL_MS = 3000
const KIMI_POLL_MS = 300
const KIMI_TIMEOUT_MS = 5000
const HEAD_BYTES = 256 * 1024

/** 路径比较：斜杠统一、去尾斜杠、不区分大小写（Windows） */
export function samePath(a: string, b: string): boolean {
  const n = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return n(a) === n(b)
}

type CodexPending = { cwd: string; startedAt: number }

/**
 * 事后发现 agent 自己的会话 ID（技术设计 §5.8，M0 实测结论）：
 * - Codex：首条消息后才在 ~/.codex/sessions/YYYY/MM/DD/ 下建 rollout-*.jsonl，首行 session_meta 带 id 与 cwd。
 *   会话期间持续轮询；同一目录同时有多个待认领的 Codex 会话时有歧义，宁可不写 ID（§5.8 规则 3）。
 * - Kimi：启动即往 ~/.kimi-code/session_index.jsonl 追加一行 { sessionId, workDir }。启动前记行数，之后 5 秒内比对新增行。
 * 只读这些文件，不改不删。
 */
export class ResumeDiscovery {
  private codex = new Map<string, CodexPending>()
  private claimed = new Set<string>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private onFound: (sessionId: string, resumeId: string) => void,
    private home: string = homedir()
  ) {}

  // ---------- Codex ----------

  watchCodex(sessionId: string, cwd: string, startedAt: number): void {
    this.codex.set(sessionId, { cwd, startedAt })
    if (!this.timer) this.timer = setInterval(() => this.scanCodex(), CODEX_POLL_MS)
  }

  unwatch(sessionId: string): void {
    this.codex.delete(sessionId)
    if (this.codex.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  dispose(): void {
    this.codex.clear()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private scanCodex(): void {
    if (this.codex.size === 0) return
    const earliest = Math.min(...[...this.codex.values()].map((p) => p.startedAt))
    for (const file of this.rolloutFiles(earliest)) {
      if (this.claimed.has(file)) continue
      let born = 0
      try {
        const st = statSync(file)
        born = st.birthtimeMs || st.mtimeMs
      } catch {
        continue
      }
      // 只认会话启动之后新建的文件（留 1 秒时钟误差）
      const pending = [...this.codex.entries()].filter(([, p]) => born >= p.startedAt - 1000)
      if (pending.length === 0) continue
      const meta = readCodexMeta(file)
      if (!meta) continue
      const same = pending.filter(([, p]) => samePath(p.cwd, meta.cwd))
      if (same.length === 0) continue
      this.claimed.add(file)
      if (same.length > 1) continue // 歧义：同目录多个待认领会话，谁都不给
      const [sessionId] = same[0]
      this.unwatch(sessionId)
      this.onFound(sessionId, meta.id)
    }
  }

  /** 今天与昨天两个日期目录（会话跨午夜时首条消息可能落在第二天） */
  private rolloutFiles(since: number): string[] {
    const days = new Set<string>()
    for (const t of [since, Date.now(), Date.now() - 86_400_000]) {
      const d = new Date(t)
      days.add(join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')))
    }
    const out: string[] = []
    for (const day of days) {
      const dir = join(this.home, '.codex', 'sessions', day)
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const n of names) if (/^rollout-.*\.jsonl$/.test(n)) out.push(join(dir, n))
    }
    return out
  }

  // ---------- Kimi ----------

  private kimiIndex(): string {
    return join(this.home, '.kimi-code', 'session_index.jsonl')
  }

  /** 启动前调用：记下 index 现有行数 */
  kimiBaseline(): number {
    return readLines(this.kimiIndex()).length
  }

  /** 启动后调用：5 秒内找新增的、workDir 等于工作区目录的那一行 */
  async waitKimi(baseline: number, cwd: string): Promise<string | null> {
    const deadline = Date.now() + KIMI_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, KIMI_POLL_MS))
      const lines = readLines(this.kimiIndex()).slice(baseline)
      for (const line of lines) {
        try {
          const row = JSON.parse(line) as { sessionId?: unknown; workDir?: unknown }
          if (typeof row.workDir !== 'string' || !samePath(row.workDir, cwd)) continue
          if (!isValidResumeId(row.sessionId) || this.claimed.has(`kimi:${row.sessionId}`)) continue
          this.claimed.add(`kimi:${row.sessionId}`)
          return row.sessionId
        } catch {
          // 半行（正在写入）跳过，下一轮再读
        }
      }
    }
    return null
  }
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim())
  } catch {
    return []
  }
}

/** 读 rollout 首行的 session_meta：{ id, cwd }。首行很长时退回正则提取 */
export function readCodexMeta(file: string): { id: string; cwd: string } | null {
  let head = ''
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(HEAD_BYTES)
      const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
      head = buf.subarray(0, n).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  const nl = head.indexOf('\n')
  if (nl > 0) {
    try {
      const row = JSON.parse(head.slice(0, nl)) as { type?: unknown; payload?: { id?: unknown; cwd?: unknown } }
      if (row.type === 'session_meta' && isValidResumeId(row.payload?.id) && typeof row.payload?.cwd === 'string') {
        return { id: row.payload.id, cwd: row.payload.cwd }
      }
      return null
    } catch {
      // 落到下面的正则
    }
  }
  if (!head.includes('"session_meta"')) return null
  const id = /"payload":\{[^{}]*?"id":"([A-Za-z0-9_-]{8,64})"/.exec(head)?.[1]
  const cwdRaw = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]
  if (!id || cwdRaw === undefined) return null
  try {
    return { id, cwd: JSON.parse(`"${cwdRaw}"`) as string }
  } catch {
    return null
  }
}
