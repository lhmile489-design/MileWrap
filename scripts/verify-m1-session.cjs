/**
 * M1 验收：单格终端（技术设计 §10 verify-m1-session）。
 *
 * 启动真实主进程（out/ 产物），在沙箱 appData 里预置一个 Shell 工作区（目录名含中文），
 * 通过渲染层真实点击与 window.warp IPC 驱动：
 *   1. agent 探测：claude / codex / kimi 可用
 *   2. 点击工作区卡片 → 会话启动、终端出现提示符、目录是中文路径
 *   3. 键入中文命令，终端回显中文不乱码
 *   4. 子进程树：shell 里拉起 node 子进程，kill 后两个 PID 都不在
 *   5. 重启 → gen+1；exit 3 → 状态 crashed、退出码 3、界面出现退出条
 *   6. 入参校验：相对路径 / 不存在目录 / 未知 agent / 未知工作区 / 非法会话 id 一律拒绝
 *   7. 关闭会话后列表为空；配置写在沙箱里
 *
 *   npm run build
 *   npx electron scripts/verify-m1-session.cjs
 */
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'warp-m1-'))
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)

const WORK = join(SANDBOX, '项目 M1')
mkdirSync(WORK, { recursive: true })
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
          id: 'ws-shell', groupId: null, name: '中文工作区', note: '', agentId: 'shell', agentPath: null,
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
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
function pidAlive(pid) {
  try {
    const out = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true })
    return out.includes(`"${pid}"`)
  } catch {
    return false
  }
}

// 任何一步卡住或抛错都要退出，不能让 harness 挂着
setTimeout(() => { console.log('\n  FAIL  总超时 180 秒'); app.exit(3) }, 180000).unref()

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  win.webContents.on('console-message', (e) => {
    const lvl = e.level ?? ''
    if (lvl === 'error' || lvl === 'warning' || lvl === 3 || lvl === 2) console.log('  [renderer]', e.message)
  })
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 10000) => {
    for (let t = 0; t < ms; t += 150) {
      try {
        if (await js(code)) return true
      } catch {
        // 页面里的表达式暂时抛错（元素还没渲染）按未满足处理
      }
      await sleep(150)
    }
    return false
  }
  const rejects = (code) => js(`(${code}).then(() => 'resolved', (e) => 'rejected:' + String(e && e.message || e))`)
  const termText = (id) => js(`window.__warpDebug.text(${JSON.stringify(id)})`)

  console.log('\n=== 1. agent 探测 ===')
  const agents = await js('window.warp.agent.list()')
  for (const id of ['claude', 'codex', 'kimi', 'pi', 'shell']) {
    const a = agents.find((x) => x.id === id)
    check(`${id} 可用`, Boolean(a && a.available), a && { via: a.via, version: a.version })
  }

  console.log('\n=== 2. 点击工作区卡片启动 ===')
  await waitFor(`!!document.querySelector('[data-workspace-id="ws-shell"]')`)
  await js(`document.querySelector('[data-workspace-id="ws-shell"]').click()`)
  const started = await waitFor(`window.warp.session.list().then(l => l.length === 1 && l[0].status === 'running')`)
  const [meta] = await js('window.warp.session.list()')
  check('会话进入运行中', started, meta && { status: meta.status, pid: meta.pid, title: meta.title })
  const id = meta.id
  const prompt = await waitFor(`window.__warpDebug.text(${JSON.stringify(id)}).includes('项目 M1')`, 15000)
  check('终端出现提示符且目录为中文路径', prompt, (await termText(id)).trim().split('\n').pop())
  check('xterm 挂进格里', await js(`!!document.querySelector('[data-session-id="${id}"] .xterm')`))

  console.log('\n=== 3. 中文输入输出 ===')
  await js(`window.warp.session.write(${JSON.stringify(id)}, "Write-Output ('中文' + '回显OK')\\r")`)
  const echoed = await waitFor(`window.__warpDebug.text(${JSON.stringify(id)}).includes('中文回显OK')`)
  check('终端回显中文', echoed, (await termText(id)).split('\n').filter((l) => l.includes('回显')).slice(-1)[0])

  console.log('\n=== 4. 进程树清理 ===')
  await js(
    `window.warp.session.write(${JSON.stringify(id)}, "node -e \\"console.log('CHILD=' + process.pid); setInterval(() => {}, 1000)\\"\\r")`
  )
  await waitFor(`/CHILD=\\d+/.test(window.__warpDebug.text(${JSON.stringify(id)}))`)
  const childPid = Number(/CHILD=(\d+)/.exec(await termText(id))?.[1])
  check('拿到子进程 PID', Number.isInteger(childPid) && pidAlive(childPid), { shell: meta.pid, child: childPid })
  await js(`window.warp.session.kill(${JSON.stringify(id)})`)
  const ended = await waitFor(`window.warp.session.list().then(l => l[0] && l[0].status !== 'running' && l[0].status !== 'starting')`)
  await sleep(500)
  check('kill 后会话结束', ended)
  check('shell 进程已不在', !pidAlive(meta.pid))
  check('node 子进程已不在（taskkill /T 生效）', !pidAlive(childPid))

  console.log('\n=== 5. 重启与退出码 ===')
  const re = await js(`window.warp.session.restart(${JSON.stringify(id)})`)
  check('重启后 gen + 1', re && re.gen === meta.gen + 1, re && { gen: re.gen })
  await waitFor(`window.warp.session.list().then(l => l[0].status === 'running')`)
  await waitFor(`window.__warpDebug.text(${JSON.stringify(id)}).includes('项目 M1')`, 15000)
  check('重启后旧画面已清掉', !(await termText(id)).includes('CHILD='))
  await js(`window.warp.session.write(${JSON.stringify(id)}, "exit 3\\r")`)
  await waitFor(`window.warp.session.list().then(l => l[0].status === 'crashed')`)
  const after = (await js('window.warp.session.list()'))[0]
  check('exit 3 → crashed / 退出码 3', after.status === 'crashed' && after.exitCode === 3, { status: after.status, exitCode: after.exitCode })
  const bar = await waitFor(`document.body.innerText.includes('进程已退出') && document.body.innerText.includes('3')`)
  check('界面显示退出条', bar)

  console.log('\n=== 6. 入参校验 ===')
  const base = { name: 'x', agentId: 'shell', argsText: '', note: '', groupId: null }
  check('相对路径拒绝', (await rejects(`window.warp.workspace.create(${JSON.stringify({ ...base, cwd: 'relative\\\\dir' })})`)).startsWith('rejected'))
  check('不存在目录拒绝', (await rejects(`window.warp.workspace.create(${JSON.stringify({ ...base, cwd: join(SANDBOX, 'gone') })})`)).startsWith('rejected'))
  check('未知 agent 拒绝', (await rejects(`window.warp.workspace.create(${JSON.stringify({ ...base, cwd: WORK, agentId: 'calc.exe' })})`)).startsWith('rejected'))
  check('未知工作区拒绝启动', (await rejects(`window.warp.session.start('nope')`)).startsWith('rejected'))
  check('非法会话 id 拒绝', (await rejects(`window.warp.session.kill('../x')`)).startsWith('rejected'))
  const okCreate = await rejects(`window.warp.workspace.create(${JSON.stringify({ ...base, name: '新建 ok', cwd: WORK, argsText: '-NoProfile -Command "echo hi"' })})`)
  const cfgAfter = await js('window.warp.config.get()')
  const created = cfgAfter.workspaces.find((w) => w.name === '新建 ok')
  check('合法工作区可创建且参数已切分', okCreate === 'resolved' && JSON.stringify(created && created.args) === JSON.stringify(['-NoProfile', '-Command', 'echo hi']), created && created.args)
  check('渲染层拿不到 envEnc', created && !('envEnc' in created))

  console.log('\n=== 7. 关闭会话与落盘 ===')
  await js(`window.warp.session.close(${JSON.stringify(id)})`)
  const emptied = await waitFor(`window.warp.session.list().then(l => l.length === 0)`)
  check('关闭后会话列表为空', emptied)
  check('格回到空态', await waitFor(`document.body.innerText.includes('从左侧选择')`, 3000))
  const cfgFile = join(SANDBOX, 'mile-warp', 'config.json')
  const onDisk = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : null
  check('配置写在沙箱且含新工作区', Boolean(onDisk && onDisk.workspaces.some((w) => w.name === '新建 ok')))
  check('写入后留有 .bak', existsSync(`${cfgFile}.bak`))

  console.log(`\n${pass}/${pass + fail} 通过`)
  win.destroy()
  setTimeout(() => {
    try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
    app.exit(fail ? 1 : 0)
  }, 300)
}).catch((e) => {
  console.log('\n  FAIL  脚本异常', e && e.stack || e)
  app.exit(2)
})
