/**
 * 安装包冒烟（M5）：直接启动 release/win-unpacked 里打包好的 Mile Warp.exe，确认
 *   1. 打包产物能起来、窗口能加载（preload 的 window.warp 在）
 *   2. node-pty 原生模块从 app.asar.unpacked 正常加载：真能起一个 Shell 会话并收到输出
 *   3. 打包后单实例锁生效：第二个实例自己退出
 * 用 MILE_WARP_DATA_DIR 把配置目录指到临时目录，不碰真实配置；经 --remote-debugging-port 用 CDP 驱动渲染层。
 * 结束前确认真实的 %APPDATA%\mile-warp 没有被这次运行创建。
 * 需要 Node 22+（全局 WebSocket）：
 *   npm run build:win
 *   node scripts/verify-package.cjs
 */
const { spawn, execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')

const EXE = join(__dirname, '..', 'release', 'win-unpacked', 'Mile Warp.exe')
const PORT = 9333 + Math.floor(Math.random() * 500)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}

const REAL_DIR = join(process.env.APPDATA || '', 'mile-warp')

async function main() {
  if (!existsSync(EXE)) throw new Error(`找不到 ${EXE}，先 npm run build:win`)
  const realBefore = existsSync(REAL_DIR)
  if (typeof WebSocket === 'undefined') throw new Error('需要 Node 22+（全局 WebSocket）')
  check('托盘与窗口图标随包放进 resources/icon.png', existsSync(join(EXE, '..', 'resources', 'icon.png')))
  const appData = mkdtempSync(join(tmpdir(), 'warp-pkg-'))
  const work = join(appData, '安装包 验证')
  mkdirSync(join(appData, 'mile-warp'), { recursive: true })
  mkdirSync(work, { recursive: true })
  const now = Date.now()
  writeFileSync(
    join(appData, 'mile-warp', 'config.json'),
    JSON.stringify({
      version: 1,
      groups: [],
      workspaces: [{ id: 'wsP', groupId: null, name: '打包验证', note: '', agentId: 'shell', agentPath: null, cwd: work, args: [], envKeys: [], envEnc: null, order: 0, createdAt: now, updatedAt: now }],
      customAgents: [],
      settings: { closeAction: 'quit' },
      sessionRecords: []
    }),
    'utf8'
  )
  // Windows 上 Electron 的 appData 取自系统已知文件夹，改 APPDATA 环境变量不生效；用应用自己的覆盖变量
  const env = { ...process.env, MILE_WARP_DATA_DIR: appData }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' })
  try {
    console.log('\n=== 打包产物启动 ===')
    let target = null
    for (let t = 0; t < 20000 && !target; t += 250) {
      await sleep(250)
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
        target = list.find((x) => x.type === 'page')
      } catch {
        // 调试端口还没起来
      }
    }
    check('窗口起来、调试端口可连', Boolean(target), target && target.url)
    if (!target) return
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((r, j) => {
      ws.onopen = r
      ws.onerror = j
    })
    let seq = 0
    const pending = new Map()
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data)
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
    const evaluate = (expression) =>
      new Promise((resolve) => {
        const id = ++seq
        // 表达式抛错（含 Promise 被拒）时 exceptionDetails 有值，按 undefined 处理，不能当成真值
        pending.set(id, (msg) => resolve(msg.result && !msg.result.exceptionDetails && msg.result.result ? msg.result.result.value : undefined))
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
      })
    const waitFor = async (expr, ms) => {
      for (let t = 0; t < ms; t += 200) {
        if (await evaluate(expr).catch(() => false)) return true
        await sleep(200)
      }
      return false
    }
    check('preload 暴露了 window.warp', await waitFor(`typeof window.warp === 'object' && typeof window.warp.session.start === 'function'`, 10000))
    check('读到临时目录里的配置', await waitFor(`window.warp.config.get().then((c) => c.workspaces.length === 1 && c.workspaces[0].name === '打包验证')`, 5000))
    const meta = await evaluate(`window.warp.session.start('wsP').then((m) => ({ id: m.id, pid: m.pid }), (e) => ({ error: String(e) }))`)
    check('node-pty 在打包产物里可用：起 Shell 会话', Boolean(meta && meta.pid), meta)
    const out = await waitFor(`window.warp.session.buffer(${JSON.stringify(meta && meta.id)}).then((b) => !!b && b.data.includes('安装包 验证'))`, 15000)
    check('收到 Shell 输出（中文路径）', out)

    console.log('\n=== 单实例锁 ===')
    const second = spawn(EXE, [], { env, stdio: 'ignore' })
    const code = await Promise.race([new Promise((r) => second.on('exit', r)), sleep(10000).then(() => 'timeout')])
    check('第二个实例自己退出', code !== 'timeout', code)
    if (code === 'timeout') execFileSync('taskkill.exe', ['/PID', String(second.pid), '/T', '/F'], { windowsHide: true })
    ws.close()
    check('没有碰真实的 %APPDATA%\\mile-warp', realBefore || !existsSync(REAL_DIR))
  } finally {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch {
      // 已退出
    }
    await sleep(500)
    try {
      rmSync(appData, { recursive: true, force: true })
    } catch {
      // 进程刚退出时文件可能还被占用
    }
  }
}

main()
  .catch((e) => {
    console.log('\n  FAIL  脚本异常', (e && e.stack) || e)
    fail++
  })
  .finally(() => {
    console.log(`\n${pass}/${pass + fail} 通过`)
    process.exit(fail ? 1 : 0)
  })
