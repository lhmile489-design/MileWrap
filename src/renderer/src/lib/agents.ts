import { inkOn } from '@shared/color'
import { useConfig } from '../store/config'
import claudeIcon from '../assets/agents/claude.svg'
import codexIcon from '../assets/agents/codex.svg'
import kimiIcon from '../assets/agents/kimi.svg'
import piIcon from '../assets/agents/pi.svg'
import globalIcon from '../assets/agents/global.svg'

/** 内置 agent 的固定图标（docs/icons 里的设计稿原样放进 assets/agents）；用户不用自己找图 */
export const AGENT_ICONS: Record<string, string> = { claude: claudeIcon, codex: codexIcon, kimi: kimiIcon, pi: piIcon }
/** Skills 管理里「全局仓 ~/.agents/skills」的图标（skillkit MIT 图标集） */
export const GLOBAL_SKILLS_ICON: string = globalIcon
/** agent 徽章：字母缩写 + 分类色（UI设计约束 §4.3）。内置 agent 有固定图标（AGENT_ICONS）；自定义 agent 用用户选的底色 */
export type BadgeStyle = { label: string; className: string; style?: React.CSSProperties }

const BADGES: Record<string, BadgeStyle> = {
  claude: { label: 'C', className: 'bg-agent-icon text-ink-strong' },
  codex: { label: 'X', className: 'bg-agent-icon text-ink-strong' },
  kimi: { label: 'K', className: 'bg-agent-icon text-ink-strong' },
  pi: { label: 'P', className: 'bg-agent-icon text-ink-strong' },
  shell: { label: '>_', className: 'bg-raised text-ink' }
}

const BUILTIN_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  kimi: 'Kimi Code',
  pi: 'Pi',
  shell: 'Shell'
}

function custom(agentId: string): { name: string; color?: string | null } | undefined {
  return useConfig.getState().config?.customAgents.find((a) => a.id === agentId)
}

export function badgeOf(agentId: string): BadgeStyle {
  const b = BADGES[agentId]
  if (b) return b
  const c = custom(agentId)
  const label = (c?.name ?? agentId).slice(0, 1).toUpperCase() || '?'
  // 底色由主进程校验过前景对比度 ≥ 4.5:1（WorkspaceService.saveCustomAgent）
  if (c?.color) return { label, className: '', style: { backgroundColor: c.color, color: inkOn(c.color) } }
  return { label, className: 'bg-raised text-ink' }
}

/** agent 显示名：内置 + 自定义；不认识的退回 id */
export function agentName(agentId: string): string {
  return BUILTIN_NAMES[agentId] ?? custom(agentId)?.name ?? agentId
}

/** 兼容旧调用：只含内置名，新代码用 agentName() */
export const AGENT_NAMES = BUILTIN_NAMES

/** 没装时给的安装命令（升级建议 4.6）：只展示、复制，应用不代装（PRD §7） */
export const INSTALL_HINTS: Record<string, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
  kimi: 'uv tool install kimi-cli',
  pi: 'npm i -g @earendil-works/pi-coding-agent'
}
