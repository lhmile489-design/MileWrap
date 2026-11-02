/*
 * M0 探针：用正式代码（src/main/lib）解析三个 agent，再用 node-pty 实跑。
 * 运行：npm run probe（Electron 主进程）或 node scripts/verify-m0-pty.cjs
 * 结果写到 scripts/m0-report.json（已 gitignore），控制台打印摘要。
 *
 * 会话 ID 写入时机的探测会在临时目录里短暂启动 codex / kimi（不发消息，几秒后结束），
 * 只读取 ~/.codex/sessions 与 ~/.kimi-code/session_index.jsonl，不修改它们。
 */
const { join, resolve } = require('node:path')
const { mkdtempSync, readFileSync, readdirSync, statSync, existsSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir, homedir } = require('node:os')
const { execFile } = require('node:child_process')

const root = resolve(__dirname, '..')
const isElectronMain = Boolean(process.versions.electron) && !process.env.ELECTRON_RUN_AS_NODE

function loadLib() {
  const esbuild = require('esbuild')
  const out = join(mkdtempSync(join(tmpdir(), 'warp-m0-')), 'lib.cjs')
  esbuild.buildSync({
    stdin: {
      contents: [
        "export * from './src/main/lib/argTokenizer'",
        "export * from './src/main/lib/commandResolver'",
        "export * from './src/main/lib/shimParser'"
      ].join('\n'),
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    logLevel: 'error'
  })
  return require(out)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function killTree(pid) {
  return new Promise((done) =>
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => done())
  )
}

function cleanEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.FORCE_COLOR
  return env
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')

/** 起一个 PTY，收集输出，可选写入，到时或退出后返回 */
function runPty(pty, spec, { cwd, waitMs = 8000, writes = [], triggers = [], cols = 120, rows = 30, resizeTo = null }) {
  return new Promise((done) => {
    let out = ''
    let exitCode = null
    let finished = false
    const p = pty.spawn(spec.file, spec.args, { name: 'xterm-256color', cols, rows, cwd, env: cleanEnv(), useConpty: true })
    const fired = new Set()
    p.onData((d) => {
      out += d
      const plain = stripAnsi(out).replace(/\s+/g, '')
      triggers.forEach((t, i) => {
        if (!fired.has(i) && t.re.test(plain)) {
          fired.add(i)
          setTimeout(() => !finished && p.write(t.data), t.delay ?? 400)
        }
      })
    })
    p.onExit(({ exitCode: c }) => {
      exitCode = c
      finish()
    })
    for (const w of writes) setTimeout(() => !finished && p.write(w.data), w.at)
    if (resizeTo) setTimeout(() => !finished && p.resize(resizeTo.cols, resizeTo.rows), resizeTo.at)
    const timer = setTimeout(async () => {
      await killTree(p.pid)
      // taskkill 后进程已退出时再 kill() 会让 node-pty 的 console-list agent 报 AttachConsole failed
      setTimeout(() => {
        if (exitCode === null) { try { p.kill() } catch {} }
        setTimeout(finish, 300)
      }, 300)
    }, waitMs)
    function finish() {
      if (finished) return
      finished = true
      clearTimeout(timer)
      done({ pid: p.pid, exitCode, raw: out, text: stripAnsi(out) })
    }
  })
}

function listCodexRollouts() {
  const base = join(homedir(), '.codex', 'sessions')
  const found = []
  const walk = (dir, depth) => {
    let names = []
    try { names = readdirSync(dir) } catch { return }
    for (const n of names) {
      const p = join(dir, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory() && depth < 3) walk(p, depth + 1)
      else if (/^rollout-.*\.jsonl$/.test(n)) found.push(p)
    }
  }
  walk(base, 0)
  return new Set(found)
}

function readKimiIndex() {
  try {
    return readFileSync(join(homedir(), '.kimi-code', 'session_index.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
}

async function main() {
  const lib = loadLib()
  const pty = require('node-pty')
  const env = lib.envFromProcess(process.env)
  const report = { at: new Date().toISOString(), runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`, checks: [] }
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`)
  }

  // 1. 纯逻辑：参数切分与 shim 模板
  const tk = lib.tokenizeArgs('--model "gpt 5" -c key=\\"v\\" plain')
  check('argTokenizer 引号与转义', JSON.stringify(tk) === JSON.stringify(['--model', 'gpt 5', '-c', 'key="v"', 'plain']), tk)

  // 2. 解析三个 agent
  const specs = {}
  for (const name of ['claude', 'codex', 'kimi']) {
    const spec = lib.resolveLaunch(name, ['--version'], env)
    specs[name] = spec
    check(`resolve ${name}`, Boolean(spec && spec.via !== 'cmd-wrap'), spec && { via: spec.via, file: spec.file, resolvedPath: spec.resolvedPath })
  }

  // 3. --version 经 PTY 直启
  const work = mkdtempSync(join(tmpdir(), 'warp-m0-cwd-'))
  for (const [name, spec] of Object.entries(specs)) {
    if (!spec) continue
    const r = await runPty(pty, spec, { cwd: work, waitMs: 15000 })
    const ver = (r.text.match(/\d+\.\d+\.\d+/) || [null])[0]
    check(`pty ${name} --version`, r.exitCode === 0 && Boolean(ver), { exitCode: r.exitCode, version: ver })
  }

  // 4. 中文输出（ConPTY → node-pty 的 UTF-8）
  const nodeSpec = lib.resolveLaunch('node', ['-e', "process.stdout.write('中文输出测试 E:\\\\项目\\n')"], env)
  const zh = await runPty(pty, nodeSpec, { cwd: work, waitMs: 8000 })
  check('中文输出 node', zh.text.includes('中文输出测试'), JSON.stringify(zh.text.trim().slice(0, 60)))

  const ps = lib.resolveLaunch('powershell', ['-NoLogo', '-NoProfile', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output '中文PS'"], env)
  const zhPs = await runPty(pty, ps, { cwd: work, waitMs: 10000 })
  check('中文输出 powershell', zhPs.text.includes('中文PS'), JSON.stringify(zhPs.text.trim().slice(0, 60)))

  // 5. Ctrl+C：node 长驻进程收到 \x03 应退出
  const loop = lib.resolveLaunch('node', ['-e', "process.stdin.setRawMode&&process.stdin.setRawMode(false);setInterval(()=>{},1000);console.log('READY')"], env)
  const cc = await runPty(pty, loop, { cwd: work, waitMs: 6000, writes: [{ at: 1500, data: '\x03' }] })
  check('Ctrl+C 结束前台进程', cc.exitCode !== null, { exitCode: cc.exitCode })

  // 6. resize 后子进程拿到新尺寸
  // ConPTY 下 libuv 的 resize 事件依赖控制台布局钩子，不可靠；轮询 getWindowSize 才是 PTY 尺寸的真值
  // libuv 只在 raw mode 读 stdin 时从 ConPTY 收到 WINDOW_BUFFER_SIZE_EVENT；真实 TUI 都开 raw mode
  const sz = lib.resolveLaunch('node', ['-e', "process.stdin.setRawMode(true);process.stdin.resume();const t=()=>console.log('SIZE '+process.stdout.columns+' '+process.stdout.rows);t();process.stdout.on('resize',t);setTimeout(()=>process.exit(0),3000)"], env)
  const rs = await runPty(pty, sz, { cwd: work, waitMs: 5000, resizeTo: { at: 1200, cols: 90, rows: 20 } })
  // 再用 PowerShell 直接读控制台缓冲区尺寸，排除 libuv 缓存的影响
  const psz = lib.resolveLaunch('powershell', ['-NoLogo', '-NoProfile', '-Command', "$l='';1..40|%{$w=$Host.UI.RawUI.WindowSize;$s='PSIZE '+$w.Width+' '+$w.Height;if($s -ne $l){$l=$s;Write-Host $s};Start-Sleep -Milliseconds 100}"], env)
  const prs = await runPty(pty, psz, { cwd: work, waitMs: 8000, resizeTo: { at: 2500, cols: 90, rows: 20 } })
  check('resize 同步到 ConPTY（PowerShell 读缓冲区）', /PSIZE 120 30/.test(prs.text) && /PSIZE 90 20/.test(prs.text), prs.text.match(/PSIZE \d+ \d+/g))
  check('resize 同步到子进程', /SIZE 120 30/.test(rs.text) && /SIZE 90 20/.test(rs.text), rs.text.match(/SIZE \d+ \d+/g))

  // 7. 会话 ID 写入时机：启动后不发消息，看是否已经落盘
  if (specs.codex) {
    const before = listCodexRollouts()
    const spec = lib.resolveLaunch('codex', [], env)
    // 临时目录会弹 hook 信任确认框；选第 3 项「Continue without trusting」，不写入信任状态
    const r = await runPty(pty, spec, { cwd: work, waitMs: 20000, triggers: [{ re: /escskip/i, data: '\x1b[B\x1b[B', delay: 800 }, { re: /escskip/i, data: '\r', delay: 1500 }] })
    report.codexScreenTail = stripAnsi(r.text).replace(/\s+/g, ' ').slice(-300)
    const added = [...listCodexRollouts()].filter((p) => !before.has(p))
    // 实测结论：进入主界面后不发消息，不会建 rollout；ID 要等首条消息后才能发现（见技术设计 §5.8）
    const reachedMain = /Ask Codex|shortcuts/i.test(stripAnsi(r.text).replace(/\s+/g, ''))
    check('codex 首条消息前不建 rollout（进入主界面后空等 20 秒）', reachedMain && added.length === 0, { reachedMain, added: added.length })
    report.codexRolloutAddedOnStart = added.length > 0
  }
  if (specs.kimi) {
    const before = readKimiIndex()
    const spec = lib.resolveLaunch('kimi', [], env)
    const r = await runPty(pty, spec, { cwd: work, waitMs: 9000 })
    const after = readKimiIndex()
    const added = after.slice(before.length)
    check('kimi 启动即追加 session_index（不发消息）', added.length > 0, { added: added.length, sample: r.text.replace(/\s+/g, ' ').slice(0, 120) })
    report.kimiIndexAddedOnStart = added.length > 0
  }

  try { rmSync(work, { recursive: true, force: true }) } catch {}
  writeFileSync(join(__dirname, 'm0-report.json'), JSON.stringify(report, null, 2), 'utf8')
  const failed = report.checks.filter((c) => !c.ok).length
  console.log(`\n${report.checks.length - failed}/${report.checks.length} 通过；报告：scripts/m0-report.json`)
  return failed
}

if (isElectronMain) {
  const { app } = require('electron')
  app.setPath('appData', mkdtempSync(join(tmpdir(), 'warp-m0-appdata-')))
  app.whenReady().then(main).then((f) => app.exit(f ? 1 : 0), (e) => { console.error(e); app.exit(2) })
} else {
  main().then((f) => process.exit(f ? 1 : 0), (e) => { console.error(e); process.exit(2) })
}
