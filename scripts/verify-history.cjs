/**
 * 会话历史验收（会话管理升级计划 §6）。
 *
 * 在沙箱里按 P0 实测的真实格式造四个 agent 的会话数据，MILE_WARP_AGENT_HOME 指过去；
 * 导出用 MILE_WARP_TEST_SAVE 跳过系统保存对话框（两个变量打包后都不认）。断言：
 *   - 列表：数量、标题、摘要、目录规范化（\\?\ 前缀、斜杠、盘符），空会话 / 归档 / 子 agent / 越界路径不列出
 *   - 预览：各 agent 的消息解析、注入内容过滤、工具调用开关、分页
 *   - 安全：渲染层拿不到文件路径；非法 / 过期 historyId、越界联接点、非法参数一律被拒
 *   - 导出：Markdown / JSON / 原始文件（Kimi 带 state.json）
 *   - 续接：按 agent 拼续接参数、运行中判定、没有工作区时返回 needWorkspace
 *   - 界面：入口、目录归类、筛选、搜索、预览、工具调用开关
 *
 *   npm run build
 *   npx electron scripts/verify-history.cjs 2>&1 | Out-File $env:TEMP\warp-history.log -Encoding utf8
 */
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'warp-history-'))
// 必须在 require 主进程包之前，否则读写的是真实 %APPDATA%
app.setPath('appData', SANDBOX)
const HOME = join(SANDBOX, 'home')
const EXPORTS = join(SANDBOX, 'exports')
const BIN = join(SANDBOX, 'bin')
process.env.MILE_WARP_AGENT_HOME = HOME
process.env.MILE_WARP_TEST_SAVE = EXPORTS

const DIR_A = join(SANDBOX, '项目 A')
const DIR_B = join(SANDBOX, 'other-b')
const DIR_C = join(SANDBOX, 'kimi-c')
for (const d of [HOME, EXPORTS, BIN, DIR_A, DIR_B, DIR_C]) mkdirSync(d, { recursive: true })

const fwd = (p) => p.replace(/\\/g, '/')
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const iso = (min) => new Date(Date.UTC(2026, 9, 31, 8, min)).toISOString()

// ---------- Claude ----------
const C1 = '11111111-1111-4111-8111-111111111111'
const C_PAGED = '22222222-2222-4222-8222-222222222222'
const C_EMPTY = '33333333-3333-4333-8333-333333333333'
const claudeDir = join(HOME, '.claude', 'projects', 'E--sandbox-proj-a')
mkdirSync(join(claudeDir, C1, 'subagents'), { recursive: true })
const cl = (type, extra) => ({ type, sessionId: C1, cwd: DIR_A, timestamp: iso(1), ...extra })
writeFileSync(
  join(claudeDir, `${C1}.jsonl`),
  jsonl([
    { type: 'mode', mode: 'normal', sessionId: C1 },
    cl('user', { isMeta: true, message: { role: 'user', content: '<local-command-caveat>注入的说明</local-command-caveat>' } }),
    cl('user', { message: { role: 'user', content: '你好，帮我看看这个项目' } }),
    cl('assistant', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: '想一想' }, { type: 'text', text: '好的，我先列目录' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } }),
    cl('user', { message: { role: 'user', content: [{ type: 'tool_result', content: '工具输出内容 ABC' }] } }),
    cl('user', { message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>' } }),
    cl('user', { message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' } }),
    cl('user', { isSidechain: true, message: { role: 'user', content: '子任务里的消息' } }),
    { type: 'custom-title', customTitle: 'Claude 改过的名字', sessionId: C1 },
    { type: 'last-prompt', lastPrompt: '最后一句', sessionId: C1 }
  ]),
  'utf8'
)
writeFileSync(join(claudeDir, C1, 'subagents', 'agent-x.jsonl'), jsonl([cl('user', { message: { role: 'user', content: '子 agent' } })]), 'utf8')
const paged = []
for (let i = 0; i < 250; i++) paged.push({ type: 'user', sessionId: C_PAGED, cwd: DIR_A + '\\', timestamp: iso(2), message: { role: 'user', content: `第 ${i} 条` } })
writeFileSync(join(claudeDir, `${C_PAGED}.jsonl`), jsonl(paged), 'utf8')
writeFileSync(join(claudeDir, `${C_EMPTY}.jsonl`), jsonl([{ type: 'mode', mode: 'normal', sessionId: C_EMPTY }, { type: 'permission-mode', sessionId: C_EMPTY, cwd: DIR_A }]), 'utf8')
writeFileSync(join(claudeDir, 'not-a-session.txt'), 'x', 'utf8')

// ---------- Codex ----------
const T1 = '019a0001-0000-7000-8000-000000000001'
const T_ARCH = '019a0001-0000-7000-8000-000000000002'
const T_SUB = '019a0001-0000-7000-8000-000000000003'
const T_OUT = '019a0001-0000-7000-8000-000000000004'
const T_MISS = '019a0001-0000-7000-8000-000000000005'
const codexHome = join(HOME, '.codex')
const day = join(codexHome, 'sessions', '2026', '10', '31')
mkdirSync(day, { recursive: true })
const rollout = join(day, `rollout-2026-10-31T08-00-00-${T1}.jsonl`)
const ri = (payload) => ({ timestamp: iso(3), type: 'response_item', payload })
writeFileSync(
  rollout,
  jsonl([
    { timestamp: iso(3), type: 'session_meta', payload: { id: T1, cwd: '\\\\?\\' + DIR_A } },
    ri({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions>系统</permissions>' }] }),
    ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>x</cwd>\n</environment_context>' }] }),
    ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for x\n\n内容' }] }),
    ri({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex 里的问题' }] }),
    ri({ type: 'reasoning', summary: [] }),
    ri({ type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'git status' }), call_id: 'c1' }),
    ri({ type: 'function_call_output', call_id: 'c1', output: 'nothing to commit' }),
    ri({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex 的回答' }] }),
    { timestamp: iso(3), type: 'event_msg', payload: { type: 'token_count' } }
  ]),
  'utf8'
)
const outsideRollout = join(SANDBOX, 'outside-rollout.jsonl')
writeFileSync(outsideRollout, readFileSync(rollout))
writeFileSync(join(day, `rollout-x-${T_ARCH}.jsonl`), readFileSync(rollout))
writeFileSync(join(day, `rollout-x-${T_SUB}.jsonl`), readFileSync(rollout))
{
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
  const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'))
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, cwd TEXT, title TEXT,
    archived INTEGER, first_user_message TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, name TEXT, extra_future_col TEXT)`)
  const ins = db.prepare('INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, archived, first_user_message, created_at_ms, updated_at_ms, name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  const t = Date.UTC(2026, 9, 31, 9, 0)
  ins.run(T1, '\\\\?\\' + rollout, t / 1000, t / 1000, 'cli', '\\\\?\\' + DIR_A.toLowerCase() + '\\', '自动标题', 0, 'Codex 里的问题', t, t + 5000, 'Codex 别名')
  ins.run(T_ARCH, '\\\\?\\' + join(day, `rollout-x-${T_ARCH}.jsonl`), t / 1000, t / 1000, 'cli', DIR_A, '归档的', 1, '归档', t, t, null)
  ins.run(T_SUB, '\\\\?\\' + join(day, `rollout-x-${T_SUB}.jsonl`), t / 1000, t / 1000, '{"subagent":{"other":"guardian"}}', DIR_A, '子 agent', 0, '子', t, t, null)
  ins.run(T_OUT, outsideRollout, t / 1000, t / 1000, 'cli', DIR_A, '越界的', 0, '越界', t, t, null)
  ins.run(T_MISS, '\\\\?\\' + join(day, 'rollout-missing.jsonl'), t / 1000, t / 1000, 'exec', DIR_A, '文件缺失', 0, '缺文件', t, t - 1000, null)
  db.close()
}

// ---------- Kimi ----------
const K1 = 'session_44444444-4444-4444-8444-444444444444'
const kimiSession = join(HOME, '.kimi-code', 'sessions', 'wd_kimi-c_abc123', K1)
mkdirSync(join(kimiSession, 'agents', 'main'), { recursive: true })
mkdirSync(join(kimiSession, 'agents', 'agent-0'), { recursive: true })
writeFileSync(
  join(kimiSession, 'state.json'),
  JSON.stringify({ createdAt: iso(4), updatedAt: iso(5), title: 'Kimi 的标题', isCustomTitle: false, workDir: fwd(DIR_C), lastPrompt: 'Kimi 最后一句' }),
  'utf8'
)
const kev = (event) => ({ type: 'context.append_loop_event', event, time: Date.UTC(2026, 9, 31, 8, 4) })
writeFileSync(
  join(kimiSession, 'agents', 'main', 'wire.jsonl'),
  jsonl([
    { type: 'metadata', protocol_version: '1.4', created_at: 1 },
    { type: 'turn.prompt', input: [{ type: 'text', text: 'Kimi 的问题' }], origin: { kind: 'user' }, time: Date.UTC(2026, 9, 31, 8, 4) },
    { type: 'turn.prompt', input: [{ type: 'text', text: '注入' }], origin: { kind: 'injection' }, time: 1 },
    kev({ type: 'step.begin', uuid: 's1' }),
    kev({ type: 'content.part', stepUuid: 's1', part: { type: 'think', think: '思考' } }),
    kev({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: '第一段' } }),
    kev({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: '第二段' } }),
    kev({ type: 'tool.call', stepUuid: 's1', name: 'Read', args: { path: 'a.txt' } }),
    kev({ type: 'tool.result', result: { output: '文件内容' } }),
    kev({ type: 'content.part', stepUuid: 's2', part: { type: 'text', text: '收尾' } })
  ]),
  'utf8'
)
writeFileSync(join(kimiSession, 'agents', 'agent-0', 'wire.jsonl'), jsonl([{ type: 'turn.prompt', input: [{ type: 'text', text: '子 agent' }] }]), 'utf8')

// ---------- Pi ----------
const P1 = '55555555-5555-4555-8555-555555555555'
const piDir = join(HOME, '.pi', 'agent', 'sessions', '--sandbox-other-b--')
mkdirSync(piDir, { recursive: true })
writeFileSync(
  join(piDir, `2026-10-31T08-06-00-000Z_${P1}.jsonl`),
  jsonl([
    { type: 'session', version: 3, id: P1, timestamp: iso(6), cwd: DIR_B },
    { type: 'model_change', id: 'a', parentId: null, timestamp: iso(6), provider: 'x', modelId: 'y' },
    { type: 'message', id: 'b', parentId: 'a', timestamp: iso(6), message: { role: 'system', content: [{ type: 'text', text: '系统' }] } },
    { type: 'message', id: 'c', parentId: 'b', timestamp: iso(6), message: { role: 'user', content: [{ type: 'text', text: 'Pi 的问题' }] } },
    { type: 'message', id: 'd', parentId: 'c', timestamp: iso(7), message: { role: 'assistant', content: [{ type: 'thinking', thinking: '想' }, { type: 'toolCall', name: 'bash', arguments: { command: 'dir' } }, { type: 'text', text: 'Pi 的回答' }] } },
    { type: 'message', id: 'e', parentId: 'd', timestamp: iso(7), message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'Pi 工具输出' }] } }
  ]),
  'utf8'
)
// 联接点：会话目录里的一个子目录其实指到外面（列表里会出现，但读文件时 realpath 越界必须被拒）
const OUTSIDE = join(SANDBOX, 'outside-pi')
mkdirSync(OUTSIDE, { recursive: true })
const P_JUNC = '66666666-6666-4666-8666-666666666666'
writeFileSync(join(OUTSIDE, `x_${P_JUNC}.jsonl`), jsonl([{ type: 'session', version: 3, id: P_JUNC, timestamp: iso(8), cwd: join(SANDBOX, 'junction-dir') }, { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '外面的' }] } }]), 'utf8')
let junction = true
try {
  symlinkSync(OUTSIDE, join(HOME, '.pi', 'agent', 'sessions', '--junction--'), 'junction')
} catch {
  junction = false
}

// ---------- 假 agent 与配置 ----------
const FAKE = String.raw`
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
module.exports = (agent) => {
  const dir = join(process.env.MILE_WARP_AGENT_HOME, 'argv')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, agent + '-' + process.pid + '.json'), JSON.stringify({ agent, argv: process.argv.slice(2), cwd: process.cwd() }))
  console.log('FAKE ' + agent + ' ready')
  process.stdin.on('data', (d) => { if (String(d).includes('q')) process.exit(3) })
  setInterval(() => undefined, 1000)
}
`
writeFileSync(join(BIN, 'fake-common.js'), FAKE, 'utf8')
for (const a of ['claude', 'codex']) {
  writeFileSync(join(BIN, `fake-${a}.js`), `require('./fake-common.js')(${JSON.stringify(a)})\n`, 'utf8')
  writeFileSync(join(BIN, `${a}.cmd`), `@ECHO off\r\nSET "_prog=node"\r\n"%_prog%"  "%dp0%\\fake-${a}.js" %*\r\n`, 'utf8')
}
const now = Date.now()
const ws = (id, agentId, name, cwd, order) => ({
  id, groupId: null, name, note: '', agentId, agentPath: join(BIN, `${agentId}.cmd`), cwd, args: [], envKeys: [], envEnc: null, icon: null, order, createdAt: now, updatedAt: now
})
mkdirSync(join(SANDBOX, 'mile-warp'), { recursive: true })
writeFileSync(
  join(SANDBOX, 'mile-warp', 'config.json'),
  JSON.stringify({
    version: 2,
    groups: [],
    workspaces: [ws('w1', 'claude', '项目 A', DIR_A, 0), ws('w2', 'codex', '项目 A Codex', DIR_A, 1)],
    customAgents: [],
    settings: { closeAction: 'quit' },
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
  const J = JSON.stringify
  const js = (code) => win.webContents.executeJavaScript(code, true)
  const rejects = (code) => js(`(${code}).then(() => null, (e) => String(e && e.message || e))`)
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
  await waitFor(`!!document.querySelector('[data-rail="sessions"] [data-workspace-id]')`)

  console.log('\n=== 列表 ===')
  const list = await js('window.warp.history.list()')
  const by = (a, sid) => list.items.find((i) => i.agentId === a && i.sessionId === sid)
  const c1 = by('claude', C1)
  const cp = by('claude', C_PAGED)
  const t1 = by('codex', T1)
  const tm = by('codex', T_MISS)
  const k1 = by('kimi', K1)
  const p1 = by('pi', P1)
  check('没有 agent 读取失败', list.failed.length === 0, list.failed)
  check('Claude：列出 2 段（空会话、子 agent、非 jsonl 不列）', list.items.filter((i) => i.agentId === 'claude').length === 2, list.items.filter((i) => i.agentId === 'claude').map((i) => i.sessionId))
  check('Claude：标题取 custom-title', c1?.title === 'Claude 改过的名字', c1?.title)
  check('Claude：摘要取首条真实用户消息（跳过 isMeta）', c1?.summary === '你好，帮我看看这个项目', c1?.summary)
  check('Claude：目录取文件内 cwd 并规范化', c1?.cwd === fwd(DIR_A), c1?.cwd)
  check('Claude：尾斜杠被去掉，与同目录归到一处', cp?.cwd === fwd(DIR_A), cp?.cwd)
  check('Codex：列出 2 段（归档、子 agent、越界路径不列）', list.items.filter((i) => i.agentId === 'codex').length === 2, list.items.filter((i) => i.agentId === 'codex').map((i) => i.sessionId))
  check('Codex：标题优先用户改的 name', t1?.title === 'Codex 别名', t1?.title)
  check('Codex：\\\\?\\ 前缀去掉、盘符大写、尾斜杠去掉', t1?.cwd.toLowerCase() === fwd(DIR_A).toLowerCase() && /^[A-Z]:\//.test(t1?.cwd ?? '') && !t1?.cwd.endsWith('/'), t1?.cwd)
  check('Codex：更新时间取 updated_at_ms', t1?.updatedAt === Date.UTC(2026, 9, 31, 9, 0) + 5000)
  check('Codex：索引有记录、文件缺失的照样列出（大小 0）', tm?.size === 0, tm)
  check('Kimi：读 state.json 的标题、目录、最后输入', k1?.title === 'Kimi 的标题' && k1?.cwd === fwd(DIR_C) && k1?.summary === 'Kimi 最后一句', k1)
  check('Kimi：大小是 agents/main/wire.jsonl 的', (k1?.size ?? 0) > 100, k1?.size)
  check('Pi：标题用首条用户消息', p1?.title === 'Pi 的问题' && p1?.cwd === fwd(DIR_B), p1)
  check('按更新时间倒序', list.items.every((x, i, a) => i === 0 || a[i - 1].updatedAt >= x.updatedAt))
  const raw = JSON.stringify(list)
  check('渲染层拿不到文件路径', !raw.includes('.claude') && !raw.includes('rollout-') && !raw.includes('wire.jsonl') && !list.items.some((i) => 'file' in i))
  check('historyId 是不透明 ID', list.items.every((i) => /^h[0-9a-f]{20}$/.test(i.historyId)))
  const list2 = await js('window.warp.history.list()')
  check('再列一次 historyId 不变（缓存命中）', list2.items.find((i) => i.sessionId === C1)?.historyId === c1?.historyId)

  console.log('\n=== 预览 ===')
  const detail = (id, offset = 0, tools = false) => js(`window.warp.history.detail(${J(id)}, ${offset}, ${tools})`)
  const d1 = await detail(c1.historyId)
  check('Claude：用户 / 回答 / 斜杠命令，isMeta、sidechain、命令回显、思考都不进', J(d1.messages.map((m) => [m.role, m.text])) === J([['user', '你好，帮我看看这个项目'], ['assistant', '好的，我先列目录'], ['user', '/model']]), d1.messages.map((m) => [m.role, m.text]))
  const d1t = await detail(c1.historyId, 0, true)
  check('Claude：打开工具调用后出现 Bash ls -la；工具输出不进预览', d1t.messages.some((m) => m.role === 'tool' && m.text === 'Bash ls -la') && !J(d1t).includes('工具输出内容'), d1t.messages.map((m) => m.text))
  check('消息带时间', typeof d1.messages[0].time === 'number')
  const pg1 = await detail(cp.historyId)
  const pg3 = await detail(cp.historyId, 200)
  check('分页：第一页 100 条且还有', pg1.messages.length === 100 && pg1.truncated && pg1.messages[0].text === '第 0 条')
  check('分页：offset 200 取到剩下 50 条', pg3.messages.length === 50 && !pg3.truncated && pg3.messages[0].text === '第 200 条')
  const dt = await detail(t1.historyId, 0, true)
  check('Codex：过滤环境信息与 AGENTS.md 注入，developer 不进', J(dt.messages.map((m) => [m.role, m.text])) === J([['user', 'Codex 里的问题'], ['tool', 'shell_command git status'], ['assistant', 'Codex 的回答']]), dt.messages.map((m) => [m.role, m.text]))
  const dk = await detail(k1.historyId, 0, true)
  check('Kimi：同一步的文字合成一条，注入的 prompt 不进', J(dk.messages.map((m) => [m.role, m.text])) === J([['user', 'Kimi 的问题'], ['assistant', '第一段第二段'], ['tool', 'Read a.txt'], ['assistant', '收尾']]), dk.messages.map((m) => [m.role, m.text]))
  const dp = await detail(p1.historyId, 0, true)
  check('Pi：系统消息与思考不进，toolCall 是工具调用', J(dp.messages.map((m) => [m.role, m.text])) === J([['user', 'Pi 的问题'], ['tool', 'bash dir'], ['assistant', 'Pi 的回答']]), dp.messages.map((m) => [m.role, m.text]))
  check('文件缺失的记录：预览给出明确原因', String(await rejects(`window.warp.history.detail(${J(tm.historyId)})`)).includes('会话文件不存在'))

  console.log('\n=== 参数与越界 ===')
  check('非法 historyId 被拒', !!(await rejects(`window.warp.history.detail('h123')`)))
  check('路径形式的 historyId 被拒', !!(await rejects(`window.warp.history.detail('..\\\\..\\\\x.jsonl')`)))
  check('格式合法但不在列表里的 ID 被拒', String(await rejects(`window.warp.history.detail('h${'0'.repeat(20)}')`)).includes('已失效'))
  check('非法 offset 被拒', !!(await rejects(`window.warp.history.detail(${J(c1.historyId)}, -1)`)))
  check('非法导出格式被拒', !!(await rejects(`window.warp.history.export(${J(c1.historyId)}, 'exe')`)))
  check('传文件路径给 reveal 被拒', !!(await rejects(`window.warp.history.reveal(${J(join(claudeDir, `${C1}.jsonl`))})`)))
  if (junction) {
    const pj = list.items.find((i) => i.sessionId === P_JUNC)
    check('联接点指到外面：读取时 realpath 越界被拒', !pj || String(await rejects(`window.warp.history.detail(${J(pj.historyId)})`)).includes('越出'), pj ? 'listed' : 'not listed')
  } else {
    check('联接点（跳过：建不了 junction）', true)
  }

  console.log('\n=== 导出 ===')
  const exp = (id, fmt, tools = false) => js(`window.warp.history.export(${J(id)}, ${J(fmt)}, ${tools})`)
  const mdPath = await exp(c1.historyId, 'markdown')
  const md = mdPath && existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : ''
  check('Markdown：写到保存对话框给的路径', !!md && mdPath.startsWith(EXPORTS), mdPath)
  check('Markdown：标题、元数据、按轮次', md.startsWith('# Claude 改过的名字') && md.includes(C1) && md.includes('## 用户') && md.includes('## Assistant') && md.includes('> 工具调用：Bash ls -la'))
  check('Markdown：默认不含工具输出', !md.includes('工具输出内容 ABC'))
  const md2 = readFileSync(await exp(c1.historyId, 'markdown', true), 'utf8')
  check('Markdown（含工具输出）：折叠块里有输出', md2.includes('<details><summary>工具输出</summary>') && md2.includes('工具输出内容 ABC'))
  const jp = await exp(t1.historyId, 'json')
  const jd = JSON.parse(readFileSync(jp, 'utf8'))
  check('JSON：元数据与消息', jd.version === 1 && jd.agent === 'codex' && jd.sessionId === T1 && jd.messages.length === 3 && jd.messages[0].text === 'Codex 里的问题', jd.messages)
  const rp = await exp(t1.historyId, 'raw')
  check('原始文件：逐字节相同', !!rp && readFileSync(rp).equals(readFileSync(rollout)))
  const kp = await exp(k1.historyId, 'raw')
  const kState = kp.replace(/\.jsonl$/, '.state.json')
  check('Kimi 原始文件：wire.jsonl 加旁边的 state.json', readFileSync(kp).equals(readFileSync(join(kimiSession, 'agents', 'main', 'wire.jsonl'))) && existsSync(kState) && JSON.parse(readFileSync(kState, 'utf8')).title === 'Kimi 的标题')

  console.log('\n=== 续接 ===')
  const argvOf = async (agent) => {
    const dir = join(HOME, 'argv')
    for (let t = 0; t < 8000; t += 200) {
      const f = existsSync(dir) ? readdirSync(dir).find((n) => n.startsWith(agent + '-')) : null
      if (f) return JSON.parse(readFileSync(join(dir, f), 'utf8'))
      await sleep(200)
    }
    return null
  }
  const r1 = await js(`window.warp.history.resume(${J(c1.historyId)})`)
  check('Claude：续接成功，用同目录的 Claude 工作区', r1.ok && r1.session.workspaceId === 'w1' && r1.session.resumeId === C1 && r1.session.resumeMode === 'exact', r1)
  const a1 = await argvOf('claude')
  check('Claude：启动参数是 --resume <id>', a1 && a1.argv[0] === '--resume' && a1.argv[1] === C1, a1?.argv)
  check('续接后的会话标题是历史标题', r1.ok && r1.session.title === 'Claude 改过的名字')
  const again = await js(`window.warp.history.resume(${J(c1.historyId)})`)
  check('同一段对话正在运行：返回 running，不开第二个', !again.ok && again.running && !again.needWorkspace, again)
  const listRun = await js('window.warp.history.list()')
  check('列表里标记运行中', listRun.items.find((i) => i.sessionId === C1)?.running === true)
  const r2 = await js(`window.warp.history.resume(${J(t1.historyId)}, 'w2')`)
  const a2 = await argvOf('codex')
  check('Codex：续接参数是 resume <id>（工作区目录带 \\\\?\\ 前缀也能对上）', r2.ok && a2 && a2.argv[0] === 'resume' && a2.argv[1] === T1, a2?.argv)
  check('指定 agent 不符的工作区被拒', String(await rejects(`window.warp.history.resume(${J(t1.historyId)}, 'w1')`)).includes('不一致'))
  const rk = await js(`window.warp.history.resume(${J(k1.historyId)})`)
  check('没有对应工作区：返回 needWorkspace', !rk.ok && rk.needWorkspace && !rk.running, rk)

  console.log('\n=== 界面 ===')
  const key = (code) => js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: ${J(code)}, key: 'h', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); true`)
  await key('KeyH')
  check('Ctrl+Shift+H 打开会话历史', await waitFor(`!!document.querySelector('[data-testid="history-dialog"]')`))
  check('列表渲染出全部条目', await waitFor(`document.querySelectorAll('[data-history-item]').length === ${list.items.length}`), await js(`document.querySelectorAll('[data-history-item]').length`))
  const dirA = fwd(DIR_A).toLowerCase()
  const dirB = fwd(DIR_B).toLowerCase()
  check('左栏：工作区目录（两个工作区同目录合成一项）', await js(`(() => { const b = document.querySelector('[data-history-dir=${J(J(dirA).slice(1, -1))}]'); return !!b && b.textContent.includes('项目 A / 项目 A Codex') })()`))
  check('左栏：其他目录里有 Pi 的目录', await js(`!!document.querySelector('[data-history-dir=${J(J(dirB).slice(1, -1))}]')`))
  await js(`document.querySelector('[data-history-dir=${J(J(dirB).slice(1, -1))}]').click()`)
  check('点其他目录：只剩该目录的会话', await waitFor(`document.querySelectorAll('[data-history-item]').length === 1`))
  check('预览自动选中第一条并显示对话', await waitFor(`[...document.querySelectorAll('[data-history-msg]')].some((e) => e.textContent.includes('Pi 的回答'))`))
  check('默认不显示工具调用', await js(`!document.querySelector('[data-history-msg="tool"]')`))
  await js(`document.querySelector('[data-testid="history-tools"]').click()`)
  check('勾选「显示工具调用」后出现工具行', await waitFor(`!!document.querySelector('[data-history-msg="tool"]')`))
  await js(`document.querySelector('[data-history-dir="*"]').click()`)
  await js(`(() => { const i = document.querySelector('[data-testid="history-search"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Codex'); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  check('搜索标题 / 首条消息', await waitFor(`document.querySelectorAll('[data-history-item]').length === 1`), await js(`document.querySelectorAll('[data-history-item]').length`))
  await js(`(() => { const i = document.querySelector('[data-testid="history-search"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await js(`document.querySelector('[data-history-agent="kimi"]').click()`)
  check('按 agent 筛选', await waitFor(`document.querySelectorAll('[data-history-item]').length === 1`))
  check('运行中的条目有文字标记', await js(`(() => { document.querySelector('[data-history-agent="claude"]').click(); return true })()`) && (await waitFor(`[...document.querySelectorAll('[data-history-item]')].some((e) => e.textContent.includes('运行中'))`)))
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true`)
  check('Esc 关闭', await waitFor(`!document.querySelector('[data-testid="history-dialog"]')`, 3000))
  // 工作区右键「历史会话…」：打开时定位到该工作区目录
  await js(`(() => { const el = document.querySelector('[data-rail="sessions"] [data-workspace-id="w1"]'); const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })); return true })()`)
  await waitFor(`!!document.querySelector('[role="menu"]')`, 2000)
  await js(`[...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === '历史会话…').click()`)
  check('工作区菜单「历史会话…」定位到该目录', await waitFor(`document.querySelector('[data-history-dir][aria-pressed="true"]')?.getAttribute('data-history-dir') === ${J(dirA)}`))
  check('该目录下是 Claude 与 Codex 的会话', await waitFor(`document.querySelectorAll('[data-history-item]').length === 4`), await js(`document.querySelectorAll('[data-history-item]').length`))

  // 收尾：结束假 agent
  const live = await js('window.warp.session.list()')
  for (const s of live) await js(`window.warp.session.close(${J(s.id)})`)
  console.log(`\n${pass}/${pass + fail} 通过`)
  app.exit(fail ? 1 : 0)
})
