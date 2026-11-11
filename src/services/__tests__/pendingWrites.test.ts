import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PendingWritesTracker,
  pendingWritesTracker,
  getPendingWritesState,
  subscribePendingWrites,
  recordLocalMutation,
  type PendingWritesState,
} from '../pendingWrites.ts'

test('pendingWritesTracker manages offline write mutation state and subscriptions', async (t) => {
  await t.test('initial state reflects default state', () => {
    const state = getPendingWritesState()
    assert.equal(typeof state.hasPendingWrites, 'boolean')
    assert.equal(typeof state.isOnline, 'boolean')
    assert.equal(typeof state.isSyncing, 'boolean')
  })

  await t.test('recordLocalMutation sets hasPendingWrites to true and notifies subscribers', () => {
    const observed: PendingWritesState[] = []
    const unsubscribe = subscribePendingWrites((state) => {
      observed.push(state)
    })

    recordLocalMutation()
    const latest = getPendingWritesState()
    assert.equal(latest.hasPendingWrites, true)
    assert.ok(observed.some((s) => s.hasPendingWrites === true))

    unsubscribe()
  })

  await t.test('manual updateState updates state and notifies active subscribers', () => {
    let callCount = 0
    let lastState: PendingWritesState = getPendingWritesState()
    const unsubscribe = subscribePendingWrites((state) => {
      callCount++
      lastState = state
    })

    pendingWritesTracker.updateState({ isOnline: false, hasPendingWrites: true, isSyncing: false })
    assert.equal(lastState.isOnline, false)
    assert.equal(lastState.hasPendingWrites, true)

    // Updating with identical values does not trigger duplicate subscriber notifications
    const countBefore = callCount
    pendingWritesTracker.updateState({ isOnline: false, hasPendingWrites: true, isSyncing: false })
    assert.equal(callCount, countBefore)

    // Reset back to clean state
    pendingWritesTracker.updateState({ isOnline: true, hasPendingWrites: false, isSyncing: false })
    assert.equal(lastState.isOnline, true)
    assert.equal(lastState.hasPendingWrites, false)

    unsubscribe()
  })

  await t.test('handles syncPendingWrites with mock waitFn and acknowledges writes', async () => {
    let waitCalled = false
    const tracker = new PendingWritesTracker({
      getDb: async () => ({} as any),
      waitFn: async () => {
        waitCalled = true
      },
      initialOnline: true,
    })

    tracker.updateState({ hasPendingWrites: true })
    assert.equal(tracker.getState().hasPendingWrites, true)

    const synced = await tracker.syncPendingWrites()
    assert.equal(synced, true)
    assert.equal(waitCalled, true)
    assert.equal(tracker.getState().hasPendingWrites, false)
    assert.equal(tracker.getState().isSyncing, false)
  })

  await t.test('does not sync when offline and preserves pending writes', async () => {
    let waitCalled = false
    const tracker = new PendingWritesTracker({
      getDb: async () => ({} as any),
      waitFn: async () => {
        waitCalled = true
      },
      initialOnline: false,
    })

    tracker.updateState({ hasPendingWrites: true })
    const synced = await tracker.syncPendingWrites()
    assert.equal(synced, false)
    assert.equal(waitCalled, false)
    assert.equal(tracker.getState().hasPendingWrites, true)

    // When network comes back online, handles online transition
    tracker.handleOnline()
    assert.equal(tracker.getState().isOnline, true)
    // Wait a tick for async sync
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(waitCalled, true)
    assert.equal(tracker.getState().hasPendingWrites, false)
  })
})
