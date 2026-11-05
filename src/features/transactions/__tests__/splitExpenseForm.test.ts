import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeFormSplits,
  getInitialSharingState,
  validateRepaymentSafety,
  getRecommendedPreset,
} from '../splitFormHelpers.ts'
import { TransactionSchema } from '../../../utils/schemas.ts'
import type { Transaction } from '../../../types/index.ts'

describe('splitExpenseForm — Form calculation, presets, and edit safety', () => {
  const dummyTimestamp = { seconds: 1730000000, nanoseconds: 0 } as any

  const baseTx: Transaction = {
    id: 'tx-1',
    amountPaise: 120000, // ₹1,200
    description: 'Team Lunch',
    categoryId: 'cat-food',
    type: 'everyday',
    date: dummyTimestamp,
    paymentMode: 'UPI',
    paymentAccountId: 'acc-1',
    tripId: 'trip-1',
    personId: null,
    tags: ['lunch', 'office'],
    notes: 'Paid via GPay',
    receiptUrl: 'https://example.com/receipt.jpg',
    createdAt: dummyTimestamp,
    updatedAt: dummyTimestamp,
  }

  it('1. Normal personal expense remains unchanged', () => {
    const calc = computeFormSplits({
      amountPaise: 120000,
      sharingMode: 'none',
      splitPreset: 'equal_2',
      customMySharePaise: 0,
      participants: [],
    })

    assert.equal(calc.totalPaise, 120000)
    assert.equal(calc.mySharePaise, 120000)
    assert.equal(calc.recoverablePaise, 0)
    assert.deepEqual(calc.splits, [])
    assert.equal(calc.reimbursementStatus, 'none')
    assert.equal(calc.error, null)

    const init = getInitialSharingState(baseTx)
    assert.equal(init.sharingMode, 'none')
    assert.deepEqual(init.initialParticipants, [])
  })

  it('2. Fully recoverable expense allocates 100% to participants', () => {
    const calc = computeFormSplits({
      amountPaise: 150000, // ₹1,500
      sharingMode: 'fully_recoverable',
      splitPreset: 'equal_2',
      customMySharePaise: 0,
      participants: [
        { id: 'p1', name: 'Rahul' },
        { id: 'p2', name: 'Priya' },
      ],
    })

    assert.equal(calc.totalPaise, 150000)
    assert.equal(calc.mySharePaise, 0)
    assert.equal(calc.recoverablePaise, 150000)
    assert.equal(calc.splits.length, 2)
    assert.equal(calc.splits[0].amountPaise, 75000)
    assert.equal(calc.splits[1].amountPaise, 75000)
    assert.equal(calc.reimbursementStatus, 'pending')
    assert.equal(calc.error, null)
  })

  it('3. Equal split with 2, 3, and 4 participants (including user)', () => {
    // 2 total (me + 1)
    const calc2 = computeFormSplits({
      amountPaise: 100000, // ₹1,000
      sharingMode: 'shared',
      splitPreset: 'equal_2',
      customMySharePaise: 0,
      participants: [{ id: 'p1', name: 'Rahul' }],
    })
    assert.equal(calc2.error, null)
    assert.equal(calc2.mySharePaise, 50000)
    assert.equal(calc2.recoverablePaise, 50000)
    assert.equal(calc2.splits[0].amountPaise, 50000)

    // 3 total (me + 2)
    const calc3 = computeFormSplits({
      amountPaise: 90000, // ₹900
      sharingMode: 'shared',
      splitPreset: 'equal_3',
      customMySharePaise: 0,
      participants: [
        { id: 'p1', name: 'Rahul' },
        { id: 'p2', name: 'Priya' },
      ],
    })
    assert.equal(calc3.error, null)
    assert.equal(calc3.mySharePaise, 30000)
    assert.equal(calc3.recoverablePaise, 60000)
    assert.equal(calc3.splits.length, 2)
    assert.equal(calc3.splits[0].amountPaise, 30000)
    assert.equal(calc3.splits[1].amountPaise, 30000)

    // 4 total (me + 3)
    const calc4 = computeFormSplits({
      amountPaise: 120000, // ₹1,200
      sharingMode: 'shared',
      splitPreset: 'equal_4',
      customMySharePaise: 0,
      participants: [
        { id: 'p1', name: 'Rahul' },
        { id: 'p2', name: 'Priya' },
        { id: 'p3', name: 'Amit' },
      ],
    })
    assert.equal(calc4.error, null)
    assert.equal(calc4.mySharePaise, 30000)
    assert.equal(calc4.recoverablePaise, 90000)
    assert.equal(calc4.splits.length, 3)
    assert.equal(calc4.splits[0].amountPaise, 30000)
    assert.equal(calc4.splits[1].amountPaise, 30000)
    assert.equal(calc4.splits[2].amountPaise, 30000)

    // Mismatched participant count triggers validation error
    const calcMismatch = computeFormSplits({
      amountPaise: 100000,
      sharingMode: 'shared',
      splitPreset: 'equal_2',
      customMySharePaise: 0,
      participants: [
        { id: 'p1', name: 'Rahul' },
        { id: 'p2', name: 'Priya' },
      ],
    })
    assert.match(calcMismatch.error || '', /requires 1 friend selected/i)
  })

  it('4. Custom user share calculates remaining recoverable accurately', () => {
    const calc = computeFormSplits({
      amountPaise: 100000, // ₹1,000 total bill
      sharingMode: 'shared',
      splitPreset: 'custom_my_share',
      customMySharePaise: 40000, // ₹400 user's share -> ₹600 to be split
      participants: [
        { id: 'p1', name: 'Rahul' },
        { id: 'p2', name: 'Priya' },
      ],
    })

    assert.equal(calc.error, null)
    assert.equal(calc.mySharePaise, 40000)
    assert.equal(calc.recoverablePaise, 60000)
    assert.equal(calc.splits[0].amountPaise, 30000)
    assert.equal(calc.splits[1].amountPaise, 30000)
    assert.equal(calc.mySharePaise + calc.recoverablePaise, 100000)
  })

  it('5. Rounding and remainder integer paise allocation', () => {
    // ₹100 split 3 ways (me + 2 friends)
    const calc = computeFormSplits({
      amountPaise: 10000, // 10,000 paise
      sharingMode: 'shared',
      splitPreset: 'equal_3',
      customMySharePaise: 0,
      participants: [
        { id: 'p1', name: 'Rahul' },
        { id: 'p2', name: 'Priya' },
      ],
    })

    assert.equal(calc.totalPaise, 10000)
    // Friends receive floor(10000/3) = 3333 each -> recoverable = 6666
    assert.equal(calc.splits[0].amountPaise, 3333)
    assert.equal(calc.splits[1].amountPaise, 3333)
    assert.equal(calc.recoverablePaise, 6666)
    // User absorbs remainder (10000 - 6666 = 3334)
    assert.equal(calc.mySharePaise, 3334)
    assert.equal(calc.mySharePaise + calc.recoverablePaise, calc.totalPaise)
  })

  it('6. Duplicate participant prevention in selection', () => {
    const participants = [
      { id: 'p1', name: 'Rahul' },
      { id: 'p1', name: 'Rahul' }, // duplicate id
      { id: 'p2', name: 'rahul' }, // case-insensitive name match
    ]

    const seen = new Set<string>()
    const deduplicated = participants.filter(p => {
      const lower = p.name.trim().toLowerCase()
      if (seen.has(p.id) || seen.has(lower)) return false
      seen.add(p.id)
      seen.add(lower)
      return true
    })

    assert.equal(deduplicated.length, 1)
  })

  it('7. Recoverable amount validation against schema', () => {
    const calc = computeFormSplits({
      amountPaise: 100000,
      sharingMode: 'shared',
      splitPreset: 'equal_2',
      customMySharePaise: 0,
      participants: [{ id: 'p1', name: 'Rahul' }],
    })

    const payload = {
      ...baseTx,
      date: '2026-11-04',
      recoverablePaise: calc.recoverablePaise,
      splits: calc.splits,
      reimbursementStatus: calc.reimbursementStatus,
    }

    const res = TransactionSchema.safeParse(payload)
    assert.equal(res.success, true)

    // Invalid: recoverablePaise > amountPaise
    const invalidPayload = {
      ...payload,
      recoverablePaise: 150000,
    }
    const invalidRes = TransactionSchema.safeParse(invalidPayload)
    assert.equal(invalidRes.success, false)
  })

  it('8. Editing a split while preserving repayment history', () => {

    const existingRepaidMap = new Map([
      ['p1', 20000],
      ['p2', 40000],
    ])
    const existingSettledAtMap = new Map([['p2', dummyTimestamp]])

    // Increase total amount to ₹1,500 (3-way split: 50,000 each)
    const calc = computeFormSplits({
      amountPaise: 150000,
      sharingMode: 'shared',
      splitPreset: 'equal_3',
      customMySharePaise: 0,
      participants: [
        { id: 'p1', name: 'Rahul' },
        { id: 'p2', name: 'Priya' },
      ],
      existingRepaidMap,
      existingSettledAtMap,
    })

    assert.equal(calc.error, null)
    const rahul = calc.splits.find(s => s.personId === 'p1')
    const priya = calc.splits.find(s => s.personId === 'p2')

    // Preserved repayment amounts
    assert.equal(rahul?.repaidPaise, 20000)
    assert.equal(priya?.repaidPaise, 40000)
    // Priya owed 40,000, now owes 50,000 -> not settled yet (40000 < 50000), so settledAt becomes null
    assert.equal(priya?.settledAt, null)
    // Overall status is 'partial'
    assert.equal(calc.reimbursementStatus, 'partial')
  })

  it('9. Preventing a share reduction below the amount already repaid', () => {
    const existingTx: Transaction = {
      ...baseTx,
      amountPaise: 100000,
      recoverablePaise: 50000,
      splits: [
        {
          personId: 'p1',
          personName: 'Rahul',
          amountPaise: 50000,
          repaidPaise: 40000, // ₹400 already repaid
          settledAt: null,
        },
      ],
    }

    // Attempt to reduce bill to ₹300, giving Rahul a share of ₹150 (< ₹400 repaid)
    const reducedCalc = computeFormSplits({
      amountPaise: 30000,
      sharingMode: 'shared',
      splitPreset: 'equal_2',
      customMySharePaise: 0,
      participants: [{ id: 'p1', name: 'Rahul' }],
      existingRepaidMap: new Map([['p1', 40000]]),
    })

    const safety = validateRepaymentSafety(
      existingTx,
      'shared',
      new Set(['p1']),
      reducedCalc.splits
    )

    assert.equal(safety.canSave, false)
    assert.match(safety.conflicts[0], /cannot be less than their already repaid amount/i)

    // Attempting to remove Rahul who already repaid
    const removeSafety = validateRepaymentSafety(
      existingTx,
      'shared',
      new Set([]), // Rahul removed
      []
    )
    assert.equal(removeSafety.canSave, false)
    assert.match(removeSafety.conflicts[0], /Cannot remove "Rahul"/i)

    // Attempting to convert to Personal while repayment exists
    const personalSafety = validateRepaymentSafety(
      existingTx,
      'none',
      new Set([]),
      []
    )
    assert.equal(personalSafety.canSave, false)
    assert.match(personalSafety.conflicts[0], /Cannot convert to Personal expense/i)
  })

  it('10. Legacy reimbursable transaction editing', () => {
    const legacyReimbursableTx: Transaction = {
      ...baseTx,
      amountPaise: 45000, // ₹450
      type: 'reimbursable',
      personId: 'Aarav',
      // No recoverablePaise or splits
    }

    const init = getInitialSharingState(legacyReimbursableTx)
    assert.equal(init.sharingMode, 'fully_recoverable')
    assert.equal(init.initialParticipants.length, 1)
    assert.equal(init.initialParticipants[0].name, 'Aarav')

    const calc = computeFormSplits({
      amountPaise: legacyReimbursableTx.amountPaise,
      sharingMode: init.sharingMode,
      splitPreset: init.splitPreset,
      customMySharePaise: 0,
      participants: init.initialParticipants,
    })

    assert.equal(calc.mySharePaise, 0)
    assert.equal(calc.recoverablePaise, 45000)
    assert.equal(calc.splits[0].amountPaise, 45000)
    assert.equal(calc.splits[0].repaidPaise, 0) // No invented repayment history
    assert.equal(calc.reimbursementStatus, 'pending')
  })

  it('11. Receipt and unrelated metadata preservation during edit', () => {
    const calc = computeFormSplits({
      amountPaise: baseTx.amountPaise,
      sharingMode: 'shared',
      splitPreset: 'equal_2',
      customMySharePaise: 0,
      participants: [{ id: 'p1', name: 'Rahul' }],
    })

    const payload = {
      amountPaise: baseTx.amountPaise,
      description: baseTx.description,
      categoryId: baseTx.categoryId,
      type: baseTx.type,
      date: baseTx.date,
      paymentMode: baseTx.paymentMode,
      paymentAccountId: baseTx.paymentAccountId,
      tripId: baseTx.tripId,
      personId: calc.splits.length === 1 ? calc.splits[0].personId : null,
      tags: baseTx.tags,
      notes: baseTx.notes,
      receiptUrl: baseTx.receiptUrl,
      recoverablePaise: calc.recoverablePaise,
      splits: calc.splits,
      reimbursementStatus: calc.reimbursementStatus,
    }

    // Metadata remains strictly intact
    assert.equal(payload.receiptUrl, 'https://example.com/receipt.jpg')
    assert.deepEqual(payload.tags, ['lunch', 'office'])
    assert.equal(payload.notes, 'Paid via GPay')
    assert.equal(payload.tripId, 'trip-1')
    assert.equal(payload.paymentMode, 'UPI')
    assert.equal(payload.paymentAccountId, 'acc-1')
  })

  it('12. Editing a fully settled participant share upward transitions to partial and clears settledAt', () => {
    // Rahul previously settled his full share of ₹400 (40,000 paise)
    const existingSettledTx: Transaction = {
      ...baseTx,
      amountPaise: 80000, // ₹800 2-way split
      recoverablePaise: 40000,
      reimbursementStatus: 'settled',
      splits: [
        {
          personId: 'p1',
          personName: 'Rahul',
          amountPaise: 40000,
          repaidPaise: 40000,
          settledAt: dummyTimestamp,
        },
      ],
    }

    // Bill increases to ₹1,200 (2-way split: 60,000 paise each)
    const calc = computeFormSplits({
      amountPaise: 120000,
      sharingMode: 'shared',
      splitPreset: 'equal_2',
      customMySharePaise: 0,
      participants: [{ id: 'p1', name: 'Rahul' }],
      existingRepaidMap: new Map([['p1', 40000]]),
      existingSettledAtMap: new Map([['p1', dummyTimestamp]]),
    })

    assert.equal(calc.error, null)
    assert.equal(calc.splits[0].amountPaise, 60000)
    assert.equal(calc.splits[0].repaidPaise, 40000)
    // Since 40000 < 60000, he is no longer settled -> settledAt is cleared
    assert.equal(calc.splits[0].settledAt, null)
    assert.equal(calc.reimbursementStatus, 'partial')

    // Repayment safety allows this upward adjustment
    const safety = validateRepaymentSafety(
      existingSettledTx,
      'shared',
      new Set(['p1']),
      calc.splits
    )
    assert.equal(safety.canSave, true)
    assert.equal(safety.conflicts.length, 0)
  })

  it('13. Switching between Shared and Fully Recoverable with existing repayments', () => {
    // Case A: Shared -> Fully Recoverable (valid: share increases from 50k to 100k, repaid 30k)
    const sharedTx: Transaction = {
      ...baseTx,
      amountPaise: 100000,
      recoverablePaise: 50000,
      reimbursementStatus: 'partial',
      splits: [
        {
          personId: 'p1',
          personName: 'Rahul',
          amountPaise: 50000,
          repaidPaise: 30000,
          settledAt: null,
        },
      ],
    }

    const calcToRecoverable = computeFormSplits({
      amountPaise: 100000,
      sharingMode: 'fully_recoverable',
      splitPreset: 'equal_2',
      customMySharePaise: 0,
      participants: [{ id: 'p1', name: 'Rahul' }],
      existingRepaidMap: new Map([['p1', 30000]]),
    })

    assert.equal(calcToRecoverable.splits[0].amountPaise, 100000)
    assert.equal(calcToRecoverable.splits[0].repaidPaise, 30000)
    assert.equal(calcToRecoverable.mySharePaise, 0)
    assert.equal(calcToRecoverable.reimbursementStatus, 'partial')

    const safetyA = validateRepaymentSafety(
      sharedTx,
      'fully_recoverable',
      new Set(['p1']),
      calcToRecoverable.splits
    )
    assert.equal(safetyA.canSave, true)

    // Case B: Fully Recoverable -> Shared (invalid if new share drops below amount repaid)
    // Rahul paid 80k of 100k. In a 2-way shared split, his new share would be 50k < 80k repaid.
    const fullyRecoverableTx: Transaction = {
      ...baseTx,
      amountPaise: 100000,
      recoverablePaise: 100000,
      reimbursementStatus: 'partial',
      splits: [
        {
          personId: 'p1',
          personName: 'Rahul',
          amountPaise: 100000,
          repaidPaise: 80000,
          settledAt: null,
        },
      ],
    }

    const calcToShared = computeFormSplits({
      amountPaise: 100000,
      sharingMode: 'shared',
      splitPreset: 'equal_2',
      customMySharePaise: 0,
      participants: [{ id: 'p1', name: 'Rahul' }],
      existingRepaidMap: new Map([['p1', 80000]]),
    })

    const safetyB = validateRepaymentSafety(
      fullyRecoverableTx,
      'shared',
      new Set(['p1']),
      calcToShared.splits
    )
    assert.equal(safetyB.canSave, false)
    assert.match(safetyB.conflicts[0], /cannot be less than their already repaid amount/i)
  })

  it('14. Removing participants with zero versus non-zero repayments', () => {
    const multiTx: Transaction = {
      ...baseTx,
      amountPaise: 120000,
      recoverablePaise: 80000,
      reimbursementStatus: 'partial',
      splits: [
        {
          personId: 'p1',
          personName: 'Rahul',
          amountPaise: 40000,
          repaidPaise: 20000, // Non-zero repayment
          settledAt: null,
        },
        {
          personId: 'p2',
          personName: 'Priya',
          amountPaise: 40000,
          repaidPaise: 0, // Zero repayment
          settledAt: null,
        },
      ],
    }

    // Removing Priya (zero repayment) is safe and permitted
    const safetyPriyaRemoved = validateRepaymentSafety(
      multiTx,
      'shared',
      new Set(['p1']), // Priya removed
      [{ personId: 'p1', personName: 'Rahul', amountPaise: 60000, repaidPaise: 20000 }]
    )
    assert.equal(safetyPriyaRemoved.canSave, true)
    assert.equal(safetyPriyaRemoved.conflicts.length, 0)

    // Removing Rahul (has repayment) is blocked
    const safetyRahulRemoved = validateRepaymentSafety(
      multiTx,
      'shared',
      new Set(['p2']), // Rahul removed
      [{ personId: 'p2', personName: 'Priya', amountPaise: 60000, repaidPaise: 0 }]
    )
    assert.equal(safetyRahulRemoved.canSave, false)
    assert.match(safetyRahulRemoved.conflicts[0], /Cannot remove "Rahul"/i)
  })

  it('15. Legacy reimbursable transactions with missing personId fallback cleanly', () => {
    const legacyWithoutPerson: Transaction = {
      ...baseTx,
      amountPaise: 55000,
      type: 'reimbursable',
      personId: null, // missing personId
    }

    const init = getInitialSharingState(legacyWithoutPerson)
    assert.equal(init.sharingMode, 'fully_recoverable')
    assert.equal(init.initialParticipants.length, 1)
    assert.equal(init.initialParticipants[0].id, '__unassigned__')
    assert.equal(init.initialParticipants[0].name, 'Unassigned')

    const calc = computeFormSplits({
      amountPaise: legacyWithoutPerson.amountPaise,
      sharingMode: init.sharingMode,
      splitPreset: 'equal_2',
      customMySharePaise: 0,
      participants: init.initialParticipants,
    })

    assert.equal(calc.mySharePaise, 0)
    assert.equal(calc.recoverablePaise, 55000)
    assert.equal(calc.splits[0].personId, '__unassigned__')
    assert.equal(calc.splits[0].amountPaise, 55000)
    assert.equal(calc.splits[0].repaidPaise, 0)
    assert.equal(calc.reimbursementStatus, 'pending')
  })

  it('16. Zero, negative, and fractional inputs handling', () => {
    // Zero amount
    const zeroCalc = computeFormSplits({
      amountPaise: 0,
      sharingMode: 'shared',
      splitPreset: 'equal_2',
      customMySharePaise: 0,
      participants: [{ id: 'p1', name: 'Rahul' }],
    })
    assert.equal(zeroCalc.totalPaise, 0)
    assert.equal(zeroCalc.mySharePaise, 0)
    assert.equal(zeroCalc.recoverablePaise, 0)

    // Negative amount is clamped to zero
    const negCalc = computeFormSplits({
      amountPaise: -5000,
      sharingMode: 'shared',
      splitPreset: 'equal_2',
      customMySharePaise: 0,
      participants: [{ id: 'p1', name: 'Rahul' }],
    })
    assert.equal(negCalc.totalPaise, 0)
    assert.equal(negCalc.mySharePaise, 0)
    assert.equal(negCalc.recoverablePaise, 0)

    // Fractional paise is rounded to nearest integer paise
    const fracCalc = computeFormSplits({
      amountPaise: 10000.75, // Rounds to 10001
      sharingMode: 'shared',
      splitPreset: 'equal_2',
      customMySharePaise: 0,
      participants: [{ id: 'p1', name: 'Rahul' }],
    })
    assert.equal(fracCalc.totalPaise, 10001)
    // 10001 / 2 = 5000 for friend, user absorbs 1-paise remainder = 5001
    assert.equal(fracCalc.splits[0].amountPaise, 5000)
    assert.equal(fracCalc.mySharePaise, 5001)
    assert.equal(fracCalc.mySharePaise + fracCalc.recoverablePaise, 10001)

    // Custom share exceeding gross bill returns clear error
    const overCalc = computeFormSplits({
      amountPaise: 10000,
      sharingMode: 'shared',
      splitPreset: 'custom_my_share',
      customMySharePaise: 15000, // exceeds total
      participants: [{ id: 'p1', name: 'Rahul' }],
    })
    assert.match(overCalc.error || '', /cannot exceed the total bill amount/i)
  })

  it('17. Custom allocation rounding distributes remainder evenly across multiple participants', () => {
    // Bill = 10,000 paise. User share = 1,001 paise.
    // Target recoverable = 8,999 paise across 3 participants.
    // Base share = 2999 paise. Remainder = 8999 % 3 = 2 paise.
    // First 2 participants get 3000 paise each; 3rd gets 2999 paise.
    const calc = computeFormSplits({
      amountPaise: 10000,
      sharingMode: 'shared',
      splitPreset: 'custom_my_share',
      customMySharePaise: 1001,
      participants: [
        { id: 'p1', name: 'Rahul' },
        { id: 'p2', name: 'Priya' },
        { id: 'p3', name: 'Amit' },
      ],
    })

    assert.equal(calc.error, null)
    assert.equal(calc.mySharePaise, 1001)
    assert.equal(calc.recoverablePaise, 8999)
    assert.deepEqual(
      calc.splits.map(s => s.amountPaise),
      [3000, 3000, 2999]
    )
    assert.equal(
      calc.mySharePaise + calc.splits.reduce((sum, s) => sum + s.amountPaise, 0),
      10000
    )
  })

  it('18. Repeated mode and preset switching preserves mathematical consistency', () => {
    const participants = [
      { id: 'p1', name: 'Rahul' },
      { id: 'p2', name: 'Priya' },
    ]

    // Step 1: Personal mode
    const s1 = computeFormSplits({
      amountPaise: 90000,
      sharingMode: 'none',
      splitPreset: 'equal_3',
      customMySharePaise: 0,
      participants: [],
    })
    assert.equal(s1.mySharePaise, 90000)
    assert.equal(s1.recoverablePaise, 0)

    // Step 2: Switch to Shared (÷3 preset)
    const s2 = computeFormSplits({
      amountPaise: 90000,
      sharingMode: 'shared',
      splitPreset: 'equal_3',
      customMySharePaise: 0,
      participants,
    })
    assert.equal(s2.mySharePaise, 30000)
    assert.equal(s2.recoverablePaise, 60000)

    // Step 3: Switch to Fully Recoverable
    const s3 = computeFormSplits({
      amountPaise: 90000,
      sharingMode: 'fully_recoverable',
      splitPreset: 'equal_3',
      customMySharePaise: 0,
      participants,
    })
    assert.equal(s3.mySharePaise, 0)
    assert.equal(s3.recoverablePaise, 90000)
    assert.equal(s3.splits[0].amountPaise, 45000)
    assert.equal(s3.splits[1].amountPaise, 45000)

    // Step 4: Switch to Custom My Share (₹100 my share)
    const s4 = computeFormSplits({
      amountPaise: 90000,
      sharingMode: 'shared',
      splitPreset: 'custom_my_share',
      customMySharePaise: 10000,
      participants,
    })
    assert.equal(s4.mySharePaise, 10000)
    assert.equal(s4.recoverablePaise, 80000)
    assert.equal(s4.splits[0].amountPaise, 40000)
    assert.equal(s4.splits[1].amountPaise, 40000)

    // Step 5: Switch back to Personal
    const s5 = computeFormSplits({
      amountPaise: 90000,
      sharingMode: 'none',
      splitPreset: 'equal_3',
      customMySharePaise: 10000,
      participants: [],
    })
    assert.equal(s5.mySharePaise, 90000)
    assert.equal(s5.recoverablePaise, 0)
    assert.deepEqual(s5.splits, [])
  })

  it('19. getRecommendedPreset adapts dynamically to selected friends count', () => {
    // 0 or 1 friend: 2 people total (User + Friend) -> equal_2
    assert.equal(getRecommendedPreset(0), 'equal_2')
    assert.equal(getRecommendedPreset(1), 'equal_2')

    // 2 friends: 3 people total (User + 2 Friends) -> equal_3
    assert.equal(getRecommendedPreset(2), 'equal_3')

    // 3 friends: 4 people total (User + 3 Friends) -> equal_4
    assert.equal(getRecommendedPreset(3), 'equal_4')

    // 4 or more friends: equal_all
    assert.equal(getRecommendedPreset(4), 'equal_all')
    assert.equal(getRecommendedPreset(7), 'equal_all')
  })
})
