/**
 * 启动参数里常见的误填：把 agent 的命令名当成参数写在最前面（"claude --permission-mode bypassPermissions"）。
 * 命令由应用按 agent 解析，参数里再带一个 claude，agent 会把它当成第一条提示词发出去，每次启动都多出一轮对话。
 * 只去掉最前面那个与 agent id 或命令名完全相同的词（忽略大小写和 .exe/.cmd 后缀），其余原样保留。
 */
export function stripLeadingCommand(args: string[], agentId: string, command: string): string[] {
  if (args.length === 0) return args
  const bare = (s: string): string =>
    (s.split(/[\\/]/).pop() ?? s).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
  const names = new Set([bare(agentId), bare(command)])
  return names.has(bare(args[0])) ? args.slice(1) : args
}
