import { watch, type FSWatcher } from 'node:fs'
import { readdir, realpath, stat, lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { FileEntry } from '@shared/types'
import type { ConfigStore } from './ConfigStore'

const MAX_ENTRIES = 2000
const MAX_REL_LEN = 1024
/** 只 watch 已展开的层级，非递归；上限防句柄失控（升级建议 3.7） */
const MAX_WATCHED = 64
const UNWATCHED = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target'])
const STAT_CONCURRENCY = 16

/**
 * 目录栏（技术设计 §6.4）：只读、懒加载。渲染层只给 workspaceId + 相对路径，
 * 绝对路径由主进程拼出并经 realpath 校验仍在工作区目录内，越界一律拒绝、不回退。
 */
export class FileTreeService {
  /** workspaceId -> (相对路径 -> watcher) */
  private watchers = new Map<string, Map<string, FSWatcher>>()

  constructor(
    private config: ConfigStore,
    /** 有变化时通知渲染层（只提示「有更新」，不自动重读） */
    private onChanged: (workspaceId: string) => void = () => undefined
  ) {}

  async list(input: unknown): Promise<FileEntry[]> {
    const { root, target } = await this.locate(input)
    const st = await stat(target)
    if (!st.isDirectory()) throw new Error('不是目录')

    const dirents = await readdir(target, { withFileTypes: true })
    // 每项要 lstat + stat：逐个 await 时 2000 项要四百多毫秒，改成限并发并行（libuv 线程池默认 4 线程，并发再高也没用）
    const out = await mapLimit(dirents.slice(0, MAX_ENTRIES), STAT_CONCURRENCY, async (d): Promise<FileEntry> => {
      const full = join(target, d.name)
      let kind: FileEntry['kind'] = d.isDirectory() ? 'dir' : 'file'
      let size = 0
      let mtime = 0
      let link = false
      try {
        // 联接点（junction）在 lstat 下也报 symlink；只有指向工作区之外的才标 link（不可展开）
        if ((await lstat(full)).isSymbolicLink()) link = !inside(root, await realpath(full))
        const s = await stat(full)
        kind = s.isDirectory() ? 'dir' : 'file'
        size = s.isDirectory() ? 0 : s.size
        mtime = s.mtimeMs
      } catch {
        // 读不到元信息（权限、悬空链接）：照常列出名字，标为不可展开
        link = true
      }
      return { name: d.name, kind, size, mtime, link }
    })
    out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.kind === 'dir' ? -1 : 1))
    return out
  }

  /** 返回校验过的绝对路径，供「在资源管理器中显示」 */
  async resolvePath(input: unknown): Promise<string> {
    return (await this.locate(input)).target
  }

  /**
   * 设定某个工作区要 watch 的目录（替换上一次的集合）。非递归，只看已展开的层级；
   * node_modules、.git 这类灰化目录不 watch。空数组 = 全部停止。
   */
  async watchDirs(input: unknown): Promise<void> {
    const r = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const workspaceId = r.workspaceId
    if (typeof workspaceId !== 'string') throw new Error('workspaceId 不合法')
    const list = r.relativePaths
    if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) throw new Error('目录列表不合法')
    const wanted = [...new Set(list as string[])]
      .filter((rel) => !rel.split('/').some((seg) => UNWATCHED.has(seg)))
      .slice(0, MAX_WATCHED)
    const cur = this.watchers.get(workspaceId) ?? new Map<string, FSWatcher>()
    for (const [rel, w] of cur) {
      if (!wanted.includes(rel)) {
        w.close()
        cur.delete(rel)
      }
    }
    for (const rel of wanted) {
      if (cur.has(rel)) continue
      try {
        const { target } = await this.locate({ workspaceId, relativePath: rel })
        const w = watch(target, { persistent: false }, () => this.onChanged(workspaceId))
        w.on('error', () => {
          w.close()
          cur.delete(rel)
        })
        cur.set(rel, w)
      } catch {
        // 目录没了、越界、权限不足：跳过
      }
    }
    if (cur.size) this.watchers.set(workspaceId, cur)
    else this.watchers.delete(workspaceId)
  }

  unwatchAll(): void {
    for (const m of this.watchers.values()) for (const w of m.values()) w.close()
    this.watchers.clear()
  }

  private async locate(input: unknown): Promise<{ root: string; target: string }> {
    const r = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const workspaceId = r.workspaceId
    if (typeof workspaceId !== 'string') throw new Error('workspaceId 不合法')
    const rel = typeof r.relativePath === 'string' ? r.relativePath : ''
    if (rel.length > MAX_REL_LEN || rel.includes('\0')) throw new Error('路径不合法')
    if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error('只接受相对路径')

    const ws = this.config.get().workspaces.find((w) => w.id === workspaceId)
    if (!ws) throw new Error('工作区不存在')
    const root = await realpath(ws.cwd)
    const joined = resolve(root, rel)
    if (!inside(root, joined)) throw new Error('路径越出工作区目录')
    const target = await realpath(joined)
    if (!inside(root, target)) throw new Error('路径越出工作区目录')
    return { root, target }
  }
}

/** 按原顺序返回结果，同时最多 limit 个在跑 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** 大小写不敏感比较，Windows 盘符统一大写（技术设计 §6.4） */
function inside(root: string, p: string): boolean {
  const norm = (x: string): string => x.replace(/^[a-z]:/, (m) => m.toUpperCase()).toLowerCase()
  const rel = relative(norm(root), norm(p))
  // 跨盘符时 relative 返回绝对路径，isAbsolute 兜住
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}
