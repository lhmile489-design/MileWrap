/**
 * 由 resources/icon.svg 生成全部应用图标（SVG 是唯一源文件，改图标改它再跑本脚本）：
 *   build/icon.ico        16 到 256 多尺寸，electron-builder 的 exe / NSIS 图标
 *   build/icon.png        512 像素
 *   resources/icon.png    256 像素，窗口图标与托盘（打包时经 extraResources 放到 resources/ 下）
 *   src/renderer/src/assets/logo.png  128 像素，标题栏与「关于」页
 *
 * 用离屏透明窗口把 SVG 渲染成 1024 母版，再用 nativeImage 缩放、合成 ICO：
 *   npm run icon     （= npx electron scripts/make-icon.cjs）
 */
const { app, BrowserWindow } = require('electron')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

const ROOT = join(__dirname, '..')
const SOURCE = join(ROOT, 'resources', 'icon.svg')
const MASTER = 1024
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

async function render() {
  const svg = readFileSync(SOURCE, 'utf8')
  const win = new BrowserWindow({ show: false, width: MASTER, height: MASTER, useContentSize: true, frame: false, transparent: true, webPreferences: { offscreen: true } })
  const html = '<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:' + MASTER + 'px;height:' + MASTER + 'px}</style>' + svg
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 600))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: MASTER, height: MASTER })
  win.destroy()
  return img
}

function ico(master) {
  const images = ICO_SIZES.map((s) => ({ size: s, data: master.resize({ width: s, height: s, quality: 'best' }).toPNG() }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 = 图标
  header.writeUInt16LE(images.length, 4)
  let offset = 6 + 16 * images.length
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size
    e[1] = size >= 256 ? 0 : size
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    return e
  })
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)])
}

function save(rel, buf) {
  const file = join(ROOT, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, buf)
  console.log('  ' + rel + '  ' + buf.length + ' 字节')
}

app.whenReady().then(async () => {
  try {
    const master = await render()
    const { width, height } = master.getSize()
    if (width < MASTER || height < MASTER) throw new Error('渲染尺寸不对：' + width + 'x' + height)
    const m = width === MASTER ? master : master.resize({ width: MASTER, height: MASTER, quality: 'best' })
    save('build/icon.ico', ico(m))
    save('build/icon.png', m.resize({ width: 512, height: 512, quality: 'best' }).toPNG())
    save('resources/icon.png', m.resize({ width: 256, height: 256, quality: 'best' }).toPNG())
    save('src/renderer/src/assets/logo.png', m.resize({ width: 128, height: 128, quality: 'best' }).toPNG())
    app.exit(0)
  } catch (e) {
    console.error(e)
    app.exit(1)
  }
})
