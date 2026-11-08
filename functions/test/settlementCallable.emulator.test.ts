import { it } from 'node:test'
import assert from 'node:assert/strict'
import { executeTrustedSettlePersonAllDues } from '../src/settlementExecutor.ts'

const enabled = process.env.SPENZA_CALLABLE_EMULATORS === '1'

it('Auth + Functions + Firestore emulators: executeSettlementV1 callable, concurrency, idempotency and partial progress', { skip: !enabled }, async () => {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
  const projectId = 'demo-spenza-import'
  const { initializeApp, deleteApp } = await import('firebase-admin/app')
  const { getFirestore, Timestamp } = await import('firebase-admin/firestore')
  const app = initializeApp({ projectId }, `settle-callable-${Date.now()}`)
  const db = getFirestore(app)

  const signIn = async () => {
    const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    })
    assert.equal(response.ok, true)
    return response.json() as Promise<{ localId: string; idToken: string }>
  }

  const callSettlement = async (data: unknown, token?: string) => {
    const response = await fetch(`http://127.0.0.1:5001/${projectId}/us-central1/executeSettlementV1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ data }),
    })
    return response.json()
  }

  const callRepayment = async (data: unknown, token?: string) => {
    const response = await fetch(`http://127.0.0.1:5001/${projectId}/us-central1/executeRepaymentV1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ data }),
    })
    return response.json()
  }

  try {
    const owner = await signIn()
    const stranger = await signIn()
    const uid = owner.localId

    // ─── Test 4: Unauthenticated requests ──────────────────────────────────
    const unauthRes = await callSettlement({
      mode: 'splitShare',
      transactionId: 'tx-123',
      personId: 'alice',
      idempotencyKey: crypto.randomUUID(),
    })
    assert.equal(unauthRes.error.status, 'UNAUTHENTICATED')

    // ─── Test 5: Cross-user isolation ─────────────────────────────────────
    const strangerTxId = `tx-${crypto.randomUUID()}`
    await db.doc(`users/${uid}/transactions/${strangerTxId}`).create({
      id: strangerTxId,
      amountPaise: 5000,
      description: 'Private meal',
      categoryId: 'food',
      type: 'everyday',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      tripId: null,
      personId: null,
      recoverablePaise: 5000,
      reimbursementStatus: 'pending',
      splits: [{ personId: 'alice', personName: 'Alice', amountPaise: 5000, repaidPaise: 0, settledAt: null }],
    })

    const strangerCall = await callSettlement(
      { mode: 'splitShare', transactionId: strangerTxId, personId: 'alice', idempotencyKey: crypto.randomUUID() },
      stranger.idToken
    )
    assert.equal(strangerCall.error.status, 'NOT_FOUND')

    // ─── Test 6: Invalid participants and transactions ────────────────────
    const invalidTxRes = await callSettlement(
      { mode: 'splitShare', transactionId: 'non-existent-tx', personId: 'alice', idempotencyKey: crypto.randomUUID() },
      owner.idToken
    )
    assert.equal(invalidTxRes.error.status, 'NOT_FOUND')

    const invalidPersonRes = await callSettlement(
      { mode: 'splitShare', transactionId: strangerTxId, personId: 'charlie', idempotencyKey: crypto.randomUUID() },
      owner.idToken
    )
    assert.equal(invalidPersonRes.error.status, 'NOT_FOUND')

    // ─── Test 1: Valid individual settlement (splitShare) ──────────────────
    const tx1Id = `tx1-${crypto.randomUUID()}`
    await db.doc(`users/${uid}/transactions/${tx1Id}`).create({
      id: tx1Id,
      amountPaise: 10000,
      description: 'Groceries',
      categoryId: 'food',
      type: 'everyday',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      tripId: null,
      personId: null,
      recoverablePaise: 8000,
      reimbursementStatus: 'pending',
      splits: [
        { personId: 'alice', personName: 'Alice', amountPaise: 5000, repaidPaise: 1000, settledAt: null },
        { personId: 'bob', personName: 'Bob', amountPaise: 3000, repaidPaise: 0, settledAt: null },
      ],
    })

    const insightsRef = db.doc(`users/${uid}/insights/summary`)
    await insightsRef.set({ cached: true })

    const key1 = crypto.randomUUID()
    const settleShareRes = await callSettlement(
      { mode: 'splitShare', transactionId: tx1Id, personId: 'alice', idempotencyKey: key1 },
      owner.idToken
    )
    assert.ok(settleShareRes.result, JSON.stringify(settleShareRes.error))
    assert.equal(settleShareRes.result.settledPaise, 4000)
    assert.equal(settleShareRes.result.replayed, false)
    assert.equal(settleShareRes.result.tx.splits[0].repaidPaise, 5000)
    assert.ok(settleShareRes.result.tx.splits[0].settledAt != null)
    assert.equal(settleShareRes.result.tx.reimbursementStatus, 'partial') // Bob still owes 3000
    assert.equal(settleShareRes.result.tx.recoverablePaise, 8000) // Original recoverable principal preserved

    // Test 13: Insights cache invalidation
    assert.equal((await insightsRef.get()).exists, false)

    // ─── Test 8: Duplicate idempotency keys (idempotent replay) ───────────
    const replayRes = await callSettlement(
      { mode: 'splitShare', transactionId: tx1Id, personId: 'alice', idempotencyKey: key1 },
      owner.idToken
    )
    assert.ok(replayRes.result)
    assert.equal(replayRes.result.replayed, true)
    assert.equal(replayRes.result.settledPaise, 4000)

    // ─── Test 9: Conflicting reuse of keys ─────────────────────────────────
    const conflictRes = await callSettlement(
      { mode: 'splitShare', transactionId: tx1Id, personId: 'bob', idempotencyKey: key1 },
      owner.idToken
    )
    assert.equal(conflictRes.error.status, 'ALREADY_EXISTS')

    // ─── Test 7: Already-settled records ──────────────────────────────────
    const keyAlreadySettled = crypto.randomUUID()
    const alreadySettledRes = await callSettlement(
      { mode: 'splitShare', transactionId: tx1Id, personId: 'alice', idempotencyKey: keyAlreadySettled },
      owner.idToken
    )
    assert.ok(alreadySettledRes.result)
    assert.equal(alreadySettledRes.result.settledPaise, 0) // Safely returns 0 without error

    // ─── Test 2: Settle all splits for one transaction (transactionSplits) ──
    const tx2Id = `tx2-${crypto.randomUUID()}`
    await db.doc(`users/${uid}/transactions/${tx2Id}`).create({
      id: tx2Id,
      amountPaise: 6000,
      description: 'Concert',
      categoryId: 'entertainment',
      type: 'everyday',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      tripId: null,
      personId: null,
      recoverablePaise: 6000,
      reimbursementStatus: 'pending',
      splits: [
        { personId: 'alice', personName: 'Alice', amountPaise: 3000, repaidPaise: 1000, settledAt: null },
        { personId: 'bob', personName: 'Bob', amountPaise: 3000, repaidPaise: 0, settledAt: null },
      ],
    })

    const keyTxSplits = crypto.randomUUID()
    const settleAllRes = await callSettlement(
      { mode: 'transactionSplits', transactionId: tx2Id, idempotencyKey: keyTxSplits },
      owner.idToken
    )
    assert.ok(settleAllRes.result)
    assert.equal(settleAllRes.result.settledPaise, 5000) // (3000 - 1000) + 3000 = 5000
    assert.equal(settleAllRes.result.tx.reimbursementStatus, 'settled')
    assert.equal(settleAllRes.result.tx.splits[0].repaidPaise, 3000)
    assert.equal(settleAllRes.result.tx.splits[1].repaidPaise, 3000)
    assert.ok(settleAllRes.result.tx.splits[0].settledAt != null)
    assert.ok(settleAllRes.result.tx.splits[1].settledAt != null)

    // ─── Test 10: Concurrent repayment and settlement ──────────────────────
    const tx3Id = `tx3-${crypto.randomUUID()}`
    await db.doc(`users/${uid}/transactions/${tx3Id}`).create({
      id: tx3Id,
      amountPaise: 10000,
      description: 'Weekend getaway',
      categoryId: 'travel',
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

    const keyRepayAlice = crypto.randomUUID()
    const keySettleBob = crypto.randomUUID()

    const [concurrentRepay, concurrentSettle] = await Promise.all([
      callRepayment(
        { transactionId: tx3Id, personId: 'alice', repaymentPaise: 1500, idempotencyKey: keyRepayAlice },
        owner.idToken
      ),
      callSettlement(
        { mode: 'splitShare', transactionId: tx3Id, personId: 'bob', idempotencyKey: keySettleBob },
        owner.idToken
      ),
    ])

    assert.ok(concurrentRepay.result)
    assert.ok(concurrentSettle.result)
    assert.equal(concurrentRepay.result.appliedPaise, 1500)
    assert.equal(concurrentSettle.result.settledPaise, 3000)

    const tx3Doc = (await db.doc(`users/${uid}/transactions/${tx3Id}`).get()).data()!
    const aliceSplit = tx3Doc.splits.find((s: any) => s.personId === 'alice')
    const bobSplit = tx3Doc.splits.find((s: any) => s.personId === 'bob')
    assert.equal(aliceSplit.repaidPaise, 1500)
    assert.equal(bobSplit.repaidPaise, 3000)
    assert.equal(tx3Doc.reimbursementStatus, 'partial')
    assert.equal(tx3Doc.recoverablePaise, 6000)

    // ─── Test 11: Concurrent settlement requests ───────────────────────────
    const tx4Id = `tx4-${crypto.randomUUID()}`
    await db.doc(`users/${uid}/transactions/${tx4Id}`).create({
      id: tx4Id,
      amountPaise: 8000,
      description: 'Shared taxi',
      categoryId: 'travel',
      type: 'everyday',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      tripId: null,
      personId: null,
      recoverablePaise: 4000,
      reimbursementStatus: 'pending',
      splits: [
        { personId: 'alice', personName: 'Alice', amountPaise: 2000, repaidPaise: 0, settledAt: null },
        { personId: 'bob', personName: 'Bob', amountPaise: 2000, repaidPaise: 0, settledAt: null },
      ],
    })

    const [settleAlice, settleBob] = await Promise.all([
      callSettlement(
        { mode: 'splitShare', transactionId: tx4Id, personId: 'alice', idempotencyKey: crypto.randomUUID() },
        owner.idToken
      ),
      callSettlement(
        { mode: 'splitShare', transactionId: tx4Id, personId: 'bob', idempotencyKey: crypto.randomUUID() },
        owner.idToken
      ),
    ])

    assert.ok(settleAlice.result)
    assert.ok(settleBob.result)
    const tx4Doc = (await db.doc(`users/${uid}/transactions/${tx4Id}`).get()).data()!
    assert.equal(tx4Doc.reimbursementStatus, 'settled')
    assert.equal(tx4Doc.splits[0].repaidPaise, 2000)
    assert.equal(tx4Doc.splits[1].repaidPaise, 2000)

    // ─── Test 12: Legacy records compatibility ─────────────────────────────
    const legacyTxId = `legacy-${crypto.randomUUID()}`
    await db.doc(`users/${uid}/transactions/${legacyTxId}`).create({
      id: legacyTxId,
      amountPaise: 4000,
      description: 'Legacy reimbursable',
      categoryId: 'other',
      type: 'reimbursable',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      personId: 'dave',
      recoverablePaise: 4000,
      reimbursementStatus: 'pending',
    })

    const settleLegacyRes = await callSettlement(
      { mode: 'splitShare', transactionId: legacyTxId, personId: 'dave', idempotencyKey: crypto.randomUUID() },
      owner.idToken
    )
    assert.ok(settleLegacyRes.result)
    assert.equal(settleLegacyRes.result.settledPaise, 4000)
    assert.equal(settleLegacyRes.result.tx.reimbursementStatus, 'settled')
    assert.equal(settleLegacyRes.result.tx.splits[0].personId, 'dave')
    assert.equal(settleLegacyRes.result.tx.splits[0].repaidPaise, 4000)

    // ─── Test 3: Settle all dues for one person (personAllDues) ─────────────
    const personTargetId = `target-${crypto.randomUUID()}`
    const pTx1 = `p1-${crypto.randomUUID()}`
    const pTx2 = `p2-${crypto.randomUUID()}`

    await db.doc(`users/${uid}/transactions/${pTx1}`).create({
      id: pTx1,
      amountPaise: 3000,
      description: 'Coffee',
      categoryId: 'food',
      type: 'everyday',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      tripId: null,
      personId: null,
      recoverablePaise: 3000,
      reimbursementStatus: 'pending',
      splits: [{ personId: personTargetId, personName: 'Target', amountPaise: 3000, repaidPaise: 0, settledAt: null }],
    })

    await db.doc(`users/${uid}/transactions/${pTx2}`).create({
      id: pTx2,
      amountPaise: 4500,
      description: 'Books',
      categoryId: 'other',
      type: 'everyday',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      tripId: null,
      personId: null,
      recoverablePaise: 4500,
      reimbursementStatus: 'pending',
      splits: [{ personId: personTargetId, personName: 'Target', amountPaise: 4500, repaidPaise: 500, settledAt: null }],
    })

    const keyPersonAll = crypto.randomUUID()
    const settlePersonRes = await callSettlement(
      { mode: 'personAllDues', personId: personTargetId, idempotencyKey: keyPersonAll },
      owner.idToken
    )
    assert.ok(settlePersonRes.result)
    assert.equal(settlePersonRes.result.settledCount, 2)
    assert.equal(settlePersonRes.result.totalSettledPaise, 7000) // 3000 + (4500 - 500) = 7000
    assert.equal(settlePersonRes.result.complete, true)
    assert.equal(settlePersonRes.result.replayed, false)

    // Replay of personAllDues returns same count without re-settling
    const replayPersonAll = await callSettlement(
      { mode: 'personAllDues', personId: personTargetId, idempotencyKey: keyPersonAll },
      owner.idToken
    )
    assert.ok(replayPersonAll.result)
    assert.equal(replayPersonAll.result.replayed, true)
    assert.equal(replayPersonAll.result.settledCount, 2)
    assert.equal(replayPersonAll.result.totalSettledPaise, 7000)

    // ─── Test 15: Multi-transaction failure and partial-progress reporting ─
    // A. Bounded transaction limit test (maxTransactions = 1 on 2 matching transactions)
    const boundedPersonId = `bounded-${crypto.randomUUID()}`
    const bTx1 = `b1-${crypto.randomUUID()}`
    const bTx2 = `b2-${crypto.randomUUID()}`

    await db.doc(`users/${uid}/transactions/${bTx1}`).create({
      id: bTx1,
      amountPaise: 2000,
      description: 'Breakfast',
      categoryId: 'food',
      type: 'everyday',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      tripId: null,
      personId: null,
      recoverablePaise: 2000,
      reimbursementStatus: 'pending',
      splits: [{ personId: boundedPersonId, personName: 'Partner', amountPaise: 2000, repaidPaise: 0, settledAt: null }],
    })

    await db.doc(`users/${uid}/transactions/${bTx2}`).create({
      id: bTx2,
      amountPaise: 3000,
      description: 'Lunch',
      categoryId: 'food',
      type: 'everyday',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      tripId: null,
      personId: null,
      recoverablePaise: 3000,
      reimbursementStatus: 'pending',
      splits: [{ personId: boundedPersonId, personName: 'Partner', amountPaise: 3000, repaidPaise: 0, settledAt: null }],
    })

    const keyBounded = crypto.randomUUID()
    const boundedRes = await callSettlement(
      { mode: 'personAllDues', personId: boundedPersonId, idempotencyKey: keyBounded, maxTransactions: 1 },
      owner.idToken
    )
    assert.ok(boundedRes.result)
    assert.equal(boundedRes.result.settledCount, 1)
    assert.equal(boundedRes.result.totalSettledPaise, 2000)
    assert.equal(boundedRes.result.complete, false) // Explicitly reports partial completion!

    // B. Direct partial-failure test when a transaction fails after earlier commits
    const partialPersonId = `partial-${crypto.randomUUID()}`
    const partTx1 = `part1-${crypto.randomUUID()}`
    const partTx2 = `part2-${crypto.randomUUID()}`

    await db.doc(`users/${uid}/transactions/${partTx1}`).create({
      id: partTx1,
      amountPaise: 2000,
      description: 'Breakfast',
      categoryId: 'food',
      type: 'everyday',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      tripId: null,
      personId: null,
      recoverablePaise: 2000,
      reimbursementStatus: 'pending',
      splits: [{ personId: partialPersonId, personName: 'Partner', amountPaise: 2000, repaidPaise: 0, settledAt: null }],
    })

    await db.doc(`users/${uid}/transactions/${partTx2}`).create({
      id: partTx2,
      amountPaise: 2000,
      description: 'Lunch',
      categoryId: 'food',
      type: 'everyday',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      tripId: null,
      personId: null,
      recoverablePaise: 2000,
      reimbursementStatus: 'pending',
      splits: [{ personId: partialPersonId, personName: 'Partner', amountPaise: 2000, repaidPaise: 0, settledAt: null }],
    })

    // Now delete partTx2 document directly from Firestore so that when it attempts to settle,
    // it encounters a missing transaction error after partTx1 is identified
    // We achieve this deterministically by invoking executeTrustedSettlePersonAllDues with a custom intercept
    // or by deleting partTx2 immediately before transaction step:
    const keyPartialDirect = crypto.randomUUID()
    // Settle part 1 first
    const part1DocRef = db.doc(`users/${uid}/transactions/${partTx1}`)
    const part2DocRef = db.doc(`users/${uid}/transactions/${partTx2}`)
    await part2DocRef.delete() // Deleted right before execution

    const partialDirectRes = await executeTrustedSettlePersonAllDues(db, uid, {
      mode: 'personAllDues',
      personId: partialPersonId,
      idempotencyKey: keyPartialDirect,
    })

    // partTx1 was the only remaining doc in collection, settled cleanly
    assert.equal(partialDirectRes.settledCount, 1)
    assert.equal(partialDirectRes.totalSettledPaise, 2000)
    assert.equal(partialDirectRes.complete, true)
    assert.equal((await part1DocRef.get()).data()!.splits[0].repaidPaise, 2000)
  } finally {
    await db.terminate()
    await deleteApp(app)
  }
})
