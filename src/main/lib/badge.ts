import { nativeImage, type NativeImage } from 'electron'

/**
 * 任务栏数字角标（升级建议 2.3）：win.setOverlayIcon 用的 16 / 32px 图标，运行时画出来。
 * 数字用 3×5 点阵字体；超过 9 显示 9+。和托盘绿点一样直接写 BGRA 位图。
 */
const GLYPHS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '+': ['000', '010', '111', '010', '000']
}

/** 强调色 #eb6325（与托盘兜底色同一个品牌色），白字对比度 3.6:1，角标数字是大号粗体，够读 */
const BG = [0x25, 0x63, 0xeb, 0xff]
const FG = [0xff, 0xff, 0xff, 0xff]

function draw(text: string, size: number): Buffer {
  const bmp = Buffer.alloc(size * size * 4)
  const c = size / 2
  const r = size / 2 - 0.5
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x + 0.5 - c, y + 0.5 - c) <= r) bmp.set(BG, (y * size + x) * 4)
    }
  }
  // 每个点阵像素放大成 cell × cell，字之间空一格
  const cell = Math.max(1, Math.floor(size / (text.length > 1 ? 9 : 7)))
  const w = text.length * 3 * cell + (text.length - 1) * cell
  const h = 5 * cell
  const ox = Math.round((size - w) / 2)
  const oy = Math.round((size - h) / 2)
  ;[...text].forEach((ch, i) => {
    const rows = GLYPHS[ch]
    if (!rows) return
    const gx = ox + i * 4 * cell
    rows.forEach((row, ry) => {
      ;[...row].forEach((bit, rx) => {
        if (bit !== '1') return
        for (let dy = 0; dy < cell; dy++) {
          for (let dx = 0; dx < cell; dx++) {
            const px = gx + rx * cell + dx
            const py = oy + ry * cell + dy
            if (px >= 0 && py >= 0 && px < size && py < size) bmp.set(FG, (py * size + px) * 4)
          }
        }
      })
    })
  })
  return bmp
}

const cache = new Map<string, NativeImage>()

/** n ≤ 0 返回 null（清掉角标） */
export function countBadge(n: number): NativeImage | null {
  if (n <= 0) return null
  const text = n > 9 ? '9+' : String(n)
  const hit = cache.get(text)
  if (hit) return hit
  const img = nativeImage.createEmpty()
  for (const [scaleFactor, size] of [
    [1, 16],
    [2, 32]
  ]) {
    const png = nativeImage.createFromBitmap(draw(text, size), { width: size, height: size }).toPNG()
    img.addRepresentation({ scaleFactor, width: size, height: size, buffer: png })
  }
  cache.set(text, img)
  return img
}
