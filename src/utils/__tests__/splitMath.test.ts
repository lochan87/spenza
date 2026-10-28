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

