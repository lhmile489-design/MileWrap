import { useState } from 'react'
import { CaretRight, DotsThree, Palette, PencilSimple, Play, Plus, Stop, Trash } from '@phosphor-icons/react'
import type { Group } from '@shared/types'
import { useConfig } from '../../store/config'
import { useUi } from '../../store/ui'
import { removeGroup, startGroup, stopGroup } from '../actions'
import { notifyError } from '../ConfirmDialog'
import { InlineEdit } from '../InlineEdit'
import { openMenu, openMenuAt, type MenuItem } from '../Menu'
import { IconButton } from '../ui'
import { GROUP_COLORS } from '../../lib/palette'
import { DRAG_GROUP, DRAG_WS, appendWorkspace, beginDrag, carries, draggingId, dropSide, endDrag, placeGroup, type DropAt } from './drag'

/**
 * 分组标签行（UI设计约束 §4.1）：28px，没有底色，不是卡片。
 * 点击折叠 / 展开（持久化，W-03）；双击或菜单改名（行内编辑）；
 * 拖动标签调整分组顺序；把工作区拖到标签上 = 移进该分组末尾。
 */
export function GroupLabel({ group, filtering }: { group: Group; filtering: boolean }): React.JSX.Element {
  const toggleGroup = useConfig((s) => s.toggleGroup)
  const renameGroup = useConfig((s) => s.renameGroup)
  const openCreate = useUi((s) => s.openCreate)
  const [renaming, setRenaming] = useState(false)
  const [dropAt, setDropAt] = useState<DropAt>(null)
  const [wsOver, setWsOver] = useState(false)
  const open = filtering || !group.collapsed

  const menu = (): MenuItem[] => [
    { label: '新建工作区', icon: <Plus size={16} />, onSelect: () => openCreate(group.id) },
    { label: '重命名分组', icon: <PencilSimple size={16} />, onSelect: () => setRenaming(true) },
    { kind: 'separator' },
    { label: '全部启动', icon: <Play size={16} />, onSelect: () => void startGroup(group.id) },
    { label: '全部结束', icon: <Stop size={16} />, onSelect: () => void stopGroup(group.id, group.name) },
    { kind: 'separator' },
    ...GROUP_COLORS.map((c) => ({
      label: c.label,
      icon: c.value ? <span aria-hidden="true" className="size-3 rounded-pill" style={{ backgroundColor: c.value }} /> : <Palette size={16} />,
      onSelect: () => void useConfig.getState().setGroupColor(group.id, c.value).catch((e: unknown) => notifyError(e))
    })),
    { kind: 'separator' },
    { label: '删除分组', icon: <Trash size={16} />, danger: true, onSelect: () => void removeGroup(group) }
  ]

  const toggle = (): void => {
    if (filtering) return
    void toggleGroup(group.id).catch((e: unknown) => notifyError(e))
  }

  return (
    <div
      data-group-label={group.id}
      draggable={!filtering && !renaming}
      onDragStart={(e) => beginDrag(e, 'group', group.id)}
      onDragEnd={endDrag}
      onDragOver={(e) => {
        if (carries(e, DRAG_GROUP) && draggingId('group') !== group.id) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const at = dropSide(e)
          if (at !== dropAt) setDropAt(at)
        } else if (carries(e, DRAG_WS)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          if (!wsOver) setWsOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropAt(null)
        setWsOver(false)
      }}
      onDrop={(e) => {
        const at = dropAt
        setDropAt(null)
        setWsOver(false)
        const gid = e.dataTransfer.getData(DRAG_GROUP)
        const wid = e.dataTransfer.getData(DRAG_WS)
        if (!gid && !wid) return
        e.preventDefault()
        e.stopPropagation()
        if (gid && at) placeGroup(gid, group.id, at)
        else if (wid) appendWorkspace(wid, group.id)
      }}
      onContextMenu={(e) => openMenu(e, menu())}
      className={`group/label relative mt-2 flex h-7 items-center gap-1 rounded-control transition-colors duration-150 ${
        wsOver ? 'bg-accent-soft' : ''
      }`}
    >
      {dropAt && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute right-0 left-0 h-0.5 rounded-pill bg-accent ${dropAt === 'before' ? '-top-1' : '-bottom-1'}`}
        />
      )}
      {renaming ? (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <CaretRight size={16} aria-hidden="true" className={`shrink-0 text-ink-faint ${open ? 'rotate-90' : ''}`} />
          <InlineEdit
            initial={group.name}
            label="分组名称"
            className="text-[12px] font-semibold"
            onCommit={(v) => {
              setRenaming(false)
              void renameGroup(group.id, v).catch((e: unknown) => notifyError(e, '重命名失败'))
            }}
            onCancel={() => setRenaming(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          onDoubleClick={() => setRenaming(true)}
          onKeyDown={(e) => {
            if (e.key === 'F2') {
              e.preventDefault()
              setRenaming(true)
            }
          }}
          className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-control text-left"
        >
          <CaretRight
            size={16}
            aria-hidden="true"
            className={`shrink-0 text-ink-faint opacity-0 transition duration-200 ease-spring group-focus-within/label:opacity-100 group-hover/label:opacity-100 ${
              open ? 'rotate-90' : ''
            }`}
          />
          {group.color && <span aria-hidden="true" data-group-color={group.color} className="size-2 shrink-0 rounded-pill" style={{ backgroundColor: group.color }} />}
          <span className="truncate text-[12px] font-semibold text-ink-muted">{group.name}</span>
        </button>
      )}
      <span className="flex shrink-0 opacity-0 transition-opacity duration-150 group-focus-within/label:opacity-100 group-hover/label:opacity-100">
        <IconButton label={`在 ${group.name} 中新建工作区`} onClick={() => openCreate(group.id)}>
          <Plus size={16} />
        </IconButton>
        <IconButton label={`${group.name} 更多操作`} onClick={(e) => openMenuAt(e.currentTarget, menu())}>
          <DotsThree size={16} />
        </IconButton>
      </span>
    </div>
  )
}

/** 「未分组」标签：固定在最后，不能拖动、不能改名，只当拖放目标 */
export function UngroupedLabel(): React.JSX.Element {
  const [over, setOver] = useState(false)
  return (
    <div
      data-group-label="none"
      onDragOver={(e) => {
        if (!carries(e, DRAG_WS)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!over) setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(e) => {
        setOver(false)
        const wid = e.dataTransfer.getData(DRAG_WS)
        if (!wid) return
        e.preventDefault()
        e.stopPropagation()
        appendWorkspace(wid, null)
      }}
      className={`mt-2 flex h-7 items-center rounded-control pl-5 transition-colors duration-150 ${over ? 'bg-accent-soft' : ''}`}
    >
      <span className="truncate text-[12px] font-semibold text-ink-muted">未分组</span>
    </div>
  )
}
