/**
 * M0 探针：实测本机各 agent 的 skill 目录形态（只读，不做任何写操作）。
 *
 *   node scripts/probe-skills.cjs
 *
 * 输出每个候选目录的存在性、skill 数量、前 3 个 skill 的 frontmatter 样例。
 * 结论回写 docs/Skills管理-PRD.md §5 的目录映射表。
 */
const { readdirSync, existsSync, statSync, readFileSync } = require('node:fs')
const { join, homedir: _hd } = (() => {
  const path = require('node:path')
  const os = require('node:os')
  return { readdirSync, existsSync, statSync, readFileSync, join: path.join, homedir: os.homedir }
})()
const home = require('node:os').homedir()

/** 候选目录（PRD §5 + skillkit tools.ts 的映射，全部待实测确认） */
const CANDIDATES = [
  { agentId: 'claude', paths: ['.claude/skills'] },
  { agentId: 'codex', paths: ['.codex/skills'] },
  { agentId: 'kimi', paths: ['.kimi-code/skills', '.kimi/skills', 'kimicode/skills'] },
  { agentId: 'pi', paths: ['.pi/skills', '.pi-agent/skills'] },
  { agentId: 'agents(全局仓)', paths: ['.agents/skills'] }
]

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end < 0) return null
  const block = text.slice(3, end).replace(/\r\n/g, '\n')
  const out = {}
  for (const lineRaw of block.split('\n')) {
    const m = lineRaw.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

function probe(root) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (e) {
    return { ok: false, reason: e.code }
  }
  const skills = []
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    if (e.name.startsWith('.')) continue
    const sub = join(root, e.name)
    let hasMd = false
    for (const f of ['SKILL.md', 'AGENTS.md']) {
      if (existsSync(join(sub, f))) {
        hasMd = true
        break
      }
    }
    if (hasMd) skills.push(e.name)
  }
  return { ok: true, skillCount: skills.length, samples: skills.slice(0, 3) }
}

console.log('=== agent skill 目录探针（只读）===\n')
for (const c of CANDIDATES) {
  console.log(`[${c.agentId}]`)
  for (const p of c.paths) {
    const root = join(home, p)
    const r = probe(root)
    if (r.ok) {
      console.log(`  ~/ ${p}  →  ${r.skillCount} 个 skill`)
      for (const s of r.samples) {
        try {
          const fm = parseFrontmatter(readFileSync(join(root, s, 'SKILL.md'), 'utf8')) ||
            parseFrontmatter(readFileSync(join(root, s, 'AGENTS.md'), 'utf8'))
          console.log(`    ${s}: name=${JSON.stringify(fm?.name ?? null)} desc=${JSON.stringify((fm?.description ?? '').slice(0, 60))}`)
        } catch {
          console.log(`    ${s}: frontmatter 读取失败`)
        }
      }
    } else if (r.reason === 'ENOENT') {
      console.log(`  ~/${p}  →  不存在`)
    } else {
      console.log(`  ~/${p}  →  读取失败 ${r.reason}`)
    }
  }
  console.log()
}
