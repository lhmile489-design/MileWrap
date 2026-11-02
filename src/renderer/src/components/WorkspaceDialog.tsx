import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, ImageSquare, Plus, Trash, X } from '@phosphor-icons/react'
import type { Workspace, WorkspaceInput } from '@shared/types'
import { useConfig } from '../store/config'
import { useSessions } from '../store/sessions'
import type { WorkspaceDialogState } from '../store/ui'
import { formatArgs } from '../lib/args'
import { errorText } from '../lib/errors'
import { isLive } from '../lib/time'
import { useOverlay } from '../lib/useOverlay'
import { AgentBadge, Button, IconButton, useWorkspaceIconUrl } from './ui'

const FIELD =
  'h-9 w-full rounded-control border border-line bg-card px-3 text-[13px] text-ink-strong outline-none transition-colors duration-150 focus:border-accent'
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/** 环境变量编辑行。已有的键只给键名（值不出主进程），留空 = 保持不变 */
type EnvRow = { uid: number; key: string; value: string; existing: boolean }

let rowSeq = 0

/**
 * 新建 / 编辑工作区（PRD W-04 / W-05）。校验以主进程为准，这里只挡空值与明显的格式错误。
 * 编辑时只发改动过的字段；环境变量按补丁发：字符串 = 新增或覆盖，null = 删除。
 */
export function WorkspaceDialog({ state, onClose }: { state: NonNullable<WorkspaceDialogState>; onClose: () => void }): React.JSX.Element | null {
  const config = useConfig((s) => s.config)
  const editing = state.kind === 'edit' ? config?.workspaces.find((w) => w.id === state.id) : undefined
  // 编辑中的工作区被删掉了：关掉弹窗
  const gone = state.kind === 'edit' && config !== null && !editing
  useEffect(() => {
    if (gone) onClose()
  }, [gone, onClose])
  if (gone || (state.kind === 'edit' && !editing)) return null
  const prefill = state.kind === 'create' && state.cwd ? { cwd: state.cwd, name: state.name ?? '' } : null
  return (
    <Form
      key={editing?.id ?? 'create'}
      editing={editing ?? null}
      defaultGroupId={state.kind === 'create' ? state.groupId : null}
      prefill={prefill}
      onClose={onClose}
    />
  )
}

const LAST_AGENT_KEY = 'warp.lastAgent'

/** 上次新建工作区时选的 agent（升级建议 2.5「agent 取上次用的那个」）；已不存在就不用 */
function lastAgent(agents: { id: string }[]): string | undefined {
  const id = localStorage.getItem(LAST_AGENT_KEY)
  return id && agents.some((a) => a.id === id) ? id : undefined
}

function Form({
  editing,
  defaultGroupId,
  prefill,
  onClose
}: {
  editing: Workspace | null
  defaultGroupId: string | null
  /** 从资源管理器拖进来 / 粘贴的目录：只预填，校验仍由主进程 workspace:create 负责 */
  prefill: { cwd: string; name: string } | null
  onClose: () => void
}): React.JSX.Element {
  const agents = useConfig((s) => s.agents)
  const config = useConfig((s) => s.config)
  const createWorkspace = useConfig((s) => s.createWorkspace)
  const editWorkspace = useConfig((s) => s.editWorkspace)
  const sessions = useSessions((s) => s.sessions)
  const groups = useMemo(() => [...(config?.groups ?? [])].sort((a, b) => a.order - b.order), [config])
  const running = editing ? sessions.some((s) => s.workspaceId === editing.id && isLive(s)) : false

  const initialArgs = useMemo(() => (editing ? formatArgs(editing.args) : ''), [editing])
  const [name, setName] = useState(editing?.name ?? prefill?.name ?? '')
  const [agentId, setAgentId] = useState(editing?.agentId ?? lastAgent(agents) ?? agents.find((a) => a.available)?.id ?? 'claude')
  const [cwd, setCwd] = useState(editing?.cwd ?? prefill?.cwd ?? '')
  const [argsText, setArgsText] = useState(initialArgs)
  const [note, setNote] = useState(editing?.note ?? '')
  const [groupId, setGroupId] = useState<string | null>(editing ? editing.groupId : defaultGroupId)
  const [env, setEnv] = useState<EnvRow[]>(() => (editing?.envKeys ?? []).map((key) => ({ uid: ++rowSeq, key, value: '', existing: true })))
  const [removed, setRemoved] = useState<string[]>([])
  // 图标：null = 不变；picked = 新选的图（保存时才落盘）；'reset' = 恢复成 agent 徽章
  const [iconChoice, setIconChoice] = useState<{ token: string; dataUrl: string } | 'reset' | null>(null)
  const currentIcon = useWorkspaceIconUrl(editing?.id)
  const previewIcon = iconChoice === 'reset' ? null : (iconChoice?.dataUrl ?? currentIcon)
  const hasCustomIcon = iconChoice === null ? Boolean(editing?.icon) : iconChoice !== 'reset'
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlay(panelRef, onClose)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const pick = async (): Promise<void> => {
    const dir = await window.warp.dialog.pickDirectory()
    if (!dir) return
    setCwd(dir)
    if (!name.trim()) {
      const parts = dir.split(/[\\/]+/).filter(Boolean)
      setName(parts[parts.length - 1] ?? '')
    }
  }

  const pickIcon = async (): Promise<void> => {
    try {
      const r = await window.warp.workspace.pickIcon()
      if (r) setIconChoice(r)
    } catch (err) {
      setError(errorText(err))
    }
  }

  const setRow = (uid: number, patch: Partial<EnvRow>): void => setEnv((rows) => rows.map((r) => (r.uid === uid ? { ...r, ...patch } : r)))
  const removeRow = (row: EnvRow): void => {
    setEnv((rows) => rows.filter((r) => r.uid !== row.uid))
    if (row.existing) setRemoved((list) => [...list, row.key])
  }

  /** 组装环境变量补丁；格式不对返回错误文案 */
  const buildEnv = (): Record<string, string | null> | string => {
    const out: Record<string, string | null> = {}
    for (const k of removed) out[k] = null
    const seen = new Set<string>()
    for (const r of env) {
      const key = r.key.trim()
      if (!r.existing && !key && !r.value) continue
      if (!ENV_KEY_RE.test(key)) return `环境变量名不合法：${key || '（空）'}`
      if (seen.has(key)) return `环境变量重复：${key}`
      seen.add(key)
      if (r.existing && r.value === '') continue
      out[key] = r.value
    }
    return out
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim() || !cwd.trim()) {
      setError('名称和工作目录不能为空')
      return
    }
    const envPatch = buildEnv()
    if (typeof envPatch === 'string') {
      setError(envPatch)
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (!editing) {
        const iconToken = iconChoice && iconChoice !== 'reset' ? iconChoice.token : undefined
        await createWorkspace({ name, agentId, cwd, argsText, note, groupId, env: envPatch, iconToken })
        localStorage.setItem(LAST_AGENT_KEY, agentId)
      } else {
        const patch: Partial<WorkspaceInput> = {}
        if (name.trim() !== editing.name) patch.name = name
        if (agentId !== editing.agentId) patch.agentId = agentId
        if (cwd.trim() !== editing.cwd) patch.cwd = cwd
        if (argsText !== initialArgs) patch.argsText = argsText
        if (note.trim() !== editing.note) patch.note = note
        if (groupId !== editing.groupId) patch.groupId = groupId
        if (Object.keys(envPatch).length > 0) patch.env = envPatch
        if (iconChoice === 'reset') {
          if (editing.icon) patch.iconToken = null
        } else if (iconChoice) patch.iconToken = iconChoice.token
        if (Object.keys(patch).length > 0) await editWorkspace(editing.id, patch)
      }
      onClose()
    } catch (err) {
      setError(errorText(err))
      setSaving(false)
    }
  }

  const title = editing ? '编辑工作区' : '新建工作区'

  return (
    <div className="dialog-backdrop fixed inset-0 z-40 grid place-items-center" onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ws-dialog-title"
        data-testid="workspace-dialog"
        className="flex max-h-[calc(100vh-64px)] w-[520px] max-w-[calc(100vw-48px)] flex-col rounded-card border border-line bg-card shadow-[var(--shadow-float)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-5">
          <h2 id="ws-dialog-title" className="font-display text-[15px] font-bold text-ink-strong">
            {title}
          </h2>
          <IconButton label="关闭" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>

        <form className="flex min-h-0 flex-col" onSubmit={(e) => void submit(e)}>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
            {running && (
              <p className="rounded-control border border-line bg-sunken px-3 py-2 text-[12px] text-ink-muted">
                这个工作区有正在运行的会话，修改在下次启动时生效。
              </p>
            )}

            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-ink-muted">名称</span>
              <input ref={nameRef} name="name" className={FIELD} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </label>

            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-ink-muted">图标</span>
              <div className="flex flex-wrap items-center gap-3">
                <span data-testid="icon-preview" className="grid size-12 shrink-0 place-items-center rounded-control border border-line bg-sunken">
                  {previewIcon ? (
                    // 预览图是用户图片而非图标字形，按 48px 铺满预览框
                    <img src={previewIcon} alt="图标预览" draggable={false} className="size-12 rounded-control object-cover" />
                  ) : (
                    <AgentBadge agentId={agentId} />
                  )}
                </span>
                <Button onClick={() => void pickIcon()} testId="icon-pick">
                  <ImageSquare size={16} />
                  更换图片…
                </Button>
                {hasCustomIcon && (
                  <Button variant="ghost" onClick={() => setIconChoice('reset')} testId="icon-reset">
                    恢复默认
                  </Button>
                )}
                <span className="min-w-0 text-[12px] text-ink-faint">PNG / JPG / ICO，自动裁成正方形；默认用 agent 徽章</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-semibold text-ink-muted">Agent</span>
                <select name="agentId" className={FIELD} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id} disabled={!a.available && a.id !== agentId}>
                      {a.name}
                      {a.available ? (a.version ? `  ${a.version}` : '') : '（未安装）'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12px] font-semibold text-ink-muted">所属分组</span>
                <select name="groupId" className={FIELD} value={groupId ?? ''} onChange={(e) => setGroupId(e.target.value || null)}>
                  <option value="">未分组</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-ink-muted">工作目录</span>
              <div className="flex gap-2">
                <input
                  aria-label="工作目录"
                  name="cwd"
                  className={`${FIELD} font-mono`}
                  value={cwd}
                  placeholder={'D:\\Projects\\my-app'}
                  onChange={(e) => setCwd(e.target.value)}
                />
                <Button onClick={() => void pick()}>
                  <FolderOpen size={16} />
                  选择
                </Button>
              </div>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-ink-muted">启动参数（可选）</span>
              <input
                name="argsText"
                className={`${FIELD} font-mono`}
                value={argsText}
                placeholder='--model "sonnet"'
                onChange={(e) => setArgsText(e.target.value)}
              />
            </label>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-[12px] font-semibold text-ink-muted">环境变量（可选，值加密保存，不在界面回显）</legend>
              {env.map((r) => (
                <div key={r.uid} className="flex items-center gap-2" data-env-row={r.key || 'new'}>
                  <input
                    aria-label="变量名"
                    className={`${FIELD} font-mono`}
                    value={r.key}
                    readOnly={r.existing}
                    placeholder="ANTHROPIC_API_KEY"
                    onChange={(e) => setRow(r.uid, { key: e.target.value })}
                  />
                  <input
                    aria-label={`${r.key || '新变量'} 的值`}
                    type="password"
                    autoComplete="off"
                    className={`${FIELD} font-mono`}
                    value={r.value}
                    placeholder={r.existing ? '已设置，留空保持不变' : '值'}
                    onChange={(e) => setRow(r.uid, { value: e.target.value })}
                  />
                  <IconButton label={`删除变量 ${r.key || ''}`.trim()} danger onClick={() => removeRow(r)}>
                    <Trash size={16} />
                  </IconButton>
                </div>
              ))}
              <div>
                <Button variant="ghost" onClick={() => setEnv((rows) => [...rows, { uid: ++rowSeq, key: '', value: '', existing: false }])}>
                  <Plus size={16} />
                  添加变量
                </Button>
              </div>
            </fieldset>

            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-ink-muted">备注（可选）</span>
              <input name="note" className={FIELD} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </label>

            {error && (
              <p role="alert" className="text-[13px] text-fault">
                {error}
              </p>
            )}
          </div>

          <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={saving} testId="workspace-save">
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
