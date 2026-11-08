/**
 * M2 验收：会话栏与持久化（技术设计 §11 M2）。
 *
 * 启动前在沙箱 appData 里放一份「坏掉的 config.json + 完好的 .bak」，验证 .bak 恢复；
 * 之后全部通过渲染层真实 DOM 事件驱动（click / dblclick / contextmenu / 合成 DragEvent / sendInputEvent）：
 *   1. .bak 恢复与 .corrupt 另存
 *   2. 渲染：分组标签、分支（读 .git/HEAD）、非 git 显示备注、空分组提示
 *   3. 分组：新建（+ 菜单 → 对话框）、行内改名、折叠持久化
 *   4. 筛选：按备注命中、无命中提示
 *   5. 拖拽：组内排序、拖进分组、拖到「未分组」、分组排序
 *   6. 右键菜单：复制工作区；编辑弹窗改名 + 环境变量（加密落盘、会话里可读）
 *   7. 多会话：会话数胶囊、子行、双击改名
 *   8. 删除非空分组（取消 / 确认）、删除运行中的工作区
 *   9. 目录栏：根目录、懒加载、空目录、灰化、刷新
 *  10. 快捷键：焦点在终端里 Ctrl+Shift+B / E 仍生效；栏宽 200 / 56 / 240
 *
 *   npm run build
 *   npx electron scripts/verify-m2-rail.cjs > $env:TEMP\warp-m2.log
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'warp-m2-'))
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

// 工作区 A：假 git 仓库（只要 .git/HEAD），带几层目录
const WORK_A = join(SANDBOX, '前端 A')
mkdirSync(join(WORK_A, '.git'), { recursive: true })
writeFileSync(join(WORK_A, '.git', 'HEAD'), 'ref: refs/heads/feature/m2\n', 'utf8')
mkdirSync(join(WORK_A, 'src', 'util'), { recursive: true })
mkdirSync(join(WORK_A, 'node_modules', 'x'), { recursive: true })
mkdirSync(join(WORK_A, 'empty'), { recursive: true })
writeFileSync(join(WORK_A, 'src', 'index.ts'), 'export {}\n', 'utf8')
writeFileSync(join(WORK_A, 'README.md'), '# A\n', 'utf8')
// 工作区 B / C：非 git 目录
const WORK_B = join(SANDBOX, '后端 B')
mkdirSync(WORK_B, { recursive: true })

const CFG_DIR = join(SANDBOX, 'mile-warp')
const CFG = join(CFG_DIR, 'config.json')
mkdirSync(CFG_DIR, { recursive: true })
const now = Date.now()
const ws = (id, groupId, name, cwd, order, note = '') => ({
  id, groupId, name, note, agentId: 'shell', agentPath: null, cwd, args: [], envKeys: [], envEnc: null, order, createdAt: now + order, updatedAt: now
})
const good = {
  version: 1,
  groups: [
    { id: 'g1', name: '前端', color: null, collapsed: false, order: 0 },
    { id: 'g2', name: '后端', color: null, collapsed: false, order: 1 }
  ],
  workspaces: [ws('wsA', 'g1', '客户端', WORK_A, 0), ws('wsB', 'g1', '订单服务', WORK_B, 1, '备注B'), ws('wsC', null, '杂项', WORK_B, 0)],
  customAgents: [],
  settings: {},
  sessionRecords: []
}
writeFileSync(`${CFG}.bak`, JSON.stringify(good, null, 2), 'utf8')
writeFileSync(CFG, '{ "version": 1, "groups": [ 坏掉的', 'utf8')

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
const disk = () => JSON.parse(readFileSync(CFG, 'utf8'))

setTimeout(() => { console.log('\n  FAIL  总超时 180 秒'); app.exit(3) }, 180000).unref()

/** 注入页面的小工具：React 受控输入要走原生 setter + input 事件；拖拽用合成 DragEvent */
const HELPERS = `
window.__t = {
  q: (sel) => document.querySelector(sel),
  qa: (sel) => [...document.querySelectorAll(sel)],
  setVal(el, v) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  },
  key(el, key) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  },
  ctx(el) {
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }))
  },
  dbl(el) {
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  },
  menuItems: () => [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((b) => b.textContent.trim()),
  clickMenu(label) {
    const b = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((x) => x.textContent.trim() === label)
    if (!b) throw new Error('菜单项不存在：' + label)
    b.click()
  },
  point(el, where) {
    const r = el.getBoundingClientRect()
    const y = where === 'before' ? r.top + 3 : where === 'after' ? r.bottom - 3 : r.top + r.height / 2
    return { clientX: r.left + 30, clientY: y }
  },
  dragStart(sel) {
    window.__dt = new DataTransfer()
    document.querySelector(sel).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
  },
  dragOver(sel, where) {
    const el = document.querySelector(sel)
    const p = this.point(el, where)
    el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: window.__dt, ...p }))
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt, ...p }))
  },
  drop(sel, where, srcSel) {
    const el = document.querySelector(sel)
    const p = this.point(el, where)
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, ...p }))
    const src = document.querySelector(srcSel)
    if (src) src.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))
  },
  /** 某个分组段里卡片的顺序 */
  cards: (gid) => [...document.querySelectorAll('[data-group-section="' + gid + '"] [data-workspace-id]')].map((e) => e.dataset.workspaceId)
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
  const cfg = () => js('window.warp.config.get()')
  const order = async (gid) =>
    (await cfg()).workspaces.filter((w) => w.groupId === gid).sort((a, b) => a.order - b.order).map((w) => w.id)
  const card = (id) => `[data-rail="sessions"] [data-workspace-id="${id}"]`
  const label = (gid) => `[data-group-label="${gid}"]`
  const drag = async (src, dst, where) => {
    await js(`__t.dragStart(${J(src)})`)
    await sleep(50)
    await js(`__t.dragOver(${J(dst)}, ${J(where)})`)
    await sleep(100)
    await js(`__t.drop(${J(dst)}, ${J(where)}, ${J(src)})`)
    await sleep(400)
  }
  const openCtx = async (sel) => {
    await js(`__t.ctx(__t.q(${J(sel)}))`)
    await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  }
  const termText = (id) => js(`window.__warpDebug.text(${J(id)})`)

  await waitFor(`!!document.querySelector('[data-rail="sessions"]')`)
  await js(HELPERS)

  console.log('\n=== 1. .bak 恢复 ===')
  const c0 = await cfg()
  check('从 .bak 恢复出 2 个分组、3 个工作区', c0.groups.length === 2 && c0.workspaces.length === 3, { groups: c0.groups.length, workspaces: c0.workspaces.length })
  check('坏文件另存为 config.json.corrupt', existsSync(`${CFG}.corrupt`) && readFileSync(`${CFG}.corrupt`, 'utf8').includes('坏掉的'))
  let parsed = null
  try { parsed = disk() } catch {}
  check('config.json 已重写为合法 JSON', Boolean(parsed && parsed.workspaces.length === 3))

  console.log('\n=== 2. 渲染 ===')
  await waitFor(`!!__t.q(${J(card('wsA'))})`)
  check('分组标签：前端 / 后端 / 未分组', await js(`['g1','g2','none'].every((g) => !!__t.q('[data-group-label="' + g + '"]'))`))
  check('分组按 order 排列，未分组在最后', J(await js(`__t.qa('[data-group-section]').map((e) => e.dataset.groupSection)`)) === J(['g1', 'g2', 'none']))
  const branchOk = await waitFor(`__t.q(${J(card('wsA') + ' [data-branch]')}).dataset.branch === 'feature/m2'`)
  check('git 目录显示分支（读 .git/HEAD）', branchOk, await js(`__t.q(${J(card('wsA') + ' [data-branch]')}).textContent`))
  check('非 git 目录显示备注', await js(`__t.q(${J(card('wsB') + ' [data-branch]')}).textContent === '备注B'`))
  check('非 git 且无备注显示目录末段', await js(`__t.q(${J(card('wsC') + ' [data-branch]')}).textContent === '后端 B'`))
  check('空分组有提示', await js(`__t.q('[data-group-section="g2"]').textContent.includes('空分组')`))
  const w0 = await js(`Math.round(__t.q('[data-rail="sessions"]').getBoundingClientRect().width)`)
  check('会话栏宽 200px', w0 === 200, w0)
  check('未选工作区时目录栏给出提示', await js(`__t.q('[data-rail="files"]').textContent.includes('选择一个工作区')`))

  console.log('\n=== 3. 分组：新建 / 改名 / 折叠 ===')
  await js(`__t.q('[data-rail="sessions"] button[aria-label="新建"]').click()`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  check('+ 菜单有新建工作区 / 新建分组', J(await js('__t.menuItems()')) === J(['新建工作区', '新建分组']))
  await js(`__t.clickMenu('新建分组')`)
  await waitFor(`!!__t.q('[data-testid="prompt-input"]')`, 2000)
  await js(`__t.setVal(__t.q('[data-testid="prompt-input"]'), '测试组')`)
  await js(`__t.q('[role="dialog"] button[type="submit"]').click()`)
  check('新建分组落盘', await waitFor(`window.warp.config.get().then((c) => c.groups.some((g) => g.name === '测试组'))`))
  check('新分组标签出现', await waitFor(`__t.qa('[data-group-label]').some((e) => e.textContent.includes('测试组'))`))

  await js(`__t.dbl(__t.q('[data-group-label="g2"] button[aria-expanded]'))`)
  await waitFor(`!!__t.q('[data-testid="inline-edit"]')`, 2000)
  await js(`__t.setVal(__t.q('[data-testid="inline-edit"]'), '服务端'); __t.key(__t.q('[data-testid="inline-edit"]'), 'Enter')`)
  check('双击行内改名', await waitFor(`window.warp.config.get().then((c) => c.groups.find((g) => g.id === 'g2').name === '服务端')`))
  await js(`__t.dbl(__t.q('[data-group-label="g2"] button[aria-expanded]'))`)
  await waitFor(`!!__t.q('[data-testid="inline-edit"]')`, 2000)
  await js(`__t.setVal(__t.q('[data-testid="inline-edit"]'), '不该保存'); __t.key(__t.q('[data-testid="inline-edit"]'), 'Escape')`)
  await sleep(300)
  check('Esc 取消改名', (await cfg()).groups.find((g) => g.id === 'g2').name === '服务端')

  await js(`__t.q('[data-group-label="g1"] button[aria-expanded]').click()`)
  check('折叠后卡片隐藏', await waitFor(`__t.cards('g1').length === 0`))
  await sleep(200)
  check('折叠状态落盘', disk().groups.find((g) => g.id === 'g1').collapsed === true)
  await js(`__t.q('[data-group-label="g1"] button[aria-expanded]').click()`)
  check('展开后卡片恢复', await waitFor(`__t.cards('g1').length === 2`))

  console.log('\n=== 4. 筛选 ===')
  await js(`__t.setVal(__t.q('[data-testid="rail-filter"]'), '备注b')`)
  await sleep(200)
  check('按备注命中（不区分大小写）', J(await js(`__t.qa('[data-rail="sessions"] [data-workspace-id]').map((e) => e.dataset.workspaceId)`)) === J(['wsB']))
  await js(`__t.setVal(__t.q('[data-testid="rail-filter"]'), 'zzz-不存在')`)
  check('无命中提示', await waitFor(`!!__t.q('[data-testid="rail-no-match"]')`, 2000))
  await js(`__t.setVal(__t.q('[data-testid="rail-filter"]'), '')`)
  check('清空后全部回来', await waitFor(`__t.qa('[data-rail="sessions"] [data-workspace-id]').length === 3`, 2000))

  console.log('\n=== 5. 拖拽排序 ===')
  await drag(card('wsB'), card('wsA'), 'before')
  check('组内拖到前面', J(await order('g1')) === J(['wsB', 'wsA']), await order('g1'))
  check('界面顺序同步', J(await js(`__t.cards('g1')`)) === J(['wsB', 'wsA']))
  await drag(card('wsC'), label('g1'), 'middle')
  check('拖到分组标签 = 移进该组末尾', J(await order('g1')) === J(['wsB', 'wsA', 'wsC']), await order('g1'))
  await drag(card('wsA'), label('none'), 'middle')
  check('拖到「未分组」', J(await order(null)) === J(['wsA']) && J(await order('g1')) === J(['wsB', 'wsC']), { none: await order(null), g1: await order('g1') })
  await drag(card('wsC'), card('wsB'), 'before')
  check('再次组内排序', J(await order('g1')) === J(['wsC', 'wsB']), await order('g1'))
  await drag(label('g2'), label('g1'), 'before')
  const gOrder = (await cfg()).groups.sort((a, b) => a.order - b.order).map((g) => g.name)
  check('分组拖拽排序', J(gOrder) === J(['服务端', '前端', '测试组']), gOrder)
  check('分组顺序落盘', J(disk().groups.sort((a, b) => a.order - b.order).map((g) => g.id).slice(0, 2)) === J(['g2', 'g1']))

  console.log('\n=== 6. 右键菜单：复制、编辑、环境变量 ===')
  await openCtx(card('wsB'))
  const items = await js('__t.menuItems()')
  check('工作区菜单项齐全', ['新建会话', '在资源管理器中打开', '在 Windows Terminal 中打开', '编辑工作区', '复制工作区', '删除工作区'].every((x) => items.includes(x)), items)
  await js(`__t.clickMenu('复制工作区')`)
  check('复制工作区', await waitFor(`window.warp.config.get().then((c) => c.workspaces.some((w) => w.name === '订单服务 副本' && w.groupId === 'g1'))`))

  await openCtx(card('wsB'))
  await js(`__t.clickMenu('编辑工作区')`)
  await waitFor(`!!__t.q('[data-testid="workspace-dialog"]')`, 2000)
  check('编辑弹窗回填当前值', await js(`__t.q('[data-testid="workspace-dialog"] input[name="name"]').value === '订单服务' && __t.q('[data-testid="workspace-dialog"] select[name="groupId"]').value === 'g1'`))
  await js(`(() => {
    const d = __t.q('[data-testid="workspace-dialog"]')
    __t.setVal(d.querySelector('input[name="name"]'), '订单服务改')
    ;[...d.querySelectorAll('button')].find((b) => b.textContent.includes('添加变量')).click()
    return true
  })()`)
  await waitFor(`!!__t.q('[data-env-row="new"]')`, 2000)
  await js(`(() => {
    const [k, v] = __t.q('[data-env-row="new"]').querySelectorAll('input')
    __t.setVal(v, 'secret-1')
    __t.setVal(k, 'WARP_TEST')
    return true
  })()`)
  await js(`__t.q('[data-testid="workspace-save"]').click()`)
  check('保存后弹窗关闭', await waitFor(`!__t.q('[data-testid="workspace-dialog"]')`, 4000))
  const edited = (await cfg()).workspaces.find((w) => w.id === 'wsB')
  check('名称已改、分组未变', edited.name === '订单服务改' && edited.groupId === 'g1', { name: edited.name, groupId: edited.groupId })
  check('渲染层只拿到 envKeys', J(edited.envKeys) === J(['WARP_TEST']) && !('envEnc' in edited))
  const rawDisk = readFileSync(CFG, 'utf8')
  check('环境变量值没有明文落盘', !rawDisk.includes('secret-1') && Boolean(disk().workspaces.find((w) => w.id === 'wsB').envEnc))

  await openCtx(card('wsB'))
  await js(`__t.clickMenu('编辑工作区')`)
  await waitFor(`!!__t.q('[data-testid="workspace-dialog"]')`, 2000)
  check('已有变量只显示键名，值留空', await js(`(() => { const [k, v] = __t.q('[data-env-row="WARP_TEST"]').querySelectorAll('input'); return k.value === 'WARP_TEST' && k.readOnly && v.value === '' })()`))
  const before = (await cfg()).workspaces.find((w) => w.id === 'wsB').updatedAt
  await js(`__t.q('[data-testid="workspace-save"]').click()`)
  await waitFor(`!__t.q('[data-testid="workspace-dialog"]')`, 4000)
  check('什么都不改直接保存不写配置', (await cfg()).workspaces.find((w) => w.id === 'wsB').updatedAt === before)

  console.log('\n=== 7. 多会话 ===')
  await js(`__t.q(${J(card('wsB'))}).click()`)
  check('单击卡片启动会话', await waitFor(`window.warp.session.list().then((l) => l.some((s) => s.workspaceId === 'wsB' && s.status === 'running'))`, 15000))
  const s1 = (await js('window.warp.session.list()')).find((s) => s.workspaceId === 'wsB')
  check('卡片显示格号 1', await waitFor(`!!__t.q(${J(card('wsB') + ' [data-cell-badge]')})`, 2000))
  await waitFor(`window.__warpDebug.text(${J(s1.id)}).includes('后端 B')`, 15000)
  await js(`window.warp.session.write(${J(s1.id)}, 'Write-Output ("ENV=" + $env:WARP_TEST)\\r')`)
  check('会话里能读到解密后的环境变量', await waitFor(`window.__warpDebug.text(${J(s1.id)}).includes('ENV=secret-1')`, 8000))

  await openCtx(card('wsB'))
  await js(`__t.clickMenu('新建会话')`)
  check('右键新建第二个会话', await waitFor(`window.warp.session.list().then((l) => l.filter((s) => s.workspaceId === 'wsB').length === 2)`, 15000))
  check('会话数胶囊 = 2', await waitFor(`!!__t.q(${J(card('wsB') + ' [data-session-count="2"]')})`, 3000))
  check('展开两条会话子行', await waitFor(`__t.qa('[data-session-row]').length === 2`, 3000))
  const s2 = (await js('window.warp.session.list()')).find((s) => s.workspaceId === 'wsB' && s.index === 2)
  await js(`__t.dbl(__t.q('[data-session-row="${s2.id}"]'))`)
  await waitFor(`!!__t.q('[data-testid="inline-edit"]')`, 2000)
  await js(`__t.setVal(__t.q('[data-testid="inline-edit"]'), '会话甲'); __t.key(__t.q('[data-testid="inline-edit"]'), 'Enter')`)
  check('双击子行改会话标题', await waitFor(`window.warp.session.list().then((l) => l.some((s) => s.id === ${J(s2.id)} && s.title === '会话甲'))`))
  await js(`__t.q('[data-session-row="${s1.id}"]').click()`)
  check('点子行切换当前格的会话', await waitFor(`!!__t.q('main [data-session-id="${s1.id}"]')`, 3000))
  await js(`__t.q(${J(card('wsB') + ' [data-session-count]')}).click()`)
  check('胶囊收起子行', await waitFor(`__t.qa('[data-session-row]').length === 0`, 2000))

  console.log('\n=== 8. 删除 ===')
  const openGroupMenu = async () => {
    await js(`__t.q('[data-group-label="g1"] button[aria-label="前端 更多操作"]').click()`)
    await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
    await js(`__t.clickMenu('删除分组')`)
    await waitFor(`!!__t.q('[data-testid="confirm-dialog"]')`, 2000)
  }
  await openGroupMenu()
  check('非空分组删除前确认，说明工作区去向', await js(`__t.q('[data-testid="confirm-dialog"]').textContent.includes('移到「未分组」')`))
  await js(`__t.q('[data-testid="confirm-cancel"]').click()`)
  await sleep(300)
  check('取消后分组仍在', (await cfg()).groups.some((g) => g.id === 'g1'))
  await openGroupMenu()
  await js(`__t.q('[data-testid="confirm-ok"]').click()`)
  check('确认后分组删除', await waitFor(`window.warp.config.get().then((c) => !c.groups.some((g) => g.id === 'g1'))`))
  const moved = (await cfg()).workspaces.filter((w) => w.groupId === null).map((w) => w.id)
  check('其下工作区移到未分组末尾', moved.length === 4 && (await order(null))[0] === 'wsA', await order(null))

  await openCtx(card('wsB'))
  await js(`__t.clickMenu('删除工作区')`)
  await waitFor(`!!__t.q('[data-testid="confirm-dialog"]')`, 2000)
  check('运行中删除会提示结束进程', await js(`__t.q('[data-testid="confirm-dialog"]').textContent.includes('运行中')`))
  await js(`__t.q('[data-testid="confirm-ok"]').click()`)
  check('工作区删除', await waitFor(`window.warp.config.get().then((c) => !c.workspaces.some((w) => w.id === 'wsB'))`))
  check('其会话一并结束', await waitFor(`window.warp.session.list().then((l) => !l.some((s) => s.workspaceId === 'wsB'))`, 10000))

  console.log('\n=== 9. 目录栏 ===')
  const tree = (rel) => `[data-rail="files"] [role="treeitem"][data-rel="${rel}"]`
  await js(`__t.q(${J(card('wsA'))}).click()`)
  check('选中工作区后目录栏显示根目录', await waitFor(`!!__t.q(${J(tree(''))}) && !!__t.q(${J(tree('src'))})`, 5000))
  check('上下文行显示工作区名与会话序号', await waitFor(`__t.q('[data-testid="file-rail-context"]').textContent.includes('客户端 · #1')`, 5000))
  const rels = await js(`__t.qa('[data-rail="files"] [role="treeitem"]').map((e) => e.dataset.rel)`)
  const kinds = await js(`__t.qa('[data-rail="files"] [role="treeitem"]').slice(1).map((e) => e.dataset.kind)`)
  check('目录在前、文件在后', kinds.lastIndexOf('dir') < kinds.indexOf('file') && rels[rels.length - 1] === 'README.md', rels)
  check('node_modules 灰化显示', await js(`__t.q(${J(tree('node_modules'))}).querySelector('span.truncate').className.includes('text-ink-faint')`))
  check('子目录未展开时不读', await js(`!__t.q(${J(tree('src/index.ts'))})`))
  await js(`__t.q(${J(tree('src'))}).click()`)
  check('点击目录懒加载子级', await waitFor(`!!__t.q(${J(tree('src/util'))}) && !!__t.q(${J(tree('src/index.ts'))})`, 3000))
  check('aria-expanded 同步', await js(`__t.q(${J(tree('src'))}).getAttribute('aria-expanded') === 'true'`))
  await js(`__t.q(${J(tree('empty'))}).click()`)
  check('空目录提示', await waitFor(`__t.q('[data-rail="files"]').textContent.includes('空目录')`, 3000))
  await js(`(() => { const el = __t.q(${J(tree('src'))}); el.focus(); __t.key(el, 'ArrowLeft'); return true })()`)
  check('方向键左收起目录', await waitFor(`__t.q(${J(tree('src'))}).getAttribute('aria-expanded') === 'false'`, 2000))
  await js(`(() => { const el = __t.q(${J(tree('src'))}); __t.key(el, 'ArrowDown'); return true })()`)
  // src 收起后，下一个可见节点是排在目录之后的第一个文件
  check('方向键下移动焦点并选中', await js(`document.activeElement.dataset.rel === 'README.md' && document.activeElement.getAttribute('aria-selected') === 'true'`), await js('document.activeElement.dataset.rel'))
  writeFileSync(join(WORK_A, 'NEW.txt'), 'x', 'utf8')
  check('不自动重读：外部新增文件不会自动出现', !(await waitFor(`!!__t.q(${J(tree('NEW.txt'))})`, 800)))
  await js(`__t.q('[data-rail="files"] button[aria-label^="刷新"]').click()`)
  check('点刷新后出现', await waitFor(`!!__t.q(${J(tree('NEW.txt'))})`, 3000))
  await openCtx(tree('README.md'))
  // v1.4.0 文件预览起，文件节点菜单首项是「预览」
  check('节点右键：预览 / 插入 / 复制路径 / 资源管理器', J(await js('__t.menuItems()')) === J(['预览', '插入到当前终端', '复制相对路径', '复制绝对路径', '在资源管理器中显示']), await js('__t.menuItems()'))
  await js(`__t.key(document.activeElement, 'Escape')`)
  await waitFor(`!document.querySelector('[role="menu"]')`, 2000)
  const fw = await js(`Math.round(__t.q('[data-rail="files"]').getBoundingClientRect().width)`)
  check('目录栏宽 240px', fw === 240, fw)

  console.log('\n=== 10. 快捷键（焦点在终端里） ===')
  const sA = (await js('window.warp.session.list()')).find((s) => s.workspaceId === 'wsA')
  await waitFor(`!!__t.q('main .xterm-helper-textarea')`, 5000)
  win.focus()
  const press = async (keyCode) => {
    await js(`__t.q('main .xterm-helper-textarea').focus(); document.activeElement.classList.contains('xterm-helper-textarea')`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['control', 'shift'] })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['control', 'shift'] })
    await sleep(300)
  }
  // 终端里跑一个原样回显 stdin 的 node：快捷键若漏进 PTY，会打印 GOT"\u0002" 之类
  const probe = `node -e "process.stdin.setRawMode(true);console.log('READY');process.stdin.on('data',d=>console.log('GOT'+JSON.stringify(d.toString())))"`
  await waitFor(`window.__warpDebug.text(${J(sA.id)}).includes('前端 A')`, 15000)
  await js(`window.warp.session.write(${J(sA.id)}, ${J(probe + '\r')})`)
  const ready = await waitFor(`window.__warpDebug.text(${J(sA.id)}).split('\\n').some((l) => l.trim() === 'READY')`, 10000)
  check('终端里的 stdin 探针已就绪', ready)
  const leaked = async () => /GOT"/.test(await termText(sA.id))
  await press('B')
  check('Ctrl+Shift+B 折叠会话栏为 56px', await waitFor(`__t.q('[data-rail="sessions"]').dataset.collapsed === 'true' && Math.round(__t.q('[data-rail="sessions"]').getBoundingClientRect().width) === 56`, 2000))
  check('标题栏按钮 aria-pressed 同步', await js(`__t.q('button[aria-label^="会话栏"]').getAttribute('aria-pressed') === 'false'`))
  check('折叠态仍列出全部工作区', await js(`__t.qa('[data-rail="sessions"] [data-workspace-id]').length === 3`))
  await press('B')
  check('再按展开回 200px', await waitFor(`Math.round(__t.q('[data-rail="sessions"]').getBoundingClientRect().width) === 200`, 2000))
  await press('E')
  check('Ctrl+Shift+E 隐藏目录栏', await waitFor(`!__t.q('[data-rail="files"]')`, 2000))
  await press('E')
  check('再按显示目录栏，树的展开状态保留', await waitFor(`!!__t.q(${J(tree('NEW.txt'))})`, 2000))
  await sleep(500)
  check('快捷键没有作为按键送进终端', !(await leaked()))
  await js(`__t.q('main .xterm-helper-textarea').focus()`)
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'x' })
  check('普通按键照常进终端（探针有效）', await waitFor(`/GOT"x"/.test(window.__warpDebug.text(${J(sA.id)}))`, 3000))

  console.log('\n=== 收尾 ===')
  check('渲染层没有报错', rendererErrors.length === 0, rendererErrors.slice(0, 3))
  for (const s of await js('window.warp.session.list()')) await js(`window.warp.session.close(${J(s.id)})`)
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
