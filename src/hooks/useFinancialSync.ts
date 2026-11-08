import { useState, useEffect, useCallback, useRef } from 'react'
import { subscribeFinancialSync, type FinancialSyncEvent } from '@/utils/financialSync'

export interface UseFinancialSyncOptions {
  uid: string | null | undefined
  onRefresh: () => void | Promise<void>
  isFromCache?: boolean
}

export interface UseFinancialSyncReturn {
  isOnline: boolean
  isStale: boolean
  isFromCache: boolean
  refresh: () => void
}

export function useFinancialSync({
  uid,
  onRefresh,
  isFromCache = false,
}: UseFinancialSyncOptions): UseFinancialSyncReturn {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  )
  const [isStale, setIsStale] = useState(false)
  const onRefreshRef = useRef(onRefresh)
  onRefreshRef.current = onRefresh

  const refresh = useCallback(() => {
    setIsStale(false)
    return onRefreshRef.current()
  }, [])

  // 1. Network connectivity (online / offline)
  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleOnline = () => {
      setIsOnline(true)
      // When network returns, refresh data to get freshly synchronized server state
      refresh()
    }

    const handleOffline = () => {
      setIsOnline(false)
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [refresh])

  // 2. Cross-tab invalidation listener
  useEffect(() => {
    if (!uid) return

    const unsubscribe = subscribeFinancialSync(
      (event: FinancialSyncEvent) => {
        if (event.uid !== uid) return

        // If tab is currently active and visible, refresh immediately
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
          refresh()
        } else {
          // Tab is hidden / backgrounded: mark stale and refresh when user returns
          setIsStale(true)
        }
      },
      { currentUid: uid, ignoreSelf: true }
    )

    return () => {
      unsubscribe()
    }
  }, [uid, refresh])

  // 3. Tab visibility / window focus listener: refresh when returning to a stale tab
  useEffect(() => {
    if (typeof document === 'undefined') return

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isStale) {
        refresh()
      }
    }

    const handleFocus = () => {
      if (isStale) {
        refresh()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [isStale, refresh])

  return {
    isOnline,
    isStale,
    isFromCache,
    refresh,
  }
}

