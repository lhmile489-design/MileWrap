import { useEffect, useRef, useState } from 'react'
import { CaretDown, CaretUp, X } from '@phosphor-icons/react'
import { useUi } from '../store/ui'
import { terminals } from '../terminal/TerminalRegistry'
import { IconButton } from './ui'

/**
 * 终端内搜索条（PRD T-12，Ctrl+Shift+F）：在该会话的滚动缓冲区里找，找到时选中匹配。
 * 回车下一个，Shift+回车上一个，Esc 关闭并把键盘还给终端。不区分大小写。
 */
export function TerminalSearch({ index, sessionId }: { index: number; sessionId: string }): React.JSX.Element | null {
  const open = useUi((s) => s.searchCell === index)
  const setSearchCell = useUi((s) => s.setSearchCell)
  const [query, setQuery] = useState('')
  const [missed, setMissed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  if (!open) return null

  const find = (backwards: boolean): void => {
    if (!query) return
    setMissed(!terminals.find(sessionId, query, backwards))
  }
  const close = (): void => {
    terminals.clearFind(sessionId)
    setSearchCell(null)
    terminals.focus(sessionId)
  }

  return (
    <div
      role="search"
      data-search-cell={index}
      className="absolute top-12 right-3 z-10 flex h-9 items-center gap-1 rounded-control border border-line bg-card pr-1 pl-2 shadow-[var(--shadow-float)]"
    >
      <input
        ref={inputRef}
        aria-label="在终端中搜索"
        data-testid="terminal-search-input"
        placeholder="搜索…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setMissed(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            find(e.shiftKey)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
        }}
        className="h-7 w-44 bg-transparent text-[13px] text-ink-strong outline-none placeholder:text-ink-faint"
      />
      {missed && (
        <span role="status" className="shrink-0 text-[12px] text-fault">
          无匹配
        </span>
      )}
      <IconButton label="上一个（Shift+回车）" onClick={() => find(true)}>
        <CaretUp size={16} />
      </IconButton>
      <IconButton label="下一个（回车）" onClick={() => find(false)}>
        <CaretDown size={16} />
      </IconButton>
      <IconButton label="关闭搜索（Esc）" onClick={close}>
        <X size={16} />
      </IconButton>
    </div>
  )
}
