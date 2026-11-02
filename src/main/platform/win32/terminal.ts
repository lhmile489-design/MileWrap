import { spawn } from 'node:child_process'
import { lstatSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows'
const WINDOW_TITLE = 'Mile Warp'

/** wt.exe 是应用执行别名（重解析点），existsSync 认不出，用 lstat 判断 */
function present(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

function wtPath(): string | null {
  const local = process.env.LOCALAPPDATA
  if (!local) return null
  const p = join(local, 'Microsoft', 'WindowsApps', 'wt.exe')
  return present(p) ? p : null
}

/**
 * 在外部终端打开目录（技术设计 §8 第 5 条）。cwd 必须是调用方按工作区解析过的目录。
 * 目录从不进命令行，只经 spawn 的 cwd 选项传入：wt 用 `-d .`，PowerShell 直接继承 cwd。
 * 把路径塞进参数会踩两个坑：wt 把 `;` 当子命令分隔符，cmd 会解释 `&` `|`。
 */
export function openExternalTerminal(cwd: string): void {
  let isDir = false
  try {
    isDir = statSync(cwd).isDirectory()
  } catch {
    isDir = false
  }
  if (!isDir) throw new Error(`工作目录不存在：${cwd}`)

  const comspec = process.env.ComSpec ?? join(SYSTEM_ROOT, 'System32', 'cmd.exe')
  const wt = wtPath()
  // start 的第一个带引号参数是窗口标题。不能传 '""'：Node 会转义成 "\"\""。
  // 标题含空格时 Node 自动加引号，start 才把它当标题而不是程序名
  const args = wt
    ? ['/d', '/c', 'start', WINDOW_TITLE, 'wt.exe', '-d', '.']
    : ['/d', '/c', 'start', WINDOW_TITLE, join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), '-NoLogo', '-NoExit']

  const child = spawn(comspec, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => undefined)
  child.unref()
}
