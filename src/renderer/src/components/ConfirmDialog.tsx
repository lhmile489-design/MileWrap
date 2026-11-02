import { useEffect, useId, useRef } from 'react'
import { Warning } from '@phosphor-icons/react'
import { create } from 'zustand'
import { useOverlay } from '../lib/useOverlay'
import { errorText } from '../lib/errors'
import { Button } from './ui'

/**
 * 应用内确认 / 提示弹窗，替代 window.confirm / window.alert（对齐 Mile Terminal Confirm.tsx）。
 * 原生对话框会阻塞渲染线程，harness 的 executeJavaScript 也会跟着卡住。
 *
 * 用法：`if (!(await confirm({ title, body, danger: true }))) return`
 * 默认焦点在「取消」，回车不会误触危险操作。
 */
export type ConfirmOptions = {
  title: string
  body?: React.ReactNode
  okLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** 第三个按钮（例如「转入后台」）；给了才显示，放在取消和确定之间 */
  altLabel?: string
}

export type Choice = 'ok' | 'alt' | 'cancel'

type Request = ConfirmOptions & {
  id: number
  /** 只有一个按钮的提示框（报错用） */
  single: boolean
  resolve: (choice: Choice) => void
}

let seq = 0
const useConfirmStore = create<{ queue: Request[] }>(() => ({ queue: [] }))

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return choose(opts).then((c) => c === 'ok')
}

/** 三选一：确定 / 第三个按钮（altLabel）/ 取消。Esc 与点遮罩都算取消 */
export function choose(opts: ConfirmOptions): Promise<Choice> {
  return new Promise((resolve) => {
    useConfirmStore.setState((s) => ({ queue: [...s.queue, { ...opts, single: false, id: ++seq, resolve }] }))
  })
}

/** 报错提示：只有「知道了」一个按钮 */
export function notifyError(e: unknown, title = '操作失败'): void {
  useConfirmStore.setState((s) => ({
    queue: [...s.queue, { title, body: errorText(e), okLabel: '知道了', danger: true, single: true, id: ++seq, resolve: () => undefined }]
  }))
}

/** 挂在 App 根部一次 */
export function ConfirmHost(): React.JSX.Element | null {
  const req = useConfirmStore((s) => s.queue[0])
  if (!req) return null
  return <ConfirmPanel key={req.id} req={req} />
}

function ConfirmPanel({ req }: { req: Request }): React.JSX.Element {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const settled = useRef(false)

  const done = (choice: Choice): void => {
    if (settled.current) return
    settled.current = true
    useConfirmStore.setState((s) => ({ queue: s.queue.filter((r) => r.id !== req.id) }))
    req.resolve(choice)
  }
  useOverlay(panelRef, () => done('cancel'))

  useEffect(() => {
    // 默认焦点：确认框在「取消」，提示框在唯一的按钮
    panelRef.current?.querySelector<HTMLButtonElement>('[data-autofocus]')?.focus()
  }, [])

  return (
    <div className="dialog-backdrop fixed inset-0 z-40 grid place-items-center">
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="confirm-dialog"
        className="flex w-[420px] max-w-[calc(100vw-48px)] flex-col gap-4 rounded-card border border-line bg-card p-5 shadow-[var(--shadow-float)]"
      >
        <div className="flex items-center gap-2">
          {req.danger && <Warning size={20} className="shrink-0 text-fault" aria-hidden="true" />}
          <h2 id={titleId} className="font-display text-[15px] font-bold text-ink-strong">
            {req.title}
          </h2>
        </div>
        {req.body != null && <div className="whitespace-pre-line text-[13px] text-ink">{req.body}</div>}
        <div className="flex justify-end gap-2">
          {req.single ? (
            <Button variant="primary" autoFocus onClick={() => done('ok')} testId="confirm-ok">
              {req.okLabel ?? '知道了'}
            </Button>
          ) : (
            <>
              <Button autoFocus onClick={() => done('cancel')} testId="confirm-cancel">
                {req.cancelLabel ?? '取消'}
              </Button>
              {req.altLabel && (
                <Button onClick={() => done('alt')} testId="confirm-alt">
                  {req.altLabel}
                </Button>
              )}
              <Button variant={req.danger ? 'danger' : 'primary'} onClick={() => done('ok')} testId="confirm-ok">
                {req.okLabel ?? '确定'}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
