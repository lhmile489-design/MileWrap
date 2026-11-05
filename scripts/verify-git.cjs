/**
 * Git 管理 G0 验收（docs/Git管理-PRD.md §9）。
 *
 * 沙箱里用真实 git 造：
 *   repo/            仓库根；工作区指向 repo/子目录（工作区是仓库子目录）
 *     a.txt          已提交后改动（未暂存 M）
 *     both.txt       暂存了一次修改、又改了一次（已暂存 M + 未暂存 M）
 *     staged.txt     新文件已暂存（已暂存 A）
 *     子目录/旧名.txt → 新名.txt  git mv（已暂存 R，带 oldPath）
 *     子目录/删掉.txt  工作区删除（未暂存 D）
 *     子目录/中文 名.txt  未跟踪
 *     core.fsmonitor 配成会写 pwned.txt 的命令：status 不能执行它
 *   norepo/          不是 git 仓库
 *   remote.git       裸仓库，加成 origin 后 hasRemote 为 true
 *
 * 覆盖：总开关默认关（probe=disabled、status 拒绝）、设置页 Git 分区、远端名校形、
 *      probe（仓库名 / 子目录 / 非仓库 / 未知工作区）、status 各状态与中文路径、detached HEAD、关开关后再次拒绝。
 *
 *   npm run build
 *   npx electron scripts/verify-git.cjs > $env:TEMP\warp-git.log
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'warp-git-'))
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
// git 向上找仓库时不越过沙箱（用户目录本身万一是仓库，norepo 也不会误判）
process.env.GIT_CEILING_DIRECTORIES = SANDBOX

const REPO = join(SANDBOX, 'repo')
const SUB = join(REPO, '子目录')
const NOREPO = join(SANDBOX, 'norepo')
const REMOTE = join(SANDBOX, 'remote.git')
mkdirSync(SUB, { recursive: true })
mkdirSync(NOREPO, { recursive: true })

// harness 自己的 git 调用也必须关掉 fsmonitor：否则下面配的恶意 fsmonitor 会被 harness 的 stash / checkout 执行，
// 写出 pwned.txt，分不清是谁执行的（实测踩到）。-c 只影响本次运行，不改仓库配置
const g = (...args) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', REPO, ...args], { encoding: 'utf8', windowsHide: true })
execFileSync('git', ['init', '-q', '-b', 'main', REPO], { windowsHide: true })
g('config', 'user.name', 'warp-test')
g('config', 'user.email', 'warp@test.local')
g('config', 'core.autocrlf', 'false')
writeFileSync(join(REPO, 'a.txt'), 'a1\n')
writeFileSync(join(REPO, 'both.txt'), 'b1\n')
writeFileSync(join(SUB, '旧名.txt'), 'old\n')
writeFileSync(join(SUB, '删掉.txt'), 'del\n')
g('add', '-A')
g('commit', '-q', '-m', 'init')
// 改动
writeFileSync(join(REPO, 'a.txt'), 'a2\n')
writeFileSync(join(REPO, 'both.txt'), 'b2\n')
g('add', 'both.txt')
writeFileSync(join(REPO, 'both.txt'), 'b3\n')
writeFileSync(join(REPO, 'staged.txt'), 's\n')
g('add', 'staged.txt')
g('mv', '子目录/旧名.txt', '子目录/新名.txt')
rmSync(join(SUB, '删掉.txt'))
writeFileSync(join(SUB, '中文 名.txt'), 'zh\n')
// 恶意 fsmonitor：被执行就会在仓库里写 pwned.txt
g('config', 'core.fsmonitor', 'echo x > pwned.txt')
execFileSync('git', ['init', '-q', '--bare', REMOTE], { windowsHide: true })

mkdirSync(join(SANDBOX, 'mile-warp'), { recursive: true })
const now = Date.now()
const ws = (id, name, cwd, order) => ({ id, groupId: null, name, note: '', agentId: 'shell', agentPath: null, cwd, args: [], envKeys: [], envEnc: null, order, createdAt: now, updatedAt: now })
writeFileSync(
  join(SANDBOX, 'mile-warp', 'config.json'),
  JSON.stringify({
    version: 2,
    groups: [],
    workspaces: [ws('ws-g', '仓库子目录', SUB, 0), ws('ws-n', '非仓库', NOREPO, 1)],
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

setTimeout(() => {
  console.log('\n  FAIL  总超时 120 秒')
  app.exit(3)
}, 120000).unref()

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const js = (code) => win.webContents.executeJavaScript(code, true)
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
  // IPC 调用全部包 catch：rejection 会让 executeJavaScript 一直悬着
  const call = (expr) => js(`(${expr}).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String(e) }))`)
  const probe = (id) => call(`window.warp.git.probe('${id}')`)
  const status = (id) => call(`window.warp.git.status('${id}')`)

  await waitFor(`!!document.querySelector('[data-rail="sessions"]')`)

  console.log('\n=== 1. 总开关默认关 ===')
  const cfg0 = await call(`window.warp.config.get()`)
  check('settings.gitEnabled 默认 false', cfg0.ok && cfg0.v.settings.gitEnabled === false, cfg0.ok ? cfg0.v.settings.gitEnabled : cfg0.e)
  check('settings.gitDefaultRemote 默认 origin', cfg0.ok && cfg0.v.settings.gitDefaultRemote === 'origin')
  const p0 = await probe('ws-g')
  check('关闭时 probe 返回 disabled', p0.ok && p0.v.available === false && p0.v.reason === 'disabled', p0)
  const s0 = await status('ws-g')
  check('关闭时 status 拒绝', !s0.ok && /未启用/.test(s0.e), s0.e)

  console.log('\n=== 2. 设置页 Git 分区 ===')
  await js(`document.querySelector('button[aria-label^="设置"]').click()`)
  await waitFor(`!!document.querySelector('[data-testid="settings-dialog"]')`, 3000)
  check('有 Git 页签', await js(`!!document.querySelector('[data-settings-tab="git"]')`))
  await js(`document.querySelector('[data-settings-tab="git"]').click()`)
  await waitFor(`!!document.querySelector('[data-testid="settings-git-enabled"]')`, 2000)
  check('开关初始为关', (await js(`document.querySelector('[data-testid="settings-git-enabled"]').getAttribute('aria-checked')`)) === 'false')
  check('关着时不显示默认远端', await js(`!document.querySelector('[data-testid="settings-git-remote"]')`))
  await js(`document.querySelector('[data-testid="settings-git-enabled"]').click()`)
  const on = await waitFor(`document.querySelector('[data-testid="settings-git-enabled"]').getAttribute('aria-checked') === 'true'`, 3000)
  check('点开关后变为开', on)
  check('打开后出现默认远端输入框', await waitFor(`!!document.querySelector('[data-testid="settings-git-remote"]')`, 2000))
  const cfg1 = await call(`window.warp.config.get()`)
  check('开关落盘为 true', cfg1.ok && cfg1.v.settings.gitEnabled === true)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  await sleep(300)

  console.log('\n=== 3. 远端名校形 ===')
  for (const bad of ['-x', '--upload-pack=evil', '../evil', 'a b', '']) {
    const r = await call(`window.warp.settings.update({ gitDefaultRemote: ${JSON.stringify(bad)} })`)
    check(`拒绝远端名 ${JSON.stringify(bad)}`, !r.ok, r.ok ? '被接受了' : r.e)
  }
  const goodRemote = await call(`window.warp.settings.update({ gitDefaultRemote: 'up-stream.1' })`)
  check('接受远端名 up-stream.1', goodRemote.ok && goodRemote.v.settings.gitDefaultRemote === 'up-stream.1')
  await call(`window.warp.settings.update({ gitDefaultRemote: 'origin' })`)

  console.log('\n=== 4. probe ===')
  const p1 = await probe('ws-g')
  check('仓库子目录：available', p1.ok && p1.v.available === true, p1)
  check('仓库名为 repo', p1.ok && p1.v.repoName === 'repo', p1.ok ? p1.v.repoName : null)
  check('relativeDir 为「子目录」', p1.ok && p1.v.relativeDir === '子目录', p1.ok ? p1.v.relativeDir : null)
  check('probe 不返回绝对路径', p1.ok && !JSON.stringify(p1.v).includes(SANDBOX.replace(/\\/g, '/')) && !JSON.stringify(p1.v).includes(SANDBOX))
  const pn = await probe('ws-n')
  check('非仓库：not-repo', pn.ok && pn.v.available === false && pn.v.reason === 'not-repo', pn)
  const pu = await probe('ws-none')
  check('未知 workspaceId 拒绝', !pu.ok && /工作区不存在/.test(pu.e), pu.e)
  const pb = await call(`window.warp.git.probe(123)`)
  check('workspaceId 类型不对拒绝', !pb.ok && /不合法/.test(pb.e), pb.e)

  console.log('\n=== 5. status ===')
  const s1 = await status('ws-g')
  check('status 成功', s1.ok, s1.ok ? null : s1.e)
  const st = s1.ok ? s1.v : { files: [] }
  const has = (path, status, staged) => st.files.some((f) => f.path === path && f.status === status && f.staged === staged)
  check('分支 main，非 detached', st.branch === 'main' && st.detached === false, { branch: st.branch, detached: st.detached })
  check('没有上游、没有远端', st.upstream === null && st.hasRemote === false && st.ahead === 0 && st.behind === 0, { upstream: st.upstream, hasRemote: st.hasRemote })
  check('a.txt 未暂存修改', has('a.txt', 'modified', false))
  check('both.txt 已暂存修改', has('both.txt', 'modified', true))
  check('both.txt 未暂存修改（同一文件两行）', has('both.txt', 'modified', false))
  check('staged.txt 已暂存新增', has('staged.txt', 'added', true))
  const ren = st.files.find((f) => f.status === 'renamed')
  check('重命名：路径相对仓库根、带 oldPath、已暂存', !!ren && ren.path === '子目录/新名.txt' && ren.oldPath === '子目录/旧名.txt' && ren.staged === true, ren)
  check('子目录/删掉.txt 未暂存删除', has('子目录/删掉.txt', 'deleted', false))
  check('中文带空格的未跟踪文件原样显示', has('子目录/中文 名.txt', 'untracked', false), st.files.map((f) => f.path))
  check('路径不含反斜杠和 \\3xx 转义', st.files.every((f) => !f.path.includes('\\') && !/\\\d{3}/.test(f.path)))
  // a.txt、both.txt ×2、staged.txt、新名、删掉、中文 名
  check('文件行数正确（7 行）', st.files.length === 7, st.files.length)
  check('恶意 core.fsmonitor 没有被执行', !existsSync(join(REPO, 'pwned.txt')) && !existsSync(join(SUB, 'pwned.txt')))
  check('status 不返回绝对路径', !JSON.stringify(st).includes(SANDBOX) && !JSON.stringify(st).includes(SANDBOX.replace(/\\/g, '/')))

  g('remote', 'add', 'origin', REMOTE)
  const s2 = await status('ws-g')
  check('加了 origin 后 hasRemote 为 true', s2.ok && s2.v.hasRemote === true && s2.v.upstream === null, s2.ok ? { hasRemote: s2.v.hasRemote, upstream: s2.v.upstream } : s2.e)

  const head = g('rev-parse', '--short', 'HEAD').trim()
  g('stash', '-q', '-u')
  g('checkout', '-q', '--detach')
  const s3 = await status('ws-g')
  check('detached HEAD：detached=true、branch 为短哈希', s3.ok && s3.v.detached === true && s3.v.branch === head, s3.ok ? { branch: s3.v.branch, head } : s3.e)
  check('干净工作区 files 为空', s3.ok && s3.v.files.length === 0, s3.ok ? s3.v.files : null)
  g('checkout', '-q', 'main')
  check('多次 status 之后恶意 core.fsmonitor 仍未被执行', !existsSync(join(REPO, 'pwned.txt')) && !existsSync(join(SUB, 'pwned.txt')))

  const sn = await status('ws-n')
  check('非仓库 status 拒绝', !sn.ok, sn.ok ? '居然成功了' : sn.e)

  console.log('\n=== 6. 再关掉开关 ===')
  await call(`window.warp.settings.update({ gitEnabled: false })`)
  const p2 = await probe('ws-g')
  check('关掉后 probe 回到 disabled', p2.ok && p2.v.reason === 'disabled', p2)
  const s4 = await status('ws-g')
  check('关掉后 status 拒绝', !s4.ok && /未启用/.test(s4.e), s4.e)
  const bad = await call(`window.warp.settings.update({ gitEnabled: 'yes' })`)
  check('gitEnabled 非布尔拒绝', !bad.ok, bad.ok ? '被接受了' : bad.e)

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
  console.log(`${pass}/${pass + fail} 通过`)
  app.exit(fail ? 2 : 0)
})
