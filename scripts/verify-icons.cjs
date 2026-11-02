/**
 * 工作区自定义图标验收。
 *
 * 系统文件对话框没法在脚本里点，开发期用 MILE_WARP_TEST_ICON 让 workspace:pickIcon 直接读指定文件
 * （打包版不认这个变量）。其余全部走真实 IPC 与界面：
 *   - 预置图标显示、非法哈希迁移为 null
 *   - 选图 → token；编辑写盘、128×128、居中裁切；token 一次性；非法 token / id 被拒
 *   - 复制带图标、恢复默认删文件、删除工作区删文件、新建失败不留孤儿文件
 *   - 弹窗里「更换图片… / 恢复默认」、会话栏 / 命令面板 / 格头显示图片
 *
 *   npm run build
 *   npx electron scripts/verify-icons.cjs 2>&1 | Out-File $env:TEMP\warp-icons.log -Encoding utf8
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const { join } = require('node:path')
const { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'warp-icons-'))
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const TEST_IMG = join(SANDBOX, '测试图 300x200.png')
process.env.MILE_WARP_TEST_ICON = TEST_IMG

const DATA = join(SANDBOX, 'mile-warp')
const ICONS = join(DATA, 'icons')
mkdirSync(ICONS, { recursive: true })
const PRESEED = 'abcdef012345'
copyFileSync(join(ROOT, 'resources', 'icon.png'), join(ICONS, 'w0.png'))

const now = Date.now()
const specs = [
  ['w0', 'claude', '预置图标', PRESEED],
  ['w1', 'codex', '没有图标', null],
  ['w2', 'shell', '坏哈希', 'NOT-A-HASH']
]
const workspaces = specs.map(([id, agentId, name, icon], i) => {
  const cwd = join(SANDBOX, `目录${i}`)
  mkdirSync(cwd, { recursive: true })
  return { id, groupId: null, name, note: '', agentId, agentPath: null, cwd, args: [], envKeys: [], envEnc: null, icon, order: i, createdAt: now, updatedAt: now + i }
})
writeFileSync(
  join(DATA, 'config.json'),
  JSON.stringify({ version: 1, groups: [], workspaces, customAgents: [], settings: { closeAction: 'quit' }, sessionRecords: [] }),
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

/** 300×200：左右各 50px 红色，中间 200×200 蓝色。居中裁正方形后应当全是蓝色 */
function makeTestImage(file) {
  const w = 300
  const h = 200
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const blue = x >= 50 && x < 250
      // BGRA
      buf[o] = blue ? 255 : 0
      buf[o + 1] = 0
      buf[o + 2] = blue ? 0 : 255
      buf[o + 3] = 255
    }
  }
  writeFileSync(file, nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG())
}

/** 读 PNG 的尺寸与左上角像素（BGRA） */
function inspect(file) {
  const img = nativeImage.createFromPath(file)
  const { width, height } = img.getSize()
  const bmp = img.toBitmap()
  return { width, height, corner: [bmp[0], bmp[1], bmp[2]] }
}

const isHash = (s) => typeof s === 'string' && /^[0-9a-f]{12}$/.test(s)

app.whenReady().then(async () => {
  makeTestImage(TEST_IMG)
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const J = JSON.stringify
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const rejects = (code) => js(`(${code}).then(() => null, (e) => String(e && e.message || e))`)
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
  const cfg = () => js('window.warp.config.get()')
  const ws = async (id) => (await cfg()).workspaces.find((w) => w.id === id)
  const railImg = (id) => `!!document.querySelector('[data-rail="sessions"] [data-workspace-id="${id}"] img[data-workspace-icon]')`
  const openEdit = async (id) => {
    await js(`(() => { const el = document.querySelector('[data-rail="sessions"] [data-workspace-id="${id}"]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })); return true })()`)
    await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
    await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === '编辑工作区').click()`)
    return waitFor(`!!document.querySelector('[data-testid="workspace-dialog"]')`, 2000)
  }
  const save = async () => {
    await js(`document.querySelector('[data-testid="workspace-save"]').click()`)
    return waitFor(`!document.querySelector('[data-testid="workspace-dialog"]')`, 4000)
  }

  await waitFor(`!!document.querySelector('[data-rail="sessions"] [data-workspace-id]')`)

  console.log('\n=== 预置与迁移 ===')
  check('预置哈希保留', (await ws('w0')).icon === PRESEED)
  check('非法哈希迁移为 null', (await ws('w2')).icon === null)
  check('会话栏：有图标的显示图片', await waitFor(railImg('w0'), 4000))
  check('会话栏：没图标的显示 agent 徽章', !(await js(railImg('w1'))))
  check('workspace:icon 返回 data URL', String(await js(`window.warp.workspace.icon('w0')`)).startsWith('data:image/png;base64,'))
  check('workspace:icon 不存在的文件返回 null', (await js(`window.warp.workspace.icon('nope')`)) === null)
  check('workspace:icon 拒绝路径形式的 id', !!(await rejects(`window.warp.workspace.icon('../config')`)))

  console.log('\n=== 选图与写盘 ===')
  const picked = await js('window.warp.workspace.pickIcon()')
  check('pickIcon 返回 token 与预览', /^[0-9a-f-]{36}$/.test(picked?.token ?? '') && String(picked?.dataUrl).startsWith('data:image/png;base64,'))
  check('选图后还没写盘', !existsSync(join(ICONS, 'w1.png')))
  await js(`window.warp.workspace.edit('w1', { iconToken: ${J(picked.token)} })`)
  const h1 = (await ws('w1')).icon
  check('编辑带 token：写入哈希', isHash(h1), h1)
  check('图标文件落盘', existsSync(join(ICONS, 'w1.png')))
  const info = inspect(join(ICONS, 'w1.png'))
  check('缩放到 128×128', info.width === 128 && info.height === 128, info)
  // BGRA：蓝色 = [255, 0, 0]；若没有居中裁切，左上角会是红色
  check('居中裁切（左上角是中间的蓝色而不是两侧的红色）', info.corner[0] > 200 && info.corner[2] < 50, info.corner)
  check('token 一次性：再用一次被拒', !!(await rejects(`window.warp.workspace.edit('w1', { iconToken: ${J(picked.token)} })`)))
  check('非法 token 被拒', !!(await rejects(`window.warp.workspace.edit('w1', { iconToken: 'not-a-token' })`)))
  check('非字符串 token 被拒', !!(await rejects(`window.warp.workspace.edit('w1', { iconToken: 42 })`)))
  check('被拒后哈希不变', (await ws('w1')).icon === h1)

  console.log('\n=== 复制、恢复默认、删除、新建 ===')
  await js(`window.warp.workspace.duplicate('w1')`)
  const dup = (await cfg()).workspaces.find((w) => w.name === '没有图标 副本')
  check('复制：带上同一哈希', dup?.icon === h1, dup?.icon)
  check('复制：图标文件一起复制', !!dup && existsSync(join(ICONS, `${dup.id}.png`)))
  await js(`window.warp.workspace.remove(${J(dup.id)})`)
  check('删除工作区：图标文件删掉', !existsSync(join(ICONS, `${dup.id}.png`)))
  await js(`window.warp.workspace.edit('w1', { iconToken: null })`)
  check('恢复默认：哈希清空', (await ws('w1')).icon === null)
  check('恢复默认：文件删掉', !existsSync(join(ICONS, 'w1.png')))

  const before = readdirSync(ICONS).length
  const t2 = (await js('window.warp.workspace.pickIcon()')).token
  const bad = await rejects(`window.warp.workspace.create({ name: '失败', agentId: 'claude', cwd: ${J(join(SANDBOX, '目录0'))}, argsText: '', note: '', groupId: 'missing-group', iconToken: ${J(t2)} })`)
  check('新建失败（分组不存在）', !!bad, bad)
  check('新建失败不留孤儿图标文件', readdirSync(ICONS).length === before, readdirSync(ICONS))
  const t3 = (await js('window.warp.workspace.pickIcon()')).token
  await js(`window.warp.workspace.create({ name: '新建带图标', agentId: 'claude', cwd: ${J(join(SANDBOX, '目录0'))}, argsText: '', note: '', groupId: null, iconToken: ${J(t3)} })`)
  const created = (await cfg()).workspaces.find((w) => w.name === '新建带图标')
  check('新建带图标：哈希与文件', isHash(created?.icon) && existsSync(join(ICONS, `${created.id}.png`)))

  console.log('\n=== 配置写失败时回滚 ===')
  // config.json 设成只读：atomicWrite 的 rename 会失败，此时图标文件已经写过，必须还原
  const CONFIG = join(DATA, 'config.json')
  const t4 = (await js('window.warp.workspace.pickIcon()')).token
  chmodSync(CONFIG, 0o444)
  const editFail = await rejects(`window.warp.workspace.edit('w1', { iconToken: ${J(t4)} })`)
  chmodSync(CONFIG, 0o666)
  check('编辑：配置写失败被拒', !!editFail, editFail)
  check('编辑失败：图标文件还原（原本没有就删掉）', !existsSync(join(ICONS, 'w1.png')))
  check('编辑失败：哈希不变', (await ws('w1')).icon === null)
  await js(`window.warp.workspace.edit('w1', { iconToken: ${J(t4)} })`)
  check('编辑失败后 token 仍可用', isHash((await ws('w1')).icon) && existsSync(join(ICONS, 'w1.png')))
  await js(`window.warp.workspace.edit('w1', { iconToken: null })`)

  const beforeDup = readdirSync(ICONS).length
  chmodSync(CONFIG, 0o444)
  const dupFail = await rejects(`window.warp.workspace.duplicate(${J(created.id)})`)
  chmodSync(CONFIG, 0o666)
  check('复制：配置写失败被拒', !!dupFail, dupFail)
  check('复制失败不留孤儿图标文件', readdirSync(ICONS).length === beforeDup, readdirSync(ICONS))

  console.log('\n=== 编辑弹窗 ===')
  check('打开 w1 编辑弹窗', await openEdit('w1'))
  check('默认：预览是 agent 固定图标、没有「恢复默认」', await js(`!document.querySelector('[data-testid="icon-preview"] img[alt="图标预览"]') && !!document.querySelector('[data-testid="icon-preview"] [data-agent-icon]') && !document.querySelector('[data-testid="icon-reset"]')`))
  await js(`document.querySelector('[data-testid="icon-pick"]').click()`)
  check('更换图片…：预览变成图片', await waitFor(`!!document.querySelector('[data-testid="icon-preview"] img[alt="图标预览"]')`, 4000))
  check('更换后出现「恢复默认」', await js(`!!document.querySelector('[data-testid="icon-reset"]')`))
  check('保存前不写盘', !existsSync(join(ICONS, 'w1.png')))
  check('保存关闭弹窗', await save())
  check('保存后写入哈希与文件', isHash((await ws('w1')).icon) && existsSync(join(ICONS, 'w1.png')))
  // 上面直接调 IPC 的改动不经过渲染层 store；经弹窗保存的才会立刻反映到界面
  check('保存后会话栏显示图片', await waitFor(railImg('w1'), 4000))
  check('打开 w0 编辑弹窗', await openEdit('w0'))
  check('已有图标：预览显示当前图片', await waitFor(`!!document.querySelector('[data-testid="icon-preview"] img[alt="图标预览"]')`, 4000))
  await js(`document.querySelector('[data-testid="icon-reset"]').click()`)
  check('恢复默认：预览退回 agent 固定图标', await waitFor(`!document.querySelector('[data-testid="icon-preview"] img[alt="图标预览"]') && !!document.querySelector('[data-testid="icon-preview"] [data-agent-icon]')`, 2000))
  check('保存关闭弹窗', await save())
  check('保存后 w0 哈希清空、文件删掉', (await ws('w0')).icon === null && !existsSync(join(ICONS, 'w0.png')))
  check('恢复默认后会话栏退回徽章', await waitFor(`!(${railImg('w0')})`, 4000))

  console.log('\n=== 命令面板与格头 ===')
  await js(`document.querySelector('[data-testid="palette-trigger"]').click()`)
  await waitFor(`!!document.querySelector('[data-testid="palette"]')`, 2000)
  check('命令面板：有图标的工作区显示图片', await waitFor(`!!document.querySelector('[data-kind="workspace"][data-item-id="w1"] img[data-workspace-icon]')`, 3000))
  check('命令面板：没图标的显示 agent 固定图标', await js(`!document.querySelector('[data-kind="workspace"][data-item-id="w0"] img[data-workspace-icon]') && !!document.querySelector('[data-kind="workspace"][data-item-id="w0"] [data-agent-icon]')`))
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await js(`document.querySelector('[data-rail="sessions"] [data-workspace-id="w1"]').click()`)
  check('格头：agent 会话显示工作区图片', await waitFor(`!!document.querySelector('section[data-cell] [data-cell-head] img[data-workspace-icon]')`, 15000))

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
