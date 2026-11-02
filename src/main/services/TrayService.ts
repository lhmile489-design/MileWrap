import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import type { SessionMeta } from '@shared/types'

type Deps = {
  showWindow: () => void
  showSession: (id: string) => void
  quitAll: () => void
  sessions: () => SessionMeta[]
  candidateCount: () => number
}


/**
 * 托盘（PRD S-06，技术设计 §5.7）：显示主窗口 / 运行中的会话 / 恢复上次的会话 / 全部结束并退出。
 * 有运行中会话时图标换成「运行中」样式（右下角绿点），会话数写在 tooltip 里（数字角标列 P2）。
 * 菜单里的结束操作只调 SessionService，不另开命令通道。
 */
export class TrayService {
  private tray: Tray | null = null
  private icons: { idle: NativeImage; active: NativeImage } | null = null

  constructor(
    private deps: Deps,
    /** 应用图标 PNG（resources/icon.png，由 scripts/make-icon.cjs 生成） */
    private iconPath: string
  ) {}

  create(): void {
    if (this.tray) return
    this.icons = { idle: trayIcon(this.iconPath, false), active: trayIcon(this.iconPath, true) }
    this.tray = new Tray(this.icons.idle)
    this.tray.on('click', () => this.deps.showWindow())
    this.tray.on('double-click', () => this.deps.showWindow())
    this.refresh()
  }

  refresh(): void {
    const tray = this.tray
    if (!tray || tray.isDestroyed() || !this.icons) return
    const live = this.deps.sessions().filter((s) => s.status === 'running' || s.status === 'starting')
    tray.setImage(live.length ? this.icons.active : this.icons.idle)
    tray.setToolTip(live.length ? `Mile Warp · ${live.length} 个会话运行中` : 'Mile Warp')
    const items: MenuItemConstructorOptions[] = [
      { label: '显示主窗口', click: () => this.deps.showWindow() },
      {
        label: `运行中的会话（${live.length}）`,
        enabled: live.length > 0,
        submenu: live.length
          ? live.map((s) => ({ label: s.title.replace(/&/g, '&&'), click: () => this.deps.showSession(s.id) }))
          : [{ label: '没有运行中的会话', enabled: false }]
      }
    ]
    const n = this.deps.candidateCount()
    if (n > 0) items.push({ label: `恢复上次的 ${n} 个会话…`, click: () => this.deps.showWindow() })
    items.push({ type: 'separator' }, { label: '全部结束并退出', click: () => this.deps.quitAll() })
    tray.setContextMenu(Menu.buildFromTemplate(items))
  }

  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy()
    this.tray = null
  }
}

/**
 * 托盘图标：缩小应用图标，给 100% 与 200% 缩放各一张；运行中在右下角加绿点（白色描边，深浅任务栏都看得清）。
 * 图标文件读不到时退回一个品牌蓝方块，托盘不至于建不出来。
 */
function trayIcon(iconPath: string, active: boolean): NativeImage {
  const src = nativeImage.createFromPath(iconPath)
  const out = nativeImage.createEmpty()
  for (const [scaleFactor, size] of [
    [1, 16],
    [2, 32]
  ]) {
    let bmp: Buffer
    if (src.isEmpty()) {
      bmp = Buffer.alloc(size * size * 4)
      for (let i = 0; i < bmp.length; i += 4) bmp.set([0xeb, 0x63, 0x25, 0xff], i)
    } else {
      bmp = Buffer.from(src.resize({ width: size, height: size, quality: 'best' }).toBitmap())
    }
    if (active) drawDot(bmp, size)
    out.addRepresentation({ scaleFactor, width: size, height: size, buffer: nativeImage.createFromBitmap(bmp, { width: size, height: size }).toPNG() })
  }
  return out
}

/** 右下角绿点：位图是预乘 alpha 的 BGRA，点是不透明的，直接写颜色即可 */
function drawDot(bmp: Buffer, size: number): void {
  const c = size * 0.76
  const r = size * 0.22
  const ring = size * 0.07
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      if (d > r + ring) continue
      const i = (y * size + x) * 4
      if (d <= r) bmp.set([0x5e, 0xc5, 0x22, 0xff], i) // #22c55e
      else bmp.set([0xff, 0xff, 0xff, 0xff], i)
    }
  }
}
