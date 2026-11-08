/**
 * Spenza Financial Sync — Cross-Tab & Offline Consistency Mechanism
 *
 * Provides a lightweight, reliable invalidation and synchronization mechanism
 * using BroadcastChannel and browser events without external state libraries.
 */

export type FinancialMutationType =
  | 'transaction_created'
  | 'transaction_updated'
  | 'transaction_deleted'
  | 'repayment_recorded'
  | 'settlement_completed'
  | 'person_changed'
  | 'bulk_cleared'
  | 'import_completed'

export interface FinancialSyncEvent {
  type: FinancialMutationType
  uid: string
  timestamp: number
  entityId?: string
  channelId: string
}

let channelInstance: BroadcastChannel | null = null
const inProcessListeners = new Set<(event: FinancialSyncEvent) => void>()
let localChannelId = ''

function getChannelId(): string {
  if (!localChannelId) {
    localChannelId = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `tab_${Math.random().toString(36).slice(2)}_${Date.now()}`
  }
  return localChannelId
}

function getBroadcastChannel(): BroadcastChannel | null {
  if (channelInstance) return channelInstance
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channelInstance = new BroadcastChannel('spenza_financial_sync')
      channelInstance.onmessage = (messageEvent: MessageEvent<FinancialSyncEvent>) => {
        const data = messageEvent.data
        if (!data || !data.type || !data.uid) return
        for (const listener of inProcessListeners) {
          try {
            listener(data)
          } catch (err) {
            console.error('[Spenza Financial Sync] Listener error:', err)
          }
        }
      }
    } catch {
      channelInstance = null
    }
  }
  return channelInstance
}

/**
 * Broadcasts a financial mutation to all other open tabs and in-process subscribers.
 */
export function notifyFinancialMutation(payload: {
  type: FinancialMutationType
  uid: string
  entityId?: string
}): void {
  const event: FinancialSyncEvent = {
    ...payload,
    timestamp: Date.now(),
    channelId: getChannelId(),
  }

  // 1. Broadcast to other browser tabs
  const ch = getBroadcastChannel()
  if (ch) {
    try {
      ch.postMessage(event)
    } catch {
      // Ignore broadcast errors in sandboxed or disconnected contexts
    }
  }

  // 2. Dispatch to local in-process listeners
  for (const listener of inProcessListeners) {
    try {
      listener(event)
    } catch (err) {
      console.error('[Spenza Financial Sync] In-process listener error:', err)
    }
  }
}

// Global DOM bridge: forward financial mutations dispatched via CustomEvent to BroadcastChannel and listeners
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('spenza_financial_mutation', ((e: CustomEvent<FinancialSyncEvent>) => {
    const detail = e.detail
    if (!detail || !detail.type || !detail.uid) return
    // Forward to BroadcastChannel and inProcessListeners
    const ch = getBroadcastChannel()
    const syncEvent: FinancialSyncEvent = {
      ...detail,
      timestamp: detail.timestamp || Date.now(),
      channelId: getChannelId(),
    }
    if (ch) {
      try {
        ch.postMessage(syncEvent)
      } catch {
        // ignore
      }
    }
    for (const listener of inProcessListeners) {
      try {
        listener(syncEvent)
      } catch (err) {
        console.error('[Spenza Financial Sync] Listener error:', err)
      }
    }
  }) as EventListener)
}

export interface SubscribeOptions {
  currentUid?: string
  /**
   * If true, ignores events originating from this same execution context.
   * By default BroadcastChannel does not deliver to self, but in-process listeners do.
   */
  ignoreSelf?: boolean
}

/**
 * Subscribes to financial mutation events across tabs and local mutations.
 * Returns an unsubscribe cleanup function.
 */
export function subscribeFinancialSync(
  callback: (event: FinancialSyncEvent) => void,
  options?: SubscribeOptions
): () => void {
  // Ensure the BroadcastChannel is initialized
  getBroadcastChannel()

  const wrappedListener = (event: FinancialSyncEvent) => {
    if (options?.currentUid && event.uid !== options.currentUid) {
      return
    }
    if (options?.ignoreSelf && event.channelId === getChannelId()) {
      return
    }
    callback(event)
  }

  inProcessListeners.add(wrappedListener)

  return () => {
    inProcessListeners.delete(wrappedListener)
  }
}

/**
 * For testing purposes: closes broadcast channel and resets listeners.
 */
export function resetFinancialSyncForTesting(): void {
  inProcessListeners.clear()
  if (channelInstance) {
    try {
      channelInstance.close()
    } catch {
      // Ignore
    }
    channelInstance = null
  }
  localChannelId = ''
}

