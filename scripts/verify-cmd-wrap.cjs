/**
 * cmd-wrap 兜底路径验收（技术设计 §5.2）：还原不了 npm shim 的 .cmd / .bat 经 cmd.exe /d /s /c 启动时，
 * 参数里的 & | % ^ " 等字符必须原样到达最终进程，不被 cmd 二次解释。
 *
 * 用正式代码（src/main/lib/commandResolver）解析沙箱里的 .cmd（不是 npm 模板，只能走 cmd-wrap），
 * 壳所在目录名本身含空格、&、括号。分别经 node-pty（会话启动）与 execFile（--version 探测）跑一遍，
 * 由 node 脚本把收到的 argv 写进文件比对。
 *
 *   npx electron scripts/verify-cmd-wrap.cjs 2>&1 | Out-File $env:TEMP\warp-cmd-wrap.log -Encoding utf8
 */
const { app } = require('electron')
const { join } = require('node:path')
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { execFile } = require('node:child_process')

const ROOT = join(__dirname, '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'warp-cmdwrap-'))
app.setPath('appData', SANDBOX)

let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

setTimeout(() => {
  console.log('\n  FAIL  总超时 60 秒')
  app.exit(3)
}, 60000).unref()

function loadLib() {
  const esbuild = require('esbuild')
  const out = join(SANDBOX, 'lib.cjs')
  esbuild.buildSync({
    stdin: { contents: "export * from './src/main/lib/commandResolver'", resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    logLevel: 'error'
  })
  return require(out)
}

const CASES = [
  'plain',
  'a b',
  'a&b',
  '%PATH%',
  'x^y',
  '"q"',
  'a"&"b',
  'p|q',
  '<>',
  'trail\\',
  'C:\\dir with space\\',
  '(x)',
  '!x!',
  '',
  'k=v,w;z',
  '--flag=1 && echo pwned',
  '中文 参数'
]

function compare(label, file) {
  let got
  try {
    got = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    got = null
  }
  check(`${label}：收到 ${CASES.length} 个参数`, Array.isArray(got) && got.length === CASES.length, Array.isArray(got) ? got.length : 'NO OUTPUT')
  if (!Array.isArray(got)) return
  const bad = CASES.map((c, i) => [c, got[i]]).filter(([c, g]) => c !== g)
  check(`${label}：每个参数原样到达`, bad.length === 0, bad.length ? bad : null)
}

app.whenReady().then(async () => {
  const lib = loadLib()
  const pty = require('node-pty')
  const env = lib.envFromProcess(process.env)

  const dir = join(SANDBOX, 'tools dir & x(1)')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'echo.js'), "require('fs').writeFileSync(process.env.OUT_FILE, JSON.stringify(process.argv.slice(2)))\n", 'utf8')
  // 普通批处理，不是 npm cmd-shim 模板：只能走 cmd-wrap
  writeFileSync(join(dir, 'warp-echo.cmd'), '@echo off\r\nnode "%~dp0echo.js" %*\r\n', 'utf8')

  console.log('\n=== 解析 ===')
  const spec = lib.resolveLaunch(join(dir, 'warp-echo.cmd'), CASES, env)
  check('非 npm 模板的 .cmd 走 cmd-wrap', spec?.via === 'cmd-wrap', spec?.via)
  check('cmd-wrap 的 file 是 cmd.exe', /cmd\.exe$/i.test(spec?.file ?? ''), spec?.file)
  check('spec.args 仍是原始参数数组', JSON.stringify(spec?.args) === JSON.stringify(CASES))
  const line = lib.spawnArgs(spec)
  check('spawnArgs 返回整条命令行', typeof line === 'string' && line.startsWith('/d /s /c "'))
  check('exe 规格的 spawnArgs 原样返回数组', Array.isArray(lib.spawnArgs({ file: 'x.exe', args: ['a&b'], via: 'exe', resolvedPath: 'x.exe' })))

  console.log('\n=== node-pty（会话启动） ===')
  const ptyOut = join(SANDBOX, 'out-pty.json')
  await new Promise((done) => {
    const p = pty.spawn(spec.file, line, { cwd: SANDBOX, env: { ...process.env, OUT_FILE: ptyOut }, useConpty: true, cols: 120, rows: 30 })
    const t = setTimeout(done, 10000)
    p.onExit(() => {
      clearTimeout(t)
      done()
    })
  })
  compare('node-pty', ptyOut)
  check('没有被注入执行（pwned 未写出）', !existsSync(join(SANDBOX, 'pwned')))

  console.log('\n=== execFile（版本探测同款调用） ===')
  const execOut = join(SANDBOX, 'out-exec.json')
  await new Promise((done) => {
    execFile(spec.file, [line], { windowsHide: true, timeout: 10000, windowsVerbatimArguments: true, env: { ...process.env, OUT_FILE: execOut } }, () => done())
  })
  compare('execFile', execOut)

  console.log(`\n${pass}/${pass + fail} 通过`)
  try {
    rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    // 临时目录删不掉不影响结果
  }
  app.exit(fail ? 1 : 0)
})
