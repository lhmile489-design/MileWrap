import type { Group, Workspace } from '@shared/types'
import { useConfig } from '../../store/config'

/**
 * 会话栏拖拽排序（PRD W-08）：HTML5 draggable，不引入拖拽库（技术设计 §2）。
 * 载荷只带 id；排序结果由主进程 workspace:move / group:reorder 校验后落盘。
 */
export const DRAG_WS = 'application/x-warp-workspace'
export const DRAG_GROUP = 'application/x-warp-group'
/** 会话：从会话子行或格头拖到某一格（PRD T-02a） */
export const DRAG_SESSION = 'application/x-warp-session'
/** 目录栏的文件 / 文件夹：拖到终端格 = 把路径插入那个会话的输入行（升级建议 2.4）。载荷为「workspaceId\n相对路径」 */
export const DRAG_FILE = 'application/x-warp-file'

export type DropAt = 'before' | 'after' | null
type DragKind = 'workspace' | 'group' | 'session'
const MIME: Record<DragKind, string> = { workspace: DRAG_WS, group: DRAG_GROUP, session: DRAG_SESSION }

/** dragover 里读不到 dataTransfer 的数据，只能读类型；拖的是谁记在这里 */
let dragging: { kind: DragKind; id: string } | null = null

export function beginDrag(e: React.DragEvent, kind: DragKind, id: string): void {
  e.dataTransfer.setData(MIME[kind], id)
  e.dataTransfer.effectAllowed = 'move'
  dragging = { kind, id }
}

/**
 * 目录栏节点拖到终端格 = 插入路径（升级建议 2.4）。载荷是「workspaceId\n相对路径」；
 * 同时放 text/plain，拖进别的应用时得到相对路径
 */
export function beginFileDrag(e: React.DragEvent, workspaceId: string, rel: string): void {
  e.dataTransfer.setData(DRAG_FILE, `${workspaceId}\n${rel}`)
  e.dataTransfer.setData('text/plain', rel)
  e.dataTransfer.effectAllowed = 'copy'
}

export function endDrag(): void {
  dragging = null
}

export function draggingId(kind: DragKind): string | null {
  return dragging && dragging.kind === kind ? dragging.id : null
}

export function carries(e: React.DragEvent, mime: string): boolean {
  return e.dataTransfer.types.includes(mime)
}

/** 指针在目标上半部 = 放到它前面 */
export function dropSide(e: React.DragEvent): 'before' | 'after' {
  const r = e.currentTarget.getBoundingClientRect()
  return e.clientY < r.top + r.height / 2 ? 'before' : 'after'
}

export function byOrder(a: { order: number }, b: { order: number }): number {
  return a.order - b.order
}

export function sortedGroups(): Group[] {
  return [...(useConfig.getState().config?.groups ?? [])].sort(byOrder)
}

/** 放到某张卡片前 / 后：换算成 workspace:move 需要的「目标组内（不含自己）的下标」 */
export function placeWorkspace(dragId: string, target: Workspace, at: 'before' | 'after'): void {
  if (dragId === target.id) return
  const members = (useConfig.getState().config?.workspaces ?? [])
    .filter((w) => w.groupId === target.groupId && w.id !== dragId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
  const i = members.findIndex((w) => w.id === target.id)
  if (i < 0) return
  void moveWorkspace(dragId, target.groupId, at === 'before' ? i : i + 1)
}

/** 放进某个分组末尾（拖到分组标签或组内空白处） */
export function appendWorkspace(dragId: string, groupId: string | null): void {
  void moveWorkspace(dragId, groupId, 1_000_000)
}

/** 分组标签拖到另一个分组标签前 / 后 */
export function placeGroup(dragId: string, targetId: string, at: 'before' | 'after'): void {
  if (dragId === targetId) return
  const ids = sortedGroups()
    .map((g) => g.id)
    .filter((id) => id !== dragId)
  const i = ids.indexOf(targetId)
  if (i < 0) return
  ids.splice(at === 'before' ? i : i + 1, 0, dragId)
  void useConfig
    .getState()
    .reorderGroups(ids)
    .catch(() => undefined)
}

async function moveWorkspace(id: string, groupId: string | null, index: number): Promise<void> {
  try {
    await useConfig.getState().moveWorkspace(id, groupId, index)
  } catch {
    // 目标分组刚被删掉之类的竞态：主进程拒绝即不变，界面按最新配置重画
  }
}
