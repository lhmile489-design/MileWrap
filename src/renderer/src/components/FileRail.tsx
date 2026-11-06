import { memo, useEffect, useRef, useState } from 'react'
import { ArrowClockwise, ArrowSquareOut, CaretLineLeft, CaretRight } from '@phosphor-icons/react'
import type { FileEntry } from '@shared/types'
import { useBranches } from '../store/branches'
import { MARK_LABEL, useGitMarks } from '../store/gitMarks'
import { useConfig } from '../store/config'
import { EMPTY_TREE, joinRel, useFileTree } from '../store/fileTree'
import { usePreview } from '../store/preview'
import { PreviewEye } from './previewIcons'
import { LAYOUT_LIMITS } from '@shared/types'
import { CELL_COUNT, railsOf, useLayout } from '../store/layout'
import { useSessions } from '../store/sessions'
import { fileIcon, isDimmed } from '../lib/fileIcons'
import { notifyError } from './ConfirmDialog'
import { openMenu } from './Menu'
import { fileMenu } from './fileActions'
import { beginFileDrag } from './rail/drag'
import { RailResizer } from './Splitter'
import { IconButton } from './ui'

/** 改动标记颜色：与 Git 栏徽标同一套信号色；字母本身就是文字，不只靠颜色 */
const MARK_TONE = { M: 'text-warn', A: 'text-live', D: 'text-fault', R: 'text-accent', U: 'text-idle', '!': 'text-fault' } as const

function lastSegment(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function parentRel(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

/**
 * 目录栏（UI设计约束 §4.1.1，PRD D-01–D-07）：当前选中工作区目录的只读文件树。
 * 懒加载，每层一次 fs:listDir。已展开的层级非递归 watch，有变化只提示「有更新」，点刷新才重读（升级建议 3.7）。
 * 越界校验全在主进程。
 */
export function FileRail(): React.JSX.Element | null {
  const visible = useLayout((s) => railsOf(s).fileShown)
  const width = useLayout((s) => s.fileRailWidth)
  const setRailWidth = useLayout((s) => s.setRailWidth)
  const toggleFileRail = useLayout((s) => s.toggleFileRail)
  const workspaceId = useSessions((s) => s.selectedWorkspaceId)
  const workspace = useConfig((s) => s.config?.workspaces.find((w) => w.id === workspaceId))
  // 上下文行的会话序号：聚焦格里的会话属于这个工作区时取它，否则取该工作区第一个可见的会话
  const cells = useLayout((s) => s.cells)
  const focusedCell = useLayout((s) => s.focused)
  const gridMode = useLayout((s) => s.gridMode)
  const sessions = useSessions((s) => s.sessions)
  const indexIn = (id: string | null): number | null => {
    const s = id ? sessions.find((x) => x.id === id) : undefined
    return s && s.workspaceId === workspaceId ? s.index : null
  }
  let sessionIndex = indexIn(cells[focusedCell])
  for (let i = 0; sessionIndex === null && i < CELL_COUNT[gridMode]; i++) sessionIndex = indexIn(cells[i])
  const load = useFileTree((s) => s.load)
  const refresh = useFileTree((s) => s.refresh)
  const refreshBranch = useBranches((s) => s.refresh)

  // 切到一个还没读过的工作区：读根目录
  const id = workspace?.id
  const rootLoaded = useFileTree((s) => Boolean(id && s.trees[id]?.dirs['']))
  useEffect(() => {
    if (visible && id && !rootLoaded) void load(id, '')
  }, [visible, id, rootLoaded, load])

  // 已展开的目录拼成字符串：选择器只返回原始值（数组每次是新引用，会无限重渲染）
  const openKey = useFileTree((s) => {
    const t = id ? s.trees[id] : undefined
    return t ? Object.keys(t.open).filter((k) => t.open[k]).sort().join('\n') : ''
  })
  // 目录栏改动标记（Git管理-PRD G-18）：总开关打开时切到工作区读一次；Git 栏开着时由它刷新后写入
  const gitEnabled = useConfig((s) => s.config?.settings.gitEnabled === true)
  useEffect(() => {
    if (!id) return
    if (gitEnabled && visible) void useGitMarks.getState().load(id)
    else if (!gitEnabled) useGitMarks.getState().clear(id)
  }, [id, gitEnabled, visible])
  const stale = useFileTree((s) => Boolean(id && s.stale[id]))
  useEffect(() => {
    if (!visible || !id) return
    void window.warp.fs.watch(id, openKey ? openKey.split('\n') : ['']).catch(() => undefined)
    return () => {
      void window.warp.fs.watch(id, []).catch(() => undefined)
    }
  }, [visible, id, openKey])

  if (!visible) return null

  return (
    <aside
      aria-label="目录栏"
      data-rail="files"
      style={{ '--rail-w': `${width}px` } as React.CSSProperties}
      className="relative flex w-[var(--rail-w)] shrink-0 flex-col border-r border-line bg-panel"
    >
      <RailResizer
        label="调整目录栏宽度"
        width={width}
        min={LAYOUT_LIMITS.fileRail.min}
        max={LAYOUT_LIMITS.fileRail.max}
        onResize={(px) => setRailWidth('file', px)}
        testId="resize-file-rail"
      />
      <div className="flex h-9 shrink-0 items-center gap-1 pr-1 pl-2">
        <div role="tablist" aria-label="目录栏页签" className="flex min-w-0 flex-1">
          <span role="tab" aria-selected="true" className="rounded-control bg-raised px-2 py-0.5 text-[12px] font-semibold text-ink-strong">
            文件
          </span>
        </div>
        {stale && (
          <span
            role="status"
            data-testid="file-rail-stale"
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-pill bg-accent-soft px-2 text-[12px] font-semibold text-ink-strong"
          >
            <span aria-hidden="true" className="size-1.5 rounded-pill bg-accent" />
            有更新
          </span>
        )}
        <IconButton
          label={stale ? '刷新（目录有更新）' : '刷新'}
          disabled={!workspace}
          onClick={() => {
            if (!workspace) return
            refresh(workspace.id)
            refreshBranch(workspace.id)
            if (gitEnabled) void useGitMarks.getState().load(workspace.id, true)
          }}
        >
          <ArrowClockwise size={16} />
        </IconButton>
        <IconButton
          label="在资源管理器中打开"
          disabled={!workspace}
          onClick={() => workspace && void window.warp.shell.openPath(workspace.id).catch((e: unknown) => notifyError(e, '打开失败'))}
        >
          <ArrowSquareOut size={16} />
        </IconButton>
        <IconButton label="收起目录栏" onClick={toggleFileRail}>
          <CaretLineLeft size={16} />
        </IconButton>
      </div>

      {!workspace ? (
        <p className="px-3 pt-3 text-[12px] text-ink-muted">在左侧选择一个工作区，这里显示它的目录。</p>
      ) : (
        <>
          <div className="flex h-7 shrink-0 items-center px-3" title={workspace.cwd} data-testid="file-rail-context">
            <span className="truncate text-[12px] text-ink-muted">
              {workspace.name}
              {sessionIndex !== null ? ` · #${sessionIndex}` : ''}
            </span>
          </div>
          <Tree workspaceId={workspace.id} rootName={lastSegment(workspace.cwd)} />
        </>
      )}
    </aside>
  )
}

/** 大目录分批渲染：每层先画这么多，其余点「显示其余」再按批追加（主进程每层最多给 2000 项） */
const PAGE = 300

function Tree({ workspaceId, rootName }: { workspaceId: string; rootName: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const setOpen = useFileTree((s) => s.setOpen)
  const select = useFileTree((s) => s.select)

  /** 方向键导航（WAI-ARIA tree 模式）：上下移动，右展开 / 进子级，左收起 / 回父级 */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])]
    const cur = document.activeElement as HTMLElement | null
    const i = cur ? items.indexOf(cur) : -1
    if (i < 0) return
    const rel = cur?.dataset.rel ?? ''
    const isDir = cur?.dataset.kind === 'dir'
    const isOpen = cur?.getAttribute('aria-expanded') === 'true'
    const focusAt = (j: number): void => {
      const el = items[j]
      if (!el) return
      select(workspaceId, el.dataset.rel ?? '')
      el.focus()
    }
    switch (e.key) {
      case 'ArrowDown':
        focusAt(Math.min(items.length - 1, i + 1))
        break
      case 'ArrowUp':
        focusAt(Math.max(0, i - 1))
        break
      case 'ArrowRight':
        if (isDir && !isOpen) setOpen(workspaceId, rel, true)
        else if (isDir) focusAt(i + 1)
        break
      case 'ArrowLeft':
        if (isDir && isOpen) setOpen(workspaceId, rel, false)
        else if (rel) focusAt(items.findIndex((x) => x.dataset.rel === parentRel(rel)))
        break
      case 'Home':
        focusAt(0)
        break
      case 'End':
        focusAt(items.length - 1)
        break
      default:
        return
    }
    e.preventDefault()
  }

  return (
    <div ref={ref} role="tree" aria-label="文件" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" onKeyDown={onKeyDown}>
      <Node workspaceId={workspaceId} rel="" name={rootName} kind="dir" link={false} depth={0} />
    </div>
  )
}

type NodeProps = {
  workspaceId: string
  rel: string
  name: string
  kind: FileEntry['kind']
  link: boolean
  depth: number
}

/**
 * 树节点只订阅跟自己有关的几个布尔值（是否展开 / 选中 / 可聚焦），再配合 memo：
 * 点选、展开某一项时只有状态真正变了的节点重渲染，而不是整棵树（2000 项的目录点一下也不卡）
 */
const Node = memo(function Node({ workspaceId, rel, name, kind, link, depth }: NodeProps): React.JSX.Element {
  const toggle = useFileTree((s) => s.toggle)
  const select = useFileTree((s) => s.select)
  const isDir = kind === 'dir' && !link
  const open = useFileTree((s) => isDir && Boolean((s.trees[workspaceId] ?? EMPTY_TREE).open[rel]))
  const selected = useFileTree((s) => (s.trees[workspaceId]?.selected ?? null) === rel)
  // 键盘焦点所在节点：选中的节点，没有就是根
  const focusable = useFileTree((s) => (s.trees[workspaceId]?.selected ?? '') === rel)
  // 正在预览的文件：左侧强调线 + Eye（不只靠颜色，UI设计约束 §6）
  const previewing = usePreview((s) => s.target !== null && s.target.workspaceId === workspaceId && s.target.rel === rel)
  const root = rel === ''
  // 改动标记：文件按路径标；目录不汇总，但整个未跟踪的目录 git 只报一条 `dir/`，键就是目录本身，照样标 U
  const mark = useGitMarks((s) => (root ? undefined : s.marks[workspaceId]?.[rel]))
  const Icon = fileIcon(name, kind, open, link)
  const dimmed = isDimmed(name)

  return (
    <div role="none">
      <div
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={isDir ? open : undefined}
        aria-selected={selected}
        tabIndex={focusable ? 0 : -1}
        data-rel={rel}
        data-kind={isDir ? 'dir' : kind === 'dir' ? 'link' : 'file'}
        title={link ? `${name}：链接指向工作区目录之外，不展开` : name}
        onClick={() => {
          select(workspaceId, rel)
          if (isDir) toggle(workspaceId, rel)
          else if (!link) usePreview.getState().open({ workspaceId, rel, name })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            select(workspaceId, rel)
            if (isDir) toggle(workspaceId, rel)
            else if (!link) usePreview.getState().open({ workspaceId, rel, name })
          }
        }}
        draggable={!root}
        onDragStart={(e) => beginFileDrag(e, workspaceId, rel)}
        onContextMenu={(e) => {
          select(workspaceId, rel)
          openMenu(e, fileMenu(workspaceId, rel))
        }}
        style={{ '--depth': depth } as React.CSSProperties}
        className={`flex h-7 items-center gap-1 rounded-control pr-2 pl-[calc(4px+var(--depth)*14px)] outline-none transition-colors duration-150 focus-visible:outline-3 focus-visible:outline-offset-[-3px] focus-visible:outline-accent ${
          selected ? 'bg-accent-soft text-ink-strong' : root ? 'bg-raised text-ink-strong hover:bg-raised' : 'text-ink hover:bg-raised'
        } ${previewing ? 'shadow-[inset_2px_0_0_0_var(--color-accent)]' : ''}`}
      >
        {isDir ? (
          <CaretRight size={16} aria-hidden="true" className={`shrink-0 text-ink-faint transition-transform duration-200 ease-spring ${open ? 'rotate-90' : ''}`} />
        ) : (
          <span aria-hidden="true" className="w-4 shrink-0" />
        )}
        <Icon size={16} aria-hidden="true" className={`shrink-0 ${dimmed || link ? 'text-ink-faint' : 'text-ink-muted'}`} />
        <span className={`truncate text-[13px] ${root ? 'font-semibold' : ''} ${dimmed || link ? 'text-ink-faint' : ''}`}>{name}</span>
        {previewing && <PreviewEye size={16} aria-hidden="true" className="ml-auto shrink-0 text-accent" />}
        {mark && (
          <span
            role="img"
            aria-label={`Git：${MARK_LABEL[mark]}`}
            title={`Git：${MARK_LABEL[mark]}`}
            data-git-mark={mark}
            className={`${previewing ? '' : 'ml-auto'} shrink-0 font-mono text-[12px] font-bold ${MARK_TONE[mark]}`}
          >
            {mark}
          </span>
        )}
      </div>
      {open && <Children workspaceId={workspaceId} rel={rel} depth={depth + 1} />}
    </div>
  )
})

function Children({ workspaceId, rel, depth }: { workspaceId: string; rel: string; depth: number }): React.JSX.Element {
  const load = useFileTree((s) => s.load)
  const d = useFileTree((s) => s.trees[workspaceId]?.dirs[rel])
  const [limit, setLimit] = useState(PAGE)
  const indent = { '--depth': depth } as React.CSSProperties
  const pad = 'pl-[calc(24px+var(--depth)*14px)]'

  if (!d || d.status === 'loading') {
    return (
      <div role="group" aria-busy="true" aria-label="加载中" className={`flex flex-col gap-2 py-2 pr-3 ${pad}`} style={indent}>
        <span className="h-3 w-3/4 animate-pulse rounded-pill bg-raised motion-reduce:animate-none" />
        <span className="h-3 w-1/2 animate-pulse rounded-pill bg-raised motion-reduce:animate-none" />
      </div>
    )
  }
  if (d.status === 'error') {
    return (
      <div role="group" className={`flex flex-col items-start gap-1 py-1.5 pr-2 ${pad}`} style={indent} data-testid="file-rail-error">
        <span role="alert" className="text-[12px] text-fault">
          {d.message}
        </span>
        <button type="button" onClick={() => void load(workspaceId, rel)} className="text-[12px] font-semibold text-accent hover:underline">
          重试
        </button>
      </div>
    )
  }
  if (d.entries.length === 0) {
    return (
      <div role="group" className={`py-1 text-[12px] text-ink-faint ${pad}`} style={indent}>
        空目录
      </div>
    )
  }
  const rest = d.entries.length - limit
  return (
    <div role="group">
      {d.entries.slice(0, limit).map((e) => (
        <Node key={e.name} workspaceId={workspaceId} rel={joinRel(rel, e.name)} name={e.name} kind={e.kind} link={e.link} depth={depth} />
      ))}
      {rest > 0 && (
        <div className={`py-1 pr-2 ${pad}`} style={indent}>
          <button
            type="button"
            data-show-more={rel}
            onClick={() => setLimit((n) => n + PAGE)}
            className="text-[12px] font-semibold text-accent hover:underline"
          >
            {rest > PAGE ? `再显示 ${PAGE} 项（还有 ${rest} 项）` : `显示其余 ${rest} 项`}
          </button>
        </div>
      )}
    </div>
  )
}
