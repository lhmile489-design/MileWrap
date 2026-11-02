import { useRef, useState } from 'react'

/**
 * 分隔条（UI设计约束 §3）：视觉 2px，命中区 6–8px，悬停 / 拖动变 accent。
 * - vertical：竖条，左右拖（col-resize）；horizontal：横条，上下拖（row-resize）
 * - 指针拖动用 pointer capture，拖出窗口也不丢；键盘方向键按步长调整（可访问性）
 * 只上报指针坐标，比例 / 宽度由调用方换算与夹取。
 */
export function Splitter({
  orientation,
  label,
  value,
  onDrag,
  onStep,
  className = '',
  testId
}: {
  orientation: 'vertical' | 'horizontal'
  label: string
  /** aria-valuenow，0–100 */
  value: number
  onDrag: (clientPos: number) => void
  /** 方向键：-1 / +1 */
  onStep: (dir: -1 | 1) => void
  className?: string
  testId?: string
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const pointer = useRef<number | null>(null)
  const vertical = orientation === 'vertical'

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      data-testid={testId}
      data-dragging={dragging || undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        pointer.current = e.pointerId
        setDragging(true)
        document.documentElement.dataset.resizing = vertical ? 'col' : 'row'
      }}
      onPointerMove={(e) => {
        if (pointer.current !== e.pointerId) return
        onDrag(vertical ? e.clientX : e.clientY)
      }}
      onPointerUp={(e) => {
        if (pointer.current !== e.pointerId) return
        pointer.current = null
        setDragging(false)
        delete document.documentElement.dataset.resizing
      }}
      onLostPointerCapture={() => {
        pointer.current = null
        setDragging(false)
        delete document.documentElement.dataset.resizing
      }}
      onKeyDown={(e) => {
        const back = vertical ? 'ArrowLeft' : 'ArrowUp'
        const fwd = vertical ? 'ArrowRight' : 'ArrowDown'
        if (e.key !== back && e.key !== fwd) return
        e.preventDefault()
        onStep(e.key === back ? -1 : 1)
      }}
      className={`group/split relative z-10 flex shrink-0 touch-none items-center justify-center outline-none ${
        vertical ? 'w-2 cursor-col-resize self-stretch' : 'h-2 cursor-row-resize'
      } ${className}`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none rounded-pill transition-colors duration-150 group-hover/split:bg-accent group-focus-visible/split:bg-accent ${
          dragging ? 'bg-accent' : 'bg-transparent'
        } ${vertical ? 'h-full w-0.5' : 'h-0.5 w-full'}`}
      />
    </div>
  )
}

/**
 * 栏位右边缘的拖拽条：会话栏 160–320px、目录栏 180–400px（技术设计 §4 LayoutState）。
 * 贴在栏的右边框上，压住 3px，命中区 8px。
 */
export function RailResizer({
  label,
  width,
  min,
  max,
  onResize,
  testId
}: {
  label: string
  width: number
  min: number
  max: number
  onResize: (px: number) => void
  testId?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} className="absolute inset-y-0 -right-1 flex">
      <Splitter
        orientation="vertical"
        label={label}
        value={((width - min) / (max - min)) * 100}
        onDrag={(x) => {
          const rail = ref.current?.parentElement?.getBoundingClientRect()
          if (rail) onResize(x - rail.left)
        }}
        onStep={(d) => onResize(width + d * 16)}
        testId={testId}
      />
    </div>
  )
}
