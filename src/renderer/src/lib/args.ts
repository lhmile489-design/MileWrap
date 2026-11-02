/**
 * 把已切分的启动参数数组还原成可编辑的文本，是主进程 argTokenizer 的逆运算：
 * - 含空白或为空的参数用双引号包住；参数里的 `"` 写成 `\"`
 * - tokenizer 里 `\"` 恒为转义，所以结尾的反斜杠要放到右引号之外（`"C:\my dir"\`）
 * 保证 tokenizeArgs(formatArgs(x)) 与 x 相同，编辑弹窗不改参数时原样保存。
 */
export function formatArgs(args: string[]): string {
  return args.map(formatOne).join(' ')
}

function formatOne(arg: string): string {
  if (arg === '') return '""'
  if (!/\s/.test(arg)) return arg.replace(/"/g, '\\"')
  const m = /\\+$/.exec(arg)
  const tail = m ? m[0] : ''
  const body = tail ? arg.slice(0, -tail.length) : arg
  return `"${body.replace(/"/g, '\\"')}"${tail}`
}
