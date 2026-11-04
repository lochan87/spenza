import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getRecoverablePaise,
  getNetSpendPaise,
  getRepaidPaise,
  getPendingRecoverablePaise,
  getReimbursementStatus,
  getNormalizedSplits,
  isSplitOrRecoverable,
} from '../../../utils/splitMath.ts'
import { formatTxAmount } from '../../../utils/format.ts'
import type { Transaction } from '../../../types/index.ts'

describe('TransactionsPage — Shared Expense & Recoverable Display Logic', () => {
  const dummyDate = { seconds: 1772000000, nanoseconds: 0 } as any

  const personalTx: Transaction = {
    id: 'tx-1',
    amountPaise: 25000, // ₹250
    description: 'Groceries at Blinkit',
    categoryId: 'cat-groceries',
    type: 'everyday',
    date: dummyDate,
    paymentMode: 'UPI',
    paymentAccountId: 'acc-1',
    tripId: null,
    personId: null,
    tags: [],
    notes: 'Weekly milk and eggs',
    receiptUrl: null,
    createdAt: dummyDate,
    updatedAt: dummyDate,
  }

  const sharedTx: Transaction = {
    id: 'tx-2',
    amountPaise: 300000, // ₹3,000 gross
    description: 'Dinner at Fisherman’s Wharf',
    categoryId: 'cat-food',
    type: 'everyday',
    date: dummyDate,
    paymentMode: 'UPI',
    paymentAccountId: 'acc-1',
    tripId: 'trip-1',
    personId: null,
    tags: [],
    notes: 'Group dinner',
    receiptUrl: 'https://example.com/receipt.jpg',
    recoverablePaise: 200000, // ₹2,000 recoverable from 2 friends
    splits: [
      {
        personId: 'p-aarav',
        personName: 'Aarav',
        amountPaise: 100000,
        repaidPaise: 0,
        settledAt: null,
      },
      {
        personId: 'p-meera',
        personName: 'Meera',
        amountPaise: 100000,
        repaidPaise: 0,
        settledAt: null,
      },
    ],
    reimbursementStatus: 'pending',
    createdAt: dummyDate,
    updatedAt: dummyDate,
  }

  const fullyRecoverableTx: Transaction = {
    id: 'tx-3',
    amountPaise: 50000, // ₹500 fronted for Kabir
    description: 'Concert ticket for Kabir',
    categoryId: 'cat-ent',
    type: 'everyday',
    date: dummyDate,
    paymentMode: 'Card',
    paymentAccountId: 'acc-2',
    tripId: null,
    personId: 'p-kabir',
    tags: [],
    notes: '',
    receiptUrl: null,
    recoverablePaise: 50000,
    splits: [
      {
        personId: 'p-kabir',
        personName: 'Kabir',
        amountPaise: 50000,
        repaidPaise: 0,
        settledAt: null,
      },
    ],
    reimbursementStatus: 'pending',
    createdAt: dummyDate,
    updatedAt: dummyDate,
  }

  const legacyReimbursableNamed: Transaction = {
    id: 'tx-4',
    amountPaise: 120000, // ₹1,200
    description: 'Office cab ride',
    categoryId: 'cat-travel',
    type: 'reimbursable',
    date: dummyDate,
    paymentMode: 'UPI',
    paymentAccountId: null,
    tripId: null,
    personId: 'Rohan (HR)',
    tags: [],
    notes: '',
    receiptUrl: null,
    createdAt: dummyDate,
    updatedAt: dummyDate,
  }

  const legacyReimbursableUnassigned: Transaction = {
    id: 'tx-5',
    amountPaise: 80000, // ₹800
    description: 'Client coffee',
    categoryId: 'cat-food',
    type: 'reimbursable',
    date: dummyDate,
    paymentMode: 'Cash',
    paymentAccountId: null,
    tripId: null,
    personId: null,
    tags: [],
    notes: '',
    receiptUrl: null,
    createdAt: dummyDate,
    updatedAt: dummyDate,
  }

  it('1. formats transaction amount cleanly with integer or exact decimals', () => {
    assert.equal(formatTxAmount(25000), '₹250')
    assert.equal(formatTxAmount(45197), '₹451.97')
    assert.equal(formatTxAmount(0), '₹0')
  })

  it('2. displays personal transactions with identical gross and net amounts', () => {
    assert.equal(isSplitOrRecoverable(personalTx), false)
    assert.equal(getRecoverablePaise(personalTx), 0)
    assert.equal(getNetSpendPaise(personalTx), 25000)
    assert.equal(getRepaidPaise(personalTx), 0)
    assert.equal(getPendingRecoverablePaise(personalTx), 0)
    assert.equal(getReimbursementStatus(personalTx), 'none')
    assert.deepEqual(getNormalizedSplits(personalTx), [])
  })

  it('3. derives net personal spend, recoverable amount, and pending status for shared transactions', () => {
    assert.equal(isSplitOrRecoverable(sharedTx), true)
    assert.equal(sharedTx.amountPaise, 300000) // Gross ₹3,000
    assert.equal(getNetSpendPaise(sharedTx), 100000) // Net personal share ₹1,000
    assert.equal(getRecoverablePaise(sharedTx), 200000) // Recoverable ₹2,000
    assert.equal(getRepaidPaise(sharedTx), 0)
    assert.equal(getPendingRecoverablePaise(sharedTx), 200000)
    assert.equal(getReimbursementStatus(sharedTx), 'pending')

    const splits = getNormalizedSplits(sharedTx)
    assert.equal(splits.length, 2)
    assert.equal(splits[0].personName, 'Aarav')
    assert.equal(splits[0].amountPaise, 100000)
    assert.equal(splits[1].personName, 'Meera')
    assert.equal(splits[1].amountPaise, 100000)
  })

  it('4. displays partial repayment amounts and remaining outstanding balances accurately', () => {
    const partiallyRepaidTx: Transaction = {
      ...sharedTx,
      splits: [
        {
          personId: 'p-aarav',
          personName: 'Aarav',
          amountPaise: 100000,
          repaidPaise: 40000, // ₹400 repaid
          settledAt: null,
        },
        {
          personId: 'p-meera',
          personName: 'Meera',
          amountPaise: 100000,
          repaidPaise: 0,
          settledAt: null,
        },
      ],
      reimbursementStatus: 'partial',
    }

    assert.equal(getRepaidPaise(partiallyRepaidTx), 40000) // ₹400 repaid
    assert.equal(getPendingRecoverablePaise(partiallyRepaidTx), 160000) // ₹1,600 still due
    assert.equal(getReimbursementStatus(partiallyRepaidTx), 'partial')
    // Gross and Net Spend remain completely invariant
    assert.equal(partiallyRepaidTx.amountPaise, 300000)
    assert.equal(getNetSpendPaise(partiallyRepaidTx), 100000)
  })

  it('5. displays fully settled status when all participants have repaid their shares', () => {
    const settledTx: Transaction = {
      ...sharedTx,
      splits: [
        {
          personId: 'p-aarav',
          personName: 'Aarav',
          amountPaise: 100000,
          repaidPaise: 100000,
          settledAt: dummyDate,
        },
        {
          personId: 'p-meera',
          personName: 'Meera',
          amountPaise: 100000,
          repaidPaise: 100000,
          settledAt: dummyDate,
        },
      ],
      reimbursementStatus: 'settled',
    }

    assert.equal(getRepaidPaise(settledTx), 200000)
    assert.equal(getPendingRecoverablePaise(settledTx), 0)
    assert.equal(getReimbursementStatus(settledTx), 'settled')
    assert.equal(getNetSpendPaise(settledTx), 100000)
  })

  it('6. displays 100% recoverable transactions with net personal share equal to zero', () => {
    assert.equal(isSplitOrRecoverable(fullyRecoverableTx), true)
    assert.equal(fullyRecoverableTx.amountPaise, 50000)
    assert.equal(getNetSpendPaise(fullyRecoverableTx), 0) // Net ₹0
    assert.equal(getRecoverablePaise(fullyRecoverableTx), 50000)
    assert.equal(getPendingRecoverablePaise(fullyRecoverableTx), 50000)
  })

  it('7. safely handles legacy type="reimbursable" transactions with and without personId', () => {
    // Named legacy reimbursable
    assert.equal(isSplitOrRecoverable(legacyReimbursableNamed), true)
    assert.equal(getNetSpendPaise(legacyReimbursableNamed), 0)
    assert.equal(getRecoverablePaise(legacyReimbursableNamed), 120000)
    const namedSplits = getNormalizedSplits(legacyReimbursableNamed)
    assert.equal(namedSplits.length, 1)
    assert.equal(namedSplits[0].personName, 'Rohan (HR)')
    assert.equal(namedSplits[0].amountPaise, 120000)

    // Unassigned legacy reimbursable
    assert.equal(isSplitOrRecoverable(legacyReimbursableUnassigned), true)
    assert.equal(getNetSpendPaise(legacyReimbursableUnassigned), 0)
    assert.equal(getRecoverablePaise(legacyReimbursableUnassigned), 80000)
    const unassignedSplits = getNormalizedSplits(legacyReimbursableUnassigned)
    assert.equal(unassignedSplits.length, 1)
    assert.equal(unassignedSplits[0].personName, 'Unassigned')
    assert.equal(unassignedSplits[0].amountPaise, 80000)
  })

  it('8. searches participant names in splits', () => {
    const list = [personalTx, sharedTx, fullyRecoverableTx]
    const q = 'aarav'

    const matches = list.filter(tx => {
      const desc = (tx.description ?? '').toLowerCase()
      const person = (tx.personId ?? '').toLowerCase()
      const splitPeople = (tx.splits ?? []).map(s => s.personName).join(' ').toLowerCase()
      return desc.includes(q) || person.includes(q) || splitPeople.includes(q)
    })

    assert.equal(matches.length, 1)
    assert.equal(matches[0].id, 'tx-2') // Fisherman's Wharf dinner
  })
})
