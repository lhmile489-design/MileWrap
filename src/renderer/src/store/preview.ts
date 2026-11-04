import { create } from 'zustand'
import type { FileImagePreview, FileTextPreview } from '@shared/types'
import { errorText } from '../lib/errors'
import { useLayout } from './layout'

/** 文本 / 代码类走 readText；图片类走 readImage（主进程按扩展名卡白名单） */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])
const MD_EXTS = new Set(['md', 'mdx', 'markdown'])

export type PreviewTarget = {
  workspaceId: string
  /** 工作区内相对路径（/ 分隔），与目录栏 joinRel 一致 */
  rel: string
  name: string
}

type PreviewResult =
  | { kind: 'text'; data: FileTextPreview }
  | { kind: 'image'; data: FileImagePreview }

type PreviewState = {
  target: PreviewTarget | null
  /** 正在预览哪份内容；loading 为 true 时内容是上一个目标的（reqId 挡住竞态） */
  loading: boolean
  result: PreviewResult | null
  error: string | null
  open: (t: PreviewTarget) => void
  close: () => void
  /** 切工作区 / 工作区被删：清空预览内容（栏位偏好不动） */
  clear: () => void
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function isMarkdown(name: string): boolean {
  return MD_EXTS.has(extOf(name))
}

export function isImage(name: string): boolean {
  return IMAGE_EXTS.has(extOf(name))
}

/** 预览目标（技术设计 §6.4 预览栏）：单击文件即载入，展开预览栏 */
export const usePreview = create<PreviewState>((set, get) => {
  /** 每开一次 +1；异步回来时对不上的直接丢（点了别的文件 / 已关闭） */
  let reqId = 0
  return {
    target: null,
    loading: false,
    result: null,
    error: null,

    open: (t) => {
      const id = ++reqId
      set({ target: t, loading: true, error: null })
      // 栏收起时单击文件顺手展开（用户动作优先于自动收栏）
      const layout = useLayout.getState()
      if (!layout.previewRailVisible) layout.togglePreviewRail()
      const req: Promise<PreviewResult> = isImage(t.name)
        ? window.warp.fs.readImage(t.workspaceId, t.rel).then((data) => ({ kind: 'image', data }))
        : window.warp.fs.readText(t.workspaceId, t.rel).then((data) => ({ kind: 'text', data }))
      req
        .then((result) => {
          if (reqId !== id) return
          set({ result, loading: false })
        })
        .catch((e) => {
          if (reqId !== id) return
          set({ result: null, loading: false, error: errorText(e) })
        })
    },

    close: () => {
      reqId++
      set({ target: null, loading: false, result: null, error: null })
    },

    clear: () => get().close()
  }
})
