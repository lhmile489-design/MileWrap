import { useSyncExternalStore } from 'react'
import type { SessionMeta } from '@shared/types'

export function isLive(s: SessionMeta): boolean {
  return s.status === 'starting' || s.status === 'running'
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/**
 * 共享的 1 秒时钟：所有运行时长共用一个计时器，同一拍里一起刷新（一次批量渲染），
 * 而不是每行各起一个 setInterval、各自错开时间渲染。没人订阅时停表；窗口隐藏（最小化 / 收进托盘）时不推送，
 * 回到前台立即补一拍。
 */
const listeners = new Set<() => void>()
let timer: number | null = null
let now = Date.now()

function tick(): void {
  now = Date.now()
  for (const l of listeners) l()
}

function onVisibility(): void {
  if (document.visibilityState === 'visible' && listeners.size) tick()
}

function subscribeClock(cb: () => void): () => void {
  listeners.add(cb)
  if (timer === null) {
    now = Date.now()
    timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') tick()
    }, 1000)
    document.addEventListener('visibilitychange', onVisibility)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer)
      timer = null
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}

const noSubscribe = (): (() => void) => () => undefined
const getNow = (): number => now

/** 运行时长：运行中跟着共享时钟每秒刷新，退出后定格在结束时刻（不再订阅） */
export function useUptime(session: SessionMeta): string {
  const live = isLive(session)
  const t = useSyncExternalStore(live ? subscribeClock : noSubscribe, getNow)
  // 刚挂载、时钟还没走第一拍时 now 可能早于启动时刻
  return formatDuration((session.endedAt ?? Math.max(t, Date.now())) - session.startedAt)
}
