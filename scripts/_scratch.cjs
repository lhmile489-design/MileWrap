const { app } = require('electron')
const { execFileSync, execFile } = require('node:child_process')
const { join } = require('node:path')
const { mkdtempSync, readdirSync, statSync, rmSync } = require('node:fs')
const { tmpdir, homedir } = require('node:os')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const strip = (s) => s.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\)/g, '')
const killTree = (pid) => new Promise((d) => execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => d()))
const nodeExe = execFileSync('where.exe', ['node'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim()
function rollouts() {
  const out = new Set()
  const walk = (d, depth) => { let n=[]; try { n = readdirSync(d) } catch { return }
    for (const x of n) { const p = join(d, x); let st; try { st = statSync(p) } catch { continue }
      if (st.isDirectory() && depth < 3) walk(p, depth + 1); else if (/^rollout-.*\.jsonl$/.test(x)) out.add(p) } }
  walk(join(homedir(), '.codex', 'sessions'), 0); return out
}
async function main() {
  const pty = require('node-pty')
  const work = mkdtempSync(join(tmpdir(), 'warp-scratch-'))
  const env = { ...process.env, TERM: 'xterm-256color' }; delete env.ELECTRON_RUN_AS_NODE
  const before = rollouts()
  let out = ''
  const c = pty.spawn(nodeExe, ['C:\nvm4w\nodejs\node_modules\@openai\codex\bin\codex.js'], { name: 'xterm-256color', cols: 120, rows: 30, cwd: work, env, useConpty: true })
  c.onData((d) => (out += d))
  for (let i = 1; i <= 6; i++) {
    await sleep(3500)
    c.write('\x1b')
    const added = [...rollouts()].filter((x) => !before.has(x))
    console.log(`t=${i*3.5}s esc sent, rollouts+=${added.length}  tail=` + strip(out).replace(/\s+/g, ' ').slice(-110))
  }
  await killTree(c.pid); await sleep(800)
  console.log('final rollouts+=' + [...rollouts()].filter((x) => !before.has(x)).length)
  try { rmSync(work, { recursive: true, force: true }) } catch {}
}
app.whenReady().then(main).then(() => app.exit(0), (e) => { console.error(e); app.exit(1) })
