import { useEffect, useRef, useState } from 'react'
import { ArrowLineDown, Power } from '@phosphor-icons/react'
import { create } from 'zustand'
import type { SessionMeta } from '@shared/types'
import { useConfig } from '../store/config'
import { useOverlay } from '../lib/useOverlay'
import { errorText } from '../lib/errors'
import { Button, SessionIcon } from './ui'

/** 主进程发来的「关闭窗口但还有运行中会话」请求 */
export const useQuitRequest = create<{ live: SessionMeta[] | null; show: (live: SessionMeta[]) => void; hide: () => void }>((set) => ({
  live: null,
  show: (live) => set({ live }),
  hide: () => set({ live: null })
}))

/**
 * 关闭确认（PRD S-05，技术设计 §5.7）：列出运行中的会话，给「最小化到托盘」与「全部结束并退出」。
 * 两种方式主进程都会先写会话快照。勾选「下次不再询问」则写入设置 closeAction。
 */
export function QuitDialog(): React.JSX.Element | null {
  const live = useQuitRequest((s) => s.live)
  const hide = useQuitRequest((s) => s.hide)
  if (!live) return null
  return <QuitPanel live={live} onClose={hide} />
}

function QuitPanel({ live, onClose }: { live: SessionMeta[]; onClose: () => void }): React.JSX.Element {
  const updateSettings = useConfig((s) => s.updateSettings)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState<'tray' | 'quit' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlay(panelRef, onClose)

  useEffect(() => {
    panelRef.current?.querySelector<HTMLButtonElement>('[data-autofocus]')?.focus()
  }, [])

  const choose = async (action: 'tray' | 'quit'): Promise<void> => {
    setBusy(action)
    setError(null)
    try {
      if (remember) await updateSettings({ closeAction: action })
      if (action === 'tray') {
        await window.warp.app.minimizeToTray()
        onClose()
      } else {
        await window.warp.app.quitAll()
      }
    } catch (e) {
      setError(errorText(e))
      setBusy(null)
    }
  }

  return (
    <div className="dialog-backdrop fixed inset-0 z-40 grid place-items-center">
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="quit-title"
        data-testid="quit-dialog"
        className="flex w-[460px] max-w-[calc(100vw-48px)] flex-col gap-4 rounded-card border border-line bg-card p-5 shadow-[var(--shadow-float)]"
      >
        <div>
          <h2 id="quit-title" className="font-display text-[15px] font-bold text-ink-strong">
            还有 {live.length} 个会话在运行
          </h2>
          <p className="mt-1 text-[13px] text-ink-muted">最小化到托盘时会话继续运行；全部结束会关掉这些进程。两种方式都会记下会话，下次打开可以一键恢复。</p>
        </div>
        <ul className="flex max-h-[200px] flex-col gap-1 overflow-y-auto">
          {live.map((s) => (
            <li key={s.id} className="flex items-center gap-2 rounded-control bg-sunken px-2 py-1.5">
              <SessionIcon kind={s.kind} workspaceId={s.workspaceId} agentId={s.agentId} size={20} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink-strong">{s.title}</span>
              <span className="truncate font-mono text-[12px] text-ink-faint" title={s.cwd}>
                {s.cwd.split(/[\\/]+/).filter(Boolean).pop()}
              </span>
            </li>
          ))}
        </ul>
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            data-testid="quit-remember"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="size-4 accent-[var(--signal-accent)]"
          />
          下次不再询问，按这次的选择处理
        </label>
        {error && (
          <p role="alert" className="text-[13px] text-fault">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy !== null} onClick={onClose} testId="quit-cancel">
            取消
          </Button>
          <Button variant="danger" disabled={busy !== null} onClick={() => void choose('quit')} testId="quit-all">
            <Power size={16} />
            {busy === 'quit' ? '正在结束…' : '全部结束并退出'}
          </Button>
          <Button variant="primary" autoFocus disabled={busy !== null} onClick={() => void choose('tray')} testId="quit-tray">
            <ArrowLineDown size={16} />
            最小化到托盘
          </Button>
        </div>
      </div>
    </div>
  )
}
