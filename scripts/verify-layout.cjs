/**
 * 布局验收：控件里的文字不能被挤得换行或溢出（用户反馈「文字因为按钮太小被挤到换行」）。
 *
 * 在多种典型状态下扫一遍 DOM，凡是下面这些元素里的文字折成了两行、或者被裁掉却没有省略号，都算违规：
 *   button、[role=tab|radio|menuitem|option]、kbd、胶囊（.rounded-pill）、设置行标题、格头标题
 * 判定按「单个文本节点的行盒数」：同一个文本节点出现两个以上不同 top 的矩形 = 折行。
 * 这样不会把图标与文字的垂直错位误判成折行。
 *
 * 状态：1024 / 1440 宽 × 单格 / 双格 / 四宫格（含长标题、运行中、异常退出的会话）、会话栏折叠、
 *       设置各页签、新建 / 编辑工作区弹窗（含环境变量行）、命令面板、右键菜单、关闭确认框。
 *
 *   npm run build
 *   npx electron scripts/verify-layout.cjs 2>&1 | Out-File $env:TEMP\warp-layout.log -Encoding utf8
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'warp-layout-'))
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const now = Date.now()
const specs = [
  ['w0', 'claude', '客户端（Claude Code 主仓库）', 'g1'],
  ['w1', 'codex', '订单服务后端很长很长的工作区名字', 'g1'],
  ['w2', 'shell', 'Shell 运维', null],
  ['w3', 'shell', '异常退出示例', null]
]
const workspaces = specs.map(([id, agentId, name, groupId], i) => {
  const cwd = join(SANDBOX, `目录 ${i} 有一个比较长的文件夹名称`)
  mkdirSync(cwd, { recursive: true })
  return { id, groupId, name, note: '这是一段备注', agentId, agentPath: null, cwd, args: [], envKeys: [], envEnc: null, order: i, createdAt: now, updatedAt: now + i }
})
mkdirSync(join(SANDBOX, 'mile-warp'), { recursive: true })
writeFileSync(
  join(SANDBOX, 'mile-warp', 'config.json'),
  JSON.stringify({
    version: 1,
    groups: [{ id: 'g1', name: '前端与后端项目组', color: null, collapsed: false, order: 0 }],
    workspaces,
    customAgents: [],
    settings: { closeAction: 'ask' },
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

setTimeout(() => { console.log('\n  FAIL  总超时 180 秒'); app.exit(3) }, 180000).unref()

/** 页面里的审计函数：返回违规元素的描述 */
const AUDIT = `
window.__audit = () => {
  const SEL = 'button, [role="tab"], [role="radio"], [role="menuitem"], [role="option"], kbd, .rounded-pill, [data-audit], [data-audit-minw]'
  const out = []
  const seen = new Set()
  for (const el of document.querySelectorAll(SEL)) {
    if (seen.has(el)) continue
    seen.add(el)
    const box = el.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden') continue
    // 1. 折行：任一文本节点有两行以上
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let wrapped = null
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue
      const r = document.createRange()
      r.selectNodeContents(n)
      const tops = [...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))
      if (new Set(tops.map((t) => Math.round(t / 4))).size > 1) {
        wrapped = n.textContent.trim()
        break
      }
    }
    // 2. 溢出：内容比盒子宽，又没有用省略号收尾
    const ellipsis = cs.textOverflow === 'ellipsis' || [...el.querySelectorAll('*')].some((c) => getComputedStyle(c).textOverflow === 'ellipsis')
    const overflow = !ellipsis && el.scrollWidth > el.clientWidth + 2
    // 3. 说明文字被挤窄：标了 data-audit-minw 的块不能比这个宽度窄
    const minw = Number(el.dataset.auditMinw || 0)
    if (minw) {
      // 说明文字本身可以多行，只检查宽度
      if (box.width < minw - 1) out.push({ kind: '被挤窄', text: el.innerText.trim().slice(0, 40), w: Math.round(box.width), min: minw })
      continue
    }
    if (wrapped || overflow) {
      out.push({ kind: wrapped ? '折行' : '溢出', text: (wrapped || el.innerText).trim().slice(0, 40), w: Math.round(box.width), h: Math.round(box.height), where: (el.closest('[data-testid], [data-rail], section[data-cell], header, [role="dialog"], [role="menu"]') || {}).outerHTML?.slice(0, 60) })
    }
  }
  return out
}
true
`

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
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
  const audit = async (name) => {
    await sleep(350)
    const bad = await js('window.__audit()')
    check(`${name}：控件文字不折行、不溢出`, bad.length === 0, bad.length ? bad.slice(0, 6) : undefined)
  }
  const esc = () => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  const grid = (m) => js(`document.querySelector('[data-grid-mode="${m}"]').click()`)

  await waitFor(`!!document.querySelector('[data-rail="sessions"] [data-workspace-id]')`)
  await js(AUDIT)

  // 准备会话：4 个会话放进 4 格，其中一个异常退出
  await grid('quad')
  await waitFor(`document.querySelectorAll('section[data-cell]').length === 4`)
  for (const [i, ws] of ['w0', 'w1', 'w2', 'w3'].entries()) {
    const ctxEl = `[data-rail="sessions"] [data-workspace-id="${ws}"]`
    await js(`(() => { const el = document.querySelector(${J(ctxEl)}); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })); return true })()`)
    await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
    await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === '在第 ${i + 1} 格打开').click()`)
    await waitFor(`!!document.querySelector('section[data-cell="${i}"] [data-session-id]')`, 15000)
  }
  // 后两个是 shell：一个改长标题，一个 exit 3
  const list = await js('window.warp.session.list()')
  const by = (ws) => list.find((s) => s.workspaceId === ws)
  await js(`window.warp.session.rename(${J(by('w2').id)}, '一个非常非常长的会话标题用来测试格头是否会挤压')`)
  await waitFor(`window.__warpDebug.text(${J(by('w3').id)}).includes('目录 3')`, 15000)
  await js(`window.warp.session.write(${J(by('w3').id)}, 'exit 3\\r')`)
  await waitFor(`window.warp.session.list().then((l) => l.some((s) => s.exitCode === 3))`, 8000)

  for (const [w, h] of [[1024, 700], [1440, 900]]) {
    win.setSize(w, h)
    await sleep(800)
    console.log(`\n=== ${w}×${h} ===`)
    await grid('quad')
    await audit(`${w} 四宫格`)
    await grid('dual')
    await audit(`${w} 双格`)
    await grid('single')
    await audit(`${w} 单格`)
    await grid('quad')
  }

  console.log('\n=== 会话栏折叠、右键菜单、命令面板 ===')
  await js(`document.querySelector('button[aria-label^="会话栏"]').click()`)
  await audit('会话栏折叠')
  await js(`document.querySelector('button[aria-label^="会话栏"]').click()`)
  await js(`(() => { const el = document.querySelector('[data-rail="sessions"] [data-workspace-id="w1"]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })); return true })()`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  await audit('工作区右键菜单')
  await esc()
  await js(`document.querySelector('[data-testid="palette-trigger"]').click()`)
  await waitFor(`!!document.querySelector('[data-testid="palette"]')`, 2000)
  await audit('命令面板')
  await esc()

  console.log('\n=== 设置页 ===')
  win.setSize(1024, 700)
  await sleep(600)
  await js(`document.querySelector('button[aria-label^="设置"]').click()`)
  await waitFor(`!!document.querySelector('[data-testid="settings-dialog"]')`, 2000)
  for (const tab of ['appearance', 'terminal', 'agents', 'startup', 'git', 'about']) {
    await js(`document.querySelector('[data-settings-tab="${tab}"]').click()`)
    await audit(`设置 · ${tab}`)
  }
  await esc()

  console.log('\n=== 工作区弹窗 ===')
  await js(`(() => { const el = document.querySelector('[data-rail="sessions"] [data-workspace-id="w0"]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })); return true })()`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === '编辑工作区').click()`)
  await waitFor(`!!document.querySelector('[data-testid="workspace-dialog"]')`, 2000)
  await js(`[...document.querySelectorAll('[data-testid="workspace-dialog"] button')].find((b) => b.textContent.includes('添加变量')).click()`)
  await audit('编辑工作区弹窗')
  // 元素级 button 样式若不分层，会压过 text-fault 这类工具类（踩坑记录）
  const colors = await js(`(() => {
    const btn = [...document.querySelectorAll('[data-testid="workspace-dialog"] button')].find((b) => (b.getAttribute('aria-label') || '').startsWith('删除变量'))
    const probe = document.createElement('span')
    probe.className = 'text-fault'
    document.body.appendChild(probe)
    const want = getComputedStyle(probe).color
    probe.remove()
    return { got: getComputedStyle(btn).color, want }
  })()`)
  check('按钮上的文字色工具类生效（危险按钮是 fault 色）', colors.got === colors.want, colors)
  await esc()

  console.log('\n=== 关闭确认框 ===')
  win.close()
  await waitFor(`!!document.querySelector('[data-testid="quit-dialog"]')`, 3000)
  await audit('关闭确认框')
  await js(`document.querySelector('[data-testid="quit-cancel"]').click()`)

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
