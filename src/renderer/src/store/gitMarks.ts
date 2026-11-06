import { create } from 'zustand'
import type { GitFile, GitFileStatus } from '@shared/types'

/**
 * 目录栏改动标记（Git管理-PRD G-18）：复用 Git 栏同一次 git status 的结果，不另跑命令。
 * 放在首屏（体积很小）；Git 栏（lazy chunk）每次刷新后写进来，目录栏只读。
 * 键是工作区内相对路径（/ 分隔），和目录栏 data-rel 一致；仓库根下、工作区目录外的文件不出现。
 */
export type GitMark = 'M' | 'A' | 'D' | 'R' | 'U' | '!'

const LETTER: Record<GitFileStatus, GitMark> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflict: '!'
}

/** 同一文件既暂存又有未暂存改动时取更显眼的那个 */
const RANK: Record<GitMark, number> = { '!': 5, D: 4, U: 3, A: 2, R: 2, M: 1 }

export const MARK_LABEL: Record<GitMark, string> = { M: '修改', A: '新增', D: '删除', R: '重命名', U: '未跟踪', '!': '冲突' }

type GitMarksState = {
  /** workspaceId → 工作区内相对路径 → 标记 */
  marks: Record<string, Record<string, GitMark>>
  set: (workspaceId: string, relativeDir: string, files: GitFile[]) => void
  clear: (workspaceId: string) => void
  /**
   * Git 栏没开时目录栏自己取一次（切工作区、点目录栏刷新）：同一工作区 2 秒内只取一次。
   * 只在设置打开 Git 管理时由目录栏调用；主进程在开关关着时本来也会拒绝
   */
  load: (workspaceId: string, force?: boolean) => Promise<void>
}

const LOAD_THROTTLE_MS = 2000
const lastLoad: Record<string, number> = {}

/** 仓库根相对路径 → 工作区相对路径；不在工作区目录内返回 null */
export function toWorkspaceRel(relativeDir: string, repoPath: string): string | null {
  if (!relativeDir) return repoPath
  const prefix = `${relativeDir}/`
  return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : null
}

export const useGitMarks = create<GitMarksState>((set, get) => ({
  marks: {},
  set: (workspaceId, relativeDir, files) => {
    const next: Record<string, GitMark> = {}
    for (const f of files) {
      // 未跟踪目录 porcelain 里带结尾 /，目录栏的 rel 没有
      const rel = toWorkspaceRel(relativeDir, f.path.replace(/\/$/, ''))
      if (!rel) continue
      const m = LETTER[f.status]
      const cur = next[rel]
      if (!cur || RANK[m] > RANK[cur]) next[rel] = m
    }
    const prev = get().marks[workspaceId]
    if (prev && sameMarks(prev, next)) return
    set({ marks: { ...get().marks, [workspaceId]: next } })
  },
  clear: (workspaceId) => {
    if (!get().marks[workspaceId]) return
    const next = { ...get().marks }
    delete next[workspaceId]
    set({ marks: next })
  },
  load: async (workspaceId, force = false) => {
    const now = Date.now()
    // 目录栏「刷新」是手动操作，不受节流（审查 2026-11-06）
    if (!force && now - (lastLoad[workspaceId] ?? 0) < LOAD_THROTTLE_MS) return
    lastLoad[workspaceId] = now
    try {
      const probe = await window.warp.git.probe(workspaceId)
      if (!probe.available) return get().clear(workspaceId)
      // 没确认信任的仓库不跑 status（会执行 clean 过滤器），目录栏不标
      if (await window.warp.git.risk(workspaceId)) return get().clear(workspaceId)
      const status = await window.warp.git.status(workspaceId)
      get().set(workspaceId, probe.relativeDir, status.files)
    } catch {
      get().clear(workspaceId)
    }
  }
}))

function sameMarks(a: Record<string, GitMark>, b: Record<string, GitMark>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => a[k] === b[k])
}
