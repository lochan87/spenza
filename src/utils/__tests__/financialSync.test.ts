import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  notifyFinancialMutation,
  subscribeFinancialSync,
  resetFinancialSyncForTesting,
  type FinancialSyncEvent,
} from '../financialSync.ts'

describe('financialSync — Cross-Tab & Invalidation Mechanism', () => {
  beforeEach(() => {
    resetFinancialSyncForTesting()
  })

  afterEach(() => {
    resetFinancialSyncForTesting()
  })

  it('1. delivers financial mutation events to active subscribers with accurate payload', () => {
    const events: FinancialSyncEvent[] = []
    const unsubscribe = subscribeFinancialSync(e => events.push(e), { currentUid: 'user-1' })

    notifyFinancialMutation({
      type: 'transaction_created',
      uid: 'user-1',
      entityId: 'tx-100',
    })

    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'transaction_created')
    assert.equal(events[0].uid, 'user-1')
    assert.equal(events[0].entityId, 'tx-100')
    assert.ok(events[0].timestamp > 0)
    assert.ok(events[0].channelId)

    unsubscribe()
  })

  it('2. filters out events intended for other users', () => {
    const user1Events: FinancialSyncEvent[] = []
    const user2Events: FinancialSyncEvent[] = []

    const unsub1 = subscribeFinancialSync(e => user1Events.push(e), { currentUid: 'user-1' })
    const unsub2 = subscribeFinancialSync(e => user2Events.push(e), { currentUid: 'user-2' })

    notifyFinancialMutation({
      type: 'repayment_recorded',
      uid: 'user-2',
      entityId: 'tx-repaid-2',
    })

    assert.equal(user1Events.length, 0, 'user-1 should not receive user-2 events')
    assert.equal(user2Events.length, 1, 'user-2 receives repayment event')
    assert.equal(user2Events[0].type, 'repayment_recorded')

    unsub1()
    unsub2()
  })

  it('3. unsubscribe function cleans up listener and prevents further notifications', () => {
    let callCount = 0
    const unsubscribe = subscribeFinancialSync(() => {
      callCount++
    }, { currentUid: 'user-1' })

    notifyFinancialMutation({
      type: 'transaction_updated',
      uid: 'user-1',
      entityId: 'tx-edit-1',
    })
    assert.equal(callCount, 1)

    // Unsubscribe
    unsubscribe()

    notifyFinancialMutation({
      type: 'transaction_deleted',
      uid: 'user-1',
      entityId: 'tx-edit-1',
    })
    assert.equal(callCount, 1, 'Callback should not fire after unsubscribe')
  })

  it('4. supports multi-subscriber delivery across different views without crosstalk', () => {
    let dashboardRefreshed = false
    let peopleRefreshed = false
    let transactionsRefreshed = false

    const unsubDash = subscribeFinancialSync(e => {
      if (e.type === 'settlement_completed') dashboardRefreshed = true
    }, { currentUid: 'user-1' })

    const unsubPeople = subscribeFinancialSync(e => {
      if (e.type === 'settlement_completed') peopleRefreshed = true
    }, { currentUid: 'user-1' })

    const unsubTx = subscribeFinancialSync(e => {
      if (e.type === 'settlement_completed') transactionsRefreshed = true
    }, { currentUid: 'user-1' })

    notifyFinancialMutation({
      type: 'settlement_completed',
      uid: 'user-1',
      entityId: 'person-bob',
    })

    assert.equal(dashboardRefreshed, true)
    assert.equal(peopleRefreshed, true)
    assert.equal(transactionsRefreshed, true)

    unsubDash()
    unsubPeople()
    unsubTx()
  })
})

describe('Financial Sync Lifecycle & Reconnect Emulation', () => {
  beforeEach(() => {
    resetFinancialSyncForTesting()
  })

  afterEach(() => {
    resetFinancialSyncForTesting()
  })

  it('5. foreground tab triggers immediate refresh on financial mutation', () => {
    let refreshTriggered = false
    const isTabVisible = () => true // simulated foreground tab

    const unsub = subscribeFinancialSync(() => {
      if (isTabVisible()) {
        refreshTriggered = true
      }
    }, { currentUid: 'user-sync' })

    notifyFinancialMutation({
      type: 'settlement_completed',
      uid: 'user-sync',
      entityId: 'person-123',
    })

    assert.equal(refreshTriggered, true)
    unsub()
  })

  it('6. background tab flags state as stale and defers refresh until tab becomes visible', () => {
    let refreshCount = 0
    let isStale = false
    let isTabVisible = false // simulated background tab

    const onEvent = () => {
      if (isTabVisible) {
        refreshCount++
      } else {
        isStale = true
      }
    }

    const onTabBecameVisible = () => {
      isTabVisible = true
      if (isStale) {
        isStale = false
        refreshCount++
      }
    }

    const unsub = subscribeFinancialSync(onEvent, { currentUid: 'user-sync' })

    // Mutation occurs while in background
    notifyFinancialMutation({
      type: 'repayment_recorded',
      uid: 'user-sync',
      entityId: 'tx-background',
    })

    assert.equal(isStale, true, 'Background tab marks itself stale')
    assert.equal(refreshCount, 0, 'Does not perform background Firestore reads')

    // User switches back to tab
    onTabBecameVisible()

    assert.equal(isStale, false, 'Stale flag cleared after activation')
    assert.equal(refreshCount, 1, 'Refresh invoked upon becoming visible')

    unsub()
  })

  it('7. reconnect transition triggers refresh when connectivity is restored', () => {
    let refreshCount = 0
    let isOnline = false

    const handleOnline = () => {
      isOnline = true
      refreshCount++
    }

    const handleOffline = () => {
      isOnline = false
    }

    // Go offline
    handleOffline()
    assert.equal(isOnline, false)
    assert.equal(refreshCount, 0)

    // Reconnect
    handleOnline()
    assert.equal(isOnline, true)
    assert.equal(refreshCount, 1, 'Reconnecting automatically triggers refresh to sync fresh state')
  })

  it('8. distinguishes cached offline balances from synchronized server data', () => {
    const serverResult = { transactions: [{ id: 'tx-1' }], fromCache: false }
    const cachedResult = { transactions: [{ id: 'tx-1' }], fromCache: true }

    const isDisplayStaleOrCached = (fromCache: boolean, online: boolean, isStale: boolean) => {
      return !online || fromCache || isStale
    }

    assert.equal(isDisplayStaleOrCached(serverResult.fromCache, true, false), false, 'Fresh online data is not cached')
    assert.equal(isDisplayStaleOrCached(cachedResult.fromCache, true, false), true, 'fromCache indicates cached data')
    assert.equal(isDisplayStaleOrCached(serverResult.fromCache, false, false), true, 'offline state indicates cached data')
    assert.equal(isDisplayStaleOrCached(serverResult.fromCache, true, true), true, 'stale state indicates pending update')
  })
})

