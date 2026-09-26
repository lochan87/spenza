import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

interface DrawerProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  title?: string
}

/**
 * Responsive drawer:
 * - On desktop: slides in from the right as a panel (max-w-md)
 * - On mobile: slides up from the bottom as a full-screen sheet
 */
export function Drawer({ open, onClose, children }: DrawerProps) {
  const overlayRef = useRef<HTMLDivElement>(null)

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  // Prevent body scroll when open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div
        ref={overlayRef}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel — right side on desktop, bottom sheet on mobile */}
      <div
        className="
          relative ml-auto flex h-full w-full max-w-md flex-col
          bg-[var(--surface)] shadow-[var(--shadow-xl)]
          md:rounded-l-2xl
          /* Mobile: full width bottom sheet */
          max-md:fixed max-md:bottom-0 max-md:left-0 max-md:right-0
          max-md:h-[92dvh] max-md:w-full max-md:max-w-full
          max-md:rounded-t-2xl max-md:rounded-l-none
        "
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  )
}
