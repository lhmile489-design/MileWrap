import { join } from 'node:path'

/**
 * npm cmd-shim 生成的 .cmd 批处理壳解析结果。
 * - exe：壳只是转发到某个 exe（claude.cmd 就是这种），直接启动那个 exe
 * - node：壳用 node 运行某个 js（codex.cmd 就是这种），启动 node + js
 */
export type ShimTarget = { kind: 'exe'; file: string } | { kind: 'node'; script: string }

const EXE_RE = /"%dp0%\\([^"]+?\.exe)"/i
const NODE_RE = /"%_prog%"\s+"%dp0%\\([^"]+?\.(?:js|cjs|mjs))"/i

/**
 * 从批处理文本还原真实目标。只认 npm cmd-shim 的两种模板，其余返回 null，
 * 调用方退回 cmd.exe 包装。dp0 是 .cmd 所在目录（不带结尾反斜杠）。
 */
export function parseCmdShim(text: string, dp0: string): ShimTarget | null {
  const node = NODE_RE.exec(text)
  if (node) return { kind: 'node', script: join(dp0, node[1]) }
  const exe = EXE_RE.exec(text)
  if (exe) return { kind: 'exe', file: join(dp0, exe[1]) }
  return null
}
