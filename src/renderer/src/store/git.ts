import { create } from 'zustand'
import type { GitDiff, GitProbe, GitStatus } from '@shared/types'
import { errorText } from '../lib/errors'
import { confirm, notifyError } from '../components/ConfirmDialog'

/** 静默刷新的节流（Git管理-PRD G-16）：焦点回来、会话转空闲这类触发 2 秒内只跑一次 */
const THROTTLE_MS = 2000

export type GitView = { kind: 'list' } | { kind: 'diff'; path: string; staged: boolean }

type RefreshOpts = { silent?: boolean; force?: boolean }

type GitState = {
  /** Git 栏当前看的工作区；跟随会话栏选中，聚焦格为空时保留上一个（G-03） */
  workspaceId: string | null
  probe: GitProbe | null
  status: GitStatus | null
  loading: boolean
  error: string | null
  /** 有暂存 / 丢弃 / 提交在跑：按钮禁用，避免连点 */
  busy: boolean
  view: GitView
  diff: GitDiff | null
  diffError: string | null

  setWorkspace: (id: string | null) => void
  refresh: (opts?: RefreshOpts) => Promise<void>
  openDiff: (path: string, staged: boolean) => void
  backToList: () => void
  /** follow：在 diff 视图里点暂存 / 取消暂存时，视图跟到另一组的同一文件 */
  stage: (paths: string[], follow?: boolean) => Promise<void>
  unstage: (paths: string[], follow?: boolean) => Promise<void>
  discard: (paths: string[]) => Promise<void>
  /** 成功返回短哈希；失败抛出（钩子输出原样带回，由提交框显示） */
  commit: (summary: string, description: string) => Promise<string>
}

/**
 * Git 栏状态（Git管理-PRD §3.2）。渲染层只拿 workspaceId 调 IPC，仓库路径不出主进程。
 * reqId / diffReq 挡竞态：切工作区或连续刷新时，晚到的结果直接丢。
 */
export const useGit = create<GitState>((set, get) => {
  let reqId = 0
  let diffReq = 0
  let last = 0

  const loadDiff = (path: string, staged: boolean, keep: boolean): void => {
    const id = get().workspaceId
    if (!id) return
    const r = ++diffReq
    if (!keep) set({ diff: null, diffError: null })
    window.warp.git.diff(id, path, staged).then(
      (d) => {
        if (r === diffReq) set({ diff: d, diffError: null })
      },
      (e: unknown) => {
        if (r === diffReq) set({ diffError: errorText(e) })
      }
    )
  }

  const op = async (fn: (id: string) => Promise<unknown>, follow?: GitView): Promise<void> => {
    const id = get().workspaceId
    if (!id || get().busy) return
    set({ busy: true })
    try {
      await fn(id)
      if (follow) set({ view: follow })
    } catch (e) {
      notifyError(e)
    } finally {
      set({ busy: false })
      await get().refresh({ force: true, silent: true })
    }
  }

  const flip = (paths: string[], follow: boolean | undefined, staged: boolean): GitView | undefined => {
    const v = get().view
    return follow && v.kind === 'diff' && paths.length === 1 && paths[0] === v.path ? { kind: 'diff', path: v.path, staged } : undefined
  }

  return {
    workspaceId: null,
    probe: null,
    status: null,
    loading: false,
    error: null,
    busy: false,
    view: { kind: 'list' },
    diff: null,
    diffError: null,

    setWorkspace: (id) => {
      if (get().workspaceId === id) return
      reqId++
      diffReq++
      set({ workspaceId: id, probe: null, status: null, error: null, loading: false, view: { kind: 'list' }, diff: null, diffError: null })
      if (id) void get().refresh({ force: true })
    },

    refresh: async ({ silent = false, force = false } = {}) => {
      const id = get().workspaceId
      if (!id) return
      const now = Date.now()
      if (!force && now - last < THROTTLE_MS) return
      last = now
      const r = ++reqId
      if (!silent) set({ loading: true })
      try {
        const probe = await window.warp.git.probe(id)
        if (r !== reqId) return
        if (!probe.available) {
          set({ probe, status: null, error: null, loading: false })
          return
        }
        const status = await window.warp.git.status(id)
        if (r !== reqId) return
        set({ probe, status, error: null, loading: false })
        const v = get().view
        if (v.kind === 'diff') {
          if (status.files.some((f) => f.path === v.path && f.staged === v.staged)) loadDiff(v.path, v.staged, true)
          else {
            diffReq++
            set({ view: { kind: 'list' }, diff: null, diffError: null })
          }
        }
      } catch (e) {
        if (r !== reqId) return
        set({ error: errorText(e), loading: false })
      }
    },

    openDiff: (path, staged) => {
      set({ view: { kind: 'diff', path, staged } })
      loadDiff(path, staged, false)
    },

    backToList: () => {
      diffReq++
      set({ view: { kind: 'list' }, diff: null, diffError: null })
    },

    stage: (paths, follow) => op((id) => window.warp.git.stage(id, paths), flip(paths, follow, true)),
    unstage: (paths, follow) => op((id) => window.warp.git.unstage(id, paths), flip(paths, follow, false)),

    discard: (paths) =>
      op(async (id) => {
        // 两步走（PRD §6.2 第 7 条）：主进程先列出要丢的文件并发 token，确认后只凭 token 执行
        const plan = await window.warp.git.discardPrepare(id, paths)
        const untracked = plan.files.filter((f) => f.untracked).length
        const shown = plan.files.slice(0, 10).map((f) => `${f.untracked ? '删除' : '还原'}  ${f.path}`)
        if (plan.files.length > shown.length) shown.push(`…以及另外 ${plan.files.length - shown.length} 个文件`)
        const ok = await confirm({
          title: `丢弃 ${plan.files.length} 个文件的改动？`,
          body: `${shown.join('\n')}\n\n${untracked ? `其中 ${untracked} 个未跟踪的文件会被删除。` : ''}丢弃后无法恢复。`,
          okLabel: untracked ? '删除并丢弃' : '丢弃',
          danger: true
        })
        if (ok) await window.warp.git.discard(id, plan.token)
      }),

    commit: async (summary, description) => {
      const id = get().workspaceId
      if (!id) throw new Error('没有选中工作区')
      set({ busy: true })
      try {
        return (await window.warp.git.commit(id, summary, description)).hash
      } finally {
        set({ busy: false })
        await get().refresh({ force: true, silent: true })
      }
    }
  }
})
