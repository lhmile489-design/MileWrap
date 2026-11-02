/**
 * M3 验收：宫格与后台会话（技术设计 §10 verify-m3-grid）。
 *
 * 沙箱里 4 个 Shell 工作区（目录名含中文），全部经渲染层真实交互驱动：
 *   1. 默认单格 → 切四宫格，4 个空格
 *   2. 四种方式把会话放进 4 格：单击卡片、右键「在第 N 格打开」、拖卡片到格、空格里的快捷按钮
 *   3. 每格独立输出；拖分隔条（真实鼠标事件）后左右列 cols 不同，PTY 收到的宽度与 xterm 一致
 *   4. 格头拖到另一格 = 两格互换，画面不丢
 *   5. 切 2 格 / 1 格：隐藏位置的会话转后台继续运行、继续收输出；切回 4 格原样接上
 *   6. 最大化 / 还原；快捷键 Ctrl+Shift+2、Ctrl+Tab、Ctrl+Shift+D
 *   7. 会话子行拖到格；原占用者转后台
 *   8. 窗口缩到 1024 宽：目录栏临时收起，每格 ≥ 360px，偏好不变；手动展开优先；变宽后恢复
 *   9. 栏宽拖动；window-state.json 落盘（宫格、格位、比例、栏宽、窗口尺寸）
 *  10. 渲染层重载：布局从磁盘读回，格位仍指向主进程里活着的会话，终端内容由主进程缓冲回放
 *  11. 关闭会话后对应格变空
 *
 *   npm run build
 *   npx electron scripts/verify-m3-grid.cjs 2>&1 | Out-File $env:TEMP\warp-m3.log -Encoding utf8
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'warp-m3-'))
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const CFG_DIR = join(SANDBOX, 'mile-warp')
const STATE = join(CFG_DIR, 'window-state.json')
mkdirSync(CFG_DIR, { recursive: true })
const now = Date.now()
const workspaces = [1, 2, 3, 4].map((n) => {
  const cwd = join(SANDBOX, `格${n} 目录`)
  mkdirSync(cwd, { recursive: true })
  return {
    id: `ws${n}`, groupId: null, name: `工作区${n}`, note: '', agentId: 'shell', agentPath: null, cwd,
    args: [], envKeys: [], envEnc: null, order: n - 1, createdAt: now, updatedAt: now + n
  }
})
writeFileSync(
  join(CFG_DIR, 'config.json'),
  JSON.stringify({ version: 1, groups: [], workspaces, customAgents: [], settings: {}, sessionRecords: [] }, null, 2),
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
const state = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null)

setTimeout(() => { console.log('\n  FAIL  总超时 240 秒'); app.exit(3) }, 240000).unref()

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
  center(sel) {
    const r = document.querySelector(sel).getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
  },
  dragStart(sel) {
    window.__dt = new DataTransfer()
    document.querySelector(sel).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
  },
  dragOver(sel) {
    const el = document.querySelector(sel)
    el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
  },
  drop(sel, srcSel) {
    document.querySelector(sel).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
    const src = document.querySelector(srcSel)
    if (src) src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
  },
  /** 每格当前显示的会话 id（空格为 null） */
  cells: () => [...document.querySelectorAll('section[data-cell]')].map((s) => {
    const h = s.querySelector('[data-session-id]')
    return { cell: Number(s.dataset.cell), id: h ? h.dataset.sessionId : null, focused: s.dataset.focused === 'true', width: Math.round(s.getBoundingClientRect().width) }
  })
}
true
`

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const rendererErrors = []
  win.webContents.on('console-message', (e) => {
    const lvl = e.level ?? ''
    if (lvl === 'error' || lvl === 3) {
      rendererErrors.push(e.message)
      console.log('  [renderer]', e.message)
    }
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
  const card = (id) => `[data-rail="sessions"] [data-workspace-id="${id}"]`
  const cell = (i) => `section[data-cell="${i}"]`
  const list = () => js('window.warp.session.list()')
  const sidOf = async (ws) => (await list()).filter((s) => s.workspaceId === ws).sort((a, b) => a.index - b.index).map((s) => s.id)
  const cellIds = async () => (await js('__t.cells()')).map((c) => c.id)
  const text = (id) => js(`window.__warpDebug.text(${J(id)})`)
  const mouseDrag = async (sel, dx, dy) => {
    const c = await js(`__t.center(${J(sel)})`)
    // 按住拖动时 mouseMove 必须带 leftButtonDown，否则 Chromium 当作松开按键，指针捕获随即丢失
    const send = (type, x, y) =>
      win.webContents.sendInputEvent({ type, x, y, button: 'left', clickCount: 1, modifiers: type === 'mouseMove' ? ['leftButtonDown'] : [] })
    send('mouseMove', c.x, c.y)
    await sleep(50)
    send('mouseDown', c.x, c.y)
    for (let i = 1; i <= 6; i++) {
      send('mouseMove', c.x + Math.round((dx * i) / 6), c.y + Math.round((dy * i) / 6))
      await sleep(30)
    }
    send('mouseUp', c.x + dx, c.y + dy)
    await sleep(400)
  }
  const keys = async (keyCode, modifiers) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(300)
  }
  const drag = async (src, dst) => {
    await js(`__t.dragStart(${J(src)})`)
    await sleep(50)
    await js(`__t.dragOver(${J(dst)})`)
    await sleep(100)
    await js(`__t.drop(${J(dst)}, ${J(src)})`)
    await sleep(400)
  }
  const promptIn = (id, n) => waitFor(`window.__warpDebug.text(${J(id)}).includes('格${n} 目录')`, 15000)

  await waitFor(`!!document.querySelector('[data-rail="sessions"] [data-workspace-id]')`)
  await js(HELPERS)

  console.log('\n=== 1. 布局切换 ===')
  check('默认单格', await js(`__t.q('main[data-grid]').dataset.grid === 'single' && __t.qa('section[data-cell]').length === 1`))
  await js(`__t.q('[data-grid-mode="quad"]').click()`)
  check('切四宫格后 4 个空格', await waitFor(`__t.qa('section[data-cell]').length === 4 && __t.qa('[data-empty-cell]').length === 4`))
  check('标题栏分段控件选中四宫格', await js(`__t.q('[data-grid-mode="quad"]').getAttribute('aria-checked') === 'true'`))

  console.log('\n=== 2. 四种方式放进 4 格 ===')
  await js(`__t.q(${J(card('ws1'))}).click()`)
  check('单击卡片 → 聚焦格（第 1 格）启动', await waitFor(`__t.cells()[0].id !== null`, 15000))
  await js(`__t.ctx(__t.q(${J(card('ws2'))}))`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  const menu = await js('__t.menuItems()')
  check('多格时菜单出现「在第 N 格打开」', ['在第 1 格打开', '在第 2 格打开', '在第 3 格打开', '在第 4 格打开'].every((x) => menu.includes(x)), menu)
  await js(`__t.clickMenu('在第 2 格打开')`)
  check('右键「在第 2 格打开」', await waitFor(`__t.cells()[1].id !== null`, 15000))
  await drag(card('ws3'), cell(2))
  check('拖卡片到第 3 格', await waitFor(`__t.cells()[2].id !== null`, 15000))
  await js(`[...__t.qa('[data-empty-cell="3"] button')].find((b) => b.textContent.includes('工作区4')).click()`)
  check('空格快捷按钮在第 4 格启动', await waitFor(`__t.cells()[3].id !== null`, 15000))
  const [s1] = await sidOf('ws1')
  const [s2] = await sidOf('ws2')
  const [s3] = await sidOf('ws3')
  const [s4] = await sidOf('ws4')
  check('4 格各是对应工作区的会话', J(await cellIds()) === J([s1, s2, s3, s4]), await cellIds())
  check('卡片格号小标', await js(`__t.q(${J(card('ws2') + ' [data-cell-badge]')}).dataset.cellBadge === '2'`))

  console.log('\n=== 3. 每格输出与尺寸 ===')
  const ids = [s1, s2, s3, s4]
  for (let n = 1; n <= 4; n++) {
    await promptIn(ids[n - 1], n)
    await js(`window.warp.session.write(${J(ids[n - 1])}, 'Write-Output CELL${n}-OK\\r')`)
  }
  for (let n = 1; n <= 4; n++) {
    check(`第 ${n} 格独立输出`, await waitFor(`window.__warpDebug.text(${J(ids[n - 1])}).includes('CELL${n}-OK')`, 8000))
  }
  const before = await js('__t.cells()')
  await mouseDrag('[data-testid="split-h"]', 300, 0)
  await sleep(500)
  const after = await js('__t.cells()')
  check('拖分隔条后左列变宽', after[0].width > before[0].width + 50, { before: before.map((c) => c.width), after: after.map((c) => c.width) })
  check('右列不低于最小格宽 360（被夹住）', after[1].width >= 358, after[1].width)
  check('下排跟随同一个左右比例', Math.abs(after[2].width - after[0].width) <= 1 && Math.abs(after[3].width - after[1].width) <= 1)
  const sizes = await js(`[${J(s1)}, ${J(s2)}].map((id) => window.__warpDebug.size(id))`)
  const metas = (await list()).filter((s) => s.id === s1 || s.id === s2)
  const metaCols = (id) => metas.find((m) => m.id === id).cols
  check('左右两格 cols 不同', sizes[0].cols > sizes[1].cols, sizes)
  check('主进程记录的尺寸与 xterm 一致', metaCols(s1) === sizes[0].cols && metaCols(s2) === sizes[1].cols, { s1: metaCols(s1), s2: metaCols(s2) })
  for (const [id, sz] of [[s1, sizes[0]], [s2, sizes[1]]]) {
    await js(`window.warp.session.write(${J(id)}, 'Write-Output ("COLS=" + $Host.UI.RawUI.WindowSize.Width)\\r')`)
    await waitFor(`/COLS=\\d+/.test(window.__warpDebug.text(${J(id)}))`, 8000)
    const m = /COLS=(\d+)/.exec(await text(id))
    check(`PTY 收到的宽度 = xterm cols（${id === s1 ? '左' : '右'}）`, m && Number(m[1]) === sz.cols, { pty: m && m[1], xterm: sz.cols })
  }

  console.log('\n=== 4. 格头拖拽换格 ===')
  await drag('[data-cell-head="0"]', cell(1))
  check('两格互换', J(await cellIds()) === J([s2, s1, s3, s4]), await cellIds())
  check('聚焦跟到落点格', (await js('__t.cells()'))[1].focused)
  check('换格后 xterm 跟着挪、内容还在', await js(`!!__t.q('section[data-cell="1"] [data-session-id="${s1}"] .xterm')`) && (await text(s1)).includes('CELL1-OK'))

  console.log('\n=== 5. 后台会话保活 ===')
  await js(`__t.q('[data-grid-mode="dual"]').click()`)
  check('切 2 格只剩两格', await waitFor(`__t.qa('section[data-cell]').length === 2`))
  check('隐藏位置的会话仍在运行', (await list()).filter((s) => s.status === 'running').length === 4)
  await js(`window.warp.session.write(${J(s4)}, 'Write-Output BG-OUTPUT\\r')`)
  await sleep(1200)
  await js(`__t.q('[data-grid-mode="quad"]').click()`)
  check('切回 4 格原样接上', await waitFor(`${J(J([s2, s1, s3, s4]))} === JSON.stringify(__t.cells().map((c) => c.id))`, 3000), await cellIds())
  check('后台期间的输出已写进终端', (await text(s4)).includes('BG-OUTPUT') && (await text(s4)).includes('CELL4-OK'))
  await js(`__t.q('[data-grid-mode="single"]').click()`)
  check('切单格只显示第 1 格', await waitFor(`__t.qa('section[data-cell]').length === 1 && __t.cells()[0].id === ${J(s2)}`))
  await js(`__t.q('[data-grid-mode="quad"]').click()`)
  await waitFor(`__t.qa('section[data-cell]').length === 4`)

  console.log('\n=== 6. 最大化与快捷键 ===')
  await js(`__t.q('section[data-cell="1"] button[aria-label="最大化"]').click()`)
  check('最大化只显示该格', await waitFor(`__t.qa('section[data-cell]').length === 1 && __t.q('section[data-cell="1"]') !== null`))
  await js(`__t.q('section[data-cell="1"] button[aria-label="还原"]').click()`)
  check('还原回四格', await waitFor(`__t.qa('section[data-cell]').length === 4`))
  win.focus()
  await js(`__t.q('section[data-cell="0"] .xterm-helper-textarea').focus()`)
  await keys('2', ['control', 'shift'])
  check('Ctrl+Shift+2 聚焦第 2 格', (await js('__t.cells()'))[1].focused)
  check('键盘焦点进了第 2 格的终端', await js(`document.activeElement.closest('section[data-cell]').dataset.cell === '1'`))
  await keys('Tab', ['control'])
  check('Ctrl+Tab 到下一格', (await js('__t.cells()'))[2].focused)
  await keys('Tab', ['control', 'shift'])
  check('Ctrl+Shift+Tab 回上一格', (await js('__t.cells()'))[1].focused)
  await keys('D', ['control', 'shift'])
  check('Ctrl+Shift+D 循环：4 → 1', await waitFor(`__t.q('main[data-grid]').dataset.grid === 'single'`, 2000))
  await keys('D', ['control', 'shift'])
  await keys('D', ['control', 'shift'])
  check('再按两次回到 4 格', await waitFor(`__t.q('main[data-grid]').dataset.grid === 'quad'`, 2000))

  console.log('\n=== 7. 新会话、后台会话回格、子行拖到格 ===')
  await keys('4', ['control', 'shift'])
  check('Ctrl+Shift+4 聚焦第 4 格', (await js('__t.cells()'))[3].focused)
  await js(`__t.ctx(__t.q(${J(card('ws1'))}))`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  await js(`__t.clickMenu('新建会话')`)
  check('新建会话进聚焦格', await waitFor(`window.warp.session.list().then((l) => l.filter((s) => s.workspaceId === 'ws1').length === 2)`, 15000))
  const s1b = (await sidOf('ws1'))[1]
  check('原占用者转后台', await waitFor(`__t.cells()[3].id === ${J(s1b)}`, 3000) && (await list()).find((s) => s.id === s4).status === 'running')
  await js(`__t.q(${J(card('ws4'))}).click()`)
  check('单击卡片把后台会话切回聚焦格', await waitFor(`__t.cells()[3].id === ${J(s4)}`, 3000), await cellIds())
  await waitFor(`!!__t.q('[data-session-row="${s1b}"]')`, 2000)
  await drag(`[data-session-row="${s1b}"]`, cell(0))
  check('会话子行拖到第 1 格', await waitFor(`__t.cells()[0].id === ${J(s1b)}`, 3000), await cellIds())
  await drag(card('ws2'), cell(0))
  check('拖卡片到格：优先接回该工作区的后台会话', await waitFor(`__t.cells()[0].id === ${J(s2)}`, 3000) && (await sidOf('ws2')).length === 1, await cellIds())
  check('格位回到 [s2, s1, s3, s4]', J(await cellIds()) === J([s2, s1, s3, s4]))

  console.log('\n=== 8. 窄窗口自动收栏 ===')
  win.setSize(1024, 700)
  await sleep(800)
  const collapsed = await waitFor(`!__t.q('[data-rail="files"]')`, 3000)
  check('四宫格在 1024 宽下目录栏临时收起', collapsed, collapsed ? undefined : await js('JSON.stringify(window.__warpDebug.layout())'))
  check('会话栏仍展开', await js(`Math.round(__t.q('[data-rail="sessions"]').getBoundingClientRect().width) === 200`))
  const narrow = await js('__t.cells()')
  check('每格宽度 ≥ 360', narrow.every((c) => c.width >= 358), narrow.map((c) => c.width))
  check('没有横向溢出', await js(`document.documentElement.scrollWidth <= window.innerWidth`))
  check('用户偏好不变（仍是显示）', state().fileRailVisible === true)
  await js(`__t.q('[data-grid-mode="single"]').click()`)
  check('单格不需要收：目录栏回来', await waitFor(`!!__t.q('[data-rail="files"]')`, 2000))
  await js(`__t.q('[data-grid-mode="quad"]').click()`)
  await waitFor(`!__t.q('[data-rail="files"]')`, 2000)
  await keys('E', ['control', 'shift'])
  check('手动展开优先于自动收起', await waitFor(`!!__t.q('[data-rail="files"]')`, 2000))
  win.setSize(1440, 900)
  await sleep(800)
  check('窗口变宽后目录栏保持显示', await js(`!!__t.q('[data-rail="files"]')`))

  console.log('\n=== 9. 栏宽与落盘 ===')
  await mouseDrag('[data-testid="resize-session-rail"]', 60, 0)
  const railW = await js(`Math.round(__t.q('[data-rail="sessions"]').getBoundingClientRect().width)`)
  check('拖动会话栏边缘改宽度', Math.abs(railW - 260) <= 2, railW)
  await mouseDrag('[data-testid="resize-file-rail"]', 400, 0)
  const fileW = await js(`Math.round(__t.q('[data-rail="files"]').getBoundingClientRect().width)`)
  check('目录栏宽度夹在上限 400', fileW === 400, fileW)
  await mouseDrag('[data-testid="resize-file-rail"]', -160, 0)
  await sleep(900)
  const st = state()
  const nb = win.getNormalBounds()
  check('window-state.json：宫格与格位', st && st.gridMode === 'quad' && J(st.cells) === J([s2, s1, s3, s4]), st && { gridMode: st.gridMode, cells: st.cells })
  check('window-state.json：分隔比例', st && st.splitRatioH > 0.55 && st.splitRatioH <= 0.8, st && st.splitRatioH)
  check('window-state.json：栏宽', st && Math.abs(st.sessionRailWidth - 260) <= 2 && Math.abs(st.fileRailWidth - 240) <= 2, st && { s: st.sessionRailWidth, f: st.fileRailWidth })
  check('window-state.json：窗口尺寸', st && st.width === nb.width && st.height === nb.height && st.maximized === false, st && { w: st.width, h: st.height, nb })
  const bad = await js(`window.warp.layout.update({ cells: ['../x', null, null, null] }).then(() => 'resolved', () => 'rejected')`)
  check('layout:update 拒绝非法格位', bad === 'rejected')
  const dup = await js(`window.warp.layout.update({ cells: [${J(s1)}, ${J(s1)}, null, null] }).then(() => 'resolved', () => 'rejected')`)
  check('layout:update 拒绝同一会话占两格', dup === 'rejected')
  const sizeTry = await js(`window.warp.layout.update({ width: 300, gridMode: 'quad' }).then((l) => l.width)`)
  check('渲染层改不了窗口尺寸', sizeTry === nb.width, sizeTry)

  console.log('\n=== 10. 渲染层重载后回放 ===')
  const loaded = new Promise((r) => win.webContents.once('did-finish-load', r))
  win.webContents.reload()
  await loaded
  await waitFor(`!!document.querySelector('section[data-cell]')`, 8000)
  await js(HELPERS)
  check('布局读回：四宫格 + 原格位', await waitFor(`${J(J([s2, s1, s3, s4]))} === JSON.stringify(__t.cells().map((c) => c.id))`, 8000), await cellIds())
  check('栏宽读回', await js(`Math.abs(Math.round(__t.q('[data-rail="sessions"]').getBoundingClientRect().width) - 260) <= 2`))
  const marks = [[s1, 'CELL1-OK'], [s2, 'CELL2-OK'], [s3, 'CELL3-OK'], [s4, 'BG-OUTPUT']]
  for (const [id, mark] of marks) {
    check(`主进程缓冲回放：${mark}`, await waitFor(`window.__warpDebug.text(${J(id)}).includes(${J(mark)})`, 5000))
  }
  check('后台会话 s1b 没被误清', (await list()).some((s) => s.id === s1b))

  console.log('\n=== 11. 关闭会话后格变空 ===')
  await js(`__t.q('section[data-cell="2"] button[aria-label="关闭会话"]').click()`)
  await waitFor(`!!__t.q('[data-testid="confirm-dialog"]')`, 2000)
  await js(`__t.q('[data-testid="confirm-ok"]').click()`)
  check('第 3 格回到空态', await waitFor(`!!__t.q('[data-empty-cell="2"]')`, 8000))
  await sleep(900)
  check('格位落盘清掉', state().cells[2] === null, state().cells)

  console.log('\n=== 收尾 ===')
  check('渲染层没有报错', rendererErrors.length === 0, rendererErrors.slice(0, 3))
  for (const s of await list()) await js(`window.warp.session.close(${J(s.id)})`)
  check('会话全部关闭', await waitFor(`window.warp.session.list().then((l) => l.length === 0)`, 10000))

  console.log(`\n${pass}/${pass + fail} 通过`)
  win.destroy()
  setTimeout(() => {
    try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
    app.exit(fail ? 1 : 0)
  }, 300)
}).catch((e) => {
  console.log('\n  FAIL  脚本异常', (e && e.stack) || e)
  app.exit(2)
})
