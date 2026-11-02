import { create } from 'zustand'

/**
 * 工作区自定义图标缓存。键 = `${workspaceId}:${hash}`，hash 来自 Workspace.icon（图片内容哈希），
 * 换图后哈希变，自然取新图；图片本身按需经 workspace:icon 取一次（data URL）。
 */
type IconState = {
  urls: Record<string, string>
  ensure: (workspaceId: string, hash: string) => void
}

const inflight = new Set<string>()

export const iconKey = (workspaceId: string, hash: string): string => `${workspaceId}:${hash}`

export const useIcons = create<IconState>((set) => ({
  urls: {},
  ensure: (workspaceId, hash) => {
    const key = iconKey(workspaceId, hash)
    if (inflight.has(key) || useIcons.getState().urls[key]) return
    inflight.add(key)
    window.warp.workspace
      .icon(workspaceId)
      .then((url) => {
        if (!url) return
        set((s) => {
          // 同一工作区的旧哈希一并丢掉，换过几次图也不会攒一堆 data URL
          const urls: Record<string, string> = {}
          const prefix = `${workspaceId}:`
          for (const [k, v] of Object.entries(s.urls)) if (!k.startsWith(prefix)) urls[k] = v
          urls[key] = url
          return { urls }
        })
      })
      .catch(() => {
        // 文件丢了：退回 agent 徽章，不打扰用户
      })
      .finally(() => inflight.delete(key))
  }
}))
