/**
 * M4 验收：关闭确认、托盘、会话快照、一键恢复与续接（技术设计 §5.7 / §5.8 / §10 verify-m3-restore）。
 *
 * 一个编排进程 + 三次真实启动（每次是独立的 Electron 进程，共用同一个沙箱 appData）：
 *   第 1 次：四宫格里开 claude / codex / kimi / shell，后台再开几个；验证续接 ID 的获取
 *           （Claude 自生成、Codex 单会话认领 rollout、同目录两个 Codex 有歧义不写、Kimi 同目录排队各拿各的）；
 *           关闭确认框：取消 / 最小化到托盘 / 勾「下次不再询问」后全部结束并退出
 *   第 2 次：恢复卡片候选（目录被删的被过滤、不能续接的标新开）；逐条改新开、取消勾选；全部恢复后
 *           检查实际启动参数（--resume / resume / --session）与格位；忽略；「续接上次对话启动」；
 *           记住的关闭方式直接退出
 *   第 3 次：启动时自动恢复，只拉起上次没正常退出的
 *
 * agent 用沙箱里的假 agent（npm cmd-shim 格式的 .cmd + node 脚本）：把收到的参数写到文件，
 * Codex 假体在沙箱 home 下写 rollout，Kimi 假体追加 session_index；不碰真实的 ~/.codex、~/.kimi-code。
 *
 *   npm run build
 *   npx electron scripts/verify-m4-restore.cjs 2>&1 | Out-File $env:TEMP\warp-m4.log -Encoding utf8
 */
const { app, BrowserWindow } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3)
const PHASE = arg('phase')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'))

/** 沙箱布局：appData / agentHome / 假 agent / 各工作区目录 */
function paths(sandbox) {
  return {
    sandbox,
    cfgDir: join(sandbox, 'mile-warp'),
    cfg: join(sandbox, 'mile-warp', 'config.json'),
    home: join(sandbox, 'agent-home'),
    bin: join(sandbox, 'bin'),
    argvDir: join(sandbox, 'agent-home', 'argv'),
    pids: join(sandbox, 'pids.json'),
    dir: (name) => join(sandbox, `目录 ${name}`)
  }
}

function pidAlive(pid) {
  try {
    const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true })
    return out.includes(`"${pid}"`)
  } catch {
    return false
  }
}

// ======================================================================
// 编排进程
// ======================================================================

/** 假 agent：参数写到 argv/<pid>.json；codex / kimi 按 §5.8 的方式「登记」会话；收到 q 以退出码 3 退出 */
const FAKE_AGENT = String.raw`
const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs')
const { join } = require('node:path')
const { randomUUID } = require('node:crypto')
module.exports = (agent) => {
  const home = process.env.MILE_WARP_AGENT_HOME
  const argv = process.argv.slice(2)
  mkdirSync(join(home, 'argv'), { recursive: true })
  writeFileSync(join(home, 'argv', process.pid + '.json'), JSON.stringify({ agent, argv, cwd: process.cwd() }))
  console.log('FAKE ' + agent + ' ready')
  const resumed = argv.includes('--session') || argv.includes('--continue') || argv[0] === 'resume' || argv.includes('--resume')
  if (agent === 'codex' && !resumed) {
    // Codex：首条消息后才建 rollout，这里用 1 秒延迟模拟
    setTimeout(() => {
      const d = new Date()
      const day = join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
      mkdirSync(day, { recursive: true })
      const id = randomUUID()
      const meta = { timestamp: d.toISOString(), type: 'session_meta', payload: { id, cwd: process.cwd(), originator: 'fake' } }
      writeFileSync(join(day, 'rollout-' + Date.now() + '-' + id + '.jsonl'), JSON.stringify(meta) + '\n')
    }, 1000)
  }
  if (agent === 'kimi' && !resumed) {
    mkdirSync(join(home, '.kimi-code'), { recursive: true })
    const row = { sessionId: 'session_' + randomUUID(), workDir: process.cwd().replace(/\\/g, '/') }
    appendFileSync(join(home, '.kimi-code', 'session_index.jsonl'), JSON.stringify(row) + '\n')
  }
  process.stdin.on('data', (d) => {
    if (String(d).includes('q')) process.exit(3)
  })
  setInterval(() => {}, 1000)
}
`

function setupSandbox() {
  const p = paths(mkdtempSync(join(tmpdir(), 'warp-m4-')))
  for (const d of [p.cfgDir, p.home, p.bin]) mkdirSync(d, { recursive: true })
  writeFileSync(join(p.bin, 'fake-common.js'), FAKE_AGENT, 'utf8')
  for (const a of ['claude', 'codex', 'kimi']) {
    writeFileSync(join(p.bin, `fake-${a}.js`), `require('./fake-common.js')(${JSON.stringify(a)})\n`, 'utf8')
    // npm cmd-shim 的模板：shimParser 认出 "%_prog%" "%dp0%\x.js" 后直接启动 node + js
    writeFileSync(join(p.bin, `${a}.cmd`), `@ECHO off\r\nSET "_prog=node"\r\n"%_prog%"  "%dp0%\\fake-${a}.js" %*\r\n`, 'utf8')
  }
  const now = Date.now()
  const ws = (id, agentId, name, order) => {
    const cwd = p.dir(name)
    mkdirSync(cwd, { recursive: true })
    return {
      id, groupId: null, name, note: '', agentId, cwd, args: [], envKeys: [], envEnc: null, order, createdAt: now, updatedAt: now + order,
      agentPath: agentId === 'shell' ? null : join(p.bin, `${agentId}.cmd`)
    }
  }
  const workspaces = [
    ws('wsClaude', 'claude', 'claude', 0),
    ws('wsCodex', 'codex', 'codex', 1),
    ws('wsKimi', 'kimi', 'kimi', 2),
    ws('wsShell', 'shell', 'shell', 3),
    ws('wsCodex2', 'codex', 'codex2', 4),
    ws('wsGone', 'shell', 'gone', 5)
  ]
  writeFileSync(
    p.cfg,
    JSON.stringify({ version: 1, groups: [], workspaces, customAgents: [], settings: { closeAction: 'ask' }, sessionRecords: [] }, null, 2),
    'utf8'
  )
  return p
}

let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

/** 起一个阶段进程，转发输出，统计 PASS / FAIL；返回退出码 */
function runPhase(n, p, timeoutMs = 150000) {
  return new Promise((resolve) => {
    console.log(`\n######## 第 ${n} 次启动 ########`)
    const env = { ...process.env, MILE_WARP_AGENT_HOME: p.home }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(process.execPath, [__filename, `--phase=${n}`, `--sandbox=${p.sandbox}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const onChunk = (buf) => {
      tail += buf.toString('utf8')
      const lines = tail.split(/\r?\n/)
      tail = lines.pop()
      for (const l of lines) {
        if (/^\s+PASS\s/.test(l)) pass++
        else if (/^\s+FAIL\s/.test(l)) fail++
        if (/PASS|FAIL|===|\[renderer\]|异常/.test(l)) console.log(l)
      }
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', (b) => {
      const s = b.toString('utf8')
      if (/FAIL|异常|Error:/.test(s) && !/GPU|gpu_|command_buffer/.test(s)) console.log('  [stderr]', s.trim().slice(0, 300))
    })
    const timer = setTimeout(() => {
      console.log(`  FAIL  第 ${n} 次启动超时`)
      fail++
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch {}
    }, timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

async function orchestrate() {
  const p = setupSandbox()
  const leftovers = () =>
    (existsSync(p.argvDir) ? readdirSync(p.argvDir) : []).map((f) => Number(f.replace('.json', ''))).filter(pidAlive)

  // ---------- 第 1 次 ----------
  const c1 = await runPhase(1, p)
  check('第 1 次：确认框选「全部结束并退出」后进程自己退出', c1 === 0, c1)
  const cfg1 = readJson(p.cfg)
  check('「下次不再询问」写入 closeAction = quit', cfg1.settings.closeAction === 'quit', cfg1.settings.closeAction)
  const open1 = cfg1.sessionRecords.filter((r) => r.open)
  check('退出后快照里 8 条会话仍是 open（关掉的那条不算）', open1.length === 8, open1.map((r) => r.title))
  check('被结束的进程退出码没写进快照（仍为 null）', open1.filter((r) => r.lastExitCode === null).length === 7, open1.map((r) => r.lastExitCode))
  check('自己 exit 5 的那条保留退出码', open1.some((r) => r.lastExitCode === 5))
  const pids1 = readJson(p.pids)
  await sleep(500)
  check('退出后第 1 次的 agent 进程全部结束', pids1.every((pid) => !pidAlive(pid)), pids1.filter(pidAlive))
  // 第 2 次启动前删掉一个工作区目录：它的记录应被过滤掉
  rmSync(p.dir('gone'), { recursive: true, force: true })

  // ---------- 第 2 次 ----------
  const c2 = await runPhase(2, p)
  check('第 2 次：关闭方式已记住为退出，关窗口直接退出', c2 === 0, c2)
  const cfg2 = readJson(p.cfg)
  const open2 = cfg2.sessionRecords.filter((r) => r.open)
  // 5 个运行中 + 1 个自己退出 + 目录缺失被过滤的 1 条（工作区还在，目录回来后仍可恢复，所以不清）
  check('第 2 次退出后 open 记录 = 7', open2.length === 7, open2.map((r) => `${r.title}:${r.lastExitCode}`))
  check('设置 restoreOnStartup 已保存', cfg2.settings.restoreOnStartup === true)

  // ---------- 第 3 次 ----------
  const c3 = await runPhase(3, p)
  check('第 3 次正常退出', c3 === 0, c3)

  await sleep(500)
  const left = leftovers()
  check('三次启动的 agent 进程都已结束', left.length === 0, left)
  for (const pid of left) {
    try { execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }) } catch {}
  }
  console.log(`\n${pass}/${pass + fail} 通过`)
  try { rmSync(p.sandbox, { recursive: true, force: true }) } catch {}
  app.exit(fail ? 1 : 0)
}

// ======================================================================
// 阶段进程：一次真实启动
// ======================================================================

const HELPERS = `
window.__t = {
  q: (sel) => document.querySelector(sel),
  qa: (sel) => [...document.querySelectorAll(sel)],
  ctx(el) {
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }))
  },
  clickMenu(label) {
    const b = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((x) => x.textContent.trim() === label)
    if (!b) throw new Error('菜单项不存在：' + label)
    b.click()
  },
  menuItems: () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((b) => b.textContent.trim()),
  cells: () => [...document.querySelectorAll('section[data-cell]')].map((s) => {
    const h = s.querySelector('[data-session-id]')
    return h ? h.dataset.sessionId : null
  }),
  rows: () => [...document.querySelectorAll('[data-restore-row]')].map((r) => ({
    id: r.dataset.restoreRow,
    text: r.textContent,
    mode: r.querySelector('[data-restore-mode]').dataset.restoreMode,
    disabled: r.querySelector('[data-restore-mode]').disabled,
    checked: r.querySelector('input[type="checkbox"]').checked
  }))
}
true
`

async function phase(n) {
  const p = paths(arg('sandbox'))
  // 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
  app.setPath('appData', p.sandbox)
  const cfgAtStart = readJson(p.cfg)
  // 调试面（window.__warpDebug）只在 MILE_WARP_DEBUG=1 时挂，必须在 require 主进程包之前设
  process.env.MILE_WARP_DEBUG = '1'
  require(join(ROOT, 'out', 'main', 'index.js'))
  await app.whenReady()
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.webContents.on('console-message', (e) => {
    const lvl = e.level ?? ''
    if (lvl === 'error' || lvl === 3) console.log('  FAIL  [renderer]', e.message)
  })
  const J = JSON.stringify
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) {
      try {
        if (await js(code)) return true
      } catch {
        // 元素还没渲染出来按未满足处理
      }
      await sleep(100)
    }
    return false
  }
  const list = () => js('window.warp.session.list()')
  const card = (id) => `[data-rail="sessions"] [data-workspace-id="${id}"]`
  /** 假 agent 收到的参数：按会话的 pid 读 argv/<pid>.json */
  const argvOf = async (meta) => {
    const f = join(p.argvDir, `${meta.pid}.json`)
    for (let t = 0; t < 8000 && !existsSync(f); t += 100) await sleep(100)
    return existsSync(f) ? readJson(f).argv : null
  }
  const menuPick = async (sel, label) => {
    await js(`__t.ctx(__t.q(${J(sel)}))`)
    await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
    const items = await js('__t.menuItems()')
    if (items.includes(label)) await js(`__t.clickMenu(${J(label)})`)
    else await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    return items
  }

  await waitFor(`!!document.querySelector('[data-rail="sessions"] [data-workspace-id]')`)
  await js(HELPERS)
  const ctx = { p, win, js, waitFor, list, card, argvOf, menuPick, J, cfgAtStart }
  try {
    if (n === '1') await phase1(ctx)
    else if (n === '2') await phase2(ctx)
    else await phase3(ctx)
  } catch (e) {
    console.log('  FAIL  脚本异常', (e && e.stack) || e)
    app.exit(2)
  }
}

async function phase1({ p, win, js, waitFor, list, card, argvOf, menuPick, J }) {
  console.log('\n=== 1-1. 四宫格里开四种会话，后台再开几个 ===')
  await js(`__t.q('[data-grid-mode="quad"]').click()`)
  await waitFor(`__t.qa('section[data-cell]').length === 4`)
  await js(`__t.q(${J(card('wsClaude'))}).click()`)
  await waitFor(`__t.cells()[0] !== null`, 10000)
  await menuPick(card('wsCodex'), '在第 2 格打开')
  await waitFor(`__t.cells()[1] !== null`, 10000)
  await menuPick(card('wsKimi'), '在第 3 格打开')
  await waitFor(`__t.cells()[2] !== null`, 10000)
  await menuPick(card('wsShell'), '在第 4 格打开')
  await waitFor(`__t.cells()[3] !== null`, 10000)
  // 后台会话直接走 IPC 启动（不占格）
  for (const ws of ['wsCodex', 'wsKimi', 'wsCodex2', 'wsGone', 'wsShell']) await js(`window.warp.session.start(${J(ws)})`)
  const all = await list()
  check('共 9 个会话', all.length === 9, all.map((s) => s.title))
  const by = (ws, idx = 1) => all.find((s) => s.workspaceId === ws && s.index === idx)

  console.log('\n=== 1-2. 续接 ID ===')
  const claude = by('wsClaude')
  const claudeArgv = await argvOf(claude)
  check('Claude 启动时带 --session-id <uuid>，且就是快照里的 resumeId', claudeArgv && claudeArgv[0] === '--session-id' && claudeArgv[1] === claude.resumeId, claudeArgv)
  const got = await waitFor(
    `window.warp.session.list().then((l) => l.filter((s) => s.workspaceId === 'wsKimi' && s.resumeId).length === 2 && l.some((s) => s.workspaceId === 'wsCodex2' && s.resumeId))`,
    15000
  )
  const after = await list()
  const kimiIds = after.filter((s) => s.workspaceId === 'wsKimi').map((s) => s.resumeId)
  check('同目录两个 Kimi 逐个启动，各拿到自己的 ID', got && kimiIds[0] !== kimiIds[1] && kimiIds.every((x) => /^session_/.test(x)), kimiIds)
  check('单个 Codex 会话认领到 rollout 里的 ID', Boolean(after.find((s) => s.workspaceId === 'wsCodex2').resumeId))
  await sleep(4000)
  const codexIds = (await list()).filter((s) => s.workspaceId === 'wsCodex').map((s) => s.resumeId)
  check('同目录两个 Codex 有歧义：都不写 ID', codexIds.every((x) => x === null), codexIds)
  const cfg = readJson(p.cfg)
  const rec = (id) => cfg.sessionRecords.find((r) => r.id === id)
  check('ID 一拿到就写进快照（不等退出）', rec(by('wsCodex2').id).resumeId === after.find((s) => s.workspaceId === 'wsCodex2').resumeId)
  const cellsInRecords = ['wsClaude', 'wsCodex', 'wsKimi', 'wsShell'].map((ws) => rec(by(ws).id)?.cell)
  check('快照里记了格位（布局变化后同步）', J(cellsInRecords) === J([0, 1, 2, 3]), cellsInRecords)
  check('后台会话格位为 null', rec(by('wsKimi', 2).id)?.cell === null)

  console.log('\n=== 1-3. 关闭会话与自己退出 ===')
  const extraShell = by('wsShell', 2)
  await js(`window.warp.session.close(${J(extraShell.id)})`)
  await sleep(300)
  check('手动关闭的会话在快照里标为已关闭', readJson(p.cfg).sessionRecords.find((r) => r.id === extraShell.id).open === false)
  const shell = by('wsShell')
  await waitFor(`window.__warpDebug.text(${J(shell.id)}).includes('shell')`, 15000)
  await js(`window.warp.session.write(${J(shell.id)}, 'exit 5\\r')`)
  await waitFor(`window.warp.session.list().then((l) => l.some((s) => s.id === ${J(shell.id)} && s.exitCode === 5))`, 10000)
  await sleep(300)
  check('自己退出的会话快照里记退出码 5', readJson(p.cfg).sessionRecords.find((r) => r.id === shell.id).lastExitCode === 5)

  console.log('\n=== 1-4. 关闭确认框 ===')
  win.close()
  check('有运行中会话时关窗口弹确认框', await waitFor(`!!__t.q('[data-testid="quit-dialog"]')`, 3000))
  check('确认框列出 7 个运行中的会话', await js(`__t.qa('[data-testid="quit-dialog"] li').length === 7`))
  await js(`__t.q('[data-testid="quit-cancel"]').click()`)
  await sleep(300)
  check('取消后窗口还在、会话还在', win.isVisible() && (await list()).filter((s) => s.status === 'running').length === 7)
  win.close()
  await waitFor(`!!__t.q('[data-testid="quit-dialog"]')`, 3000)
  await js(`__t.q('[data-testid="quit-tray"]').click()`)
  await sleep(600)
  check('最小化到托盘：窗口隐藏，会话继续运行', !win.isVisible() && (await list()).filter((s) => s.status === 'running').length === 7)
  win.show()
  await sleep(300)

  writeFileSync(p.pids, JSON.stringify((await list()).filter((s) => s.status === 'running').map((s) => s.pid)))
  win.close()
  await waitFor(`!!__t.q('[data-testid="quit-dialog"]')`, 3000)
  console.log('  （第 1 次：勾「下次不再询问」后全部结束并退出）')
  await js(`__t.q('[data-testid="quit-remember"]').click(); __t.q('[data-testid="quit-all"]').click()`)
  // 进程由应用自己退出；编排进程检查退出码与快照
}

async function phase2({ p, win, js, waitFor, list, card, argvOf, menuPick, J }) {
  console.log('\n=== 2-1. 恢复卡片 ===')
  check('启动后空格里出现恢复卡片', await waitFor(`!!__t.q('[data-testid="restore-card"]')`, 8000))
  const cands = await js('window.warp.session.restoreCandidates()')
  const byTitle = (t) => cands.find((c) => c.title === t)
  check('候选 7 条：手动关闭的、目录被删的都不在', cands.length === 7 && !cands.some((c) => c.workspaceId === 'wsGone'), cands.map((c) => c.title))
  check('卡片标题写明数量', await js(`__t.q('[data-testid="restore-card"]').textContent.includes('恢复上次的 7 个会话')`))
  const rows = await js('__t.rows()')
  const row = (t) => rows.find((r) => r.id === byTitle(t).id)
  check('Claude（有 ID）默认续接', row('claude').mode === 'resume')
  check('同目录两个 Codex（没 ID）标新开且不可改', ['codex', 'codex #2'].every((t) => row(t).mode === 'fresh' && row(t).disabled))
  check('单个 Codex（认领到 ID）默认续接', row('codex2').mode === 'resume')
  check('两个 Kimi 各自续接', row('kimi').mode === 'resume' && row('kimi #2').mode === 'resume')
  check('Shell 不续接', row('shell').mode === 'fresh' && row('shell').disabled)
  check('卡片按上次的格排序', J(cands.slice(0, 4).map((c) => c.cell)) === J([0, 1, 2, 3]), cands.map((c) => c.cell))

  await js(`__t.q('[data-restore-row="${byTitle('kimi #2').id}"] [data-restore-mode]').click()`)
  await js(`__t.q('[data-restore-row="${byTitle('shell').id}"] input[type="checkbox"]').click()`)
  const rows2 = await js('__t.rows()')
  check('逐条改成新开', rows2.find((r) => r.id === byTitle('kimi #2').id).mode === 'fresh')
  check('取消勾选', rows2.find((r) => r.id === byTitle('shell').id).checked === false)
  check('主按钮变成「恢复所选 6 个」', await js(`__t.q('[data-testid="restore-all"]').textContent.includes('恢复所选 6 个')`))
  await js(`__t.q('[data-testid="restore-all"]').click()`)
  check('恢复出 6 个会话', await waitFor(`window.warp.session.list().then((l) => l.length === 6 && l.every((s) => s.status === 'running'))`, 30000))
  check('格子占满后卡片收进标题栏入口', await waitFor(`!__t.q('[data-testid="restore-card"]') && !!__t.q('[data-testid="restore-pill"]')`, 5000))

  const sess = await list()
  const s = (t) => sess.find((x) => x.title === t)
  const argv = {}
  for (const t of ['claude', 'codex', 'codex #2', 'codex2', 'kimi', 'kimi #2']) argv[t] = await argvOf(s(t))
  check('Claude 以 --resume <上次的 uuid> 启动', J(argv.claude.slice(0, 2)) === J(['--resume', byTitle('claude').resumeId]), argv.claude)
  check('Claude 续接时不再另指定 --session-id', !argv.claude.includes('--session-id'))
  check('Codex 以 resume <id> 子命令启动', J(argv.codex2.slice(0, 2)) === J(['resume', byTitle('codex2').resumeId]), argv.codex2)
  check('Kimi 以 --session <id> 启动', J(argv.kimi.slice(0, 2)) === J(['--session', byTitle('kimi').resumeId]), argv.kimi)
  check('改成新开的 Kimi 不带续接参数', !argv['kimi #2'].includes('--session') && !argv['kimi #2'].includes('--continue'), argv['kimi #2'])
  check('没 ID 的两个 Codex 新开（不用 resume --last 挤到同一段对话）', argv.codex[0] !== 'resume' && argv['codex #2'][0] !== 'resume', [argv.codex, argv['codex #2']])
  check('会话的 resumeMode 记录正确', s('claude').resumeMode === 'exact' && s('kimi #2').resumeMode === 'fresh' && s('codex').resumeMode === 'fresh')
  const cells = await js('__t.cells()')
  check('放回上次的格；没格的放进第一个空格', J(cells) === J([s('claude').id, s('codex').id, s('kimi').id, s('codex #2').id]), cells)
  const cfg = readJson(p.cfg)
  const claudeRec = cfg.sessionRecords.find((r) => r.id === s('claude').id)
  check('新记录接替旧记录，续接 ID 沿用', claudeRec && claudeRec.resumeId === byTitle('claude').resumeId && !cfg.sessionRecords.some((r) => r.id === byTitle('claude').id))

  await js(`__t.q('[data-testid="restore-pill"]').click()`)
  check('点入口以对话框打开，剩下取消勾选的那 1 条', await waitFor(`!!__t.q('[data-testid="restore-dialog"]') && __t.qa('[data-restore-row]').length === 1`, 3000))
  await js(`__t.q('[data-testid="restore-dismiss"]').click()`)
  check('「忽略」后对话框与入口都消失', await waitFor(`!__t.q('[data-testid="restore-card"]') && !__t.q('[data-testid="restore-pill"]')`, 3000))
  await sleep(300)
  check('被忽略的记录不再是候选', readJson(p.cfg).sessionRecords.find((r) => r.id === byTitle('shell').id).open === false)

  console.log('\n=== 2-2. 续接上次对话启动（S-10） ===')
  const kimiItems = await menuPick(card('wsKimi'), '__none__')
  check('对话正开着的工作区不出现「续接上次对话启动」', !kimiItems.includes('续接上次对话启动'), kimiItems)
  await js(`window.warp.session.close(${J(s('claude').id)})`)
  await sleep(800)
  const items = await menuPick(card('wsClaude'), '续接上次对话启动')
  check('关掉后菜单出现「续接上次对话启动」', items.includes('续接上次对话启动'), items)
  check('续接启动出新会话', await waitFor(`window.warp.session.list().then((l) => l.some((x) => x.workspaceId === 'wsClaude' && x.status === 'running'))`, 10000))
  const resumed = (await list()).find((x) => x.workspaceId === 'wsClaude')
  const ra = await argvOf(resumed)
  check('续接启动带 --resume <uuid>', J(ra.slice(0, 2)) === J(['--resume', byTitle('claude').resumeId]), ra)

  console.log('\n=== 2-3. 准备第 3 次 ===')
  await js(`window.warp.session.write(${J(s('codex2').id)}, 'q\\r')`)
  check('codex2 自己以退出码 3 退出', await waitFor(`window.warp.session.list().then((l) => l.some((x) => x.id === ${J(s('codex2').id)} && x.exitCode === 3))`, 8000))
  await js(`window.warp.settings.update({ restoreOnStartup: true })`)
  const bad = await js(`window.warp.settings.update({ fontSize: 99 }).then(() => 'resolved', () => 'rejected')`)
  check('settings:update 拒绝越界值', bad === 'rejected')
  console.log('  （第 2 次：关闭方式已记住为退出，直接关窗口）')
  await sleep(500)
  win.close()
}

async function phase3({ js, waitFor, list, argvOf, J, cfgAtStart, win }) {
  console.log('\n=== 3-1. 启动时自动恢复 ===')
  const expected = cfgAtStart.sessionRecords.filter((r) => r.open && r.lastExitCode === null && r.workspaceId !== 'wsGone')
  check('自动恢复只拉起上次没正常退出的（5 个）', await waitFor(`window.warp.session.list().then((l) => l.length === ${expected.length} && l.every((s) => s.status === 'running'))`, 30000), expected.map((r) => r.title))
  const titles = (await list()).map((s) => s.title).sort()
  check('恢复的正是这几条', J(titles) === J(expected.map((r) => r.title).sort()), titles)
  const claudeRec = expected.find((r) => r.workspaceId === 'wsClaude')
  const claude = (await list()).find((s) => s.workspaceId === 'wsClaude')
  const a = await argvOf(claude)
  check('自动恢复同样续接对话', J(a.slice(0, 2)) === J(['--resume', claudeRec.resumeId]), a)
  // 5 个会话占满四格：卡片在标题栏入口里
  await waitFor(`!!__t.q('[data-testid="restore-pill"]') || !!__t.q('[data-testid="restore-card"]')`, 5000)
  if (await js(`!!__t.q('[data-testid="restore-pill"]')`)) await js(`__t.q('[data-testid="restore-pill"]').click()`)
  check('自己退出的那条留在恢复卡片上', await waitFor(`__t.qa('[data-restore-row]').length === 1 && __t.q('[data-testid="restore-card"]').textContent.includes('codex2')`, 5000))
  await sleep(500)
  win.close()
}

if (!PHASE) {
  orchestrate().catch((e) => {
    console.log('\n  FAIL  编排异常', (e && e.stack) || e)
    app.exit(2)
  })
  // 编排进程不开窗口；总超时兜底
  setTimeout(() => { console.log('\n  FAIL  总超时 480 秒'); app.exit(3) }, 480000).unref()
} else {
  setTimeout(() => { console.log('\n  FAIL  阶段总超时'); app.exit(3) }, 140000).unref()
  void phase(PHASE)
}
