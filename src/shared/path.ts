/**
 * 目录规范化（会话管理升级计划 §3.1）：去掉 Codex 的 \\?\ 前缀，斜杠统一成 /，去尾斜杠，盘符大写。
 * 得到的是显示用的形态；比较用 dirKey（再转小写，Windows 路径不区分大小写）。
 */
export function normDir(p: string): string {
  let s = p.trim().replace(/\\/g, '/')
  if (/^\/\/\?\/UNC\//i.test(s)) s = '//' + s.slice(8)
  else if (/^\/\/\?\//.test(s)) s = s.slice(4)
  s = s.replace(/(.)\/+$/, '$1')
  if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1)
  if (/^[A-Z]:$/.test(s)) s += '/'
  return s
}

export function dirKey(p: string): string {
  return normDir(p).toLowerCase()
}

/** 显示给 Windows 用户看的形态：反斜杠 */
export function winPath(p: string): string {
  return normDir(p).replace(/\//g, '\\')
}
