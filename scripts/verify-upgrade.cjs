/**
 * 升级建议验收（docs/升级建议.md）：主进程能力走 IPC 回执断言，界面部分读 DOM。
 *
 *   1. 配置 v1 → v2 迁移：layoutPresets 补空、旧字段保留、新设置项有默认值；日志目录建出来了
 *   2. 活动指示（2.1）：连续输出后安静 → attention；格头与卡片出现小点；聚焦后清掉
 *   3. 自定义 agent（3.3）：命令只认命令名 / 存在的绝对路径；颜色对比度不够被拒；续接模板要有 {id}；
 *      在用时不能删；工作区能选它
 *   4. 路径（2.4 / 2.6）：fs:resolve 相对 / 绝对路径都校验在工作区内，越界拒绝；插入路径不带回车
 *   5. 布局预设（3.1）：保存、校验不存在的工作区、应用后各格放对
 *   6. 分组颜色（W-13 / 4.5）与配置导出不含环境变量值（4.7）
 *   7. 广播输入（3.4）：开启前要确认；开启后输入同时进两格，排除的格收不到
 *   8. 目录栏「有更新」（3.7）：已展开目录里新建文件后头部出现提示，点刷新消失
 *   9. 渲染进程崩溃自动重载（1.3）：forcefullyCrashRenderer 后界面回来、会话还在
 *
 *   npm run build
 *   npx electron scripts/verify-upgrade.cjs 2>&1 | Out-File $env:TEMP\warp-upgrade.log -Encoding utf8
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'warp-up-'))
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const WORK_A = join(SANDBOX, '工作区 甲')
const WORK_B = join(SANDBOX, 'work-b')
mkdirSync(join(WORK_A, 'src'), { recursive: true })
mkdirSync(WORK_B, { recursive: true })
writeFileSync(join(WORK_A, 'src', 'foo.ts'), 'export {}\n', 'utf8')
const CFG = join(SANDBOX, 'mile-warp', 'config.json')
mkdirSync(join(SANDBOX, 'mile-warp'), { recursive: true })
const now = Date.now()
const ws = (id, name, cwd, groupId) => ({
  id, groupId, name, note: '', agentId: 'shell', agentPath: null, cwd, args: [], envKeys: [], envEnc: null, order: 0, createdAt: now, updatedAt: now
})
writeFileSync(
  CFG,
  JSON.stringify({
    version: 1,
    groups: [{ id: 'g1', name: '前端', color: null, collapsed: false, order: 0 }],
    workspaces: [ws('wsA', '客户端', WORK_A, 'g1'), ws('wsB', '服务端', WORK_B, 'g1')],
    customAgents: [],
    // 阈值调小，活动指示几秒内就能判出来
    settings: { theme: 'light', activityBurstSec: 1, activityQuietSec: 2, notifyIdle: false, notifyExit: false },
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

setTimeout(() => { console.log('\n  FAIL  总超时 240 秒'); app.exit(3) }, 240000).unref()

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
  const rejects = (code) => js(`(${code}).then(() => false, () => true)`)
  const waitFor = async (code, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) {
      try {
        if (await js(code)) return true
      } catch {
        // 元素还没渲染出来
      }
      await sleep(100)
    }
    return false
  }
  const q = (sel) => js(`!!document.querySelector(${J(sel)})`)
  const text = (id) => js(`window.__warpDebug.text(${J(id)})`)
  await waitFor(`!!document.querySelector('[data-rail="sessions"] [data-workspace-id]')`)
  win.focus()

  console.log('\n=== 1. 配置迁移与日志 ===')
  const cfg = await js('window.warp.config.get()')
  check('layoutPresets 补成空数组', Array.isArray(cfg.layoutPresets) && cfg.layoutPresets.length === 0)
  check('customAgents 存在', Array.isArray(cfg.customAgents))
  check('旧设置保留，新设置有默认值', cfg.settings.activityQuietSec === 2 && cfg.settings.lineHeight === 1.5 && cfg.settings.cursorStyle === 'block')
  check('工作区保留', cfg.workspaces.length === 2)
  // 落盘一次后 version 升到 2
  await js(`window.warp.settings.update({ cursorBlink: false })`)
  check('写盘后 version = 2', JSON.parse(readFileSync(CFG, 'utf8')).version === 2)
  check('越界设置被拒', await rejects(`window.warp.settings.update({ lineHeight: 9 })`))
  check('日志目录已建', existsSync(join(SANDBOX, 'mile-warp', 'logs')))

  console.log('\n=== 2. 活动指示 ===')
  await js(`document.querySelector('[data-workspace-id="wsA"]').click()`)
  await waitFor(`window.warp.session.list().then((l) => l.some((s) => s.workspaceId === 'wsA' && s.status === 'running'))`, 15000)
  const sA = (await js('window.warp.session.list()')).find((s) => s.workspaceId === 'wsA')
  await waitFor(`window.__warpDebug.text(${J(sA.id)}).includes('PS ')`, 15000)
  // 先让它进 2 格，再把焦点放到另一格：attention 才不会被「看见即清」立刻清掉
  await js(`document.querySelector('[aria-label*="左右两格"]')?.click()`)
  await sleep(300)
  await js(`document.querySelector('[data-cell="1"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await sleep(100)
  await js(`document.querySelector('[data-workspace-id="wsB"]').click()`)
  await waitFor(`window.warp.session.list().then((l) => l.some((s) => s.workspaceId === 'wsB' && s.status === 'running'))`, 15000)
  const sB = (await js('window.warp.session.list()')).find((s) => s.workspaceId === 'wsB')
  await waitFor(`window.__warpDebug.text(${J(sB.id)}).includes('PS ')`, 15000)
  check('A 在第 1 格、B 在第 2 格', await waitFor(`!!document.querySelector('[data-cell="0"] [data-session-id=${J(sA.id)}]') && !!document.querySelector('[data-cell="1"] [data-session-id=${J(sB.id)}]')`, 3000))
  // 让 A 连续输出约 2 秒，然后安静
  await js(`window.warp.session.write(${J(sA.id)}, '1..20 | % { Write-Output tick$_; Start-Sleep -Milliseconds 100 }\\r')`)
  check('输出中判为 active', await waitFor(`window.warp.session.activityList().then((l) => l.find((x) => x.id === ${J(sA.id)})?.state === 'active')`, 6000))
  // 状态灯：对话中 = 绿色呼吸（有动画），安静后 = 等待输入（蓝色静止）
  const lamp = (cell) => `document.querySelector('[data-cell="${cell}"] [data-cell-head] [data-status]')`
  check('对话中：格头状态灯为 busy', await waitFor(`${lamp(0)}?.dataset.status === 'busy'`, 3000))
  check('对话中：状态灯在呼吸', await js(`getComputedStyle(${lamp(0)}).animationName === 'status-breathe'`))
  check('对话中：会话栏卡片同步', await q('[data-workspace-id="wsA"] [data-status="busy"]'))
  check('对话中：格头文字', await js(`${lamp(0)}.getAttribute('aria-label') === '对话中'`))
  const att = await waitFor(`window.warp.session.activityList().then((l) => l.find((x) => x.id === ${J(sA.id)})?.attention === true)`, 12000)
  check('安静后标记「等你处理」', att)
  check('安静后：状态灯为 waiting', await waitFor(`${lamp(0)}?.dataset.status === 'waiting'`, 3000))
  check('安静后：状态灯不动', await js(`getComputedStyle(${lamp(0)}).animationName === 'none'`))
  check('安静后：格头文字', await js(`${lamp(0)}.getAttribute('aria-label') === '等待输入'`))
  check('格头出现小点', await waitFor(`!!document.querySelector('[data-cell="0"] [data-attention]')`, 3000))
  check('工作区卡片出现小点', await q('[data-workspace-id="wsA"] [data-attention]'))
  await js(`document.querySelector('[data-cell="0"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  check('聚焦后清掉', await waitFor(`window.warp.session.activityList().then((l) => l.find((x) => x.id === ${J(sA.id)})?.attention === false)`, 3000))
  // 纯转义噪声（空闲 TUI 的状态栏重绘）不该顶成 active：命令回显算可见输出，随后安静超 quietSec 应转 quiet
  await js(`window.warp.session.write(${J(sB.id)}, '1..20 | % { [Console]::Write([char]27+"[9;39H"+[char]27+"[K"); Start-Sleep -Milliseconds 600 }\\r')`)
  await sleep(6500)
  check('纯转义噪声不算 active', (await js('window.warp.session.activityList()')).find((x) => x.id === sB.id)?.state !== 'active')

  console.log('\n=== 3. 自定义 agent ===')
  const save = (o) => `window.warp.agent.saveCustom(${J({ name: 'Gemini', command: 'gemini', argsText: '', color: null, resumeArgsText: '', continueArgsText: '', ...o })})`
  check('命令里带 shell 元字符被拒', await rejects(save({ command: 'gemini & calc' })))
  check('不存在的绝对路径被拒', await rejects(save({ command: 'C:\\no\\such\\agent.exe' })))
  check('对比度不够的颜色被拒', await rejects(save({ color: '#777777' })))
  check('续接模板缺 {id} 被拒', await rejects(save({ resumeArgsText: '--resume' })))
  const c1 = await js(save({ color: '#1d4ed8', argsText: '--yolo', resumeArgsText: '--resume {id}', continueArgsText: '--continue' }))
  const ga = c1.customAgents.find((a) => a.name === 'Gemini')
  check('合法的自定义 agent 存下了', ga && ga.defaultArgs[0] === '--yolo' && ga.resumeArgs[1] === '{id}', ga)
  check('agent 列表里有它', (await js('window.warp.agent.list()')).some((a) => a.id === ga?.id))
  await js(`window.warp.workspace.edit('wsB', { agentId: ${J(ga.id)} })`)
  check('工作区能改成它', (await js('window.warp.config.get()')).workspaces.find((w) => w.id === 'wsB').agentId === ga.id)
  check('在用时不能删', await rejects(`window.warp.agent.removeCustom(${J(ga.id)})`))
  await js(`window.warp.workspace.edit('wsB', { agentId: 'shell' })`)
  check('不再使用后能删', (await js(`window.warp.agent.removeCustom(${J(ga.id)})`)).customAgents.length === 0)
  check('未知 agent 被拒', await rejects(`window.warp.workspace.edit('wsB', { agentId: 'nope' })`))

  console.log('\n=== 4. 路径 ===')
  const rel = await js(`window.warp.fs.resolve('wsA', 'src/foo.ts')`)
  check('相对路径解析到工作区内', rel.toLowerCase().endsWith('\\src\\foo.ts'), rel)
  const abs = await js(`window.warp.fs.resolve('wsA', ${J(join(WORK_A, 'src', 'foo.ts'))})`)
  check('工作区内的绝对路径放行', abs.toLowerCase() === rel.toLowerCase())
  check('../ 越界被拒', await rejects(`window.warp.fs.resolve('wsA', '../work-b')`))
  check('工作区外的绝对路径被拒', await rejects(`window.warp.fs.resolve('wsA', ${J(WORK_B)})`))
  check('打开编辑器也走同样的校验', await rejects(`window.warp.fs.openInEditor('wsA', 'C:\\\\Windows\\\\win.ini', 1)`))
  check('非法行号被拒', await rejects(`window.warp.fs.openInEditor('wsA', 'src/foo.ts', -3)`))

  console.log('\n=== 5. 布局预设 ===')
  check('不存在的工作区被拒', await rejects(`window.warp.preset.save('坏', 'dual', ['nope', null, null, null])`))
  check('格位数不对被拒', await rejects(`window.warp.preset.save('坏', 'dual', ['wsA'])`))
  const p = (await js(`window.warp.preset.save('前端联调', 'dual', ['wsB', 'wsA', null, null])`)).layoutPresets[0]
  check('预设存下了', p && p.name === '前端联调' && p.gridMode === 'dual')
  await js(`window.warp.preset.save('前端联调', 'dual', ['wsB', 'wsA', null, null])`)
  check('同名覆盖不重复', (await js('window.warp.config.get()')).layoutPresets.length === 1)

  console.log('\n=== 6. 分组颜色与导出 ===')
  check('非法颜色被拒', await rejects(`window.warp.group.setColor('g1', 'red')`))
  await js(`document.querySelector('button[aria-label="前端 更多操作"]').click()`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  await js(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((b) => b.textContent.trim() === '蓝').click()`)
  await sleep(300)
  check('分组颜色存下了', (await js('window.warp.config.get()')).groups[0].color === '#2563eb')
  check('格头色带跟着分组颜色', await waitFor(`!!document.querySelector('[data-cell-band="#2563eb"]')`, 3000))

  console.log('\n=== 7. 广播输入 ===')
  await js(`document.querySelector('button[aria-label="广播输入"]').click()`)
  check('开启前弹确认', await waitFor(`!!document.querySelector('[data-testid="confirm-dialog"]')`, 3000))
  await js(`document.querySelector('[data-testid="confirm-ok"]').click()`)
  check('确认后开启', await waitFor(`!!document.querySelector('button[aria-pressed="true"][aria-label*="广播输入已开启"]')`, 3000))
  // 格的聚焦状态在 onMouseDownCapture 里同步，光 focus() 不改 store：先派发 mousedown 再聚焦终端
  await js(`const sec = document.querySelector('[data-cell="0"]'); sec.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); sec.querySelector('.xterm-helper-textarea').focus(); true`)
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'Q' })
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'Z' })
  // 去掉换行再比：格宽可能让字符折到下一行（踩坑记录：窄格 + 长提示符时 'Q' 在末列、'Z' 折行）
  const flatQZ = (id) => `window.__warpDebug.text(${J(id)}).replace(/\\r?\\n/g, '').includes('QZ')`
  check('聚焦格收到', await waitFor(flatQZ(sA.id), 3000))
  const gotB = await waitFor(flatQZ(sB.id), 8000)
  if (!gotB) {
    await js(`window.warp.session.write(${J(sB.id)}, 'MANX')`)
    const manualEcho = await waitFor(`window.__warpDebug.text(${J(sB.id)}).includes('MANX')`, 2000)
    const bufB = await js(`window.warp.session.buffer(${J(sB.id)}).then((b) => JSON.stringify({ hasQZ: b?.data?.includes('QZ') ?? 'null', tail: b?.data?.slice(-200) }))`)
    const textNow = await js(`window.__warpDebug.text(${J(sB.id)}).replace(/\\r?\\n/g, '').includes('QZ')`)
    const tailLines = await js(`window.__warpDebug.text(${J(sB.id)}).split('\\n').filter((l) => l.trim()).slice(-6).join('|')`)
    console.log('  诊断：手动写 sB 回显 =', manualEcho, '主进程buffer =', bufB, '此刻xterm含QZ =', textNow, 'xterm尾行 =', tailLines, await js(`window.warp.session.list().then((l) => JSON.stringify({ hook: window.__warpDebug.inputHookActive(), stats: window.__warpDebug.hookStats(), store: window.__warpDebug.sessionStore(), layout: window.__warpDebug.layout(), sessions: l.map((x) => ({ id: x.id, status: x.status })) }))`))
  }
  check('另一格也收到', gotB)
  await js(`document.querySelector('button[aria-pressed="true"][aria-label*="广播输入已开启"]').click()`)
  await sleep(200)
  win.webContents.sendInputEvent({ type: 'char', keyCode: 'W' })
  await sleep(600)
  check('关闭后只进聚焦格', await waitFor(`window.__warpDebug.text(${J(sA.id)}).replace(/\\r?\\n/g, '').includes('QZW')`, 3000) && !(await text(sB.id)).replace(/\r?\n/g, '').includes('QZW'))

  console.log('\n=== 8. 目录栏「有更新」 ===')
  await js(`document.querySelector('[data-workspace-id="wsA"]').click()`)
  await waitFor(`!!document.querySelector('[data-rail="files"] [data-rel="src"]')`, 5000)
  await js(`document.querySelector('[data-rail="files"] [data-rel="src"]').click()`)
  await waitFor(`!!document.querySelector('[data-rail="files"] [data-rel="src/foo.ts"]')`, 5000)
  await sleep(500)
  writeFileSync(join(WORK_A, 'src', 'bar.ts'), 'export {}\n', 'utf8')
  check('新建文件后出现「有更新」', await waitFor(`!!document.querySelector('[data-testid="file-rail-stale"]')`, 5000))
  check('不自动重读', !(await q('[data-rail="files"] [data-rel="src/bar.ts"]')))
  await js(`document.querySelector('[data-rail="files"] button[aria-label^="刷新"]').click()`)
  check('点刷新后看到新文件', await waitFor(`!!document.querySelector('[data-rail="files"] [data-rel="src/bar.ts"]')`, 5000))
  check('提示消失', !(await q('[data-testid="file-rail-stale"]')))

  console.log('\n=== 9. 渲染进程崩溃自动重载 ===')
  const before = (await js('window.warp.session.list()')).length
  win.webContents.forcefullyCrashRenderer()
  await sleep(1500)
  const back = await waitFor(`!!document.querySelector('[data-rail="sessions"] [data-workspace-id]')`, 15000)
  check('界面自动回来', back)
  check('会话还在', (await js('window.warp.session.list()')).length === before)
  check('终端画面回放', await waitFor(`window.__warpDebug.text(${J(sA.id)}).includes('tick')`, 8000))

  console.log('\n=== 10. 异常退出：红色状态灯 ===')
  // 第 7 节的广播在 B 的提示符上留了「QZ」：先 Ctrl+C 清掉当前行，否则 exit 3 会变成 QZexit 3
  await js(`window.warp.session.write(${J(sB.id)}, '\\x03')`)
  await sleep(500)
  await js(`window.warp.session.write(${J(sB.id)}, 'exit 3\\r')`)
  check('B 异常退出', await waitFor(`window.warp.session.list().then((l) => l.find((s) => s.id === ${J(sB.id)})?.status === 'crashed')`, 10000))
  check('格头状态灯为 fault', await waitFor(`document.querySelector('[data-cell="1"] [data-cell-head] [data-status]')?.dataset.status === 'fault'`, 3000))
  check('fault 是红色实心', await js(`(() => { const el = document.querySelector('[data-cell="1"] [data-cell-head] [data-status="fault"]'); return !!el && getComputedStyle(el).backgroundColor ===getComputedStyle(document.documentElement).getPropertyValue('--signal-fault').trim().replace(/^#(..)(..)(..)$/, (_, r, g, b) => 'rgb(' + [r, g, b].map((h) => parseInt(h, 16)).join(', ') + ')') })()`))

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
  console.log('  FAIL  脚本异常', e && e.stack ? e.stack : e)
  app.exit(2)
})
