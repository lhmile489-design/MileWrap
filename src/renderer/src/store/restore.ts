import { create } from 'zustand'
import type { RestoreCandidate } from '@shared/types'
import { useConfig } from './config'
import { useLayout, visibleCount } from './layout'
import { useSessions } from './sessions'

/**
 * 一键恢复（PRD S-07 / S-08 / S-09，技术设计 §5.7）。
 * 候选由主进程在启动时确定；这里管勾选、逐条「续接 / 新开」与恢复动作。
 * 恢复逐条进行（主进程对同目录的 Kimi 还会再排队），恢复出来的会话尽量放回上次的格。
 */
type RestoreState = {
  candidates: RestoreCandidate[]
  /** 取消勾选的记录 */
  unchecked: Record<string, boolean>
  /** 逐条改成「新开」的记录（只对能续接的有意义） */
  fresh: Record<string, boolean>
  busy: boolean
  /** 没有空格放卡片时，从标题栏打开的恢复对话框 */
  dialogOpen: boolean
  setDialogOpen: (open: boolean) => void
  /** 本次启动里可「续接上次对话启动」的工作区（PRD S-10） */
  resumable: string[]
  load: () => Promise<void>
  refreshResumable: () => Promise<void>
  toggleChecked: (id: string) => void
  toggleFresh: (id: string) => void
  /** 恢复勾选的候选；onlyUnfinished = 自动恢复，只拉起上次没正常退出的 */
  restore: (opts?: { onlyUnfinished?: boolean }) => Promise<string[]>
  dismiss: () => Promise<void>
}

/** 这条候选按什么方式恢复：能续接且没被改成新开、且设置允许续接 */
export function wantsResume(c: RestoreCandidate, fresh: Record<string, boolean>): boolean {
  const allow = useConfig.getState().config?.settings.resumeConversation ?? true
  return allow && c.canResume && !fresh[c.id]
}

/** 恢复出的会话放哪一格：上次的格空着就放回去，否则放第一个空的可见格，都满了留在后台 */
function targetCell(preferred: number | null): number {
  const l = useLayout.getState()
  const n = visibleCount(l)
  if (preferred !== null && preferred < n && !l.cells[preferred]) return preferred
  for (let i = 0; i < n; i++) if (!l.cells[i]) return i
  return -1
}

export const useRestore = create<RestoreState>((set, get) => ({
  candidates: [],
  unchecked: {},
  fresh: {},
  busy: false,
  dialogOpen: false,
  setDialogOpen: (open) => set({ dialogOpen: open }),
  resumable: [],

  load: async () => {
    set({ candidates: await window.warp.session.restoreCandidates() })
  },
  refreshResumable: async () => {
    const ids = await window.warp.session.resumable().catch(() => [] as string[])
    const cur = get().resumable
    if (ids.length !== cur.length || ids.some((x, i) => x !== cur[i])) set({ resumable: ids })
  },
  toggleChecked: (id) => set({ unchecked: { ...get().unchecked, [id]: !get().unchecked[id] } }),
  toggleFresh: (id) => set({ fresh: { ...get().fresh, [id]: !get().fresh[id] } }),

  restore: async (opts = {}) => {
    const { candidates, unchecked, fresh } = get()
    const picked = candidates.filter((c) => !unchecked[c.id] && (!opts.onlyUnfinished || c.lastExitCode === null))
    if (picked.length === 0) return []
    set({ busy: true })
    const failures: string[] = []
    for (const c of picked) {
      const r = await window.warp.session.restore(c.id, wantsResume(c, fresh)).catch((e: unknown) => ({
        ok: false as const,
        reason: e instanceof Error ? e.message : String(e)
      }))
      // 不管成功与否，这条都不再是候选
      set({ candidates: get().candidates.filter((x) => x.id !== c.id) })
      if (!r.ok) {
        failures.push(`${c.workspaceName}：${r.reason}`)
        continue
      }
      useSessions.getState().adopt(r.session)
      const cell = targetCell(c.cell)
      if (cell >= 0) useLayout.getState().place(r.session.id, cell)
    }
    set({ busy: false })
    void get().refreshResumable()
    return failures
  },

  dismiss: async () => {
    const ids = get().candidates.map((c) => c.id)
    set({ candidates: [] })
    await window.warp.session.dismissCandidates(ids)
  }
}))
