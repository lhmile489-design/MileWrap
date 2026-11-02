import { appendFile, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const KEEP_DAYS = 7
const FILE_RE = /^main-(\d{4}-\d{2}-\d{2})\.log$/

let dir: string | null = null

function day(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 主进程日志（升级建议 1.2）：%APPDATA%\mile-warp\logs\main-YYYY-MM-DD.log，按天切分，保留 7 天。
 * 只记事件、频道名、时序与路径；不记环境变量值、终端输出、剪贴板内容。
 * 写盘失败一律吞掉，日志不能拖垮主流程。
 */
export function initLog(logDir: string): void {
  dir = logDir
  try {
    mkdirSync(logDir, { recursive: true })
    const cutoff = day(new Date(Date.now() - KEEP_DAYS * 86_400_000))
    for (const f of readdirSync(logDir)) {
      const m = FILE_RE.exec(f)
      if (m && m[1] < cutoff) rmSync(join(logDir, f), { force: true })
    }
  } catch {
    // 目录建不了就不写日志
  }
}

export function logDir(): string | null {
  return dir
}

export function log(event: string, detail?: Record<string, unknown>): void {
  if (!dir) return
  const now = new Date()
  let line = `${now.toISOString()} ${event}`
  if (detail) {
    try {
      line += ` ${JSON.stringify(detail)}`
    } catch {
      // 不可序列化的细节丢掉
    }
  }
  appendFile(join(dir, `main-${day(now)}.log`), line + '\n', { encoding: 'utf8' }, () => undefined)
}
