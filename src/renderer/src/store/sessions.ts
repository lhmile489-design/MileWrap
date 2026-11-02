import { create } from 'zustand'
import type { SessionMeta } from '@shared/types'

/**
 * 会话列表（主进程内存里的运行时状态的镜像）。
 * 「哪个会话显示在哪一格」不在这里，在 store/layout.ts 的 cells。
 */
type SessionsState = {
  sessions: SessionMeta[]
  /** 首次从主进程拿到列表后为 true；之前不能据空列表去清格位 */
  ready: boolean
  /** 当前选中的工作区（会话栏高亮、目录栏跟随） */
  selectedWorkspaceId: string | null
  init: () => Promise<() => void>
  selectWorkspace: (id: string | null) => void
  start: (workspaceId: string, dims?: { cols?: number; rows?: number }) => Promise<SessionMeta>
  openShell: (workspaceId: string, dims?: { cols?: number; rows?: number }) => Promise<SessionMeta>
  close: (id: string) => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  /** 别的入口（一键恢复、续接启动）拉起的会话：先放进列表，免得格里闪空 */
  adopt: (meta: SessionMeta) => void
}

export const useSessions = create<SessionsState>((set, get) => ({
  sessions: [],
  ready: false,
  selectedWorkspaceId: null,
  init: async () => {
    set({ sessions: await window.warp.session.list(), ready: true })
    return window.warp.session.onChanged((sessions) => set({ sessions }))
  },
  selectWorkspace: (id) => set({ selectedWorkspaceId: id }),
  start: async (workspaceId, dims) => {
    const meta = await window.warp.session.start(workspaceId, dims)
    upsert(set, get, meta)
    return meta
  },
  openShell: async (workspaceId, dims) => {
    const meta = await window.warp.session.openShell(workspaceId, dims)
    upsert(set, get, meta)
    return meta
  },
  close: async (id) => {
    await window.warp.session.close(id)
  },
  rename: async (id, title) => {
    const meta = await window.warp.session.rename(id, title)
    if (meta) set({ sessions: get().sessions.map((s) => (s.id === id ? meta : s)) })
  },
  adopt: (meta) => upsert(set, get, meta)
}))

/** invoke 返回比 session:changed 事件早到时，先把会话放进列表，避免格里闪空 */
function upsert(set: (p: Partial<SessionsState>) => void, get: () => SessionsState, meta: SessionMeta): void {
  const list = get().sessions.filter((s) => s.id !== meta.id)
  set({ sessions: [...list, meta], selectedWorkspaceId: meta.workspaceId })
}
