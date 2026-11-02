import type { AgentDef, ResumeMode } from '@shared/types'

/**
 * 内置 agent 的续接参数（技术设计 §5.8，2026-10-31 实测 --help）：
 * | agent  | 启动时指定 ID          | 按 ID 续接            | 拿不到 ID 的兜底       |
 * | claude | --session-id <uuid>    | --resume <uuid>        | --continue             |
 * | codex  | 不能（事后发现 rollout） | resume <uuid>（子命令） | resume --last          |
 * | kimi   | 不能（事后发现 index）   | --session <id>         | --continue             |
 * | pi     | --session-id <uuid>    | --session-id <uuid>    | --continue             |
 * Shell 不续接。自定义 agent 用用户填的模板（{id} 是会话 ID 占位符，升级建议 3.3）；
 * 应用拿不到自定义 agent 的会话 ID，实际只会用到「兜底续接」那一套。工作区自己的参数追加在续接参数之后。
 */
type Spec = { resume: ((id: string) => string[]) | null; continue: string[] | null }

const SPECS: Record<string, Spec> = {
  claude: { resume: (id) => ['--resume', id], continue: ['--continue'] },
  codex: { resume: (id) => ['resume', id], continue: ['resume', '--last'] },
  kimi: { resume: (id) => ['--session', id], continue: ['--continue'] },
  pi: { resume: (id) => ['--session-id', id], continue: ['--continue'] }
}

/** ID 进命令行前的校验（§5.8 规则 6）：仍是数组传参，没有注入面，只挡坏数据 */
export const RESUME_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

function specOf(agentId: string, custom?: AgentDef | null): Spec | null {
  if (SPECS[agentId]) return SPECS[agentId]
  if (!custom || custom.builtin) return null
  const tpl = custom.resumeArgs?.length ? custom.resumeArgs : null
  const cont = custom.continueArgs?.length ? custom.continueArgs : null
  if (!tpl && !cont) return null
  return {
    resume: tpl ? (id) => tpl.map((a) => a.split('{id}').join(id)) : null,
    continue: cont
  }
}

export function supportsResume(agentId: string, custom?: AgentDef | null): boolean {
  return specOf(agentId, custom) !== null
}

/** 拿不到 ID 时能否用兜底续接 */
export function supportsContinue(agentId: string, custom?: AgentDef | null): boolean {
  return Boolean(specOf(agentId, custom)?.continue)
}

export function isValidResumeId(id: unknown): id is string {
  return typeof id === 'string' && RESUME_ID_RE.test(id)
}

/** 续接时放在工作区参数前面的那段 */
export function resumePrefix(agentId: string, mode: ResumeMode, resumeId: string | null, custom?: AgentDef | null): string[] {
  const spec = specOf(agentId, custom)
  if (!spec || mode === 'fresh') return []
  if (mode === 'exact') {
    if (!isValidResumeId(resumeId)) throw new Error('会话 ID 不合法，无法续接')
    if (!spec.resume) throw new Error('这个 agent 没有配置按 ID 续接的参数')
    return spec.resume(resumeId)
  }
  if (!spec.continue) throw new Error('这个 agent 没有配置兜底续接的参数')
  return [...spec.continue]
}
