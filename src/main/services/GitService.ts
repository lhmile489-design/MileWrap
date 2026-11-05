import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git'
import type { GitFile, GitFileStatus, GitProbe, GitStatus } from '@shared/types'
import type { ConfigStore } from './ConfigStore'
import { envFromProcess, whichCommand } from '../lib/commandResolver'
import { log } from '../lib/log'

/** 本地命令超时（Git管理-PRD §6.2 第 6 条）；远端命令在 G2 另设 */
const LOCAL_TIMEOUT_MS = 15_000

/** 会让 git 子进程弹窗、改执行路径或换 ssh 的变量，一律不传（移植自源项目） */
const STRIP_ENV = ['GIT_EDITOR', 'EDITOR', 'VISUAL', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']

/**
 * 每条命令前缀的 -c 配置：
 * - core.fsmonitor=false：仓库配置里的 fsmonitor 是任意命令，git status 会执行它
 * - core.quotepath=false：中文路径不转义成 \344\270…
 */
const SAFE_CONFIG = ['core.fsmonitor=false', 'core.quotepath=false']

const INDEX_STATUS: Record<string, GitFileStatus> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified' }

/**
 * Git 管理（Git管理-PRD）。渲染层只给 workspaceId，仓库目录从配置里的 cwd 求；
 * settings.gitEnabled 为 false 时不执行任何 git 命令（G-01）。
 */
export class GitService {
  /** undefined = 还没找过；null = PATH 里没有 git.exe */
  private binary: string | null | undefined

  constructor(private config: ConfigStore) {}

  enabled(): boolean {
    return this.config.get().settings.gitEnabled === true
  }

  /** 设置里切换开关或 PATH 变了之后重新找 git.exe */
  resetBinary(): void {
    this.binary = undefined
  }

  async probe(input: unknown): Promise<GitProbe> {
    const cwd = this.workspaceCwd(input)
    if (!this.enabled()) return { available: false, reason: 'disabled' }
    const bin = this.gitBinary()
    if (!bin) return { available: false, reason: 'no-git' }
    try {
      const g = this.client(bin, cwd)
      const top = (await g.raw(['rev-parse', '--show-toplevel'])).trim()
      const prefix = (await g.raw(['rev-parse', '--show-prefix'])).trim().replace(/\/$/, '')
      const repoName = top.split('/').filter(Boolean).pop() ?? top
      return { available: true, repoName, relativeDir: prefix }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/not a git repository/i.test(msg)) return { available: false, reason: 'not-repo' }
      if (/dubious ownership/i.test(msg)) return { available: false, reason: 'error', message: '仓库所有者与当前用户不一致，git 拒绝操作（safe.directory）' }
      log('git.probe.fail', { reason: firstLine(msg) })
      return { available: false, reason: 'error', message: firstLine(msg) }
    }
  }

  async status(input: unknown): Promise<GitStatus> {
    const { g } = await this.repo(input)
    const s = await run(() => g.status())
    let branch = s.current ?? 'HEAD'
    if (s.detached) branch = (await run(() => g.raw(['rev-parse', '--short', 'HEAD']))).trim() || branch
    let hasRemote = !!s.tracking
    if (!hasRemote) hasRemote = (await run(() => g.getRemotes(false))).length > 0
    return { branch, detached: s.detached, ahead: s.ahead, behind: s.behind, upstream: s.tracking ?? null, hasRemote, files: mapFiles(s) }
  }

  /** 开关、git.exe、仓库根三道检查都过了才返回 client；baseDir 是仓库根 */
  private async repo(input: unknown): Promise<{ g: SimpleGit; root: string }> {
    const cwd = this.workspaceCwd(input)
    if (!this.enabled()) throw new Error('未启用 Git 管理')
    const bin = this.gitBinary()
    if (!bin) throw new Error('找不到 git，请先安装 Git for Windows')
    const top = await run(() => this.client(bin, cwd).raw(['rev-parse', '--show-toplevel']))
    const root = top.trim()
    return { g: this.client(bin, root), root }
  }

  private workspaceCwd(input: unknown): string {
    const id = input && typeof input === 'object' ? (input as Record<string, unknown>).workspaceId : undefined
    if (typeof id !== 'string') throw new Error('workspaceId 不合法')
    const ws = this.config.get().workspaces.find((w) => w.id === id)
    if (!ws) throw new Error('工作区不存在')
    return ws.cwd
  }

  private gitBinary(): string | null {
    if (this.binary === undefined) {
      // 只认 git.exe：.cmd 壳要经 cmd.exe 才能跑，这里不走 shell
      const p = whichCommand('git.exe', envFromProcess(process.env))
      this.binary = p ? p.replace(/\\/g, '/') : null
    }
    return this.binary
  }

  private client(bin: string, baseDir: string): SimpleGit {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STRIP_ENV.includes(k)) env[k] = v
    // simple-git 的 binary 校验不允许空格（C:/Program Files/...），路径是主进程从 PATH 找到的，不来自渲染层；
    // 放行时它会 console.warn 一次，这里静音
    const warn = console.warn
    console.warn = () => undefined
    try {
      return simpleGit({
        baseDir,
        binary: bin,
        maxConcurrentProcesses: 4,
        config: SAFE_CONFIG,
        timeout: { block: LOCAL_TIMEOUT_MS },
        unsafe: { allowUnsafeCustomBinary: true, allowUnsafeFsMonitor: true }
      }).env({
        ...env,
        // 无 tty：不弹密码框、不开编辑器；status 不抢 index.lock（agent 可能同时在跑 git）
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_MERGE_AUTOEDIT: 'no',
        GIT_OPTIONAL_LOCKS: '0'
      })
    } finally {
      console.warn = warn
    }
  }
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(firstLine(msg) || 'git 执行失败')
  }
}

function firstLine(msg: string): string {
  return msg.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
}

/** 一条 porcelain 记录拆成「已暂存」「未暂存」两行；冲突文件只出一行 */
export function mapFiles(s: StatusResult): GitFile[] {
  const out: GitFile[] = []
  const conflicted = new Set(s.conflicted)
  for (const f of s.files) {
    const path = f.path.replace(/\\/g, '/')
    if (conflicted.has(f.path)) {
      out.push({ path, status: 'conflict', staged: false })
      continue
    }
    if (f.index && f.index !== ' ' && f.index !== '?') {
      const item: GitFile = { path, status: INDEX_STATUS[f.index] ?? 'modified', staged: true }
      if (f.index === 'R' && f.from) item.oldPath = f.from.replace(/\\/g, '/')
      out.push(item)
    }
    if (f.working_dir && f.working_dir !== ' ') {
      out.push({ path, status: f.working_dir === '?' ? 'untracked' : (INDEX_STATUS[f.working_dir] ?? 'modified'), staged: false })
    }
  }
  return out
}
