import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getRecoverablePaise,
  getNetSpendPaise,
  getNormalizedSplits,
  getRepaidPaise,
  getPendingRecoverablePaise,
  getReimbursementStatus,
  allocateEqualSplitPaise,
  allocateCustomMyShareSplitPaise,
  isSplitOrRecoverable,
  getPersonShare,
  getPersonSharePaise,
  getPersonRepaidPaise,
  getPersonOutstandingPaise,
  validateFinancialInvariants,
  UNASSIGNED_PERSON_ID,
  UNASSIGNED_PERSON_NAME,
  type SplitAwareTransaction,
} from '../splitMath.ts'
import { SplitShareSchema, TransactionSchema } from '../schemas.ts'

describe('splitMath — core accounting helpers & invariants', () => {
  it('1. handles standard unsplit transactions (Case A)', () => {
    const tx: SplitAwareTransaction = {
      amountPaise: 25000, // ₹250
      type: 'everyday',
    }

    assert.equal(getRecoverablePaise(tx), 0)
    assert.equal(getNetSpendPaise(tx), 25000)
    assert.deepEqual(getNormalizedSplits(tx), [])
    assert.equal(getRepaidPaise(tx), 0)
    assert.equal(getPendingRecoverablePaise(tx), 0)
    assert.equal(getReimbursementStatus(tx), 'none')
  })

  it('2. handles legacy type="reimbursable" transactions without new fields (Case G)', () => {
    const legacyWithPerson: SplitAwareTransaction = {
      amountPaise: 50000, // ₹500
      type: 'reimbursable',
      personId: 'Rahul',
    }

    assert.equal(getRecoverablePaise(legacyWithPerson), 50000)
    assert.equal(getNetSpendPaise(legacyWithPerson), 0)
    assert.equal(getRepaidPaise(legacyWithPerson), 0)
    assert.equal(getPendingRecoverablePaise(legacyWithPerson), 50000)
    assert.equal(getReimbursementStatus(legacyWithPerson), 'pending')

    const splits = getNormalizedSplits(legacyWithPerson)
    assert.equal(splits.length, 1)
    assert.equal(splits[0].personId, 'Rahul')
    assert.equal(splits[0].personName, 'Rahul')
    assert.equal(splits[0].amountPaise, 50000)
    assert.equal(splits[0].repaidPaise, 0)

    const legacyUnassigned: SplitAwareTransaction = {
      amountPaise: 120000,
      type: 'reimbursable',
      personId: null,
    }
    const unassignedSplits = getNormalizedSplits(legacyUnassigned)
    assert.equal(unassignedSplits[0].personId, UNASSIGNED_PERSON_ID)
    assert.equal(unassignedSplits[0].personName, UNASSIGNED_PERSON_NAME)
  })

  it('3. preserves exact integer paise on uneven equal splits (₹100 ÷ 3, Case C)', () => {
    const result = allocateEqualSplitPaise(
      10000, // ₹100.00 = 10000 paise
      [
        { personId: 'p1', personName: 'Aarav' },
        { personId: 'p2', personName: 'Meera' },
      ],
      true // includeSelf = true => 3 total people
    )

    assert.equal(result.totalPaise, 10000)
    assert.equal(result.mySharePaise, 3334) // ₹33.34 absorbs 1-paise remainder
    assert.equal(result.recoverablePaise, 6666) // ₹33.33 * 2
    assert.equal(result.mySharePaise + result.recoverablePaise, result.totalPaise)
    assert.equal(result.splits.length, 2)
    assert.equal(result.splits[0].amountPaise, 3333)
    assert.equal(result.splits[1].amountPaise, 3333)
    assert.equal(
      result.splits.reduce((s, item) => s + item.amountPaise, 0),
      result.recoverablePaise
    )
  })

  it('4. allocates 100% recoverable across multiple people when includeSelf=false', () => {
    const result = allocateEqualSplitPaise(
      10000, // ₹100.00 fronted entirely for 3 friends
      [
        { personId: 'p1', personName: 'Aarav' },
        { personId: 'p2', personName: 'Meera' },
        { personId: 'p3', personName: 'Kabir' },
      ],
      false
    )

    assert.equal(result.mySharePaise, 0)
    assert.equal(result.recoverablePaise, 10000)
    assert.deepEqual(
      result.splits.map(s => s.amountPaise),
      [3334, 3333, 3333]
    )
    assert.equal(
      result.splits.reduce((s, item) => s + item.amountPaise, 0),
      10000
    )
  })

  it('5. allocates custom user share and distributes remainder across participants', () => {
    const result = allocateCustomMyShareSplitPaise(
      250000, // ₹2,500 total bill
      50000, // ₹500 my share -> ₹2,000 recoverable across 3 friends
      [
        { personId: 'p1', personName: 'Aarav' },
        { personId: 'p2', personName: 'Meera' },
        { personId: 'p3', personName: 'Kabir' },
      ]
    )

    assert.equal(result.mySharePaise, 50000)
    assert.equal(result.recoverablePaise, 200000)
    assert.deepEqual(
      result.splits.map(s => s.amountPaise),
      [66667, 66667, 66666]
    )
    assert.equal(result.mySharePaise + result.recoverablePaise, result.totalPaise)
  })

  it('6. tracks partial and multi-person repayments without distorting gross or net spend (Cases D, E, F)', () => {
    // Initial 3-way split of ₹100
    const baseTx: SplitAwareTransaction = {
      amountPaise: 10000,
      type: 'everyday',
      recoverablePaise: 6666,
      splits: [
        { personId: 'p1', personName: 'Aarav', amountPaise: 3333, repaidPaise: 0, settledAt: null },
        { personId: 'p2', personName: 'Meera', amountPaise: 3333, repaidPaise: 0, settledAt: null },
      ],
    }

    assert.equal(getReimbursementStatus(baseTx), 'pending')
    assert.equal(getPendingRecoverablePaise(baseTx), 6666)
    assert.equal(getNetSpendPaise(baseTx), 3334)

    // Case D: Aarav partially repays ₹20 (2000 paise)
    const afterPartialTx: SplitAwareTransaction = {
      ...baseTx,
      splits: [
        { personId: 'p1', personName: 'Aarav', amountPaise: 3333, repaidPaise: 2000, settledAt: null },
        { personId: 'p2', personName: 'Meera', amountPaise: 3333, repaidPaise: 0, settledAt: null },
      ],
    }
    assert.equal(getRepaidPaise(afterPartialTx), 2000)
    assert.equal(getPendingRecoverablePaise(afterPartialTx), 4666)
    assert.equal(getReimbursementStatus(afterPartialTx), 'partial')
    // Settlement orthogonality invariant: gross and net personal spend never change on repayment
    assert.equal(afterPartialTx.amountPaise, 10000)
    assert.equal(getNetSpendPaise(afterPartialTx), 3334)

    // Case E: Aarav settles his full share (3333), Meera still owes 3333 -> status MUST be 'partial', NOT 'settled'
    const oneFriendSettledTx: SplitAwareTransaction = {
      ...baseTx,
      splits: [
        { personId: 'p1', personName: 'Aarav', amountPaise: 3333, repaidPaise: 3333, settledAt: null },
        { personId: 'p2', personName: 'Meera', amountPaise: 3333, repaidPaise: 0, settledAt: null },
      ],
    }
    assert.equal(getRepaidPaise(oneFriendSettledTx), 3333)
    assert.equal(getPendingRecoverablePaise(oneFriendSettledTx), 3333)
    assert.equal(getReimbursementStatus(oneFriendSettledTx), 'partial')

    // Case F: Meera also settles her full share (3333) -> now 'settled'
    const allSettledTx: SplitAwareTransaction = {
      ...baseTx,
      splits: [
        { personId: 'p1', personName: 'Aarav', amountPaise: 3333, repaidPaise: 3333, settledAt: null },
        { personId: 'p2', personName: 'Meera', amountPaise: 3333, repaidPaise: 3333, settledAt: null },
      ],
    }
    assert.equal(getRepaidPaise(allSettledTx), 6666)
    assert.equal(getPendingRecoverablePaise(allSettledTx), 0)
    assert.equal(getReimbursementStatus(allSettledTx), 'settled')
    assert.equal(getNetSpendPaise(allSettledTx), 3334)
  })

  it('7. clamps malformed/overpaid split inputs so balances can never become negative', () => {
    const malformedTx: SplitAwareTransaction = {
      amountPaise: 10000,
      type: 'everyday',
      recoverablePaise: 50000, // exceeds gross
      splits: [
        { personId: 'p1', personName: 'Aarav', amountPaise: 15000, repaidPaise: 99999, settledAt: null },
      ],
    }

    assert.equal(getRecoverablePaise(malformedTx), 10000)
    assert.equal(getNetSpendPaise(malformedTx), 0)
    assert.equal(getRepaidPaise(malformedTx), 10000)
    assert.equal(getPendingRecoverablePaise(malformedTx), 0)
    assert.equal(getReimbursementStatus(malformedTx), 'settled')
  })

  it('8. safely handles null, undefined, and empty objects without throwing', () => {
    assert.equal(getRecoverablePaise(null), 0)
    assert.equal(getRecoverablePaise(undefined), 0)
    assert.equal(getNetSpendPaise(null), 0)
    assert.equal(getRepaidPaise(null), 0)
    assert.equal(getPendingRecoverablePaise(null), 0)
    assert.equal(getReimbursementStatus(null), 'none')
    assert.deepEqual(getNormalizedSplits(null), [])
    assert.equal(isSplitOrRecoverable(null), false)

    const emptyTx = {} as unknown as SplitAwareTransaction
    assert.equal(getRecoverablePaise(emptyTx), 0)
    assert.equal(getNetSpendPaise(emptyTx), 0)
    assert.equal(getRepaidPaise(emptyTx), 0)
    assert.equal(getPendingRecoverablePaise(emptyTx), 0)
    assert.equal(getReimbursementStatus(emptyTx), 'none')
    assert.deepEqual(getNormalizedSplits(emptyTx), [])
  })

  it('9. enforces settledAt hygiene — unsettled shares never retain stale settledAt timestamps', () => {
    const fakeTimestamp = { seconds: 1772000000, nanoseconds: 0 } as any
    const rawTx: SplitAwareTransaction = {
      amountPaise: 10000,
      type: 'everyday',
      splits: [
        {
          personId: 'p1',
          personName: 'Aarav',
          amountPaise: 5000,
          repaidPaise: 2000,
          settledAt: fakeTimestamp,
        },
        {
          personId: 'p2',
          personName: 'Meera',
          amountPaise: 5000,
          repaidPaise: 5000,
          settledAt: fakeTimestamp,
        },
      ],
    }

    const splits = getNormalizedSplits(rawTx)
    const aarav = splits.find(s => s.personId === 'p1')!
    const meera = splits.find(s => s.personId === 'p2')!

    assert.equal(aarav.settledAt, null) // cleared because 2000 < 5000
    assert.equal(meera.settledAt, fakeTimestamp) // preserved because 5000 === 5000

    // Duplicate person merger hygiene
    const duplicateTx: SplitAwareTransaction = {
      amountPaise: 10000,
      type: 'everyday',
      splits: [
        { personId: 'p1', personName: 'Aarav', amountPaise: 3000, repaidPaise: 3000, settledAt: fakeTimestamp },
        { personId: 'p1', personName: 'Aarav', amountPaise: 3000, repaidPaise: 1000, settledAt: null },
      ],
    }
    const mergedSplits = getNormalizedSplits(duplicateTx)
    assert.equal(mergedSplits.length, 1)
    assert.equal(mergedSplits[0].amountPaise, 6000)
    assert.equal(mergedSplits[0].repaidPaise, 4000)
    assert.equal(mergedSplits[0].settledAt, null) // 4000 < 6000 => settledAt is null
  })

  it('10. preserves settledAt in allocateEqualSplitPaise and allocateCustomMyShareSplitPaise when fully repaid', () => {
    const fakeTimestamp = { seconds: 1772000000, nanoseconds: 0 } as any
    const repaidMap = new Map([['p1', 5000]])
    const settledAtMap = new Map([['p1', fakeTimestamp]])

    const equalRes = allocateEqualSplitPaise(
      10000,
      [{ personId: 'p1', personName: 'Aarav' }],
      true, // user + friend => 5000 each
      repaidMap,
      settledAtMap
    )
    assert.equal(equalRes.splits[0].amountPaise, 5000)
    assert.equal(equalRes.splits[0].repaidPaise, 5000)
    assert.equal(equalRes.splits[0].settledAt, fakeTimestamp)

    const customRes = allocateCustomMyShareSplitPaise(
      10000,
      5000, // user share = 5000 => recoverable = 5000
      [{ personId: 'p1', personName: 'Aarav' }],
      repaidMap,
      settledAtMap
    )
    assert.equal(customRes.splits[0].amountPaise, 5000)
    assert.equal(customRes.splits[0].repaidPaise, 5000)
    assert.equal(customRes.splits[0].settledAt, fakeTimestamp)
  })

  it('11. person query helpers retrieve accurate share, repaid, and outstanding amounts', () => {
    const fakeTimestamp = { seconds: 1772000000, nanoseconds: 0 } as any
    const tx: SplitAwareTransaction = {
      amountPaise: 10000,
      type: 'everyday',
      splits: [
        { personId: 'p1', personName: 'Aarav', amountPaise: 4000, repaidPaise: 2500, settledAt: null },
        { personId: 'p2', personName: 'Meera', amountPaise: 3000, repaidPaise: 3000, settledAt: fakeTimestamp },
      ],
    }

    assert.equal(isSplitOrRecoverable(tx), true)
    assert.equal(getPersonShare(tx, 'p1')?.personName, 'Aarav')
    assert.equal(getPersonSharePaise(tx, 'p1'), 4000)
    assert.equal(getPersonRepaidPaise(tx, 'p1'), 2500)
    assert.equal(getPersonOutstandingPaise(tx, 'p1'), 1500)

    assert.equal(getPersonShare(tx, 'p2')?.personName, 'Meera')
    assert.equal(getPersonSharePaise(tx, 'p2'), 3000)
    assert.equal(getPersonRepaidPaise(tx, 'p2'), 3000)
    assert.equal(getPersonOutstandingPaise(tx, 'p2'), 0)

    // Uninvolved person
    assert.equal(getPersonShare(tx, 'unknown'), undefined)
    assert.equal(getPersonSharePaise(tx, 'unknown'), 0)
    assert.equal(getPersonRepaidPaise(tx, 'unknown'), 0)
    assert.equal(getPersonOutstandingPaise(tx, 'unknown'), 0)
  })

  it('12. validateFinancialInvariants validates all 4 financial rules across personal, shared, recoverable and legacy', () => {
    const fakeTimestamp = { seconds: 1772000000, nanoseconds: 0 } as any
    // A. Personal expense
    const personalTx: SplitAwareTransaction = { amountPaise: 15000, type: 'everyday' }
    const repA = validateFinancialInvariants(personalTx)
    assert.equal(repA.isValid, true)
    assert.equal(repA.grossPaise, 15000)
    assert.equal(repA.netSpendPaise, 15000)
    assert.equal(repA.recoverablePaise, 0)
    assert.equal(repA.repaidPaise, 0)
    assert.equal(repA.outstandingPaise, 0)

    // B. Shared expense with partial repayment
    const sharedTx: SplitAwareTransaction = {
      amountPaise: 30000,
      type: 'everyday',
      splits: [
        { personId: 'p1', personName: 'Aarav', amountPaise: 10000, repaidPaise: 4000, settledAt: null },
        { personId: 'p2', personName: 'Meera', amountPaise: 10000, repaidPaise: 10000, settledAt: fakeTimestamp },
      ],
    }
    const repB = validateFinancialInvariants(sharedTx)
    assert.equal(repB.isValid, true)
    assert.equal(repB.grossPaise, 30000)
    assert.equal(repB.netSpendPaise, 10000) // User share = ₹100
    assert.equal(repB.recoverablePaise, 20000) // ₹200 recoverable
    assert.equal(repB.repaidPaise, 14000) // ₹140 repaid
    assert.equal(repB.outstandingPaise, 6000) // ₹60 outstanding
    assert.equal(repB.grossPaise, repB.netSpendPaise + repB.recoverablePaise)
    assert.equal(repB.recoverablePaise, repB.repaidPaise + repB.outstandingPaise)

    // C. 100% Recoverable expense
    const fullRecoverableTx: SplitAwareTransaction = {
      amountPaise: 25000,
      type: 'everyday',
      splits: [
        { personId: 'p1', personName: 'Aarav', amountPaise: 25000, repaidPaise: 0, settledAt: null },
      ],
    }
    const repC = validateFinancialInvariants(fullRecoverableTx)
    assert.equal(repC.isValid, true)
    assert.equal(repC.grossPaise, 25000)
    assert.equal(repC.netSpendPaise, 0)
    assert.equal(repC.recoverablePaise, 25000)
    assert.equal(repC.outstandingPaise, 25000)

    // D. Legacy reimbursable
    const legacyTx: SplitAwareTransaction = {
      amountPaise: 5000,
      type: 'reimbursable',
      personId: 'Rohan',
    }
    const repD = validateFinancialInvariants(legacyTx)
    assert.equal(repD.isValid, true)
    assert.equal(repD.grossPaise, 5000)
    assert.equal(repD.netSpendPaise, 0)
    assert.equal(repD.recoverablePaise, 5000)
    assert.equal(repD.outstandingPaise, 5000)
  })
})

describe('schemas — SplitShareSchema & TransactionSchema validation', () => {
  const validBaseTx = {
    amountPaise: 100000, // ₹1,000
    description: 'Dinner at Namaste Cafe',
    categoryId: 'cat-food',
    type: 'everyday' as const,
    date: '2026-10-28',
    paymentMode: 'UPI' as const,
    paymentAccountId: 'acc-gpay',
    tripId: null,
    personId: null,
    tags: [],
    notes: '',
    receiptUrl: null,
  }

  it('1. accepts existing transactions without recoverablePaise or splits (backward compatibility)', () => {
    const parsed = TransactionSchema.safeParse(validBaseTx)
    assert.equal(parsed.success, true)
  })

  it('2. accepts valid split transactions where sum(splits.amountPaise) === recoverablePaise', () => {
    const parsed = TransactionSchema.safeParse({
      ...validBaseTx,
      recoverablePaise: 60000,
      reimbursementStatus: 'partial',
      splits: [
        { personId: 'p1', personName: 'Aarav', amountPaise: 30000, repaidPaise: 30000, settledAt: null },
        { personId: 'p2', personName: 'Meera', amountPaise: 30000, repaidPaise: 0, settledAt: null },
      ],
    })
    assert.equal(parsed.success, true)
  })

  it('3. rejects non-integer paise or repaidPaise > amountPaise in SplitShareSchema', () => {
    const floatShare = SplitShareSchema.safeParse({
      personId: 'p1',
      personName: 'Aarav',
      amountPaise: 3333.5,
      repaidPaise: 0,
    })
    assert.equal(floatShare.success, false)

    const overpaidShare = SplitShareSchema.safeParse({
      personId: 'p1',
      personName: 'Aarav',
      amountPaise: 30000,
      repaidPaise: 30001,
    })
    assert.equal(overpaidShare.success, false)
  })

  it('4. rejects recoverablePaise > amountPaise or mismatched splits sum in TransactionSchema', () => {
    const exceedsTotal = TransactionSchema.safeParse({
      ...validBaseTx,
      recoverablePaise: 150000, // > 100000
    })
    assert.equal(exceedsTotal.success, false)

    const mismatchedSplits = TransactionSchema.safeParse({
      ...validBaseTx,
      recoverablePaise: 60000,
      splits: [
        { personId: 'p1', personName: 'Aarav', amountPaise: 25000, repaidPaise: 0 },
        { personId: 'p2', personName: 'Meera', amountPaise: 25000, repaidPaise: 0 },
      ], // sum = 50000 !== 60000
    })
    assert.equal(mismatchedSplits.success, false)

    const emptySplitsWithRecoverable = TransactionSchema.safeParse({
      ...validBaseTx,
      recoverablePaise: 50000,
      splits: [],
    })
    assert.equal(emptySplitsWithRecoverable.success, false)

    const duplicatePersonSplits = TransactionSchema.safeParse({
      ...validBaseTx,
      recoverablePaise: 60000,
      splits: [
        { personId: 'p1', personName: 'Aarav', amountPaise: 30000, repaidPaise: 0 },
        { personId: 'p1', personName: 'Aarav', amountPaise: 30000, repaidPaise: 0 },
      ],
    })
    assert.equal(duplicatePersonSplits.success, false)
  })
})

