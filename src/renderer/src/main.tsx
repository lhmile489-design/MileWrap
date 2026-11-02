import React from 'react'
import { createRoot } from 'react-dom/client'
import App, { preloadDialogs } from './App'
import { preloadWebgl } from './terminal/TerminalRegistry'
import './styles/tokens.css'

async function boot(): Promise<void> {
  const theme = await window.warp.theme.get().catch(() => 'light' as const)
  document.documentElement.dataset.theme = theme
  window.warp.theme.onChange((next) => {
    document.documentElement.dataset.theme = next
  })

  const root = document.getElementById('root')
  if (!root) throw new Error('root element missing')
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
  // 首屏画完后空闲时预取 WebGL 插件与常用弹窗，第一次用到时不用再等加载
  requestIdleCallback(() => {
    void preloadWebgl()
    preloadDialogs()
  })
}

void boot()
