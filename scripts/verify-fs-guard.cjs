/**
 * M2 验收：目录栏路径越界防护（技术设计 §10 verify-fs-guard，PRD D-07）。
 *
 * 沙箱里建一个工作区目录与一个「工作区外」的目录，工作区里放两个联接点：
 *   inner-link  → 工作区内的子目录（允许展开）
 *   escape-link → 工作区外的目录（列出但标 link，不允许展开、不允许经它读取）
 * 然后从渲染层直接调 window.warp.fs.listDir / reveal，覆盖 ..、绝对路径、盘符相对路径、UNC、
 * 空字节、超长路径、未知工作区等入参，全部应被主进程拒绝。
 * reveal 只测拒绝路径，不测成功路径（成功会真的弹出资源管理器）。
 *
 *   npm run build
 *   npx electron scripts/verify-fs-guard.cjs > $env:TEMP\warp-fs-guard.log
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'warp-fsguard-'))
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const WORK = join(SANDBOX, '工作区 甲')
const OUTSIDE = join(SANDBOX, 'outside')
mkdirSync(join(WORK, 'inner', 'deep'), { recursive: true })
writeFileSync(join(WORK, 'inner', 'file.txt'), 'hi', 'utf8')
mkdirSync(OUTSIDE, { recursive: true })
writeFileSync(join(OUTSIDE, 'secret.txt'), 'secret', 'utf8')
// junction 不需要管理员权限
symlinkSync(join(WORK, 'inner'), join(WORK, 'inner-link'), 'junction')
symlinkSync(OUTSIDE, join(WORK, 'escape-link'), 'junction')

mkdirSync(join(SANDBOX, 'mile-warp'), { recursive: true })
const now = Date.now()
writeFileSync(
  join(SANDBOX, 'mile-warp', 'config.json'),
  JSON.stringify({
    version: 1,
    groups: [],
    workspaces: [
      { id: 'ws-a', groupId: null, name: '甲', note: '', agentId: 'shell', agentPath: null, cwd: WORK, args: [], envKeys: [], envEnc: null, order: 0, createdAt: now, updatedAt: now }
    ],
    customAgents: [],
    settings: {},
    sessionRecords: []
  }),
  'utf8'
)

require(join(ROOT, 'out', 'main', 'index.js'))

let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

setTimeout(() => { console.log('\n  FAIL  总超时 60 秒'); app.exit(3) }, 60000).unref()

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const js = (code) => win.webContents.executeJavaScript(code, true)
  /** 返回 'ok:<json>' 或 'rejected:<原因>' */
  const call = (expr) =>
    js(`(${expr}).then((v) => 'ok:' + JSON.stringify(v), (e) => 'rejected:' + String(e && e.message || e))`)
  const list = (rel, ws = 'ws-a') => call(`window.warp.fs.listDir(${JSON.stringify(ws)}, ${JSON.stringify(rel)})`)
  const entries = (r) => (r.startsWith('ok:') ? JSON.parse(r.slice(3)) : null)

  console.log('\n=== 1. 合法路径 ===')
  const root = entries(await list(''))
  const names = root && root.map((e) => e.name)
  check('根目录可列出', Boolean(root), names)
  const esc = root && root.find((e) => e.name === 'escape-link')
  const inl = root && root.find((e) => e.name === 'inner-link')
  check('指向工作区外的联接点标 link=true', Boolean(esc && esc.link), esc)
  check('指向工作区内的联接点 link=false', Boolean(inl && !inl.link), inl)
  check('目录排在文件前', Boolean(root && root.findIndex((e) => e.kind === 'file') === -1 || root.every((e, i, a) => i === 0 || !(a[i - 1].kind === 'file' && e.kind === 'dir'))))
  const inner = entries(await list('inner'))
  check('子目录可列出', Boolean(inner && inner.some((e) => e.name === 'file.txt') && inner.some((e) => e.name === 'deep')), inner && inner.map((e) => e.name))
  check('反斜杠分隔的相对路径可列出', Boolean(entries(await list('inner\\deep'))))
  check('经工作区内联接点可列出', Boolean(entries(await list('inner-link'))))
  check('inner/./deep 规范化后仍在内', Boolean(entries(await list('inner/./deep'))))
  check('inner/../inner 规范化后仍在内', Boolean(entries(await list('inner/../inner'))))

  console.log('\n=== 2. 越界与非法入参一律拒绝 ===')
  const bad = [
    ['..', '父目录'],
    ['..\\..', '..\\..'],
    ['../outside', '../outside'],
    ['inner/../../outside', 'inner/../../outside'],
    ['escape-link', '经工作区外联接点'],
    ['escape-link/secret.txt', '经联接点读工作区外文件'],
    [WORK, '绝对路径（工作区本身）'],
    [OUTSIDE, '绝对路径（工作区外）'],
    ['C:\\Windows', '盘符绝对路径'],
    ['C:Windows', '盘符相对路径'],
    ['/Windows', '根相对路径'],
    ['\\\\localhost\\c$', 'UNC 路径'],
    ['inner\u0000x', '空字节'],
    ['a/'.repeat(600), '超长路径'],
    ['inner/file.txt', '文件不是目录']
  ]
  for (const [rel, label] of bad) {
    const r = await list(rel)
    check(`拒绝：${label}`, r.startsWith('rejected'), r.slice(0, 80))
  }
  check('拒绝：未知工作区', (await list('', 'nope')).startsWith('rejected'))
  check('拒绝：workspaceId 不是字符串', (await call(`window.warp.fs.listDir(123, '')`)).startsWith('rejected'))
  check('拒绝：relativePath 不是字符串时按根处理而不报越界', (await call(`window.warp.fs.listDir('ws-a', null)`)).startsWith('ok'))

  console.log('\n=== 3. reveal 同样受限（只测拒绝） ===')
  for (const [rel, label] of [['..', '父目录'], [OUTSIDE, '绝对路径'], ['escape-link/secret.txt', '经联接点']]) {
    const r = await call(`window.warp.fs.reveal('ws-a', ${JSON.stringify(rel)})`)
    check(`reveal 拒绝：${label}`, r.startsWith('rejected'), r.slice(0, 80))
  }
  check('shell.openPath 未知工作区拒绝', (await call(`window.warp.shell.openPath('nope')`)).startsWith('rejected'))
  check('git.branch 未知工作区拒绝', (await call(`window.warp.git.branch('nope')`)).startsWith('rejected'))

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
