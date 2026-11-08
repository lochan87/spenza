import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initializeApp, deleteApp } from 'firebase/app'
import * as sdk from 'firebase/firestore'
import type { Transaction } from '../../types/index.ts'

const host = process.env.SPENZA_FIRESTORE_EMULATOR_HOST

it('Firestore emulator: transaction write security rules hardening', { skip: !host }, async t => {
  assert.match(host!, /^(localhost|127\.0\.0\.1):\d+$/)
  const projectId = 'demo-spenza-rules'
  const rules = readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8')

  // Upload current rules to isolated test project
  const response = await fetch(`http://${host}/emulator/v1/projects/${projectId}:securityRules`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: rules }] } }),
  })
  assert.ok(response.ok, await response.text())

  const [hostname, portStr] = host!.split(':')
  const port = Number(portStr)

  const ownerApp = initializeApp({ projectId }, `owner-${Date.now()}`)
  const otherApp = initializeApp({ projectId }, `other-${Date.now()}`)

  const ownerDb = sdk.getFirestore(ownerApp)
  const otherDb = sdk.getFirestore(otherApp)

  sdk.connectFirestoreEmulator(ownerDb, hostname, port, { mockUserToken: { sub: 'owner-uid', user_id: 'owner-uid' } })
  sdk.connectFirestoreEmulator(otherDb, hostname, port, { mockUserToken: { sub: 'other-uid', user_id: 'other-uid' } })

  const ownerTxRef = (id: string) => sdk.doc(ownerDb, 'users', 'owner-uid', 'transactions', id)
  const otherTxRef = (id: string) => sdk.doc(otherDb, 'users', 'owner-uid', 'transactions', id)

  const validExpenseFixture = (overrides: Partial<Transaction> = {}): Transaction => ({
    id: 'tx-' + crypto.randomUUID(),
    amountPaise: 10000,
    type: 'everyday',
    description: 'Grocery shopping',
    categoryId: 'groceries',
    date: sdk.Timestamp.now(),
    paymentMode: 'Cash',
    paymentAccountId: null,
    tripId: null,
    personId: null,
    tags: [],
    notes: '',
    receiptUrl: null,
    recoverablePaise: 0,
    reimbursementStatus: 'none',
    splits: [],
    createdAt: sdk.Timestamp.now(),
    updatedAt: sdk.Timestamp.now(),
    ...overrides,
  })

  try {
    // 1. Owner creates a valid expense
    await t.test('1. Owner creates a valid expense', async () => {
      const data = validExpenseFixture()
      const ref = ownerTxRef(data.id)
      await sdk.setDoc(ref, data)
      const snap = await sdk.getDoc(ref)
      assert.equal(snap.exists(), true)
      assert.equal(snap.data()?.amountPaise, 10000)
    })

    // 2. Another user cannot access or modify it
    await t.test('2. Another user cannot access or modify it', async () => {
      const data = validExpenseFixture()
      const ownerRef = ownerTxRef(data.id)
      const otherRef = otherTxRef(data.id)
      await sdk.setDoc(ownerRef, data)

      await assert.rejects(sdk.getDoc(otherRef), /permission-denied/)
      await assert.rejects(sdk.updateDoc(otherRef, { description: 'Hacked' }), /permission-denied/)
      await assert.rejects(sdk.deleteDoc(otherRef), /permission-denied/)
      await assert.rejects(sdk.setDoc(otherRef, { ...data, id: 'forged' }), /permission-denied/)
    })

    // 3. Owner deletes an unpaid expense
    await t.test('3. Owner deletes an unpaid expense', async () => {
      const data = validExpenseFixture({
        recoverablePaise: 5000,
        reimbursementStatus: 'pending',
        splits: [{ personId: 'friend-1', personName: 'Friend', amountPaise: 5000, repaidPaise: 0, settledAt: null }],
      })
      const ref = ownerTxRef(data.id)
      await sdk.setDoc(ref, data)
      assert.equal((await sdk.getDoc(ref)).exists(), true)

      await sdk.deleteDoc(ref)
      assert.equal((await sdk.getDoc(ref)).exists(), false)
    })

    // 4. Owner cannot delete a partially repaid expense
    await t.test('4. Owner cannot delete a partially repaid expense', async () => {
      const initial = validExpenseFixture({
        recoverablePaise: 5000,
        reimbursementStatus: 'pending',
        splits: [{ personId: 'friend-1', personName: 'Friend', amountPaise: 5000, repaidPaise: 0, settledAt: null }],
      })
      const ref = ownerTxRef(initial.id)
      await sdk.setDoc(ref, initial)
      // Legitimate repayment update advances status to partial
      await sdk.updateDoc(ref, {
        recoverablePaise: 3000,
        reimbursementStatus: 'partial',
        splits: [{ personId: 'friend-1', personName: 'Friend', amountPaise: 5000, repaidPaise: 2000, settledAt: null }],
      })

      await assert.rejects(sdk.deleteDoc(ref), /permission-denied/)
      assert.equal((await sdk.getDoc(ref)).exists(), true)
    })

    // 5. Owner cannot delete a fully repaid expense
    await t.test('5. Owner cannot delete a fully repaid expense', async () => {
      const initial = validExpenseFixture({
        recoverablePaise: 5000,
        reimbursementStatus: 'pending',
        splits: [{ personId: 'friend-1', personName: 'Friend', amountPaise: 5000, repaidPaise: 0, settledAt: null }],
      })
      const ref = ownerTxRef(initial.id)
      await sdk.setDoc(ref, initial)
      // Legitimate settlement update advances status to settled
      await sdk.updateDoc(ref, {
        recoverablePaise: 0,
        reimbursementStatus: 'settled',
        splits: [{ personId: 'friend-1', personName: 'Friend', amountPaise: 5000, repaidPaise: 5000, settledAt: sdk.Timestamp.now() }],
      })

      await assert.rejects(sdk.deleteDoc(ref), /permission-denied/)
      assert.equal((await sdk.getDoc(ref)).exists(), true)
    })

    // 6. Legacy repayment or settlement markers prevent deletion
    await t.test('6. Legacy repayment or settlement markers prevent deletion', async () => {
      // Legacy Case A: settled status without splits
      const legacySettled = {
        id: 'legacy-settled-' + crypto.randomUUID(),
        amountPaise: 5000,
        type: 'reimbursable',
      }
      const refA = ownerTxRef(legacySettled.id)
      await sdk.setDoc(refA, legacySettled)
      await sdk.updateDoc(refA, { reimbursementStatus: 'settled' })
      await assert.rejects(sdk.deleteDoc(refA), /permission-denied/)

      // Legacy Case B: settledAt marker on split item with status none
      const legacySplitMarker = {
        id: 'legacy-marker-' + crypto.randomUUID(),
        amountPaise: 5000,
        type: 'everyday',
      }
      const refB = ownerTxRef(legacySplitMarker.id)
      await sdk.setDoc(refB, legacySplitMarker)
      await sdk.updateDoc(refB, { splits: [{ settledAt: sdk.Timestamp.now() }] })
      await assert.rejects(sdk.deleteDoc(refB), /permission-denied/)
    })

    // 7. Direct reimbursement-status demotion is rejected
    await t.test('7. Direct reimbursement-status demotion is rejected', async () => {
      // Seed pending, update to partial
      const initial = validExpenseFixture({
        recoverablePaise: 5000,
        reimbursementStatus: 'pending',
        splits: [{ personId: 'f1', personName: 'F1', amountPaise: 5000, repaidPaise: 0, settledAt: null }],
      })
      const ref1 = ownerTxRef(initial.id)
      await sdk.setDoc(ref1, initial)
      await sdk.updateDoc(ref1, {
        recoverablePaise: 3000,
        reimbursementStatus: 'partial',
        splits: [{ personId: 'f1', personName: 'F1', amountPaise: 5000, repaidPaise: 2000, settledAt: null }],
      })

      // Cannot demote partial to none or pending
      await assert.rejects(sdk.updateDoc(ref1, { reimbursementStatus: 'none' }), /permission-denied/)
      await assert.rejects(sdk.updateDoc(ref1, { reimbursementStatus: 'pending' }), /permission-denied/)

      // Advance to settled
      await sdk.updateDoc(ref1, {
        recoverablePaise: 0,
        reimbursementStatus: 'settled',
        splits: [{ personId: 'f1', personName: 'F1', amountPaise: 5000, repaidPaise: 5000, settledAt: sdk.Timestamp.now() }],
      })

      // Cannot demote settled to partial, pending, or none
      await assert.rejects(sdk.updateDoc(ref1, { reimbursementStatus: 'partial' }), /permission-denied/)
      await assert.rejects(sdk.updateDoc(ref1, { reimbursementStatus: 'pending' }), /permission-denied/)
      await assert.rejects(sdk.updateDoc(ref1, { reimbursementStatus: 'none' }), /permission-denied/)
    })

    // 8. Immutable provenance cannot be changed or removed
    await t.test('8. Immutable provenance cannot be changed or removed', async () => {
      const initial = validExpenseFixture({
        isImported: true,
        importOperationId: 'import-op-42',
        recurringItemId: 'rec-item-99',
      })
      const ref = ownerTxRef(initial.id)
      await sdk.setDoc(ref, initial)

      // Value mutation rejected
      await assert.rejects(sdk.updateDoc(ref, { id: 'forged-id' }), /permission-denied/)
      await assert.rejects(sdk.updateDoc(ref, { createdAt: sdk.Timestamp.fromMillis(0) }), /permission-denied/)
      await assert.rejects(sdk.updateDoc(ref, { isImported: false }), /permission-denied/)
      await assert.rejects(sdk.updateDoc(ref, { importOperationId: 'tampered-op' }), /permission-denied/)
      await assert.rejects(sdk.updateDoc(ref, { recurringItemId: 'tampered-rec' }), /permission-denied/)

      // Field removal via deleteField() rejected
      await assert.rejects(sdk.updateDoc(ref, { id: sdk.deleteField() }), /permission-denied/)
      await assert.rejects(sdk.updateDoc(ref, { createdAt: sdk.deleteField() }), /permission-denied/)
      await assert.rejects(sdk.updateDoc(ref, { isImported: sdk.deleteField() }), /permission-denied/)
      await assert.rejects(sdk.updateDoc(ref, { importOperationId: sdk.deleteField() }), /permission-denied/)
      await assert.rejects(sdk.updateDoc(ref, { recurringItemId: sdk.deleteField() }), /permission-denied/)
    })

    // 9. Legacy documents without immutable provenance fields remain compatible
    await t.test('9. Legacy documents without immutable provenance fields remain compatible', async () => {
      const legacy = {
        id: 'legacy-untracked-' + crypto.randomUUID(),
        amountPaise: 4500,
        type: 'everyday',
      }
      const ref = ownerTxRef(legacy.id)
      await sdk.setDoc(ref, legacy)

      // Updating non-provenance fields on a document that never had isImported/recurringItemId succeeds
      await sdk.updateDoc(ref, { description: 'Updated legacy expense' })
      const snap = await sdk.getDoc(ref)
      assert.equal(snap.data()?.description, 'Updated legacy expense')
    })

    // 10. Split array length: uninspectable or >10 split arrays fail closed on deletion
    await t.test('10. Split array length: repayment at index 10+ or >10 splits cannot be deleted', async () => {
      // 11 splits (indices 0 to 10). Split index 10 has a repayment of 2000 paise.
      const splits11 = Array.from({ length: 11 }, (_, i) => ({
        personId: `p-${i}`,
        personName: `Person ${i}`,
        amountPaise: 1000,
        repaidPaise: i === 10 ? 2000 : 0,
        settledAt: null,
      }))
      const txId = 'tx-11splits-' + crypto.randomUUID()
      const ref = ownerTxRef(txId)

      // Seed as unpaid first
      await sdk.setDoc(ref, {
        id: txId,
        amountPaise: 20000,
        type: 'everyday',
      })
      // Update with 11 splits containing repayment at index 10
      await sdk.updateDoc(ref, {
        recoverablePaise: 11000,
        reimbursementStatus: 'partial',
        splits: splits11,
      })

      // Deletion must be rejected because rules fail closed when splits.size() > 10
      await assert.rejects(sdk.deleteDoc(ref), /permission-denied/)
      assert.equal((await sdk.getDoc(ref)).exists(), true)
    })

    // 11. Normal unpaid transactions (<=10 splits) remain deletable
    await t.test('11. Normal unpaid transactions (<=10 splits) remain deletable', async () => {
      const splits5 = Array.from({ length: 5 }, (_, i) => ({
        personId: `friend-${i}`,
        personName: `Friend ${i}`,
        amountPaise: 1000,
        repaidPaise: 0,
        settledAt: null,
      }))
      const expense = validExpenseFixture({
        recoverablePaise: 5000,
        reimbursementStatus: 'pending',
        splits: splits5,
      })
      const ref = ownerTxRef(expense.id)
      await sdk.setDoc(ref, expense)
      assert.equal((await sdk.getDoc(ref)).exists(), true)

      // Unpaid expense with <=10 splits deletes successfully
      await sdk.deleteDoc(ref)
      assert.equal((await sdk.getDoc(ref)).exists(), false)
    })

    // 12. Forged repayment history at creation is rejected
    await t.test('12. Forged repayment history at creation is rejected', async () => {
      // Direct create with reimbursementStatus: 'settled'
      await assert.rejects(
        sdk.setDoc(ownerTxRef('forged-settled'), {
          ...validExpenseFixture(),
          reimbursementStatus: 'settled',
        }),
        /permission-denied/
      )

      // Direct create with reimbursementStatus: 'partial'
      await assert.rejects(
        sdk.setDoc(ownerTxRef('forged-partial'), {
          ...validExpenseFixture(),
          reimbursementStatus: 'partial',
        }),
        /permission-denied/
      )

      // Direct create with repaidPaise > 0 in splits
      await assert.rejects(
        sdk.setDoc(ownerTxRef('forged-repaid-paise'), {
          ...validExpenseFixture({
            recoverablePaise: 5000,
            reimbursementStatus: 'pending',
            splits: [{ personId: 'p1', personName: 'P1', amountPaise: 5000, repaidPaise: 1000, settledAt: null }],
          }),
        }),
        /permission-denied/
      )

      // Direct create with settledAt marker in splits
      await assert.rejects(
        sdk.setDoc(ownerTxRef('forged-settled-marker'), {
          ...validExpenseFixture({
            recoverablePaise: 5000,
            reimbursementStatus: 'pending',
            splits: [{ personId: 'p1', personName: 'P1', amountPaise: 5000, repaidPaise: 0, settledAt: sdk.Timestamp.now() }],
          }),
        }),
        /permission-denied/
      )

      // Inconsistent recoverablePaise: recoverablePaise > 0 with status 'none'
      await assert.rejects(
        sdk.setDoc(ownerTxRef('inconsistent-none-rec'), {
          ...validExpenseFixture({
            recoverablePaise: 5000,
            reimbursementStatus: 'none',
            splits: [],
          }),
        }),
        /permission-denied/
      )

      // Inconsistent recoverablePaise: recoverablePaise == 0 with status 'pending'
      await assert.rejects(
        sdk.setDoc(ownerTxRef('inconsistent-pending-zero'), {
          ...validExpenseFixture({
            recoverablePaise: 0,
            reimbursementStatus: 'pending',
            splits: [],
          }),
        }),
        /permission-denied/
      )

      // Inconsistent recoverablePaise: recoverablePaise > 0 with empty splits
      await assert.rejects(
        sdk.setDoc(ownerTxRef('inconsistent-empty-splits'), {
          ...validExpenseFixture({
            recoverablePaise: 5000,
            reimbursementStatus: 'pending',
            splits: [],
          }),
        }),
        /permission-denied/
      )

      // Inconsistent recoverablePaise: recoverablePaise == 0 with non-empty splits
      await assert.rejects(
        sdk.setDoc(ownerTxRef('inconsistent-zero-splits'), {
          ...validExpenseFixture({
            recoverablePaise: 0,
            reimbursementStatus: 'none',
            splits: [{ personId: 'p1', personName: 'P1', amountPaise: 1000, repaidPaise: 0, settledAt: null }],
          }),
        }),
        /permission-denied/
      )
    })

    // 13. Valid repayment and settlement transactions still succeed
    await t.test('13. Valid repayment and settlement transactions still succeed', async () => {
      const initial = validExpenseFixture({
        recoverablePaise: 5000,
        reimbursementStatus: 'pending',
        splits: [{ personId: 'p1', personName: 'Person 1', amountPaise: 5000, repaidPaise: 0, settledAt: null }],
      })
      const ref = ownerTxRef(initial.id)
      await sdk.setDoc(ref, initial)

      // Repayment transaction update: pending -> partial
      await sdk.updateDoc(ref, {
        recoverablePaise: 2500,
        reimbursementStatus: 'partial',
        splits: [{ personId: 'p1', personName: 'Person 1', amountPaise: 5000, repaidPaise: 2500, settledAt: null }],
      })
      const snap1 = await sdk.getDoc(ref)
      assert.equal(snap1.data()?.reimbursementStatus, 'partial')
      assert.equal(snap1.data()?.splits[0].repaidPaise, 2500)

      // Settlement transaction update: partial -> settled
      await sdk.updateDoc(ref, {
        recoverablePaise: 0,
        reimbursementStatus: 'settled',
        splits: [{ personId: 'p1', personName: 'Person 1', amountPaise: 5000, repaidPaise: 5000, settledAt: sdk.Timestamp.now() }],
      })
      const snap2 = await sdk.getDoc(ref)
      assert.equal(snap2.data()?.reimbursementStatus, 'settled')
      assert.equal(snap2.data()?.splits[0].repaidPaise, 5000)
    })

    // 14. Recurring expense creation still succeeds
    await t.test('14. Recurring expense creation still succeeds', async () => {
      const recId = `recurring|item-123|${Date.now()}|0`
      const recurringExpense = validExpenseFixture({
        id: recId,
        type: 'recurring',
        recurringItemId: 'item-123',
        description: 'Monthly broadband',
      })
      const ref = ownerTxRef(recurringExpense.id)
      await sdk.setDoc(ref, recurringExpense)
      const snap = await sdk.getDoc(ref)
      assert.equal(snap.exists(), true)
      assert.equal(snap.data()?.type, 'recurring')
    })

    // 15. Invalid monetary fields are rejected
    await t.test('15. Invalid monetary fields are rejected', async () => {
      // Negative amount on create
      await assert.rejects(
        sdk.setDoc(ownerTxRef('neg-amt-' + crypto.randomUUID()), { ...validExpenseFixture(), amountPaise: -500 }),
        /permission-denied/
      )

      // Zero amount on create
      await assert.rejects(
        sdk.setDoc(ownerTxRef('zero-amt-' + crypto.randomUUID()), { ...validExpenseFixture(), amountPaise: 0 }),
        /permission-denied/
      )

      // Non-integer amount on create
      await assert.rejects(
        sdk.setDoc(ownerTxRef('float-amt-' + crypto.randomUUID()), { ...validExpenseFixture(), amountPaise: 99.99 }),
        /permission-denied/
      )

      // Cash payment mode with non-null account
      await assert.rejects(
        sdk.setDoc(ownerTxRef('cash-acc-' + crypto.randomUUID()), { ...validExpenseFixture(), paymentMode: 'Cash', paymentAccountId: 'acc-1' }),
        /permission-denied/
      )

      // UPI payment mode with null account
      await assert.rejects(
        sdk.setDoc(ownerTxRef('upi-null-' + crypto.randomUUID()), { ...validExpenseFixture(), paymentMode: 'UPI', paymentAccountId: null }),
        /permission-denied/
      )

      // UPI payment mode with empty string account
      await assert.rejects(
        sdk.setDoc(ownerTxRef('upi-empty-' + crypto.randomUUID()), { ...validExpenseFixture(), paymentMode: 'UPI', paymentAccountId: '' }),
        /permission-denied/
      )

      // Negative amount on update
      const valid = validExpenseFixture()
      const validRef = ownerTxRef(valid.id)
      await sdk.setDoc(validRef, valid)
      await assert.rejects(sdk.updateDoc(validRef, { amountPaise: -100 }), /permission-denied/)
    })

    // 16. Existing legitimate transaction edits remain supported
    await t.test('16. Existing legitimate transaction edits remain supported', async () => {
      const expense = validExpenseFixture({
        paymentMode: 'UPI',
        paymentAccountId: 'bank-acc-1',
      })
      const ref = ownerTxRef(expense.id)
      await sdk.setDoc(ref, expense)

      await sdk.updateDoc(ref, {
        description: 'Updated grocery description',
        categoryId: 'household',
        notes: 'Bought organic items',
      })

      const snap = await sdk.getDoc(ref)
      assert.equal(snap.data()?.description, 'Updated grocery description')
      assert.equal(snap.data()?.categoryId, 'household')
      assert.equal(snap.data()?.notes, 'Bought organic items')
    })

    // 17. Negative test demonstrating remaining split-history overwrite bypass
    await t.test('17. Remaining split-history overwrite bypass (requires Cloud Functions Phase 7.2)', async () => {
      // Seed an unpaid split expense legitimately
      const initial = validExpenseFixture({
        recoverablePaise: 5000,
        reimbursementStatus: 'pending',
        splits: [{ personId: 'p1', personName: 'Person 1', amountPaise: 5000, repaidPaise: 0, settledAt: null }],
      })
      const ref = ownerTxRef(initial.id)
      await sdk.setDoc(ref, initial)

      // Legitimate repayment update advances status to partial
      await sdk.updateDoc(ref, {
        recoverablePaise: 2500,
        reimbursementStatus: 'partial',
        splits: [{ personId: 'p1', personName: 'Person 1', amountPaise: 5000, repaidPaise: 2500, settledAt: null }],
      })

      // An authenticated owner can directly overwrite the splits array while keeping
      // reimbursementStatus as 'partial' (e.g. reducing repaidPaise from 2500 to 1).
      // Because Firestore security rules cannot iterate across dynamic arrays of maps
      // to assert incoming[i].repaidPaise >= existing[i].repaidPaise, this client write succeeds.
      await sdk.updateDoc(ref, {
        splits: [{ personId: 'p1', personName: 'Person 1', amountPaise: 5000, repaidPaise: 1, settledAt: null }],
        recoverablePaise: 4999,
      })

      const forgedSnap = await sdk.getDoc(ref)
      // Confirmed bypass: repaidPaise was altered from 2500 down to 1 via direct client write.
      // Phase 7.2 will eliminate this bypass by moving repayment/settlement writes to Cloud Functions.
      assert.equal(forgedSnap.data()?.splits[0].repaidPaise, 1)
      assert.equal(forgedSnap.data()?.reimbursementStatus, 'partial')
    })
  } finally {
    await sdk.terminate(ownerDb)
    await sdk.terminate(otherDb)
    await deleteApp(ownerApp)
    await deleteApp(otherApp)
  }
})
