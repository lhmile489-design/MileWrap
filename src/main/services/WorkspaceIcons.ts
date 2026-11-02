import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dialog, nativeImage, type BrowserWindow } from 'electron'
import { atomicWrite } from '../lib/atomicWrite'

const SIZE = 128
const MAX_BYTES = 5 * 1024 * 1024
const TOKEN_TTL_MS = 10 * 60 * 1000
const TOKEN_RE = /^[0-9a-f-]{36}$/
const ID_RE = /^[A-Za-z0-9-]{1,64}$/

/**
 * 工作区自定义图标。渲染层不经手任何路径：
 *   1. workspace:pickIcon：主进程弹系统文件对话框，读图、居中裁成正方形、缩到 128×128 PNG，
 *      暂存在内存里，只把一个一次性 token 和预览用的 data URL 交给渲染层
 *   2. workspace:create / edit 带上 iconToken 时才真正写盘：icons/<workspaceId>.png
 * Workspace.icon 存的是图片内容的短哈希，渲染层据此判断缓存是否过期。
 */
export class WorkspaceIcons {
  private readonly dir: string
  private pending = new Map<string, { png: Buffer; at: number }>()

  /**
   * @param testFile 仅开发期验证脚本用（MILE_WARP_TEST_ICON）：pick() 跳过系统对话框直接读这个文件。
   *                 打包版由调用方传 undefined。
   */
  constructor(
    baseDir: string,
    private readonly testFile?: string
  ) {
    this.dir = join(baseDir, 'icons')
    mkdirSync(this.dir, { recursive: true })
  }

  async pick(win: BrowserWindow | null): Promise<{ token: string; dataUrl: string } | null> {
    const file = this.testFile ?? (await this.choose(win))
    if (!file) return null
    if (statSync(file).size > MAX_BYTES) throw new Error('图片不能超过 5MB')
    const png = normalize(file)
    this.sweep()
    const token = randomUUID()
    this.pending.set(token, { png, at: Date.now() })
    return { token, dataUrl: toDataUrl(png) }
  }

  /**
   * 把暂存的图写成某个工作区的图标，返回内容哈希（Workspace.icon）。
   * 不作废 token：配置写成功后由调用方 consume()，失败时用户不必重新选图。
   */
  commit(workspaceId: string, token: unknown): string {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new Error('图标参数不合法')
    const item = this.pending.get(token)
    if (!item) throw new Error('所选图片已过期，请重新选择')
    atomicWrite(this.fileOf(workspaceId), item.png)
    return hashOf(item.png)
  }

  /** 配置已落盘：token 作废，不能再用 */
  consume(token: string | null | undefined): void {
    if (token) this.pending.delete(token)
  }

  /**
   * 记下某个工作区图标文件的当前状态（内容或不存在），返回还原函数。
   * 配置写失败时调用，让磁盘上的图标回到改动之前，与配置里的哈希一致。
   */
  snapshot(workspaceId: string): () => void {
    const file = this.fileOf(workspaceId)
    let before: Buffer | null = null
    try {
      before = existsSync(file) ? readFileSync(file) : null
    } catch {
      before = null
    }
    return () => {
      try {
        if (before) atomicWrite(file, before)
        else rmSync(file, { force: true })
      } catch {
        // 还原失败不掩盖原来的错误
      }
    }
  }

  remove(workspaceId: string): void {
    try {
      rmSync(this.fileOf(workspaceId), { force: true })
    } catch {
      // 删不掉也不影响配置
    }
  }

  copy(fromId: string, toId: string): boolean {
    const src = this.fileOf(fromId)
    if (!existsSync(src)) return false
    copyFileSync(src, this.fileOf(toId))
    return true
  }

  /** 渲染层显示用：data URL（CSP 只放行 self 与 data:） */
  read(workspaceId: string): string | null {
    const file = this.fileOf(workspaceId)
    if (!existsSync(file)) return null
    try {
      return toDataUrl(readFileSync(file))
    } catch {
      return null
    }
  }

  private async choose(win: BrowserWindow | null): Promise<string | null> {
    const opts = {
      title: '选择工作区图标',
      properties: ['openFile' as const],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'ico'] }]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || r.filePaths.length === 0) return null
    return r.filePaths[0]
  }

  private fileOf(workspaceId: string): string {
    if (!ID_RE.test(workspaceId)) throw new Error('工作区 id 不合法')
    return join(this.dir, `${workspaceId}.png`)
  }

  private sweep(): void {
    const now = Date.now()
    for (const [t, v] of this.pending) if (now - v.at > TOKEN_TTL_MS) this.pending.delete(t)
  }
}

/** 读图 → 居中裁正方形 → 128×128 PNG；读不出来的（损坏、格式不支持）直接报错 */
function normalize(file: string): Buffer {
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) throw new Error('无法读取这张图片，请换一张 PNG / JPG / ICO')
  const { width, height } = img.getSize()
  const side = Math.min(width, height)
  const square = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side })
  return square.resize({ width: SIZE, height: SIZE, quality: 'best' }).toPNG()
}

function toDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

function hashOf(png: Buffer): string {
  return createHash('sha1').update(png).digest('hex').slice(0, 12)
}
