import { useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { create } from 'zustand'
import { useOverlay } from '../lib/useOverlay'
import { errorText } from '../lib/errors'
import { Button, IconButton } from './ui'

type PromptRequest = {
  title: string
  label: string
  initial: string
  maxLength: number
  /** 返回 Promise 时等它完成再关；抛错则留在对话框里显示原因 */
  onSubmit: (value: string) => void | Promise<void>
}

type PromptState = {
  open: PromptRequest | null
  show: (req: PromptRequest) => void
  hide: () => void
}

/** 单行输入对话框（Electron 没有 window.prompt）。全局只有一个，任何组件调 openPrompt 打开 */
const usePrompt = create<PromptState>((set) => ({
  open: null,
  show: (req) => set({ open: req }),
  hide: () => set({ open: null })
}))

export function openPrompt(req: Omit<PromptRequest, 'maxLength' | 'initial'> & { initial?: string; maxLength?: number }): void {
  usePrompt.getState().show({ initial: '', maxLength: 80, ...req })
}

const FIELD =
  'h-9 w-full rounded-control border border-line bg-card px-3 text-[13px] text-ink-strong outline-none transition-colors duration-150 focus:border-accent'

export function PromptHost(): React.JSX.Element | null {
  const open = usePrompt((s) => s.open)
  const hide = usePrompt((s) => s.hide)
  if (!open) return null
  // key：连续打开两次也重置输入框
  return <PromptPanel key={`${open.title}-${open.initial}`} req={open} onClose={hide} />
}

function PromptPanel({ req, onClose }: { req: PromptRequest; onClose: () => void }): React.JSX.Element {
  const [value, setValue] = useState(req.initial)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useOverlay(panelRef, onClose)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const v = value.trim()
    if (!v) {
      setError('不能为空')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await req.onSubmit(v)
      onClose()
    } catch (err) {
      setError(errorText(err))
      setSaving(false)
    }
  }

  return (
    <div className="dialog-backdrop fixed inset-0 z-40 grid place-items-center" onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-title"
        className="w-[400px] max-w-[calc(100vw-48px)] rounded-card border border-line bg-card shadow-[var(--shadow-float)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 items-center justify-between border-b border-line px-5">
          <h2 id="prompt-title" className="font-display text-[15px] font-bold text-ink-strong">
            {req.title}
          </h2>
          <IconButton label="关闭" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <form className="flex flex-col gap-4 p-5" onSubmit={(e) => void submit(e)}>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-ink-muted">{req.label}</span>
            <input
              ref={inputRef}
              data-testid="prompt-input"
              className={FIELD}
              value={value}
              maxLength={req.maxLength}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="text-[13px] text-fault">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={saving}>
              {saving ? '保存中…' : '确定'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
