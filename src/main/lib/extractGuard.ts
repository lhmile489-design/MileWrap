import AdmZip from 'adm-zip'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, rmSync, existsSync, mkdirSync, writeFileSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { inside } from '../services/history/common'

/** 解压上限（防解压炸弹）：条目数与累计解压字节，zip / tar 共用 */
export const EXTRACT_MAX_ENTRIES = 5000
export const EXTRACT_MAX_BYTES = 200 * 1024 * 1024

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const TAR_EXE = 'C:\\Windows\\System32\\tar.exe'
/** Windows 保留设备名（不分大小写，带不带扩展名都算）：落盘后资源管理器 / cmd 打不开也删不掉 */
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i

/**
 * 条目名逐段校验（zip / tar 共用）：
 * - `:` 一律拒绝（NTFS 备用数据流 `a.txt:hidden` 会绕过 readdir/lstat 的终检，并被 cpSync 带进目标）
 * - 保留设备名、以点或空格结尾的段拒绝
 * - 控制字符拒绝
 */
function assertSafeName(name: string): void {
  if (name.includes(':')) throw new Error(`压缩包条目名含冒号：${name}`)
  if (/[\u0000-\u001f]/.test(name)) throw new Error(`压缩包条目名含控制字符：${name}`)
  for (const seg of name.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') continue // 空段（结尾 /）与 . / .. 由 inside 处理
    if (/[. ]$/.test(seg)) throw new Error(`压缩包条目名以点或空格结尾：${name}`)
    if (RESERVED_RE.test(seg)) throw new Error(`压缩包条目名是 Windows 保留名：${name}`)
  }
}

/** 解压 / 复制用的临时根（按次唯一） */
function tempRoot(): string {
  const dir = join(tmpdir(), `warp-skills-${createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 16)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 解压 / 复制完成后清掉临时目录；失败也尽力清 */
function cleanup(dir: string): void {
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  } catch {
    // 临时目录删不掉不影响主流程（在 %TEMP% 里）
  }
}

/**
 * 逐条目校验 + 解压 zip 到临时目录（PRD §6.5：zip-slip 防护）。
 * 写盘前先过一遍全部条目：条目数、声明的解压大小、符号链接属性、路径越界，任何一项不过整包拒绝，
 * 一个字节都不落盘。返回临时目录；失败抛错并清空临时目录。
 */
export function extractZipGuarded(zipPath: string): string {
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries()
  if (entries.length > EXTRACT_MAX_ENTRIES) throw new Error(`压缩包条目过多（${entries.length}，上限 ${EXTRACT_MAX_ENTRIES}）`)
  const root = tempRoot()
  try {
    const plan: { entry: (typeof entries)[number]; target: string }[] = []
    let declared = 0
    for (const entry of entries) {
      const name = entry.entryName.replace(/\\/g, '/')
      // 盘符 / 绝对路径 / UNC 一律拒绝；.. 段由下面的 inside 兜
      if (/^[a-zA-Z]:/.test(name) || name.startsWith('/')) throw new Error(`压缩包含绝对路径：${entry.entryName}`)
      assertSafeName(name)
      // 外部属性高 16 位是 unix mode：符号链接条目直接拒绝（不当普通文件写，避免伪装）
      if (((entry.header.attr >>> 16) & S_IFMT) === S_IFLNK) throw new Error(`压缩包含符号链接：${entry.entryName}`)
      const target = resolve(root, name)
      if (!inside(root, target)) throw new Error(`压缩包含越界路径：${entry.entryName}`)
      if (!entry.isDirectory) {
        declared += entry.header.size
        if (declared > EXTRACT_MAX_BYTES) throw new Error(`压缩包解压后超过 ${EXTRACT_MAX_BYTES / 1024 / 1024}MB`)
      }
      plan.push({ entry, target })
    }
    // 声明大小可以造假：写盘时再按实际字节累计一遍
    let actual = 0
    for (const { entry, target } of plan) {
      if (entry.isDirectory) {
        mkdirSync(target, { recursive: true })
        continue
      }
      const data = entry.getData()
      actual += data.length
      if (actual > EXTRACT_MAX_BYTES) throw new Error(`压缩包解压后超过 ${EXTRACT_MAX_BYTES / 1024 / 1024}MB`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, data)
    }
    // 终检：lstat 遍历，确认没有链接、没有越界、总量在上限内
    assertExtracted(root)
    return root
  } catch (e) {
    cleanup(root)
    throw e
  }
}

/**
 * 解压 tar.gz 到临时目录：先 `tar -tvzf` 预检（条目数、累计大小、链接条目），
 * 通过后走系统 bsdtar 解压，结束后再用 lstat 整体终检。async：内部等 tar 子进程退出。
 */
export async function extractTarGzGuarded(tarPath: string): Promise<string> {
  preflightTar(await runTar(['-tvzf', tarPath]), await runTar(['-tzf', tarPath]))
  const root = tempRoot()
  try {
    await runTar(['-xzf', tarPath, '-C', root])
    assertExtracted(root)
    return root
  } catch (e) {
    cleanup(root)
    throw e
  }
}

/**
 * tar 预检。`listing` 是 `-tv` 列表（`<mode> <links> <user> <group> <size> <date...> <name>`），
 * `names` 是 `-t` 纯名单，两者同序逐条对应：
 * - 类型位 l（符号链接）/ h（硬链接）/ 设备等特殊文件拒绝；看不懂的行也拒绝（宁可误拒不放过）
 * - 链接在 `-tv` 里会在名字后面多出 ` -> 目标` / ` link to 目标`：行尾不是该条目的名字就拒绝
 *   （按名字比对，不再按行内是否含 " -> " 判断，文件名本身带 " -> " 不会误拒）
 * - 每个名字过 assertSafeName（冒号 / 保留名 / 结尾点空格 / 控制字符）
 */
function preflightTar(listing: string, nameList: string): void {
  const lines = listing.split(/\r?\n/).filter((l) => l.trim() !== '')
  const names = nameList.split(/\r?\n/).filter((l) => l !== '')
  if (lines.length > EXTRACT_MAX_ENTRIES || names.length > EXTRACT_MAX_ENTRIES)
    throw new Error(`压缩包条目过多（${Math.max(lines.length, names.length)}，上限 ${EXTRACT_MAX_ENTRIES}）`)
  if (lines.length !== names.length) throw new Error('压缩包列表前后不一致')
  let total = 0
  lines.forEach((line, i) => {
    const name = names[i]
    const m = /^([-dlhbcps])[-rwxsStT]{9}\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s/.exec(line)
    if (!m) throw new Error(`压缩包列表无法识别：${line.slice(0, 120)}`)
    const type = m[1]
    if (type === 'l' || type === 'h' || !line.endsWith(name)) throw new Error(`压缩包含链接条目：${line.slice(0, 120)}`)
    if (type !== '-' && type !== 'd') throw new Error(`压缩包含特殊文件：${line.slice(0, 120)}`)
    const norm = name.replace(/\\/g, '/')
    if (/^[a-zA-Z]:/.test(norm) || norm.startsWith('/')) throw new Error(`压缩包含绝对路径：${name}`)
    if (norm.split('/').includes('..')) throw new Error(`压缩包含越界路径：${name}`)
    assertSafeName(norm)
    total += Number(m[2])
    if (total > EXTRACT_MAX_BYTES) throw new Error(`压缩包解压后超过 ${EXTRACT_MAX_BYTES / 1024 / 1024}MB`)
  })
}

/** bsdtar 包装（60s 超时；参数是数组，不拼 shell 字符串）；返回 stdout（列表用，最多 4MB） */
function runTar(args: string[]): Promise<string> {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn(TAR_EXE, args, { windowsHide: true })
    // 先收 Buffer 再整体按 UTF-8 解码：中文名跨 chunk 边界时逐块 String() 会解出乱码，名单比对就会误拒
    const out: Buffer[] = []
    let outLen = 0
    let stderr = ''
    let overflow = false
    child.stdout.on('data', (b: Buffer) => {
      if (outLen > 4 * 1024 * 1024) {
        overflow = true
        child.kill()
        return
      }
      out.push(b)
      outLen += b.length
    })
    child.stderr.on('data', (b) => {
      if (stderr.length < 2000) stderr += String(b)
    })
    const timer = setTimeout(() => {
      child.kill()
      rejectFn(new Error('tar 解压超时'))
    }, 60_000)
    child.on('error', (e) => {
      clearTimeout(timer)
      rejectFn(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (overflow) rejectFn(new Error('压缩包列表过大'))
      else if (code === 0) resolveFn(Buffer.concat(out).toString('utf8'))
      else rejectFn(new Error(`tar 解压失败：${stderr.slice(0, 200) || `exit ${code}`}`))
    })
  })
}

/**
 * 解压后的终检（lstat，不跟随链接）：每一项都在 root 内；
 * 任何符号链接 / junction（Node 在 Windows 上把 junction 报成符号链接）/ 硬链接（nlink > 1）都拒绝；
 * 条目数与累计字节不超上限。
 */
function assertExtracted(root: string): void {
  let count = 0
  let bytes = 0
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (!inside(root, p)) throw new Error(`解压结果越出临时目录：${p}`)
      assertSafeName(name)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) throw new Error(`解压结果含链接：${name}`)
      if (++count > EXTRACT_MAX_ENTRIES) throw new Error(`压缩包条目过多（上限 ${EXTRACT_MAX_ENTRIES}）`)
      if (st.isDirectory()) {
        walk(p)
        continue
      }
      if (!st.isFile()) throw new Error(`解压结果含特殊文件：${name}`)
      if (st.nlink > 1) throw new Error(`解压结果含硬链接：${name}`)
      bytes += st.size
      if (bytes > EXTRACT_MAX_BYTES) throw new Error(`压缩包解压后超过 ${EXTRACT_MAX_BYTES / 1024 / 1024}MB`)
    }
  }
  walk(root)
}

/**
 * 在解压根里找「最浅的含 SKILL.md / AGENTS.md 的目录」，返回该目录绝对路径。
 * 找不到 → 抛错（调用方负责 cleanup）。
 */
export function findSkillDir(root: string): string {
  const candidates: { dir: string; depth: number }[] = []
  const walk = (dir: string, depth: number): void => {
    for (const f of ['SKILL.md', 'AGENTS.md']) {
      if (existsSync(join(dir, f))) {
        candidates.push({ dir, depth })
        return
      }
    }
    if (depth >= 4) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1)
    }
  }
  walk(root, 0)
  if (candidates.length === 0) throw new Error('压缩包里没找到 SKILL.md（不是合法的 skill 目录布局）')
  candidates.sort((a, b) => a.depth - b.depth)
  return candidates[0].dir
}

export { tempRoot, cleanup }
