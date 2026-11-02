import { useLayoutEffect, useRef, useState } from 'react'
import { LAYOUT_LIMITS } from '@shared/types'
import { useLayout, visibleCount } from '../store/layout'
import { Splitter } from './Splitter'
import { TerminalPane } from './TerminalPane'

const GAP = 8
const STEP = 0.02

/** 把比例夹到「两侧都不低于 minCell」的范围；放不下两格时取 0.5；尺寸未知（0）时原样返回 */
function fitRatio(ratio: number, size: number, minCell: number): number {
  if (size <= 0) return ratio
  const min = (minCell + GAP / 2) / size
  if (min >= 0.5) return 0.5
  return Math.min(1 - min, Math.max(min, ratio))
}

/**
 * 宫格控制台（技术设计 §6.1）：single 一格；dual 左右两格（splitRatioH）；quad 2×2（splitRatioH / splitRatioV）。
 * 分隔条拖动只改比例，不改 DOM 结构，xterm 宿主节点不会被重建。
 * 切换模式不销毁任何会话：隐藏位置上的会话转入后台，切回时接上。
 */
export function Grid(): React.JSX.Element {
  const mode = useLayout((s) => s.gridMode)
  const maximized = useLayout((s) => s.maximized)
  const ratioH = useLayout((s) => s.splitRatioH)
  const ratioV = useLayout((s) => s.splitRatioV)
  const setRatio = useLayout((s) => s.setRatio)
  const count = useLayout((s) => visibleCount(s))
  const boxRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setBox((b) => (b.width === width && b.height === height ? b : { width, height }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** 指针位置 → 比例；两侧各保证最小格尺寸，容器放不下两格时停在中间 */
  const dragTo = (axis: 'H' | 'V', pos: number): void => {
    const box = boxRef.current?.getBoundingClientRect()
    if (!box) return
    const size = axis === 'H' ? box.width : box.height
    const start = axis === 'H' ? box.left : box.top
    const minCell = axis === 'H' ? LAYOUT_LIMITS.cell.width : LAYOUT_LIMITS.cell.height
    setRatio(axis, fitRatio((pos - start) / size, size, minCell))
  }
  const step = (axis: 'H' | 'V', dir: -1 | 1): void => {
    const cur = axis === 'H' ? useLayout.getState().splitRatioH : useLayout.getState().splitRatioV
    setRatio(axis, cur + dir * STEP)
  }

  // 窗口变窄时按当前尺寸夹取比例，保证每格不低于 360×240；只影响显示，存下的比例不变，变宽后恢复
  const vars = {
    '--rh': fitRatio(ratioH, box.width, LAYOUT_LIMITS.cell.width),
    '--rv': fitRatio(ratioV, box.height, LAYOUT_LIMITS.cell.height)
  } as React.CSSProperties
  // 第一列 / 第一行的尺寸：比例减去半个格间距；第二个 flex-1 吃掉剩余
  const firstCol = 'basis-[calc(var(--rh)*100%-4px)] shrink-0 grow-0'
  const firstRow = 'basis-[calc(var(--rv)*100%-4px)] shrink-0 grow-0'
  const hSplit = (
    <Splitter
      orientation="vertical"
      label="调整左右格宽度"
      value={ratioH * 100}
      onDrag={(p) => dragTo('H', p)}
      onStep={(d) => step('H', d)}
      testId="split-h"
    />
  )

  let body: React.ReactNode
  if (count === 1 || maximized !== null) {
    body = <TerminalPane index={maximized ?? 0} />
  } else if (mode === 'dual') {
    body = (
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className={`flex min-w-0 ${firstCol}`}>
          <TerminalPane index={0} />
        </div>
        {hSplit}
        <div className="flex min-w-0 flex-1">
          <TerminalPane index={1} />
        </div>
      </div>
    )
  } else {
    body = (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className={`flex min-h-0 ${firstRow}`}>
          <div className={`flex min-w-0 ${firstCol}`}>
            <TerminalPane index={0} />
          </div>
          {hSplit}
          <div className="flex min-w-0 flex-1">
            <TerminalPane index={1} />
          </div>
        </div>
        <Splitter
          orientation="horizontal"
          label="调整上下格高度"
          value={ratioV * 100}
          onDrag={(p) => dragTo('V', p)}
          onStep={(d) => step('V', d)}
          testId="split-v"
        />
        <div className="flex min-h-0 flex-1">
          <div className={`flex min-w-0 ${firstCol}`}>
            <TerminalPane index={2} />
          </div>
          {/* 下排共用同一个左右比例；这条分隔条和上排的联动 */}
          <Splitter
            orientation="vertical"
            label="调整左右格宽度"
            value={ratioH * 100}
            onDrag={(p) => dragTo('H', p)}
            onStep={(d) => step('H', d)}
          />
          <div className="flex min-w-0 flex-1">
            <TerminalPane index={3} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <main aria-label="控制台" data-grid={mode} className="console-dots relative flex min-h-0 min-w-0 flex-1 p-2">
      <div ref={boxRef} className="flex min-h-0 min-w-0 flex-1" style={vars}>
        {body}
      </div>
    </main>
  )
}
