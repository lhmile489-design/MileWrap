/**
 * 旧批次候选归档验收：每次退出，上一轮留下、这次既没恢复也没忽略的可见候选要归档（open=false），
 * 否则 open 记录一批批攒下来，一键恢复时一次拉起所有旧批次。
 * 用正式代码（src/main/services/SessionRecords）经 esbuild 打包，配一个内存版 ConfigStore，不起 Electron：
 *   node scripts/verify-archive-stale.cjs
 */
const { join, resolve } = require('node:path')
const { mkdtempSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')

const root = resolve(__dirname, '..')
const esbuild = require('esbuild')
const tmp = mkdtempSync(join(tmpdir(), 'warp-archive-'))
const out = join(tmp, 'lib.cjs')
esbuild.buildSync({
  stdin: { contents: "export * from './src/main/services/SessionRecords'", resolveDir: root, loader: 'ts' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error',
  alias: { '@shared': join(root, 'src', 'shared') },
  external: ['electron']
})
const { SessionRecords } = require(out)

const dirOk = join(tmp, 'ok')
mkdirSync(dirOk)
const dirGone = join(tmp, 'gone') // 故意不创建

let pass = 0
let fail = 0
function check(name, ok, detail) {
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail != null ? ` — ${JSON.stringify(detail)}` : ''}`)
}

const rec = (id, workspaceId, cwd, open = true) => ({
  id,
  workspaceId,
  agentId: 'claude',
  kind: 'agent',
  cwd,
  args: [],
  title: id,
  cell: null,
  lastStartedAt: 1,
  lastExitCode: null,
  resumeId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  resumeMode: 'exact',
  open,
  pid: null,
  exe: null
})

function makeStore(records) {
  let data = {
    sessionRecords: records,
    workspaces: [
      { id: 'w1', name: 'ok', agentId: 'claude', cwd: dirOk },
      { id: 'w2', name: 'gone', agentId: 'claude', cwd: dirGone }
    ],
    customAgents: []
  }
  return {
    get: () => data,
    update(fn) {
      const next = structuredClone(data)
      fn(next)
      data = next
      return next
    }
  }
}
const openIds = (store) => store.get().sessionRecords.filter((r) => r.open).map((r) => r.id).sort()

console.log('=== 本次开过会话：旧候选归档 ===')
{
  const store = makeStore([rec('s1-a', 'w1', dirOk), rec('s2-b', 'w1', dirOk), rec('s3-c', 'w2', dirGone)])
  const r = new SessionRecords(store)
  // 模拟本次运行新开了一个会话（候选集合在构造时就定了，新记录不在其中）
  r.upsert(rec('s4-new', 'w1', dirOk))
  r.archiveStale(true)
  check('旧的可见候选被归档', !openIds(store).includes('s1-a') && !openIds(store).includes('s2-b'), openIds(store))
  check('本次新开的会话仍是 open（下次启动的候选）', openIds(store).includes('s4-new'), openIds(store))
  check('目录缺失的记录不动', openIds(store).includes('s3-c'), openIds(store))
  check('归档后候选列表为空', r.candidatesList().length === 0, r.candidatesList().map((c) => c.id))
}

console.log('\n=== 本次什么都没开：旧候选原样保留 ===')
{
  const store = makeStore([rec('s1-a', 'w1', dirOk), rec('s2-b', 'w1', dirOk)])
  const r = new SessionRecords(store)
  r.archiveStale(false)
  check('没开过会话就退出，旧候选保留', openIds(store).join() === 's1-a,s2-b', openIds(store))
}

console.log('\n=== 已恢复的不受影响 ===')
{
  const store = makeStore([rec('s1-a', 'w1', dirOk), rec('s2-b', 'w1', dirOk)])
  const r = new SessionRecords(store)
  // 恢复 s1-a：新会话的记录接替旧记录
  r.upsert(rec('s9-restored', 'w1', dirOk), 's1-a')
  r.archiveStale(true)
  check('恢复出的新会话保持 open', openIds(store).includes('s9-restored'), openIds(store))
  check('没被恢复的 s2-b 归档', !openIds(store).includes('s2-b'), openIds(store))
}

console.log(`\n${pass}/${pass + fail} 通过`)
process.exit(fail ? 1 : 0)
