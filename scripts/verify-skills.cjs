/**
 * Skills 管理验收（Skills管理-PRD）。
 *
 * 沙箱 HOME 下造三个 skill 根目录：
 *   .claude/skills/diag/SKILL.md        正常 frontmatter（name: diag）
 *   .claude/skills/中文技能/SKILL.md    中文目录名 + 无 frontmatter（name 用目录名）
 *   .claude/skills/分组/子技能/SKILL.md 两级布局（分组目录下沉）
 *   .codex/skills/diag/SKILL.md         同名 skill（跨根对照 + 冲突用例）
 *   .agents/skills/link-escape          悬空 symlink（扫描跳过）
 *   escape-link → HOME 外（越界 detail/uninstall 拒绝用，经由构造 name 攻击）
 *
 * 覆盖：
 *   1. IPC：skills.scan（计数 / frontmatter / 中文名 / 两级布局 / 悬空链接）、
 *      detail（正文 / frontmatter 剥离 / 越界 name 拒绝 / 多级 name 拒绝）、
 *      uninstall（builtin 拒绝、删目录）、installTo（复制 / skip / rename 留 .bak / 未知目标拒绝）
 *   2. 渲染层：Ctrl+Shift+S 开弹窗、列表渲染、搜索过滤、详情渲染 .md-body、Esc 关闭
 *
 *   npm run build
 *   npx electron scripts/verify-skills.cjs 2>&1 | tee log
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, existsSync, rmSync, readdirSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const HOME = mkdtempSync(join(tmpdir(), 'warp-skills-'))
// SkillsService 用 homedir() 定位 skill 根；harness 里把整个 HOME 换掉（含 appData 隔离）
app.setPath('appData', join(HOME, 'appdata'))
process.env.USERPROFILE = HOME

/* ---------- M3 夹具：本地 http 服务模拟 codeload（harness 不依赖外网） ---------- */
const http = require('node:http')
const T = tmpdir()
const GOOD_TAR = join(T, 'demo-repo.tar.gz')
const GOOD_ZIP = join(T, 'good-skill.zip')
const EVIL_ZIP = join(T, 'zipslip.zip')
// tar.gz 没造出来就现造（依赖脚本跑过一次；这里兜底保证独立可跑）
if (!existsSync(GOOD_TAR) || !existsSync(GOOD_ZIP) || !existsSync(EVIL_ZIP)) {
  const { execSync } = require('node:child_process')
  const AdmZip = require(join(ROOT, 'node_modules', 'adm-zip'))
  const gz = mkdtempSync(join(T, 'fx-'))
  mkdirSync(join(gz, 'demo-repo-main', 'packaged-skill'), { recursive: true })
  writeFileSync(join(gz, 'demo-repo-main', 'packaged-skill', 'SKILL.md'), '---\nname: packaged-skill\ndescription: gh 安装验收\n---\n\n# T\n', 'utf8')
  execSync(`C:\\Windows\\System32\\tar.exe -czf "${GOOD_TAR}" -C "${gz}" demo-repo-main`)
  const zp = mkdtempSync(join(T, 'fx2-'))
  mkdirSync(join(zp, 'my-skill'), { recursive: true })
  writeFileSync(join(zp, 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: zip 安装验收\n---\n\n# Z\n', 'utf8')
  const zipGood = new (require(join(ROOT, 'node_modules', 'adm-zip')))()
  zipGood.addLocalFolder(join(zp, 'my-skill'), 'my-skill')
  zipGood.writeZip(GOOD_ZIP)
  const zipEvil = new (require(join(ROOT, 'node_modules', 'adm-zip')))()
  // adm-zip 的 addFile 会把 '../evil.txt' 规范化成 'evil.txt'（打包时），
  // 所以 zip-slip 夹具必须手写 zip 二进制让 entryName 字面保留 ../ ——见下方 buildEvilZip()
  writeFileSync(EVIL_ZIP, buildEvilZip([
    { name: '../evil.txt', data: Buffer.from('pwned') },
    { name: 'good/SKILL.md', data: Buffer.from('---\nname: good\n---\n\n# G\n') }
  ]))
}
/** 手写 ustar 归档（gzip）：Windows 上建的符号链接打包后变普通文件，链接条目只能手造（typeflag '2'） */
function buildTarGz(entries) {
  const blocks = []
  for (const e of entries) {
    const h = Buffer.alloc(512)
    const data = e.data || Buffer.alloc(0)
    h.write(e.name, 0, 100, 'utf8')
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    h.write('00000000000\0', 136)
    h.write('        ', 148)
    h.write(e.type || '0', 156)
    if (e.link) h.write(e.link, 157, 100, 'utf8')
    h.write('ustar\0', 257); h.write('00', 263)
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return require('node:zlib').gzipSync(Buffer.concat(blocks))
}
const LINK_TAR = buildTarGz([
  { name: 'link-repo-main/', type: '5' },
  { name: 'link-repo-main/link-skill/', type: '5' },
  { name: 'link-repo-main/link-skill/SKILL.md', data: Buffer.from('---\nname: link-skill\n---\n') },
  { name: 'link-repo-main/link-skill/escape', type: '2', link: 'C:/Windows/System32' }
])
// 文件名本身带 " -> " 的正常归档：预检按名单比对，不能误判成链接
const ARROW_TAR = buildTarGz([
  { name: 'arrow-repo-main/', type: '5' },
  { name: 'arrow-repo-main/arrow-skill/', type: '5' },
  { name: 'arrow-repo-main/arrow-skill/SKILL.md', data: Buffer.from('---\nname: arrow-skill\n---\n') },
  { name: 'arrow-repo-main/arrow-skill/weird -> name.txt', data: Buffer.from('ok') }
])
// 条目名含冒号（NTFS 备用数据流）：必须拒
const ADS_TAR = buildTarGz([
  { name: 'ads-repo-main/', type: '5' },
  { name: 'ads-repo-main/ads-skill/', type: '5' },
  { name: 'ads-repo-main/ads-skill/SKILL.md', data: Buffer.from('---\nname: ads-skill\n---\n') },
  { name: 'ads-repo-main/ads-skill/notes.txt:hidden', data: Buffer.from('hidden') }
])
const codeload = http.createServer((req, res) => {
  const extra = { '/demo-owner/arrow-repo/tar.gz/HEAD': ARROW_TAR, '/demo-owner/ads-repo/tar.gz/HEAD': ADS_TAR }[req.url]
  if (extra) {
    res.writeHead(200, { 'content-type': 'application/x-gzip' })
    res.end(extra)
    return
  }
  if (req.url === '/demo-owner/link-repo/tar.gz/HEAD') {
    res.writeHead(200, { 'content-type': 'application/x-gzip' })
    res.end(LINK_TAR)
    return
  }
  // codeload.github.com/owner/repo/tar.gz/HEAD
  if (req.url === '/demo-owner/demo-repo/tar.gz/HEAD') {
    const { readFileSync } = require('node:fs')
    res.writeHead(200, { 'content-type': 'application/x-gzip' })
    res.end(readFileSync(GOOD_TAR))
    return
  }
  res.writeHead(404)
  res.end()
})
let CODELOAD_PORT = 0
const codeloadReady = new Promise((r) => codeload.listen(0, '127.0.0.1', () => {
  CODELOAD_PORT = codeload.address().port
  r()
}))

/** 手写 zip 二进制（stored 模式）：entryName 字面保留 ../，绕过 adm-zip 打包时的路径规范化 */
function buildEvilZip(entries) {
  const crc32 = (buf) => { let c, crc = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 0xFF; for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c } return (crc ^ 0xFFFFFFFF) >>> 0 }
  const chunks = [], central = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name)
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(e.data.length, 18); local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, e.data)
    const cd = Buffer.alloc(46)
    // e.attr：外部属性（高 16 位 unix mode，造符号链接条目用）；e.declared：中央目录里谎报的解压大小（造炸弹用）
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(e.attr != null ? 0x0314 : 20, 4); cd.writeUInt16LE(20, 6)
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(e.data.length, 20); cd.writeUInt32LE(e.declared ?? e.data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE((e.attr ?? 0) >>> 0, 38); cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += local.length + nameBuf.length + e.data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cdBuf, eocd])
}
// 劫持 codeload 域名：harness 里把 installGithub 的请求改走本地。Electron 主进程 dns 默认解析真域名，
// 这里直接改 hosts 不可行 → 用 MILE_WARP_CODELOAD_OVERRIDE 环境变量让 githubInstall 支持测试覆盖
codeloadReady.then(() => {
  process.env.MILE_WARP_CODELOAD_OVERRIDE = `http://127.0.0.1:${CODELOAD_PORT}`
})

const mkSkill = (root, dir, body, name) => {
  mkdirSync(join(HOME, root, dir), { recursive: true })
  writeFileSync(join(HOME, root, dir, 'SKILL.md'), body, 'utf8')
}

mkSkill('.claude/skills', 'diag', `---
name: diag
description: 用于验收的诊断技能，含中文描述。
---

# Diag

正文标题一。

- 列表项
`, 'diag')
mkSkill('.claude/skills', '中文技能', '# 无 frontmatter\n\n直接正文。\n')
mkdirSync(join(HOME, '.claude/skills/分组'), { recursive: true })
mkSkill('.claude/skills/分组', '子技能', '---\nname: sub-skill\ndescription: 两级布局\n---\n\n# Sub\n')
mkSkill('.codex/skills', 'diag', `---
name: diag
description: codex 侧的同名技能。
---

# Diag Codex
`)
// 悬空 symlink：statSync 抛错 → 扫描跳过不炸
mkdirSync(join(HOME, '.agents/skills'), { recursive: true })
try {
  symlinkSync(join(HOME, 'no-such-target'), join(HOME, '.agents/skills', 'link-escape'), 'junction')
} catch {
  // 某些环境建 junction 失败，跳过该用例的前提
}
// 全局仓一个真 skill（agent 筛选栏要有 agents chip）
mkSkill('.agents/skills', 'global-skill', '---\nname: global-skill\ndescription: 全局仓的技能\n---\n\n# G\n')

mkdirSync(join(HOME, 'appdata', 'mile-warp'), { recursive: true })
writeFileSync(join(HOME, 'appdata', 'mile-warp', 'config.json'), JSON.stringify({ version: 2, groups: [], workspaces: [], customAgents: [], settings: {}, sessionRecords: [], layoutPresets: [] }), 'utf8')

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
  key(el, key) { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }
}
true
`

app.whenReady().then(async () => {
  await codeloadReady
  const win = BrowserWindow.getAllWindows()[0]
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const waitFor = async (code, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) {
      try {
        if (await js(code)) return true
      } catch {
        // 渲染层未就绪
      }
      await sleep(100)
    }
    return false
  }
  await waitFor(`!!document.querySelector('[data-rail="sessions"]')`)
  await js(HELPERS)
  // IPC 错误断言统一包 catch，rejection 会卡住 executeJavaScript
  const caught = (expr) => js(`${expr}.then((v) => ({ ok: v })).catch((e) => ({ err: String(e) }))`)

  console.log('\n=== 1. skills.scan ===')
  const scan = await caught(`window.warp.skills.scan()`)
  check('scan 成功返回', scan.ok != null, scan.err)
  const skills = scan.ok?.skills ?? []
  const byId = (id, name) => skills.find((s) => s.agentId === id && s.name === name)
  check('claude 根扫到 diag', byId('claude', 'diag') != null, skills.length)
  check('中文目录名（无 frontmatter → 用目录名）', byId('claude', '中文技能') != null)
  check('两级布局下沉（sub-skill）', byId('claude', 'sub-skill') != null)
  check('codex 根扫到同名 diag', byId('codex', 'diag') != null)
  check('悬空 symlink 跳过（link-escape 不在结果里）', !skills.some((s) => s.name === 'link-escape'))
  check('diag 的描述来自 frontmatter', (byId('claude', 'diag')?.description ?? '').includes('诊断'))
  check('中文技能 rel 是目录名本身', byId('claude', '中文技能')?.rel === '中文技能')
  check('sub-skill rel 是两级磁盘路径', byId('claude', 'sub-skill')?.rel === '分组/子技能', byId('claude', 'sub-skill')?.rel)

  console.log('\n=== 2. skills.detail ===')
  const detail = await caught(`window.warp.skills.detail('claude', 'diag')`)
  check('detail 返回正文', typeof detail.ok?.body === 'string' && detail.ok.body.includes('# Diag'), detail.err)
  check('frontmatter 已剥离', !detail.ok.body.includes('name: diag'))
  const detailZh = await caught(`window.warp.skills.detail('claude', '中文技能')`)
  check('中文技能详情可读', (detailZh.ok?.body ?? '').includes('# 无 frontmatter'))

  const escape1 = await caught(`window.warp.skills.detail('claude', '../escape')`)
  check('detail 拒绝 .. 越界', escape1.err != null && /不合法|越出/.test(escape1.err), escape1.err)
  const escape2 = await caught(`window.warp.skills.detail('claude', 'a/b')`)
  check('detail 拒绝多级 name', escape2.err != null && /不合法/.test(escape2.err), escape2.err)
  const escape3 = await caught(`window.warp.skills.detail('no-such-root', 'diag')`)
  check('detail 拒绝未知根', escape3.err != null && /未知/.test(escape3.err), escape3.err)

  console.log('\n=== 3. skills.installTo ===')
  // 先造一个不冲突的目标环境：codex 里没有「中文技能」
  const inst = await caught(`window.warp.skills.installTo('claude', '中文技能', ['codex'], 'skip')`)
  check('复制到 codex 成功', inst.ok?.installed?.includes('codex') === true, inst.ok)
  check('目标目录真实存在', existsSync(join(HOME, '.codex/skills/中文技能/SKILL.md')))

  const dup = await caught(`window.warp.skills.installTo('claude', '中文技能', ['codex'], 'skip')`)
  check('同名 skip', dup.ok?.skipped?.includes('codex') === true, dup.ok)

  const ovr = await caught(`window.warp.skills.installTo('claude', '中文技能', ['codex'], 'overwrite')`)
  check('同名 overwrite 装入 + 留 .bak', ovr.ok?.installed?.includes('codex') === true && readdirSync(join(HOME, '.codex/skills')).some((n) => n.startsWith('中文技能.bak-')), { r: ovr.ok, dirs: existsSync(join(HOME, '.codex/skills')) ? readdirSync(join(HOME, '.codex/skills')) : null })

  const badTarget = await caught(`window.warp.skills.installTo('claude', 'diag', ['no-such-root'], 'skip')`)
  check('未知目标进 failed', badTarget.ok?.failed?.length === 1 && /未知/.test(badTarget.ok.failed[0].reason), badTarget.ok)
  const selfTarget = await caught(`window.warp.skills.installTo('claude', 'diag', ['claude'], 'skip')`)
  check('安装到自身 skip', selfTarget.ok?.skipped?.includes('claude') === true, selfTarget.ok)

  console.log('\n=== 4. skills.uninstall ===')
  const rm1 = await caught(`window.warp.skills.uninstall('codex', '中文技能')`)
  check('卸载成功', rm1.ok?.ok === true, rm1.err ?? rm1.ok)
  check('目录真没了', !existsSync(join(HOME, '.codex/skills/中文技能')))
  const rmMissing = await caught(`window.warp.skills.uninstall('codex', '中文技能')`)
  check('卸载不存在的报错', rmMissing.err != null, rmMissing.ok)

  console.log('\n=== 5. skills.reveal ===')
  const rev = await caught(`window.warp.skills.reveal('claude', 'diag')`)
  check('reveal 正常返回（shell 调用不抛错）', rev.ok === 'reveal' || rev.ok != null, rev.err)

  console.log('\n=== 6. 渲染层：SkillsDialog ===')
  // OS 级真鼠标点击（标题栏自绘 + app-region 拖拽区：DOM click 不经过 hit-test，
  // cover 2026-11-04 标题栏容器漏 app-no-drag 导致按钮点不动的回归）
  const btnC = await js(`(() => { const b = [...document.querySelectorAll('button[aria-label*="Skills"]')][0]; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } })()`)
  win.webContents.sendInputEvent({ type: 'mouseDown', x: btnC.x, y: btnC.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: btnC.x, y: btnC.y, button: 'left', clickCount: 1 })
  check('标题栏按钮（真鼠标）打开弹窗', await waitFor(`!!__t.q('[data-testid="skills-dialog"]')`, 3000))

  console.log('  [dbg] dialog open, probing rows…')
  const rowsProbe = await Promise.race([js(`__t.qa('[data-testid^="skill-row-"]').length`), sleep(3000).then(() => 'TIMEOUT')])
  console.log('  [dbg] rows =', JSON.stringify(rowsProbe))
  // 防页面重载丢 __t：每步前重注入（幂等）
  const reH = () => js(HELPERS)
  await reH()
  const rowsNow = await js(`__t.qa('[data-testid^="skill-row-"]').length`).catch(async (e) => { await reH(); return await js(`__t.qa('[data-testid^="skill-row-"]').length`) })
  check('扫描出列表行（≥4）', rowsNow >= 4, rowsNow)
  await reH()
  const agentChips = await js(`__t.qa('[data-testid^="skills-agent-"]').map((b) => b.getAttribute('data-testid'))`).catch(() => [])
  check('agent 筛选栏有 claude/codex/全局仓', ['skills-agent-claude', 'skills-agent-codex', 'skills-agent-agents'].every((x) => agentChips.includes(x)), agentChips)

  // 搜索过滤（React 受控 input：必须用 native setter 赋值才触发 onChange）
  const typeSearch = (v) => js(`(() => { const el = __t.q('[data-testid="skills-search"]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await typeSearch('诊断')
  await sleep(300)
  const rowsAfterSearch = await js(`__t.qa('[data-testid^="skill-row-"]').length`)
  check('搜索「诊断」只剩 diag（描述含中文）', rowsAfterSearch === 1, rowsAfterSearch)
  await typeSearch('')

  // 详情
  await js(`__t.q('[data-testid="skill-row-claude-diag"]').click()`)
  check('详情面板出现', await waitFor(`!!__t.q('[data-testid="skills-detail"]')`, 3000))
  check('详情渲染出 .md-body 标题', await waitFor(`!!__t.q('[data-testid="skills-detail"] .md-body h1')`, 8000))
  check('详情没有 frontmatter 文本', await js(`!__t.q('[data-testid="skills-detail"]').textContent.includes('name: diag')`))

  // Esc 关闭（App 的 Esc handler 只在有 target 的预览时拦；dialog 开着时 skills 弹窗自己用 useOverlay 处理 Esc？——对话框走 Esc 由 useOverlay 处理）
  await js(`__t.key(document.body, 'Escape')`)
  check('Esc 关闭弹窗', await waitFor(`!__t.q('[data-testid="skills-dialog"]')`, 3000))

  console.log('\n=== 7. M3：GitHub URL 解析 ===')
  const u1 = await caught(`window.warp.skills.parseGithubUrl('owner/repo')`)
  check('短格式 owner/repo', u1.ok?.owner === 'owner' && u1.ok?.repo === 'repo' && u1.ok?.branch === 'HEAD', u1.ok)
  const u2 = await caught(`window.warp.skills.parseGithubUrl('https://github.com/a/b/tree/main/skills/foo')`)
  check('tree/branch/subpath', u2.ok?.branch === 'main' && u2.ok?.subpath === 'skills/foo', u2.ok)
  const u3 = await caught(`window.warp.skills.parseGithubUrl('git@github.com:owner/repo.git')`)
  check('git@ 短格式', u3.ok?.owner === 'owner' && u3.ok?.repo === 'repo', u3.ok)
  const u4 = await caught(`window.warp.skills.parseGithubUrl('https://gitlab.com/a/b')`)
  check('非 github 拒绝', u4.err != null && /github/.test(u4.err), u4.err)
  const u5 = await caught(`window.warp.skills.parseGithubUrl('https://github.com/a/b/releases')`)
  check('非 tree 路径拒绝', u5.err != null && /tree/.test(u5.err), u5.err)
  const u6 = await caught(`window.warp.skills.parseGithubUrl('https://github.com/a/b/tree/main')`)
  check('tree 缺子目录拒绝', u6.err != null, u6.err)
  const u7 = await caught(`window.warp.skills.parseGithubUrl('https://github.com/..%2F..%2Fetc/repo')`)
  check('owner 注入拒绝', u7.err != null, u7.err ?? u7.ok)

  console.log('\n=== 8. M3：GitHub 安装（本地 codeload 假源） ===')
  const gh = await caught(`window.warp.skills.installGithub('https://github.com/demo-owner/demo-repo', ['codex'], 'overwrite')`)
  check('从 tar.gz 安装成功', gh.ok?.installed?.includes('codex') === true, { ok: gh.ok, err: gh.err })
  check('packaged-skill 目录真实存在', existsSync(join(HOME, '.codex/skills/packaged-skill/SKILL.md')))
  const ghBody = readFileSync(join(HOME, '.codex/skills/packaged-skill/SKILL.md'), 'utf8')
  check('内容来自归档', ghBody.includes('gh 安装验收'))

  console.log('\n=== 8.1 GitHub 子路径 .. / 空段 / 反斜杠拒绝（I-3） ===')
  const dotCases = [
    ['短格式 ..', 'owner/repo/tree/main/../../etc'],
    ['短格式 . 段', 'owner/repo/tree/main/./x'],
    ['短格式空段', 'owner/repo/tree/main//x'],
    ['git@ ..', 'git@github.com:owner/repo/tree/main/../x'],
    ['https ..（new URL 会折叠）', 'https://github.com/owner/repo/tree/main/a/../../../x'],
    ['https %2e%2e', 'https://github.com/owner/repo/tree/main/%2e%2e/x'],
    ['branch 为 ..', 'owner/repo/tree/../x'],
    ['反斜杠', 'owner/repo/tree/main/a\\..\\x']
  ]
  for (const [label, url] of dotCases) {
    const r = await caught(`window.warp.skills.parseGithubUrl(${JSON.stringify(url)})`)
    check(`parseGithubUrl 拒绝：${label}`, r.err != null, r.err ?? r.ok)
  }
  const ghDot = await caught(`window.warp.skills.installGithub('https://github.com/demo-owner/demo-repo/tree/main/../../x', ['codex'], 'overwrite')`)
  check('installGithub 带 .. 子路径被拒', ghDot.err != null, ghDot.err ?? ghDot.ok)
  const ghLink = await caught(`window.warp.skills.installGithub('https://github.com/demo-owner/link-repo', ['codex'], 'overwrite')`)
  check('tar.gz 含符号链接条目被拒（I-4）', ghLink.err != null && /链接/.test(ghLink.err), ghLink.err ?? ghLink.ok)
  check('符号链接 skill 没有装进目标', !existsSync(join(HOME, '.codex/skills/link-skill')))
  const ghArrow = await caught(`window.warp.skills.installGithub('https://github.com/demo-owner/arrow-repo', ['codex'], 'overwrite')`)
  check('tar.gz 文件名带 " -> " 不误判为链接', ghArrow.ok?.installed?.includes('codex') === true, ghArrow.err ?? ghArrow.ok)
  // bsdtar 在 Windows 上把文件名里非法的 > 换成 _（落盘为 "weird -_ name.txt"），只确认文件装进来了
  const arrowDir = join(HOME, '.codex/skills/arrow-skill')
  check('带箭头的文件真实装入', existsSync(arrowDir) && readdirSync(arrowDir).some((n) => n.startsWith('weird -')), existsSync(arrowDir) ? readdirSync(arrowDir) : null)
  const ghAds = await caught(`window.warp.skills.installGithub('https://github.com/demo-owner/ads-repo', ['codex'], 'overwrite')`)
  check('tar.gz 条目名含冒号（ADS）被拒', ghAds.err != null && /冒号/.test(ghAds.err), ghAds.err ?? ghAds.ok)
  check('ADS skill 没有装进目标', !existsSync(join(HOME, '.codex/skills/ads-skill')))

  console.log('\n=== 9. M3：zip 安装（一次性 token）+ zip-slip 防护 ===')
  // MILE_WARP_TEST_ZIP：主进程 pickZip 跳过系统对话框直接用这个路径（每次调用现读，打包后不认）
  const pick = async (file) => {
    process.env.MILE_WARP_TEST_ZIP = file
    return caught(`window.warp.skills.pickZip()`)
  }
  const p1 = await pick(GOOD_ZIP)
  check('pickZip 只返回 token + 文件名，不含路径', p1.ok && typeof p1.ok.token === 'string' && p1.ok.name === 'good-skill.zip' && !JSON.stringify(p1.ok).includes(T.replace(/\\/g, '\\\\')), p1.ok ?? p1.err)
  const zipInst = await caught(`window.warp.skills.installZip(${JSON.stringify(p1.ok?.token)}, ['agents'], 'overwrite')`)
  check('zip 安装成功', zipInst.ok?.installed?.includes('agents') === true, { ok: zipInst.ok, err: zipInst.err })
  check('my-skill 目录真实存在', existsSync(join(HOME, '.agents/skills/my-skill/SKILL.md')))
  const reuse = await caught(`window.warp.skills.installZip(${JSON.stringify(p1.ok?.token)}, ['agents'], 'overwrite')`)
  check('同一 token 不能复用', reuse.err != null && /失效/.test(reuse.err), reuse.err ?? reuse.ok)
  const forged = await caught(`window.warp.skills.installZip('00000000-0000-4000-8000-000000000000', ['agents'], 'overwrite')`)
  check('伪造 token 被拒', forged.err != null, forged.err ?? forged.ok)
  const rawPath = await caught(`window.warp.skills.installZip(${JSON.stringify(GOOD_ZIP)}, ['agents'], 'overwrite')`)
  check('直接传 zip 路径被拒（旧接口形态）', rawPath.err != null && /不合法/.test(rawPath.err), rawPath.err ?? rawPath.ok)
  const p2 = await pick(GOOD_ZIP)
  const badTargets = await caught(`window.warp.skills.installZip(${JSON.stringify(p2.ok?.token)}, [], 'overwrite')`)
  check('targets 不合法时报错', badTargets.err != null, badTargets.err ?? badTargets.ok)
  const afterBad = await caught(`window.warp.skills.installZip(${JSON.stringify(p2.ok?.token)}, ['claude'], 'overwrite')`)
  check('targets 写错不白白作废 token', afterBad.ok?.installed?.includes('claude') === true, afterBad.ok ?? afterBad.err)

  const evilTok = await pick(EVIL_ZIP)
  const evil = await caught(`window.warp.skills.installZip(${JSON.stringify(evilTok.ok?.token)}, ['agents'], 'overwrite')`)
  check('zip-slip 拒绝（../ 条目）', evil.err != null && /越界|路径/.test(evil.err), evil.err ?? evil.ok)
  // ../evil.txt 若真解出来会落在 %TEMP%（临时目录的上一级是解压根的父级）
  const tmpLeak = join(T, 'evil.txt')
  check('越界文件没有落盘', !existsSync(tmpLeak))

  console.log('\n=== 9.1 zip 符号链接 / 条目数 / 大小上限（I-4） ===')
  const fx = mkdtempSync(join(T, 'warp-zipfx-'))
  const LINK_ZIP = join(fx, 'link.zip')
  writeFileSync(LINK_ZIP, buildEvilZip([
    { name: 'link-skill/SKILL.md', data: Buffer.from('---\nname: link-skill\n---\n') },
    { name: 'link-skill/escape', data: Buffer.from('C:/Windows/System32'), attr: (0o120777 << 16) >>> 0 }
  ]))
  const MANY_ZIP = join(fx, 'many.zip')
  writeFileSync(MANY_ZIP, buildEvilZip([
    { name: 'many/SKILL.md', data: Buffer.from('# M\n') },
    ...Array.from({ length: 5000 }, (_, i) => ({ name: `many/f${i}.txt`, data: Buffer.from('x') }))
  ]))
  const BIG_ZIP = join(fx, 'big.zip')
  writeFileSync(BIG_ZIP, buildEvilZip([
    { name: 'big/SKILL.md', data: Buffer.from('# B\n') },
    { name: 'big/blob.bin', data: Buffer.from('y'), declared: 300 * 1024 * 1024 }
  ]))
  const ADS_ZIP = join(fx, 'ads.zip')
  writeFileSync(ADS_ZIP, buildEvilZip([
    { name: 'ads-skill/SKILL.md', data: Buffer.from('# A\n') },
    { name: 'ads-skill/notes.txt:hidden', data: Buffer.from('hidden') }
  ]))
  const NUL_ZIP = join(fx, 'nul.zip')
  writeFileSync(NUL_ZIP, buildEvilZip([
    { name: 'nul-skill/SKILL.md', data: Buffer.from('# N\n') },
    { name: 'nul-skill/NUL', data: Buffer.from('x') }
  ]))
  const DOT_ZIP = join(fx, 'dot.zip')
  writeFileSync(DOT_ZIP, buildEvilZip([
    { name: 'dot-skill/SKILL.md', data: Buffer.from('# D\n') },
    { name: 'dot-skill/trailing.', data: Buffer.from('x') }
  ]))
  for (const [label, file, re, leak] of [
    ['条目名含冒号（ADS）被拒', ADS_ZIP, /冒号/, '.agents/skills/ads-skill'],
    ['Windows 保留名 NUL 被拒', NUL_ZIP, /保留名/, '.agents/skills/nul-skill'],
    ['以点结尾的条目名被拒', DOT_ZIP, /点或空格/, '.agents/skills/dot-skill'],
    ['符号链接条目被拒', LINK_ZIP, /链接/, '.agents/skills/link-skill'],
    ['超过 5000 条目被拒', MANY_ZIP, /条目过多/, '.agents/skills/many'],
    ['声明解压大小超 200MB 被拒', BIG_ZIP, /超过/, '.agents/skills/big']
  ]) {
    const t = await pick(file)
    const r = await caught(`window.warp.skills.installZip(${JSON.stringify(t.ok?.token)}, ['agents'], 'overwrite')`)
    check(`zip ${label}`, r.err != null && re.test(r.err), r.err ?? r.ok)
    check(`zip ${label}：目标里没有残留`, !existsSync(join(HOME, leak)))
  }
  delete process.env.MILE_WARP_TEST_ZIP

  console.log('\n=== 9.2 调试面门禁（I-1）：未设 MILE_WARP_DEBUG 时没有 __warpDebug ===')
  check('window.warp.debug 为 false', (await js(`window.warp.debug`)) === false)
  check('window.__warpDebug 不存在', (await js(`typeof window.__warpDebug`)) === 'undefined')

  console.log('\n=== 10. M3：渲染层安装页 ===')
  await js(`[...document.querySelectorAll('button[aria-label*="Skills"]')][0].click()`)
  await waitFor(`!!__t.q('[data-testid="skills-dialog"]')`, 3000)
  await js(`[...__t.qa('[role="tab"]')].find((b) => b.textContent.includes('安装')).click()`)
  check('安装页出现', await waitFor(`!!__t.q('[data-testid="skills-install"]')`, 3000))
  check('解析按钮 + URL 输入框在', await js(`!!__t.q('[data-testid="skills-url"]')`))
  // 粘个坏 URL 看错误
  const typeUrl = (v) => js(`(() => { const el = __t.q('[data-testid="skills-url"]'); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await typeUrl('https://gitlab.com/a/b')
  await js(`[...__t.qa('button')].find((b) => b.textContent.trim() === '解析').click()`)
  check('坏 URL 显示错误', await waitFor(`!!__t.q('[data-testid="skills-url-error"]')`, 3000))
  // 目标选择（按钮文本是显示名「Claude Code」等，不是 agentId）
  const pickTarget = `(() => { const b = [...__t.qa('[data-testid="skills-install-targets"] button')].find((x) => x.textContent.includes('Claude')); if (!b) return 'NOT-FOUND'; b.click(); return 'ok' })()`
  const picked = await js(pickTarget)
  check('目标按钮找到并点击', picked === 'ok', picked)
  const pressed = await js(`[...__t.qa('[data-testid="skills-install-targets"] button')].filter((b) => b.getAttribute('aria-pressed') === 'true').length`)
  check('目标 agent 可选（aria-pressed）', pressed === 1, pressed)

  codeload.close()
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`)
  app.exit(fail ? 2 : 0)
})
