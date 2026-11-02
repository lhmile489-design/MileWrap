import { useRef } from 'react'
import { ArrowCounterClockwise } from '@phosphor-icons/react'
import { useRestore, wantsResume } from '../store/restore'
import { useConfig } from '../store/config'
import { firstEmptyCell, useLayout } from '../store/layout'
import { useOverlay } from '../lib/useOverlay'
import { agentName } from '../lib/agents'
import { notifyError } from './ConfirmDialog'
import { Button, SessionIcon } from './ui'

/**
 * 「恢复上次的 N 个会话」（UI设计约束 §4.2 空格，PRD S-07 / S-09）。
 * 每行可取消勾选，能续接的可以逐条改成「新开」；不能续接的固定「新开」并说明原因。
 * 恢复 = 重新启动 agent 并续接对话，应用不重放历史输出。
 */
export function RestoreCard(): React.JSX.Element | null {
  const candidates = useRestore((s) => s.candidates)
  const unchecked = useRestore((s) => s.unchecked)
  const fresh = useRestore((s) => s.fresh)
  const busy = useRestore((s) => s.busy)
  const toggleChecked = useRestore((s) => s.toggleChecked)
  const toggleFresh = useRestore((s) => s.toggleFresh)
  const restore = useRestore((s) => s.restore)
  const dismiss = useRestore((s) => s.dismiss)
  // 设置「恢复时续接对话」关掉时，全部按新开
  const allowResume = useConfig((s) => s.config?.settings.resumeConversation ?? true)

  if (candidates.length === 0) return null
  const picked = candidates.filter((c) => !unchecked[c.id]).length

  const run = async (): Promise<void> => {
    const failures = await restore()
    if (failures.length) notifyError(new Error(failures.join('\n')), `有 ${failures.length} 个会话没能恢复`)
  }

  return (
    <section
      aria-labelledby="restore-title"
      data-testid="restore-card"
      className="flex w-full max-w-[440px] flex-col gap-3 rounded-card border border-line bg-card p-5 shadow-[var(--shadow-lift)]"
    >
      <div className="flex items-center gap-2">
        <ArrowCounterClockwise size={20} aria-hidden="true" className="shrink-0 text-accent" />
        <h2 id="restore-title" className="font-display text-[15px] font-bold text-ink-strong">
          恢复上次的 {candidates.length} 个会话
        </h2>
      </div>
      <ul className="flex max-h-[260px] flex-col gap-1 overflow-y-auto">
        {candidates.map((c) => {
          const checked = !unchecked[c.id]
          const resume = wantsResume(c, fresh)
          const note = !c.canResume ? c.resumeNote : !allowResume ? '设置里关闭了续接' : c.resumeNote
          return (
            <li key={c.id} data-restore-row={c.id} className="flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-raised">
              <input
                type="checkbox"
                aria-label={`恢复 ${c.workspaceName} · ${c.title}`}
                checked={checked}
                onChange={() => toggleChecked(c.id)}
                className="size-4 shrink-0 accent-[var(--signal-accent)]"
              />
              <SessionIcon kind={c.kind} workspaceId={c.workspaceId} agentId={c.agentId} size={20} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-ink-strong">
                  {c.title || c.workspaceName}
                  {c.cell !== null && <span className="ml-1.5 text-[12px] font-normal text-ink-faint">第 {c.cell + 1} 格</span>}
                </div>
                <div className="truncate font-mono text-[12px] text-ink-faint" title={c.cwd}>
                  {agentName(c.kind === 'shell' ? 'shell' : c.agentId)} · {c.cwd}
                </div>
              </div>
              <button
                type="button"
                data-restore-mode={resume ? 'resume' : 'fresh'}
                aria-pressed={resume}
                aria-label={`${c.workspaceName}：${resume ? '续接上次对话，点击改为新开' : '新开'}`}
                title={note ?? (resume ? '续接上次对话；点击改为新开' : '点击改为续接')}
                disabled={!c.canResume || !allowResume || !checked}
                onClick={() => toggleFresh(c.id)}
                className={`h-6 shrink-0 rounded-pill border px-2 text-[12px] font-semibold transition-colors duration-150 disabled:cursor-not-allowed ${
                  resume ? 'border-accent text-accent' : 'border-line-strong text-ink-muted'
                }`}
              >
                {resume ? '续接' : '新开'}
              </button>
            </li>
          )
        })}
      </ul>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={() => void dismiss()} testId="restore-dismiss">
          忽略
        </Button>
        <Button variant="primary" disabled={busy || picked === 0} onClick={() => void run()} testId="restore-all">
          {busy ? '恢复中…' : picked === candidates.length ? '全部恢复' : `恢复所选 ${picked} 个`}
        </Button>
      </div>
    </section>
  )
}

/**
 * 所有可见格都占满时，恢复卡片没有空格可放：标题栏出一个入口，点开以对话框形式显示同一张卡片。
 * 候选清空（全部恢复或忽略）后自动关闭。
 */
export function RestoreDialog(): React.JSX.Element | null {
  const open = useRestore((s) => s.dialogOpen)
  const count = useRestore((s) => s.candidates.length)
  const setOpen = useRestore((s) => s.setDialogOpen)
  if (!open || count === 0) return null
  return <RestoreDialogPanel onClose={() => setOpen(false)} />
}

function RestoreDialogPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlay(panelRef, onClose)
  return (
    <div className="dialog-backdrop fixed inset-0 z-40 grid place-items-center" onMouseDown={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="恢复上次的会话" data-testid="restore-dialog" className="w-[440px] max-w-[calc(100vw-48px)]" onMouseDown={(e) => e.stopPropagation()}>
        <RestoreCard />
      </div>
    </div>
  )
}

/** 标题栏入口：只在有候选、且没有空格能放卡片时出现 */
export function RestorePill(): React.JSX.Element | null {
  const count = useRestore((s) => s.candidates.length)
  const noEmptyCell = useLayout((s) => firstEmptyCell(s) < 0)
  const setOpen = useRestore((s) => s.setDialogOpen)
  if (count === 0 || !noEmptyCell) return null
  return (
    <button
      type="button"
      data-testid="restore-pill"
      onClick={() => setOpen(true)}
      className="app-no-drag inline-flex h-7 items-center gap-1.5 rounded-pill border border-accent px-3 text-[12px] font-semibold text-accent transition-colors duration-150 hover:bg-accent-soft"
    >
      <ArrowCounterClockwise size={16} aria-hidden="true" />
      恢复上次的 {count} 个会话
    </button>
  )
}
