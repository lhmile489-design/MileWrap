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
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
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
  console.log('\n  FAIL  总超时 300 秒')
  app.exit(3)
}, 300000).unref()

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

  console.log('\n=== 6. G1 IPC：暂存 / 取消 / diff / 丢弃 / 提交 ===')
  const api = (m, ...args) => call(`window.warp.git.${m}(${args.map((a) => JSON.stringify(a)).join(', ')})`)
  const cur = async () => (await status('ws-g')).v
  const find = (s, path, staged) => s.files.find((f) => f.path === path && f.staged === staged)
  const readText = (p) => readFileSync(p, 'utf8')
  writeFileSync(join(REPO, 'a.txt'), 'a9\n')
  writeFileSync(join(REPO, '新 文件.txt'), 'n1\nn2\n')
  writeFileSync(join(SUB, 'x.bin'), Buffer.from([0, 1, 2, 0, 3]))

  check('stage 单个文件', (await api('stage', 'ws-g', ['a.txt'])).ok && !!find(await cur(), 'a.txt', true))
  for (const bad of [['../outside.txt'], ['C:/Windows/win.ini'], ['\\\\server\\share'], ['']]) {
    const r = await api('stage', 'ws-g', bad)
    check(`stage 拒绝 ${JSON.stringify(bad[0])}`, !r.ok, r.ok ? '被接受了' : r.e)
  }
  const nonArr = await call(`window.warp.git.stage('ws-g', 'a.txt')`)
  check('stage 拒绝非数组 paths', !nonArr.ok, nonArr.ok ? '被接受了' : nonArr.e)

  const d1 = await api('diff', 'ws-g', 'a.txt', true)
  check('已暂存 diff：+1 −1', d1.ok && d1.v.added === 1 && d1.v.removed === 1 && d1.v.hunks.length === 1, d1.ok ? { added: d1.v.added, removed: d1.v.removed } : d1.e)
  const types = d1.ok && d1.v.hunks[0] ? d1.v.hunks[0].lines.map((l) => l.type).join(',') : ''
  check('diff 行类型为 removed,added', types === 'removed,added', types)
  const d0 = await api('diff', 'ws-g', 'a.txt', false)
  check('未暂存一侧没有改动时 diff 为空', d0.ok && d0.v.hunks.length === 0, d0.ok ? d0.v : d0.e)
  const dn = await api('diff', 'ws-g', '新 文件.txt', false)
  check('未跟踪文件 diff 为全量新增', dn.ok && dn.v.added === 2 && dn.v.removed === 0 && dn.v.hunks[0].lines.every((l) => l.type === 'added' && l.oldNo === null), dn.ok ? { added: dn.v.added } : dn.e)
  const db = await api('diff', 'ws-g', '子目录/x.bin', false)
  check('二进制未跟踪文件 binary=true', db.ok && db.v.binary === true && db.v.hunks.length === 0, db.ok ? db.v : db.e)
  const dx = await api('diff', 'ws-g', '../outside.txt', false)
  check('diff 拒绝越界路径', !dx.ok, dx.ok ? '被接受了' : dx.e)

  await api('unstage', 'ws-g', ['a.txt'])
  const afterUn = await cur()
  check('unstage 回到未暂存', !!find(afterUn, 'a.txt', false) && !find(afterUn, 'a.txt', true))

  const plan = await api('discardPrepare', 'ws-g', ['a.txt', '新 文件.txt'])
  check('discardPrepare 返回 token 与文件', plan.ok && typeof plan.v.token === 'string' && plan.v.files.length === 2, plan.ok ? plan.v.files : plan.e)
  const fl = plan.ok ? Object.fromEntries(plan.v.files.map((f) => [f.path, f.untracked])) : {}
  check('未跟踪文件标 untracked', fl['a.txt'] === false && fl['新 文件.txt'] === true, fl)
  check('discardPrepare 之后文件仍在（没确认不动）', existsSync(join(REPO, '新 文件.txt')))
  const wrongWs = await api('discard', 'ws-n', plan.ok ? plan.v.token : 'x')
  check('token 换工作区使用被拒', !wrongWs.ok, wrongWs.ok ? '被接受了' : wrongWs.e)
  // 换失败也让 token 作废：重新拿一个
  const plan2 = await api('discardPrepare', 'ws-g', ['a.txt', '新 文件.txt'])
  const dis = await api('discard', 'ws-g', plan2.ok ? plan2.v.token : 'x')
  check('discard 成功', dis.ok, dis.ok ? null : dis.e)
  check('已跟踪文件还原', readText(join(REPO, 'a.txt')) === 'a1\n')
  check('未跟踪文件被删', !existsSync(join(REPO, '新 文件.txt')))
  const again = await api('discard', 'ws-g', plan2.ok ? plan2.v.token : 'x')
  check('token 只能用一次', !again.ok, again.ok ? '被接受了' : again.e)
  const bogus = await api('discard', 'ws-g', 'not-a-token')
  check('伪造 token 被拒', !bogus.ok, bogus.ok ? '被接受了' : bogus.e)
  const clean = await api('discardPrepare', 'ws-g', ['a.txt'])
  check('没有改动的文件不能丢弃', !clean.ok && /没有可丢弃/.test(clean.e), clean.ok ? '被接受了' : clean.e)
  writeFileSync(join(REPO, 'a.txt'), 'a8\n')
  await api('stage', 'ws-g', ['a.txt'])
  const stagedOnly = await api('discardPrepare', 'ws-g', ['a.txt'])
  check('只在暂存区的改动不能丢弃', !stagedOnly.ok, stagedOnly.ok ? '被接受了' : stagedOnly.e)
  rmSync(join(SUB, 'x.bin'))

  const c0 = await api('commit', 'ws-g', '', '')
  check('空摘要拒绝', !c0.ok && /摘要/.test(c0.e), c0.e)
  const c1 = await api('commit', 'ws-g', '第一行\n第二行', '')
  check('多行摘要拒绝', !c1.ok, c1.ok ? '被接受了' : c1.e)
  const c2 = await api('commit', 'ws-g', 'feat: 中文提交', '描述第一段\n\n描述第二段')
  const headHash = g('rev-parse', '--short', 'HEAD').trim()
  check('提交成功，返回 HEAD 短哈希', c2.ok && c2.v.hash === headHash, c2.ok ? { got: c2.v.hash, head: headHash } : c2.e)
  const body = g('log', '-1', '--format=%B').trim()
  check('提交信息含摘要与描述', body === 'feat: 中文提交\n\n描述第一段\n\n描述第二段', body)
  const c3 = await api('commit', 'ws-g', '再来', '')
  check('暂存区为空时拒绝', !c3.ok && /暂存区为空/.test(c3.e), c3.e)

  // Q6：提交照常跑仓库 hooks，失败时把钩子输出带回
  const hook = join(REPO, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\necho "lint failed: hook-says-no" >&2\nexit 1\n')
  writeFileSync(join(REPO, 'a.txt'), 'a7\n')
  // 仓库里多了钩子：没确认信任前，除探测 / 扫描外的命令一律拒绝（审查 2026-11-06 高危项）
  const sg0 = await api('stage', 'ws-g', ['a.txt'])
  check('有未确认的钩子时暂存被拒', !sg0.ok && /确认信任/.test(sg0.e), sg0.ok ? '暂存成功了' : sg0.e)
  const st0 = await api('status', 'ws-g')
  check('有未确认的钩子时 status 也被拒', !st0.ok && /确认信任/.test(st0.e), st0.ok ? 'status 成功了' : st0.e)
  const c4a = await api('commit', 'ws-g', '被钩子拦下', '')
  check('有未确认的钩子时提交被拒（要求先确认信任）', !c4a.ok && /确认信任/.test(c4a.e), c4a.ok ? '提交成功了' : c4a.e)
  const rk = await api('risk', 'ws-g')
  check('risk 列出 pre-commit 钩子', rk.ok && rk.v && rk.v.items.some((x) => x.kind === 'hook' && x.name === 'pre-commit'), rk.ok ? rk.v : rk.e)
  const tBad = await api('trust', 'ws-g', '0'.repeat(64))
  check('指纹对不上时 trust 拒绝', !tBad.ok, tBad.ok ? '被接受了' : tBad.e)
  const tOk = await api('trust', 'ws-g', rk.ok && rk.v ? rk.v.fingerprint : '')
  check('带回正确指纹后 trust 成功', tOk.ok, tOk.ok ? null : tOk.e)
  const rk2 = await api('risk', 'ws-g')
  check('信任后 risk 返回 null', rk2.ok && rk2.v === null, rk2.ok ? rk2.v : rk2.e)
  const sg1 = await api('stage', 'ws-g', ['a.txt'])
  check('信任后暂存放行', sg1.ok, sg1.ok ? null : sg1.e)
  const c4 = await api('commit', 'ws-g', '被钩子拦下', '')
  check('pre-commit 失败时提交被拒，带回钩子输出', !c4.ok && c4.e.includes('hook-says-no'), c4.ok ? '提交成功了' : c4.e)
  // 钩子内容变了：指纹不同，重新要求确认
  writeFileSync(hook, '#!/bin/sh\necho changed >&2\nexit 1\n')
  await sleep(1600)
  const rk3 = await api('risk', 'ws-g')
  check('钩子内容变了之后重新要求确认', rk3.ok && rk3.v !== null && rk3.v.fingerprint !== (rk.ok && rk.v ? rk.v.fingerprint : ''), rk3.ok ? rk3.v : rk3.e)
  rmSync(hook)
  await sleep(1600)
  const rk4 = await api('risk', 'ws-g')
  check('删掉钩子后 risk 回到 null', rk4.ok && rk4.v === null, rk4.ok ? rk4.v : rk4.e)
  await api('unstage', 'ws-g', ['a.txt'])
  const plan3 = await api('discardPrepare', 'ws-g', ['a.txt'])
  if (plan3.ok) await api('discard', 'ws-g', plan3.v.token)
  check('G1 操作后恶意 core.fsmonitor 仍未被执行', !existsSync(join(REPO, 'pwned.txt')) && !existsSync(join(SUB, 'pwned.txt')))

  console.log('\n=== 7. G1 渲染层：右栏 Git 页签 ===')
  const keyG = () =>
    js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyG', key: 'G', bubbles: true, cancelable: true, ctrlKey: true, shiftKey: true })); true`)
  const setInput = (sel, value) =>
    js(`(() => { const el = document.querySelector('${sel}'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  const row = (path, staged) => `[data-git-file="${path}"][data-git-staged="${staged}"]`
  const emptyClean = `document.querySelector('[data-testid="git-empty"]')?.textContent.includes('工作区很干净')`
  const clickRefresh = () => js(`document.querySelector('[data-rail="preview"] button[aria-label="刷新"]').click(); true`)

  check('标题栏出现 Git 按钮', await waitFor(`!!document.querySelector('button[aria-label^="Git 栏"]')`, 3000))
  await js(`document.querySelector('[data-rail="sessions"] [data-workspace-id="ws-g"]').click(); true`)
  await sleep(300)
  await keyG()
  check('Ctrl+Shift+G 打开右栏 Git 页签', await waitFor(`!!document.querySelector('[data-rail="preview"][data-right-tab="git"] [data-testid="git-panel"]')`, 8000))
  check('页签条有「预览」「Git」', (await js(`[...document.querySelectorAll('[data-right-tab-btn]')].map((b) => b.textContent).join(',')`)) === '预览,Git')
  check('栏头显示工作区名', await waitFor(`document.querySelector('[data-testid="git-workspace-name"]')?.textContent === '仓库子目录'`, 3000))
  check('分支 pill 显示 main', await waitFor(`!!document.querySelector('[data-testid="git-branch"]')?.textContent.includes('main')`, 3000))
  check('干净工作区显示空态', await waitFor(emptyClean, 3000))

  writeFileSync(join(REPO, 'a.txt'), 'a6\n')
  await clickRefresh()
  check('刷新后出现未暂存行 a.txt', await waitFor(`!!document.querySelector('${row('a.txt', 'false')}')`, 5000))
  check('徽标为字母 M，带文字标签', (await js(`(() => { const b = document.querySelector('[data-git-file="a.txt"] [data-git-badge]'); return b ? b.textContent + '|' + b.getAttribute('aria-label') : '' })()`)) === 'M|修改')
  check('暂存区为空时提交按钮禁用并说明', await js(`document.querySelector('[data-testid="git-commit-button"]').disabled && !!document.querySelector('[data-testid="git-commit-hint"]')?.textContent.includes('暂存区为空')`))

  await js(`document.querySelector('${row('a.txt', 'false')} button').click(); true`)
  check('点行进 diff 视图', await waitFor(`!!document.querySelector('[data-testid="git-diff"] [data-diff-line="added"]')`, 5000))
  check('diff 统计 +1 −1', (await js(`(document.querySelector('[data-testid="git-diff-stat"]')?.textContent ?? '').replace(/\\s/g, '')`)) === '+1−1')
  await js(`document.querySelector('[data-testid="git-diff"] button[aria-label="暂存"]').click(); true`)
  check('diff 里暂存后视图跟到「已暂存」', await waitFor(`!!document.querySelector('[data-testid="git-diff"]')?.textContent.includes('已暂存')`, 5000))
  await js(`document.querySelector('button[aria-label="返回改动列表"]').click(); true`)
  check('返回列表，a.txt 在已暂存组', await waitFor(`!!document.querySelector('${row('a.txt', 'true')}')`, 3000))

  await setInput('[data-testid="git-commit-summary"]', 'fix: 从界面提交')
  await sleep(200)
  check('草稿按工作区存进 localStorage', (await js(`localStorage.getItem('warp.commitDraft.ws-g') ?? ''`)).includes('从界面提交'))
  check('提交按钮文案「提交 1 个文件」且可点', await js(`(() => { const b = document.querySelector('[data-testid="git-commit-button"]'); return !b.disabled && b.textContent === '提交 1 个文件' })()`))
  await js(`document.querySelector('[data-testid="git-commit-button"]').click(); true`)
  check('提交后回到干净空态', await waitFor(emptyClean, 8000))
  check('git log 里有这次提交', g('log', '-1', '--format=%s').trim() === 'fix: 从界面提交')
  check('提交后草稿清掉', (await js(`localStorage.getItem('warp.commitDraft.ws-g')`)) === null)

  writeFileSync(join(REPO, 'a.txt'), 'a5\n')
  await clickRefresh()
  await waitFor(`!!document.querySelector('${row('a.txt', 'false')}')`, 5000)
  await js(`document.querySelector('${row('a.txt', 'false')} button[aria-label="更多操作"]').click(); true`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('丢弃改动')).click(); true`)
  check('丢弃先弹确认框并列出文件', await waitFor(`!!document.querySelector('[data-testid="confirm-dialog"]')?.textContent.includes('a.txt')`, 3000))
  check('确认前文件没动', readText(join(REPO, 'a.txt')) === 'a5\n')
  await js(`document.querySelector('[data-testid="confirm-ok"]').click(); true`)
  // 上面界面提交已把 a.txt 提成 a6，丢弃后回到 HEAD
  check('确认后改动被丢弃', (await waitFor(emptyClean, 5000)) && readText(join(REPO, 'a.txt')) === 'a6\n', readText(join(REPO, 'a.txt')))

  await js(`document.querySelector('[data-right-tab-btn="preview"]').click(); true`)
  check('点「预览」页签切回预览', await waitFor(`!!document.querySelector('[data-rail="preview"][data-right-tab="preview"]')`, 2000))
  await keyG()
  check('预览页签时 Ctrl+Shift+G 切到 Git', await waitFor(`!!document.querySelector('[data-right-tab="git"]')`, 2000))
  // 第 5 节 stash -u 之后没有 pop，工作树里是 init 时提交的 旧名.txt
  const fileItem = `[data-rail="files"] [role="treeitem"][data-rel="旧名.txt"]`
  const hasItem = await waitFor(`!!document.querySelector('${fileItem}')`, 5000)
  await js(`document.querySelector('${fileItem}')?.click(); true`)
  check(
    '单击目录栏文件切回预览页签',
    hasItem && (await waitFor(`!!document.querySelector('[data-rail="preview"][data-right-tab="preview"]')`, 3000)),
    hasItem ? null : await js(`[...document.querySelectorAll('[data-rail="files"] [role="treeitem"]')].map((x) => x.dataset.rel)`)
  )
  await keyG()
  await waitFor(`!!document.querySelector('[data-right-tab="git"]')`, 2000)
  await keyG()
  check('Git 页签时 Ctrl+Shift+G 收起右栏', await waitFor(`!document.querySelector('[data-rail="preview"]')`, 2000))
  await sleep(600)
  const lay = await call(`window.warp.layout.get()`)
  check('rightRailTab 持久化为 git', lay.ok && lay.v.rightRailTab === 'git', lay.ok ? lay.v.rightRailTab : lay.e)
  const badTab = await call(`window.warp.layout.update({ rightRailTab: 'evil' })`)
  check('layout 拒绝非法 rightRailTab', !badTab.ok, badTab.ok ? '被接受了' : badTab.e)

  console.log('\n=== 7b. G2 IPC：分支 / 远端 ===')
  // 进度推送：渲染层订阅，push 时应收到 op=push 的事件
  await js(`window.__gp = []; window.__gpOff = window.warp.git.onProgress((p) => window.__gp.push(p)); true`)

  const br0 = await api('branches', 'ws-g')
  check('branches 列出 main 且为当前', br0.ok && br0.v[0] && br0.v[0].name === 'main' && br0.v[0].current === true, br0.ok ? br0.v.map((b) => b.name) : br0.e)
  for (const bad of ['-evil', '--orphan', 'a..b', 'x.lock', 'a b', '']) {
    const r = await api('createBranch', 'ws-g', bad)
    check(`createBranch 拒绝 ${JSON.stringify(bad)}`, !r.ok, r.ok ? '被接受了' : r.e)
  }
  const dup = await api('createBranch', 'ws-g', 'main')
  check('createBranch 拒绝已存在的分支', !dup.ok && /已存在/.test(dup.e), dup.e)
  const cb = await api('createBranch', 'ws-g', 'feat/g2')
  check('createBranch feat/g2 并切换', cb.ok && (await cur()).branch === 'feat/g2', cb.ok ? (await cur()).branch : cb.e)
  const br1 = await api('branches', 'ws-g')
  check('当前分支排在最前', br1.ok && br1.v[0].name === 'feat/g2' && br1.v[0].current, br1.ok ? br1.v.map((b) => b.name) : br1.e)
  const co0 = await api('checkout', 'ws-g', 'main')
  check('checkout main', co0.ok && (await cur()).branch === 'main', co0.ok ? null : co0.e)
  const co1 = await api('checkout', 'ws-g', 'nope')
  check('checkout 不存在的分支拒绝', !co1.ok && /没有本地分支/.test(co1.e), co1.e)
  const co2 = await api('checkout', 'ws-g', '--orphan')
  check('checkout 以 - 开头的名字拒绝', !co2.ok && /不合法/.test(co2.e), co2.e)

  // 未提交改动挡住切换：feat/g2 上 a.txt 有不同内容，main 上 a.txt 有未提交改动
  g('switch', '-q', 'feat/g2')
  writeFileSync(join(REPO, 'a.txt'), 'feat\n')
  g('commit', '-qam', 'feat change')
  g('switch', '-q', 'main')
  writeFileSync(join(REPO, 'a.txt'), 'dirty\n')
  const co3 = await api('checkout', 'ws-g', 'feat/g2')
  check('有未提交改动时切换失败并翻成中文', !co3.ok && /未提交的改动/.test(co3.e), co3.e)
  check('切换失败后仍在 main、改动还在', (await cur()).branch === 'main' && readText(join(REPO, 'a.txt')) === 'dirty\n')
  g('checkout', '--', 'a.txt')

  // 首次推送自动设上游（G-24）
  const ps0 = await api('push', 'ws-g')
  const afterPush = await cur()
  check('push 无上游时自动 -u origin main', ps0.ok && afterPush.upstream === 'origin/main', ps0.ok ? afterPush.upstream : ps0.e)
  const remoteHead = execFileSync('git', ['--git-dir', REMOTE, 'rev-parse', 'main'], { encoding: 'utf8' }).trim()
  check('远端 main 与本地一致', remoteHead === g('rev-parse', 'HEAD').trim())
  const gp = await js(`window.__gp.filter((p) => p.workspaceId === 'ws-g' && p.op === 'push').length`)
  check('push 期间收到进度推送', gp > 0, gp)
  const gpBad = await js(`window.__gp.every((p) => typeof p.stage === 'string' && p.percent >= 0 && p.percent <= 100)`)
  check('进度事件字段合法', gpBad)
  await js(`window.__gpOff(); true`)
  const cn = await api('cancel', 'ws-g')
  check('没有远端操作时 cancel 无副作用', cn.ok)

  // 分叉：另一个克隆推了改 a.txt 的提交，本地也提交了不同的 a.txt
  const CLONE = join(SANDBOX, 'clone')
  // 裸仓库是 init --bare 建的，HEAD 指向默认的 master（不存在），clone 必须显式 -b main，否则工作树是空的
  execFileSync('git', ['-c', 'core.fsmonitor=false', 'clone', '-q', '-b', 'main', REMOTE, CLONE], { windowsHide: true })
  const gc = (...a) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'user.name=o', '-c', 'user.email=o@o', '-C', CLONE, ...a], { encoding: 'utf8', windowsHide: true })
  writeFileSync(join(CLONE, 'a.txt'), 'other\n')
  gc('commit', '-qam', 'other side')
  gc('push', '-q', 'origin', 'main')
  writeFileSync(join(REPO, 'a.txt'), 'local\n')
  g('commit', '-qam', 'local side')
  const ft = await api('fetch', 'ws-g')
  const afterFetch = await cur()
  check('fetch 后领先 1 落后 1', ft.ok && afterFetch.ahead === 1 && afterFetch.behind === 1, ft.ok ? { ahead: afterFetch.ahead, behind: afterFetch.behind } : ft.e)
  const ps1 = await api('push', 'ws-g')
  check('分叉时 push 被拒并提示先拉取', !ps1.ok && /先拉取/.test(ps1.e), ps1.e)
  const pl = await api('pull', 'ws-g')
  check('pull 产生冲突时返回 conflict、不抛错', pl.ok && pl.v.conflict === true, pl.ok ? pl.v : pl.e)
  check('冲突文件出现在 status 里', !!find(await cur(), 'a.txt', false) && find(await cur(), 'a.txt', false).status === 'conflict')
  g('merge', '--abort')
  check('merge --abort 后回到干净的分叉状态', (await cur()).files.length === 0)

  // ext:: 传输被白名单挡住：仓库配置放行 ext、远端是任意命令
  g('config', 'protocol.ext.allow', 'always')
  g('remote', 'add', 'evil', 'ext::sh -c touch% pwned-ext')
  await call(`window.warp.settings.update({ gitDefaultRemote: 'evil' })`)
  g('switch', '-q', 'feat/g2')
  const ps2 = await api('push', 'ws-g')
  check('ext:: 远端的推送被拒绝', !ps2.ok, ps2.ok ? '推送成功了' : ps2.e)
  check('ext:: 里的命令没有被执行', !existsSync(join(REPO, 'pwned-ext')) && !existsSync(join(SUB, 'pwned-ext')))
  g('switch', '-q', 'main')
  g('remote', 'remove', 'evil')
  g('config', '--unset', 'protocol.ext.allow')
  await call(`window.warp.settings.update({ gitDefaultRemote: 'origin' })`)
  const nr = await api('push', 'ws-n')
  check('非仓库 push 拒绝', !nr.ok, nr.ok ? '居然成功了' : nr.e)

  console.log('\n=== 7c. G2 渲染层：分支菜单 / 远端按钮 ===')
  await keyG()
  check('重新打开 Git 页签', await waitFor(`!!document.querySelector('[data-right-tab="git"] [data-testid="git-panel"]')`, 5000))
  await clickRefresh()
  check('拉取按钮显示落后数', await waitFor(`!!document.querySelector('[data-testid="git-remote-bar"] button[aria-label="拉取（落后 1）"]')`, 5000))
  check('推送按钮显示领先数', await waitFor(`!!document.querySelector('[data-testid="git-remote-bar"] button[aria-label="推送（领先 1）"]')`, 3000))

  await js(`document.querySelector('[data-testid="git-branch"]').click(); true`)
  check('点分支 pill 打开分支菜单', await waitFor(`!!document.querySelector('[data-testid="git-branch-menu"] [data-git-branch-item="feat/g2"]')`, 5000))
  check('当前分支有勾选标记', await js(`document.querySelector('[data-git-branch-item="main"]')?.closest('[role="option"]')?.getAttribute('aria-selected') === 'true'`))
  await setInput('[data-testid="git-branch-search"]', 'feat')
  check('搜索过滤分支', await waitFor(`[...document.querySelectorAll('[data-git-branch-item]')].map((b) => b.dataset.gitBranchItem).join(',') === 'feat/g2'`, 2000))
  await setInput('[data-testid="git-branch-search"]', '')
  await setInput('[data-testid="git-branch-new"]', '-bad')
  await js(`document.querySelector('[data-testid="git-branch-menu"] button[aria-label="新建分支"]').click(); true`)
  check('非法分支名在菜单里报错', await waitFor(`!!document.querySelector('[data-testid="git-branch-error"]')?.textContent.includes('不合法')`, 3000))
  await setInput('[data-testid="git-branch-new"]', 'ui-branch')
  await js(`document.querySelector('[data-testid="git-branch-menu"] button[aria-label="新建分支"]').click(); true`)
  check('新建分支后菜单关闭、pill 显示新分支', await waitFor(`!document.querySelector('[data-testid="git-branch-menu"]') && document.querySelector('[data-testid="git-branch"]')?.textContent.includes('ui-branch')`, 5000))
  check('新分支没有上游时按钮写「推送并设为上游」', await waitFor(`!!document.querySelector('[data-testid="git-remote-bar"] button[aria-label="推送并设为上游"]')`, 3000))
  await js(`document.querySelector('[data-testid="git-remote-bar"] button[aria-label="推送并设为上游"]').click(); true`)
  check('界面推送后分支有上游', await waitFor(`document.querySelector('[data-testid="git-branch"]')?.title === '上游 origin/ui-branch'`, 10000))
  check('远端出现 ui-branch', execFileSync('git', ['--git-dir', REMOTE, 'branch', '--list', 'ui-branch'], { encoding: 'utf8' }).includes('ui-branch'))

  await js(`document.querySelector('[data-testid="git-branch"]').click(); true`)
  await waitFor(`!!document.querySelector('[data-git-branch-item="main"]')`, 5000)
  await js(`document.querySelector('[data-git-branch-item="main"]').click(); true`)
  check('从菜单切回 main', await waitFor(`!document.querySelector('[data-testid="git-branch-menu"]') && document.querySelector('[data-testid="git-branch"]')?.textContent.includes('main')`, 5000))
  check('git 里当前分支也是 main', g('branch', '--show-current').trim() === 'main')

  console.log('\n=== 7d. G3 IPC：历史 / 提交详情 / 提交内文件 diff ===')
  // 先造 55 个空提交测分页，再造三个带中文路径的提交：新增 → 重命名 → 改内容
  for (let i = 0; i < 55; i++) g('commit', '-q', '--allow-empty', '-m', `空提交 ${i}`)
  writeFileSync(join(SUB, '历史 文件.txt'), 'h1\n')
  g('add', '--', '子目录/历史 文件.txt')
  g('commit', '-q', '-m', 'hist: 中文路径')
  g('mv', '子目录/历史 文件.txt', '子目录/历史 改名.txt')
  g('commit', '-q', '-m', 'hist: 改名')
  writeFileSync(join(SUB, '历史 改名.txt'), 'h1\nh2\n')
  g('commit', '-q', '-am', 'hist: 改内容')
  const headFull = g('rev-parse', 'HEAD').trim()
  const addHash = g('rev-parse', 'HEAD~2').trim()
  const renHash = g('rev-parse', 'HEAD~1').trim()

  const lg = await api('log', 'ws-g', 0, 50)
  check('log 第一页 50 条且 hasMore', lg.ok && lg.v.commits.length === 50 && lg.v.hasMore === true, lg.ok ? { n: lg.v.commits.length, more: lg.v.hasMore } : lg.e)
  check('log 第一条是 HEAD', lg.ok && lg.v.commits[0].hash === headFull && lg.v.commits[0].subject === 'hist: 改内容', lg.ok ? lg.v.commits[0] : null)
  check('log 带分支引用', lg.ok && lg.v.commits[0].refs.includes('main'), lg.ok ? lg.v.commits[0].refs : null)
  const lg2 = await api('log', 'ws-g', 50, 50)
  check('log 第二页接着往下', lg2.ok && lg2.v.commits.length > 0 && !lg2.v.commits.some((c) => lg.v.commits.some((x) => x.hash === c.hash)), lg2.ok ? lg2.v.commits.length : lg2.e)
  // 夹取要在提交数 > 100 时才测得出：临时分支上补足空提交，测完切回 main 并删掉（不影响后面的用例）
  g('switch', '-q', '-c', 'g3-many')
  const have = Number(g('rev-list', '--count', 'HEAD').trim())
  for (let i = have; i < 120; i++) g('commit', '-q', '--allow-empty', '-m', `empty ${i}`)
  const lgBig = await api('log', 'ws-g', 0, 100000)
  check('log limit 夹到 100', lgBig.ok && lgBig.v.commits.length === 100 && lgBig.v.hasMore === true, lgBig.ok ? { n: lgBig.v.commits.length, hasMore: lgBig.v.hasMore } : lgBig.e)
  g('switch', '-q', 'main')
  g('branch', '-q', '-D', 'g3-many')
  const lgBad = await call(`window.warp.git.log('ws-g', -5, 'x')`)
  check('log 非法 offset / limit 用默认值', lgBad.ok && lgBad.v.commits.length === 50, lgBad.ok ? lgBad.v.commits.length : lgBad.e)

  const dAdd = await api('commitDetail', 'ws-g', addHash)
  const fAdd = dAdd.ok ? dAdd.v.files.find((f) => f.path === '子目录/历史 文件.txt') : null
  check('提交详情：中文路径原样、新增 +1', !!fAdd && fAdd.status === 'added' && fAdd.added === 1 && fAdd.removed === 0, dAdd.ok ? dAdd.v.files : dAdd.e)
  check('提交详情：完整哈希、短哈希、作者', dAdd.ok && dAdd.v.hash === addHash && addHash.startsWith(dAdd.v.shortHash) && dAdd.v.author === 'warp-test')
  const dRen = await api('commitDetail', 'ws-g', renHash)
  const fRen = dRen.ok ? dRen.v.files[0] : null
  check('提交详情：重命名带 oldPath', !!fRen && fRen.status === 'renamed' && fRen.path === '子目录/历史 改名.txt' && fRen.oldPath === '子目录/历史 文件.txt', dRen.ok ? dRen.v.files : dRen.e)
  const dShort = await api('commitDetail', 'ws-g', headFull.slice(0, 8))
  check('提交详情接受短哈希', dShort.ok && dShort.v.hash === headFull, dShort.ok ? dShort.v.hash : dShort.e)
  for (const bad of ['-x', '--output=evil', 'HEAD~1', 'zzzz', '', 'deadbeefdeadbeef']) {
    const r = await call(`window.warp.git.commitDetail('ws-g', ${JSON.stringify(bad)})`)
    check(`提交详情拒绝 ${JSON.stringify(bad)}`, !r.ok, r.ok ? '被接受了' : r.e)
  }

  const cfd = await api('commitFileDiff', 'ws-g', headFull, '子目录/历史 改名.txt')
  check('提交内文件 diff：+1 −0', cfd.ok && cfd.v.added === 1 && cfd.v.removed === 0, cfd.ok ? { added: cfd.v.added, removed: cfd.v.removed } : cfd.e)
  const cfdAdd = await api('commitFileDiff', 'ws-g', addHash, '子目录/历史 文件.txt')
  check('根提交之后的新增文件 diff', cfdAdd.ok && cfdAdd.v.added === 1, cfdAdd.ok ? cfdAdd.v.added : cfdAdd.e)
  const cfdEsc = await call(`window.warp.git.commitFileDiff('ws-g', ${JSON.stringify(headFull)}, '../outside.txt')`)
  check('提交内文件 diff 拒绝越界路径', !cfdEsc.ok && /越出/.test(cfdEsc.e), cfdEsc.e)
  const cfdAbs = await call(`window.warp.git.commitFileDiff('ws-g', ${JSON.stringify(headFull)}, 'C:/Windows/win.ini')`)
  check('提交内文件 diff 拒绝绝对路径', !cfdAbs.ok, cfdAbs.ok ? '被接受了' : cfdAbs.e)

  console.log('\n=== 7e. G-18 目录栏改动标记 / G-17 改动文件跳转 ===')
  writeFileSync(join(SUB, '标记.txt'), 'm\n')
  writeFileSync(join(SUB, '历史 改名.txt'), 'h1\nh2\nh3\n')
  await clickRefresh()
  await js(`document.querySelector('[data-rail="files"] button[aria-label^="刷新"]')?.click(); true`)
  const markU = `[data-rail="files"] [role="treeitem"][data-rel="标记.txt"] [data-git-mark="U"]`
  const markM = `[data-rail="files"] [role="treeitem"][data-rel="历史 改名.txt"] [data-git-mark="M"]`
  check('目录栏给未跟踪文件标 U', await waitFor(`!!document.querySelector('${markU}')`, 8000))
  check('目录栏给修改的文件标 M', await waitFor(`!!document.querySelector('${markM}')`, 5000))
  check('标记带文字说明（不只靠颜色）', (await js(`document.querySelector('${markU}')?.getAttribute('aria-label') ?? ''`)) === 'Git：未跟踪')

  const gitRow = row('子目录/标记.txt', 'false')
  await waitFor(`!!document.querySelector('${gitRow}')`, 5000)
  await js(`(() => { const el = document.querySelector('${gitRow}'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 })); return true })()`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  const menuLabels = await js(`[...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.trim())`)
  check('改动文件右键菜单有预览 / 定位 / 资源管理器', ['预览文件', '在目录栏中定位', '在资源管理器中显示'].every((l) => menuLabels.includes(l)), menuLabels)
  await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('预览文件')).click(); true`)
  check('「预览文件」切到预览页签并打开该文件', await waitFor(`!!document.querySelector('[data-rail="preview"][data-right-tab="preview"]') && !!document.querySelector('[data-testid="preview-text"]')?.textContent.includes('m')`, 5000))
  await keyG()
  await waitFor(`!!document.querySelector('${gitRow}')`, 5000)
  await js(`(() => { const el = document.querySelector('${gitRow}'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 })); return true })()`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('在目录栏中定位')).click(); true`)
  check('「在目录栏中定位」选中目录栏里的该文件', await waitFor(`document.querySelector('[data-rail="files"] [role="treeitem"][data-rel="标记.txt"]')?.getAttribute('aria-selected') === 'true'`, 5000))
  // 父目录超过 300 项（目录栏每批只渲染 300 项）：定位排在后面的文件，要自动扩到能露出它
  const BIG = join(SUB, '大目录')
  mkdirSync(BIG, { recursive: true })
  for (let i = 0; i < 350; i++) writeFileSync(join(BIG, `f${String(i).padStart(3, '0')}.txt`), 'x\n')
  g('add', '--', '子目录/大目录')
  g('commit', '-q', '-m', 'big dir')
  writeFileSync(join(BIG, 'f349.txt'), 'changed\n')
  await clickRefresh()
  const bigRow = row('子目录/大目录/f349.txt', 'false')
  await waitFor(`!!document.querySelector('${bigRow}')`, 5000)
  await js(`(() => { const el = document.querySelector('${bigRow}'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 })); return true })()`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes('在目录栏中定位')).click(); true`)
  check(
    '父目录超过 300 项时也能定位到第 350 个文件',
    await waitFor(`document.querySelector('[data-rail="files"] [role="treeitem"][data-rel="大目录/f349.txt"]')?.getAttribute('aria-selected') === 'true'`, 5000)
  )
  // 还原：撤掉这次提交，目录随之删掉，后面的历史用例不受影响
  g('reset', '-q', '--hard', 'HEAD~1')
  rmSync(BIG, { recursive: true, force: true })
  // 仓库根下、工作区目录外的文件：跳转项置灰
  writeFileSync(join(REPO, '根外.txt'), 'x\n')
  await clickRefresh()
  const outRow = row('根外.txt', 'false')
  await waitFor(`!!document.querySelector('${outRow}')`, 5000)
  await js(`(() => { const el = document.querySelector('${outRow}'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 })); return true })()`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  check('工作区目录外的文件，预览 / 定位置灰', await js(`[...document.querySelectorAll('[role="menuitem"]')].filter((b) => /预览文件|在目录栏中定位/.test(b.textContent)).every((b) => b.disabled)`))
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  await sleep(200)
  rmSync(join(REPO, '根外.txt'))
  rmSync(join(SUB, '标记.txt'))
  g('checkout', '--', '子目录/历史 改名.txt')
  await clickRefresh()
  await js(`document.querySelector('[data-rail="files"] button[aria-label^="刷新"]')?.click(); true`)
  check('改动清掉后标记消失', await waitFor(`!document.querySelector('[data-rail="files"] [data-git-mark]')`, 8000))

  console.log('\n=== 7f. G3 渲染层：Git 工作台 ===')
  await js(`document.querySelector('[data-rail="preview"] button[aria-label="展开 Git 工作台"]').click(); true`)
  check('栏头「展开」打开工作台改动页', await waitFor(`!!document.querySelector('[data-testid="git-workbench"] [data-testid="git-workbench-changes"]')`, 8000))
  await js(`document.querySelector('[data-workbench-tab="history"]').click(); true`)
  check('历史页第一条是 HEAD', await waitFor(`document.querySelector('[data-testid="git-history-list"] [data-commit]')?.dataset.commit === ${JSON.stringify(headFull)}`, 8000))
  check('历史页第一页 50 条', (await js(`document.querySelectorAll('[data-testid="git-history-list"] [data-commit]').length`)) === 50)
  await js(`document.querySelector('[data-testid="git-history-more"]').click(); true`)
  check('「加载更多」追加下一页', await waitFor(`document.querySelectorAll('[data-testid="git-history-list"] [data-commit]').length > 50`, 5000))
  check('默认选中第一条并显示详情', await waitFor(`document.querySelector('[data-testid="git-commit-subject"]')?.textContent === 'hist: 改内容'`, 5000))
  await js(`document.querySelector('[data-commit-file="子目录/历史 改名.txt"]').click(); true`)
  check('点提交里的文件显示该提交的 diff', await waitFor(`!!document.querySelector('[data-testid="git-commit-detail"] [data-diff-line="added"]')`, 5000))
  await js(`document.querySelector('[data-commit="${renHash}"]').click(); true`)
  check('切到重命名提交', await waitFor(`document.querySelector('[data-testid="git-commit-subject"]')?.textContent === 'hist: 改名'`, 5000))
  check('重命名文件显示 R 徽标', await waitFor(`document.querySelector('[data-commit-file="子目录/历史 改名.txt"] [aria-label="重命名"]')?.textContent === 'R'`, 3000))
  await js(`document.querySelector('[data-testid="git-copy-hash"]').click(); true`)
  check('复制哈希写入完整哈希', await waitFor(`window.warp.clipboard.read().then((t) => t === ${JSON.stringify(renHash)})`, 3000))
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  check('Esc 关闭工作台', await waitFor(`!document.querySelector('[data-testid="git-workbench"]')`, 3000))

  console.log('\n=== 7g. G-06 工作区右键「Git…」/ G-05 格头分支 pill ===')
  await js(`document.querySelector('[data-right-tab-btn="preview"]')?.click(); true`)
  await waitFor(`!!document.querySelector('[data-rail="preview"][data-right-tab="preview"]')`, 2000)
  await js(`(() => { const el = document.querySelector('[data-rail="sessions"] [data-workspace-id="ws-g"]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })); return true })()`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  const hasGitItem = await js(`[...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.trim() === 'Git…')`)
  check('工作区右键菜单有「Git…」', hasGitItem)
  if (hasGitItem) await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === 'Git…').click(); true`)
  check('「Git…」把右栏切到 Git 页签', await waitFor(`!!document.querySelector('[data-rail="preview"][data-right-tab="git"] [data-testid="git-panel"]')`, 5000))

  await js(`document.querySelector('[data-right-tab-btn="preview"]')?.click(); true`)
  await js(`(() => { const el = document.querySelector('[data-rail="sessions"] [data-workspace-id="ws-g"]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })); return true })()`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === '新建会话')?.click(); true`)
  const pill = await waitFor(`!!document.querySelector('[data-testid="cell-branch"]')`, 10000)
  check('Git 开启时格头分支 pill 是按钮', pill)
  if (pill) await js(`document.querySelector('[data-testid="cell-branch"]').click(); true`)
  check('点格头分支 pill 打开 Git 栏', pill && (await waitFor(`!!document.querySelector('[data-rail="preview"][data-right-tab="git"]')`, 3000)))

  console.log('\n=== 7h. 风险确认：仓库里有会执行命令的配置 ===')
  // 植入：clean 过滤器（status 会执行）+ receivepack（push 会执行）。被执行就会写 clean-ran
  const cleanMark = join(SANDBOX, 'clean-ran').replace(/\\/g, '/')
  writeFileSync(join(REPO, '.gitattributes'), '*.risk filter=pwn\n')
  writeFileSync(join(REPO, 'x.risk'), 'r1\n')
  g('config', 'filter.pwn.clean', `sh -c 'touch ${cleanMark}; cat'`)
  g('config', 'remote.origin.receivepack', 'evil-receive-pack')
  await js(`document.querySelector('[data-right-tab-btn="git"]')?.click(); true`)
  await waitFor(`!!document.querySelector('[data-rail="preview"][data-right-tab="git"] [data-testid="git-panel"]')`, 5000)
  await sleep(1600)
  await clickRefresh()
  check('Git 栏显示风险确认面板', await waitFor(`!!document.querySelector('[data-testid="git-risk"]')`, 5000))
  const riskNames = await js(`[...document.querySelectorAll('[data-testid="git-risk-items"] li')].map((li) => li.textContent).join('|')`)
  check('面板列出 filter.pwn.clean 与 remote.origin.receivepack', riskNames.includes('filter.pwn.clean') && riskNames.includes('remote.origin.receivepack'), riskNames)
  check('面板显示时没有改动列表与提交框', await js(`!document.querySelector('[data-testid="git-commit-box"]') && !document.querySelector('[data-git-group]')`))
  check('确认前 clean 过滤器没有被执行', !existsSync(cleanMark))
  const stBlocked = await status('ws-g')
  check('确认前 status 被主进程拒绝', !stBlocked.ok && /确认信任/.test(stBlocked.e), stBlocked.ok ? '成功了' : stBlocked.e)
  const psBlocked = await api('push', 'ws-g')
  check('确认前 push 被主进程拒绝', !psBlocked.ok && /确认信任/.test(psBlocked.e), psBlocked.ok ? '成功了' : psBlocked.e)
  const coBlocked = await api('checkout', 'ws-g', 'feat/g2')
  check('确认前切分支被主进程拒绝', !coBlocked.ok && /确认信任/.test(coBlocked.e), coBlocked.ok ? '成功了' : coBlocked.e)
  const markLoad = await js(`window.warp.git.risk('ws-g').then((r) => !!r)`)
  check('目录栏标记加载同样先查风险（risk 非空）', markLoad === true)
  check('目录栏没有改动标记', await js(`!document.querySelector('[data-rail="files"] [data-git-mark]')`))
  await js(`document.querySelector('[data-testid="git-risk-trust"]').click(); true`)
  check('点「信任」后面板消失、出现改动列表', await waitFor(`!document.querySelector('[data-testid="git-risk"]') && !!document.querySelector('[data-git-file="x.risk"]')`, 8000))
  check('信任后 status 可用', (await status('ws-g')).ok)
  // 改了配置值：指纹变了，重新要求确认
  g('config', 'remote.origin.receivepack', 'evil-2')
  await sleep(1600)
  await clickRefresh()
  check('配置变了之后重新出现确认面板', await waitFor(`!!document.querySelector('[data-testid="git-risk"]')`, 5000))
  // 清理：去掉植入的配置与文件，回到干净仓库
  g('config', '--unset', 'filter.pwn.clean')
  g('config', '--unset', 'remote.origin.receivepack')
  rmSync(join(REPO, '.gitattributes'))
  rmSync(join(REPO, 'x.risk'))
  await sleep(1600)
  await clickRefresh()
  check('去掉风险配置后面板消失', await waitFor(`!document.querySelector('[data-testid="git-risk"]')`, 5000))
  rmSync(cleanMark, { force: true })

  console.log('\n=== 8. 再关掉开关 ===')
  // 走设置页开关（用户路径）：直接调 window.warp.settings.update 不会更新渲染层的配置 store
  await js(`document.querySelector('button[aria-label^="设置"]').click(); true`)
  await waitFor(`!!document.querySelector('[data-settings-tab="git"]')`, 3000)
  await js(`document.querySelector('[data-settings-tab="git"]').click(); true`)
  await waitFor(`!!document.querySelector('[data-testid="settings-git-enabled"]')`, 2000)
  await js(`document.querySelector('[data-testid="settings-git-enabled"]').click(); true`)
  await waitFor(`document.querySelector('[data-testid="settings-git-enabled"]').getAttribute('aria-checked') === 'false'`, 3000)
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  await sleep(300)
  const p2 = await probe('ws-g')
  check('关掉后 probe 回到 disabled', p2.ok && p2.v.reason === 'disabled', p2)
  const s4 = await status('ws-g')
  check('关掉后 status 拒绝', !s4.ok && /未启用/.test(s4.e), s4.e)
  const bad = await call(`window.warp.settings.update({ gitEnabled: 'yes' })`)
  const sg = await call(`window.warp.git.stage('ws-g', [])`)
  check('关掉后 stage 拒绝', !sg.ok && /未启用/.test(sg.e), sg.e)
  check('关掉后标题栏 Git 按钮消失', await waitFor(`!document.querySelector('button[aria-label^="Git 栏"]')`, 3000))
  check('gitEnabled 非布尔拒绝', !bad.ok, bad.ok ? '被接受了' : bad.e)

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
  console.log(`${pass}/${pass + fail} 通过`)
  app.exit(fail ? 2 : 0)
}).catch((e) => {
  // harness 自己抛错（夹具 git 命令失败等）：立即判失败退出，不挂到总超时
  console.log(`\n  FAIL  harness 异常 — ${e && e.stack ? e.stack : e}`)
  console.log(`${pass}/${pass + fail + 1} 通过`)
  app.exit(4)
})
