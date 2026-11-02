/**
 * 汉字拼音首字母（升级建议 3.5）：不带字表，用中文排序规则（zh-Hans-CN 按拼音排）找每个字落在哪两个边界字之间。
 * 边界字是各声母在拼音序里的第一个常用字；Chromium 自带完整 ICU，结果与字表法一致，多音字取排序规则的默认读音。
 */
const LETTERS = 'ABCDEFGHJKLMNOPQRSTWXYZ'
const BOUNDS = '阿八嚓哒妸发旮哈讥咔垃妈拏噢妑七呥仨他屲夕丫帀'

let collator: Intl.Collator | null = null

function initialOf(ch: string): string {
  if (!/[一-鿿]/.test(ch)) return /[A-Za-z0-9]/.test(ch) ? ch.toLowerCase() : ''
  collator ??= new Intl.Collator('zh-Hans-CN')
  let lo = 0
  let hi = BOUNDS.length - 1
  if (collator.compare(ch, BOUNDS[0]) < 0) return ''
  // 二分：最后一个 <= ch 的边界字
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (collator.compare(ch, BOUNDS[mid]) >= 0) lo = mid
    else hi = mid - 1
  }
  return LETTERS[lo].toLowerCase()
}

const cache = new Map<string, string>()

/** 「客户端 Claude」→「khdclaude」；只保留字母数字 */
export function initials(text: string): string {
  const hit = cache.get(text)
  if (hit !== undefined) return hit
  const out = [...text].map(initialOf).join('')
  if (cache.size > 2000) cache.clear()
  cache.set(text, out)
  return out
}
