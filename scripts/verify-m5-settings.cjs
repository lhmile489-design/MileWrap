/**
 * M5 验收：设置、主题、快捷键、命令面板、终端内搜索（技术设计 §11 M5）。
 *
 *   1. 默认应用菜单已去掉：焦点在终端时 Ctrl+R / Ctrl+W 送进 PTY，页面不重载、窗口不关
 *   2. 设置页：Ctrl+, 打开；主题切换落到 data-theme；字号 / 字体立即作用到已有终端；越界值被拒且回退；
 *      默认 Shell 只能选本机探测到的；关闭行为、恢复开关落盘；Agent 列表与重新检测；关于页版本
 *   3. 字号快捷键 Ctrl+= / Ctrl+- / Ctrl+0
 *   4. 命令面板：Ctrl+Shift+K / 标题栏触发框打开；搜工作区回车启动；执行动作（切四宫格、打开设置）
 *   5. 终端内搜索：Ctrl+Shift+F、回车选中匹配、无匹配提示、Esc 还焦点
 *
 *   npm run build
 *   npx electron scripts/verify-m5-settings.cjs 2>&1 | Out-File $env:TEMP\warp-m5.log -Encoding utf8
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'warp-m5-'))
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const WORK = join(SANDBOX, '设置 验证')
mkdirSync(WORK, { recursive: true })
const CFG = join(SANDBOX, 'mile-warp', 'config.json')
mkdirSync(join(SANDBOX, 'mile-warp'), { recursive: true })
const now = Date.now()
writeFileSync(
  CFG,
  JSON.stringify({
    version: 1,
    groups: [],
    workspaces: [
      { id: 'wsA', groupId: null, name: '面板目标', note: '备注甲', agentId: 'shell', agentPath: null, cwd: WORK, args: [], envKeys: [], envEnc: null, order: 0, createdAt: now, updatedAt: now }
    ],
    customAgents: [],
    settings: { theme: 'light' },
    sessionRecords: []
  }),
  'utf8'
)

// 调试面（window.__warpDebug）只在 MILE_WARP_DEBUG=1 时挂，必须在 require 主进程包之前设
process.env.MILE_WARP_DEBUG = '1'
require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const settings = () => JSON.parse(readFileSync(CFG, 'utf8')).settings

setTimeout(() => { console.log('\n  FAIL  总超时 180 秒'); app.exit(3) }, 180000).unref()

const HELPERS = `
window.__t = {
  q: (sel) => document.querySelector(sel),
  qa: (sel) => [...document.querySelectorAll(sel)],
  setVal(el, v) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  },
  key(el, key, extra = {}) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }))
  },
  /** 输入框改值后失焦提交 */
  commit(sel, v) {
    const el = document.querySelector(sel)
    el.focus()
    this.setVal(el, v)
    el.blur()
  },
  tab(id) {
    document.querySelector('[data-settings-tab="' + id + '"]').click()
  },
  radio(groupSel, value) {
    document.querySelector(groupSel + ' [data-value="' + value + '"]').click()
  },
  menuItems: () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((b) => b.textContent.trim())
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
  const keys = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(300)
  }
  // React 受控输入：先改值，等一帧重渲染，再失焦提交（同一个任务里连发，onBlur 读到的是旧值）
  const commit = async (sel, v) => {
    await js(`(() => { const el = __t.q(${J(sel)}); el.focus(); __t.setVal(el, ${J(v)}); return true })()`)
    await sleep(80)
    await js(`__t.q(${J(sel)}).blur()`)
    await sleep(300)
  }
  const termText = (id) => js(`window.__warpDebug.text(${J(id)})`)

  await waitFor(`!!document.querySelector('[data-rail="sessions"] [data-workspace-id]')`)
  await js(HELPERS)
  win.focus()

  console.log('\n=== 1. 默认应用菜单已去掉，按键还给终端 ===')
  await js(`__t.q('[data-workspace-id="wsA"]').click()`)
  await waitFor(`window.warp.session.list().then((l) => l.length === 1 && l[0].status === 'running')`, 15000)
  const [s] = await js('window.warp.session.list()')
  await waitFor(`window.__warpDebug.text(${J(s.id)}).includes('设置 验证')`, 15000)
  const probe = `node -e "process.stdin.setRawMode(true);console.log('READY');process.stdin.on('data',d=>console.log('GOT'+JSON.stringify(d.toString())))"`
  await js(`window.warp.session.write(${J(s.id)}, ${J(probe + '\r')})`)
  check('stdin 探针就绪', await waitFor(`window.__warpDebug.text(${J(s.id)}).split('\\n').some((l) => l.trim() === 'READY')`, 10000))
  await js(`window.__alive = 'yes'; __t.q('main .xterm-helper-textarea').focus(); true`)
  await keys('R', ['control'])
  check('Ctrl+R 送进 PTY（\\x12）', await waitFor(`window.__warpDebug.text(${J(s.id)}).includes('GOT"\\\\u0012"')`, 3000))
  check('页面没有被 Ctrl+R 重载', (await js('window.__alive')) === 'yes')
  // 「窗口没关」= 没被销毁：isVisible 在最小化时也是 false，会误报；先把窗口恢复出来再按键
  if (win.isMinimized() || !win.isVisible()) { win.restore(); win.show() }
  await keys('W', ['control'])
  check('Ctrl+W 送进 PTY（\\x17），窗口没关', (await waitFor(`window.__warpDebug.text(${J(s.id)}).includes('GOT"\\\\u0017"')`, 3000)) && !win.isDestroyed())
  const beforeEq = (await termText(s.id)).split('GOT').length
  await keys('=', ['control'])
  check('Ctrl+= 不进 PTY（应用内字号快捷键）', (await termText(s.id)).split('GOT').length === beforeEq)

  console.log('\n=== 2. 字号快捷键 ===')
  check('Ctrl+= 字号 13 → 14', (await waitFor(`window.__warpDebug.font(${J(s.id)}).size === 14`, 2000)) && settings().fontSize === 14, await js(`window.__warpDebug.font(${J(s.id)})`))
  await keys('-', ['control'])
  await keys('-', ['control'])
  check('Ctrl+- 两次 → 12', await waitFor(`window.__warpDebug.font(${J(s.id)}).size === 12`, 2000))
  await keys('0', ['control'])
  check('Ctrl+0 复位到 13', await waitFor(`window.__warpDebug.font(${J(s.id)}).size === 13`, 2000))
  // 结束探针，后面要往 shell 里写搜索用的内容
  await js(`window.warp.session.write(${J(s.id)}, '\\u0003')`)
  await js(`window.warp.session.restart(${J(s.id)})`)
  await waitFor(`window.__warpDebug.text(${J(s.id)}).includes('设置 验证')`, 15000)

  console.log('\n=== 3. 设置页 ===')
  await js(`__t.q('main .xterm-helper-textarea').focus()`)
  await keys(',', ['control'])
  check('Ctrl+, 打开设置', await waitFor(`!!__t.q('[data-testid="settings-dialog"]')`, 2000))
  check('七个页签', J(await js(`__t.qa('[data-testid="settings-dialog"] [role="tab"]').map((t) => t.textContent)`)) === J(['外观', '终端', 'Agent', '通知', '启动与恢复', 'Git', '关于']))
  await js(`__t.radio('[data-testid="settings-theme"]', 'dark')`)
  check('切深色：data-theme = dark，落盘', (await waitFor(`document.documentElement.dataset.theme === 'dark'`, 3000)) && settings().theme === 'dark')
  await js(`__t.radio('[data-testid="settings-theme"]', 'light')`)
  check('切浅色', await waitFor(`document.documentElement.dataset.theme === 'light'`, 3000))
  await js(`__t.radio('[data-testid="settings-theme"]', 'system')`)
  check('跟随系统落盘', await waitFor(`window.warp.config.get().then((c) => c.settings.theme === 'system')`, 3000))
  await js(`__t.radio('[data-testid="settings-theme"]', 'light')`)
  await sleep(300)

  await js(`__t.tab('terminal')`)
  await waitFor(`!!__t.q('[data-testid="settings-font-size"]')`, 2000)
  await commit('[data-testid="settings-font-size"]', '16')
  check('改字号立即作用到已有终端', (await waitFor(`window.__warpDebug.font(${J(s.id)}).size === 16`, 2000)) && settings().fontSize === 16)
  await commit('[data-testid="settings-font-size"]', '99')
  check('越界字号被拒并提示原因', await waitFor(`__t.qa('[data-testid="settings-dialog"] [role="alert"]').some((e) => e.textContent.includes('10–24'))`, 2000))
  check('被拒后输入框回到当前值', (await js(`__t.q('[data-testid="settings-font-size"]').value`)) === '16' && settings().fontSize === 16)
  await commit('[data-testid="settings-font-family"]', "Consolas, 'Microsoft YaHei UI', monospace")
  check('改字体作用到已有终端', await waitFor(`window.__warpDebug.font(${J(s.id)}).family.startsWith('Consolas')`, 2000))
  await commit('[data-testid="settings-scrollback"]', '8000')
  check('滚动行数落盘', settings().scrollback === 8000)
  await js(`__t.q('[data-testid="settings-copy-on-select"]').click()`)
  check('选中即复制开关', await waitFor(`window.warp.config.get().then((c) => c.settings.copyOnSelect === false)`, 2000))
  const shells = await js('window.warp.agent.shells()')
  check('默认 Shell 只列本机存在的', shells.length >= 2 && shells.some((x) => /powershell\.exe$/i.test(x.path)) && shells.some((x) => /cmd\.exe$/i.test(x.path)), shells.map((x) => x.label))
  const ps = shells.find((x) => /powershell\.exe$/i.test(x.path)).path
  await js(`__t.setVal(__t.q('[data-testid="settings-shell"]'), ${J(ps)})`)
  check('选择 Windows PowerShell 落盘', await waitFor(`window.warp.config.get().then((c) => c.settings.shellPath === ${J(ps)})`, 2000))
  const evil = await js(`window.warp.settings.update({ shellPath: 'C:\\\\Windows\\\\System32\\\\notepad.exe' }).then(() => 'resolved', (e) => 'rejected:' + e.message)`)
  check('渲染层不能把任意 exe 设成 Shell', evil.startsWith('rejected') && evil.includes('本机已安装'), evil)
  await js(`__t.setVal(__t.q('[data-testid="settings-shell"]'), '')`)
  check('改回自动', await waitFor(`window.warp.config.get().then((c) => c.settings.shellPath === null)`, 2000))

  await js(`__t.tab('startup')`)
  await waitFor(`!!__t.q('[data-testid="settings-close-action"]')`, 2000)
  await js(`__t.radio('[data-testid="settings-close-action"]', 'tray')`)
  check('关闭行为落盘', await waitFor(`window.warp.config.get().then((c) => c.settings.closeAction === 'tray')`, 2000))
  await js(`__t.q('[data-testid="settings-restore-on-startup"]').click()`)
  await js(`__t.q('[data-testid="settings-resume"]').click()`)
  check('恢复开关落盘', await waitFor(`window.warp.config.get().then((c) => c.settings.restoreOnStartup === true && c.settings.resumeConversation === false)`, 2000))
  await js(`__t.radio('[data-testid="settings-close-action"]', 'ask')`)

  await js(`__t.tab('agents')`)
  check('Agent 页列出 5 个预设', await waitFor(`__t.qa('[data-agent]').length === 5`, 2000))
  await js(`__t.q('[data-testid="settings-redetect"]').click()`)
  check('重新检测完成', await waitFor(`!__t.q('[data-testid="settings-redetect"]').disabled`, 20000))
  await js(`__t.tab('about')`)
  check('关于页显示版本', await waitFor(`/版本 \\d+\\.\\d+\\.\\d+/.test(__t.q('[data-testid="settings-version"]').textContent)`, 2000))
  await js(`__t.key(document.activeElement, 'Escape')`)
  check('Esc 关闭设置', await waitFor(`!__t.q('[data-testid="settings-dialog"]')`, 2000))

  console.log('\n=== 4. 命令面板 ===')
  await js(`__t.q('main .xterm-helper-textarea').focus()`)
  await keys('K', ['control', 'shift'])
  check('Ctrl+Shift+K 打开命令面板，输入框拿到焦点', (await waitFor(`!!__t.q('[data-testid="palette"]')`, 2000)) && (await js(`document.activeElement === __t.q('[data-testid="palette-input"]')`)))
  check('分组：工作区 / 会话 / 动作', await js(`['workspace', 'session', 'action'].every((k) => __t.qa('[data-testid="palette"] [data-kind="' + k + '"]').length > 0)`))
  await js(`__t.setVal(__t.q('[data-testid="palette-input"]'), '备注甲')`)
  check('按备注搜到工作区', await waitFor(`__t.qa('[role="option"]').length >= 1 && __t.q('[role="option"][aria-selected="true"]').dataset.kind === 'workspace'`, 2000))
  await js(`__t.setVal(__t.q('[data-testid="palette-input"]'), '四宫格')`)
  await sleep(100)
  await js(`__t.key(__t.q('[data-testid="palette-input"]'), 'Enter')`)
  check('执行动作「布局：四宫格」', await waitFor(`__t.q('main[data-grid]').dataset.grid === 'quad'`, 2000))
  check('执行后面板关闭', await js(`!__t.q('[data-testid="palette"]')`))
  await js(`__t.q('[data-testid="palette-trigger"]').click()`)
  check('标题栏搜索框打开面板', await waitFor(`!!__t.q('[data-testid="palette"]')`, 2000))
  await js(`__t.setVal(__t.q('[data-testid="palette-input"]'), 'zzz-没有')`)
  check('无结果提示', await waitFor(`__t.q('[data-testid="palette"]').textContent.includes('没有匹配')`, 2000))
  await js(`__t.setVal(__t.q('[data-testid="palette-input"]'), '设置')`)
  await sleep(100)
  const firstActive = await js(`__t.q('[role="option"][aria-selected="true"]').textContent`)
  await js(`__t.key(__t.q('[data-testid="palette-input"]'), 'ArrowDown')`)
  check('方向键移动选中项', (await js(`__t.q('[role="option"][aria-selected="true"]').textContent`)) !== firstActive || (await js(`__t.qa('[role="option"]').length`)) === 1)
  await js(`__t.setVal(__t.q('[data-testid="palette-input"]'), '打开设置')`)
  await sleep(100)
  await js(`__t.key(__t.q('[data-testid="palette-input"]'), 'Enter')`)
  check('执行动作「打开设置」', await waitFor(`!!__t.q('[data-testid="settings-dialog"]')`, 2000))
  await js(`__t.key(document.activeElement, 'Escape')`)
  await waitFor(`!__t.q('[data-testid="settings-dialog"]')`, 2000)
  await js(`__t.q('[data-testid="palette-trigger"]').click()`)
  await waitFor(`!!__t.q('[data-testid="palette"]')`, 2000)
  await js(`__t.key(__t.q('[data-testid="palette-input"]'), 'Escape')`)
  check('Esc 关闭面板', await waitFor(`!__t.q('[data-testid="palette"]')`, 2000))

  console.log('\n=== 5. 终端内搜索 ===')
  await js(`window.warp.session.write(${J(s.id)}, 'Write-Output FINDME-123\\r')`)
  await waitFor(`window.__warpDebug.text(${J(s.id)}).split('\\n').some((l) => l.trim() === 'FINDME-123')`, 8000)
  await js(`__t.q('main .xterm-helper-textarea').focus()`)
  await keys('F', ['control', 'shift'])
  check('Ctrl+Shift+F 打开搜索条并聚焦', (await waitFor(`!!__t.q('[data-search-cell] input')`, 2000)) && (await waitFor(`document.activeElement === __t.q('[data-testid="terminal-search-input"]')`, 2000)))
  await js(`__t.setVal(__t.q('[data-testid="terminal-search-input"]'), 'findme')`)
  await sleep(80)
  await js(`__t.key(__t.q('[data-testid="terminal-search-input"]'), 'Enter')`)
  check('回车找到并选中匹配（不区分大小写）', await waitFor(`window.__warpDebug.selection(${J(s.id)}).toLowerCase() === 'findme'`, 2000), await js(`window.__warpDebug.selection(${J(s.id)})`))
  await js(`__t.setVal(__t.q('[data-testid="terminal-search-input"]'), 'nope-xyz-404')`)
  await sleep(80)
  await js(`__t.key(__t.q('[data-testid="terminal-search-input"]'), 'Enter')`)
  check('没有匹配时提示', await waitFor(`__t.q('[data-search-cell]').textContent.includes('无匹配')`, 2000))
  await js(`__t.key(__t.q('[data-testid="terminal-search-input"]'), 'Escape')`)
  check('Esc 关闭搜索条，键盘回到终端', (await waitFor(`!__t.q('[data-search-cell]')`, 2000)) && (await js(`document.activeElement.classList.contains('xterm-helper-textarea')`)))

  console.log('\n=== 6. 标题栏主题菜单 ===')
  await js(`[...__t.qa('header button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('主题')).click()`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  check('主题菜单三项', J(await js('__t.menuItems()')) === J(['跟随系统', '浅色', '深色']))
  await js(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((b) => b.textContent.trim() === '深色').click()`)
  check('从标题栏切到深色，终端配色跟着变', await waitFor(`document.documentElement.dataset.theme === 'dark'`, 3000))

  console.log('\n=== 7. 应用图标 ===')
  check('标题栏图标加载出来（128px 位图）', await waitFor(`(() => { const i = __t.q('[data-testid="app-logo"]'); return !!i && i.complete && i.naturalWidth === 128 })()`, 3000))
  const winIcon = require('electron').nativeImage.createFromPath(join(ROOT, 'resources', 'icon.png'))
  check('窗口 / 托盘用的 resources/icon.png 是 256px', !winIcon.isEmpty() && winIcon.getSize().width === 256, winIcon.getSize())

  console.log('\n=== 收尾 ===')
  check('渲染层没有报错', rendererErrors.length === 0, rendererErrors.slice(0, 3))
  for (const x of await js('window.warp.session.list()')) await js(`window.warp.session.close(${J(x.id)})`)
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
