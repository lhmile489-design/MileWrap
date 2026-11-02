/**
 * 把用户输入的启动参数字符串切成数组。支持双引号包裹与 `\"` 转义，
 * 不做变量展开、不识别 shell 元字符：结果直接交给 spawn，永不拼接 shell 字符串。
 */
export function tokenizeArgs(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  let hasToken = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '\\' && input[i + 1] === '"') {
      cur += '"'
      hasToken = true
      i++
    } else if (ch === '"') {
      inQuote = !inQuote
      hasToken = true
    } else if (!inQuote && /\s/.test(ch)) {
      if (hasToken) out.push(cur)
      cur = ''
      hasToken = false
    } else {
      cur += ch
      hasToken = true
    }
  }
  if (inQuote) throw new Error('启动参数里的双引号没有闭合')
  if (hasToken) out.push(cur)
  return out
}
