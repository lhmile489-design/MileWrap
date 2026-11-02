/**
 * 启动参数清理验收：工作区参数开头误写了命令名（"claude --permission-mode bypassPermissions"）时，
 * 启动前要去掉，否则 agent 会把 "claude" 当成第一条消息发出去，每次启动、每次恢复都多一轮对话。
 * 用正式代码（src/main/lib/launchArgs）经 esbuild 打包后断言，不起 Electron：
 *   node scripts/verify-launch-args.cjs
 */
const { join, resolve } = require('node:path')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')

const root = resolve(__dirname, '..')
const esbuild = require('esbuild')
const out = join(mkdtempSync(join(tmpdir(), 'warp-launchargs-')), 'lib.cjs')
esbuild.buildSync({
  stdin: { contents: "export * from './src/main/lib/launchArgs'", resolveDir: root, loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { stripLeadingCommand } = require(out)

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}

const flags = ['--permission-mode', 'bypassPermissions']
check('开头的 claude 被去掉', stripLeadingCommand(['claude', ...flags], 'claude', 'claude'), flags)
check('大小写不敏感', stripLeadingCommand(['Claude', ...flags], 'claude', 'claude'), flags)
check('带 .exe 后缀', stripLeadingCommand(['claude.exe', ...flags], 'claude', 'claude'), flags)
check('带路径和 .cmd 后缀', stripLeadingCommand(['C:\\bin\\claude.cmd', ...flags], 'claude', 'claude'), flags)
check('没有多余命令名时原样返回', stripLeadingCommand(flags, 'claude', 'claude'), flags)
check('只去开头一个，后面的 claude 保留', stripLeadingCommand(['claude', '--model', 'claude'], 'claude', 'claude'), ['--model', 'claude'])
check('别的 agent 的名字不动', stripLeadingCommand(['codex', ...flags], 'claude', 'claude'), ['codex', ...flags])
check('命令名与 id 不同时按命令名匹配', stripLeadingCommand(['agy', '-x'], 'my-agent', 'agy'), ['-x'])
check('空数组', stripLeadingCommand([], 'claude', 'claude'), [])
check('只有命令名时变成空数组', stripLeadingCommand(['claude'], 'claude', 'claude'), [])

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
