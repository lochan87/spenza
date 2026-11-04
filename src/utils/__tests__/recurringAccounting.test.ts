import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateNormalizedMonthlyCommitmentPaise,
  calculateRecurringTransactionsNetSpend,
  calculateRecurringTransactionsGrossOutflow,
  calculateRecurringRecoverablesSummary,
} from '../recurringMath.ts'
import type { RecurringItem, Transaction } from '../../types/index.ts'

describe('recurringMath — Recurring Commitments, Net Spending & Recoverables Ledger', () => {
  const dummyDate = (isoStr: string) => ({
    toDate: () => new Date(isoStr),
    seconds: Math.floor(new Date(isoStr).getTime() / 1000),
    nanoseconds: 0,
  }) as any

  function createRecurringItem(overrides: Partial<RecurringItem> = {}): RecurringItem {
    return {
      id: 'rec-' + Math.random().toString(36).substring(2, 9),
      description: 'Subscription',
      amountPaise: 64900, // ₹649
      categoryId: 'cat-subs',
      frequency: 'monthly',
      dayOfMonth: 15,
      dayOfWeek: null,
      monthDay: null,
      nextDueDate: dummyDate('2026-11-15T12:00:00.000Z'),
      lastGeneratedDate: null,
      paymentMode: 'Card',
      paymentAccountId: 'acc-card',
      isActive: true,
      createdAt: dummyDate('2026-10-01T12:00:00.000Z'),
      updatedAt: dummyDate('2026-10-01T12:00:00.000Z'),
      ...overrides,
    }
  }

  function createTx(overrides: Partial<Transaction> = {}): Transaction {
    return {
      id: 'tx-' + Math.random().toString(36).substring(2, 9),
      amountPaise: 64900,
      description: 'Netflix Subscription',
      categoryId: 'cat-subs',
      type: 'recurring',
      date: dummyDate('2026-11-15T12:00:00.000Z'),
      paymentMode: 'Card',
      paymentAccountId: 'acc-card',
      tripId: null,
      personId: null,
      tags: [],
      notes: '',
      receiptUrl: null,
      createdAt: dummyDate('2026-11-15T12:00:00.000Z'),
      updatedAt: dummyDate('2026-11-15T12:00:00.000Z'),
      ...overrides,
    }
  }

  it('1. calculates normalized monthly commitment across active frequencies and excludes paused items', () => {
    const items: RecurringItem[] = [
      // Monthly: ₹649 (64,900 paise)
      createRecurringItem({ amountPaise: 64900, frequency: 'monthly', isActive: true }),
      // Weekly: ₹500 (50,000 paise) -> (50000 * 52) / 12 = 216667 paise
      createRecurringItem({ amountPaise: 50000, frequency: 'weekly', isActive: true }),
      // Yearly: ₹1,499 (149,900 paise) -> 149900 / 12 = 12492 paise
      createRecurringItem({ amountPaise: 149900, frequency: 'yearly', isActive: true }),
      // Paused / Inactive: ₹2,000 monthly gym membership (should be excluded)
      createRecurringItem({ amountPaise: 200000, frequency: 'monthly', isActive: false }),
    ]

    const expectedTotal = 64900 + Math.round((50000 * 52) / 12) + Math.round(149900 / 12)
    const commitment = calculateNormalizedMonthlyCommitmentPaise(items)

    assert.equal(commitment, expectedTotal)
    assert.equal(calculateNormalizedMonthlyCommitmentPaise([]), 0)
  })

  it('2. isolates user net share on personal and shared recurring transactions', () => {
    const txns: Transaction[] = [
      // Personal recurring: Phone bill ₹499
      createTx({
        amountPaise: 49900,
        description: 'Jio Prepaid Fiber',
      }),
      // Shared recurring: Wi-Fi bill ₹1,179 split with 2 flatmates (User ₹393, Flatmates ₹786)
      createTx({
        amountPaise: 117900,
        description: 'Airtel Xstream Wi-Fi',
        recoverablePaise: 78600,
        reimbursementStatus: 'pending',
        splits: [
          { personId: 'p-1', personName: 'Alex', amountPaise: 39300, repaidPaise: 0 },
          { personId: 'p-2', personName: 'Ben', amountPaise: 39300, repaidPaise: 0 },
        ],
      }),
      // Non-recurring transaction (should be ignored by recurring calculations)
      createTx({
        type: 'everyday',
        amountPaise: 25000,
        description: 'Groceries',
      }),
    ]

    const netSpend = calculateRecurringTransactionsNetSpend(txns)
    const grossOutflow = calculateRecurringTransactionsGrossOutflow(txns)
    const recoverables = calculateRecurringRecoverablesSummary(txns)

    // User personal spend: ₹499 + ₹393 = ₹892 (89,200 paise)
    assert.equal(netSpend, 49900 + 39300)
    // Bank outflow: ₹499 + ₹1,179 = ₹1,678 (167,800 paise)
    assert.equal(grossOutflow, 49900 + 117900)
    // Recoverables owed by flatmates: ₹786 (78,600 paise)
    assert.equal(recoverables.recoverablePaise, 78600)
    assert.equal(recoverables.pendingPaise, 78600)
    assert.equal(recoverables.repaidPaise, 0)
  })

  it('3. handles 100% recoverable recurring expense fronted on behalf of others', () => {
    // User pays team Zoom or Figma subscription of ₹3,000 on personal card, 100% reimbursed
    const txns: Transaction[] = [
      createTx({
        amountPaise: 300000,
        description: 'Team Zoom Subscription',
        recoverablePaise: 300000,
        reimbursementStatus: 'pending',
        splits: [
          { personId: 'p-corp', personName: 'Office Finance', amountPaise: 300000, repaidPaise: 0 },
        ],
      }),
    ]

    const netSpend = calculateRecurringTransactionsNetSpend(txns)
    const grossOutflow = calculateRecurringTransactionsGrossOutflow(txns)
    const recoverables = calculateRecurringRecoverablesSummary(txns)

    assert.equal(netSpend, 0) // Zero personal spend
    assert.equal(grossOutflow, 300000) // ₹3,000 actual bank outflow
    assert.equal(recoverables.recoverablePaise, 300000)
    assert.equal(recoverables.pendingPaise, 300000)
  })

  it('4. guarantees repayments on recurring bills reduce pending dues without altering net spend or gross outflow', () => {
    // Wi-Fi bill ₹1,179, Alex repays ₹393
    const txns: Transaction[] = [
      createTx({
        amountPaise: 117900,
        description: 'Airtel Xstream Wi-Fi',
        recoverablePaise: 78600,
        reimbursementStatus: 'partial',
        splits: [
          { personId: 'p-1', personName: 'Alex', amountPaise: 39300, repaidPaise: 39300 },
          { personId: 'p-2', personName: 'Ben', amountPaise: 39300, repaidPaise: 0 },
        ],
      }),
    ]

    const netSpend = calculateRecurringTransactionsNetSpend(txns)
    const grossOutflow = calculateRecurringTransactionsGrossOutflow(txns)
    const recoverables = calculateRecurringRecoverablesSummary(txns)

    // Financial invariant checks:
    assert.equal(grossOutflow, 117900)
    assert.equal(netSpend, 39300) // User share never shifts when repayments arrive
    assert.equal(recoverables.recoverablePaise, 78600)
    assert.equal(recoverables.repaidPaise, 39300)
    assert.equal(recoverables.pendingPaise, 39300)
  })

  it('5. handles legacy reimbursable recurring transactions cleanly', () => {
    // If a recurring transaction was created with legacy personId or recoverable amount:
    const recurringWithLegacyPerson: Transaction[] = [
      createTx({
        type: 'recurring',
        amountPaise: 80000,
        description: 'Office internet',
        recoverablePaise: 80000,
        personId: 'p-legacy-corp',
        splits: undefined,
      }),
    ]

    const netSpend = calculateRecurringTransactionsNetSpend(recurringWithLegacyPerson)
    const grossOutflow = calculateRecurringTransactionsGrossOutflow(recurringWithLegacyPerson)
    const recoverables = calculateRecurringRecoverablesSummary(recurringWithLegacyPerson)

    assert.equal(netSpend, 0)
    assert.equal(grossOutflow, 80000)
    assert.equal(recoverables.recoverablePaise, 80000)
    assert.equal(recoverables.pendingPaise, 80000)
  })
})
