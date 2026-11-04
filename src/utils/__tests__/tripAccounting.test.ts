import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  calculateTripNetSpend,
  calculateTripGrossOutflow,
  calculateTripRecoverables,
  calculateTripBucketTotals,
  calculateTripDayTotals,
  calculateTripAccountingSummary,
} from '../tripBuckets.ts'
import type { Category, Transaction, Trip } from '../../types/index.ts'

describe('tripBuckets — Trip Net Spending, Recoverables & Accounting Summary', () => {
  const dummyDate = (isoStr: string) => ({
    toDate: () => new Date(isoStr),
    seconds: Math.floor(new Date(isoStr).getTime() / 1000),
    nanoseconds: 0,
  }) as any

  const mockCategories: Category[] = [
    { id: 'cat-flights', name: 'Flights', color: '#2196f3', icon: 'plane', isArchived: false },
    { id: 'cat-hotel', name: 'Hotel & Stay', color: '#ff9800', icon: 'hotel', isArchived: false },
    { id: 'cat-dining', name: 'Dining Out', color: '#4caf50', icon: 'utensils', isArchived: false },
    { id: 'cat-activities', name: 'Activities & Sightseeing', color: '#9c27b0', icon: 'ticket', isArchived: false },
    { id: 'cat-cabs', name: 'Local Transport', color: '#00bcd4', icon: 'car', isArchived: false },
    { id: 'cat-misc', name: 'General Shopping', color: '#607d8b', icon: 'shopping-bag', isArchived: false },
  ]

  const mockTrip: Trip = {
    id: 'trip-goa-2026',
    name: 'Goa Friends Trip',
    startDate: dummyDate('2026-11-01T12:00:00.000Z'),
    endDate: dummyDate('2026-11-05T12:00:00.000Z'), // 5 days
    budgetPaise: 4000000, // ₹40,000 budget
    coverColor: '#00bcd4',
    coverEmoji: '🌴',
    notes: '',
    isArchived: false,
    createdAt: dummyDate('2026-10-15T12:00:00.000Z'),
    updatedAt: dummyDate('2026-10-15T12:00:00.000Z'),
  }

  function createTx(overrides: Partial<Transaction> = {}): Transaction {
    return {
      id: 'tx-' + Math.random().toString(36).substring(2, 9),
      amountPaise: 500000, // ₹5,000
      description: 'Trip Expense',
      categoryId: 'cat-dining',
      type: 'trip',
      date: dummyDate('2026-11-02T12:00:00.000Z'),
      paymentMode: 'UPI',
      paymentAccountId: 'acc-1',
      tripId: 'trip-goa-2026',
      personId: null,
      tags: [],
      notes: '',
      receiptUrl: null,
      createdAt: dummyDate('2026-11-02T12:00:00.000Z'),
      updatedAt: dummyDate('2026-11-02T12:00:00.000Z'),
      ...overrides,
    }
  }

  it('1. Personal expenses: net spend equals gross outflow and counts towards trip buckets', () => {
    const txns: Transaction[] = [
      createTx({
        categoryId: 'cat-flights',
        amountPaise: 1200000, // ₹12,000 flights
        date: dummyDate('2026-11-01T12:00:00.000Z'),
      }),
      createTx({
        categoryId: 'cat-dining',
        amountPaise: 300000, // ₹3,000 food
        date: dummyDate('2026-11-02T12:00:00.000Z'),
      }),
    ]

    const netSpend = calculateTripNetSpend(txns)
    const grossOutflow = calculateTripGrossOutflow(txns)
    const recoverables = calculateTripRecoverables(txns)
    const summary = calculateTripAccountingSummary(mockTrip, txns, mockCategories)

    assert.equal(netSpend, 1500000)
    assert.equal(grossOutflow, 1500000)
    assert.equal(recoverables.recoverablePaise, 0)
    assert.equal(recoverables.pendingPaise, 0)
    assert.equal(summary.totalNetSpendPaise, 1500000)
    assert.equal(summary.totalGrossOutflowPaise, 1500000)
    assert.equal(summary.budgetPct, (1500000 / 4000000) * 100)
    assert.equal(summary.isOverBudget, false)
    assert.equal(summary.days, 5)
    assert.equal(summary.avgPerDayPaise, 300000) // ₹3,000/day

    // Buckets
    const directBuckets = calculateTripBucketTotals(txns, mockCategories)
    assert.equal(directBuckets.get('Transport'), 1200000)
    assert.equal(directBuckets.get('Food'), 300000)

    const buckets = summary.bucketTotals
    assert.equal(buckets.get('Transport'), 1200000)
    assert.equal(buckets.get('Food'), 300000)
  })

  it('2. Fully recoverable trip expense: consumes ₹0 of trip budget and ₹0 in buckets', () => {
    // User fronted ₹50,000 for a luxury villa or company booking, 100% owed back
    const txns: Transaction[] = [
      createTx({
        categoryId: 'cat-hotel',
        amountPaise: 5000000, // ₹50,000
        recoverablePaise: 5000000,
        reimbursementStatus: 'pending',
        splits: [
          { personId: 'p-1', personName: 'Alice', amountPaise: 2500000, repaidPaise: 0 },
          { personId: 'p-2', personName: 'Bob', amountPaise: 2500000, repaidPaise: 0 },
        ],
      }),
    ]

    const summary = calculateTripAccountingSummary(mockTrip, txns, mockCategories)

    assert.equal(summary.totalGrossOutflowPaise, 5000000) // paid ₹50,000
    assert.equal(summary.totalNetSpendPaise, 0) // ₹0 personal spend
    assert.equal(summary.recoverablePaise, 5000000)
    assert.equal(summary.pendingPaise, 5000000)
    assert.equal(summary.repaidPaise, 0)
    assert.equal(summary.budgetPct, 0) // Should not consume any budget
    assert.equal(summary.isOverBudget, false)

    // Buckets should ignore ₹0 net spend
    assert.equal(summary.bucketTotals.get('Stay') ?? 0, 0)
  })

  it('3. Shared trip expense: only the personal share consumes budget and buckets', () => {
    // Villa total: ₹40,000. 4 participants (User, Alice, Bob, Charlie) -> ₹10,000 each
    const txns: Transaction[] = [
      createTx({
        categoryId: 'cat-hotel',
        amountPaise: 4000000, // ₹40,000 gross
        recoverablePaise: 3000000, // ₹30,000 owed by 3 friends
        reimbursementStatus: 'pending',
        splits: [
          { personId: 'p-1', personName: 'Alice', amountPaise: 1000000, repaidPaise: 0 },
          { personId: 'p-2', personName: 'Bob', amountPaise: 1000000, repaidPaise: 0 },
          { personId: 'p-3', personName: 'Charlie', amountPaise: 1000000, repaidPaise: 0 },
        ],
      }),
    ]

    const summary = calculateTripAccountingSummary(mockTrip, txns, mockCategories)

    assert.equal(summary.totalGrossOutflowPaise, 4000000)
    assert.equal(summary.totalNetSpendPaise, 1000000) // ₹10,000 net personal spend
    assert.equal(summary.recoverablePaise, 3000000)
    assert.equal(summary.pendingPaise, 3000000)
    assert.equal(summary.budgetPct, (1000000 / 4000000) * 100) // 25% of budget used
    assert.equal(summary.isOverBudget, false)

    // Stay bucket should reflect only user's net personal share (₹10,000)
    assert.equal(summary.bucketTotals.get('Stay'), 1000000)
  })

  it('4. Repayments reduce pending dues but NEVER alter net personal spend or double count', () => {
    // Alice repays ₹10,000 and Bob repays ₹5,000
    const txns: Transaction[] = [
      createTx({
        categoryId: 'cat-hotel',
        amountPaise: 4000000,
        recoverablePaise: 3000000,
        reimbursementStatus: 'partial',
        splits: [
          { personId: 'p-1', personName: 'Alice', amountPaise: 1000000, repaidPaise: 1000000 },
          { personId: 'p-2', personName: 'Bob', amountPaise: 1000000, repaidPaise: 500000 },
          { personId: 'p-3', personName: 'Charlie', amountPaise: 1000000, repaidPaise: 0 },
        ],
      }),
    ]

    const summary = calculateTripAccountingSummary(mockTrip, txns, mockCategories)

    // Financial invariant checks:
    // Outflow: ₹40,000
    assert.equal(summary.totalGrossOutflowPaise, 4000000)
    // Net spend: still exactly ₹10,000 (repayments don't reduce spending or inflate income)
    assert.equal(summary.totalNetSpendPaise, 1000000)
    // Recoverables: ₹30,000 total fronted
    assert.equal(summary.recoverablePaise, 3000000)
    // Repaid: ₹15,000
    assert.equal(summary.repaidPaise, 1500000)
    // Pending: ₹15,000
    assert.equal(summary.pendingPaise, 1500000)
    // Budget & bucket remain invariant
    assert.equal(summary.bucketTotals.get('Stay'), 1000000)
    assert.equal(summary.budgetPct, 25)
  })

  it('5. Day-by-day trip spending aggregates net spend per calendar day', () => {
    const startDate = new Date('2026-11-01T12:00:00.000Z')
    const endDate = new Date('2026-11-03T12:00:00.000Z') // 3 days: D1, D2, D3

    const txns: Transaction[] = [
      // Day 1: Flight ₹10,000 (Personal)
      createTx({
        amountPaise: 1000000,
        date: dummyDate('2026-11-01T12:00:00.000Z'),
      }),
      // Day 2: Dinner ₹6,000 split 50-50 -> Net ₹3,000
      createTx({
        amountPaise: 600000,
        recoverablePaise: 300000,
        reimbursementStatus: 'pending',
        splits: [
          { personId: 'p-1', personName: 'Alice', amountPaise: 300000, repaidPaise: 0 },
        ],
        date: dummyDate('2026-11-02T12:00:00.000Z'),
      }),
      // Day 2: Fully recoverable cab ₹2,000 -> Net ₹0
      createTx({
        amountPaise: 200000,
        recoverablePaise: 200000,
        reimbursementStatus: 'pending',
        splits: [
          { personId: 'p-1', personName: 'Alice', amountPaise: 200000, repaidPaise: 0 },
        ],
        date: dummyDate('2026-11-02T14:00:00.000Z'),
      }),
      // Day 3: Activities ₹4,000 (Personal)
      createTx({
        amountPaise: 400000,
        date: dummyDate('2026-11-03T12:00:00.000Z'),
      }),
    ]

    const dayTotals = calculateTripDayTotals(txns, startDate, endDate)

    assert.equal(dayTotals.length, 3)
    assert.equal(dayTotals[0].label, 'D1')
    assert.equal(dayTotals[0].totalPaise, 1000000) // ₹10,000

    assert.equal(dayTotals[1].label, 'D2')
    assert.equal(dayTotals[1].totalPaise, 300000) // ₹3,000 net (₹6,000/2 + ₹0)

    assert.equal(dayTotals[2].label, 'D3')
    assert.equal(dayTotals[2].totalPaise, 400000) // ₹4,000
  })

  it('6. Over-budget detection and budget percentage', () => {
    const lowBudgetTrip: Trip = {
      ...mockTrip,
      budgetPaise: 1000000, // ₹10,000 budget
    }

    const txns: Transaction[] = [
      createTx({ amountPaise: 800000 }), // ₹8,000 net
      createTx({ amountPaise: 500000 }), // ₹5,000 net
    ]

    const summary = calculateTripAccountingSummary(lowBudgetTrip, txns, mockCategories)

    assert.equal(summary.totalNetSpendPaise, 1300000) // ₹13,000
    assert.equal(summary.budgetPct, 130) // 130%
    assert.equal(summary.isOverBudget, true)
  })

  it('7. Handles empty trip transactions gracefully without errors', () => {
    const summary = calculateTripAccountingSummary(mockTrip, [], mockCategories)

    assert.equal(summary.totalNetSpendPaise, 0)
    assert.equal(summary.totalGrossOutflowPaise, 0)
    assert.equal(summary.recoverablePaise, 0)
    assert.equal(summary.repaidPaise, 0)
    assert.equal(summary.pendingPaise, 0)
    assert.equal(summary.avgPerDayPaise, 0)
    assert.equal(summary.budgetPct, 0)
    assert.equal(summary.isOverBudget, false)
    assert.equal(summary.bucketTotals.size, 0)
  })

  it('8. Handles legacy reimbursable transactions inside trips', () => {
    // In legacy schema: type === 'reimbursable' treated 100% as recoverable
    const txns: Transaction[] = [
      createTx({
        type: 'reimbursable',
        amountPaise: 1500000, // ₹15,000
        recoverablePaise: undefined,
        splits: undefined,
      }),
    ]

    const summary = calculateTripAccountingSummary(mockTrip, txns, mockCategories)

    assert.equal(summary.totalGrossOutflowPaise, 1500000)
    assert.equal(summary.totalNetSpendPaise, 0) // Net spend is 0 for legacy reimbursable
    assert.equal(summary.recoverablePaise, 1500000)
    assert.equal(summary.pendingPaise, 1500000)
  })
})
