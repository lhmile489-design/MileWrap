import { create } from 'zustand'
import type { ActivityState, SessionActivity } from '@shared/types'

/**
 * 会话活动状态（升级建议 2.1）：主进程按输出时间判断，渲染层只镜像。
 * 选择器只取单个会话的原始值（字符串 / 布尔），不在选择器里拼新对象（React #185）。
 */
type ActivityStore = {
  state: Record<string, ActivityState>
  attention: Record<string, boolean>
  init: () => Promise<() => void>
  /** 用户看过这个会话：清掉「等你处理」 */
  seen: (id: string) => void
}

export const useActivity = create<ActivityStore>((set, get) => {
  const apply = (a: SessionActivity): void => {
    const s = get()
    if (s.state[a.id] === a.state && Boolean(s.attention[a.id]) === a.attention) return
    set({ state: { ...s.state, [a.id]: a.state }, attention: { ...s.attention, [a.id]: a.attention } })
  }
  return {
    state: {},
    attention: {},
    init: async () => {
      const off = window.warp.session.onActivity(apply)
      const list = await window.warp.session.activityList()
      for (const a of list) apply(a)
      return off
    },
    seen: (id) => {
      if (!get().attention[id]) return
      set({ attention: { ...get().attention, [id]: false } })
      window.warp.session.markSeen(id)
    }
  }
})
