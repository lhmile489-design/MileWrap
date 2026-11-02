import { createHash } from 'node:crypto'
import { copyFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import type { HistoryAgent, HistoryDetail, HistoryExportFormat, HistoryItem, HistoryListResult, HistoryMessage } from '@shared/types'
import { winPath } from '@shared/path'
import { log } from '../lib/log'
import { clip, ensureInside, type Adapter, type Entry, type ParsedMsg } from './history/common'
import { ClaudeAdapter } from './history/claude'
import { CodexAdapter } from './history/codex'
import { KimiAdapter } from './history/kimi'
import { PiAdapter } from './history/pi'

/** 预览每页的条数与单条上限（工具输出不进预览） */
const PAGE = 100
const PREVIEW_CHARS = 8000
/** 导出里单条工具输出的上限 */
const EXPORT_TOOL_CHARS = 20_000

export const HISTORY_ID_RE = /^h[0-9a-f]{20}$/

const AGENT_NAMES: Record<HistoryAgent, string> = { claude: 'Claude Code', codex: 'Codex CLI', kimi: 'Kimi Code', pi: 'Pi' }
const ROLE_NAMES: Record<ParsedMsg['role'], string> = { user: '用户', assistant: 'Assistant', tool: '工具调用', 'tool-output': '工具输出' }

function stamp(t: number | null): string {
  if (!t) return ''
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 比正文里最长的连续反引号再多一个，代码块不会被正文提前截断 */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  return '`'.repeat(longest + 1)
}

/**
 * 本机 agent 的历史会话（会话管理升级计划 P1 / P2：列表、预览、导出、续接）。
 * - 渲染层只拿 historyId：每次 list 重建「ID → 记录」映射，路径不出主进程（§3.2）。
 * - 读写前 realpath 校验文件仍在该 agent 的会话目录下。
 * - 只读：不改、不删 agent 自己的文件（写操作是 P3 / P4，需要另行拍板）。
 */
export class SessionHistoryService {
  private adapters: Adapter[]
  private byId = new Map<string, Entry>()

  constructor(
    /** agent 会话目录所在的主目录；harness 用 MILE_WARP_AGENT_HOME 指到沙箱 */
    home: string = homedir(),
    /** Warp 里运行中会话占用的续接 ID */
    private liveIds: () => Set<string> = () => new Set()
  ) {
    this.adapters = [
      new ClaudeAdapter(join(home, '.claude', 'projects')),
      new CodexAdapter(join(home, '.codex')),
      new KimiAdapter(join(home, '.kimi-code', 'sessions')),
      new PiAdapter(join(home, '.pi', 'agent', 'sessions'))
    ]
  }

  async list(): Promise<HistoryListResult> {
    const t0 = Date.now()
    const results = await Promise.all(
      this.adapters.map((a) =>
        a.list().then(
          (entries) => ({ a, entries, error: null as string | null }),
          (e: unknown) => ({ a, entries: [] as Entry[], error: e instanceof Error ? e.message : String(e) })
        )
      )
    )
    const live = this.liveIds()
    const map = new Map<string, Entry>()
    const items: HistoryItem[] = []
    const failed: HistoryListResult['failed'] = []
    const counts: Record<string, number> = {}
    for (const r of results) {
      counts[r.a.agentId] = r.entries.length
      if (r.error) failed.push({ agentId: r.a.agentId, reason: r.error })
      for (const e of r.entries) {
        const historyId = `h${createHash('sha1').update(`${e.agentId}\0${e.file}`).digest('hex').slice(0, 20)}`
        if (map.has(historyId)) continue
        map.set(historyId, e)
        items.push({
          historyId,
          agentId: e.agentId,
          sessionId: e.sessionId,
          cwd: e.cwd,
          title: e.title || e.summary || '（没有内容）',
          summary: e.summary,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt,
          size: e.size,
          running: live.has(e.sessionId)
        })
      }
    }
    this.byId = map
    items.sort((a, b) => b.updatedAt - a.updatedAt)
    // 日志只记条数与耗时，不记标题和目录（PRD §7）
    log('history.list', { ...counts, failed: failed.map((f) => f.agentId), ms: Date.now() - t0 })
    return { items, failed }
  }

  /** 按 historyId 取记录；ID 不在最近一次列表里一律拒绝 */
  entry(historyId: string): Entry {
    const e = HISTORY_ID_RE.test(historyId) ? this.byId.get(historyId) : undefined
    if (!e) throw new Error('这条记录已失效，请刷新列表')
    return e
  }

  isRunning(e: Entry): boolean {
    return this.liveIds().has(e.sessionId)
  }

  private adapter(e: Entry): Adapter {
    const a = this.adapters.find((x) => x.agentId === e.agentId)
    if (!a) throw new Error('不支持的 agent')
    return a
  }

  /** 校验过的对话文件路径（文件不存在、越界都会抛错） */
  async filePath(historyId: string): Promise<string> {
    const e = this.entry(historyId)
    return ensureInside(this.adapter(e).root, e.file).catch((err: unknown) => {
      throw new Error((err as NodeJS.ErrnoException)?.code === 'ENOENT' ? '会话文件不存在（可能还没写出来，或已被删除）' : err instanceof Error ? err.message : String(err))
    })
  }

  /**
   * 预览：从第 offset 条起取一页。工具输出不进预览；工具调用只在 tools 为 true 时计入
   * （实测一页里九成是工具调用，默认折叠时不该占掉一页的名额）
   */
  async detail(historyId: string, offset: number, tools: boolean): Promise<HistoryDetail> {
    const e = this.entry(historyId)
    const file = await this.filePath(historyId)
    const messages: HistoryMessage[] = []
    let index = 0
    let truncated = false
    await this.adapter(e).read({ ...e, file }, (m) => {
      if (m.role === 'tool-output' || (m.role === 'tool' && !tools)) return true
      if (index++ < offset) return true
      if (messages.length >= PAGE) {
        truncated = true
        return false
      }
      messages.push({ role: m.role, text: clip(m.text, PREVIEW_CHARS), time: m.time })
      return true
    })
    return { messages, truncated }
  }

  /** 导出对话框里的默认文件名 */
  defaultExportName(historyId: string, format: HistoryExportFormat): string {
    const e = this.entry(historyId)
    const title = (e.title || e.sessionId).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60)
    const ext = format === 'markdown' ? '.md' : format === 'json' ? '.json' : extname(e.file) || '.jsonl'
    return `${e.agentId}-${title}${ext}`
  }

  /**
   * 导出到 dest（路径由主进程的保存对话框给出，渲染层给不了）。
   * raw：原样复制对话文件；Kimi 另把 state.json 复制成「<文件名>.state.json」放在旁边。
   */
  async exportTo(historyId: string, format: HistoryExportFormat, includeTools: boolean, dest: string): Promise<void> {
    const e = this.entry(historyId)
    const file = await this.filePath(historyId)
    if (format === 'raw') {
      await copyFile(file, dest)
      const a = this.adapter(e)
      for (const x of e.extra) {
        const src = await ensureInside(a.root, x)
        await copyFile(src, join(dirname(dest), `${basename(dest, extname(dest))}.${basename(x)}`))
      }
      log('history.export', { agent: e.agentId, format })
      return
    }
    const msgs: ParsedMsg[] = []
    await this.adapter(e).read({ ...e, file }, (m) => {
      if (m.role === 'tool-output' && !includeTools) return true
      msgs.push(m.role === 'tool-output' ? { ...m, text: clip(m.text, EXPORT_TOOL_CHARS) } : m)
      return true
    })
    const text = format === 'json' ? this.toJson(e, msgs) : this.toMarkdown(e, msgs, includeTools)
    await writeFile(dest, text, { encoding: 'utf8' })
    log('history.export', { agent: e.agentId, format, messages: msgs.length })
  }

  private toJson(e: Entry, msgs: ParsedMsg[]): string {
    return JSON.stringify(
      {
        version: 1,
        agent: e.agentId,
        sessionId: e.sessionId,
        cwd: winPath(e.cwd),
        title: e.title,
        createdAt: new Date(e.createdAt).toISOString(),
        updatedAt: new Date(e.updatedAt).toISOString(),
        exportedAt: new Date().toISOString(),
        messages: msgs.map((m) => ({ role: m.role, text: m.text, time: m.time ? new Date(m.time).toISOString() : null }))
      },
      null,
      2
    )
  }

  private toMarkdown(e: Entry, msgs: ParsedMsg[], includeTools: boolean): string {
    const out: string[] = [
      `# ${e.title || e.sessionId}`,
      '',
      `- Agent：${AGENT_NAMES[e.agentId]}`,
      `- 会话 ID：\`${e.sessionId}\``,
      `- 目录：\`${winPath(e.cwd)}\``,
      `- 创建：${stamp(e.createdAt)}`,
      `- 更新：${stamp(e.updatedAt)}`,
      `- 导出：${stamp(Date.now())}${includeTools ? '（含工具输出）' : ''}`,
      ''
    ]
    for (const m of msgs) {
      if (m.role === 'tool') {
        out.push(`> 工具调用：${m.text.replace(/\n/g, ' ')}`, '')
        continue
      }
      if (m.role === 'tool-output') {
        const f = fence(m.text)
        out.push('<details><summary>工具输出</summary>', '', f, m.text, f, '', '</details>', '')
        continue
      }
      out.push('---', '', `## ${ROLE_NAMES[m.role]}${m.time ? ` · ${stamp(m.time)}` : ''}`, '', m.text.trim(), '')
    }
    return out.join('\n')
  }
}
