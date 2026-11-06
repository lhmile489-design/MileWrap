import { create } from 'zustand'

/** 工作区弹窗：新建（可带默认分组、预填目录）或编辑某个工作区 */
export type WorkspaceDialogState =
  | { kind: 'create'; groupId: string | null; cwd?: string; name?: string }
  | { kind: 'edit'; id: string }
  | null

/**
 * 不需要持久化的界面状态：会话子行展开、工作区弹窗、广播、长文本输入框。
 * 栏位显隐、栏宽、宫格在 store/layout.ts（写 window-state.json）。
 */
export type SettingsTab = 'appearance' | 'terminal' | 'agents' | 'notify' | 'startup' | 'git' | 'about'

type UiState = {
  /** 展开了会话子行的工作区 */
  expanded: Record<string, boolean>
  workspaceDialog: WorkspaceDialogState
  /** 设置页（PRD S-02）；null = 关闭 */
  settingsTab: SettingsTab | null
  /** 命令面板（PRD W-09） */
  paletteOpen: boolean
  /** 打开了终端内搜索条的格（PRD T-12） */
  searchCell: number | null
  /** 快捷键速查浮层（升级建议 3.6） */
  shortcutsOpen: boolean
  /**
   * 广播输入（PRD T-17，升级建议 3.4）：默认关，每次打开都要确认，不写进设置，关窗口（重载）即失效。
   * excluded 是被排除的会话 id
   */
  broadcast: boolean
  broadcastExcluded: Record<string, boolean>
  /** 打开了长文本输入框的格（升级建议 4.2）；按格手动打开，发完自动收起 */
  composerCell: number | null
  /** 会话历史对话框（会话管理升级计划 §3.5）；cwd = 打开时定位到的目录，null = 全部；整体 null = 关闭 */
  history: { cwd: string | null } | null
  openHistory: (cwd?: string | null) => void
  closeHistory: () => void
  /** Skills 管理对话框（Skills管理-PRD §4.1） */
  skillsOpen: boolean
  openSkills: () => void
  closeSkills: () => void
  /** Git 工作台大弹窗（Git管理-PRD G-30）；null = 关闭，否则是打开的页签 */
  gitWorkbench: 'changes' | 'history' | null
  openGitWorkbench: (tab?: 'changes' | 'history') => void
  closeGitWorkbench: () => void
  setExpanded: (workspaceId: string, open: boolean) => void
  openCreate: (groupId?: string | null, prefill?: { cwd: string; name: string }) => void
  openEdit: (id: string) => void
  closeDialog: () => void
  openSettings: (tab?: SettingsTab) => void
  closeSettings: () => void
  setPaletteOpen: (open: boolean) => void
  setSearchCell: (cell: number | null) => void
  setShortcutsOpen: (open: boolean) => void
  setBroadcast: (on: boolean) => void
  toggleBroadcastExclude: (sessionId: string) => void
  setComposerCell: (cell: number | null) => void
}

export const useUi = create<UiState>((set, get) => ({
  expanded: {},
  workspaceDialog: null,
  settingsTab: null,
  paletteOpen: false,
  searchCell: null,
  shortcutsOpen: false,
  broadcast: false,
  broadcastExcluded: {},
  composerCell: null,
  history: null,
  openHistory: (cwd = null) => set({ history: { cwd }, paletteOpen: false }),
  closeHistory: () => set({ history: null }),
  skillsOpen: false,
  openSkills: () => set({ skillsOpen: true, paletteOpen: false }),
  closeSkills: () => set({ skillsOpen: false }),
  gitWorkbench: null,
  openGitWorkbench: (tab = 'changes') => set({ gitWorkbench: tab, paletteOpen: false }),
  closeGitWorkbench: () => set({ gitWorkbench: null }),
  openSettings: (tab = 'appearance') => set({ settingsTab: tab, paletteOpen: false }),
  closeSettings: () => set({ settingsTab: null }),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setSearchCell: (cell) => set({ searchCell: cell }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  setBroadcast: (on) => set(on ? { broadcast: true } : { broadcast: false, broadcastExcluded: {} }),
  toggleBroadcastExclude: (sessionId) =>
    set({ broadcastExcluded: { ...get().broadcastExcluded, [sessionId]: !get().broadcastExcluded[sessionId] } }),
  setComposerCell: (cell) => set({ composerCell: cell }),
  setExpanded: (workspaceId, open) => set({ expanded: { ...get().expanded, [workspaceId]: open } }),
  openCreate: (groupId = null, prefill) => set({ workspaceDialog: { kind: 'create', groupId, ...prefill } }),
  openEdit: (id) => set({ workspaceDialog: { kind: 'edit', id } }),
  closeDialog: () => set({ workspaceDialog: null })
}))
