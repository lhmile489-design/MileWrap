/** WCAG 相对亮度与对比度；主进程校验自定义 agent 徽章色、渲染层选前景色共用（UI设计约束 §4.3） */

function channel(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return 0
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => channel(parseInt(x, 16)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** 徽章底色上用黑字还是白字：取对比度更高的那个 */
export function inkOn(bg: string): '#111111' | '#ffffff' {
  return contrast(bg, '#111111') >= contrast(bg, '#ffffff') ? '#111111' : '#ffffff'
}

/** 底色配上自动选的前景色后，对比度是否达到 4.5:1 */
export function badgeReadable(bg: string): boolean {
  return contrast(bg, inkOn(bg)) >= 4.5
}
