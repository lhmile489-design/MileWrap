/**
 * 复制粘贴链路探针：预写 config 夹具（同 verify-m1），开真实窗口验证
 *   1. clipboard:read / clipboard:write / clipboard:readImage IPC
 *   2. Ctrl+Shift+V 粘贴是否进 PTY（stdin 探针回显）
 *   3. contextmenu 右键粘贴
 *   4. 搜索造选区后 Ctrl+Shift+C 是否写剪贴板
 *   5. 剪贴板里只有图片时 Ctrl+Shift+V 粘图片文件路径
 *   6. settings.pasteOnCtrlV 开启后 Ctrl+V 也走粘贴
 *
 *   npm run build
 *   npx electron scripts/probe-clipboard.cjs
 */
const { app, BrowserWindow, clipboard, nativeImage } = require('electron')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs')

const ROOT = join(__dirname, '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'warp-clip-'))
app.setPath('appData', SANDBOX)
process.env['MILE_WARP_DATA_DIR'] = SANDBOX

const WORK = ROOT
mkdirSync(join(SANDBOX, 'mile-warp'), { recursive: true })
const now = Date.now()
writeFileSync(
  join(SANDBOX, 'mile-warp', 'config.json'),
  JSON.stringify(
    {
      version: 1,
      groups: [],
      workspaces: [
        {
          id: 'ws-clip', groupId: null, name: 'clip-test', note: '', agentId: 'shell', agentPath: null,
          cwd: WORK, args: [], envKeys: [], envEnc: null, order: 0, createdAt: now, updatedAt: now
        }
      ],
      customAgents: [],
      settings: {},
      sessionRecords: []
    },
    null,
    2
  ),
  'utf8'
)

// 调试面（window.__warpDebug）只在 MILE_WARP_DEBUG=1 时挂，必须在 require 主进程包之前设
process.env.MILE_WARP_DEBUG = '1'
require(join(ROOT, 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) pass++
  else fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -- ' + extra : ''}`)
}
const J = (v) => JSON.stringify(v)

setTimeout(() => { console.log('\n  FAIL  总超时 120 秒'); app.exit(3) }, 120000).unref()

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { console.log('FAIL  没有窗口'); app.exit(1); return }
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.webContents.on('console-message', (e) => {
    if ((e.level ?? 0) >= 2) console.log('  [renderer]', e.message)
  })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 10000) => {
    for (let t = 0; t < ms; t += 150) {
      try {
        if (await js(code)) return true
      } catch { /* 元素还没渲染 */ }
      await sleep(150)
    }
    return false
  }
  const keys = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(250)
  }

  console.log('=== 1. 剪贴板 IPC ===')
  await js(`window.warp.clipboard.write(${J('warp-clip-probe-1')})`)
  await sleep(150)
  check('clipboard:write → 系统剪贴板', clipboard.readText() === 'warp-clip-probe-1', clipboard.readText())
  clipboard.writeText('warp-clip-probe-2')
  const read = await js(`window.warp.clipboard.read()`)
  check('clipboard:read ← 系统剪贴板', read === 'warp-clip-probe-2', read)

  console.log('=== 2. 点工作区卡片起 shell ===')
  await waitFor(`!!document.querySelector('[data-workspace-id="ws-clip"]')`)
  await js(`document.querySelector('[data-workspace-id="ws-clip"]').click()`)
  const started = await waitFor(`window.warp.session.list().then(l => l.length === 1 && l[0].status === 'running')`, 15000)
  const [meta] = await js('window.warp.session.list()')
  check('会话运行中', started, meta && { status: meta.status, kind: meta.kind })
  const id = meta.id
  check('xterm 挂进格里', await js(`!!document.querySelector('[data-session-id="${id}"] .xterm')`))
  await js(`document.querySelector('main .xterm-helper-textarea').focus()`)
  const probe = `node -e "process.stdin.setRawMode(true);console.log('READY');process.stdin.on('data',d=>console.log('GOT'+JSON.stringify(d.toString())))"`
  await js(`window.warp.session.write(${J(id)}, ${J(probe + '\r')})`)
  check('stdin 探针 READY', await waitFor(`window.__warpDebug.text(${J(id)}).split('\\n').some((l) => l.trim() === 'READY')`, 15000))

  console.log('=== 3. Ctrl+Shift+V 粘贴 ===')
  clipboard.writeText('PASTE-VIA-CTRLSHIFTV')
  await js(`document.querySelector('main .xterm-helper-textarea').focus()`)
  await keys('V', ['control', 'shift'])
  check('Ctrl+Shift+V 进了 PTY', await waitFor(`window.__warpDebug.text(${J(id)}).includes('PASTE-VIA-CTRLSHIFTV')`, 5000))

  console.log('=== 4. contextmenu 右键粘贴 ===')
  clipboard.writeText('PASTE-VIA-RIGHTCLICK')
  await js(`(() => {
    const el = document.querySelector('main .xterm')
    if (!el) return 'no-el'
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    return 'ok'
  })()`)
  check('右键（无选区）粘贴进 PTY', await waitFor(`window.__warpDebug.text(${J(id)}).includes('PASTE-VIA-RIGHTCLICK')`, 5000))

  console.log('=== 4.5 剪贴板只有图片时粘贴路径 ===')
  // 用 canvas 生成一个真实的 PNG（某些 base64 PNG Electron 解析不了）
  const png = await (async () => {
    const { BrowserWindow } = require('electron')
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
    await win.loadURL('data:text/html,<canvas id=c width=4 height=4></canvas><script>const c=document.getElementById("c").getContext("2d");c.fillStyle="red";c.fillRect(0,0,4,4);</script>')
    const dataUrl = await win.webContents.executeJavaScript('document.getElementById("c").toDataURL()')
    win.close()
    return nativeImage.createFromDataURL(dataUrl)
  })()
  console.log('  nativeImage size:', png.getSize(), 'toPNG len:', png.toPNG().length)
  clipboard.writeImage(png)
  // 验证 probe 进程自己能读回来（同进程）
  const probeRead = clipboard.readImage()
  console.log('  probe 进程 readImage size:', probeRead.getSize(), 'isEmpty:', probeRead.isEmpty(), 'toPNG len:', probeRead.toPNG().length)
  await sleep(300) // Windows 剪贴板跨进程可能有延迟
  const imgPath = await js(`window.warp.clipboard.readImage()`)
  check('clipboard:readImage 返回 PNG 路径', typeof imgPath === 'string' && imgPath.endsWith('.png'), imgPath || 'null')
  if (imgPath) {
    const { existsSync } = require('node:fs')
    check('临时 PNG 已落盘', existsSync(imgPath))
    await js(`document.querySelector('main .xterm-helper-textarea').focus()`)
    await keys('V', ['control', 'shift'])
    const imgPasted = await waitFor(`window.__warpDebug.text(${J(id)}).includes('paste-')`, 5000)
    check('Ctrl+Shift+V 粘图片 → 文件路径进 PTY', imgPasted)
  }
  clipboard.writeText('') // 清掉图片，防后面段落误读

  console.log('=== 4.6 settings.pasteOnCtrlV ===')
  // 走真实 UI：Ctrl+, 打开设置 → 终端页签 → 点「Ctrl+V 粘贴」开关（经 useConfig.updateSettings 同步 zustand）
  const toggleCtrlV = async (want) => {
    await keys(',', ['control'])
    await waitFor(`!!document.querySelector('[data-testid="settings-dialog"]')`, 3000)
    await js(`document.querySelector('[data-settings-tab="terminal"]').click()`)
    await waitFor(`!!document.querySelector('[data-testid="settings-paste-on-ctrl-v"]')`, 3000)
    await js(`(() => { const s = document.querySelector('[data-testid="settings-paste-on-ctrl-v"]'); if ((s.getAttribute('aria-checked') === 'true') !== ${want}) s.click() })()`)
    await waitFor(`document.querySelector('[data-testid="settings-paste-on-ctrl-v"]').getAttribute('aria-checked') === '${want}'`, 3000)
    await keys('Escape')
    await waitFor(`!document.querySelector('[data-testid="settings-dialog"]')`, 3000)
  }
  await toggleCtrlV(true)
  await sleep(300)
  clipboard.writeText('PASTE-VIA-CTRLV')
  await js(`document.querySelector('main .xterm-helper-textarea').focus()`)
  await keys('V', ['control'])
  check('pasteOnCtrlV 开时 Ctrl+V 进 PTY', await waitFor(`window.__warpDebug.text(${J(id)}).includes('PASTE-VIA-CTRLV')`, 5000))
  await toggleCtrlV(false)
  await sleep(300)

  console.log('=== 5. 有选区时 Ctrl+Shift+C 复制 ===')
  // 终端内搜索造选区：先写一行含 FINDME 的输出，再 Ctrl+Shift+F 搜它
  await js(`window.warp.session.write(${J(id)}, ${J('echo FINDME-UNIQUE-TOKEN\r')})`)
  await waitFor(`window.__warpDebug.text(${J(id)}).includes('FINDME-UNIQUE-TOKEN')`, 5000)
  await js(`document.querySelector('main .xterm-helper-textarea').focus()`)
  await keys('F', ['control', 'shift'])
  const searchOpen = await waitFor(`!!document.querySelector('[data-search-cell] input')`, 3000)
  check('搜索条打开', searchOpen)
  if (searchOpen) {
    await js(`(() => {
      const inp = document.querySelector('[data-search-cell] input')
      const proto = HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(inp, 'FINDME')
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      return 'ok'
    })()`)
    await sleep(400)
    const sel = await js(`window.__warpDebug.selection(${J(id)})`)
    console.log('  搜索后选区:', JSON.stringify(sel))
    if (sel && sel.toLowerCase().includes('findme')) {
      clipboard.writeText('')
      await js(`document.querySelector('main .xterm-helper-textarea').focus()`)
      await keys('C', ['control', 'shift'])
      await sleep(300)
      const clipAfterC = clipboard.readText()
      check('Ctrl+Shift+C 复制进剪贴板', clipAfterC.toLowerCase().includes('findme'), clipAfterC.slice(0, 40))
    } else {
      check('搜索制造选区', false, 'no selection')
    }
  }

  console.log(`\n  ${pass} pass / ${fail} fail`)
  app.exit(fail ? 1 : 0)
})
