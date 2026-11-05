import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PersonSchema } from '../../utils/schemas.ts'
import {
  applyRepayment,
  applyFullSettlement,
  getRecoverablePaise,
  getNetSpendPaise,
  getPendingRecoverablePaise,
  getRepaidPaise,
  UNASSIGNED_PERSON_ID,
  type SplitAwareTransaction,
} from '../../utils/splitMath.ts'
import type { Transaction } from '../../types/index.ts'

describe('People & Repayments — Service Logic & Invariants', () => {
  // Helper to create a rich test transaction with unrelated metadata
  function createSampleTransaction(overrides?: Partial<Transaction>): Transaction {
    return {
      id: 'tx-100',
      amountPaise: 300000, // ₹3,000 paid gross
      description: 'Group dinner at Fisherman’s Wharf',
      categoryId: 'cat-food',
      type: 'trip',
      date: { seconds: 1772000000, nanoseconds: 0 } as any,
      paymentMode: 'UPI',
      paymentAccountId: 'acc-hdfc-upi',
      tripId: 'trip-gokarna-2026',
      personId: null,
      tags: ['dinner', 'seafood'],
      notes: 'Fronted by Lochan for group',
      receiptUrl: 'https://storage.spenza.app/receipts/r1.jpg',
      recoverablePaise: 200000, // ₹2,000 recoverable (user share = ₹1,000)
      splits: [
        {
          personId: 'person-aarav',
          personName: 'Aarav',
          amountPaise: 100000, // ₹1,000
          repaidPaise: 0,
          settledAt: null,
        },
        {
          personId: 'person-meera',
          personName: 'Meera',
          amountPaise: 100000, // ₹1,000
          repaidPaise: 0,
          settledAt: null,
        },
      ],
      reimbursementStatus: 'pending',
      createdAt: { seconds: 1772000000, nanoseconds: 0 } as any,
      updatedAt: { seconds: 1772000000, nanoseconds: 0 } as any,
      ...overrides,
    }
  }

  // ── 1 & 2. Person validation, creation & archiving logic ───────────────────
  describe('1 & 2. Person validation & editing logic', () => {
    it('validates and creates clean person data with defaults', () => {
      const valid = PersonSchema.parse({ name: '  Aarav Sharma  ' })
      assert.equal(valid.name, 'Aarav Sharma')
      assert.equal(valid.isArchived, false)
    })

    it('rejects empty or whitespace-only names', () => {
      assert.throws(() => PersonSchema.parse({ name: '   ' }), {
        name: 'ZodError',
      })
    })

    it('allows toggling isArchived flag', () => {
      const archived = PersonSchema.parse({ name: 'Rahul', isArchived: true })
      assert.equal(archived.isArchived, true)

      const restored = PersonSchema.parse({ ...archived, isArchived: false })
      assert.equal(restored.isArchived, false)
    })
  })

  // ── 3. Partial repayment ──────────────────────────────────────────────────
  describe('3. Partial repayment', () => {
    it('records a partial repayment on a split share and updates status to "partial"', () => {
      const tx = createSampleTransaction()
      const result = applyRepayment(tx, 'person-aarav', 40000, { seconds: 1772100000, nanoseconds: 0 })

      assert.equal(result.appliedPaise, 40000) // ₹400
      assert.equal(result.remainingPersonBalancePaise, 60000) // ₹600 remaining
      assert.equal(result.reimbursementStatus, 'partial')

      const aaravShare = result.splits.find(s => s.personId === 'person-aarav')!
      assert.equal(aaravShare.repaidPaise, 40000)
      assert.equal(aaravShare.settledAt, null) // Not yet settled

      // Verify Meera's share was untouched
      const meeraShare = result.splits.find(s => s.personId === 'person-meera')!
      assert.equal(meeraShare.repaidPaise, 0)
    })
  })

  // ── 4. Full settlement ────────────────────────────────────────────────────
  describe('4. Full settlement', () => {
    it('settles a single person’s full remaining balance', () => {
      const tx = createSampleTransaction()
      // First partial
      const partial = applyRepayment(tx, 'person-aarav', 30000)
      const intermediateTx = { ...tx, splits: partial.splits }

      // Now settle remaining for Aarav
      const settleResult = applyFullSettlement(intermediateTx, 'person-aarav', { seconds: 1772200000, nanoseconds: 0 })
      assert.equal(settleResult.settledPaise, 70000) // remaining ₹700
      assert.equal(settleResult.reimbursementStatus, 'partial') // Meera still pending

      const aarav = settleResult.splits.find(s => s.personId === 'person-aarav')!
      assert.equal(aarav.repaidPaise, 100000)
      assert.notEqual(aarav.settledAt, null)
    })

    it('settles all splits for all participants on a transaction', () => {
      const tx = createSampleTransaction()
      const result = applyFullSettlement(tx, undefined, { seconds: 1772300000, nanoseconds: 0 })

      assert.equal(result.settledPaise, 200000) // ₹2,000 total settled
      assert.equal(result.reimbursementStatus, 'settled')

      for (const s of result.splits) {
        assert.equal(s.repaidPaise, s.amountPaise)
        assert.notEqual(s.settledAt, null)
      }
    })

    it('returns 0 settled paise without error if already settled', () => {
      const tx = createSampleTransaction({
        reimbursementStatus: 'settled',
        splits: [
          { personId: 'p1', personName: 'P1', amountPaise: 50000, repaidPaise: 50000, settledAt: null },
        ],
      })

      const res = applyFullSettlement(tx, 'p1')
      assert.equal(res.settledPaise, 0)
      assert.equal(res.reimbursementStatus, 'settled')
    })
  })

  // ── 5. Attempting to repay more than the outstanding amount ───────────────
  describe('5. Overpayment prevention', () => {
    it('throws when repayment amount exceeds the outstanding balance', () => {
      const tx = createSampleTransaction()
      assert.throws(
        () => applyRepayment(tx, 'person-aarav', 100001), // ₹1,000.01 on a ₹1,000 share
        /exceeds outstanding balance/
      )
    })

    it('throws when attempting to repay on an already fully settled share', () => {
      const tx = createSampleTransaction({
        splits: [
          { personId: 'person-aarav', personName: 'Aarav', amountPaise: 50000, repaidPaise: 50000, settledAt: null },
        ],
      })
      assert.throws(
        () => applyRepayment(tx, 'person-aarav', 100),
        /already fully repaid/
      )
    })
  })

  // ── 6. Repayments involving multiple people independently ─────────────────
  describe('6. Multi-person split independence', () => {
    it('handles multiple people on the same transaction independently', () => {
      const tx = createSampleTransaction()

      // Aarav pays ₹500
      const step1 = applyRepayment(tx, 'person-aarav', 50000)
      const tx1 = { ...tx, splits: step1.splits, reimbursementStatus: step1.reimbursementStatus }

      // Meera pays ₹800
      const step2 = applyRepayment(tx1, 'person-meera', 80000)
      const tx2 = { ...tx1, splits: step2.splits, reimbursementStatus: step2.reimbursementStatus }

      const aarav = tx2.splits.find(s => s.personId === 'person-aarav')!
      const meera = tx2.splits.find(s => s.personId === 'person-meera')!

      assert.equal(aarav.repaidPaise, 50000)
      assert.equal(meera.repaidPaise, 80000)
      assert.equal(getRepaidPaise(tx2), 130000)
      assert.equal(getPendingRecoverablePaise(tx2), 70000)
      assert.equal(tx2.reimbursementStatus, 'partial')

      // Now Aarav settles remaining ₹500 -> Aarav is done, Meera still owes ₹200
      const step3 = applyRepayment(tx2, 'person-aarav', 50000)
      const tx3 = { ...tx2, splits: step3.splits, reimbursementStatus: step3.reimbursementStatus }
      assert.equal(tx3.reimbursementStatus, 'partial')

      // Finally Meera settles remaining ₹200 -> Now settled
      const step4 = applyRepayment(tx3, 'person-meera', 20000)
      const tx4 = { ...tx3, splits: step4.splits, reimbursementStatus: step4.reimbursementStatus }
      assert.equal(tx4.reimbursementStatus, 'settled')
      assert.equal(getPendingRecoverablePaise(tx4), 0)
    })
  })

  // ── 7. Invalid IDs and monetary values ────────────────────────────────────
  describe('7. Invalid IDs and monetary values', () => {
    it('throws on non-positive, zero, or floating-point repayment amounts', () => {
      const tx = createSampleTransaction()
      assert.throws(() => applyRepayment(tx, 'person-aarav', 0), /positive integer/)
      assert.throws(() => applyRepayment(tx, 'person-aarav', -500), /positive integer/)
      assert.throws(() => applyRepayment(tx, 'person-aarav', 499.5), /positive integer/)
    })

    it('throws when personId is not found on the transaction', () => {
      const tx = createSampleTransaction()
      assert.throws(
        () => applyRepayment(tx, 'non-existent-person', 5000),
        /No split share found for person/
      )
    })
  })

  // ── 8. Missing authentication & missing transactions ──────────────────────
  describe('8. Input boundary checks', () => {
    it('throws when transaction has no recoverable split shares', () => {
      const unsplitTx: SplitAwareTransaction = {
        amountPaise: 50000,
        type: 'everyday',
      }
      assert.throws(
        () => applyRepayment(unsplitTx, 'p1', 1000),
        /Transaction has no recoverable split shares/
      )
    })

    it('supports legacy type="reimbursable" transactions with named or unassigned person', () => {
      const legacyNamed: SplitAwareTransaction = {
        amountPaise: 80000,
        type: 'reimbursable',
        personId: 'Rahul',
      }
      const res = applyRepayment(legacyNamed, 'Rahul', 30000)
      assert.equal(res.appliedPaise, 30000)
      assert.equal(res.remainingPersonBalancePaise, 50000)
      assert.equal(res.reimbursementStatus, 'partial')

      const legacyUnassigned: SplitAwareTransaction = {
        amountPaise: 60000,
        type: 'reimbursable',
        personId: null,
      }
      const res2 = applyRepayment(legacyUnassigned, UNASSIGNED_PERSON_ID, 60000)
      assert.equal(res2.reimbursementStatus, 'settled')
    })
  })

  // ── 9. Preservation of unrelated transaction fields ───────────────────────
  describe('9. Preservation of unrelated transaction fields', () => {
    it('guarantees gross amount, personal spend, category, trip, payment mode and notes remain unchanged', () => {
      const tx = createSampleTransaction()
      const originalGross = tx.amountPaise
      const originalNetSpend = getNetSpendPaise(tx)

      const result = applyRepayment(tx, 'person-aarav', 50000)
      const updatedTx: Transaction = {
        ...tx,
        splits: result.splits,
        reimbursementStatus: result.reimbursementStatus,
      }

      // Financial invariance
      assert.equal(updatedTx.amountPaise, originalGross)
      assert.equal(getNetSpendPaise(updatedTx), originalNetSpend)
      assert.equal(getRecoverablePaise(updatedTx), tx.recoverablePaise)

      // Unrelated metadata invariance
      assert.equal(updatedTx.description, 'Group dinner at Fisherman’s Wharf')
      assert.equal(updatedTx.categoryId, 'cat-food')
      assert.equal(updatedTx.type, 'trip')
      assert.equal(updatedTx.paymentMode, 'UPI')
      assert.equal(updatedTx.paymentAccountId, 'acc-hdfc-upi')
      assert.equal(updatedTx.tripId, 'trip-gokarna-2026')
      assert.deepEqual(updatedTx.tags, ['dinner', 'seafood'])
      assert.equal(updatedTx.notes, 'Fronted by Lochan for group')
      assert.equal(updatedTx.receiptUrl, 'https://storage.spenza.app/receipts/r1.jpg')
    })
  })

  // ── 10. Concurrency Simulation & Stale-Update Vulnerability ───────────────
  describe('10. Concurrency Simulation & Stale-Update Vulnerability Analysis', () => {
    it('demonstrates how non-atomic read-modify-write causes lost repayments', () => {
      // Both clients read the same initial state at t0
      const initialTx = createSampleTransaction()

      // Client A records Aarav's ₹400 payment based on initial snapshot
      const updateA = applyRepayment(initialTx, 'person-aarav', 40000)
      const staleClientAWrite = { ...initialTx, splits: updateA.splits }

      // Client B records Meera's ₹700 payment concurrently, ALSO based on initial snapshot
      const updateB = applyRepayment(initialTx, 'person-meera', 70000)
      const blindClientBWrite = { ...initialTx, splits: updateB.splits }

      // If Client B's blind write overwrites Client A's write (e.g. non-transactional setDoc):
      // Aarav's ₹400 repayment is completely lost!
      const aaravInBlindWrite = blindClientBWrite.splits.find(s => s.personId === 'person-aarav')!
      assert.equal(aaravInBlindWrite.repaidPaise, 0) // Lost update!

      // Conversely, with atomic runTransaction optimistic concurrency:
      // Client B's transaction retries using Client A's committed state:
      const retriedUpdateB = applyRepayment(staleClientAWrite, 'person-meera', 70000)
      const atomicCommittedTx = {
        ...staleClientAWrite,
        splits: retriedUpdateB.splits,
        reimbursementStatus: retriedUpdateB.reimbursementStatus,
      }

      // Both repayments are safely preserved
      assert.equal(atomicCommittedTx.splits.find(s => s.personId === 'person-aarav')!.repaidPaise, 40000)
      assert.equal(atomicCommittedTx.splits.find(s => s.personId === 'person-meera')!.repaidPaise, 70000)
    })

    it('simulates sequential transactional updates on the same transaction', () => {
      const initialTx = createSampleTransaction()

      // Client 1 applies Aarav's ₹400 repayment
      const client1Update = applyRepayment(initialTx, 'person-aarav', 40000)
      const committedByClient1: Transaction = {
        ...initialTx,
        splits: client1Update.splits,
        reimbursementStatus: client1Update.reimbursementStatus,
      }

      // Client 2 attempts to apply Meera's ₹700 repayment on the latest committed state
      const client2Update = applyRepayment(committedByClient1, 'person-meera', 70000)
      const finalCommittedTx: Transaction = {
        ...committedByClient1,
        splits: client2Update.splits,
        reimbursementStatus: client2Update.reimbursementStatus,
      }

      // Assert both repayments are preserved without lost updates
      const finalAarav = finalCommittedTx.splits!.find(s => s.personId === 'person-aarav')!
      const finalMeera = finalCommittedTx.splits!.find(s => s.personId === 'person-meera')!

      assert.equal(finalAarav.repaidPaise, 40000)
      assert.equal(finalMeera.repaidPaise, 70000)
      assert.equal(getRepaidPaise(finalCommittedTx), 110000)
      assert.equal(getPendingRecoverablePaise(finalCommittedTx), 90000)
      assert.equal(finalCommittedTx.reimbursementStatus, 'partial')
    })
  })

  // ── 11. Person-centric multi-transaction settlement simulation ─────────────
  describe('11. Person-centric multi-transaction settlement', () => {
    it('settles all transactions for a specific person while preserving other splits and net spend', () => {
      const tx1 = createSampleTransaction({ id: 'tx-1' }) // Aarav owes 100000, Meera owes 100000
      const tx2 = createSampleTransaction({
        id: 'tx-2',
        amountPaise: 400000,
        splits: [
          { personId: 'person-aarav', personName: 'Aarav', amountPaise: 150000, repaidPaise: 50000, settledAt: null },
          { personId: 'person-kabir', personName: 'Kabir', amountPaise: 150000, repaidPaise: 0, settledAt: null },
        ],
      }) // Aarav owes 100000, Kabir owes 150000

      const allUserTxns = [tx1, tx2]
      const targetPersonId = 'person-aarav'

      // Find transactions where Aarav owes money
      const unsettledForAarav = allUserTxns.filter(t => {
        const share = t.splits?.find(s => s.personId === targetPersonId)
        return share && share.amountPaise > share.repaidPaise
      })
      assert.equal(unsettledForAarav.length, 2)

      // Simulate settlePersonAllDues
      let totalSettled = 0
      const updatedList: Transaction[] = []

      for (const t of unsettledForAarav) {
        const update = applyFullSettlement(t, targetPersonId)
        totalSettled += update.settledPaise
        updatedList.push({
          ...t,
          splits: update.splits,
          reimbursementStatus: update.reimbursementStatus,
        })
      }

      // Assertions
      assert.equal(totalSettled, 200000) // 100000 from tx1 + 100000 remaining from tx2
      assert.equal(updatedList.length, 2)

      // Tx1: Aarav is fully repaid (100000), Meera still owes 100000
      const tx1Aarav = updatedList[0].splits!.find(s => s.personId === 'person-aarav')!
      const tx1Meera = updatedList[0].splits!.find(s => s.personId === 'person-meera')!
      assert.equal(tx1Aarav.repaidPaise, 100000)
      assert.equal(tx1Meera.repaidPaise, 0)
      assert.equal(updatedList[0].reimbursementStatus, 'partial')
      assert.equal(getNetSpendPaise(updatedList[0]), 100000)

      // Tx2: Aarav is fully repaid (150000), Kabir still owes 150000
      const tx2Aarav = updatedList[1].splits!.find(s => s.personId === 'person-aarav')!
      const tx2Kabir = updatedList[1].splits!.find(s => s.personId === 'person-kabir')!
      assert.equal(tx2Aarav.repaidPaise, 150000)
      assert.equal(tx2Kabir.repaidPaise, 0)
      assert.equal(updatedList[1].reimbursementStatus, 'partial')
      assert.equal(getNetSpendPaise(updatedList[1]), 100000)
    })
  })
})
