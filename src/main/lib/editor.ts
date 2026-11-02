import { spawn } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { envFromProcess, whichCommand } from './commandResolver'

/**
 * 「用 VS Code 打开到对应行」（升级建议 2.6）。只认 PATH 里的 `code` 命令：
 * code.cmd 的写法是 `"%~dp0..\Code.exe" "%~dp0..\resources\app\out\cli.js" %*`，
 * 这里从壳里取出 GUI 可执行文件直接启动，参数用数组，不经 cmd.exe（避免路径里的 & % 被二次解释）。
 * 探测结果缓存，找不到返回 null，界面上就只给「在资源管理器中显示」。
 */
let cached: string | null | undefined

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export function editorExe(): string | null {
  if (cached !== undefined) return cached
  cached = null
  const hit = whichCommand('code', envFromProcess(process.env))
  if (!hit) return null
  if (/\.exe$/i.test(hit)) {
    cached = hit
    return hit
  }
  let text = ''
  try {
    text = readFileSync(hit, 'utf8')
  } catch {
    return null
  }
  const m = /"%~dp0([^"]+?\.exe)"/i.exec(text)
  if (!m) return null
  const exe = resolve(dirname(hit), m[1].replace(/\\/g, '/'))
  if (isFile(exe)) cached = exe
  return cached
}

/** 在编辑器里打开绝对路径（已由调用方校验在工作区内），可带行号 */
export function openInEditor(absPath: string, line: number | null): boolean {
  const exe = editorExe()
  if (!exe) return false
  const target = line ? `${absPath}:${line}` : absPath
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
  try {
    const child = spawn(exe, ['--goto', target], { detached: true, stdio: 'ignore', windowsHide: false, env })
    child.on('error', () => undefined)
    child.unref()
    return true
  } catch {
    return false
  }
}
