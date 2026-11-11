import type { Firestore } from 'firebase/firestore'
import { waitForPendingWrites } from 'firebase/firestore'

export interface PendingWritesState {
  hasPendingWrites: boolean
  isOnline: boolean
  isSyncing: boolean
}

type Listener = (state: PendingWritesState) => void

export interface PendingWritesTrackerOptions {
  getDb?: () => Promise<Firestore>
  waitFn?: (db: Firestore) => Promise<void>
  initialOnline?: boolean
}

export class PendingWritesTracker {
  private listeners = new Set<Listener>()
  private state: PendingWritesState
  private syncPromise: Promise<void> | null = null
  private getDb: () => Promise<Firestore>
  private waitFn: (db: Firestore) => Promise<void>

  constructor(options?: PendingWritesTrackerOptions) {
    this.getDb =
      options?.getDb ||
      (async () => {
        try {
          const mod = await import('@/firebase/config')
          return mod.db
        } catch {
          try {
            const mod = await import('../firebase/config.ts')
            return mod.db
          } catch {
            return {} as Firestore
          }
        }
      })
    this.waitFn =
      options?.waitFn ||
      (async (db: Firestore) => {
        if (!db || typeof (db as any).app === 'undefined') return
        await waitForPendingWrites(db)
      })

    const defaultOnline =
      typeof options?.initialOnline === 'boolean'
        ? options.initialOnline
        : typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean'
          ? navigator.onLine
          : true

    this.state = {
      hasPendingWrites: false,
      isOnline: defaultOnline,
      isSyncing: false,
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline)
      window.addEventListener('offline', this.handleOffline)
      window.addEventListener(
        'spenza_financial_mutation',
        this.handleFinancialMutation as EventListener
      )
    }
  }

  private handleFinancialMutation = (event: CustomEvent<{ type?: string }>) => {
    if (event.detail?.type === 'transaction_created') {
      this.recordLocalMutation()
    }
  }

  public handleOnline = () => {
    this.updateState({ isOnline: true })
    if (this.state.hasPendingWrites) {
      this.syncPendingWrites()
    }
  }

  public handleOffline = () => {
    this.updateState({ isOnline: false, isSyncing: false })
  }

  public getState(): PendingWritesState {
    return { ...this.state }
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => {
      this.listeners.delete(listener)
    }
  }

  public updateState(partial: Partial<PendingWritesState>) {
    const prev = this.state
    const next: PendingWritesState = { ...prev, ...partial }
    if (
      prev.hasPendingWrites !== next.hasPendingWrites ||
      prev.isOnline !== next.isOnline ||
      prev.isSyncing !== next.isSyncing
    ) {
      this.state = next
      this.notify()
    }
  }

  private notify() {
    const current = this.getState()
    this.listeners.forEach(fn => {
      try {
        fn(current)
      } catch (err) {
        console.error('[PendingWritesTracker] Error in listener:', err)
      }
    })
  }

  /**
   * Called when a local write mutation is queued (e.g. offline expense creation).
   */
  public recordLocalMutation() {
    this.updateState({
      hasPendingWrites: true,
      isSyncing: this.state.isOnline,
    })
    if (this.state.isOnline) {
      this.syncPendingWrites()
    }
  }

  /**
   * Waits for Firestore to acknowledge all pending writes to the server.
   */
  public async syncPendingWrites(): Promise<boolean> {
    if (this.syncPromise) {
      await this.syncPromise
      return !this.state.hasPendingWrites
    }

    if (!this.state.isOnline) {
      this.updateState({ isSyncing: false })
      return false
    }

    this.updateState({ isSyncing: true })

    this.syncPromise = (async () => {
      try {
        const db = await this.getDb()
        await this.waitFn(db)
        this.updateState({
          hasPendingWrites: false,
          isSyncing: false,
        })
      } catch (err) {
        console.warn('[PendingWritesTracker] waitForPendingWrites error:', err)
        this.updateState({ isSyncing: false })
      } finally {
        this.syncPromise = null
      }
    })()

    await this.syncPromise
    return !this.state.hasPendingWrites
  }

  /**
   * For testing or cleanup.
   */
  public destroy() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline)
      window.removeEventListener('offline', this.handleOffline)
      window.removeEventListener(
        'spenza_financial_mutation',
        this.handleFinancialMutation as EventListener
      )
    }
    this.listeners.clear()
  }
}

export const pendingWritesTracker = new PendingWritesTracker()

export function getPendingWritesState(): PendingWritesState {
  return pendingWritesTracker.getState()
}

export function subscribePendingWrites(listener: Listener): () => void {
  return pendingWritesTracker.subscribe(listener)
}

export function recordLocalMutation(): void {
  pendingWritesTracker.recordLocalMutation()
}

export function syncPendingWrites(): Promise<boolean> {
  return pendingWritesTracker.syncPendingWrites()
}
