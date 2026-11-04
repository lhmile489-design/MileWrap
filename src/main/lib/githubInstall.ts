import { createWriteStream, unlinkSync } from 'node:fs'
import { readdirSync, renameSync, cpSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SkillsInstallResult } from '@shared/types'
import { agentRootsOf, parseFrontmatter, isInstallable, type SkillRoot } from '../services/SkillsService'
import { inside } from '../services/history/common'
import { extractZipGuarded, extractTarGzGuarded, findSkillDir, tempRoot, cleanup } from './extractGuard'

const DOWNLOAD_TIMEOUT_MS = 30_000
const DOWNLOAD_MAX_BYTES = 50_000_000
/** codeload 基址；verify harness 用环境变量指到本地 http 服务（打包后正常走真域名） */
function codeloadBase(): string {
  return process.env['MILE_WARP_CODELOAD_OVERRIDE'] || 'https://codeload.github.com'
}

/** GitHub URL 解析结果：owner/repo[/tree/branch/subpath]（PRD §7 skills:parseGithubUrl） */
export type GithubRef = {
  owner: string
  repo: string
  branch: string
  subpath: string
  canonical: string
}

const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/

/**
 * 解析 GitHub 仓库 URL / 短格式为结构化引用。只接受 github.com 形态（PRD §6.6 白名单）：
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/<branch>/<subpath>
 *   git@github.com:owner/repo(.git)
 *   owner/repo
 */
export function parseGithubUrl(input: unknown): GithubRef {
  const s = typeof input === 'string' ? input.trim() : ''
  if (!s) throw new Error('URL 不能为空')
  let rest = s
  if (rest.startsWith('git@github.com:')) {
    rest = rest.slice('git@github.com:'.length)
  } else if (/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+(\/.*)?$/.test(rest) && !rest.includes('://')) {
    // 短格式 owner/repo（可带 /tree/...）
  } else {
    try {
      const u = new URL(rest.startsWith('http') ? rest : `https://${rest}`)
      if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') throw new Error('只支持 github.com 的仓库地址')
      rest = u.pathname.replace(/^\/+/, '').replace(/\.git$/, '')
    } catch (e) {
      if (e instanceof TypeError) throw new Error('URL 格式不合法')
      throw e
    }
  }
  rest = rest.replace(/\.git$/, '')
  const segs = rest.split('/').filter(Boolean)
  if (segs.length < 2) throw new Error('至少要 owner/repo 两段')
  const [owner, repo, treeWord, branch, ...sub] = segs
  if (!OWNER_RE.test(owner)) throw new Error('owner 名不合法')
  if (!REPO_RE.test(repo)) throw new Error('repo 名不合法')
  if (treeWord !== undefined && treeWord !== 'tree') throw new Error('仓库地址只支持 /tree/<branch>/<子目录> 形态')
  if (treeWord === 'tree' && (!branch || sub.length === 0)) throw new Error('/tree/ 后面要有分支和子目录')
  return {
    owner,
    repo,
    branch: branch || 'HEAD',
    subpath: sub.join('/'),
    canonical: `https://github.com/${owner}/${repo}${treeWord === 'tree' ? `/tree/${branch}/${sub.join('/')}` : ''}`
  }
}

/** codeload 下载 tar.gz 到临时文件；30s 超时 + 总量上限（协议按覆盖基址自动选 http/https） */
async function downloadTarball(ref: GithubRef): Promise<string> {
  const url = `${codeloadBase()}/${ref.owner}/${ref.repo}/tar.gz/${encodeURIComponent(ref.branch)}`
  const dest = join(tmpdir(), `warp-skills-dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tar.gz`)
  const transport = url.startsWith('http://') ? await import('node:http') : await import('node:https')
  return new Promise((resolveFn, rejectFn) => {
    const req = transport.get(url, { headers: { 'user-agent': 'MileWarp/1.4 (skills install)' }, timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.destroy()
        rejectFn(new Error(`下载失败（HTTP ${res.statusCode}）`))
        return
      }
      const out = createWriteStream(dest)
      let total = 0
      res.on('data', (chunk) => {
        total += chunk.length
        if (total > DOWNLOAD_MAX_BYTES) {
          req.destroy()
          out.destroy()
          rejectFn(new Error('仓库归档超过 50MB，不做安装'))
        }
      })
      res.pipe(out)
      out.on('finish', () => {
        out.close(() => resolveFn(dest))
      })
      out.on('error', rejectFn)
    })
    req.on('timeout', () => {
      req.destroy()
      rejectFn(new Error('下载超时（30 秒）'))
    })
    req.on('error', (e) => {
      rejectFn(e)
    })
  })
}

export type GithubInstallOutcome = SkillsInstallResult & { parsed: GithubRef }

/** 从 GitHub 安装：解析 → 下载 → 解压（guard）→ 找 skill 目录 → 复制进各目标（带 .bak） */
export async function installFromGithub(input: unknown): Promise<GithubInstallOutcome> {
  const r = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const ref = parseGithubUrl(r.url)
  const targets = targetsOf(r)
  const conflict = r.onConflict === 'overwrite' ? 'overwrite' : 'skip'

  const tarPath = await downloadTarball(ref)
  let extractRoot: string | null = null
  try {
    extractRoot = await extractTarGzGuarded(tarPath)
    // codeload 归档顶层是 <repo>-<branch>/；subpath 指到仓库内子目录
    let base = extractRoot
    if (ref.subpath) {
      const top = readdirSync(extractRoot, { withFileTypes: true }).find((e) => e.isDirectory())
      if (!top) throw new Error('归档里没有内容')
      base = join(extractRoot, top.name, ...ref.subpath.split('/'))
      if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error(`仓库里没有子目录 ${ref.subpath}`)
    }
    const skillDir = findSkillDir(base)
    const name = dirName(skillDir)
    const outcome = copyToTargets(skillDir, name, targets, conflict)
    return { parsed: ref, ...outcome }
  } finally {
    if (extractRoot) cleanup(extractRoot)
    try {
      if (existsSync(tarPath)) unlinkSync(tarPath)
    } catch {
      // 下载临时文件删不掉就算了
    }
  }
}

/** zip 安装：zipPath 由主进程 dialog 选出（渲染层拿不到路径），guard 解压后同上 */
export async function installFromZip(input: unknown): Promise<SkillsInstallResult> {
  const r = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const zipPath = typeof r.zipPath === 'string' ? r.zipPath : ''
  if (!zipPath || !zipPath.toLowerCase().endsWith('.zip')) throw new Error('要选择 .zip 文件')
  const targets = targetsOf(r)
  const conflict = r.onConflict === 'overwrite' ? 'overwrite' : 'skip'
  const extractRoot = extractZipGuarded(zipPath)
  try {
    const skillDir = findSkillDir(extractRoot)
    return copyToTargets(skillDir, dirName(skillDir), targets, conflict)
  } finally {
    cleanup(extractRoot)
  }
}

function targetsOf(r: Record<string, unknown>): string[] {
  const t = r.targets
  if (!Array.isArray(t) || t.length === 0 || t.some((x) => typeof x !== 'string')) throw new Error('targets 不合法')
  return t as string[]
}

/** 把 skillDir 复制进各目标根（同名 skip / overwrite 留 .bak）——与 SkillsService.installTo 同一套语义 */
function copyToTargets(srcDir: string, name: string, targets: string[], conflict: 'skip' | 'overwrite'): SkillsInstallResult {
  const result: SkillsInstallResult = { installed: [], skipped: [], failed: [] }
  for (const t of targets) {
    const root: SkillRoot | null = agentRootsOf(t)
    if (!root) {
      result.failed.push({ agentId: t, reason: '未知 skill 根' })
      continue
    }
    const targetParent = skillRootPath(t)
    try {
      if (!existsSync(targetParent)) mkdirSync(targetParent, { recursive: true })
      const target = join(targetParent, name)
      if (!inside(targetParent, target)) {
        result.failed.push({ agentId: t, reason: '目标路径越出根目录' })
        continue
      }
      if (existsSync(target)) {
        if (conflict === 'skip') {
          result.skipped.push(t)
          continue
        }
        renameSync(target, `${target}.bak-${Date.now()}`)
      }
      cpSync(srcDir, target, { recursive: true })
      result.installed.push(t)
    } catch (e) {
      result.failed.push({ agentId: t, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}

/** 目标根的绝对路径（与 SkillsService 同一 homedir 语义） */
function skillRootPath(agentId: string): string {
  const root = agentRootsOf(agentId)
  if (!root) throw new Error('未知 skill 根')
  return resolve(homedir(), root.rel)
}

/** 目录 basename（Windows 混合分隔符都认） */
function dirName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? 'skill'
}

export { tempRoot, cleanup, parseFrontmatter, isInstallable }
