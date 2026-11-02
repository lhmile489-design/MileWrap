import { useEffect } from 'react'
import type { SessionStatus } from '@shared/types'
import { AGENT_ICONS, badgeOf } from '../lib/agents'
import { useConfig } from '../store/config'
import { iconKey, useIcons } from '../store/icons'

export function AgentBadge({ agentId, size = 24 }: { agentId: string; size?: 20 | 24 }): React.JSX.Element {
  const box = size === 24 ? 'size-6' : 'size-5'
  const icon = AGENT_ICONS[agentId]
  // 内置 agent：固定图标放在浅色底上（两套主题同一底色，黑色图标深色模式下也看得清）
  if (icon) {
    return (
      <span aria-hidden="true" data-agent-icon={agentId} className={`grid shrink-0 place-items-center rounded-badge bg-agent-icon p-1 ${box}`}>
        <img src={icon} alt="" draggable={false} className="size-full object-contain" />
      </span>
    )
  }
  const b = badgeOf(agentId)
  return (
    <span
      aria-hidden="true"
      style={b.style}
      className={`grid shrink-0 place-items-center rounded-badge font-display text-[12px] font-bold ${b.className} ${box}`}
    >
      {b.label}
    </span>
  )
}

/** 某工作区的自定义图标 data URL；没设或还没取到时为 null */
export function useWorkspaceIconUrl(workspaceId: string | null | undefined): string | null {
  const hash = useConfig((s) => (workspaceId ? (s.config?.workspaces.find((w) => w.id === workspaceId)?.icon ?? null) : null))
  const url = useIcons((s) => (workspaceId && hash ? (s.urls[iconKey(workspaceId, hash)] ?? null) : null))
  const ensure = useIcons((s) => s.ensure)
  useEffect(() => {
    if (workspaceId && hash) ensure(workspaceId, hash)
  }, [workspaceId, hash, ensure])
  return url
}

/** 图片本体：与 AgentBadge 同尺寸同圆角，图片铺满裁切 */
export function IconImage({ src, size = 24 }: { src: string; size?: 20 | 24 }): React.JSX.Element {
  const cls = size === 24 ? 'size-6 rounded-badge' : 'size-5 rounded-badge'
  return (
    <img src={src} alt="" aria-hidden="true" draggable={false} data-workspace-icon="" className={`shrink-0 object-cover ${cls}`} />
  )
}

/**
 * 工作区图标：用户换过图就显示图片，否则退回 agent 徽章。
 * agentId 用于回退；workspaceId 为空（工作区已删）时只显示徽章。
 */
export function WorkspaceIcon({
  workspaceId,
  agentId,
  size = 24
}: {
  workspaceId: string | null | undefined
  agentId: string
  size?: 20 | 24
}): React.JSX.Element {
  const url = useWorkspaceIconUrl(workspaceId)
  return url ? <IconImage src={url} size={size} /> : <AgentBadge agentId={agentId} size={size} />
}

/** 会话图标：Shell 会话固定用 Shell 徽章（和 agent 会话区分），agent 会话用所属工作区的图标 */
export function SessionIcon({
  kind,
  workspaceId,
  agentId,
  size = 24
}: {
  kind: 'agent' | 'shell'
  workspaceId: string | null | undefined
  agentId: string
  size?: 20 | 24
}): React.JSX.Element {
  if (kind === 'shell') return <AgentBadge agentId="shell" size={size} />
  return <WorkspaceIcon workspaceId={workspaceId} agentId={agentId} size={size} />
}

export function IconButton({
  label,
  onClick,
  children,
  danger = false,
  disabled = false,
  pressed
}: {
  label: string
  /** 带事件参数，供菜单按钮取锚点位置 */
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
  danger?: boolean
  disabled?: boolean
  /** 开关型按钮（栏位显隐）；undefined = 普通按钮 */
  pressed?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`grid size-7 shrink-0 place-items-center rounded-control transition-colors duration-150 hover:bg-raised disabled:pointer-events-none disabled:text-ink-faint ${
        danger ? 'text-fault' : pressed ? 'bg-raised text-ink-strong' : 'text-ink-muted hover:text-ink-strong'
      }`}
    >
      {children}
    </button>
  )
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  type = 'button',
  disabled = false,
  autoFocus = false,
  testId
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  type?: 'button' | 'submit'
  disabled?: boolean
  /** 打标记，由所在浮层在挂载后聚焦（不用原生 autoFocus，避免和焦点陷阱抢） */
  autoFocus?: boolean
  testId?: string
}): React.JSX.Element {
  // 实底按钮用 ink-inverse：深色主题 accent / fault 偏亮，白字对比度不到 4.5:1
  const look =
    variant === 'primary'
      ? 'bg-accent text-ink-inverse hover:brightness-110'
      : variant === 'danger'
        ? 'bg-fault text-ink-inverse hover:brightness-110'
        : variant === 'ghost'
          ? 'text-ink-muted hover:bg-raised hover:text-ink-strong'
          : 'border border-line-strong bg-card text-ink-strong hover:bg-raised'
  return (
    <button
      type={type}
      disabled={disabled}
      data-autofocus={autoFocus || undefined}
      data-testid={testId}
      onClick={onClick}
      // 按钮文字一律不折行、不被挤压：放不下时由外层布局换行或收起，而不是把字挤成两行
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-control px-3 text-[13px] font-semibold transition-colors duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:bg-raised disabled:text-ink-faint ${look}`}
    >
      {children}
    </button>
  )
}

export type DisplayStatus = SessionStatus | 'idle'

const STATUS_TEXT: Record<DisplayStatus, string> = {
  idle: '未启动',
  starting: '启动中',
  running: '运行中',
  exited: '已退出',
  crashed: '异常退出'
}

/**
 * active：会话正在输出（主进程活动状态为 active），只对运行中有意义。
 * 运行中再细分：在输出 = 对话中（绿色呼吸），安静了 = 等待输入（蓝色静止）。
 */
export function statusText(status: DisplayStatus, exitCode: number | null, active = false): string {
  if (status === 'exited' || status === 'crashed') return `${STATUS_TEXT[status]}（${exitCode ?? '?'}）`
  if (status === 'running') return active ? '对话中' : '等待输入'
  return STATUS_TEXT[status]
}

/** 状态图标：形状 + 颜色 + 文字提示三重表达（UI设计约束 §4.1） */
export function StatusIcon({ status, exitCode, active = false }: { status: DisplayStatus; exitCode: number | null; active?: boolean }): React.JSX.Element {
  const title = statusText(status, exitCode, active)
  const common = 'relative inline-grid size-2.5 shrink-0 place-items-center rounded-xs'
  switch (status) {
    case 'running':
      // 对话中：实心方块 + 呼吸与外扩光晕；等待输入：描边方块里一个小实心块，不动
      return active ? (
        <span role="img" aria-label={title} title={title} data-status="busy" className={`${common} status-live bg-live`} />
      ) : (
        <span role="img" aria-label={title} title={title} data-status="waiting" className={`${common} border border-accent`}>
          <span aria-hidden="true" className="size-1 rounded-xs bg-accent" />
        </span>
      )
    case 'starting':
      return <span role="img" aria-label={title} title={title} className={`${common} border border-dashed border-warn`} />
    case 'exited':
      return (
        <span role="img" aria-label={title} title={title} className={`${common} border border-idle`}>
          <svg viewBox="0 0 10 10" className="size-2 text-idle" aria-hidden="true">
            <path d="M2.2 5.2 4.2 7 7.8 3" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </span>
      )
    case 'crashed':
      return (
        // 无法对话：实心红块 + 反色感叹号，比描边更醒目
        <span role="img" aria-label={title} title={title} data-status="fault" className={`${common} bg-fault`}>
          <svg viewBox="0 0 10 10" className="size-2 text-ink-inverse" aria-hidden="true">
            <path d="M5 2v3.6M5 7.4v.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </span>
      )
    default:
      // 未启动用空心圆：空心方块在卡片里很像一个没勾的复选框
      return <span role="img" aria-label={title} title={title} className={`${common} rounded-pill border border-idle`} />
  }
}

/**
 * 状态胶囊。compact：放在容器查询（@container）里时，窄于 400px 只留图标（图标自带 aria-label 与 title，
 * 状态仍是「形状 + 颜色 + 文字提示」三重表达）。
 */
export function StatusPill({
  status,
  exitCode,
  active = false,
  compact = false
}: {
  status: DisplayStatus
  exitCode: number | null
  active?: boolean
  compact?: boolean
}): React.JSX.Element {
  const tone =
    status === 'running'
      ? active
        ? 'border-live text-live'
        : 'border-accent text-accent'
      : status === 'starting'
        ? 'border-warn text-warn'
        : status === 'crashed'
          ? 'border-fault text-fault'
          : 'border-line-strong text-ink-muted'
  return (
    <span className={`inline-flex h-6 shrink-0 items-center gap-1.5 rounded-pill border px-2 text-[12px] font-semibold ${tone}`}>
      <StatusIcon status={status} exitCode={exitCode} active={active} />
      <span className={compact ? 'hidden @min-[400px]:inline' : ''}>{statusText(status, exitCode, active)}</span>
    </span>
  )
}
