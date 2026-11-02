import { renameSync, rmSync, writeFileSync } from 'node:fs'

/** 先写同目录临时文件再 rename，断电时只会留下旧文件或新文件，不会留半截 */
export function atomicWrite(file: string, data: string | Buffer): void {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    // 文本按 UTF-8（无 BOM）写；Buffer 原样写（图标 PNG）
    if (typeof data === 'string') writeFileSync(tmp, data, { encoding: 'utf8' })
    else writeFileSync(tmp, data)
    renameSync(tmp, file)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // 临时文件删不掉不影响主流程
    }
    throw e
  }
}
