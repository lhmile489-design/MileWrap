import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { SimpleGit } from 'simple-git'
import type { GitRisk, GitRiskItem } from '@shared/types'
import { dirKey } from '@shared/path'
import { atomicWrite } from '../lib/atomicWrite'

/**
 * 仓库里「会执行任意命令」的配置与钩子（审查 2026-11-06 高危项，decisions 同日条目）。
 * agent 能改自己工作区的 .git/config 和 .git/hooks；用户在 Git 栏点一下，命令就在主进程里跑。
 * 做法：只读扫描仓库级（local / worktree）配置与钩子目录，发现了就要用户先确认信任；
 * 内容一变（指纹不同）重新确认。全局 / 系统配置是用户自己写的，不管。
 *
 * 不在这里的：core.fsmonitor（命令行已强制关）、diff.external / textconv（diff 已加 --no-ext-diff --no-textconv）、
 * protocol.*.allow（GIT_ALLOW_PROTOCOL 环境变量优先）。
 */
const RISKY_KEYS: { re: RegExp; why: string }[] = [
  { re: /^core\.hookspath$/, why: '钩子目录：提交、切分支、拉取、推送时执行里面的脚本' },
  { re: /^filter\..+\.(clean|smudge|process)$/, why: '内容过滤器：查看状态、暂存、切分支时执行' },
  { re: /^merge\..+\.driver$/, why: '合并驱动：拉取合并时执行' },
  { re: /^remote\..+\.(receivepack|uploadpack)$/, why: '远端程序：推送 / 获取时执行' },
  { re: /^core\.(sshcommand|gitproxy|askpass|editor)$/, why: '外部命令：连接远端或需要编辑时执行' },
  { re: /^sequence\.editor$/, why: '外部命令：变基时执行' },
  { re: /^credential\.(.+\.)?helper$/, why: '凭据助手：连接远端时执行' },
  { re: /^gpg\.(.+\.)?program$|^gpg\.ssh\.defaultkeycommand$/, why: '签名程序：提交时执行' }
]

const LOCAL_SCOPES = new Set(['local', 'worktree'])
const MAX_HOOKS = 64
const MAX_HOOK_BYTES = 1024 * 1024

/** `git config --list --show-scope -z`：scope\0key\nvalue\0…（无值的布尔键没有 \n） */
export function parseConfigList(raw: string): { scope: string; key: string; value: string }[] {
  const parts = raw.split('\0')
  const out: { scope: string; key: string; value: string }[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i].trim()
    const kv = parts[i + 1]
    if (!scope || !kv) continue
    const nl = kv.indexOf('\n')
    out.push({ scope, key: (nl < 0 ? kv : kv.slice(0, nl)).toLowerCase(), value: nl < 0 ? '' : kv.slice(nl + 1) })
  }
  return out
}

/** 扫描一个仓库：只跑 `config --list` 和 `rev-parse --git-path`，都不执行仓库里的任何东西 */
export async function scanRepo(g: SimpleGit, root: string): Promise<GitRisk | null> {
  const items: GitRiskItem[] = []
  const hash = createHash('sha256')
  const list = parseConfigList(await g.raw(['config', '--list', '--show-scope', '-z']))
  for (const e of list) {
    if (!LOCAL_SCOPES.has(e.scope)) continue
    const hit = RISKY_KEYS.find((k) => k.re.test(e.key))
    if (!hit) continue
    items.push({ kind: 'config', name: e.key, detail: e.value.slice(0, 300), why: hit.why })
    hash.update(`c\0${e.key}\0${e.value}\0`)
  }
  // 钩子目录（尊重 core.hooksPath；worktree 时指向公共目录）。.sample 是 git init 自带的示例，不执行
  const rel = (await g.raw(['rev-parse', '--git-path', 'hooks'])).trim()
  const dir = isAbsolute(rel) ? rel : resolve(root, rel)
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names.sort().slice(0, MAX_HOOKS)) {
    if (name.endsWith('.sample') || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = await lstat(p).catch(() => null)
    if (!st || !st.isFile()) continue
    items.push({ kind: 'hook', name, detail: `${st.size} 字节`, why: '钩子脚本：对应的 git 操作（提交、切分支、合并、推送）时执行' })
    const body = st.size <= MAX_HOOK_BYTES ? await readFile(p).catch(() => Buffer.alloc(0)) : Buffer.from(String(st.size))
    hash.update(`h\0${name}\0`).update(body)
  }
  return items.length ? { fingerprint: hash.digest('hex'), items } : null
}

/** 用户确认过的仓库：git-trust.json，键是规范化的仓库根，值是当时的指纹 */
export class GitTrust {
  private file: string
  private data: Record<string, string> = {}

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'git-trust.json')
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) this.data[k] = v
        }
      }
    } catch {
      // 读坏了当作都没信任过：最坏是多问一次
      this.data = {}
    }
  }

  /**
   * 没信任或内容变了时返回风险项；正常仓库与已信任仓库返回 null。
   * 每条命令前都重扫、不缓存：缓存「安全」会放过 agent 刚写进去的钩子，缓存「有风险」会在删掉之后还误拒（verify-git 实测）
   */
  async untrusted(g: SimpleGit, root: string): Promise<GitRisk | null> {
    const key = dirKey(root)
    const risk = await scanRepo(g, root)
    if (!risk) return null
    return this.data[key] === risk.fingerprint ? null : risk
  }

  /** 渲染层确认时带回它看到的指纹；和现在重新扫出来的一致才记下（确认后内容又被改了就不算） */
  async trust(g: SimpleGit, root: string, fingerprint: unknown): Promise<void> {
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('fingerprint 不合法')
    const key = dirKey(root)
    const risk = await scanRepo(g, root)
    if (!risk) return
    if (risk.fingerprint !== fingerprint) throw new Error('仓库配置在确认期间又变了，请重新查看后再确认')
    this.data[key] = fingerprint
    atomicWrite(this.file, JSON.stringify(this.data, null, 2))
  }
}
