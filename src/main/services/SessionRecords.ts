import { statSync } from 'node:fs'
import type { RestoreCandidate, SessionRecord, StoredWorkspace } from '@shared/types'
import { isValidResumeId, supportsContinue, supportsResume } from '../lib/resume'
import { samePath } from './ResumeDiscovery'
import type { ConfigStore } from './ConfigStore'

const MAX_RECORDS = 50

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 会话快照（技术设计 §4 sessionRecords、§5.7）：存在 config.json，最多 50 条。
 * - 记录随会话生命周期即时写盘（启动、拿到续接 ID、改名、退出、关闭），应用崩溃也不丢
 * - open = 用户没手动关；应用退出时保持 true，下次启动这些就是「恢复候选」
 * - 候选在本次启动时一次性确定：本次运行里新开的会话不会出现在恢复卡片上
 */
export class SessionRecords {
  private candidates: Set<string>

  constructor(private config: ConfigStore) {
    this.candidates = new Set(config.get().sessionRecords.filter((r) => r.open).map((r) => r.id))
  }

  get(id: string): SessionRecord | undefined {
    return this.config.get().sessionRecords.find((r) => r.id === id)
  }

  /** 新增或整条替换；replaceId 用于恢复：旧记录由新会话的记录接替 */
  upsert(rec: SessionRecord, replaceId?: string): void {
    this.config.update((c) => {
      const list = c.sessionRecords.filter((r) => r.id !== rec.id && r.id !== replaceId)
      list.push(rec)
      // 超出上限：先丢已关闭的最旧记录，再丢最旧的
      while (list.length > MAX_RECORDS) {
        const closed = list.findIndex((r) => !r.open)
        list.splice(closed >= 0 ? closed : 0, 1)
      }
      c.sessionRecords = list
    })
    if (replaceId) this.candidates.delete(replaceId)
  }

  /** 改一条记录；没有变化不写盘 */
  patch(id: string, fn: (r: SessionRecord) => void): void {
    const cur = this.get(id)
    if (!cur) return
    const next = structuredClone(cur)
    fn(next)
    if (JSON.stringify(next) === JSON.stringify(cur)) return
    this.config.update((c) => {
      const i = c.sessionRecords.findIndex((r) => r.id === id)
      if (i >= 0) c.sessionRecords[i] = next
    })
  }

  /** 一次写盘改多条（快照格位用） */
  patchMany(changes: Map<string, (r: SessionRecord) => void>): void {
    if (changes.size === 0) return
    const before = JSON.stringify(this.config.get().sessionRecords)
    const list = structuredClone(this.config.get().sessionRecords)
    for (const r of list) changes.get(r.id)?.(r)
    if (JSON.stringify(list) === before) return
    this.config.update((c) => {
      c.sessionRecords = list
    })
  }

  /**
   * 恢复候选（§5.7）：过滤掉工作区已删、目录不存在的记录；按格号、启动时间排序。
   * canResume 规则（§5.8）：有合法 ID → 精确续接；没 ID 时只有同 (agent, 目录) 仅此一条才用 --continue，
   * 否则标「新开」，不让两个会话挤到同一段对话上。
   */
  candidatesList(): RestoreCandidate[] {
    const c = this.config.get()
    const recs = c.sessionRecords.filter((r) => r.open && this.candidates.has(r.id))
    const out: RestoreCandidate[] = []
    for (const r of recs) {
      const ws = c.workspaces.find((w) => w.id === r.workspaceId)
      if (!ws || !isDir(ws.cwd)) continue
      const verdict = this.judge(r, ws, recs)
      out.push({ ...r, workspaceName: ws.name, canResume: verdict.ok, resumeNote: verdict.note })
    }
    return out.sort((a, b) => (a.cell ?? 9) - (b.cell ?? 9) || a.lastStartedAt - b.lastStartedAt)
  }

  private judge(r: SessionRecord, ws: StoredWorkspace, all: SessionRecord[]): { ok: boolean; note: string | null } {
    if (r.kind === 'shell') return { ok: false, note: 'Shell 会话不续接，重新打开' }
    const custom = this.config.get().customAgents.find((a) => a.id === r.agentId)
    if (!supportsResume(r.agentId, custom)) return { ok: false, note: '这个 agent 不支持续接' }
    if (r.agentId !== ws.agentId) return { ok: false, note: '工作区已换了 agent' }
    if (!samePath(r.cwd, ws.cwd)) return { ok: false, note: '工作区目录已改' }
    if (isValidResumeId(r.resumeId)) return { ok: true, note: null }
    if (!supportsContinue(r.agentId, custom)) return { ok: false, note: '未能获取会话 ID' }
    const peers = all.filter((x) => x.kind === 'agent' && x.agentId === r.agentId && samePath(x.cwd, r.cwd))
    if (peers.length === 1) return { ok: true, note: '没拿到会话 ID，将续接该目录最近一次对话' }
    return { ok: false, note: '未能获取会话 ID' }
  }

  /**
   * 退出时调用：本次运行开过会话，说明用户已经在用新的一批了，
   * 上一轮留下、这次既没恢复也没忽略的可见候选就归档，不再带到下下次启动（否则每次退出都会多攒一批，
   * 一键恢复时一次拉起所有旧批次）。本次什么都没开就退出，旧候选原样保留。
   * 目录缺失、工作区已删的记录不在可见候选里，不动。
   */
  archiveStale(ranSessions: boolean): void {
    if (!ranSessions) return
    this.dismiss(this.candidatesList().map((c) => c.id))
  }

  isCandidate(id: string): boolean {
    return this.candidates.has(id)
  }

  /** 「忽略」：这些记录不再作为候选（open 置 false） */
  dismiss(ids?: string[]): void {
    const targets = ids ? ids.filter((id) => this.candidates.has(id)) : [...this.candidates]
    const changes = new Map<string, (r: SessionRecord) => void>()
    for (const id of targets) {
      changes.set(id, (r) => {
        r.open = false
      })
      this.candidates.delete(id)
    }
    this.patchMany(changes)
  }

  /** S-10：该工作区最近一条可精确续接的记录；对应对话正在本次运行的会话里打开着就不算 */
  latestResumable(ws: StoredWorkspace, liveResumeIds: Set<string>): SessionRecord | null {
    const list = this.config
      .get()
      .sessionRecords.filter(
        (r) =>
          r.workspaceId === ws.id &&
          r.kind === 'agent' &&
          r.agentId === ws.agentId &&
          samePath(r.cwd, ws.cwd) &&
          isValidResumeId(r.resumeId) &&
          !liveResumeIds.has(r.resumeId)
      )
      .sort((a, b) => b.lastStartedAt - a.lastStartedAt)
    return list[0] ?? null
  }

  resumableWorkspaces(liveResumeIds: Set<string>): string[] {
    return this.config
      .get()
      .workspaces.filter((ws) => this.latestResumable(ws, liveResumeIds))
      .map((ws) => ws.id)
  }
}
