/** 把 IPC 错误还原成主进程抛出的原始文案 */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  // invoke 的错误会被包成 "Error invoking remote method 'x': Error: 原因"
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
