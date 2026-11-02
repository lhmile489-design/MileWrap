import {
  Broadcast,
  Check,
  ArrowCounterClockwise,
  Columns,
  Desktop,
  FloppyDisk,
  FolderSimple,
  Gear,
  GridFour,
  Layout,
  MagnifyingGlass,
  Minus,
  Moon,
  SidebarSimple,
  Square,
  Sun,
  X,
  type Icon
} from '@phosphor-icons/react'
import type { GridMode, Settings } from '@shared/types'
import { useConfig } from '../store/config'
import { railsOf, useLayout } from '../store/layout'
import { useUi } from '../store/ui'
import { IconButton } from './ui'
import { RestorePill } from './RestoreCard'
import logoUrl from '../assets/logo.png'
import { notifyError } from './ConfirmDialog'
import { openMenuAt, type MenuItem } from './Menu'
import { applyPreset, savePresetPrompt, toggleBroadcast } from './actions'

const THEME_LABEL: Record<Settings['theme'], string> = { system: '跟随系统', light: '浅色', dark: '深色' }

/** 主题菜单（PRD S-01）：当前项打勾 */
function themeMenu(current: Settings['theme']): MenuItem[] {
  return (['system', 'light', 'dark'] as const).map((t) => ({
    label: THEME_LABEL[t],
    icon: t === current ? <Check size={16} /> : undefined,
    onSelect: () => void useConfig.getState().updateSettings({ theme: t }).catch((e: unknown) => notifyError(e))
  }))
}

/** 布局预设（升级建议 3.1）：选一个就切宫格并在各格启动对应工作区 */
function presetMenu(): MenuItem[] {
  const presets = useConfig.getState().config?.layoutPresets ?? []
  const items: MenuItem[] = presets.map((p) => ({ label: p.name, icon: <Layout size={16} />, onSelect: () => void applyPreset(p) }))
  if (items.length) items.push({ kind: 'separator' })
  items.push({ label: '把当前布局存为预设…', icon: <FloppyDisk size={16} />, onSelect: savePresetPrompt })
  return items
}

const MODES: { mode: GridMode; label: string; icon: Icon }[] = [
  { mode: 'single', label: '单格', icon: Square },
  { mode: 'dual', label: '左右两格', icon: Columns },
  { mode: 'quad', label: '四宫格', icon: GridFour }
]

/**
 * 自绘标题栏（UI设计约束 §4.4）。左：品牌、会话栏 / 目录栏显隐、宫格切换；
 * 中：全局搜索触发框（命令面板）、恢复入口；右：主题、设置、窗口控件。
 */
export function TitleBar(): React.JSX.Element {
  const railCollapsed = useLayout((s) => railsOf(s).railCollapsed)
  const fileShown = useLayout((s) => railsOf(s).fileShown)
  const toggleRail = useLayout((s) => s.toggleRail)
  const toggleFileRail = useLayout((s) => s.toggleFileRail)
  const gridMode = useLayout((s) => s.gridMode)
  const setGridMode = useLayout((s) => s.setGridMode)
  const setPaletteOpen = useUi((s) => s.setPaletteOpen)
  const broadcast = useUi((s) => s.broadcast)
  const openSettings = useUi((s) => s.openSettings)
  const openHistory = useUi((s) => s.openHistory)
  const theme = useConfig((s) => s.config?.settings.theme ?? 'system')
  const ThemeIcon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Desktop

  return (
    <header className="app-drag flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel pl-3">
      <div className="flex items-center gap-2 font-display text-[13px] font-extrabold text-ink-strong">
        <img src={logoUrl} alt="" draggable={false} className="size-[22px] shrink-0 select-none" data-testid="app-logo" />
        Mile Warp
      </div>
      <div className="app-no-drag ml-2 flex items-center gap-0.5">
        <IconButton label="会话栏（Ctrl+Shift+B）" pressed={!railCollapsed} onClick={toggleRail}>
          <SidebarSimple size={16} />
        </IconButton>
        <IconButton label="目录栏（Ctrl+Shift+E）" pressed={fileShown} onClick={toggleFileRail}>
          <FolderSimple size={16} />
        </IconButton>
        {/* 宫格切换（PRD T-02）：分段控件，方向键在三项之间移动 */}
        <div
          role="radiogroup"
          aria-label="宫格布局（Ctrl+Shift+D 循环切换）"
          className="ml-2 flex h-7 items-center gap-0.5 rounded-pill bg-raised p-0.5"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            const i = MODES.findIndex((m) => m.mode === gridMode)
            const next = MODES[(i + (e.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length]
            setGridMode(next.mode)
            ;(e.currentTarget.querySelector(`[data-grid-mode="${next.mode}"]`) as HTMLElement | null)?.focus()
          }}
        >
          {MODES.map(({ mode, label, icon: ModeIcon }) => {
            const on = gridMode === mode
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={label}
                title={label}
                tabIndex={on ? 0 : -1}
                data-grid-mode={mode}
                onClick={() => setGridMode(mode)}
                className={`grid h-6 w-8 place-items-center rounded-pill transition-colors duration-150 ${
                  on ? 'bg-card text-ink-strong shadow-[var(--shadow-lift)]' : 'text-ink-muted hover:text-ink-strong'
                }`}
              >
                <ModeIcon size={16} />
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2 px-2">
        {/* 全局搜索触发框（UI设计约束 §4.4）：点开是命令面板 */}
        <button
          type="button"
          data-testid="palette-trigger"
          aria-label="搜索会话、Agent（Ctrl+Shift+K）"
          onClick={() => setPaletteOpen(true)}
          className="app-no-drag flex h-[30px] w-[360px] max-w-[40vw] min-w-0 items-center gap-2 rounded-control border border-line bg-sunken px-3 text-left transition-colors duration-150 hover:border-line-strong"
        >
          <MagnifyingGlass size={16} aria-hidden="true" className="shrink-0 text-ink-faint" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink-faint">搜索会话、Agent…</span>
          {/* 窗口窄于 1280 时收起键帽，给搜索框和恢复入口让位 */}
          <kbd className="shrink-0 rounded-badge border border-line bg-card px-1.5 font-mono text-[12px] text-ink-muted max-xl:hidden">Ctrl+Shift+K</kbd>
        </button>
        <RestorePill />
        <IconButton label={broadcast ? '广播输入已开启，点击关闭' : '广播输入'} pressed={broadcast} danger={broadcast} onClick={() => void toggleBroadcast()}>
          <Broadcast size={16} />
        </IconButton>
        <IconButton label="布局预设" onClick={(e) => openMenuAt(e.currentTarget, presetMenu())}>
          <Layout size={16} />
        </IconButton>
        <IconButton label="会话历史（Ctrl+Shift+H）" onClick={() => openHistory()}>
          <ArrowCounterClockwise size={16} />
        </IconButton>
      </div>
      <div className="app-no-drag flex items-center gap-0.5 pr-1">
        <IconButton label={`主题：${THEME_LABEL[theme]}`} onClick={(e) => openMenuAt(e.currentTarget, themeMenu(theme))}>
          <ThemeIcon size={16} />
        </IconButton>
        <IconButton label="设置（Ctrl+,）" onClick={() => openSettings()}>
          <Gear size={16} />
        </IconButton>
      </div>
      <div className="app-no-drag flex h-full items-center">
        <WindowButton label="最小化" onClick={() => window.warp.window.minimize()}>
          <Minus size={16} />
        </WindowButton>
        <WindowButton label="最大化" onClick={() => window.warp.window.maximize()}>
          <Square size={16} />
        </WindowButton>
        <WindowButton label="关闭" danger onClick={() => window.warp.window.close()}>
          <X size={16} />
        </WindowButton>
      </div>
    </header>
  )
}

function WindowButton({
  label,
  onClick,
  danger = false,
  children
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid h-full w-[46px] place-items-center text-ink-muted transition-colors duration-150 ${
        danger ? 'hover:bg-fault hover:text-ink-inverse' : 'hover:bg-raised hover:text-ink-strong'
      }`}
    >
      {children}
    </button>
  )
}
