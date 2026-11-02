import { ArrowSquareOut, Copy, TextAa } from '@phosphor-icons/react'
import { useSessions } from '../store/sessions'
import { terminals } from '../terminal/TerminalRegistry'
import { isLive } from '../lib/time'
import { notifyError } from './ConfirmDialog'
import { focusedSession } from './actions'
import type { MenuItem } from './Menu'

/**
 * 目录栏节点的动作（升级建议 2.4）：复制路径、插入到终端。目录栏仍只读，这里只复制和插入文本。
 * 相对路径渲染层本来就有；绝对路径经 fs:resolve 由主进程校验后返回。
 */

/** Claude Code 用 @相对路径引用文件；其他 agent 直接给相对路径。含空格时加引号 */
function formatFor(agentId: string, rel: string): string {
  const p = /\s/.test(rel) ? `"${rel}"` : rel
  return agentId === 'claude' ? `@${p}` : p
}

/**
 * 把路径写进某个会话的输入行（缺省 = 聚焦格的会话）。只写文本、不带回车，不会替用户提交。
 * 会话不属于这个工作区时仍插入相对路径，前后补空格方便接着输入。
 */
export async function insertPath(workspaceId: string, rel: string, sessionId?: string | null): Promise<void> {
  const s = sessionId ? useSessions.getState().sessions.find((x) => x.id === sessionId) : focusedSession()
  if (!s || !isLive(s)) {
    notifyError(new Error('聚焦格里没有运行中的会话'), '无法插入路径')
    return
  }
  let text = formatFor(s.agentId, rel || '.')
  if (s.workspaceId !== workspaceId) {
    // 跨工作区：相对路径对不上，改用主进程校验过的绝对路径
    try {
      const abs = await window.warp.fs.resolve(workspaceId, rel)
      text = /\s/.test(abs) ? `"${abs}"` : abs
    } catch (e) {
      notifyError(e, '无法插入路径')
      return
    }
  }
  window.warp.session.write(s.id, `${text} `)
  terminals.focus(s.id)
}

async function copyAbsolute(workspaceId: string, rel: string): Promise<void> {
  try {
    await window.warp.clipboard.write(await window.warp.fs.resolve(workspaceId, rel))
  } catch (e) {
    notifyError(e, '复制失败')
  }
}

/** 目录栏右键菜单：在资源管理器中显示 / 复制相对路径 / 复制绝对路径 / 插入到当前终端 */
export function fileMenu(workspaceId: string, rel: string): MenuItem[] {
  const target = focusedSession()
  return [
    {
      label: '插入到当前终端',
      icon: <TextAa size={16} />,
      disabled: !target || !isLive(target),
      onSelect: () => void insertPath(workspaceId, rel)
    },
    { kind: 'separator' },
    { label: '复制相对路径', icon: <Copy size={16} />, onSelect: () => void window.warp.clipboard.write(rel || '.') },
    { label: '复制绝对路径', icon: <Copy size={16} />, onSelect: () => void copyAbsolute(workspaceId, rel) },
    { kind: 'separator' },
    {
      label: '在资源管理器中显示',
      icon: <ArrowSquareOut size={16} />,
      onSelect: () => void window.warp.fs.reveal(workspaceId, rel).catch((e: unknown) => notifyError(e, '打开失败'))
    }
  ]
}
