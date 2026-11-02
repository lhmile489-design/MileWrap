/**
 * 一键跑全部 harness（升级建议 5.4）：依次启动每个 verify-*.cjs，汇总通过数。
 * 每个脚本的输出按 UTF-8 存进 %TEMP%\warp-verify\<名字>.log，避开 PowerShell 5.1 重定向的中文乱码（踩坑记录）。
 *
 *   npm run build
 *   npm run verify:all              全部
 *   npm run verify:all -- m2 m5     只跑名字里含 m2 / m5 的
 *
 * 不含 verify-package（要先 build:win、需要 Node 22）与 verify-ui（npm run verify:ui，不用 Electron）。
 */
const { spawn } = require('node:child_process')
const { mkdirSync, writeFileSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const ROOT = join(__dirname, '..')
const LOG_DIR = join(tmpdir(), 'warp-verify')
mkdirSync(LOG_DIR, { recursive: true })

const SKIP = new Set(['verify-all.cjs', 'verify-package.cjs', 'verify-ui.cjs'])
const filters = process.argv.slice(2)
const scripts = readdirSync(__dirname)
  .filter((f) => /^verify-.+\.cjs$/.test(f) && !SKIP.has(f))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort()

const electron = require('electron')
const PER_SCRIPT_MS = 300_000

function runOne(file) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(electron, [join('scripts', file)], { cwd: ROOT, windowsHide: true, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '' } })
    let out = ''
    child.stdout.on('data', (b) => (out += b.toString('utf8')))
    child.stderr.on('data', (b) => (out += b.toString('utf8')))
    const timer = setTimeout(() => {
      out += `\n[verify-all] 超时 ${PER_SCRIPT_MS / 1000} 秒，强制结束\n`
      child.kill()
    }, PER_SCRIPT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      const log = join(LOG_DIR, file.replace(/\.cjs$/, '.log'))
      writeFileSync(log, out, { encoding: 'utf8' })
      const m = [...out.matchAll(/(\d+)\/(\d+)\s*通过/g)].pop()
      resolve({ file, code, pass: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null, sec: Math.round((Date.now() - t0) / 1000), log })
    })
  })
}

;(async () => {
  console.log(`共 ${scripts.length} 个脚本，日志在 ${LOG_DIR}\n`)
  const results = []
  for (const f of scripts) {
    process.stdout.write(`  ${f.padEnd(28)} `)
    const r = await runOne(f)
    results.push(r)
    const ok = r.code === 0
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.pass ?? '?'}/${r.total ?? '?'}  ${r.sec}s${ok ? '' : `  退出码 ${r.code}，见 ${r.log}`}`)
  }
  const failed = results.filter((r) => r.code !== 0)
  const pass = results.reduce((n, r) => n + (r.pass ?? 0), 0)
  const total = results.reduce((n, r) => n + (r.total ?? 0), 0)
  console.log(`\n脚本 ${results.length - failed.length}/${results.length} 通过，断言 ${pass}/${total}`)
  process.exit(failed.length ? 1 : 0)
})()
