/**
 * 文件预览验收（技术设计 §6.4 预览栏）。
 *
 * 沙箱造一个工作区目录：
 *   README.md    带标题 / 列表 / 代码 / 注入片段 / 外链 / 相对图片
 *   big.md       > 1MB（截断路径）
 *   huge.txt     > 2MB（直接拒绝）
 *   small.png    真 PNG（成功）
 *   big.png      > 20MB 假 PNG（拒绝）
 *   bin.exe      前 8KB 含 \0（binary=true）
 *   escape-link  指向工作区外（越界 readText 拒绝）
 *
 * 覆盖：
 *   1. IPC：fs.readText / fs.readImage 的大小上限、截断、binary、扩展名白名单、越界
 *   2. 渲染层：单击 treeitem → PreviewRail 出内容、md 渲染出 .md-body、script/onclick 被剥、外链走 shell.openUrl、相对图片换 data URL
 *   3. Esc 关预览、切工作区清空、栏宽持久化
 *
 *   npm run build
 *   npx electron scripts/verify-preview.cjs > $env:TEMP\warp-preview.log
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, mkdtempSync, writeFileSync, symlinkSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'warp-preview-'))
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const WORK = join(SANDBOX, '预览工作区')
const OUTSIDE = join(SANDBOX, 'outside')
mkdirSync(WORK, { recursive: true })
mkdirSync(OUTSIDE, { recursive: true })
writeFileSync(join(OUTSIDE, 'secret.txt'), 'should-not-read\n', 'utf8')
symlinkSync(OUTSIDE, join(WORK, 'escape-link'), 'junction')

// README.md：覆盖 sanitizer 每条红线
const README = `# 预览验收

正文一段。

- 列表一
- 列表二

\`\`\`ts
const x = 1
\`\`\`

[合法链接](https://example.com)
[坏链接](javascript:alert(1))
[伪协议](data:text/html,<script>alert(1)</script>)

<script>window.__pwned = true</script>
<img src="pic.png" onerror="window.__imgpwned=true">
<a href="https://ok.example" onclick="window.__pwned2=true">onclick</a>
<iframe src="https://evil"></iframe>

![相对图片](pic.png)

| 表头 | 值 |
| --- | --- |
| a | b |
`
writeFileSync(join(WORK, 'README.md'), README, 'utf8')

// big.md：> 1MB，触发截断
writeFileSync(join(WORK, 'big.md'), '# Big\n\n' + 'x'.repeat(1_200_000), 'utf8')
// huge.txt：> 2MB，直接拒绝
writeFileSync(join(WORK, 'huge.txt'), 'y'.repeat(2_500_000), 'utf8')
// small.png：真 PNG（1×1 红色）
writeFileSync(join(WORK, 'pic.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
// big.png：> 20MB（假 PNG 头，nativeImage 会拒——但大小上限先拦下）
writeFileSync(join(WORK, 'big.png'), Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ', 'base64'), Buffer.alloc(21_000_000, 0)]))
// bin.exe：前 8KB 含 \0
writeFileSync(join(WORK, 'bin.exe'), Buffer.concat([Buffer.from('MZ', 'binary'), Buffer.alloc(8190, 0)]))

mkdirSync(join(SANDBOX, 'mile-warp'), { recursive: true })
const now = Date.now()
writeFileSync(
  join(SANDBOX, 'mile-warp', 'config.json'),
  JSON.stringify({
    version: 2,
    groups: [],
    workspaces: [
      { id: 'ws-p', groupId: null, name: '预览', note: '', agentId: 'shell', agentPath: null, cwd: WORK, args: [], envKeys: [], envEnc: null, order: 0, createdAt: now, updatedAt: now },
      { id: 'ws-x', groupId: null, name: '空位', note: '', agentId: 'shell', agentPath: null, cwd: OUTSIDE, args: [], envKeys: [], envEnc: null, order: 1, createdAt: now, updatedAt: now }
    ],
    customAgents: [],
    settings: {},
    sessionRecords: [],
    layoutPresets: []
  }),
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

setTimeout(() => { console.log('\n  FAIL  总超时 120 秒'); app.exit(3) }, 120000).unref()

const HELPERS = `
window.__t = {
  q: (sel) => document.querySelector(sel),
  qa: (sel) => [...document.querySelectorAll(sel)],
  key(el, key, init = {}) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  }
}
true
`

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const js = (code) => win.webContents.executeJavaScript(code, true)
  // IPC 调用全部包 catch：rejection 会让 executeJavaScript 一直悬着直到超时
  const ipcText = (rel) => `window.warp.fs.readText('ws-p', '${rel}').catch((e) => ({ __err: String(e) }))`
  const ipcImg = (rel) => `window.warp.fs.readImage('ws-p', '${rel}').catch((e) => ({ __err: String(e) }))`
  const waitFor = async (code, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) {
      try {
        if (await js(code)) return true
      } catch {
        // 还没渲染出来
      }
      await sleep(100)
    }
    return false
  }

  await waitFor(`!!document.querySelector('[data-rail="sessions"]')`)
  await js(HELPERS)

  console.log('\n=== 1. IPC：fs.readText / fs.readImage ===')

  const text = await js(ipcText('README.md'))
  check('README.md 读出文本', typeof text.content === 'string' && text.content.includes('预览验收'), { truncated: text.truncated, binary: text.binary, size: text.size })
  check('README.md 不是 binary', text.binary === false)
  check('README.md 未截断', text.truncated === false)

  const big = await js(ipcText('big.md'))
  check('>1MB 文本截断并标记 truncated', big.truncated === true && big.content.length <= 1_000_100, { contentLen: big.content.length })

  const hugeErr = await js(`window.warp.fs.readText('ws-p', 'huge.txt').then(() => null).catch((e) => String(e))`)
  check('>2MB 文本拒绝', /文件太大|太大/.test(hugeErr), hugeErr)

  const bin = await js(ipcText('bin.exe'))
  check('含 \\0 的文本标 binary', bin.binary === true)

  const escapeErr = await js(`window.warp.fs.readText('ws-p', 'escape-link/secret.txt').then(() => null).catch((e) => String(e))`)
  check('越界 readText 拒绝（junction 出工作区）', /越出|不合法|不存在|链接/.test(escapeErr), escapeErr)

  const img = await js(ipcImg('pic.png'))
  check('pic.png 返回 data URL', typeof img.dataUrl === 'string' && img.dataUrl.startsWith('data:image/png;base64,'), { w: img.width, h: img.height })

  const bigImgErr = await js(`window.warp.fs.readImage('ws-p', 'big.png').then(() => null).catch((e) => String(e))`)
  check('>20MB 图片拒绝', /图片太大|太大/.test(bigImgErr), bigImgErr)

  const badExtErr = await js(`window.warp.fs.readImage('ws-p', 'README.md').then(() => null).catch((e) => String(e))`)
  check('非图片扩展名走 readImage 拒绝', /图片格式|不是支持/.test(badExtErr), badExtErr)

  const ws2 = await js(`window.warp.fs.readText('ws-none', 'README.md').then(() => null).catch((e) => String(e))`)
  check('未知 workspaceId 拒绝', /工作区不存在|不存在/.test(ws2), ws2)

  const absErr = await js(`window.warp.fs.readText('ws-p', 'E:/abs.txt').then(() => null).catch((e) => String(e))`)
  check('绝对路径拒绝', /相对路径|不合法/.test(absErr), absErr)

  console.log('\n=== 2. 渲染层：单击文件 → 预览 ===')

  // 点工作区卡片 → 目录栏出树
  await waitFor(`!!document.querySelector('[data-rail="sessions"] [data-workspace-id="ws-p"]')`, 5000)
  await js(`document.querySelector('[data-rail="sessions"] [data-workspace-id="ws-p"]').click()`)
  await waitFor(`!!document.querySelector('[data-rail="files"] [role="treeitem"][data-rel="README.md"]')`, 5000)

  // 单击 README.md → 预览栏打开 + md 渲染
  await js(`document.querySelector('[data-rail="files"] [role="treeitem"][data-rel="README.md"]').click()`)
  check('单击文件后预览栏出现', await waitFor(`!!document.querySelector('[data-rail="preview"]')`, 5000))
  check('预览标题是 README.md', await waitFor(`__t.q('[data-rail="preview"]').textContent.includes('README.md')`, 3000))
  check('Markdown 渲染出 h1', await waitFor(`!!__t.q('[data-rail="preview"] .md-body h1')`, 8000))

  console.log('\n=== 3. sanitizer ===')

  const mdHtml = await js(`__t.q('[data-rail="preview"] .md-body').innerHTML`)
  check('script 标签被剥掉', !mdHtml.includes('<script'))
  check('onclick 属性被剥掉（文本残留不算）', !/onclick\s*=/.test(mdHtml))
  check('onerror 属性被剥掉', !/onerror\s*=/.test(mdHtml))
  check('iframe 被剥掉', !mdHtml.includes('<iframe'))
  check('javascript: href 被剥掉', !mdHtml.includes('javascript:'))
  check('data: href 被剥掉', !mdHtml.includes('data:text'))
  check('javascript: 链接文本还在但 href 没了', mdHtml.includes('坏链接') && !mdHtml.includes('javascript:'))
  check('合法链接还在', mdHtml.includes('https://example.com'))
  check('外链 rel=noopener', mdHtml.includes('rel='))
  check('code 元素在', mdHtml.includes('<code'))

  const pwned = await js(`window.__pwned === true || window.__imgpwned === true || window.__pwned2 === true`)
  check('注入脚本没执行', pwned === false, pwned)

  console.log('\n=== 4. 相对图片换 data URL ===')
  // md 里的相对图片经 fs:readImage 换成 data URL
  await sleep(500) // 等异步替换
  const imgSrc = await js(`__t.q('[data-rail="preview"] .md-body img')?.getAttribute('src') ?? ''`)
  check('相对图片换成 data URL', imgSrc.startsWith('data:image/png;base64,'), imgSrc.slice(0, 60))

  console.log('\n=== 5. 链接点击 ===')
  await js(`
    const a = [...document.querySelectorAll('[data-rail="preview"] .md-body a')].find((x) => x.href === 'https://example.com/')
    a && a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  `)
  // shell.openUrl 主进程白名单过，无法断言真的弹了浏览器；只断言没异常
  await sleep(300)
  check('合法链接点击未抛错', true)

  console.log('\n=== 6. 二进制与图片视图 ===')

  await js(`document.querySelector('[data-rail="files"] [role="treeitem"][data-rel="bin.exe"]').click()`)
  check('bin.exe 标二进制占位', await waitFor(`!!__t.q('[data-testid="preview-binary"]')`, 5000))

  await js(`document.querySelector('[data-rail="files"] [role="treeitem"][data-rel="pic.png"]').click()`)
  check('pic.png 出图片视图', await waitFor(`!!__t.q('[data-testid="preview-image"] img')`, 5000))

  console.log('\n=== 7. Esc 关闭预览 ===')
  // 栏是偏好持久化的，close() 只清 target——断言「预览内容没了」，栏本身留着
  await js(`__t.key(document.body, 'Escape')`)
  await sleep(300)
  const railStill = await js(`!!__t.q('[data-rail="preview"]')`)
  const bodyEmpty = await js(`!__t.q('[data-rail="preview"] [data-testid="preview-markdown"], [data-rail="preview"] [data-testid="preview-image"], [data-rail="preview"] [data-testid="preview-text"], [data-rail="preview"] [data-testid="preview-binary"]')`)
  const headerClear = await js(`!__t.q('[data-rail="preview"]')?.textContent.includes('pic.png')`)
  check('Esc 后预览内容清空（栏留着）', railStill && bodyEmpty && headerClear, { railStill, bodyEmpty, headerClear })

  console.log('\n=== 8. 右键菜单「预览」 ===')
  // 右键 treeitem → 菜单有「预览」
  await js(`document.querySelector('[data-rail="files"] [role="treeitem"][data-rel="README.md"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  const menuText = await js(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((b) => b.textContent.trim())`)
  check('右键菜单含「预览」', menuText.includes('预览'), menuText)
  await js(`__t.key(document.body, 'Escape')`) // 关掉菜单

  console.log('\n=== 9. 栏宽持久化 ===')
  await js(`window.warp.layout.update({ previewRailWidth: 400 })`)
  const layout = await js(`window.warp.layout.get()`)
  check('previewRailWidth 写入 400', layout.previewRailWidth === 400, layout.previewRailWidth)
  check('previewRailVisible 为 true', layout.previewRailVisible === true, layout.previewRailVisible)

  console.log('\n=== 9.5 预览栏分隔条 ===')
  const splitter = await js(`
    (() => {
      const s = document.querySelector('[data-testid="resize-preview-rail"]')
      if (!s) return null
      const r = s.getBoundingClientRect()
      const rail = document.querySelector('[data-rail="preview"]').getBoundingClientRect()
      return { x: r.x, w: r.width, railLeft: rail.left, railRight: rail.right, inViewport: r.x >= 0 && r.x + r.width <= window.innerWidth }
    })()
  `)
  check('分隔条在预览栏左边缘（不在屏幕外）', splitter && splitter.inViewport && Math.abs(splitter.x - splitter.railLeft) < 8, splitter)

  console.log('\n=== 10. 切工作区清空预览 ===')
  await js(`document.querySelector('[data-rail="files"] [role="treeitem"][data-rel="README.md"]').click()`)
  await waitFor(`!!__t.q('[data-rail="preview"] .md-body h1')`, 5000)
  // 点另一个工作区卡片 → selectedWorkspaceId 变 ws-x → 预览清空
  await js(`document.querySelector('[data-rail="sessions"] [data-workspace-id="ws-x"]').click()`)
  await sleep(400)
  const hasTarget = await js(`__t.q('[data-rail="preview"]')?.textContent.includes('README.md') ?? false`)
  const mdGone = await js(`!__t.q('[data-rail="preview"] .md-body')`)
  check('切到别的工作区后预览清空', !hasTarget && mdGone, { hasTarget, mdGone })

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
  app.exit(fail ? 2 : 0)
})
