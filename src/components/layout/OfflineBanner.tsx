import { useState, useEffect } from 'react'
import { Wifi, WifiOff } from 'lucide-react'

/**
 * Shows a subtle "offline" banner when the browser reports no network.
 * Disappears as soon as connectivity is restored.
 * Note: Firestore has offline persistence enabled — any writes made while offline
 * will be queued and synced automatically on reconnect.
 */
export function OfflineBanner() {
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [showRestored, setShowRestored] = useState(false)

  useEffect(() => {
    const onOnline  = () => { setIsOnline(true);  setShowRestored(true); setTimeout(() => setShowRestored(false), 3000) }
    const onOffline = () => { setIsOnline(false); setShowRestored(false) }
    window.addEventListener('online',  onOnline)
    window.addEventListener('offline', onOffline)
    return () => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline) }
  }, [])

  if (isOnline && !showRestored) return null

  return (
    <div
      className={`fixed left-1/2 top-16 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-xs font-medium shadow-[var(--shadow-lg)] transition-all duration-300 ${
        isOnline
          ? 'bg-[var(--success)] text-white'
          : 'bg-[var(--surface)] border border-[var(--warning)] text-[var(--warning)]'
      }`}
    >
      {isOnline
        ? <><Wifi className="h-3.5 w-3.5" /> Back online — syncing…</>
        : <><WifiOff className="h-3.5 w-3.5" /> Offline — expenses will sync when reconnected</>}
    </div>
  )
}
