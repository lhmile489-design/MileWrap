import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { lstat, readFile, realpath, rm, stat, unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git'
import type {
  GitBranch,
  GitCommitDetail,
  GitCommitFile,
  GitLogPage,
  GitDiff,
  GitDiffHunk,
  GitDiscardPlan,
  GitFile,
  GitFileStatus,
  GitProbe,
  GitProgress,
  GitRemoteOp,
  GitRemoteResult,
  GitRisk,
  GitStatus
} from '@shared/types'
import type { ConfigStore } from './ConfigStore'
import { envFromProcess, whichCommand } from '../lib/commandResolver'
import { log } from '../lib/log'
import { GitTrust } from './gitRisk'

/** 本地命令超时（Git管理-PRD §6.2 第 6 条）；远端命令在 G2 另设 */
const LOCAL_TIMEOUT_MS = 15_000
/** 远端命令超时（PRD §6.2 第 6 条）：5 分钟，可取消 */
const REMOTE_TIMEOUT_MS = 5 * 60_000
/** 进度推送节流：同一阶段 100ms 内只推一次，到 100% 一定推 */
const PROGRESS_THROTTLE_MS = 100
const ALLOWED_PROTOCOLS = 'file:git:http:https:ssh'
/** 丢弃确认 token 的有效期 */
const DISCARD_TOKEN_MS = 60_000
/** diff 显示上限（G-13）：超过就给「文件太大」空态，不解析 */
const MAX_DIFF_BYTES = 1024 * 1024
const MAX_DIFF_LINES = 5000
/** 一次操作最多的文件数 */
const MAX_PATHS = 2000

/** 会让 git 子进程弹窗、改执行路径或换 ssh 的变量，一律不传（移植自源项目） */
const STRIP_ENV = ['GIT_EDITOR', 'EDITOR', 'VISUAL', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']

/**
 * 每条命令前缀的 -c 配置：
 * - core.fsmonitor=false：仓库配置里的 fsmonitor 是任意命令，git status 会执行它
 * - core.quotepath=false：中文路径不转义成 \344\270…
 */
const SAFE_CONFIG = ['core.fsmonitor=false', 'core.quotepath=false']

/** 渲染层据此认出「要先确认信任」，换成确认面板而不是报错 */
export const RISK_ERROR = '仓库里有会执行命令的配置或钩子，需要先在 Git 栏确认信任'

const INDEX_STATUS: Record<string, GitFileStatus> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified' }

/**
 * Git 管理（Git管理-PRD）。渲染层只给 workspaceId，仓库目录从配置里的 cwd 求；
 * settings.gitEnabled 为 false 时不执行任何 git 命令（G-01）。
 */
export class GitService {
  /** undefined = 还没找过；null = PATH 里没有 git.exe */
  private binary: string | null | undefined

  /** 进行中的远端操作，按仓库根互斥（G-23）：同一仓库同时只跑一个 */
  private running = new Map<string, { workspaceId: string; ac: AbortController }>()

  /** 仓库里会执行命令的配置 / 钩子：用户确认过才放行（审查 2026-11-06 高危项） */
  private trust: GitTrust

  constructor(
    private config: ConfigStore,
    private onProgress: (p: GitProgress) => void = () => undefined,
    dataDir?: string
  ) {
    this.trust = new GitTrust(dataDir ?? tmpdir())
  }

  /** 未确认信任的风险项；没有或已确认返回 null。只读扫描，不执行仓库里的任何东西 */
  async risk(input: unknown): Promise<GitRisk | null> {
    const { g, root } = await this.repo(input, false)
    return this.trust.untrusted(g, root)
  }

  /** 用户在确认框里点了「信任」：带回看到的指纹，和现在重新扫出的一致才记下 */
  async trustRepo(input: unknown): Promise<void> {
    const { g, root } = await this.repo(input, false)
    await this.trust.trust(g, root, obj(input).fingerprint)
  }

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
    const head = await g.raw(['rev-parse', '--verify', '-q', 'HEAD']).then(
      (r) => (HASH_RE.test(r.trim()) ? r.trim() : null),
      () => null
    )
    return { branch, detached: s.detached, ahead: s.ahead, behind: s.behind, upstream: s.tracking ?? null, hasRemote, head, files: mapFiles(s) }
  }

  /** G-11 暂存：paths 为空 = 全部（add -A） */
  async stage(input: unknown): Promise<void> {
    const { g, root } = await this.repo(input)
    const paths = await checkPaths(root, obj(input).paths, true)
    await run(() => (paths.length ? g.raw(['add', '--', ...paths]) : g.raw(['add', '-A'])))
  }

  /** G-11 取消暂存：paths 为空 = 全部；重命名带上旧路径；还没有提交时用 rm --cached */
  async unstage(input: unknown): Promise<void> {
    const { g, root } = await this.repo(input)
    let paths = await checkPaths(root, obj(input).paths, true)
    if (paths.length) {
      const files = mapFiles(await run(() => g.status()))
      const extra = files.filter((f) => f.staged && f.oldPath && paths.includes(f.path)).map((f) => f.oldPath as string)
      paths = [...new Set([...paths, ...extra])]
    }
    const target = paths.length ? paths : ['.']
    const hasHead = await g.raw(['rev-parse', '--verify', '-q', 'HEAD']).then(
      (r) => r.trim().length > 0,
      () => false
    )
    await run(() => (hasHead ? g.raw(['restore', '--staged', '--', ...target]) : g.raw(['rm', '--cached', '-r', '-q', '--', ...target])))
  }

  /**
   * G-12 丢弃第一步：只接受「未暂存」组里的文件，返回确认框要列的文件和一次性 token。
   * 第二步 discard 只收 token，渲染层被注入也没法跳过确认直接删文件（PRD §6.2 第 7 条）
   */
  async discardPrepare(input: unknown): Promise<GitDiscardPlan> {
    const id = obj(input).workspaceId as string
    const { g, root } = await this.repo(input)
    const paths = await checkPaths(root, obj(input).paths, false)
    const unstaged = new Map(mapFiles(await run(() => g.status())).filter((f) => !f.staged).map((f) => [f.path, f]))
    const files = paths.map((p) => {
      const f = unstaged.get(p)
      if (!f) throw new Error(`没有可丢弃的改动：${p}`)
      if (f.status === 'conflict') throw new Error(`冲突文件不能直接丢弃：${p}`)
      return { path: p, untracked: f.status === 'untracked' }
    })
    this.sweepTokens()
    const token = randomUUID()
    this.discardTokens.set(token, { workspaceId: id, root, files, expires: Date.now() + DISCARD_TOKEN_MS })
    return { token, files }
  }

  /** G-12 丢弃第二步：token 换一次即作废；已跟踪的用 checkout 还原，未跟踪的删掉（仓库根永不删） */
  async discard(input: unknown): Promise<void> {
    const r = obj(input)
    const token = r.token
    if (typeof token !== 'string') throw new Error('token 不合法')
    const plan = this.discardTokens.get(token)
    this.discardTokens.delete(token)
    if (!plan || plan.expires < Date.now()) throw new Error('确认已过期，请重新操作')
    if (plan.workspaceId !== r.workspaceId) throw new Error('token 与工作区不符')
    const { g, root } = await this.repo(input)
    if (root !== plan.root) throw new Error('仓库已变化，请重新操作')
    const tracked = plan.files.filter((f) => !f.untracked).map((f) => f.path)
    if (tracked.length) await run(() => g.raw(['checkout', '--', ...tracked]))
    const realRoot = await realpath(root)
    for (const f of plan.files.filter((x) => x.untracked)) {
      const abs = resolve(root, f.path)
      const st = await lstat(abs).catch(() => null)
      if (!st) continue
      // 链接只删链接本身，不跟进去；普通文件先 realpath 确认仍在仓库里
      if (!st.isSymbolicLink() && !inside(realRoot, await realpath(abs))) throw new Error(`路径越出仓库：${f.path}`)
      if (resolve(abs) === resolve(root)) continue
      if (st.isDirectory() && !st.isSymbolicLink()) await rm(abs, { recursive: true, force: true })
      else await unlink(abs)
    }
  }

  /** G-13 diff：未跟踪文件构造全量新增；关掉外部 diff 与 textconv（都是仓库配置里的任意命令） */
  async diff(input: unknown): Promise<GitDiff> {
    const r = obj(input)
    const { g, root } = await this.repo(input)
    const [path] = await checkPaths(root, [r.path], false)
    if (!path) throw new Error('缺少文件路径')
    const staged = r.staged === true
    const file = mapFiles(await run(() => g.status())).find((f) => f.path === path && f.staged === staged)
    if (file?.status === 'untracked') return untrackedDiff(root, path)
    const paths = file?.oldPath ? [file.oldPath, path] : [path]
    const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', ...(staged ? ['--cached'] : []), '--', ...paths]
    return parseDiff(await run(() => g.raw(args)))
  }

  /** G-14 提交：照常跑仓库 hooks；失败时把 git / 钩子的输出原样带回（截到 4000 字） */
  async commit(input: unknown): Promise<{ hash: string }> {
    const r = obj(input)
    const summary = typeof r.summary === 'string' ? r.summary.trim() : ''
    const description = typeof r.description === 'string' ? r.description.replace(/\r\n/g, '\n').trim() : ''
    if (!summary) throw new Error('请填写提交摘要')
    if (summary.length > 200 || /[\r\n\u0000]/.test(summary)) throw new Error('提交摘要须为单行，且不超过 200 字')
    if (description.length > 5000 || description.includes('\u0000')) throw new Error('提交描述不超过 5000 字')
    const { g } = await this.repo(input)
    if (!mapFiles(await run(() => g.status())).some((f) => f.staged)) throw new Error('暂存区为空，没有可提交的改动')
    const args = ['commit', '-m', summary, ...(description ? ['-m', description] : [])]
    try {
      await g.raw(args)
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).trim()
      throw new Error(msg.slice(0, 4000) || '提交失败')
    }
    return { hash: (await run(() => g.raw(['rev-parse', '--short', 'HEAD']))).trim() }
  }

  /** G-20 分支菜单：只列本地分支，当前分支在最前，其余按最近提交时间倒序 */
  async branches(input: unknown): Promise<GitBranch[]> {
    const { g } = await this.repo(input)
    const fmt = ['%(refname:short)', '%(upstream:short)', '%(committerdate:unix)', '%(HEAD)', '%(subject)'].join('%1f')
    const raw = await run(() => g.raw(['for-each-ref', `--format=${fmt}`, 'refs/heads']))
    const out: GitBranch[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const [name, upstream, time, head, ...subject] = line.split('\x1f')
      if (!name) continue
      out.push({ name, current: head === '*', upstream: upstream || null, subject: subject.join('\x1f'), time: Number(time) * 1000 || 0 })
    }
    return out.sort((a, b) => (a.current !== b.current ? (a.current ? -1 : 1) : b.time - a.time))
  }

  /** G-21 切换分支：只认已有的本地分支；有未提交改动挡住时翻成中文 */
  async checkout(input: unknown): Promise<void> {
    const name = refName(obj(input).branch)
    const { g } = await this.repo(input)
    const exists = await g.raw(['rev-parse', '--verify', '-q', `refs/heads/${name}`]).then(
      (r) => r.trim().length > 0,
      () => false
    )
    if (!exists) throw new Error(`没有本地分支：${name}`)
    await switchError(() => g.raw(['switch', name]))
  }

  /** G-20 新建分支并切换（从当前 HEAD） */
  async createBranch(input: unknown): Promise<void> {
    const name = refName(obj(input).name)
    const { g } = await this.repo(input)
    // 再让 git 自己按 check-ref-format 规则核一遍（refName 只拦主要情况）
    await g.raw(['check-ref-format', '--branch', name]).catch(() => {
      throw new Error(`分支名不合法：${name}`)
    })
    const exists = await g.raw(['rev-parse', '--verify', '-q', `refs/heads/${name}`]).then(
      (r) => r.trim().length > 0,
      () => false
    )
    if (exists) throw new Error(`分支已存在：${name}`)
    await switchError(() => g.raw(['switch', '-c', name]))
  }

  /** G-22 fetch */
  fetch(input: unknown): Promise<GitRemoteResult> {
    return this.remoteOp(input, 'fetch', async (g) => {
      await g.raw(['fetch', '--prune'])
      return { conflict: false }
    })
  }

  /** G-22 / G-25 pull：产生冲突时不报错，返回 conflict（改动列表会出冲突横条） */
  pull(input: unknown): Promise<GitRemoteResult> {
    return this.remoteOp(input, 'pull', async (g, signal) => {
      let rebase = false
      try {
        // 用户没配 pull.rebase 时 git 2.27+ 遇到分叉直接报错、不合并；补 --no-rebase（老默认：merge），配过就尊重用户
        const rebaseSet = await g.raw(['config', '--get', 'pull.rebase']).then(
          (r) => r.trim().length > 0,
          () => false
        )
        rebase = rebaseSet
        await g.raw(['pull', '--no-edit', ...(rebaseSet ? [] : ['--no-rebase'])])
        // 合并冲突时 git 退出码非 0，但 CONFLICT 提示写在 stdout、stderr 为空，simple-git 的 raw 不会抛错：
        // 成功返回后也要查一次冲突（verify-git 实测）
        const s = await g.status()
        return { conflict: s.conflicted.length > 0, rebase }
      } catch (e) {
        // 用户取消：交给 remoteOp 报「已取消」，不再查状态误报冲突（审查 2026-11-06）
        if (signal.aborted) throw e
        const s = await g.status().catch(() => null)
        if (s && s.conflicted.length > 0) return { conflict: true, rebase }
        throw e
      }
    })
  }

  /** G-22 / G-24 push：当前分支没有上游时自动 -u <默认远端> <分支> */
  push(input: unknown): Promise<GitRemoteResult> {
    return this.remoteOp(input, 'push', async (g) => {
      const s = await g.status()
      if (s.detached || !s.current) throw new Error('分离 HEAD 状态下不能推送，先切到一个分支')
      if (s.tracking) {
        await g.raw(['push'])
      } else {
        const remote = this.config.get().settings.gitDefaultRemote
        const remotes = (await g.getRemotes(false)).map((r) => r.name)
        if (!remotes.includes(remote)) throw new Error(`没有名为 ${remote} 的远端（可在设置 → Git 修改默认远端）`)
        await g.raw(['push', '-u', remote, refName(s.current)])
      }
      return { conflict: false }
    })
  }

  /** G-31 历史：当前 HEAD 的提交，按时间倒序分页；空仓库返回空列表 */
  async log(input: unknown): Promise<GitLogPage> {
    const r = obj(input)
    const offset = Number.isInteger(r.offset) && (r.offset as number) >= 0 ? Math.min(r.offset as number, 1_000_000) : 0
    const limit = Number.isInteger(r.limit) && (r.limit as number) >= 1 ? Math.min(r.limit as number, 100) : 50
    const { g } = await this.repo(input)
    if (!(await hasHead(g))) return { commits: [], hasMore: false }
    const fmt = `${LOG_RS}%H${LOG_FS}%h${LOG_FS}%s${LOG_FS}%an${LOG_FS}%at${LOG_FS}%D`
    const raw = await run(() => g.raw(['log', '--no-color', `--format=${fmt}`, `--max-count=${limit + 1}`, `--skip=${offset}`, 'HEAD', '--']))
    const commits = raw
      .split(LOG_RS)
      .filter((c) => c.trim())
      .map((c) => {
        const [hash, shortHash, subject, author, time, deco] = c.replace(/\n+$/, '').split(LOG_FS)
        return { hash, shortHash, subject: subject ?? '', author: author ?? '', time: Number(time) * 1000 || 0, refs: parseRefs(deco ?? '') }
      })
      .filter((c) => HASH_RE.test(c.hash))
    return { commits: commits.slice(0, limit), hasMore: commits.length > limit }
  }

  /** G-32 提交详情：完整信息 + 改动文件（-z 保留中文路径；合并提交按第一父提交比较） */
  async commitDetail(input: unknown): Promise<GitCommitDetail> {
    const { g } = await this.repo(input)
    const hash = await resolveCommit(g, obj(input).hash)
    const fmt = `%H${LOG_FS}%h${LOG_FS}%s${LOG_FS}%an${LOG_FS}%ae${LOG_FS}%at${LOG_FS}%D${LOG_FS}%P${LOG_FS}%b`
    const meta = await run(() => g.raw(['show', '--no-patch', '--no-color', `--format=${fmt}`, hash, '--']))
    const [full, shortHash, subject, author, email, time, deco, parentsRaw, ...body] = meta.split(LOG_FS)
    const parents = (parentsRaw ?? '').trim().split(/\s+/).filter((p) => HASH_RE.test(p))
    const ns = await run(() => g.raw([...commitDiffArgs(full, parents[0]), '--name-status', '-z']))
    const num = await run(() => g.raw([...commitDiffArgs(full, parents[0]), '--numstat', '-z']))
    return {
      hash: full,
      shortHash,
      subject: subject ?? '',
      author: author ?? '',
      email: email ?? '',
      time: Number(time) * 1000 || 0,
      refs: parseRefs(deco ?? ''),
      parents,
      body: body.join(LOG_FS).trim(),
      files: commitFiles(ns, num).slice(0, MAX_PATHS)
    }
  }

  /** G-32 某个提交里一个文件的 diff；path / oldPath 相对仓库根，同样过越界校验 */
  async commitFileDiff(input: unknown): Promise<GitDiff> {
    const r = obj(input)
    const { g, root } = await this.repo(input)
    const hash = await resolveCommit(g, r.hash)
    const paths = await checkPaths(root, r.oldPath ? [r.oldPath, r.path] : [r.path], false)
    const parentsRaw = await run(() => g.raw(['show', '--no-patch', '--format=%P', hash, '--']))
    const parent = parentsRaw.trim().split(/\s+/).find((p) => HASH_RE.test(p))
    return parseDiff(await run(() => g.raw([...commitDiffArgs(hash, parent), '-p', '--', ...paths])))
  }

  /** G-23 取消本工作区所在仓库正在进行的远端操作（按仓库根找：同一仓库的另一个工作区也能取消）；没有在跑的就什么都不做 */
  async cancel(input: unknown): Promise<void> {
    const { root } = await this.repo(input, false)
    this.running.get(root)?.ac.abort()
  }

  /** 远端操作统一入口：按仓库根互斥、5 分钟超时、可取消、进度节流推送 */
  private async remoteOp(input: unknown, op: GitRemoteOp, fn: (g: SimpleGit, signal: AbortSignal) => Promise<GitRemoteResult>): Promise<GitRemoteResult> {
    const workspaceId = obj(input).workspaceId as string
    const { root } = await this.repo(input)
    if (this.running.has(root)) throw new Error('这个仓库已有远端操作在进行，等它结束或先取消')
    const bin = this.gitBinary() as string
    const ac = new AbortController()
    this.running.set(root, { workspaceId, ac })
    let lastStage = ''
    let lastAt = 0
    const onProgress = (rawStage: string, percent: number): void => {
      // 远端发来的进度行首词是「remote:」，去掉冒号才对得上界面的阶段表（审查 2026-11-06）
      const stage = (rawStage.split('/').pop() ?? rawStage).toLowerCase().replace(/:$/, '')
      const now = Date.now()
      if (stage === lastStage && percent < 100 && now - lastAt < PROGRESS_THROTTLE_MS) return
      lastStage = stage
      lastAt = now
      this.onProgress({ workspaceId, op, stage, percent: Math.max(0, Math.min(100, Math.round(percent))) })
    }
    try {
      const g = this.client(bin, root, { signal: ac.signal, onProgress })
      const hasRemote = (await g.getRemotes(false)).length > 0
      if (!hasRemote) throw new Error('这个仓库没有配置远端')
      return await fn(g, ac.signal)
    } catch (e) {
      if (ac.signal.aborted) throw new Error('已取消')
      throw new Error(remoteError(e))
    } finally {
      this.running.delete(root)
    }
  }

  private discardTokens = new Map<string, { workspaceId: string; root: string; files: GitDiscardPlan['files']; expires: number }>()

  private sweepTokens(): void {
    const now = Date.now()
    for (const [k, v] of this.discardTokens) if (v.expires < now) this.discardTokens.delete(k)
  }

  /**
   * 开关、git.exe、仓库根三道检查都过了才返回 client；baseDir 是仓库根。
   * guard 为 true（默认）时再查一道信任：仓库里有会执行命令的配置 / 钩子且没确认过，一律拒绝，
   * 连 status 也不跑（clean 过滤器在 status 时就会执行，探针实测）
   */
  private async repo(input: unknown, guard = true): Promise<{ g: SimpleGit; root: string }> {
    const cwd = this.workspaceCwd(input)
    if (!this.enabled()) throw new Error('未启用 Git 管理')
    const bin = this.gitBinary()
    if (!bin) throw new Error('找不到 git，请先安装 Git for Windows')
    const top = await run(() => this.client(bin, cwd).raw(['rev-parse', '--show-toplevel']))
    const root = top.trim()
    const g = this.client(bin, root)
    if (guard && (await this.trust.untrusted(g, root))) throw new Error(RISK_ERROR)
    return { g, root }
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

  private client(bin: string, baseDir: string, remote?: { signal: AbortSignal; onProgress: (stage: string, percent: number) => void }): SimpleGit {
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
        timeout: { block: remote ? REMOTE_TIMEOUT_MS : LOCAL_TIMEOUT_MS },
        unsafe: { allowUnsafeCustomBinary: true, allowUnsafeFsMonitor: true },
        ...(remote ? { abort: remote.signal, progress: (e: { stage: string; progress: number }) => remote.onProgress(e.stage, e.progress) } : {})
      }).env({
        ...env,
        // 无 tty：不弹密码框、不开编辑器；status 不抢 index.lock（agent 可能同时在跑 git）
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_MERGE_AUTOEDIT: 'no',
        GIT_OPTIONAL_LOCKS: '0',
        // 只放行常规传输协议：ext:: 等传输会执行任意命令（仓库配置 protocol.ext.allow=always 时 fetch 就会跑，探针实测）
        GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS
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

/**
 * 分支名校形（移植源项目 assertRefName）：拒绝 - 开头（会被当成选项）与 check-ref-format 的主要非法情况。
 * 返回原值，方便直接放进参数数组。
 */
export function refName(v: unknown): string {
  if (
    typeof v !== 'string' ||
    !v ||
    v.length > 255 ||
    v.startsWith('-') ||
    v.startsWith('/') ||
    v.endsWith('/') ||
    v.endsWith('.') ||
    v.endsWith('.lock') ||
    v.includes('..') ||
    v.includes('@{') ||
    v === '@' ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x20\x7f~^:?*[\\]/.test(v)
  ) {
    throw new Error(`分支名不合法：${String(v).slice(0, 80)}`)
  }
  return v
}

async function switchError(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/local changes|would be overwritten|overwritten by checkout/i.test(msg)) throw new Error('当前有未提交的改动，先提交或丢弃再切换')
    throw new Error(firstLine(msg) || '切换失败')
  }
}

/** 远端错误：优先取 fatal / error 行（凭据、网络、被拒），其次第一行 */
function remoteError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const lines = msg.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const key = lines.find((l) => /^(fatal|error|remote: error|! \[rejected\])/i.test(l))
  const text = key ?? lines[0] ?? '远端操作失败'
  if (/rejected|non-fast-forward|fetch first/i.test(msg)) return `${text}（远端有新提交，先拉取再推送）`
  if (/could not read Username|Authentication failed|terminal prompts disabled|Permission denied/i.test(msg)) return `${text}（凭据不可用：请在系统凭据管理器或 SSH agent 里配置后重试）`
  return text.slice(0, 1000)
}

function firstLine(msg: string): string {
  return msg.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
}

function obj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

/** p 是否在 root 内（含 root 本身）；两者都应是已解析的绝对路径 */
function inside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 渲染层给的文件路径：必须是相对仓库根的字符串，拼出来仍在仓库根内，越界一律拒绝（PRD §6.2 第 2 条）。
 * 返回统一成 / 分隔的相对路径；命令里一律放在 `--` 之后，不会被当成选项。
 */
async function checkPaths(root: string, raw: unknown, allowEmpty: boolean): Promise<string[]> {
  if (!Array.isArray(raw)) throw new Error('paths 不合法')
  if (raw.length === 0 && !allowEmpty) throw new Error('没有选择文件')
  if (raw.length > MAX_PATHS) throw new Error(`一次最多操作 ${MAX_PATHS} 个文件`)
  const out: string[] = []
  for (const p of raw) {
    if (typeof p !== 'string' || !p || p.length > 1024 || p.includes('\u0000')) throw new Error('文件路径不合法')
    if (isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith('\\\\')) throw new Error(`只接受相对仓库根的路径：${p}`)
    const abs = resolve(root, p)
    if (abs === resolve(root) || !inside(resolve(root), abs)) throw new Error(`路径越出仓库：${p}`)
    out.push(relative(resolve(root), abs).replace(/\\/g, '/'))
  }
  return [...new Set(out)]
}

/** 未跟踪文件没有 diff：整个文件当作新增（与源项目一致） */
async function untrackedDiff(root: string, path: string): Promise<GitDiff> {
  const empty: GitDiff = { hunks: [], binary: false, tooLarge: false, added: 0, removed: 0 }
  const abs = resolve(root, path)
  const real = await realpath(abs).catch(() => null)
  if (!real) return empty
  if (!inside(await realpath(root), real)) throw new Error(`路径越出仓库：${path}`)
  const st = await stat(real)
  if (st.isDirectory()) return empty
  if (st.size > MAX_DIFF_BYTES) return { ...empty, tooLarge: true }
  const buf = await readFile(real)
  if (buf.subarray(0, 8000).includes(0)) return { ...empty, binary: true }
  const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  if (lines.length > MAX_DIFF_LINES) return { ...empty, tooLarge: true }
  if (!lines.length) return empty
  return {
    hunks: [{ header: `@@ -0,0 +1,${lines.length} @@ 新文件`, lines: lines.map((content, i) => ({ type: 'added', content, oldNo: null, newNo: i + 1 })) }],
    binary: false,
    tooLarge: false,
    added: lines.length,
    removed: 0
  }
}

/** 解析统一 diff（移植自源项目 parseDiff）；只认 @@ 之后的 +/-/空格 行 */
export function parseDiff(raw: string): GitDiff {
  const empty: GitDiff = { hunks: [], binary: false, tooLarge: false, added: 0, removed: 0 }
  if (/^Binary files |^GIT binary patch/m.test(raw)) return { ...empty, binary: true }
  if (raw.length > MAX_DIFF_BYTES) return { ...empty, tooLarge: true }
  const hunks: GitDiffHunk[] = []
  let cur: GitDiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  let added = 0
  let removed = 0
  let count = 0
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (m) {
      cur = { header: line, lines: [] }
      hunks.push(cur)
      oldNo = Number(m[1])
      newNo = Number(m[2])
      continue
    }
    if (!cur || line.startsWith('\\')) continue
    if (++count > MAX_DIFF_LINES) return { ...empty, tooLarge: true }
    if (line.startsWith('+')) {
      cur.lines.push({ type: 'added', content: line.slice(1), oldNo: null, newNo: newNo++ })
      added++
    } else if (line.startsWith('-')) {
      cur.lines.push({ type: 'removed', content: line.slice(1), oldNo: oldNo++, newNo: null })
      removed++
    } else if (line.startsWith(' ')) {
      cur.lines.push({ type: 'context', content: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return { hunks, binary: false, tooLarge: false, added, removed }
}

/** git log / show 的字段与记录分隔符（%b 可能多行，不能按换行切） */
const LOG_FS = '\x1f'
const LOG_RS = '\x1e'
const HASH_RE = /^[0-9a-f]{7,64}$/i

async function hasHead(g: SimpleGit): Promise<boolean> {
  return g.raw(['rev-parse', '--verify', '-q', 'HEAD']).then(
    (r) => r.trim().length > 0,
    () => false
  )
}

/** 渲染层给的提交哈希：只认十六进制，再由 git 解析成完整哈希（不存在就拒绝） */
async function resolveCommit(g: SimpleGit, raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || !/^[0-9a-f]{4,64}$/i.test(raw)) throw new Error('提交哈希不合法')
  const full = await g.raw(['rev-parse', '--verify', '-q', `${raw}^{commit}`]).then(
    (r) => r.trim(),
    () => ''
  )
  if (!HASH_RE.test(full)) throw new Error(`找不到提交：${raw}`)
  return full
}

/** 提交改动的比较方式：有父提交和第一父提交比，根提交用 diff-tree --root；外部 diff / textconv 一律关掉 */
function commitDiffArgs(hash: string, parent: string | undefined): string[] {
  const common = ['--no-color', '--no-ext-diff', '--no-textconv', '-M']
  return parent ? ['diff', ...common, parent, hash] : ['diff-tree', '-r', '--root', ...common, hash]
}

/** %D 装饰：去掉 HEAD -> 前缀与 tag: 前缀，只留短名 */
function parseRefs(deco: string): string[] {
  return deco
    .split(',')
    .map((s) => s.trim().replace(/^HEAD -> /, '').replace(/^tag: /, ''))
    .filter((s) => s && s !== 'HEAD')
}

const COMMIT_STATUS: Record<string, GitCommitFile['status']> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'added', T: 'modified' }

/**
 * 合并 --name-status -z 与 --numstat -z（移植源项目 parseNameStatusZ / parseNumstatZ）：
 *   name-status  M\0path\0 ；重命名 R066\0old\0new\0
 *   numstat      adds\tdels\tpath\0 ；重命名 adds\tdels\t\0old\0new\0 ；二进制 -\t-
 * diff-tree 的输出开头会带一段提交哈希，按状态字母 / 数字格式识别时自然跳过
 */
export function commitFiles(nsRaw: string, numRaw: string): GitCommitFile[] {
  const status = new Map<string, { status: GitCommitFile['status']; oldPath?: string }>()
  const ns = nsRaw.split('\0')
  for (let i = 0; i < ns.length; i++) {
    const t = ns[i].replace(/^[\r\n]+/, '')
    if (!/^[ACDMRT]\d*$/.test(t)) continue
    const letter = t[0]
    if (letter === 'R' || letter === 'C') {
      const from = ns[++i]
      const to = ns[++i]
      if (to) status.set(to, { status: COMMIT_STATUS[letter], oldPath: from })
    } else {
      const p = ns[++i]
      if (p) status.set(p, { status: COMMIT_STATUS[letter] ?? 'modified' })
    }
  }
  const out: GitCommitFile[] = []
  const num = numRaw.split('\0')
  for (let i = 0; i < num.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(num[i].replace(/^[\r\n]+/, '').replace(/^[0-9a-f]{40,64}\n/i, ''))
    if (!m) continue
    let path = m[3]
    let from: string | undefined
    if (!path) {
      from = num[++i]
      path = num[++i]
      if (!path) continue
    }
    const st = status.get(path)
    const oldPath = st?.oldPath ?? from
    const binary = m[1] === '-'
    out.push({
      path: path.replace(/\\/g, '/'),
      ...(oldPath ? { oldPath: oldPath.replace(/\\/g, '/') } : {}),
      status: st?.status ?? (oldPath ? 'renamed' : 'modified'),
      added: binary ? 0 : Number(m[1]),
      removed: binary ? 0 : Number(m[2]),
      binary
    })
  }
  return out
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
