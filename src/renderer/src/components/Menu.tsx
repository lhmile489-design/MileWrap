import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'

export type MenuItem =
  | {
      kind?: 'item'
      label: string
      icon?: React.ReactNode
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
    }
  | { kind: 'separator' }

type MenuState = {
  open: { x: number; y: number; items: MenuItem[] } | null
  show: (x: number, y: number, items: MenuItem[]) => void
  hide: () => void
}

/** 右键菜单（UI设计约束 §4.5）：全局只有一个，任何组件调 openMenu 打开 */
export const useMenu = create<MenuState>((set) => ({
  open: null,
  show: (x, y, items) => set({ open: { x, y, items } }),
  hide: () => set({ open: null })
}))

export function openMenu(e: React.MouseEvent, items: MenuItem[]): void {
  e.preventDefault()
  e.stopPropagation()
  useMenu.getState().show(e.clientX, e.clientY, items)
}

/** 从按钮打开（「⋯」按钮、键盘触发）：贴着按钮左下角，不依赖鼠标坐标 */
export function openMenuAt(el: HTMLElement, items: MenuItem[]): void {
  const r = el.getBoundingClientRect()
  useMenu.getState().show(r.left, r.bottom + 4, items)
}

const EDGE = 8

export function MenuHost(): React.JSX.Element | null {
  const open = useMenu((s) => s.open)
  const hide = useMenu((s) => s.hide)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // 先渲染再测量：贴近窗口右/下边缘时翻到鼠标另一侧
  useLayoutEffect(() => {
    if (!open || !ref.current) {
      setPos(null)
      return
    }
    const r = ref.current.getBoundingClientRect()
    const left = open.x + r.width + EDGE > window.innerWidth ? Math.max(EDGE, open.x - r.width) : open.x
    const top = open.y + r.height + EDGE > window.innerHeight ? Math.max(EDGE, open.y - r.height) : open.y
    setPos({ left, top })
  }, [open])

  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLButtonElement>('button:not([disabled])')
    first?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        hide()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
      if (items.length === 0) return
      const i = items.indexOf(document.activeElement as HTMLButtonElement)
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
      items[next].focus()
    }
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) hide()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('blur', hide)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
      if (prev && document.contains(prev)) prev.focus()
    }
  }, [open, hide])

  if (!open) return null
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[200px] rounded-control border border-line bg-card py-1 shadow-[var(--shadow-float)]"
      style={{ left: pos?.left ?? open.x, top: pos?.top ?? open.y, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {open.items.map((item, i) =>
        item.kind === 'separator' ? (
          <div key={`sep-${i}`} role="separator" className="my-1 h-px bg-line" />
        ) : (
          <button
            key={`${item.label}-${i}`}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              hide()
              item.onSelect()
            }}
            className={`flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] outline-none transition-colors duration-150 hover:bg-raised focus-visible:bg-raised disabled:text-ink-faint ${
              item.danger ? 'text-fault' : 'text-ink-strong'
            }`}
          >
            <span className="grid size-4 shrink-0 place-items-center">{item.icon}</span>
            <span className="truncate">{item.label}</span>
          </button>
        )
      )}
    </div>
  )
}
