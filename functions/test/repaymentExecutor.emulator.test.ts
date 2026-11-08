import { it } from 'node:test'
import assert from 'node:assert/strict'
import { executeTrustedRepayment } from '../src/repaymentExecutor.ts'

const host = process.env.SPENZA_FIRESTORE_EMULATOR_HOST

it('Firestore emulator: concurrent executeTrustedRepayment, concurrency invariants and receipts', { skip: !host }, async () => {
  assert.match(host!, /^(localhost|127\.0\.0\.1):\d+$/)
  process.env.FIRESTORE_EMULATOR_HOST = host
  const { initializeApp, deleteApp } = await import('firebase-admin/app')
  const { getFirestore, Timestamp } = await import('firebase-admin/firestore')
  const app = initializeApp({ projectId: 'demo-spenza-import' }, `repay-exec-${Date.now()}`)
  const db = getFirestore(app)

  try {
    const uid = `repay-user-${crypto.randomUUID()}`
    const txId = `tx-concurrent-${crypto.randomUUID()}`
    const txPath = `users/${uid}/transactions/${txId}`

    await db.doc(txPath).create({
      id: txId,
      amountPaise: 10000,
      description: 'Trip dinner',
      categoryId: 'food',
      type: 'trip',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      tripId: null,
      personId: null,
      recoverablePaise: 6000,
      reimbursementStatus: 'pending',
      splits: [
        { personId: 'alice', personName: 'Alice', amountPaise: 3000, repaidPaise: 0, settledAt: null },
        { personId: 'bob', personName: 'Bob', amountPaise: 3000, repaidPaise: 0, settledAt: null },
      ],
    })

    // Setup an initial insights cache doc to verify atomic invalidation
    const cacheRef = db.doc(`users/${uid}/insights/summary`)
    await cacheRef.set({ cached: true })

    // Execute concurrent repayments on Alice and Bob with separate idempotency keys
    const keyAlice = crypto.randomUUID()
    const keyBob = crypto.randomUUID()

    const results = await Promise.all([
      executeTrustedRepayment(db, uid, {
        transactionId: txId,
        personId: 'alice',
        repaymentPaise: 1500,
        idempotencyKey: keyAlice,
      }),
      executeTrustedRepayment(db, uid, {
        transactionId: txId,
        personId: 'bob',
        repaymentPaise: 2000,
        idempotencyKey: keyBob,
      }),
    ])

    assert.equal(results[0].replayed, false)
    assert.equal(results[1].replayed, false)

    const finalTx = (await db.doc(txPath).get()).data()!
    const aliceSplit = finalTx.splits.find((s: any) => s.personId === 'alice')
    const bobSplit = finalTx.splits.find((s: any) => s.personId === 'bob')

    assert.equal(aliceSplit.repaidPaise, 1500)
    assert.equal(bobSplit.repaidPaise, 2000)
    assert.equal(finalTx.recoverablePaise, 6000) // Original recoverable principal is preserved
    assert.equal(finalTx.reimbursementStatus, 'partial')

    // Receipts exist for both operations
    const receiptAlice = await db.doc(`users/${uid}/repaymentReceipts/${keyAlice}`).get()
    const receiptBob = await db.doc(`users/${uid}/repaymentReceipts/${keyBob}`).get()
    assert.equal(receiptAlice.exists, true)
    assert.equal(receiptBob.exists, true)
    assert.equal(receiptAlice.data()!.appliedPaise, 1500)
    assert.equal(receiptBob.data()!.appliedPaise, 2000)

    // Insights cache was deleted
    const cacheAfter = await cacheRef.get()
    assert.equal(cacheAfter.exists, false)
  } finally {
    await db.terminate()
    await deleteApp(app)
  }
})
