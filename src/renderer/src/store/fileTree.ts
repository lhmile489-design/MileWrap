import { create } from 'zustand'
import type { FileEntry } from '@shared/types'
import { errorText } from '../lib/errors'

/** 一个目录层级的加载结果；键是工作区内相对路径（'' = 根，分隔符统一用 /） */
export type DirState =
  | { status: 'loading' }
  | { status: 'ok'; entries: FileEntry[] }
  | { status: 'error'; message: string }

type TreeOfWorkspace = {
  dirs: Record<string, DirState>
  /** 展开的目录；根目录默认展开 */
  open: Record<string, boolean>
  selected: string | null
}

type FileTreeState = {
  trees: Record<string, TreeOfWorkspace>
  /** 已展开的目录有变化（主进程 fs.watch 推送）：只提示，不自动重读 */
  stale: Record<string, boolean>
  markStale: (workspaceId: string) => void
  load: (workspaceId: string, rel: string) => Promise<void>
  toggle: (workspaceId: string, rel: string) => void
  setOpen: (workspaceId: string, rel: string, open: boolean) => void
  select: (workspaceId: string, rel: string) => void
  /** 重新读取所有已加载过的层级（头部「刷新」） */
  refresh: (workspaceId: string) => void
  /** 工作区被删时丢掉缓存 */
  retain: (ids: Set<string>) => void
}

const EMPTY_TREE: TreeOfWorkspace = { dirs: {}, open: { '': true }, selected: null }

export function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

/**
 * 目录栏的树（UI设计约束 §4.1.1）：按工作区各记一份展开状态与目录缓存，切走再切回保持原样。
 * 只读。已展开的层级由主进程非递归 watch，有变化只在头部提示「有更新」，点刷新才重读。
 */
export const useFileTree = create<FileTreeState>((set, get) => {
  const patch = (workspaceId: string, fn: (t: TreeOfWorkspace) => TreeOfWorkspace): void => {
    const cur = get().trees[workspaceId] ?? EMPTY_TREE
    set({ trees: { ...get().trees, [workspaceId]: fn(cur) } })
  }
  const setDir = (workspaceId: string, rel: string, d: DirState): void =>
    patch(workspaceId, (t) => ({ ...t, dirs: { ...t.dirs, [rel]: d } }))

  return {
    trees: {},
    stale: {},
    markStale: (workspaceId) => {
      if (!get().stale[workspaceId]) set({ stale: { ...get().stale, [workspaceId]: true } })
    },
    load: async (workspaceId, rel) => {
      const prev = get().trees[workspaceId]?.dirs[rel]
      // 刷新时保留旧内容，避免整棵树闪成骨架
      if (!prev || prev.status !== 'ok') setDir(workspaceId, rel, { status: 'loading' })
      try {
        const entries = await window.warp.fs.listDir(workspaceId, rel)
        setDir(workspaceId, rel, { status: 'ok', entries })
      } catch (e) {
        setDir(workspaceId, rel, { status: 'error', message: errorText(e) })
      }
    },
    toggle: (workspaceId, rel) => {
      const t = get().trees[workspaceId] ?? EMPTY_TREE
      get().setOpen(workspaceId, rel, !t.open[rel])
    },
    setOpen: (workspaceId, rel, open) => {
      patch(workspaceId, (t) => ({ ...t, open: { ...t.open, [rel]: open } }))
      const d = get().trees[workspaceId]?.dirs[rel]
      if (open && (!d || d.status === 'error')) void get().load(workspaceId, rel)
    },
    select: (workspaceId, rel) => patch(workspaceId, (t) => ({ ...t, selected: rel })),
    refresh: (workspaceId) => {
      if (get().stale[workspaceId]) set({ stale: { ...get().stale, [workspaceId]: false } })
      const t = get().trees[workspaceId]
      if (!t) return
      for (const rel of Object.keys(t.dirs)) {
        // 已收起的层级不重读，丢掉缓存，下次展开再读
        if (rel === '' || t.open[rel]) void get().load(workspaceId, rel)
        else
          patch(workspaceId, (x) => {
            const dirs = { ...x.dirs }
            delete dirs[rel]
            return { ...x, dirs }
          })
      }
    },
    retain: (ids) => {
      const next: Record<string, TreeOfWorkspace> = {}
      for (const [id, t] of Object.entries(get().trees)) if (ids.has(id)) next[id] = t
      set({ trees: next })
    }
  }
})

export { EMPTY_TREE }
