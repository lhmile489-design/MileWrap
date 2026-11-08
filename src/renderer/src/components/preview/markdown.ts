import { marked } from 'marked'

/**
 * Markdown → 安全 HTML（技术设计 §6.4 预览栏）：marked 出 HTML，DOMParser 白名单清洗。
 * 这是全项目唯一允许 innerHTML 的位置，宁可丢格式也不放行脚本：
 * - 剥掉 script/style/iframe/object/embed/form/input 及所有 on* 属性
 * - a 只留 http/https（javascript: / data: 一律剥）；img 只留 http(s) 与相对路径（相对路径由调用方换 data URL）
 * - class 只放行 code 的 language-*；其余属性白名单见 ALLOWED_ATTR
 */
marked.setOptions({ gfm: true, breaks: false })

const ALLOWED_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'hr', 'blockquote',
  'ul', 'ol', 'li',
  'pre', 'code',
  'a', 'strong', 'em', 'del', 's', 'b', 'i', 'u', 'mark', 'small', 'sub', 'sup', 'kbd', 'samp', 'var', 'abbr', 'cite', 'q', 'dfn', 'time',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'img', 'figure', 'figcaption',
  'details', 'summary',
  'input' // 仅 checkbox（下面单独处理 type / disabled）
])

const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'textarea', 'select', 'button',
  'template', 'noscript', 'svg', 'math', 'video', 'audio', 'source', 'link', 'meta', 'base'
])

/** 元素 -> 允许的额外属性；白名单之外的元素只留通用属性 */
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  code: new Set(['class']),
  input: new Set(['type', 'checked', 'disabled']),
  th: new Set(['align']),
  td: new Set(['align']),
  col: new Set(['align']),
  colgroup: new Set(['align']),
  details: new Set(['open']),
  time: new Set(['datetime']),
  ol: new Set(['start', 'reversed', 'type'])
}

const COMMON_ATTRS = new Set(['title', 'id', 'dir', 'lang'])

function safeHref(v: string): boolean {
  const t = v.trim().replace(/[\u0000- ]/g, '')
  if (/^https?:/i.test(t)) return true
  // 锚点与相对路径放行（javascript: / data: / vbscript: / file: 全剥）
  if (/^[./#?]/.test(t) && !/^[a-z][a-z0-9+.-]*:/i.test(t)) return true
  return false
}

function safeImgSrc(v: string): boolean {
  const t = v.trim().replace(/[\u0000- ]/g, '')
  if (/^https?:/i.test(t)) return true
  // 相对路径放行（调用方会换成 fs:readImage 的 data URL）；协议 / 绝对路径一律剥
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(t)) return false
  return true
}

function sanitizeNode(node: Element | ChildNode): void {
  if (node.nodeType !== Node.ELEMENT_NODE) return
  const el = node as Element
  const tag = el.tagName.toLowerCase()

  if (DROP_WITH_CONTENT.has(tag)) {
    // 危险标签连内容一起丢（script/style 的文本绝不能回灌进 DOM）
    el.remove()
    return
  }
  if (!ALLOWED_TAGS.has(tag)) {
    // 不认识但无害的标签：剥标签留文本
    const text = el.textContent ?? ''
    el.replaceWith(document.createTextNode(text))
    return
  }

  // 属性白名单
  const extra = TAG_ATTRS[tag] ?? new Set<string>()
  for (const attr of [...el.attributes]) {
    const n = attr.name.toLowerCase()
    if (n.startsWith('on')) {
      el.removeAttribute(attr.name)
      continue
    }
    if (n === 'style' || n === 'class') {
      if (tag === 'code' && n === 'class') {
        const cls = attr.value.trim()
        if (!/^language-[a-zA-Z0-9_-]+$/.test(cls)) el.removeAttribute(attr.name)
        continue
      }
      el.removeAttribute(attr.name)
      continue
    }
    if (!COMMON_ATTRS.has(n) && !extra.has(n)) {
      el.removeAttribute(attr.name)
      continue
    }
    if (tag === 'a' && n === 'href' && !safeHref(attr.value)) el.removeAttribute(attr.name)
    if (tag === 'img' && n === 'src' && !safeImgSrc(attr.value)) el.removeAttribute(attr.name)
  }

  // 元素级校正
  if (tag === 'a') {
    el.setAttribute('target', '_blank')
    el.setAttribute('rel', 'noopener noreferrer nofollow')
  }
  if (tag === 'input') {
    // 只留 checkbox，且强制 disabled（GFM 任务列表渲染用，不许交互）
    if (el.getAttribute('type') !== 'checkbox') {
      el.replaceWith(document.createTextNode(el.textContent ?? ''))
      return
    }
    el.setAttribute('disabled', '')
    el.setAttribute('tabindex', '-1')
  }
  if (tag === 'img' && !el.hasAttribute('src')) {
    el.remove()
    return
  }

  for (const child of [...el.childNodes]) sanitizeNode(child)
}

/** markdown → 清洗后的 HTML；调用方负责 innerHTML 与相对图片替换 */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string
  const doc = new DOMParser().parseFromString(`<div>${raw}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return ''
  for (const child of [...root.childNodes]) sanitizeNode(child)
  return root.innerHTML
}
