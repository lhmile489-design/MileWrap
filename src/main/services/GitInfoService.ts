import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { ConfigStore } from './ConfigStore'

const MAX_DEPTH = 32

/**
 * 读 .git/HEAD 得到当前分支（PRD W-16）。只读文件，不执行 git、不碰 hooks。
 * - 从工作区目录向上找 .git（工作区可能是仓库子目录）
 * - .git 是文件（worktree / submodule）时跟随 `gitdir:` 指针
 * - detached HEAD 返回短哈希；非 git 目录返回 null
 */
export class GitInfoService {
  constructor(private config: ConfigStore) {}

  async branch(input: unknown): Promise<string | null> {
    const id = input && typeof input === 'object' ? (input as Record<string, unknown>).workspaceId : undefined
    if (typeof id !== 'string') throw new Error('workspaceId 不合法')
    const ws = this.config.get().workspaces.find((w) => w.id === id)
    if (!ws) throw new Error('工作区不存在')
    return readBranch(ws.cwd)
  }
}

export async function readBranch(cwd: string): Promise<string | null> {
  let dir = resolve(cwd)
  for (let i = 0; i < MAX_DEPTH; i++) {
    const gitDir = await gitDirOf(join(dir, '.git'))
    if (gitDir) return parseHead(await readFile(join(gitDir, 'HEAD'), 'utf8').catch(() => ''))
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

async function gitDirOf(dotGit: string): Promise<string | null> {
  try {
    const st = await stat(dotGit)
    if (st.isDirectory()) return dotGit
    if (!st.isFile()) return null
    const text = await readFile(dotGit, 'utf8')
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(text)
    if (!m) return null
    return isAbsolute(m[1]) ? m[1] : resolve(dirname(dotGit), m[1])
  } catch {
    return null
  }
}

export function parseHead(text: string): string | null {
  const t = text.trim()
  if (!t) return null
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(t)
  if (ref) return ref[1]
  if (/^[0-9a-f]{40,64}$/i.test(t)) return t.slice(0, 7)
  return null
}
