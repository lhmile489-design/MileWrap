/**
 * 性能基准与守门。打印数字，并对几项做上限断言（数值见 BUDGET）：
 *   - 包体：首屏 JS（index-*.js）与全部 JS 的体积
 *   - 启动：重载 5 次，取 DOMContentLoaded（主包解析 + 执行）与「会话栏出现」的中位数
 *   - 计时器：4 个运行中会话（格里 4 个 + 会话栏 4 行）一共建了几个 setInterval
 *   - 空闲 CPU：4 个 Shell 会话放着不动，渲染进程 5 秒平均 CPU
 *   - 目录栏：2000 个文件的目录，展开耗时、DOM 行数、点选一个文件的耗时；「显示其余」能展开全部
 *   - WebGL：挂载中的终端仍用 WebGL 渲染（插件改成按需加载后不能退化成 DOM 渲染）
 *
 *   npm run build
 *   npx electron scripts/verify-perf.cjs 2>&1 | Out-File $env:TEMP\warp-perf.log -Encoding utf8
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'warp-perf-'))
app.setPath('appData', SANDBOX)

const BUDGET = {
  initialJsKB: 950,
  domContentLoadedMs: 400,
  intervalsFor4Sessions: 1,
  fileRows: 400,
  listDirMs: 250,
  expandMs: 300,
  selectMs: 30
}

const now = Date.now()
const workspaces = [0, 1, 2, 3].map((i) => {
  const cwd = join(SANDBOX, `ws${i}`)
  mkdirSync(cwd, { recursive: true })
  return { id: `w${i}`, groupId: null, name: `工作区 ${i}`, note: '', agentId: 'shell', agentPath: null, cwd, args: [], envKeys: [], envEnc: null, icon: null, order: i, createdAt: now, updatedAt: now + i }
})
const big = join(workspaces[0].cwd, 'big')
mkdirSync(big)
for (let i = 0; i < 2000; i++) writeFileSync(join(big, `file-${String(i).padStart(4, '0')}.txt`), '')
mkdirSync(join(SANDBOX, 'mile-warp'), { recursive: true })
writeFileSync(
  join(SANDBOX, 'mile-warp', 'config.json'),
  JSON.stringify({ version: 1, groups: [], workspaces, customAgents: [], settings: { closeAction: 'quit', restoreOnStartup: false }, sessionRecords: [] }),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const metric = (name, value, unit) => console.log(`  ····  ${name}: ${value}${unit}`)
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

setTimeout(() => { console.log('\n  FAIL  总超时 150 秒'); app.exit(3) }, 150000).unref()

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const J = JSON.stringify
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 8000, step = 100) => {
    for (let t = 0; t < ms; t += step) {
      try {
        if (await js(code)) return true
      } catch {
        // 页面还没就绪
      }
      await sleep(step)
    }
    return false
  }
  const RAIL = `!!document.querySelector('[data-rail="sessions"] [data-workspace-id]')`
  win.setSize(1600, 1000)
  await waitFor(RAIL)

  console.log('\n=== 包体 ===')
  const assets = join(ROOT, 'out', 'renderer', 'assets')
  const jsFiles = readdirSync(assets).filter((f) => f.endsWith('.js'))
  const kb = (f) => Math.round(statSync(join(assets, f)).size / 1024)
  const initial = jsFiles.filter((f) => /^index-/.test(f)).reduce((s, f) => s + kb(f), 0)
  const total = jsFiles.reduce((s, f) => s + kb(f), 0)
  metric('首屏 JS', initial, ' KB')
  metric('全部 JS', total, ` KB（${jsFiles.length} 个文件）`)
  check(`首屏 JS ≤ ${BUDGET.initialJsKB} KB`, initial <= BUDGET.initialJsKB, `${initial} KB`)

  console.log('\n=== 启动（重载 5 次取中位数） ===')
  const dcl = []
  const rail = []
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now()
    win.webContents.reload()
    await new Promise((r) => win.webContents.once('did-finish-load', r))
    await waitFor(RAIL, 8000, 5)
    rail.push(Date.now() - t0)
    dcl.push(Math.round(await js(`performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd`)))
  }
  metric('DOMContentLoaded', `${median(dcl)} ms`, `（${dcl.join(' / ')}）`)
  metric('重载 → 会话栏出现', `${median(rail)} ms`, `（${rail.join(' / ')}）`)
  check(`DOMContentLoaded ≤ ${BUDGET.domContentLoadedMs} ms`, median(dcl) <= BUDGET.domContentLoadedMs, `${median(dcl)} ms`)

  console.log('\n=== 4 个运行中会话：计时器与空闲 CPU ===')
  // 先装计数器，再起会话：之后组件挂载时建的 interval 都会被数到
  await js(`(() => {
    const real = window.setInterval.bind(window)
    const clear = window.clearInterval.bind(window)
    window.__live = new Set()
    window.setInterval = (fn, ms, ...a) => { const id = real(fn, ms, ...a); if (ms === 1000) window.__live.add(id); return id }
    window.clearInterval = (id) => { window.__live.delete(id); return clear(id) }
    return true
  })()`)
  await js(`document.querySelector('[data-grid-mode="quad"]').click()`)
  await waitFor(`document.querySelectorAll('section[data-cell]').length === 4`)
  for (let i = 0; i < 4; i++) {
    await js(`(() => { const el = document.querySelector('[data-rail="sessions"] [data-workspace-id="w${i}"]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })); return true })()`)
    await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
    await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === '在第 ${i + 1} 格打开').click()`)
    await waitFor(`!!document.querySelector('section[data-cell="${i}"] [data-session-id]')`, 15000)
  }
  await sleep(1500)
  const intervals = await js('window.__live.size')
  metric('1 秒计时器个数', intervals, '')
  check(`4 个会话的运行时长共用 ≤ ${BUDGET.intervalsFor4Sessions} 个计时器`, intervals <= BUDGET.intervalsFor4Sessions, intervals)
  const uptimeOf = `[...document.querySelectorAll('[data-rail="sessions"] [data-session-row], section[data-cell] [data-cell-head]')].map((e) => e.textContent).join('|')`
  const u1 = await js(uptimeOf)
  await sleep(2200)
  const u2 = await js(uptimeOf)
  check('运行时长仍在走', u1 !== u2 && u2.length > 0, { u1: u1.slice(0, 80), u2: u2.slice(0, 80) })
  check('挂载中的终端用 WebGL 渲染', await waitFor(`document.querySelectorAll('section[data-cell] .xterm-screen canvas').length >= 4`, 5000), await js(`document.querySelectorAll('section[data-cell] .xterm-screen canvas').length`))

  const pid = win.webContents.getOSProcessId()
  const cpuOf = () => app.getAppMetrics().find((m) => m.pid === pid)?.cpu.percentCPUUsage ?? -1
  cpuOf()
  await sleep(5000)
  const idle = Math.round(cpuOf() * 10) / 10
  metric('渲染进程空闲 CPU（5 秒平均）', idle, ' %')

  console.log('\n=== 目录栏：2000 个文件 ===')
  await js(`document.querySelector('[data-grid-mode="single"]').click()`)
  await js(`document.querySelector('[data-rail="sessions"] [data-workspace-id="w0"]').click()`)
  await sleep(300)
  if (!(await js(`!!document.querySelector('[data-rail="files"]')`))) {
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', key: 'E', ctrlKey: true, shiftKey: true, bubbles: true }))`)
  }
  await waitFor(`!!document.querySelector('[data-rail="files"] [role="treeitem"][data-rel="big"]')`, 5000)
  const list = await js(`(async () => { const t = performance.now(); const r = await window.warp.fs.listDir('w0', 'big'); return [Math.round(performance.now() - t), r.length] })()`)
  metric('fs:listDir 2000 项（主进程读目录 + IPC）', list[0], ` ms（${list[1]} 项）`)
  check(`fs:listDir 2000 项 ≤ ${BUDGET.listDirMs} ms`, list[0] <= BUDGET.listDirMs, `${list[0]} ms`)
  const open = await js(`(async () => {
    const t = performance.now()
    document.querySelector('[data-rail="files"] [role="treeitem"][data-rel="big"]').click()
    for (let i = 0; i < 300 && !document.querySelector('[data-rail="files"] [data-rel="big/file-0000.txt"]'); i++) await new Promise((r) => setTimeout(r, 10))
    return Math.round(performance.now() - t)
  })()`)
  const rows = await js(`document.querySelectorAll('[data-rail="files"] [role="treeitem"]').length`)
  metric('展开 2000 项目录（点击 → 第一项出现）', open, ' ms')
  check(`展开 2000 项目录 ≤ ${BUDGET.expandMs} ms`, open <= BUDGET.expandMs, `${open} ms`)
  metric('目录栏 DOM 行数', rows, '')
  check(`大目录只先渲染一部分（行数 ≤ ${BUDGET.fileRows}）`, rows <= BUDGET.fileRows, rows)
  // 从点击到 aria-selected 落到 DOM（MutationObserver 在 DOM 改完后的微任务里回调）
  const sel = await js(`new Promise((resolve) => {
    const el = document.querySelector('[data-rail="files"] [data-rel="big/file-0005.txt"]')
    const t = performance.now()
    const mo = new MutationObserver(() => {
      if (el.getAttribute('aria-selected') !== 'true') return
      mo.disconnect()
      resolve(Math.round((performance.now() - t) * 10) / 10)
    })
    mo.observe(el, { attributes: true, attributeFilter: ['aria-selected'] })
    el.click()
  })`)
  metric('点选一个文件', sel, ' ms')
  check(`点选文件 ≤ ${BUDGET.selectMs} ms`, sel <= BUDGET.selectMs, `${sel} ms`)
  const MORE = `document.querySelector('[data-rail="files"] [data-show-more]')`
  const firstLabel = await js(`${MORE}?.textContent ?? null`)
  check('有「再显示 / 显示其余」按钮', !!firstLabel, firstLabel)
  let clicks = 0
  let lastLabel = firstLabel
  while (clicks < 20 && (await js(`!!${MORE}`))) {
    lastLabel = await js(`${MORE}.textContent`)
    await js(`${MORE}.click()`)
    clicks++
    await sleep(50)
  }
  const all = await js(`document.querySelectorAll('[data-rail="files"] [role="treeitem"]').length`)
  metric('点到全部显示', clicks, ' 次')
  check('按批追加后 2000 项全部可见、按钮消失', all === 2002 && !(await js(`!!${MORE}`)), { all, lastLabel })
  check('最后一项可见', await js(`!!document.querySelector('[data-rail="files"] [data-rel="big/file-1999.txt"]')`))
  const sel2 = await js(`new Promise((resolve) => {
    const el = document.querySelector('[data-rail="files"] [data-rel="big/file-1990.txt"]')
    const t = performance.now()
    const mo = new MutationObserver(() => {
      if (el.getAttribute('aria-selected') !== 'true') return
      mo.disconnect()
      resolve(Math.round((performance.now() - t) * 10) / 10)
    })
    mo.observe(el, { attributes: true, attributeFilter: ['aria-selected'] })
    el.click()
  })`)
  metric('2000 项全部显示时点选一个文件', sel2, ' ms')
  check(`2000 项全部显示时点选 ≤ ${BUDGET.selectMs} ms`, sel2 <= BUDGET.selectMs, `${sel2} ms`)

  console.log(`\n${pass}/${pass + fail} 通过`)
  for (const s of await js('window.warp.session.list()')) await js(`window.warp.session.close(${J(s.id)})`)
  win.destroy()
  setTimeout(() => {
    try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
    app.exit(fail ? 1 : 0)
  }, 300)
}).catch((e) => {
  console.log('\n  FAIL  脚本异常', (e && e.stack) || e)
  app.exit(2)
})
