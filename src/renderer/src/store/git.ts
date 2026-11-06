import { create } from 'zustand'
import type { GitBranch, GitDiff, GitProbe, GitProgress, GitRemoteOp, GitRisk, GitStatus } from '@shared/types'
import { errorText } from '../lib/errors'
import { useGitMarks } from './gitMarks'
import { useBranches } from './branches'
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

  /** 仓库里有会执行命令的配置 / 钩子且没确认过：Git 栏只显示确认面板，其它命令主进程也会拒绝 */
  risk: GitRisk | null
  /** 用户确认信任后带回指纹；成功后重新刷新 */
  trust: () => Promise<void>

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

  /** G-20 本地分支列表：打开分支菜单时读 */
  branches: GitBranch[] | null
  loadBranches: () => Promise<void>
  /** 成功返回 true；失败已弹错误 */
  checkout: (branch: string) => Promise<boolean>
  /** 失败抛出，由菜单里的输入行显示原因 */
  createBranch: (name: string) => Promise<void>
  /** G-22 / G-23 进行中的远端操作；同一时间只有一个 */
  remote: { op: GitRemoteOp; stage: string; percent: number; startedAt: number } | null
  runRemote: (op: GitRemoteOp) => Promise<void>
  cancelRemote: () => Promise<void>
  /** 主进程推来的进度：对不上当前工作区与操作的丢掉 */
  onProgress: (p: GitProgress) => void
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
    // 远端操作进行中不暂存 / 丢弃：pull 的合并阶段持有 index.lock（审查 2026-11-06）
    if (!id || get().busy || get().remote) return
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

    risk: null,
    trust: async () => {
      const id = get().workspaceId
      const risk = get().risk
      if (!id || !risk || get().busy) return
      set({ busy: true })
      try {
        await window.warp.git.trust(id, risk.fingerprint)
        set({ risk: null })
      } catch (e) {
        notifyError(e, '确认信任失败')
      } finally {
        set({ busy: false })
        await get().refresh({ force: true })
      }
    },

    setWorkspace: (id) => {
      if (get().workspaceId === id) return
      reqId++
      diffReq++
      set({ workspaceId: id, probe: null, status: null, risk: null, error: null, loading: false, view: { kind: 'list' }, diff: null, diffError: null, branches: null, remote: null })
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
          set({ probe, status: null, risk: null, error: null, loading: false })
          useGitMarks.getState().clear(id)
          return
        }
        // 先查仓库里会执行命令的配置 / 钩子（只读扫描）；没确认过就停在确认面板，不跑 status（status 会执行 clean 过滤器）
        const risk = await window.warp.git.risk(id)
        if (r !== reqId) return
        if (risk) {
          set({ probe, status: null, risk, error: null, loading: false, view: { kind: 'list' }, diff: null, diffError: null })
          useGitMarks.getState().clear(id)
          return
        }
        if (get().risk) set({ risk: null })
        const status = await window.warp.git.status(id)
        if (r !== reqId) return
        set({ probe, status, error: null, loading: false })
        // 目录栏改动标记复用这一次 status（G-18）
        useGitMarks.getState().set(id, probe.relativeDir, status.files)
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
      if (get().remote) throw new Error('远端操作进行中，等它结束再提交')
      set({ busy: true })
      try {
        return (await window.warp.git.commit(id, summary, description)).hash
      } finally {
        set({ busy: false })
        await get().refresh({ force: true, silent: true })
      }
    },

    branches: null,
    loadBranches: async () => {
      const id = get().workspaceId
      if (!id) return
      try {
        const list = await window.warp.git.branches(id)
        if (get().workspaceId === id) set({ branches: list })
      } catch (e) {
        if (get().workspaceId === id) notifyError(e, '读取分支失败')
      }
    },

    checkout: async (branch) => {
      const id = get().workspaceId
      if (!id || get().busy || get().remote) return false
      set({ busy: true })
      try {
        await window.warp.git.checkout(id, branch)
        // 格头分支 pill 读的是 useBranches（.git/HEAD 缓存），切完主动刷新（审查 2026-11-06）
        useBranches.getState().refresh(id)
        return true
      } catch (e) {
        notifyError(e, '切换分支失败')
        return false
      } finally {
        set({ busy: false, branches: null })
        await get().refresh({ force: true, silent: true })
      }
    },

    createBranch: async (name) => {
      const id = get().workspaceId
      if (!id || get().busy || get().remote) return
      set({ busy: true })
      try {
        await window.warp.git.createBranch(id, name)
        useBranches.getState().refresh(id)
      } finally {
        set({ busy: false, branches: null })
        await get().refresh({ force: true, silent: true })
      }
    },

    remote: null,
    runRemote: async (op) => {
      const id = get().workspaceId
      if (!id || get().busy || get().remote) return
      set({ remote: { op, stage: '', percent: 0, startedAt: Date.now() } })
      try {
        const r = await window.warp.git[op](id)
        if (r.conflict)
          notifyError(
            r.rebase
              ? '变基（pull.rebase）时产生冲突，仓库停在变基中途。解决冲突后在终端里 git rebase --continue，或 git rebase --abort 放弃。'
              : '拉取产生冲突，冲突文件已列在改动列表顶部。请在编辑器或让 agent 解决后再暂存。',
            '拉取后有冲突'
          )
      } catch (e) {
        // 用户点了取消：不弹错误
        if (!/已取消/.test(errorText(e))) notifyError(e, op === 'fetch' ? '获取失败' : op === 'pull' ? '拉取失败' : '推送失败')
      } finally {
        if (get().workspaceId === id) set({ remote: null })
        await get().refresh({ force: true, silent: true })
      }
    },

    cancelRemote: async () => {
      const id = get().workspaceId
      if (!id || !get().remote) return
      await window.warp.git.cancel(id).catch(() => undefined)
    },

    onProgress: (p) => {
      const r = get().remote
      if (!r || p.workspaceId !== get().workspaceId || p.op !== r.op) return
      if (r.stage === p.stage && r.percent === p.percent) return
      set({ remote: { ...r, stage: p.stage, percent: p.percent } })
    }
  }
})

// 进度推送在模块级订阅一次（审查 2026-11-06）：Git 栏卸载（收起右栏、切到预览页签、只开工作台）时进度也不丢
window.warp.git.onProgress((p) => useGit.getState().onProgress(p))
