import AdmZip from 'adm-zip'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { inside } from '../services/history/common'

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
 * 返回临时目录；任何条目越界 → 抛错并清空临时目录。
 */
export function extractZipGuarded(zipPath: string): string {
  const root = tempRoot()
  try {
    const zip = new AdmZip(zipPath)
    for (const entry of zip.getEntries()) {
      const name = entry.entryName
      // 盘符 / 反斜杠 / .. 段 / 绝对路径一律拒绝（entryName 统一 / 分隔，但防御性两种都查）
      if (/[\\]/.test(name) === false && /^[a-zA-Z]:/.test(name)) throw new Error(`压缩包含盘符路径：${name}`)
      const target = resolve(root, name.replace(/\\/g, '/'))
      if (!inside(root, target)) throw new Error(`压缩包含越界路径：${name}`)
      if (entry.isDirectory) {
        mkdirSync(target, { recursive: true })
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      // symlink 属性位：不落盘符号链接（内容可能伪装目标），一律当普通文件写内容
      writeFileSync(target, entry.getData())
    }
    // 终检：临时目录里所有文件都必须仍在 root 内（防未知的绕过路径）
    assertAllInside(root, root)
    return root
  } catch (e) {
    cleanup(root)
    throw e
  }
}

/**
 * 解压 tar.gz 到临时目录：走系统 bsdtar（Windows 自带 libarchive，自带路径穿越防护），
 * 结束后再整体校验一遍。async：内部等 tar 子进程退出。
 */
export async function extractTarGzGuarded(tarPath: string): Promise<string> {
  const root = tempRoot()
  try {
    await runTar(tarPath, root)
    assertAllInside(root, root)
    return root
  } catch (e) {
    cleanup(root)
    throw e
  }
}

/** bsdtar 包装（60s 超时；参数是数组，不拼 shell 字符串） */
function runTar(tarPath: string, root: string): Promise<void> {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn('C:\\Windows\\System32\\tar.exe', ['-xzf', tarPath, '-C', root], { windowsHide: true })
    let stderr = ''
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
      if (code === 0) resolveFn()
      else rejectFn(new Error(`tar 解压失败：${stderr.slice(0, 200) || `exit ${code}`}`))
    })
  })
}

/** 递归断言 dir 下每个文件都在 root 内（解压后的终检） */
function assertAllInside(root: string, dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (!inside(root, p)) throw new Error(`解压结果越出临时目录：${p}`)
    if (e.isDirectory()) assertAllInside(root, p)
  }
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
