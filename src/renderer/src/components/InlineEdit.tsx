import { useEffect, useRef, useState } from 'react'

/**
 * 行内改名（PRD §5「分组重命名 / 会话重命名：行内编辑」）。
 * 回车或失焦提交，Esc 取消；值没变或为空时按取消处理。提交失败由调用方提示。
 */
export function InlineEdit({
  initial,
  label,
  maxLength = 80,
  className = '',
  onCommit,
  onCancel
}: {
  initial: string
  label: string
  maxLength?: number
  className?: string
  onCommit: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const finish = (commit: boolean): void => {
    if (done.current) return
    done.current = true
    const v = value.trim()
    if (commit && v && v !== initial) onCommit(v)
    else onCancel()
  }

  return (
    <input
      ref={ref}
      aria-label={label}
      data-testid="inline-edit"
      value={value}
      maxLength={maxLength}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(false)
        }
      }}
      className={`h-6 min-w-0 flex-1 rounded-control border border-accent bg-card px-1.5 text-ink-strong outline-none ${className}`}
    />
  )
}
