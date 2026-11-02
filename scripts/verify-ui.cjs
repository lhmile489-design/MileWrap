/**
 * UI 硬规则源码扫描（技术设计 §10 verify-ui，UI设计约束 §6 / §7）：
 *   1. 文字色不加透明度（不写 text-ink-faint/50 这类）
 *   2. 字号 ≥ 12px（不写 text-[11px]）
 *   3. 圆角只用令牌（不写 rounded-[13px]）
 *   4. Phosphor 图标尺寸只用 12 / 16 / 20 / 24（12 只用于与 12px 文字同行的内联图标，UI设计约束 §4.1 / §4.2）
 *   5. 不用 window.confirm / window.alert / window.prompt（用应用内对话框）
 * 纯文本扫描，不需要 build：
 *   node scripts/verify-ui.cjs
 */
const { readdirSync, readFileSync, statSync } = require('node:fs')
const { join, relative } = require('node:path')

const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'src', 'renderer', 'src')
const COLOR_TOKENS = 'ink|ink-strong|ink-muted|ink-faint|ink-inverse|accent|live|warn|fault|idle|badge-ink'

const RULES = [
  { name: '文字色加了透明度', re: new RegExp(`\\btext-(?:${COLOR_TOKENS})\\/\\d+`, 'g') },
  { name: '文字色用了任意值透明度', re: /\btext-\[[^\]]*\]\/\d+/g },
  {
    name: '字号小于 12px',
    re: /\btext-\[(\d+(?:\.\d+)?)px\]/g,
    bad: (m) => Number(m[1]) < 12
  },
  { name: '任意值圆角', re: /\brounded(?:-[trblse]{1,2})?-\[[^\]]+\]/g },
  {
    name: '图标尺寸不在 12/16/20/24',
    re: /<[A-Z][A-Za-z]*\s[^>]*?\bsize=\{(\d+)\}/g,
    bad: (m) => ![12, 16, 20, 24].includes(Number(m[1])),
    // AgentBadge 的 size 是徽章尺寸（20 / 24），不是图标；照样在白名单里
  },
  { name: '原生对话框', re: /\bwindow\.(?:confirm|alert|prompt)\s*\(/g }
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|css)$/.test(name)) out.push(p)
  }
  return out
}

let violations = 0
let files = 0
for (const file of walk(SRC)) {
  files++
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    // 注释行里的示例（如「不写 text-ink-faint/50」）不算
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      let m
      while ((m = rule.re.exec(line))) {
        if (rule.bad && !rule.bad(m)) continue
        violations++
        console.log(`  FAIL  ${rule.name}  ${relative(ROOT, file)}:${i + 1}  ${m[0]}`)
      }
    }
  })
}

console.log(`\n扫描 ${files} 个文件，${violations ? `${violations} 处违规` : '0 处违规'}`)
console.log(violations ? '1/1 未通过' : '1/1 通过')
process.exit(violations ? 1 : 0)
