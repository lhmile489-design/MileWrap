import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { nativeImage } from 'electron'
import type { FileImagePreview, FileTextPreview } from '@shared/types'
import type { FileTreeService } from './FileTreeService'

/** 文本预览：超过这个大小直接拒绝（不读进来再截） */
const TEXT_MAX_BYTES = 2_000_000
/** 文本预览：超过这个大小只读前一段并标 truncated */
const TEXT_TRUNCATE_BYTES = 1_000_000
/** 二进制检测：前 8KB 里出现空字节就当二进制 */
const BINARY_SNIFF_BYTES = 8192
/** 图片预览：原文件大小上限 */
const IMAGE_MAX_BYTES = 20_000_000
/** 图片预览：最长边超过这个值等比缩放 */
const IMAGE_MAX_EDGE = 1600

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico'])

/**
 * 文件预览（目录栏单击文件）：文本按 UTF-8 读，图片缩放后转 data URL。
 * 路径校验复用 FileTreeService.locate：渲染层只给 workspaceId + 相对路径，
 * realpath 越界一律拒绝（技术设计 §8 第 4 条）。
 */
export class FilePreviewService {
  constructor(private files: FileTreeService) {}

  async readText(input: unknown): Promise<FileTextPreview> {
    const { target } = await this.files.locate(input)
    const st = await stat(target)
    if (!st.isFile()) throw new Error('不是文件')
    if (st.size > TEXT_MAX_BYTES) throw new Error(`文件太大（${Math.round(st.size / 1024 / 1024)}MB），不做预览`)
    const buf = await readFile(target)
    const sniff = buf.subarray(0, Math.min(BINARY_SNIFF_BYTES, buf.length))
    const binary = sniff.includes(0)
    // 截断按字符边界切：最后一个完整 UTF-8 字符为止（避免尾部出现半个字符的乱码）
    let content = buf.toString('utf8')
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > TEXT_TRUNCATE_BYTES) {
      content = buf.subarray(0, TEXT_TRUNCATE_BYTES).toString('utf8')
      // 末字符可能被切半：去掉替换符结尾的不完整部分
      content = content.replace(/�[\s\S]*$/, '')
    }
    return { content, truncated: bytes > TEXT_TRUNCATE_BYTES, binary, size: st.size, mtime: st.mtimeMs }
  }

  async readImage(input: unknown): Promise<FileImagePreview> {
    const { target } = await this.files.locate(input)
    const st = await stat(target)
    if (!st.isFile()) throw new Error('不是文件')
    if (!IMAGE_EXTS.has(extname(target).toLowerCase())) throw new Error('不是支持的图片格式（png / jpg / gif / webp / bmp / ico）')
    if (st.size > IMAGE_MAX_BYTES) throw new Error(`图片太大（${Math.round(st.size / 1024 / 1024)}MB），不做预览`)
    const img = nativeImage.createFromPath(target)
    if (img.isEmpty()) throw new Error('无法读取这张图片')
    const { width, height } = img.getSize()
    const edge = Math.max(width, height)
    const scaled = edge > IMAGE_MAX_EDGE ? img.resize({ width: Math.round((width / edge) * IMAGE_MAX_EDGE), height: Math.round((height / edge) * IMAGE_MAX_EDGE) }) : img
    const { width: w, height: h } = scaled.getSize()
    return { dataUrl: scaled.toDataURL(), width: w, height: h, size: st.size, mtime: st.mtimeMs }
  }
}
