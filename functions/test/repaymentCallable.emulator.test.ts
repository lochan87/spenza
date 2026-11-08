import { it } from 'node:test'
import assert from 'node:assert/strict'

const enabled = process.env.SPENZA_CALLABLE_EMULATORS === '1'

it('Auth + Functions + Firestore emulators: executeRepaymentV1 callable, idempotency, invariants and security rules', { skip: !enabled }, async () => {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
  const projectId = 'demo-spenza-import'
  const { initializeApp, deleteApp } = await import('firebase-admin/app')
  const { getFirestore, Timestamp } = await import('firebase-admin/firestore')
  const app = initializeApp({ projectId }, `repay-callable-${Date.now()}`)
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
    const strangerUid = stranger.localId

    // Fixture transaction with 2 split participants
    const txId = `tx-${crypto.randomUUID()}`
    const txPath = `users/${uid}/transactions/${txId}`
    const initialTx = {
      id: txId,
      amountPaise: 10000,
      description: 'Team dinner',
      categoryId: 'food',
      type: 'everyday',
      date: Timestamp.now(),
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      paymentMode: 'Other',
      paymentAccountId: null,
      tripId: null,
      personId: null,
      recoverablePaise: 6000,
      reimbursementStatus: 'pending',
      splits: [
        {
          personId: 'alice',
          personName: 'Alice',
          amountPaise: 4000,
          repaidPaise: 0,
          settledAt: null,
        },
        {
          personId: 'bob',
          personName: 'Bob',
          amountPaise: 2000,
          repaidPaise: 0,
          settledAt: null,
        },
      ],
    }
    await db.doc(txPath).create(initialTx)

    // Setup an initial insights cache doc to verify atomic invalidation
    const insightsRef = db.doc(`users/${uid}/insights/summary`)
    await insightsRef.set({ cached: true, timestamp: Date.now() })

    // 1. Unauthenticated request rejected
    const unauthRes = await callRepayment({
      transactionId: txId,
      personId: 'alice',
      repaymentPaise: 1000,
      idempotencyKey: crypto.randomUUID(),
    })
    assert.equal(unauthRes.error.status, 'UNAUTHENTICATED')

    // 2. Cross-user UID isolation: stranger cannot repay owner's transaction
    const strangerRes = await callRepayment(
      {
        transactionId: txId,
        personId: 'alice',
        repaymentPaise: 1000,
        idempotencyKey: crypto.randomUUID(),
      },
      stranger.idToken
    )
    assert.equal(strangerRes.error.status, 'NOT_FOUND')

    // 3. Reject invalid arguments (zero, negative, float, missing fields)
    const badAmountRes1 = await callRepayment(
      { transactionId: txId, personId: 'alice', repaymentPaise: 0, idempotencyKey: crypto.randomUUID() },
      owner.idToken
    )
    assert.equal(badAmountRes1.error.status, 'INVALID_ARGUMENT')

    const badAmountRes2 = await callRepayment(
      { transactionId: txId, personId: 'alice', repaymentPaise: -500, idempotencyKey: crypto.randomUUID() },
      owner.idToken
    )
    assert.equal(badAmountRes2.error.status, 'INVALID_ARGUMENT')

    const badAmountRes3 = await callRepayment(
      { transactionId: txId, personId: 'alice', repaymentPaise: 12.34, idempotencyKey: crypto.randomUUID() },
      owner.idToken
    )
    assert.equal(badAmountRes3.error.status, 'INVALID_ARGUMENT')

    // Extra forbidden keys rejected by strict schema
    const extraFieldRes = await callRepayment(
      { transactionId: txId, personId: 'alice', repaymentPaise: 1000, idempotencyKey: crypto.randomUUID(), uid: strangerUid },
      owner.idToken
    )
    assert.equal(extraFieldRes.error.status, 'INVALID_ARGUMENT')

    // 4. Unknown participant rejected
    const unknownPersonRes = await callRepayment(
      { transactionId: txId, personId: 'charlie', repaymentPaise: 1000, idempotencyKey: crypto.randomUUID() },
      owner.idToken
    )
    assert.equal(unknownPersonRes.error.status, 'NOT_FOUND')

    // 5. Repayment exceeding remaining balance rejected
    const excessiveRes = await callRepayment(
      { transactionId: txId, personId: 'alice', repaymentPaise: 5000, idempotencyKey: crypto.randomUUID() },
      owner.idToken
    )
    assert.equal(excessiveRes.error.status, 'INVALID_ARGUMENT')

    // 6. Valid partial repayment: increases repaidPaise, updates status, invalidates insights cache
    const key1 = crypto.randomUUID()
    const repay1 = await callRepayment(
      { transactionId: txId, personId: 'alice', repaymentPaise: 2500, idempotencyKey: key1 },
      owner.idToken
    )
    assert.ok(repay1.result, JSON.stringify(repay1.error))
    assert.equal(repay1.result.appliedPaise, 2500)
    assert.equal(repay1.result.replayed, false)
    assert.equal(repay1.result.tx.reimbursementStatus, 'partial')
    assert.equal(repay1.result.tx.recoverablePaise, 6000)
    assert.equal(repay1.result.tx.splits[0].repaidPaise, 2500)

    // Verify insights cache was atomically deleted
    const insightsAfter = await insightsRef.get()
    assert.equal(insightsAfter.exists, false)

    // 7. Duplicate submission with identical key replays result without double accounting
    const replayRes = await callRepayment(
      { transactionId: txId, personId: 'alice', repaymentPaise: 2500, idempotencyKey: key1 },
      owner.idToken
    )
    assert.ok(replayRes.result)
    assert.equal(replayRes.result.replayed, true)
    assert.equal(replayRes.result.appliedPaise, 2500)

    // Verify persisted state did NOT increment a second time
    const txAfterReplay = (await db.doc(txPath).get()).data()!
    assert.equal(txAfterReplay.splits[0].repaidPaise, 2500)
    assert.equal(txAfterReplay.recoverablePaise, 6000)

    // 8. Reusing the same idempotency key with conflicting details is rejected
    const conflictRes = await callRepayment(
      { transactionId: txId, personId: 'alice', repaymentPaise: 1000, idempotencyKey: key1 },
      owner.idToken
    )
    assert.equal(conflictRes.error.status, 'ALREADY_EXISTS')

    // 9. Fully repaid: settle Alice's remaining 1500 and Bob's 2000
    const key2 = crypto.randomUUID()
    const repay2 = await callRepayment(
      { transactionId: txId, personId: 'alice', repaymentPaise: 1500, idempotencyKey: key2 },
      owner.idToken
    )
    assert.ok(repay2.result)
    assert.equal(repay2.result.tx.splits[0].repaidPaise, 4000)
    assert.ok(repay2.result.tx.splits[0].settledAt != null)

    // Alice is now fully repaid; further repayment against Alice is rejected
    const key3 = crypto.randomUUID()
    const repayFullyPaidRes = await callRepayment(
      { transactionId: txId, personId: 'alice', repaymentPaise: 100, idempotencyKey: key3 },
      owner.idToken
    )
    assert.equal(repayFullyPaidRes.error.status, 'FAILED_PRECONDITION')

    // Settle Bob's share to make the entire transaction settled
    const key4 = crypto.randomUUID()
    const repay3 = await callRepayment(
      { transactionId: txId, personId: 'bob', repaymentPaise: 2000, idempotencyKey: key4 },
      owner.idToken
    )
    assert.ok(repay3.result)
    assert.equal(repay3.result.tx.reimbursementStatus, 'settled')
    assert.equal(repay3.result.tx.recoverablePaise, 6000)
    assert.equal(repay3.result.tx.splits[1].repaidPaise, 2000)

    // 10. Legacy transaction compatibility (no splits array, but personId and recoverablePaise set)
    const legacyTxId = `legacy-${crypto.randomUUID()}`
    const legacyPath = `users/${uid}/transactions/${legacyTxId}`
    await db.doc(legacyPath).create({
      id: legacyTxId,
      amountPaise: 5000,
      description: 'Legacy expense',
      categoryId: 'other',
      type: 'reimbursable',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      personId: 'dave',
      recoverablePaise: 5000,
      reimbursementStatus: 'pending',
    })

    const keyLegacy = crypto.randomUUID()
    const legacyRepay = await callRepayment(
      { transactionId: legacyTxId, personId: 'dave', repaymentPaise: 2000, idempotencyKey: keyLegacy },
      owner.idToken
    )
    assert.ok(legacyRepay.result)
    assert.equal(legacyRepay.result.appliedPaise, 2000)
    assert.equal(legacyRepay.result.tx.reimbursementStatus, 'partial')
    assert.equal(legacyRepay.result.tx.recoverablePaise, 5000)
    assert.equal(legacyRepay.result.tx.splits.length, 1)
    assert.equal(legacyRepay.result.tx.splits[0].repaidPaise, 2000)

    // 11. Security rules: Client SDK cannot forge or delete repayment receipts
    const { initializeApp: clientApp, deleteApp: deleteClient } = await import('firebase/app')
    const {
      getFirestore: clientDb,
      connectFirestoreEmulator,
      doc: clientDoc,
      setDoc,
      deleteDoc,
      getDoc,
      terminate,
    } = await import('firebase/firestore')

    const client = clientApp({ projectId }, `client-${Date.now()}`)
    const firestore = clientDb(client)
    connectFirestoreEmulator(firestore, '127.0.0.1', 8080, { mockUserToken: { sub: uid, user_id: uid } })

    try {
      const receiptRef = clientDoc(firestore, `users/${uid}/repaymentReceipts/${key1}`)
      const snap = await getDoc(receiptRef)
      assert.equal(snap.exists(), true) // Read allowed for owner

      // Direct write / forge blocked
      await assert.rejects(setDoc(receiptRef, { forged: true }), /permission-denied/)
      // Deletion blocked
      await assert.rejects(deleteDoc(receiptRef), /permission-denied/)
    } finally {
      await terminate(firestore)
      await deleteClient(client)
    }
  } finally {
    await db.terminate()
    await deleteApp(app)
  }
})
