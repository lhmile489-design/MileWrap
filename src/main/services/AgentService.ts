import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { AgentDef, AgentInfo } from '@shared/types'
import { envFromProcess, resolveLaunch, spawnArgs, type LaunchSpec } from '../lib/commandResolver'

/** 内置预设（PRD A-01）。shell 不走 PATH 解析，见 shellLaunch() */
export const BUILTIN_AGENTS: AgentDef[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude', builtin: true },
  { id: 'codex', name: 'Codex CLI', command: 'codex', builtin: true },
  { id: 'kimi', name: 'Kimi Code', command: 'kimi', builtin: true },
  { id: 'pi', name: 'Pi', command: 'pi', builtin: true },
  { id: 'shell', name: 'PowerShell', command: 'powershell', builtin: true }
]

const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows'
const SHELL_CANDIDATES = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  `${SYSTEM_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
]

const VERSION_TIMEOUT_MS = 5000

/**
 * agent 探测与启动规格解析。探测只执行 agent 自己的 --version，不执行项目代码；
 * 版本在启动后异步取一次并缓存，agent:redetect 时重来。
 */
export class AgentService {
  private cache = new Map<string, AgentInfo>()
  private detecting: Promise<AgentInfo[]> | null = null
  /** 自定义 agent 列表（PRD A-03）：由 index.ts 从 ConfigStore 注入，每次取最新 */
  private customs: () => AgentDef[] = () => []

  setCustomSource(fn: () => AgentDef[]): void {
    this.customs = fn
  }

  /** 内置 + 自定义 */
  all(): AgentDef[] {
    return [...BUILTIN_AGENTS, ...this.customs()]
  }

  /** 自定义 agent 改了：丢掉缓存，下次 detect 重新探测 */
  invalidate(): void {
    this.cache.clear()
  }

  /** 默认 shell：设置里指定的优先，其次 pwsh 7，最后 Windows PowerShell 5.1 */
  shellLaunch(shellPath: string | null): LaunchSpec {
    const file =
      (shellPath && existsSync(shellPath) ? shellPath : null) ??
      SHELL_CANDIDATES.find((p) => existsSync(p)) ??
      SHELL_CANDIDATES[1]
    // cmd 不认 -NoLogo（会当成命令执行）；PowerShell 用它去掉启动横幅
    const args = /\\cmd\.exe$/i.test(file) ? [] : ['-NoLogo']
    return { file, args, via: 'exe', resolvedPath: file }
  }

  /**
   * 设置页「默认 Shell」的可选项（PRD A-04）：只列本机实际存在的。
   * settings:update 的 shellPath 必须是这里的某一项，渲染层不能指定任意可执行文件（技术设计 §8 第 1 条）。
   */
  shells(): { label: string; path: string }[] {
    const all = [
      { label: 'PowerShell 7', path: SHELL_CANDIDATES[0] },
      { label: 'Windows PowerShell 5.1', path: SHELL_CANDIDATES[1] },
      { label: '命令提示符（cmd）', path: `${SYSTEM_ROOT}\\System32\\cmd.exe` }
    ]
    return all.filter((s) => existsSync(s.path))
  }

  /** 解析某个 agent 的启动规格；agentPath 是工作区级覆盖（PRD Q7） */
  resolve(agentId: string, args: string[], agentPath: string | null, shellPath: string | null): LaunchSpec | null {
    if (agentId === 'shell') {
      const spec = this.shellLaunch(shellPath)
      return { ...spec, args: [...spec.args, ...args] }
    }
    const def = this.all().find((a) => a.id === agentId)
    if (!def) return null
    // 自定义 agent 的默认参数在工作区参数之前（续接参数又在两者之前，由调用方拼）
    const full = def.builtin ? args : [...(def.defaultArgs ?? []), ...args]
    return resolveLaunch(agentPath ?? def.command, full, envFromProcess(process.env))
  }

  list(): AgentInfo[] {
    return this.all().map(
      (a) =>
        this.cache.get(a.id) ?? {
          id: a.id,
          name: a.name,
          resolvedPath: null,
          via: null,
          version: null,
          available: false
        }
    )
  }

  /** 首次调用时探测，之后复用缓存；force 用于 agent:redetect */
  detect(force = false): Promise<AgentInfo[]> {
    if (!force && this.cache.size > 0 && this.all().every((a) => this.cache.has(a.id))) return Promise.resolve(this.list())
    if (this.detecting) return this.detecting
    if (force) this.cache.clear()
    this.detecting = Promise.all(this.all().map((a) => this.detectOne(a)))
      .then((infos) => {
        for (const info of infos) this.cache.set(info.id, info)
        return infos
      })
      .finally(() => {
        this.detecting = null
      })
    return this.detecting
  }

  private async detectOne(def: AgentDef): Promise<AgentInfo> {
    const spec = this.resolve(def.id, [], null, null)
    const base: AgentInfo = {
      id: def.id,
      name: def.id === 'shell' && spec ? shellName(spec.file) : def.name,
      resolvedPath: spec?.resolvedPath ?? null,
      via: spec?.via ?? null,
      version: null,
      available: Boolean(spec)
    }
    if (!spec || def.id === 'shell') return base
    // 自定义 agent 不保证认 --version，只报是否找得到，不去执行它
    if (!def.builtin) return base
    base.version = await readVersion(spec)
    return base
  }
}

function shellName(file: string): string {
  return /pwsh\.exe$/i.test(file) ? 'PowerShell 7' : 'Windows PowerShell'
}

/** 跑 `<agent> --version`，取输出里第一个形如 1.2.3 的版本号 */
function readVersion(spec: LaunchSpec): Promise<string | null> {
  return new Promise((done) => {
    try {
      // cmd-wrap 是整条已转义的命令行：拆回数组给 execFile，再用 windowsVerbatimArguments 让 Node 不再加引号
      const args = spawnArgs({ ...spec, args: [...spec.args, '--version'] })
      execFile(
        spec.file,
        typeof args === 'string' ? [args] : args,
        { windowsHide: true, timeout: VERSION_TIMEOUT_MS, encoding: 'utf8', windowsVerbatimArguments: typeof args === 'string' },
        (_err, stdout, stderr) => {
          const m = /\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?/.exec(`${stdout}\n${stderr}`)
          done(m ? m[0] : null)
        }
      )
    } catch {
      done(null)
    }
  })
}
