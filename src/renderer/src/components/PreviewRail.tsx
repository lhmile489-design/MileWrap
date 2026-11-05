import { Suspense, lazy, memo } from 'react'
import { ArrowSquareOut, X } from '@phosphor-icons/react'
import { PreviewCode, PreviewFileX, PreviewWarningCircle } from './previewIcons'
import { LAYOUT_LIMITS, type RightRailTab } from '@shared/types'
import { useConfig } from '../store/config'
import { isMarkdown, usePreview } from '../store/preview'
import { railsOf, useLayout } from '../store/layout'
import { fileIcon } from '../lib/fileIcons'
import { notifyError } from './ConfirmDialog'
import { RailResizer } from './Splitter'
import { IconButton } from './ui'

/** Markdown 渲染按需加载：marked + sanitizer 都在这个 chunk 里，不进首屏 */
const MarkdownView = lazy(() => import('./preview/MarkdownView').then((m) => ({ default: m.MarkdownView })))
/** Git 栏整包按需加载（store/git + 组件），不进首屏（Git管理-PRD §8） */
const GitPanel = lazy(() => import('./git/GitPanel').then((m) => ({ default: m.GitPanel })))

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/**
 * 文件预览栏（目录栏右侧，UI设计约束 §4.1.2）：单击文件就地预览。
 * md / mdx / markdown 渲染成 HTML；png/jpg/gif/webp/bmp/ico 出缩放图；其余文本等宽显示；
 * 二进制与不支持的类型给占位 + 「在资源管理器中显示」。预览目标不持久化，切工作区清空。
 */
export function PreviewRail(): React.JSX.Element | null {
  const visible = useLayout((s) => railsOf(s).previewShown)
  const width = useLayout((s) => s.previewRailWidth)
  const setRailWidth = useLayout((s) => s.setRailWidth)
  const togglePreviewRail = useLayout((s) => s.togglePreviewRail)
  const tab = useLayout((s) => s.rightRailTab)
  const gitEnabled = useConfig((s) => s.config?.settings.gitEnabled === true)
  const target = usePreview((s) => s.target)

  if (!visible) return null
  // Git 关着时右栏就是原来的预览栏，没有页签条（Git管理-PRD §4.1）
  const showGit = gitEnabled && tab === 'git'

  return (
    <aside
      aria-label={showGit ? 'Git' : '文件预览'}
      data-rail="preview"
      data-right-tab={showGit ? 'git' : 'preview'}
      style={{ '--rail-w': `${width}px` } as React.CSSProperties}
      className="relative flex w-[var(--rail-w)] shrink-0 flex-col border-l border-line bg-panel"
    >
      <RailResizer
        label="调整预览栏宽度"
        width={width}
        min={LAYOUT_LIMITS.previewRail.min}
        max={LAYOUT_LIMITS.previewRail.max}
        onResize={(px) => setRailWidth('preview', px)}
        side="left"
        testId="resize-preview-rail"
      />
      {gitEnabled && <TabStrip tab={showGit ? 'git' : 'preview'} onClose={togglePreviewRail} />}
      {showGit ? (
        <Suspense fallback={<p className="px-3 pt-3 text-[12px] text-ink-muted">加载中…</p>}>
          <GitPanel />
        </Suspense>
      ) : (
        <>
          <Header target={target} onClose={gitEnabled ? undefined : togglePreviewRail} />
          <Body />
        </>
      )}
    </aside>
  )
}

/** 右栏页签条：预览 / Git，方向键在两项之间切换；关闭按钮收起整个右栏 */
function TabStrip({ tab, onClose }: { tab: RightRailTab; onClose: () => void }): React.JSX.Element {
  const showRightTab = useLayout((s) => s.showRightTab)
  const tabs: { id: RightRailTab; label: string }[] = [
    { id: 'preview', label: '预览' },
    { id: 'git', label: 'Git' }
  ]
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next = tab === 'preview' ? 'git' : 'preview'
    showRightTab(next)
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-right-tab-btn="${next}"]`)?.focus())
  }
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line pr-1 pl-2">
      <div role="tablist" aria-label="右栏" className="flex min-w-0 flex-1 items-center gap-0.5" onKeyDown={onKey}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            tabIndex={t.id === tab ? 0 : -1}
            data-right-tab-btn={t.id}
            onClick={() => showRightTab(t.id)}
            className={`h-7 rounded-control px-2.5 text-[12px] transition-colors duration-150 ${
              t.id === tab ? 'bg-raised font-semibold text-ink-strong' : 'text-ink-muted hover:bg-raised hover:text-ink-strong'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <IconButton label="关闭右栏" onClick={onClose}>
        <X size={16} />
      </IconButton>
    </div>
  )
}

function Header({ target, onClose }: { target: { workspaceId: string; rel: string; name: string } | null; onClose?: () => void }): React.JSX.Element {
  const openEditor = (): void => {
    if (!target) return
    void window.warp.fs
      .openInEditor(target.workspaceId, target.rel)
      .then((r) => {
        if (r === 'reveal') return window.warp.fs.reveal(target.workspaceId, target.rel)
      })
      .catch((e: unknown) => notifyError(e, '打开失败'))
  }
  const reveal = (): void => {
    if (!target) return
    void window.warp.fs.reveal(target.workspaceId, target.rel).catch((e: unknown) => notifyError(e, '打开失败'))
  }
  const Icon = target ? fileIcon(target.name, 'file', false, false) : PreviewCode

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 pr-1 pl-2">
      <Icon size={16} aria-hidden="true" className="shrink-0 text-ink-muted" />
      <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-ink-strong" title={target?.rel ?? ''}>
        {target?.name ?? '预览'}
      </span>
      <IconButton label="在编辑器中打开" disabled={!target} onClick={openEditor}>
        <PreviewCode size={16} />
      </IconButton>
      <IconButton label="在资源管理器中显示" disabled={!target} onClick={reveal}>
        <ArrowSquareOut size={16} />
      </IconButton>
      {onClose && (
        <IconButton label="关闭预览栏" onClick={onClose}>
          <X size={16} />
        </IconButton>
      )}
    </div>
  )
}

function Body(): React.JSX.Element {
  const target = usePreview((s) => s.target)
  const result = usePreview((s) => s.result)
  const error = usePreview((s) => s.error)

  if (!target) {
    return <p className="px-3 pt-3 text-[12px] text-ink-muted">单击左侧目录里的文件，在这里预览。</p>
  }
  if (error) {
    return (
      <div className="flex flex-col items-start gap-2 px-3 pt-3" data-testid="preview-error">
        <span role="alert" className="flex items-center gap-1.5 text-[12px] text-fault">
          <PreviewWarningCircle size={16} aria-hidden="true" />
          {error}
        </span>
      </div>
    )
  }
  if (!result) {
    return (
      <div className="flex flex-col gap-2 px-3 pt-3" aria-busy="true" aria-label="加载中">
        <span className="h-3 w-3/4 animate-pulse rounded-pill bg-raised motion-reduce:animate-none" />
        <span className="h-3 w-1/2 animate-pulse rounded-pill bg-raised motion-reduce:animate-none" />
        <span className="h-3 w-2/3 animate-pulse rounded-pill bg-raised motion-reduce:animate-none" />
      </div>
    )
  }

  if (result.kind === 'image') {
    const { data } = result
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pt-3 pb-3" data-testid="preview-image">
        <img src={data.dataUrl} width={data.width} height={data.height} alt={target.name} className="max-w-full rounded-card border border-line" />
        <Meta size={data.size} mtime={data.mtime} extra={`${data.width} × ${data.height}`} />
      </div>
    )
  }

  const { data } = result
  if (data.binary) {
    return (
      <div className="flex flex-col items-start gap-2 px-3 pt-3" data-testid="preview-binary">
        <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
          <PreviewFileX size={16} aria-hidden="true" />
          二进制文件，不做预览
        </span>
        <Meta size={data.size} mtime={data.mtime} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isMarkdown(target.name) ? (
        <Suspense fallback={<TextView content={data.content} />}>
          <MarkdownView workspaceId={target.workspaceId} rel={target.rel} content={data.content} />
        </Suspense>
      ) : (
        <TextView content={data.content} />
      )}
      <Meta size={data.size} mtime={data.mtime} extra={data.truncated ? '内容过大，已截断' : undefined} />
    </div>
  )
}

/** 文本 / 代码视图：等宽，保持原始换行与缩进 */
const TextView = memo(function TextView({ content }: { content: string }): React.JSX.Element {
  return (
    <pre
      className="min-h-0 flex-1 overflow-auto px-3 pt-2 pb-2 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap wrap-anywhere text-ink"
      data-testid="preview-text"
    >
      {content}
    </pre>
  )
})

function Meta({ size, mtime, extra }: { size: number; mtime: number; extra?: string }): React.JSX.Element {
  const time = mtime ? new Date(mtime).toLocaleString() : ''
  return (
    <p className="shrink-0 border-t border-line px-3 py-1.5 text-[12px] text-ink-faint" data-testid="preview-meta">
      {extra ? `${extra} · ` : ''}
      {formatSize(size)}
      {time ? ` · ${time}` : ''}
    </p>
  )
}
