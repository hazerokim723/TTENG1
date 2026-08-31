import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { wordPopoverPosition } from './scriptInteractions'

export function WordPopover({ x, y, compact = false, children }: { x: number; y: number; compact?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const place = () => {
      const { width, height } = element.getBoundingClientRect()
      const { left, top } = wordPopoverPosition(x, y, width, height, window.innerWidth, window.innerHeight)
      element.style.left = `${left}px`
      element.style.top = `${top}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    window.addEventListener('resize', place)
    return () => { observer.disconnect(); window.removeEventListener('resize', place) }
  }, [x, y])
  return createPortal(<aside ref={ref} className={`word-popover${compact ? ' word-popover-compact' : ''}`} role="dialog" aria-label="단어 뜻" aria-live="polite">{children}</aside>, document.body)
}
