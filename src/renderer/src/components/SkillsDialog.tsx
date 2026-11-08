import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowsClockwise, DownloadSimple, FolderOpen, MagnifyingGlass, X } from '@phosphor-icons/react'
import type { SkillInfo, SkillsInstallResult, SkillsScanResult } from '@shared/types'
import { AGENT_ICONS, GLOBAL_SKILLS_ICON, agentName } from '../lib/agents'
import { errorText } from '../lib/errors'
import { notifyError, confirm } from './ConfirmDialog'
import { openMenuAt } from './Menu'
import { Button, IconButton } from './ui'
import { useOverlay } from '../lib/useOverlay'

/** 详情的 markdown 渲染复用预览栏管线（lazy chunk，不进首屏）；sanitizer 同一套防线 */
const MarkdownView = lazy(() => import('./preview/MarkdownView').then((m) => ({ default: m.MarkdownView })))

/** 「全部」筛选键 */
const ALL = '*'
/** 列表分批渲染（目录栏同款，不引入虚拟滚动库） */
const BATCH = 200

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function iconOf(agentId: string): string | null {
  return agentId === 'agents' ? GLOBAL_SKILLS_ICON : (AGENT_ICONS[agentId] ?? null)
}

function labelOf(agentId: string): string {
  return agentId === 'agents' ? '全局仓库' : agentName(agentId)
}

/** 同名 skill 出现在多个根：跨 agent 徽章对照（PRD SK-09 的最小形态） */
type Row = { agentId: string; skill: SkillInfo; alsoIn: string[] }

export function SkillsDialog(): React.JSX.Element | null {
  const open = useSkillsOpen()
  if (!open) return null
  return <Panel onClose={useSkillsClose()} />
}

import { useUi } from '../store/ui'
function useSkillsOpen(): boolean {
  return useUi((s) => s.skillsOpen)
}
function useSkillsClose(): () => void {
  return useUi((s) => s.closeSkills)
}

function Panel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  useOverlay(panelRef, onClose)

  const [data, setData] = useState<SkillsScanResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [agent, setAgent] = useState<string>(ALL)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<{ agentId: string; name: string } | null>(null)
  const [tab, setTab] = useState<'list' | 'install'>('list')
  const [shown, setShown] = useState(BATCH)
  const [busy, setBusy] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const scan = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setData(await window.warp.skills.scan())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void scan()
    searchRef.current?.focus()
  }, [])

  // 同名 skill 跨根对照
  const rows = useMemo<Row[]>(() => {
    const list = data?.skills ?? []
    const names = new Map<string, Set<string>>()
    for (const s of list) {
      const set = names.get(s.name) ?? new Set<string>()
      set.add(s.agentId)
      names.set(s.name, set)
    }
    return list.map((skill) => ({
      agentId: skill.agentId,
      skill,
      alsoIn: [...(names.get(skill.name) ?? [])].filter((a) => a !== skill.agentId)
    }))
  }, [data])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(
      (r) => (agent === ALL || r.agentId === agent) && (!q || `${r.skill.name}\n${r.skill.description ?? ''}`.toLowerCase().includes(q))
    )
  }, [rows, agent, query])

  const agentCounts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const r of rows) m[r.agentId] = (m[r.agentId] ?? 0) + 1
    return m
  }, [rows])

  const agentIds = useMemo(() => Object.keys(agentCounts).sort(), [agentCounts])

  const uninstallOne = async (s: SkillInfo): Promise<void> => {
    const ok = await confirm({
      title: `卸载 skill「${s.name}」`,
      body: `将整体删除 ${labelOf(s.agentId)} 的 skill 目录（${formatSize(s.sizeBytes)}）。此操作不可恢复。`,
      okLabel: '卸载',
      danger: true
    })
    if (!ok) return
    setBusy(true)
    try {
      await window.warp.skills.uninstall(s.agentId, s.name)
      setSelected(null)
      await scan()
    } catch (e) {
      notifyError(e, '卸载失败')
    } finally {
      setBusy(false)
    }
  }

  const installToOne = async (s: SkillInfo, target: string): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.warp.skills.installTo(s.agentId, s.name, [target], 'overwrite')
      if (res.failed.length > 0) notifyError(new Error(res.failed[0].reason), `安装到 ${labelOf(target)} 失败`)
      else await scan()
    } catch (e) {
      notifyError(e, '安装失败')
    } finally {
      setBusy(false)
    }
  }

  const menuFor = (r: Row, anchor: HTMLElement): void => {
    openMenuAt(anchor, [
      ...agentIds
        .filter((a) => a !== r.agentId)
        .map((a) => ({
          label: `安装到 ${labelOf(a)}`,
          onSelect: () => void installToOne(r.skill, a)
        })),
      { label: '打开目录', onSelect: () => void window.warp.skills.reveal(r.skill.agentId, r.skill.name).catch((e: unknown) => notifyError(e, '打开失败')) },
      ...(r.skill.isBuiltin ? [] : [{ label: '卸载', onSelect: () => void uninstallOne(r.skill) }])
    ])
  }

  return (
    <div className="dialog-backdrop fixed inset-0 z-40 grid place-items-center" onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Skills 管理"
        data-testid="skills-dialog"
        className="flex h-[min(720px,calc(100vh-64px))] w-[min(1060px,calc(100vw-64px))] flex-col overflow-hidden rounded-card border border-line bg-panel shadow-[var(--shadow-modal)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 顶栏：tab 切换「我的 Skill / 安装 Skill」 */}
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
          <div role="tablist" aria-label="Skills 视图" className="flex h-8 shrink-0 items-center gap-0.5 rounded-pill bg-raised p-0.5">
            <TabBtn active={tab === 'list'} onClick={() => setTab('list')} label="我的 Skill" />
            <TabBtn active={tab === 'install'} onClick={() => setTab('install')} label="安装 Skill" />
          </div>
          {tab === 'list' && (
            <>
              <MagnifyingGlass size={16} aria-hidden="true" className="shrink-0 text-ink-faint" />
              <input
                ref={searchRef}
                data-testid="skills-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索名称或描述"
                aria-label="搜索 skill"
                className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-ink-strong outline-none placeholder:text-ink-faint"
              />
              <Button onClick={() => void scan()} disabled={busy || loading}>
                <ArrowsClockwise size={16} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
                重新扫描
              </Button>
            </>
          )}
          {tab === 'install' && <div className="min-w-0 flex-1" />}
          <IconButton label="关闭" onClick={onClose} data-testid="skills-close">
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左栏：agent 筛选 */}
          <div className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line p-2" data-testid="skills-agents">
            <AgentChip active={agent === ALL} onClick={() => setAgent(ALL)} label="全部" count={rows.length} testId="skills-agent-all" />
            {agentIds.map((a) => (
              <AgentChip
                key={a}
                active={agent === a}
                onClick={() => setAgent(a)}
                label={labelOf(a)}
                count={agentCounts[a]}
                icon={iconOf(a)}
                testId={`skills-agent-${a}`}
              />
            ))}
          </div>

          {/* 右侧：列表 + 详情 / 安装页 */}
          <div className="flex min-w-0 flex-1">
            {tab === 'install' ? (
              <InstallPane
                onDone={async (res) => {
                  if (res.failed.length > 0) notifyError(new Error(res.failed[0].reason), '安装失败')
                  await scan()
                  setTab('list')
                }}
                agentIds={agentIds}
              />
            ) : (
            <div className="min-w-0 flex-1 overflow-y-auto p-3" data-testid="skills-list">
              {error && <p className="px-2 py-6 text-center text-[13px] text-ink-muted" data-testid="skills-error">{error}</p>}
              {loading && !data && <p className="px-2 py-6 text-center text-[13px] text-ink-muted">扫描中…</p>}
              {data && filtered.length === 0 && (
                <p className="px-2 py-6 text-center text-[13px] text-ink-muted" data-testid="skills-empty">
                  {query ? '没有匹配的 skill' : '没有扫描到 skill'}
                </p>
              )}
              <div className="flex flex-col gap-1">
                {filtered.slice(0, shown).map((r) => (
                  <SkillRow
                    key={`${r.agentId}:${r.skill.rel}`}
                    row={r}
                    selected={selected?.agentId === r.agentId && selected?.name === r.skill.name}
                    onSelect={() => setSelected({ agentId: r.agentId, name: r.skill.name })}
                    onMenu={(anchor) => menuFor(r, anchor)}
                  />
                ))}
              </div>
              {filtered.length > shown && (
                <button
                  type="button"
                  onClick={() => setShown((n) => n + BATCH)}
                  className="mx-auto mt-3 block rounded-control px-3 py-1.5 text-[12px] font-semibold text-accent hover:bg-raised"
                >
                  显示其余 {filtered.length - shown} 项
                </button>
              )}
            </div>
            )}

            {selected && tab === 'list' && <SkillDetailPane agentId={selected.agentId} name={selected.name} onClose={() => setSelected(null)} />}
          </div>
        </div>
      </div>
    </div>
  )
}

function AgentChip({ active, onClick, label, count, icon, testId }: {
  active: boolean
  onClick: () => void
  label: string
  count: number
  icon?: string | null
  testId: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`flex h-8 items-center gap-2 rounded-control px-2 text-[13px] ${active ? 'bg-accent-soft font-semibold text-ink-strong' : 'text-ink hover:bg-raised'}`}
    >
      {icon && <img src={icon} alt="" draggable={false} className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className="shrink-0 text-[12px] text-ink-faint">{count}</span>
    </button>
  )
}

function SkillRow({ row, selected, onSelect, onMenu }: {
  row: Row
  selected: boolean
  onSelect: () => void
  onMenu: (anchor: HTMLElement) => void
}): React.JSX.Element {
  const icon = iconOf(row.agentId)
  const menuRef = useRef<HTMLButtonElement>(null)
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={`skill-row-${row.agentId}-${row.skill.name}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className={`flex cursor-pointer items-center gap-3 rounded-control border px-3 py-2 ${selected ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-raised'}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-ink-strong">{row.skill.name}</span>
          {row.skill.isBuiltin && <span className="shrink-0 rounded-pill bg-raised px-1.5 text-[12px] text-ink-muted">内置</span>}
        </div>
        {row.skill.description && <p className="mt-0.5 line-clamp-1 text-[12px] text-ink-muted">{row.skill.description}</p>}
      </div>
      <span className="shrink-0 text-[12px] text-ink-faint">{formatSize(row.skill.sizeBytes)}</span>
      {/* 跨根徽章：这个 skill 还在哪些 agent 有（顺序放本 agent 图标前） */}
      {row.alsoIn.map((a) => {
        const ic = iconOf(a)
        return ic ? <img key={a} src={ic} alt={labelOf(a)} title={`也在 ${labelOf(a)}`} draggable={false} className="size-4 shrink-0 opacity-70" /> : null
      })}
      {icon && <img src={icon} alt={labelOf(row.agentId)} title={labelOf(row.agentId)} draggable={false} className="size-4 shrink-0" />}
      <IconButton
        label="更多操作"
        onClick={(e) => {
          e.stopPropagation()
          onMenu(menuRef.current ?? (e.currentTarget as HTMLElement))
        }}
      >
        <span ref={menuRef} className="flex" aria-hidden="true">
          <MoreIcon />
        </span>
      </IconButton>
    </div>
  )
}

function MoreIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M140,128a12,12,0,1,1-12-12A12,12,0,0,1,140,128Zm-12-52a12,12,0,1,0-12-12A12,12,0,0,0,128,76Zm0,104a12,12,0,1,0,12,12A12,12,0,0,0,128,180Z" />
    </svg>
  )
}

function SkillDetailPane({ agentId, name, onClose }: { agentId: string; name: string; onClose: () => void }): React.JSX.Element {
  const [data, setData] = useState<{ filename: string; body: string; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(null)
    setData(null)
    window.warp.skills
      .detail(agentId, name)
      .then((d) => {
        if (alive) setData(d)
      })
      .catch((e: unknown) => {
        if (alive) setError(errorText(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [agentId, name])

  return (
    <div className="flex w-[46%] min-w-0 shrink-0 flex-col border-l border-line" data-testid="skills-detail">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink-strong">{name}</span>
        <span className="shrink-0 text-[12px] text-ink-faint">{labelOf(agentId)}</span>
        <IconButton label="关闭详情" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-3">
        <Button onClick={() => void window.warp.skills.reveal(agentId, name).catch((e: unknown) => notifyError(e, '打开失败'))}>
          <FolderOpen size={16} aria-hidden="true" />
          打开目录
        </Button>
      </div>
      {loading && <p className="px-4 py-6 text-center text-[13px] text-ink-muted">读取中…</p>}
      {error && <p className="px-4 py-6 text-[13px] text-ink-muted" data-testid="skills-detail-error">{error}</p>}
      {data && (
        <Suspense fallback={<p className="px-4 py-6 text-center text-[13px] text-ink-muted">加载渲染器…</p>}>
          {/* 首版禁图（拍板问题 3）：MarkdownView 的相对图片读取按 workspaceId 校验，skill 无 workspaceId 会失败并降级为占位文字，符合预期 */}
          <MarkdownView workspaceId="" rel={`${name}/SKILL.md`} content={data.body} />
        </Suspense>
      )}
      {data?.truncated && <p className="border-t border-line px-3 py-1.5 text-[12px] text-ink-faint">文件过长，已截断显示</p>}
    </div>
  )
}

function TabBtn({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`h-7 rounded-pill px-3 text-[12px] font-semibold ${active ? 'bg-panel text-ink-strong shadow-[0_1px_3px_rgba(0,0,0,0.08)]' : 'text-ink-muted hover:text-ink-strong'}`}
    >
      {label}
    </button>
  )
}

const FIELD =
  'h-9 w-full rounded-control border border-line bg-card px-3 text-[13px] text-ink-strong outline-none transition-colors duration-150 focus:border-accent'

/**
 * 安装页（PRD SK-06/07）：GitHub URL 或本地 zip。
 * URL 先 parseGithubUrl 预览解析结果，选目标 agent 后安装；zip 由主进程弹对话框选（路径不出渲染层）。
 */
function InstallPane({ onDone, agentIds }: {
  onDone: (res: SkillsInstallResult) => Promise<void>
  agentIds: string[]
}): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [parsed, setParsed] = useState<{ owner: string; repo: string; branch: string; subpath: string; canonical: string } | null>(null)
  const [parseErr, setParseErr] = useState<string | null>(null)
  const [targets, setTargets] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  // 主进程选出的 zip：只拿一次性 token + 文件名，路径不进渲染层；token 安装一次即作废
  const [zip, setZip] = useState<{ token: string; name: string } | null>(null)

  const toggle = (id: string): void => setTargets((ts) => (ts.includes(id) ? ts.filter((x) => x !== id) : [...ts, id]))

  const checkUrl = async (): Promise<void> => {
    setParseErr(null)
    setParsed(null)
    try {
      setParsed(await window.warp.skills.parseGithubUrl(url))
    } catch (e) {
      setParseErr(errorText(e))
    }
  }

  const install = async (): Promise<void> => {
    if (targets.length === 0 || busy) return
    setBusy(true)
    try {
      if (zip) {
        const picked = zip
        // token 用一次就作废（成败都是）：先清掉，失败后要重新选文件
        setZip(null)
        onDone(await window.warp.skills.installZip(picked.token, targets, 'overwrite'))
      } else if (parsed) {
        onDone(await window.warp.skills.installGithub(parsed.canonical, targets, 'overwrite'))
      }
    } catch (e) {
      notifyError(e, '安装失败')
    } finally {
      setBusy(false)
    }
  }

  const pickZip = async (): Promise<void> => {
    const p = await window.warp.skills.pickZip()
    if (p) {
      setZip(p)
      setUrl('')
      setParsed(null)
      setParseErr(null)
    }
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-4" data-testid="skills-install">
      <h3 className="text-[14px] font-semibold text-ink-strong">从 GitHub 安装</h3>
      <p className="mt-1 text-[12px] text-ink-muted">粘贴仓库地址，找仓库里含 SKILL.md 的目录装到指定 agent。</p>
      <div className="mt-2 flex gap-2">
        <input
          data-testid="skills-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="owner/repo 或 https://github.com/owner/repo/tree/main/subdir"
          aria-label="GitHub 仓库地址"
          className={`${FIELD} min-w-0 flex-1`}
          disabled={busy || zip != null}
        />
        <Button onClick={() => void checkUrl()} disabled={busy || !url.trim() || zip != null}>
          解析
        </Button>
      </div>
      {parseErr && <p className="mt-2 text-[12px] text-ink-muted" data-testid="skills-url-error">{parseErr}</p>}
      {parsed && (
        <div className="mt-2 rounded-control border border-line bg-card px-3 py-2 text-[12px]" data-testid="skills-url-parsed">
          <span className="font-semibold text-ink-strong">{parsed.owner}/{parsed.repo}</span>
          <span className="ml-2 text-ink-muted">分支 {parsed.branch}</span>
          {parsed.subpath && <span className="ml-2 text-ink-muted">子目录 {parsed.subpath}</span>}
        </div>
      )}

      <h3 className="mt-5 text-[14px] font-semibold text-ink-strong">从本地 zip 导入</h3>
      <div className="mt-2 flex gap-2">
        <Button onClick={() => void pickZip()} disabled={busy}>
          <DownloadSimple size={16} aria-hidden="true" />
          选择 zip 文件
        </Button>
        {zip && (
          <span className="flex items-center text-[12px] text-ink-muted" data-testid="skills-zip-picked">
            {zip.name}
            <IconButton
              label="移除所选 zip"
              onClick={() => setZip(null)}
            >
              <X size={16} aria-hidden="true" />
            </IconButton>
          </span>
        )}
      </div>

      <h3 className="mt-5 text-[14px] font-semibold text-ink-strong">安装到</h3>
      <div className="mt-2 flex flex-wrap gap-1.5" data-testid="skills-install-targets">
        {agentIds.map((a) => {
          const ic = iconOf(a)
          return (
            <button
              key={a}
              type="button"
              onClick={() => toggle(a)}
              aria-pressed={targets.includes(a)}
              className={`flex h-8 items-center gap-1.5 rounded-pill border px-3 text-[12px] ${targets.includes(a) ? 'border-accent bg-accent-soft font-semibold text-ink-strong' : 'border-line text-ink hover:bg-raised'}`}
            >
              {ic && <img src={ic} alt="" draggable={false} className="size-4" />}
              {labelOf(a)}
            </button>
          )
        })}
      </div>

      <div className="mt-5">
        <Button onClick={() => void install()} disabled={busy || targets.length === 0 || (!parsed && !zip)}>
          安装（{targets.length} 个目标）
        </Button>
        <p className="mt-2 text-[12px] text-ink-faint">同名 skill 会先备份旧目录为 .bak-时间戳 再覆盖。</p>
      </div>
    </div>
  )
}
