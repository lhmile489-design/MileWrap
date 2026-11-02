import { create } from 'zustand'
import type { AgentInfo, CustomAgentInput, GridMode, PublicConfig, Settings, WorkspaceInput } from '@shared/types'

type ConfigState = {
  config: PublicConfig | null
  agents: AgentInfo[]
  load: () => Promise<void>
  redetect: () => Promise<void>

  createGroup: (name: string) => Promise<void>
  renameGroup: (id: string, name: string) => Promise<void>
  removeGroup: (id: string) => Promise<void>
  reorderGroups: (ids: string[]) => Promise<void>
  toggleGroup: (id: string, collapsed?: boolean) => Promise<void>

  createWorkspace: (input: WorkspaceInput) => Promise<void>
  editWorkspace: (id: string, patch: Partial<WorkspaceInput>) => Promise<void>
  removeWorkspace: (id: string) => Promise<void>
  duplicateWorkspace: (id: string) => Promise<void>
  moveWorkspace: (id: string, groupId: string | null, index: number) => Promise<void>
  updateSettings: (patch: Partial<Settings>) => Promise<void>
  setGroupColor: (id: string, color: string | null) => Promise<void>
  saveCustomAgent: (input: CustomAgentInput) => Promise<void>
  removeCustomAgent: (id: string) => Promise<void>
  savePreset: (name: string, gridMode: GridMode, cells: (string | null)[]) => Promise<void>
  removePreset: (id: string) => Promise<void>
  /** 导入后返回导入数与跳过的原因；取消返回 null */
  importData: () => Promise<{ imported: number; skipped: string[] } | null>
}

/** 主进程每次写配置都返回整份脱敏配置，渲染层直接替换，不做本地合并 */
export const useConfig = create<ConfigState>((set) => {
  const apply = async (p: Promise<PublicConfig>): Promise<void> => {
    set({ config: await p })
  }
  return {
    config: null,
    agents: [],
    load: async () => {
      const [config, agents] = await Promise.all([window.warp.config.get(), window.warp.agent.list()])
      set({ config, agents })
    },
    redetect: async () => {
      set({ agents: await window.warp.agent.redetect() })
    },

    createGroup: (name) => apply(window.warp.group.create(name)),
    renameGroup: (id, name) => apply(window.warp.group.rename(id, name)),
    removeGroup: (id) => apply(window.warp.group.remove(id)),
    reorderGroups: (ids) => apply(window.warp.group.reorder(ids)),
    toggleGroup: (id, collapsed) => apply(window.warp.group.toggle(id, collapsed)),

    createWorkspace: (input) => apply(window.warp.workspace.create(input)),
    editWorkspace: (id, patch) => apply(window.warp.workspace.edit(id, patch)),
    removeWorkspace: (id) => apply(window.warp.workspace.remove(id)),
    duplicateWorkspace: (id) => apply(window.warp.workspace.duplicate(id)),
    moveWorkspace: (id, groupId, index) => apply(window.warp.workspace.move(id, groupId, index)),
    updateSettings: (patch) => apply(window.warp.settings.update(patch)),
    setGroupColor: (id, color) => apply(window.warp.group.setColor(id, color)),
    saveCustomAgent: async (input) => {
      await apply(window.warp.agent.saveCustom(input))
      // 主进程已丢掉探测缓存：重新取一次，下拉与设置页的「已安装」随之更新
      set({ agents: await window.warp.agent.list() })
    },
    removeCustomAgent: async (id) => {
      await apply(window.warp.agent.removeCustom(id))
      set({ agents: await window.warp.agent.list() })
    },
    savePreset: (name, gridMode, cells) => apply(window.warp.preset.save(name, gridMode, cells)),
    removePreset: (id) => apply(window.warp.preset.remove(id)),
    importData: async () => {
      const r = await window.warp.config.importData()
      if (!r) return null
      set({ config: r.config })
      return { imported: r.imported, skipped: r.skipped }
    }
  }
})
