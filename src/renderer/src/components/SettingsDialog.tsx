import { useEffect, useRef, useState } from 'react'
import { ArrowClockwise, Copy, DownloadSimple, FolderOpen, PencilSimple, Plus, Trash, UploadSimple, X } from '@phosphor-icons/react'
import type { AgentDef, Settings } from '@shared/types'
import { badgeReadable } from '@shared/color'
import { useConfig } from '../store/config'
import { useUi, type SettingsTab } from '../store/ui'
import { errorText } from '../lib/errors'
import { useOverlay } from '../lib/useOverlay'
import { AgentBadge, Button, IconButton } from './ui'
import { confirm, notifyError } from './ConfirmDialog'
import { INSTALL_HINTS } from '../lib/agents'
import { formatArgs } from '../lib/args'
import logoUrl from '../assets/logo.png'
import { SHORTCUTS } from '../lib/shortcuts'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'appearance', label: '外观' },
  { id: 'terminal', label: '终端' },
  { id: 'agents', label: 'Agent' },
  { id: 'notify', label: '通知' },
  { id: 'startup', label: '启动与恢复' },
  { id: 'git', label: 'Git' },
  { id: 'about', label: '关于' }
]

const FIELD =
  'h-9 w-full rounded-control border border-line bg-card px-3 text-[13px] text-ink-strong outline-none transition-colors duration-150 focus:border-accent'

/**
 * 设置页（PRD S-02，PRD §5「模态，分页签」）。改动立即生效并落盘；
 * 校验以主进程 sanitizeSettingsPatch 为准，被拒时在该项下方显示原因。
 */
export function SettingsDialog(): React.JSX.Element | null {
  const tab = useUi((s) => s.settingsTab)
  const close = useUi((s) => s.closeSettings)
  const config = useConfig((s) => s.config)
  if (!tab || !config) return null
  return <Panel tab={tab} settings={config.settings} onClose={close} />
}

function Panel({ tab, settings, onClose }: { tab: SettingsTab; settings: Settings; onClose: () => void }): React.JSX.Element {
  const openSettings = useUi((s) => s.openSettings)
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlay(panelRef, onClose)

  useEffect(() => {
    // 只在打开时聚焦当前页签一次；之后切页签不抢焦点
    panelRef.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [])

  return (
    <div className="dialog-backdrop fixed inset-0 z-40 grid place-items-center" onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-testid="settings-dialog"
        className="flex h-[min(560px,calc(100vh-64px))] w-[680px] max-w-[calc(100vw-48px)] flex-col rounded-card border border-line bg-card shadow-[var(--shadow-float)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-5">
          <h2 id="settings-title" className="font-display text-[15px] font-bold text-ink-strong">
            设置
          </h2>
          <IconButton label="关闭" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1">
          <div role="tablist" aria-orientation="vertical" aria-label="设置分类" className="flex w-40 shrink-0 flex-col gap-1 border-r border-line p-3">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === tab}
                data-settings-tab={t.id}
                onClick={() => openSettings(t.id)}
                className={`h-8 rounded-control px-3 text-left text-[13px] transition-colors duration-150 ${
                  t.id === tab ? 'bg-raised font-semibold text-ink-strong' : 'text-ink-muted hover:bg-raised hover:text-ink-strong'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label} className="min-h-0 flex-1 overflow-y-auto p-5">
            {tab === 'appearance' && <Appearance settings={settings} />}
            {tab === 'terminal' && <TerminalTab settings={settings} />}
            {tab === 'agents' && <AgentsTab />}
            {tab === 'notify' && <NotifyTab settings={settings} />}
            {tab === 'startup' && <StartupTab settings={settings} />}
            {tab === 'git' && <GitTab settings={settings} />}
            {tab === 'about' && <AboutTab />}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 写一项设置；失败返回原因 */
function useSave(): [(patch: Partial<Settings>) => Promise<boolean>, string | null] {
  const updateSettings = useConfig((s) => s.updateSettings)
  const [error, setError] = useState<string | null>(null)
  const save = async (patch: Partial<Settings>): Promise<boolean> => {
    setError(null)
    try {
      await updateSettings(patch)
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    }
  }
  return [save, error]
}

function Row({ label, hint, children, error }: { label: string; hint?: string; children: React.ReactNode; error?: string | null }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 border-b border-line py-4 first:pt-0 last:border-b-0">
      {/* 控件放不下时整块换到说明文字下面，而不是把说明挤成一列一两个字 */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <div className="min-w-[240px] flex-1" data-audit-minw="240">
          <div className="text-[13px] font-semibold text-ink-strong">{label}</div>
          {hint && <div className="text-[12px] text-ink-muted">{hint}</div>}
        </div>
        <div className="shrink-0">{children}</div>
      </div>
      {error && (
        <p role="alert" className="text-[12px] text-fault">
          {error}
        </p>
      )}
    </div>
  )
}

function Switch({ label, checked, onChange, testId }: { label: string; checked: boolean; onChange: (v: boolean) => void; testId?: string }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-10 rounded-pill border transition-colors duration-150 ${checked ? 'border-accent bg-accent' : 'border-line-strong bg-raised'}`}
    >
      <span
        aria-hidden="true"
        className={`absolute top-0.5 left-0.5 size-4 rounded-pill bg-card shadow-[var(--shadow-lift)] transition-transform duration-200 ease-spring motion-reduce:transition-none ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </button>
  )
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  testId
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  testId?: string
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} data-testid={testId} className="flex h-8 items-center gap-0.5 rounded-pill bg-raised p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          data-value={o.value}
          onClick={() => onChange(o.value)}
          className={`h-7 rounded-pill px-3 text-[12px] font-semibold transition-colors duration-150 ${
            o.value === value ? 'bg-card text-ink-strong shadow-[var(--shadow-lift)]' : 'text-ink-muted hover:text-ink-strong'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** 失焦或回车时提交的输入框；被拒时回到当前值 */
function CommitInput({
  label,
  value,
  onCommit,
  type = 'text',
  className = '',
  testId
}: {
  label: string
  value: string
  onCommit: (v: string) => Promise<boolean>
  type?: 'text' | 'number'
  className?: string
  testId?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = async (): Promise<void> => {
    if (draft === value) return
    if (!(await onCommit(draft))) setDraft(value)
  }
  return (
    <input
      aria-label={label}
      data-testid={testId}
      type={type}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void commit()
        }
      }}
      className={`${FIELD} ${className}`}
    />
  )
}

function Appearance({ settings }: { settings: Settings }): React.JSX.Element {
  const [save, error] = useSave()
  return (
    <Row label="主题" hint="跟随系统时随 Windows 的浅色 / 深色切换，终端配色同步" error={error}>
      <Segmented
        label="主题"
        testId="settings-theme"
        value={settings.theme}
        options={[
          { value: 'system', label: '跟随系统' },
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' }
        ]}
        onChange={(v) => void save({ theme: v })}
      />
    </Row>
  )
}

function TerminalTab({ settings }: { settings: Settings }): React.JSX.Element {
  const [saveSize, sizeError] = useSave()
  const [saveFont, fontError] = useSave()
  const [saveScroll, scrollError] = useSave()
  const [saveCopy, copyError] = useSave()
  const [saveShell, shellError] = useSave()
  const [saveLine, lineError] = useSave()
  const [saveCursor, cursorError] = useSave()
  const [shells, setShells] = useState<{ label: string; path: string }[]>([])
  useEffect(() => {
    void window.warp.agent.shells().then(setShells)
  }, [])

  return (
    <>
      <Row label="字号" hint="10–24；也可以用 Ctrl+= / Ctrl+- / Ctrl+0" error={sizeError}>
        <CommitInput label="字号" testId="settings-font-size" type="number" className="w-24" value={String(settings.fontSize)} onCommit={(v) => saveSize({ fontSize: Number(v) })} />
      </Row>
      <Row label="字体" hint="按顺序回落；本机没有 Cascadia Mono 时用 Consolas" error={fontError}>
        <CommitInput label="字体" testId="settings-font-family" className="w-72 font-mono" value={settings.fontFamily} onCommit={(v) => saveFont({ fontFamily: v })} />
      </Row>
      <Row label="滚动缓冲行数" hint="500–50000；新开的会话与已有会话都生效" error={scrollError}>
        <CommitInput label="滚动缓冲行数" testId="settings-scrollback" type="number" className="w-28" value={String(settings.scrollback)} onCommit={(v) => saveScroll({ scrollback: Number(v) })} />
      </Row>
      <Row label="行高" hint="1.0–2.0" error={lineError}>
        <CommitInput label="行高" testId="settings-line-height" type="number" className="w-24" value={String(settings.lineHeight)} onCommit={(v) => saveLine({ lineHeight: Number(v) })} />
      </Row>
      <Row label="光标" error={cursorError}>
        <div className="flex items-center gap-3">
          <Segmented
            label="光标样式"
            testId="settings-cursor-style"
            value={settings.cursorStyle}
            options={[
              { value: 'block', label: '方块' },
              { value: 'bar', label: '竖线' },
              { value: 'underline', label: '下划线' }
            ]}
            onChange={(v) => void saveCursor({ cursorStyle: v })}
          />
          <span className="text-[12px] text-ink-muted">闪烁</span>
          <Switch label="光标闪烁" testId="settings-cursor-blink" checked={settings.cursorBlink} onChange={(v) => void saveCursor({ cursorBlink: v })} />
        </div>
      </Row>
      <Row label="选中即复制" hint="在终端里拖选后自动写入剪贴板" error={copyError}>
        <Switch label="选中即复制" testId="settings-copy-on-select" checked={settings.copyOnSelect} onChange={(v) => void saveCopy({ copyOnSelect: v })} />
      </Row>
      <Row label="Ctrl+V 粘贴" hint="开了之后 Ctrl+V 直接粘贴给 agent，不再发给终端里的程序" error={copyError}>
        <Switch label="Ctrl+V 粘贴" testId="settings-paste-on-ctrl-v" checked={settings.pasteOnCtrlV} onChange={(v) => void saveCopy({ pasteOnCtrlV: v })} />
      </Row>
      <Row label="默认 Shell" hint="「打开 Shell」与 Shell 工作区用它；只列本机已安装的" error={shellError}>
        <select
          aria-label="默认 Shell"
          data-testid="settings-shell"
          className={`${FIELD} w-56`}
          value={settings.shellPath ?? ''}
          onChange={(e) => void saveShell({ shellPath: e.target.value || null })}
        >
          <option value="">自动（PowerShell 7 优先）</option>
          {shells.map((s) => (
            <option key={s.path} value={s.path}>
              {s.label}
            </option>
          ))}
        </select>
      </Row>
    </>
  )
}

function AgentsTab(): React.JSX.Element {
  const agents = useConfig((s) => s.agents)
  const redetect = useConfig((s) => s.redetect)
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-ink-muted">启动时自动检测 PATH 里的 agent 与版本；新装或升级后点「重新检测」。</p>
        <Button
          disabled={busy}
          testId="settings-redetect"
          onClick={() => {
            setBusy(true)
            void redetect().finally(() => setBusy(false))
          }}
        >
          <ArrowClockwise size={16} />
          {busy ? '检测中…' : '重新检测'}
        </Button>
      </div>
      <ul className="flex flex-col gap-2" aria-label="agent 列表">
        {agents.map((a) => (
          <li key={a.id} data-agent={a.id} className="flex flex-col gap-0.5 rounded-control border border-line px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-ink-strong">{a.name}</span>
              <span className={`rounded-pill border px-2 text-[12px] ${a.available ? 'border-live text-live' : 'border-line-strong text-ink-muted'}`}>
                {a.available ? (a.version ?? '已安装') : '未安装'}
              </span>
            </div>
            <span className="truncate font-mono text-[12px] text-ink-faint" title={a.resolvedPath ?? ''}>
              {a.resolvedPath ? `${a.resolvedPath}${a.via && a.via !== 'exe' ? `（${VIA[a.via]}）` : ''}` : '不在 PATH 中'}
            </span>
            {!a.available && INSTALL_HINTS[a.id] && <InstallHint command={INSTALL_HINTS[a.id]} />}
          </li>
        ))}
      </ul>
      <CustomAgents />
    </div>
  )
}

/** 没装时给安装命令（升级建议 4.6）：复制后用户自己去终端执行，应用不代装（PRD §7） */
function InstallHint({ command }: { command: string }): React.JSX.Element {
  return (
    <div className="mt-1 flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-control bg-sunken px-2 py-1 font-mono text-[12px] text-ink">{command}</code>
      <IconButton label="复制安装命令" onClick={() => void window.warp.clipboard.write(command)}>
        <Copy size={16} />
      </IconButton>
    </div>
  )
}

type AgentDraft = { id?: string; name: string; command: string; argsText: string; color: string; resumeArgsText: string; continueArgsText: string }

const BLANK_AGENT: AgentDraft = { name: '', command: '', argsText: '', color: '#2563eb', resumeArgsText: '', continueArgsText: '' }

function draftOf(a: AgentDef): AgentDraft {
  return {
    id: a.id,
    name: a.name,
    command: a.command,
    argsText: formatArgs(a.defaultArgs ?? []),
    color: a.color ?? '#2563eb',
    resumeArgsText: formatArgs(a.resumeArgs ?? []),
    continueArgsText: formatArgs(a.continueArgs ?? [])
  }
}

/**
 * 自定义 agent（PRD A-03，升级建议 3.3）。命令只接受命令名或系统对话框选出的可执行文件；
 * 参数在主进程切成数组；徽章色要求前景对比度 ≥ 4.5:1（主进程再校验一次）。
 */
function CustomAgents(): React.JSX.Element {
  const customs = useConfig((s) => s.config?.customAgents)
  const saveCustomAgent = useConfig((s) => s.saveCustomAgent)
  const removeCustomAgent = useConfig((s) => s.removeCustomAgent)
  const [draft, setDraft] = useState<AgentDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = customs ?? []
  const readable = draft ? badgeReadable(draft.color) : true

  const submit = async (): Promise<void> => {
    if (!draft) return
    setError(null)
    try {
      await saveCustomAgent({ ...draft, color: draft.color || null })
      setDraft(null)
    } catch (e) {
      setError(errorText(e))
    }
  }
  const remove = async (a: AgentDef): Promise<void> => {
    if (!(await confirm({ title: `删除自定义 agent「${a.name}」？`, body: '只删除这条定义，不影响已安装的程序。', danger: true, okLabel: '删除' }))) return
    await removeCustomAgent(a.id).catch((e: unknown) => notifyError(e, '删除失败'))
  }
  const field = (k: keyof AgentDraft, label: string, placeholder = '', mono = false): React.JSX.Element => (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-semibold text-ink-strong">{label}</span>
      <input
        aria-label={label}
        data-testid={`custom-agent-${k}`}
        value={draft?.[k] ?? ''}
        placeholder={placeholder}
        onChange={(e) => draft && setDraft({ ...draft, [k]: e.target.value })}
        className={`${FIELD} ${mono ? 'font-mono' : ''}`}
      />
    </label>
  )

  return (
    <section aria-label="自定义 agent" className="mt-2 flex flex-col gap-2 border-t border-line pt-4">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold text-ink-strong">自定义 agent</div>
        {!draft && (
          <Button testId="custom-agent-add" onClick={() => setDraft({ ...BLANK_AGENT })}>
            <Plus size={16} />
            添加 agent
          </Button>
        )}
      </div>
      {list.length === 0 && !draft && <p className="text-[12px] text-ink-muted">Gemini CLI、Aider、OpenCode 这类 agent 可以加在这里，之后在工作区弹窗里选。</p>}
      <ul className="flex flex-col gap-2">
        {list.map((a) => (
          <li key={a.id} data-custom-agent={a.id} className="flex items-center gap-2 rounded-control border border-line px-3 py-2">
            <AgentBadge agentId={a.id} size={20} />
            <span className="text-[13px] font-semibold text-ink-strong">{a.name}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-faint" title={a.command}>
              {a.command}
            </span>
            <IconButton label={`编辑 ${a.name}`} onClick={() => setDraft(draftOf(a))}>
              <PencilSimple size={16} />
            </IconButton>
            <IconButton label={`删除 ${a.name}`} danger onClick={() => void remove(a)}>
              <Trash size={16} />
            </IconButton>
          </li>
        ))}
      </ul>
      {draft && (
        <div className="flex flex-col gap-3 rounded-control border border-line bg-sunken p-3" data-testid="custom-agent-form">
          <div className="grid grid-cols-2 gap-3">
            {field('name', '名称', 'Gemini CLI')}
            <div className="flex flex-col gap-1">
              <span className="text-[12px] font-semibold text-ink-strong">命令</span>
              <div className="flex gap-1">
                <input
                  aria-label="命令"
                  data-testid="custom-agent-command"
                  value={draft.command}
                  placeholder="gemini"
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  className={`${FIELD} font-mono`}
                />
                <IconButton
                  label="选择可执行文件"
                  onClick={() => void window.warp.agent.pickCommand().then((p) => p && setDraft({ ...draft, command: p }))}
                >
                  <FolderOpen size={16} />
                </IconButton>
              </div>
            </div>
          </div>
          {field('argsText', '默认参数', '--yolo', true)}
          <div className="grid grid-cols-2 gap-3">
            {field('resumeArgsText', '按 ID 续接（{id} 为占位符，可空）', '--resume {id}', true)}
            {field('continueArgsText', '续接最近一次（可空）', '--continue', true)}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[12px] font-semibold text-ink-strong">徽章颜色</span>
            <input
              type="color"
              aria-label="徽章颜色"
              data-testid="custom-agent-color"
              value={draft.color}
              onChange={(e) => setDraft({ ...draft, color: e.target.value })}
              className="h-8 w-12 cursor-pointer rounded-control border border-line bg-card"
            />
            {!readable && <span className="text-[12px] text-fault">这个颜色上的文字对比度不到 4.5:1</span>}
          </div>
          {error && (
            <p role="alert" className="text-[12px] text-fault">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDraft(null)}>取消</Button>
            <Button variant="primary" testId="custom-agent-save" disabled={!draft.name.trim() || !draft.command.trim() || !readable} onClick={() => void submit()}>
              保存
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

/** 提醒与通知（升级建议 2.1 / 2.2）：阈值只看输出的时间，不看内容 */
function NotifyTab({ settings }: { settings: Settings }): React.JSX.Element {
  const [saveBurst, burstError] = useSave()
  const [saveQuiet, quietError] = useSave()
  const [saveIdle, idleError] = useSave()
  const [saveExit, exitError] = useSave()
  const [saveDnd, dndError] = useSave()
  const hours = Array.from({ length: 24 }, (_, h) => h)
  return (
    <>
      <Row label="「等你处理」判定：连续输出" hint="一轮输出至少持续这么多秒（1–120），才可能被判为跑完一轮" error={burstError}>
        <CommitInput label="连续输出秒数" testId="settings-burst" type="number" className="w-24" value={String(settings.activityBurstSec)} onCommit={(v) => saveBurst({ activityBurstSec: Number(v) })} />
      </Row>
      <Row label="「等你处理」判定：安静" hint="之后安静这么多秒（2–120），卡片与格头出现提示点" error={quietError}>
        <CommitInput label="安静秒数" testId="settings-quiet" type="number" className="w-24" value={String(settings.activityQuietSec)} onCommit={(v) => saveQuiet({ activityQuietSec: Number(v) })} />
      </Row>
      <Row label="等待输入时发系统通知" hint="窗口在前台且会话就在可见格里时不发" error={idleError}>
        <Switch label="等待输入时发系统通知" testId="settings-notify-idle" checked={settings.notifyIdle} onChange={(v) => void saveIdle({ notifyIdle: v })} />
      </Row>
      <Row label="进程退出时发系统通知" hint="自己点「结束」「关闭」的不发" error={exitError}>
        <Switch label="进程退出时发系统通知" testId="settings-notify-exit" checked={settings.notifyExit} onChange={(v) => void saveExit({ notifyExit: v })} />
      </Row>
      <Row label="免打扰时段" hint="这段时间不弹通知（提示点照常显示）；开始与结束相同 = 不启用" error={dndError}>
        <div className="flex items-center gap-2">
          <select aria-label="免打扰开始" data-testid="settings-dnd-start" className={`${FIELD} w-24`} value={settings.dndStart} onChange={(e) => void saveDnd({ dndStart: Number(e.target.value) })}>
            {hours.map((h) => (
              <option key={h} value={h}>
                {h}:00
              </option>
            ))}
          </select>
          <span className="text-[12px] text-ink-muted">到</span>
          <select aria-label="免打扰结束" data-testid="settings-dnd-end" className={`${FIELD} w-24`} value={settings.dndEnd} onChange={(e) => void saveDnd({ dndEnd: Number(e.target.value) })}>
            {hours.map((h) => (
              <option key={h} value={h}>
                {h}:00
              </option>
            ))}
          </select>
        </div>
      </Row>
    </>
  )
}

const VIA: Record<string, string> = { 'shim-exe': '还原 npm 壳 → exe', 'shim-node': '还原 npm 壳 → node', 'cmd-wrap': '经 cmd 启动' }

function StartupTab({ settings }: { settings: Settings }): React.JSX.Element {
  const [saveClose, closeError] = useSave()
  const [saveRestore, restoreError] = useSave()
  const [saveResume, resumeError] = useSave()
  return (
    <>
      <Row label="关闭窗口时" hint="还有会话在运行时的处理方式" error={closeError}>
        <Segmented
          label="关闭窗口时"
          testId="settings-close-action"
          value={settings.closeAction}
          options={[
            { value: 'ask', label: '每次询问' },
            { value: 'tray', label: '最小化到托盘' },
            { value: 'quit', label: '全部结束并退出' }
          ]}
          onChange={(v) => void saveClose({ closeAction: v })}
        />
      </Row>
      <Row label="启动时自动恢复" hint="关闭时只在控制台显示「恢复上次的会话」卡片；打开后自动拉起上次没正常退出的会话" error={restoreError}>
        <Switch label="启动时自动恢复" testId="settings-restore-on-startup" checked={settings.restoreOnStartup} onChange={(v) => void saveRestore({ restoreOnStartup: v })} />
      </Row>
      <Row label="恢复时续接对话" hint="关闭后恢复只重新启动 agent、开新对话" error={resumeError}>
        <Switch label="恢复时续接对话" testId="settings-resume" checked={settings.resumeConversation} onChange={(v) => void saveResume({ resumeConversation: v })} />
      </Row>
    </>
  )
}

/** Git 管理（Git管理-PRD G-01）：总开关默认关，关着时应用不执行任何 git 命令 */
function GitTab({ settings }: { settings: Settings }): React.JSX.Element {
  const [saveEnabled, enabledError] = useSave()
  const [saveRemote, remoteError] = useSave()
  return (
    <>
      <Row label="启用 Git 管理" hint="打开后可在工作区所在仓库查看改动、提交、切分支与推送；关闭时不执行任何 git 命令，格头分支仍照常显示" error={enabledError}>
        <Switch label="启用 Git 管理" testId="settings-git-enabled" checked={settings.gitEnabled} onChange={(v) => void saveEnabled({ gitEnabled: v })} />
      </Row>
      {settings.gitEnabled && (
        <Row label="默认远端" hint="分支还没有上游时，推送会自动设到这个远端的同名分支" error={remoteError}>
          <CommitInput label="默认远端" testId="settings-git-remote" className="w-40 font-mono" value={settings.gitDefaultRemote} onCommit={(v) => saveRemote({ gitDefaultRemote: v.trim() })} />
        </Row>
      )}
    </>
  )
}

async function exportConfig(): Promise<void> {
  try {
    await window.warp.config.exportData()
  } catch (e) {
    notifyError(e, '导出失败')
  }
}

async function importConfig(): Promise<void> {
  try {
    const r = await useConfig.getState().importData()
    if (!r) return
    const body = r.skipped.length ? `跳过 ${r.skipped.length} 个：\n${r.skipped.join('\n')}` : '全部导入成功。'
    await confirm({ title: `导入了 ${r.imported} 个工作区`, body, okLabel: '知道了', cancelLabel: '关闭' })
  } catch (e) {
    notifyError(e, '导入失败')
  }
}

function AboutTab(): React.JSX.Element {
  const [info, setInfo] = useState<{ version: string; platform: string } | null>(null)
  useEffect(() => {
    void window.warp.app.info().then(setInfo)
  }, [])
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <img src={logoUrl} alt="Mile Warp 图标" draggable={false} className="size-16 shrink-0 select-none" />
        <div>
          <div className="font-display text-[20px] font-extrabold text-ink-strong">Mile Warp</div>
          <div className="text-[13px] text-ink-muted" data-testid="settings-version">
            版本 {info?.version ?? '…'} · {info?.platform === 'win32' ? 'Windows' : info?.platform}
          </div>
        </div>
      </div>
      <p className="text-[13px] text-ink">集中管理和运行终端类 AI agent（Claude Code、Codex CLI、Kimi Code、Shell）。配置与会话快照只存在本机，不联网同步。</p>
      <div className="flex flex-wrap gap-2">
        <Button testId="settings-open-logs" onClick={() => void window.warp.app.openLogDir().catch((e: unknown) => notifyError(e, '打开失败'))}>
          <FolderOpen size={16} />
          打开日志目录
        </Button>
        <Button testId="settings-export" onClick={() => void exportConfig()}>
          <UploadSimple size={16} />
          导出分组与工作区
        </Button>
        <Button testId="settings-import" onClick={() => void importConfig()}>
          <DownloadSimple size={16} />
          导入
        </Button>
      </div>
      <p className="text-[12px] text-ink-muted">导出不含环境变量的值（只有键名）和自定义图标；导入时目录不存在的工作区会跳过。</p>
      <div>
        <div className="mb-2 text-[13px] font-semibold text-ink-strong">快捷键</div>
        <table className="w-full text-[12px]">
          <tbody>
            {SHORTCUTS.map(([k, v]) => (
              <tr key={k} className="border-b border-line last:border-b-0">
                <td className="py-1.5 pr-4 font-mono text-ink-strong">{k}</td>
                <td className="py-1.5 text-ink-muted">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
