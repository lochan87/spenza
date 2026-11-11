import { useState, useEffect } from 'react'
import {
  collection,
  query,
  limit,
  orderBy,
  onSnapshot,
} from 'firebase/firestore'
import { db } from '@/firebase/config'
import {
  subscribePendingWrites,
  pendingWritesTracker,
  type PendingWritesState,
} from '@/services/pendingWrites'

export function usePendingWrites(uid?: string | null): PendingWritesState {
  const [state, setState] = useState<PendingWritesState>(() =>
    pendingWritesTracker.getState()
  )

  useEffect(() => {
    return subscribePendingWrites(setState)
  }, [])

  // Listen to Firestore snapshot metadata changes if user is authenticated
  useEffect(() => {
    if (!uid) return

    let isMounted = true
    const q = query(
      collection(db, 'users', uid, 'transactions'),
      orderBy('date', 'desc'),
      limit(20)
    )

    const unsubscribe = onSnapshot(
      q,
      { includeMetadataChanges: true },
      snapshot => {
        if (!isMounted) return
        if (snapshot.metadata.hasPendingWrites) {
          pendingWritesTracker.updateState({
            hasPendingWrites: true,
            isSyncing: navigator.onLine,
          })
          if (navigator.onLine) {
            pendingWritesTracker.syncPendingWrites()
          }
        } else if (!snapshot.metadata.fromCache && navigator.onLine) {
          // If fresh from server and no pending writes on snapshot, check global db writes
          pendingWritesTracker.syncPendingWrites()
        }
      },
      error => {
        console.warn('[usePendingWrites] Snapshot error:', error)
      }
    )

    return () => {
      isMounted = false
      unsubscribe()
    }
  }, [uid])

  return state
}
