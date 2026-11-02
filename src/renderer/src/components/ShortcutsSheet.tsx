import { useRef } from 'react'
import { X } from '@phosphor-icons/react'
import { useUi } from '../store/ui'
import { SHORTCUTS } from '../lib/shortcuts'
import { useOverlay } from '../lib/useOverlay'
import { IconButton } from './ui'

/** 快捷键速查浮层（升级建议 3.6）：Ctrl+/ 打开，Esc 或点遮罩关闭；内容与设置 → 关于页一致 */
export function ShortcutsSheet(): React.JSX.Element | null {
  const open = useUi((s) => s.shortcutsOpen)
  if (!open) return null
  return <Sheet />
}

function Sheet(): React.JSX.Element {
  const close = (): void => useUi.getState().setShortcutsOpen(false)
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlay(panelRef, close)
  return (
    <div className="dialog-backdrop fixed inset-0 z-40 grid place-items-center" onMouseDown={close}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        data-testid="shortcuts-sheet"
        className="flex w-[480px] max-w-[calc(100vw-48px)] flex-col rounded-card border border-line bg-card shadow-[var(--shadow-float)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-5">
          <h2 id="shortcuts-title" className="font-display text-[15px] font-bold text-ink-strong">
            快捷键
          </h2>
          <IconButton label="关闭" onClick={close}>
            <X size={16} />
          </IconButton>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 p-5 text-[13px]">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-ink-strong">{k}</dt>
              <dd className="text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
