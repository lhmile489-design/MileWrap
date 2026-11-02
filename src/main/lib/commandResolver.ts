import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { parseCmdShim } from './shimParser'

/**
 * 最终交给 node-pty 的启动规格。args 是目标程序收到的参数；
 * cmd-wrap 时 file 是 cmd.exe、args 是给 .cmd 的参数，真正的命令行由 spawnArgs() 拼。
 */
export type LaunchSpec = {
  file: string
  args: string[]
  /** 解析链路，供设置页与诊断显示 */
  via: 'exe' | 'shim-exe' | 'shim-node' | 'cmd-wrap'
  /** PATH 里命中的那个文件（可能是 .cmd 壳） */
  resolvedPath: string
}

export type ResolveEnv = {
  path: string
  pathext: string
  comspec: string
}

export function envFromProcess(env: NodeJS.ProcessEnv = process.env): ResolveEnv {
  return {
    path: env.Path ?? env.PATH ?? '',
    pathext: env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    comspec: env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'
  }
}

const LAUNCHABLE = new Set(['.com', '.exe', '.bat', '.cmd'])

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * 按 PowerShell 的顺序找命令：PATH 目录在外层，每个目录内按 PATHEXT 优先级。
 * 只认能被 CreateProcess 或 cmd 处理的扩展名，跳过 npm 生成的无扩展名 sh 脚本。
 */
export function whichCommand(name: string, env: ResolveEnv): string | null {
  const exts = env.pathext
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => LAUNCHABLE.has(e))
  const dirs = env.path.split(';').map((d) => d.trim()).filter(Boolean)
  const givenExt = extname(name).toLowerCase()

  for (const dir of dirs) {
    if (givenExt && LAUNCHABLE.has(givenExt)) {
      const p = join(dir, name)
      if (isFile(p)) return p
      continue
    }
    for (const ext of exts) {
      const p = join(dir, name + ext)
      if (isFile(p)) return p
    }
  }
  return null
}

/** cmd 会解释的字符（含空格），照 cross-spawn 的做法逐个加 ^ */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

/**
 * 单个参数：先按 CommandLineToArgvW 规则加引号、转义引号前的反斜杠，再给 cmd 元字符加 ^。
 * 转两遍：cmd 解析一次，批处理里的 %* 展开后还会再解析一次。
 */
function escapeCmdArg(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`
  return quoted.replace(CMD_META, '^$1').replace(CMD_META, '^$1')
}

/**
 * cmd-wrap 的完整命令行（不含 cmd.exe 本身）：/d /s /c "<壳路径> <参数...>"。
 * /s 去掉最外层那对引号，其余原样交给 cmd；壳路径转一遍，参数转两遍。
 * 不能把参数数组交给 node-pty：它只在有空格时加引号，不转义 & | % ^（2026-11-01 实测，见踩坑记录）。
 */
export function cmdWrapLine(resolvedPath: string, args: string[]): string {
  return `/d /s /c "${[resolvedPath.replace(CMD_META, '^$1'), ...args.map(escapeCmdArg)].join(' ')}"`
}

/**
 * 交给 spawn 的参数：cmd-wrap 返回整条命令行字符串（node-pty 原样使用；execFile 需配 windowsVerbatimArguments），
 * 其余返回数组。
 */
export function spawnArgs(spec: LaunchSpec): string[] | string {
  return spec.via === 'cmd-wrap' ? cmdWrapLine(spec.resolvedPath, spec.args) : spec.args
}

/**
 * 把命中的文件变成启动规格。.exe 直接起；.cmd/.bat 先还原 npm shim，
 * 还原不了才经 cmd.exe /d /s /c 包装，命令行由 spawnArgs() 转义。
 */
export function toLaunchSpec(resolvedPath: string, args: string[], env: ResolveEnv): LaunchSpec {
  const ext = extname(resolvedPath).toLowerCase()
  if (ext === '.exe' || ext === '.com') {
    return { file: resolvedPath, args, via: 'exe', resolvedPath }
  }

  let text = ''
  try {
    text = readFileSync(resolvedPath, 'utf8')
  } catch {
    // 读不到按普通批处理处理
  }
  const target = text ? parseCmdShim(text, dirname(resolvedPath)) : null

  if (target?.kind === 'exe' && isFile(target.file)) {
    return { file: target.file, args, via: 'shim-exe', resolvedPath }
  }
  if (target?.kind === 'node' && isFile(target.script)) {
    // 与 cmd-shim 的逻辑一致：壳所在目录有 node.exe 就用它，否则走 PATH
    const local = join(dirname(resolvedPath), 'node.exe')
    const node = existsSync(local) ? local : whichCommand('node', env)
    if (node) return { file: node, args: [target.script, ...args], via: 'shim-node', resolvedPath }
  }
  return { file: env.comspec, args, via: 'cmd-wrap', resolvedPath }
}

/** command 可以是裸命令名，也可以是用户指定的绝对路径（agentPath） */
export function resolveLaunch(command: string, args: string[], env: ResolveEnv): LaunchSpec | null {
  const hit = isAbsolute(command) ? (isFile(command) ? command : null) : whichCommand(command, env)
  return hit ? toLaunchSpec(hit, args, env) : null
}
