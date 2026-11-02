import { create } from 'zustand'

/**
 * 工作区分支缓存（PRD W-16）。主进程只读 .git/HEAD，开销很小，
 * 但卡片多时仍按工作区去重：同一工作区同时只有一次请求在路上。
 */
type BranchState = {
  branches: Record<string, string | null>
  refresh: (workspaceId: string) => void
  refreshAll: (ids: string[]) => void
}

const inflight = new Set<string>()

export const useBranches = create<BranchState>((set, get) => ({
  branches: {},
  refresh: (workspaceId) => {
    if (inflight.has(workspaceId)) return
    inflight.add(workspaceId)
    void window.warp.git
      .branch(workspaceId)
      .catch(() => null)
      .then((branch) => {
        if (get().branches[workspaceId] !== branch) set({ branches: { ...get().branches, [workspaceId]: branch } })
      })
      .finally(() => inflight.delete(workspaceId))
  },
  refreshAll: (ids) => {
    for (const id of ids) get().refresh(id)
  }
}))
