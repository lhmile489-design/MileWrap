import { ArrowClockwise, ArrowCounterClockwise, ArrowSquareIn, Copy, FolderOpen, GitBranch, PencilSimple, Plus, SquareSplitHorizontal, TerminalWindow, Trash, X } from '@phosphor-icons/react'
import type { Cells, Group, LayoutPreset, SessionMeta, Workspace } from '@shared/types'
import { useConfig } from '../store/config'
import { cellOf, useLayout, visibleCount } from '../store/layout'
import { useSessions } from '../store/sessions'
import { useUi } from '../store/ui'
import { useRestore } from '../store/restore'
import { terminals } from '../terminal/TerminalRegistry'
import { isLive } from '../lib/time'
import { choose, confirm, notifyError } from './ConfirmDialog'
import { openPrompt } from './PromptDialog'
import type { MenuItem } from './Menu'

/**
 * 会话栏、格头、目录栏共用的动作。都从 store.getState() 取最新状态，
 * 菜单在打开那一刻生成，不必把一堆回调层层传下去。
 */

export function sessionsOf(workspaceId: string): SessionMeta[] {
  return useSessions
    .getState()
    .sessions.filter((s) => s.workspaceId === workspaceId)
    .sort((a, b) => a.index - b.index)
}

function sessionById(id: string | null): SessionMeta | undefined {
  return id ? useSessions.getState().sessions.find((s) => s.id === id) : undefined
}

/** 当前聚焦格里的会话 */
export function focusedSession(): SessionMeta | undefined {
  const l = useLayout.getState()
  return sessionById(l.cells[l.focused])
}

/** 聚焦某格：键盘进那一格，目录栏跟到该格会话的工作区（PRD T-09 / D-02） */
export function focusCell(cell: number): void {
  useLayout.getState().focusCell(cell)
  const l = useLayout.getState()
  if (l.focused !== cell) return
  const s = sessionById(l.cells[cell])
  if (!s) return
  useSessions.getState().selectWorkspace(s.workspaceId)
  terminals.focus(s.id)
}

/** 把会话放进某格（缺省 = 聚焦格）；已在另一可见格时两格互换（PRD T-02a） */
export function placeSession(sessionId: string, cell?: number): void {
  const l = useLayout.getState()
  l.place(sessionId, cell ?? l.focused)
  const s = sessionById(sessionId)
  if (s) useSessions.getState().selectWorkspace(s.workspaceId)
  // 挂载在下一帧完成，之后再给键盘焦点
  requestAnimationFrame(() => terminals.focus(sessionId))
}

async function startIn(w: Workspace, cell: number, kind: 'agent' | 'shell' = 'agent'): Promise<void> {
  try {
    const st = useSessions.getState()
    const meta = kind === 'shell' ? await st.openShell(w.id) : await st.start(w.id)
    placeSession(meta.id, cell)
  } catch (e) {
    notifyError(e, '启动失败')
  }
}

/**
 * 打开工作区（PRD 4.2 / T-03，见 decisions 2026-11-01）。
 * - 不指定格（单击卡片）：已有会话显示在某格就聚焦那格；有后台会话就切进聚焦格；都没有才启动
 * - 指定格（右键「在第 N 格打开」、拖到格上）：优先拿后台的运行中会话放进去，没有就在该格启动
 */
export function openWorkspace(w: Workspace, cell?: number): void {
  useSessions.getState().selectWorkspace(w.id)
  const l = useLayout.getState()
  const list = sessionsOf(w.id)
  if (cell === undefined) {
    const shown = list.find((s) => cellOf(l, s.id) >= 0)
    if (shown) {
      focusCell(cellOf(l, shown.id))
      return
    }
  }
  const target = list.find((s) => isLive(s) && cellOf(l, s.id) < 0) ?? list.find(isLive) ?? list[list.length - 1]
  const at = cell ?? l.focused
  if (target) placeSession(target.id, at)
  else void startIn(w, at)
}

export function newSession(w: Workspace, cell?: number): void {
  void startIn(w, cell ?? useLayout.getState().focused)
}

/** 续接上次对话启动（PRD S-10）：用该工作区最近一条快照的会话 ID，不走恢复卡片 */
export async function resumeWorkspaceIn(w: Workspace, cell?: number): Promise<void> {
  const at = cell ?? useLayout.getState().focused
  try {
    const meta = await window.warp.session.resumeWorkspace(w.id)
    useSessions.getState().adopt(meta)
    placeSession(meta.id, at)
  } catch (e) {
    notifyError(e, '续接失败')
  }
}

/** 在工作区目录打开 Shell（PRD T-15），放进指定格 */
export function openShellIn(workspaceId: string, cell: number): void {
  const w = useConfig.getState().config?.workspaces.find((x) => x.id === workspaceId)
  if (w) void startIn(w, cell, 'shell')
}

/** 点会话子行：已显示就聚焦那格，否则切进聚焦格 */
export function showSession(s: SessionMeta): void {
  const at = cellOf(useLayout.getState(), s.id)
  if (at >= 0) {
    useSessions.getState().selectWorkspace(s.workspaceId)
    focusCell(at)
  } else {
    placeSession(s.id)
  }
}

/** 关闭会话；仍在运行时先确认（PRD W-15 / T-06） */
export async function closeSession(s: SessionMeta): Promise<void> {
  if (isLive(s)) {
    // 多格模式下关的是显示在格里的运行中会话：多给一个「转入后台」，不结束进程（升级建议 4.8）
    const l = useLayout.getState()
    const shown = visibleCount(l) > 1 && cellOf(l, s.id) >= 0
    const c = await choose({
      title: `关闭「${s.title}」？`,
      body: shown ? '会话仍在运行。关闭会结束进程；转入后台只是把它从这一格拿走，进程继续运行。' : '会话仍在运行，关闭会结束进程。',
      danger: true,
      okLabel: '关闭会话',
      altLabel: shown ? '转入后台' : undefined
    })
    if (c === 'cancel') return
    if (c === 'alt') {
      toBackground(s.id)
      return
    }
  }
  await useSessions
    .getState()
    .close(s.id)
    .catch((e: unknown) => notifyError(e, '关闭失败'))
}

/** 把会话从格里拿走，进程继续在后台运行 */
export function toBackground(sessionId: string): void {
  const l = useLayout.getState()
  const i = l.cells.indexOf(sessionId)
  if (i < 0) return
  const cells = [...l.cells] as Cells
  cells[i] = null
  useLayout.setState({ cells, maximized: null })
}

/**
 * 分组「全部启动」（升级建议 3.2）：按组内顺序，已有运行中会话的不重复开；
 * 依次放进空的可见格，放满之后的转后台。同目录的 Kimi 由主进程排队启动。
 */
export async function startGroup(groupId: string | null): Promise<void> {
  const list = (useConfig.getState().config?.workspaces ?? [])
    .filter((w) => w.groupId === groupId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
  const failures: string[] = []
  for (const w of list) {
    const live = sessionsOf(w.id).find(isLive)
    const l = useLayout.getState()
    const empty = Array.from({ length: visibleCount(l) }, (_, i) => i).find((i) => !l.cells[i])
    if (live) {
      if (cellOf(l, live.id) < 0 && empty !== undefined) placeSession(live.id, empty)
      continue
    }
    try {
      const meta = await useSessions.getState().start(w.id)
      if (empty !== undefined) placeSession(meta.id, empty)
    } catch (e) {
      failures.push(`${w.name}：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (failures.length) notifyError(new Error(failures.join('\n')), `有 ${failures.length} 个工作区没能启动`)
}

/** 分组「全部结束」：先确认，再结束组内全部运行中的会话（会话保留在列表里，可重启） */
export async function stopGroup(groupId: string | null, groupName: string): Promise<void> {
  const ids = new Set((useConfig.getState().config?.workspaces ?? []).filter((w) => w.groupId === groupId).map((w) => w.id))
  const live = useSessions.getState().sessions.filter((s) => ids.has(s.workspaceId) && isLive(s))
  if (!live.length) return
  const ok = await confirm({
    title: `结束「${groupName}」里的 ${live.length} 个会话？`,
    body: '会结束这些进程，会话仍留在列表里，可以重新启动。',
    danger: true,
    okLabel: '全部结束'
  })
  if (!ok) return
  await Promise.all(live.map((s) => window.warp.session.kill(s.id).catch(() => null)))
}

/**
 * 应用布局预设（升级建议 3.1）：切到预设的宫格，各格放对应工作区。
 * 已在运行的会话直接放进去，不重复开；预设里的工作区被删了就留空格。
 */
export async function applyPreset(p: LayoutPreset): Promise<void> {
  useLayout.getState().setGridMode(p.gridMode)
  const count = visibleCount(useLayout.getState())
  const workspaces = useConfig.getState().config?.workspaces ?? []
  const failures: string[] = []
  for (let i = 0; i < count; i++) {
    const w = workspaces.find((x) => x.id === p.cells[i])
    if (!w) continue
    const l = useLayout.getState()
    const live = sessionsOf(w.id).find((s) => isLive(s) && (cellOf(l, s.id) < 0 || cellOf(l, s.id) === i))
    if (live) {
      placeSession(live.id, i)
      continue
    }
    try {
      const meta = await useSessions.getState().start(w.id)
      placeSession(meta.id, i)
    } catch (e) {
      failures.push(`${w.name}：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (failures.length) notifyError(new Error(failures.join('\n')), `预设「${p.name}」里有 ${failures.length} 格没能启动`)
}

/** 把当前宫格存成预设：每格记下它会话所属的工作区 */
export function savePresetPrompt(): void {
  const l = useLayout.getState()
  const sessions = useSessions.getState().sessions
  const count = visibleCount(l)
  const cells = Array.from({ length: 4 }, (_, i) => {
    if (i >= count) return null
    const s = sessions.find((x) => x.id === l.cells[i])
    return s && s.kind === 'agent' ? s.workspaceId : null
  })
  if (cells.every((c) => c === null)) {
    notifyError(new Error('当前格里没有工作区会话，先在格里打开几个工作区再保存'), '无法保存布局预设')
    return
  }
  openPrompt({
    title: '保存为布局预设',
    label: '预设名称（同名会覆盖）',
    onSubmit: (name) => useConfig.getState().savePreset(name, l.gridMode, cells)
  })
}

export function renameSessionPrompt(s: SessionMeta): void {
  openPrompt({ title: '重命名会话', label: '会话标题', initial: s.title, onSubmit: (v) => useSessions.getState().rename(s.id, v) })
}

export async function removeWorkspace(w: Workspace): Promise<void> {
  const live = sessionsOf(w.id).some(isLive)
  const ok = await confirm({
    title: `删除工作区「${w.name}」？`,
    body: live ? '这个工作区还有运行中的会话，删除会结束这些进程。磁盘上的目录不受影响。' : '只删除这条配置，磁盘上的目录不受影响。',
    danger: true,
    okLabel: '删除'
  })
  if (!ok) return
  try {
    await useConfig.getState().removeWorkspace(w.id)
    if (useSessions.getState().selectedWorkspaceId === w.id) useSessions.getState().selectWorkspace(null)
  } catch (e) {
    notifyError(e, '删除失败')
  }
}

/** 删除分组：非空时二次确认，其下工作区移到「未分组」（PRD W-02） */
export async function removeGroup(g: Group): Promise<void> {
  const count = useConfig.getState().config?.workspaces.filter((w) => w.groupId === g.id).length ?? 0
  if (
    count > 0 &&
    !(await confirm({
      title: `删除分组「${g.name}」？`,
      body: `其下 ${count} 个工作区会移到「未分组」，工作区本身不会删除。`,
      danger: true,
      okLabel: '删除分组'
    }))
  ) {
    return
  }
  await useConfig
    .getState()
    .removeGroup(g.id)
    .catch((e: unknown) => notifyError(e, '删除失败'))
}

export function createGroupPrompt(): void {
  openPrompt({ title: '新建分组', label: '分组名称', onSubmit: (v) => useConfig.getState().createGroup(v) })
}

function run(p: Promise<unknown>, title: string): void {
  void p.catch((e: unknown) => notifyError(e, title))
}

/** 可见格的编号 0..n-1；单格时为空（只有一格，「第 1 格」与单击等价，不重复列出） */
function cellChoices(): number[] {
  const n = visibleCount(useLayout.getState())
  return n > 1 ? Array.from({ length: n }, (_, i) => i) : []
}

/** Git管理-PRD G-05 / G-06：把右栏切到 Git 页签并定位到这个工作区（Git 栏跟随会话栏选中） */
export function openGitFor(workspaceId: string): void {
  if (useConfig.getState().config?.settings.gitEnabled !== true) return
  useSessions.getState().selectWorkspace(workspaceId)
  useLayout.getState().showRightTab('git')
}

/** 工作区右键菜单（PRD W-11） */
export function workspaceMenu(w: Workspace): MenuItem[] {
  const list = sessionsOf(w.id)
  const items: MenuItem[] = [{ label: '新建会话', icon: <Plus size={16} />, onSelect: () => newSession(w) }]
  if (useRestore.getState().resumable.includes(w.id)) {
    items.push({ label: '续接上次对话启动', icon: <ArrowCounterClockwise size={16} />, onSelect: () => void resumeWorkspaceIn(w) })
  }
  for (const i of cellChoices()) {
    items.push({ label: `在第 ${i + 1} 格打开`, icon: <SquareSplitHorizontal size={16} />, onSelect: () => openWorkspace(w, i) })
  }
  // 只有一个会话时没有子行，会话级操作放到这里
  if (list.length === 1) {
    items.push({ label: '重命名会话', icon: <PencilSimple size={16} />, onSelect: () => renameSessionPrompt(list[0]) })
  }
  items.push(
    { label: '历史会话…', icon: <ArrowCounterClockwise size={16} />, onSelect: () => useUi.getState().openHistory(w.cwd) }
  )
  if (useConfig.getState().config?.settings.gitEnabled === true) {
    items.push({ label: 'Git…', icon: <GitBranch size={16} />, onSelect: () => openGitFor(w.id) })
  }
  items.push(
    { kind: 'separator' },
    { label: '在资源管理器中打开', icon: <FolderOpen size={16} />, onSelect: () => run(window.warp.shell.openPath(w.id), '打开失败') },
    {
      label: '在 Windows Terminal 中打开',
      icon: <TerminalWindow size={16} />,
      onSelect: () => run(window.warp.shell.openExternalTerminal(w.id), '打开失败')
    },
    { kind: 'separator' },
    { label: '编辑工作区', icon: <PencilSimple size={16} />, onSelect: () => useUi.getState().openEdit(w.id) },
    { label: '复制工作区', icon: <Copy size={16} />, onSelect: () => run(useConfig.getState().duplicateWorkspace(w.id), '复制失败') },
    { kind: 'separator' },
    { label: '删除工作区', icon: <Trash size={16} />, danger: true, onSelect: () => void removeWorkspace(w) }
  )
  return items
}

/** 会话右键菜单（PRD W-11） */
export function sessionMenu(s: SessionMeta, rename: () => void): MenuItem[] {
  const l = useLayout.getState()
  const at = cellOf(l, s.id)
  const items: MenuItem[] = [
    { label: '切到当前格', icon: <ArrowSquareIn size={16} />, disabled: at === l.focused, onSelect: () => placeSession(s.id, l.focused) }
  ]
  for (const i of cellChoices()) {
    if (i !== at) items.push({ label: `移到第 ${i + 1} 格`, icon: <SquareSplitHorizontal size={16} />, onSelect: () => placeSession(s.id, i) })
  }
  items.push(
    { label: '重命名', icon: <PencilSimple size={16} />, onSelect: rename },
    { label: '重启', icon: <ArrowClockwise size={16} />, onSelect: () => run(window.warp.session.restart(s.id), '重启失败') },
    { kind: 'separator' },
    { label: '关闭会话', icon: <X size={16} />, danger: true, onSelect: () => void closeSession(s) }
  )
  return items
}

/** 广播输入（PRD T-17，升级建议 3.4）：每次打开都确认一次，不写进设置 */
export async function toggleBroadcast(): Promise<void> {
  const ui = useUi.getState()
  if (ui.broadcast) {
    ui.setBroadcast(false)
    return
  }
  const ok = await confirm({
    title: '开启广播输入？',
    body: '在聚焦格里输入的内容会同时发给所有可见格里运行中的会话，可以在格头逐格排除。这很容易误操作，比如对几个 agent 同时回答 y。重新加载界面后自动关闭。',
    okLabel: '开启广播',
    danger: true
  })
  if (ok) useUi.getState().setBroadcast(true)
}
