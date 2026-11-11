import { useState, useEffect, useRef } from 'react'
import { Wifi, WifiOff, AlertTriangle, RefreshCw } from 'lucide-react'
import { usePendingWrites } from '@/hooks/usePendingWrites'

/**
 * Shows a subtle "offline" banner when the browser reports no network or has pending writes.
 * Displays synchronization state when connectivity is restored.
 */
export function OfflineBanner() {
  const { isOnline, hasPendingWrites, isSyncing } = usePendingWrites()
  const [showRestored, setShowRestored] = useState(false)
  const prevOnlineRef = useRef(isOnline)

  useEffect(() => {
    if (!prevOnlineRef.current && isOnline) {
      setShowRestored(true)
      const timer = setTimeout(() => setShowRestored(false), 3000)
      prevOnlineRef.current = isOnline
      return () => clearTimeout(timer)
    }
    prevOnlineRef.current = isOnline
  }, [isOnline])

  if (isOnline && !showRestored && !hasPendingWrites && !isSyncing) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className={`mt-3 flex w-full items-center gap-2 rounded-xl px-4 py-2 text-xs font-medium shadow-[var(--shadow-lg)] transition-all duration-300 ${
        isOnline
          ? 'bg-[var(--success)] text-white'
          : hasPendingWrites
            ? 'bg-[var(--surface)] border border-[var(--warning)] text-[var(--warning)]'
            : 'bg-[var(--surface)] border border-[var(--warning)] text-[var(--warning)]'
      }`}
    >
      {isOnline ? (
        isSyncing || hasPendingWrites ? (
          <>
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            Back online — syncing…
          </>
        ) : (
          <>
            <Wifi className="h-3.5 w-3.5" />
            Back online — syncing…
          </>
        )
      ) : hasPendingWrites ? (
        <>
          <AlertTriangle className="h-3.5 w-3.5" />
          Offline — unsaved changes will sync when reconnected
        </>
      ) : (
        <>
          <WifiOff className="h-3.5 w-3.5" />
          Offline — expenses will sync when reconnected
        </>
      )}
    </div>
  )
}
