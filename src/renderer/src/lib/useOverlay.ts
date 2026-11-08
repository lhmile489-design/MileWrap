import { useEffect, useRef } from 'react'

/** 打开中的浮层栈：Esc 只关最上层（UI设计约束 §4.5） */
const stack: symbol[] = []

/** 有浮层打开（应用级 Esc 等全局快捷键要让位给最上层浮层） */
export function overlayOpen(): boolean {
  return stack.length > 0
}

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * 对话框统一行为：Esc 关闭（只关最上层）、Tab 焦点陷阱、关闭后还焦点。
 * onClose 用 ref 持有，调用方不必 useCallback。
 */
export function useOverlay(panelRef: React.RefObject<HTMLElement | null>, onClose: () => void): void {
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const token = Symbol('overlay')
    stack.push(token)
    const prev = document.activeElement as HTMLElement | null

    const onKey = (e: KeyboardEvent): void => {
      if (stack[stack.length - 1] !== token) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      const i = stack.indexOf(token)
      if (i >= 0) stack.splice(i, 1)
      if (prev && document.contains(prev)) prev.focus()
    }
  }, [panelRef])
}
