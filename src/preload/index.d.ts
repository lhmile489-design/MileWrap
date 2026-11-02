import type { WarpApi } from './index'

declare global {
  interface Window {
    warp: WarpApi
  }
}

export {}
