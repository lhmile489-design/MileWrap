import { memo, useEffect, useMemo, useRef } from 'react'
import { notifyError } from '../ConfirmDialog'
import { renderMarkdown } from './markdown'

function dirname(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

/**
 * Markdown 渲染视图（技术设计 §6.4）：marked + 白名单 sanitizer，React.lazy 分包。
 * - <a> 点击一律拦下走 shell.openUrl（http/https 白名单在主进程）
 * - 相对路径图片：拼 md 所在目录后仍走 fs:readImage，越界主进程拒；
 *   换来的 data URL 直接塞进 <img src>（CSP img-src 'self' data:）
 */
export const MarkdownView = memo(function MarkdownView({
  workspaceId,
  rel,
  content
}: {
  workspaceId: string
  rel: string
  content: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => renderMarkdown(content), [content])
  const dir = dirname(rel)

  // 相对图片 → data URL（一次渲染完再逐个替换；替换失败的留空占位）
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const imgs = [...root.querySelectorAll<HTMLImageElement>('img[src]')]
    let alive = true
    for (const img of imgs) {
      const src = img.getAttribute('src') ?? ''
      if (/^https?:/i.test(src)) {
        // 外链图：CSP 不放行，整块拿掉换占位文字
        img.replaceWith(`[外链图片 ${img.getAttribute('alt') ?? src}]`)
        continue
      }
      const rel2 = joinRel(dir, src)
      void window.warp.fs
        .readImage(workspaceId, rel2)
        .then((d) => {
          if (alive) img.src = d.dataUrl
        })
        .catch(() => {
          if (alive) img.replaceWith(`[图片无法读取 ${src}]`)
        })
    }
    return () => {
      alive = false
    }
  }, [html, workspaceId, dir])

  const onClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (/^https?:/i.test(href)) {
      void window.warp.shell.openUrl(href).catch((err: unknown) => notifyError(err, '打开链接失败'))
    }
  }

  // sanitizer 已把输出收敛到白名单标签 + 白名单属性；这是全项目唯一的 innerHTML 使用点
  return (
    <div
      ref={ref}
      role="document"
      aria-label={rel}
      className="md-body min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-3"
      data-testid="preview-markdown"
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
})
