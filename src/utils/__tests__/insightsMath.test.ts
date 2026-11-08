import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { subMonths } from 'date-fns'
import {
  deriveInsightsData,
  calculateSpendingPace,
  getInsightsDate,
} from '../insightsMath.ts'
import type { Category, Transaction } from '../../types/index.ts'

describe('insightsMath — Net Spending Analytics, Trends & Pacing Invariants', () => {
  const dummyNow = new Date('2026-11-15T12:00:00Z')
  const lastMonthDate = subMonths(dummyNow, 1)

  const mockCategories: Category[] = [
    { id: 'cat-food', name: 'Food & Dining', color: '#ff5722', icon: 'utensils', isArchived: false },
    { id: 'cat-travel', name: 'Travel', color: '#2196f3', icon: 'plane', isArchived: false },
    { id: 'cat-bills', name: 'Bills & Utilities', color: '#ff9800', icon: 'receipt', isArchived: false },
  ]

  function createTx(overrides: Partial<Transaction> = {}): Transaction {
    return {
      id: 'tx-' + Math.random().toString(36).substring(2, 9),
      amountPaise: 100000, // ₹1,000
      description: 'Test expense',
      categoryId: 'cat-food',
      type: 'everyday',
      date: dummyNow as any,
      paymentMode: 'UPI',
      paymentAccountId: 'acc-1',
      tripId: null,
      personId: null,
      tags: [],
      notes: '',
      receiptUrl: null,
      createdAt: dummyNow as any,
      updatedAt: dummyNow as any,
      ...overrides,
    }
  }

  it('excludes tomorrow and later today from current metrics while keeping inclusive boundaries and completed months', () => {
    const now = new Date(2026, 10, 15, 12)
    const at = (date: Date) => date as unknown as Transaction['date']
    const valid = [
      createTx({ date: at(new Date(2026, 10, 1)), amountPaise: 15001 }),
      createTx({ date: at(now), amountPaise: 30002, recoverablePaise: 10001 }),
      createTx({ date: at(new Date(2026, 9, 31, 23, 59)), amountPaise: 90003 }),
    ]
    const baseline = deriveInsightsData(valid, mockCategories, now)!
    const summary = deriveInsightsData([...valid,
      createTx({ date: at(new Date(2026, 10, 16)), amountPaise: 999999, categoryId: 'future-only' }),
      createTx({ date: at(new Date(now.getTime() + 1)), amountPaise: 999999, categoryId: 'future-only' }),
    ], mockCategories, now)!
    assert.equal(summary.monthComparison!.thisMonthPaise, 35002)
    assert.equal(summary.monthComparison!.lastMonthPaise, 90003)
    assert.deepEqual(summary.monthComparison, baseline.monthComparison)
    assert.deepEqual(summary.monthlyTrend, baseline.monthlyTrend)
    assert.deepEqual(summary.categoryMonthlyTrends, baseline.categoryMonthlyTrends)
    const pace = calculateSpendingPace(summary.monthComparison!.thisMonthPaise, now)
    assert.equal(pace.dailyPacePaise, Math.round(35002 / 15))
    assert.equal(pace.projectedMonthEndPaise, Math.round(35002 / 15) * 30)
    assert.ok(Number.isInteger(summary.monthComparison!.thisMonthPaise))
    assert.equal(15001 + 30002, summary.monthComparison!.thisMonthPaise + 10001)
  })

  it('keeps malformed dates out of all date buckets without losing date-independent all-time spending', () => {
    const valid = [
      createTx({ amountPaise: 10001 }),
      createTx({ date: lastMonthDate as any, amountPaise: 20003 }),
      createTx({ date: new Date('2020-03-10T12:00:00Z') as any, type: 'reimbursable', amountPaise: 70001, personId: 'legacy' }),
    ]
    const badDates = [undefined, null, 'not-a-date', new Date(NaN), {}, true,
      { toDate: () => null }, { toDate: () => { throw new Error('bad timestamp') } }]
    const invalid = badDates.map(date => createTx({ date: date as any, amountPaise: 90001, type: 'trip', recoverablePaise: 30001 }))
    const baseline = deriveInsightsData(valid, mockCategories, dummyNow)!
    const summary = deriveInsightsData([...valid, ...invalid], mockCategories, dummyNow)!
    assert.deepEqual(summary.monthlyTrend, baseline.monthlyTrend)
    assert.deepEqual(summary.yearlyTotals, baseline.yearlyTotals)
    assert.deepEqual(summary.dayOfWeekStats, baseline.dayOfWeekStats)
    assert.deepEqual(summary.longestStreak, baseline.longestStreak)
    assert.deepEqual(summary.highestSpendingDay, baseline.highestSpendingDay)
    assert.equal(summary.tripTotalPaise, 8 * 60000)
    assert.equal(summary.transactionCount, 11)
    assert.equal(summary.avgTransactionSize!.allTimeAvgPaise, Math.round((30004 + 8 * 60000) / 11))
    assert.equal(summary.largestSingleExpense!.date, null)
    assert.equal(summary.yearlyTotals.find(y => y.year === 2020)?.totalPaise, 0)
    for (const value of badDates) assert.equal(getInsightsDate(value), null)
    const onlyInvalid = deriveInsightsData(invalid, mockCategories, dummyNow)!
    assert.ok(onlyInvalid.monthlyTrend!.every(month => month.totalPaise === 0))
    assert.deepEqual(onlyInvalid.yearlyTotals, [])
  })

  it('retains historical trend anchoring with unsorted valid legacy records', () => {
    const txns = [3, 1, 2].map(month => createTx({ date: new Date(2020, month, 10) as any, amountPaise: 10001 }))
    txns.push(createTx({ date: new Date(2020, 3, 11) as any, type: 'reimbursable', personId: 'legacy', amountPaise: 50001 }))
    const summary = deriveInsightsData(txns, mockCategories, dummyNow)!
    assert.equal(summary.monthlyTrend!.at(-1)!.monthKey, '2020-04')
    assert.equal(summary.monthComparison!.thisMonthPaise, 10001)
    assert.equal(summary.yearlyTotals[0].totalPaise, 30003)
  })

  it('1. excludes 100% recoverable expenses from monthly trend totals and all-time spend', () => {
    // Current month: 2 personal expenses + 1 large 100% fronted bill
    const tx1 = createTx({ amountPaise: 500000, categoryId: 'cat-food' }) // ₹5,000 personal
    const tx2 = createTx({ amountPaise: 300000, categoryId: 'cat-bills' }) // ₹3,000 personal
    const txFronted = createTx({
      amountPaise: 5000000, // ₹50,000 fronted for office dinner
      recoverablePaise: 5000000,
      splits: [{ personId: 'p-1', personName: 'Office', amountPaise: 5000000, repaidPaise: 0, settledAt: null }],
    })

    const summary = deriveInsightsData([tx1, tx2, txFronted], mockCategories, dummyNow)
    assert.ok(summary)

    // Current month trend point must equal ₹8,000, NOT ₹58,000!
    const currentMonthPoint = summary!.monthlyTrend!.find(m => m.isCurrentMonth)
    assert.ok(currentMonthPoint)
    assert.equal(currentMonthPoint!.totalPaise, 800000)

    // All-time most expensive category: Food (₹5,000), Bills (₹3,000). Office fronted bill is 0!
    assert.equal(summary!.mostExpensiveCategory?.categoryId, 'cat-food')
    assert.equal(summary!.mostExpensiveCategory?.totalPaise, 500000)
  })

  it('2. isolates user net share on shared expenses in Month-over-Month comparison', () => {
    // Last month: ₹10,000 personal Food
    const txLastMonth = createTx({
      date: lastMonthDate as any,
      amountPaise: 1000000,
      categoryId: 'cat-food',
    })

    // This month: ₹30,000 group dinner bill, user share ₹10,000, friends owe ₹20,000
    const txThisMonthShared = createTx({
      date: dummyNow as any,
      amountPaise: 3000000, // ₹30,000 gross
      recoverablePaise: 2000000, // ₹20,000 recoverable
      splits: [
        { personId: 'p-1', personName: 'Friend A', amountPaise: 1000000, repaidPaise: 0, settledAt: null },
        { personId: 'p-2', personName: 'Friend B', amountPaise: 1000000, repaidPaise: 0, settledAt: null },
      ],
      categoryId: 'cat-food',
    })

    // Additional historical transaction to meet minimum 3 txns
    const txOld = createTx({
      date: subMonths(dummyNow, 2) as any,
      amountPaise: 500000,
    })

    const summary = deriveInsightsData([txOld, txLastMonth, txThisMonthShared], mockCategories, dummyNow)
    assert.ok(summary)

    const mom = summary!.monthComparison
    // Net spend comparison: This month (₹10,000) vs Last month (₹10,000)
    assert.equal(mom!.thisMonthPaise, 1000000)
    assert.equal(mom!.lastMonthPaise, 1000000)
    assert.equal(mom!.diffPaise, 0)
    assert.equal(mom!.pctChange, 0)
    assert.ok(mom!.summarySentence.includes('matches'))
  })

  it('3. guarantees repayments never register as negative spend spikes or alter analytics', () => {
    // Shared dinner from earlier where Friend A has now repaid ₹10,000
    const txRepaid = createTx({
      date: dummyNow as any,
      amountPaise: 3000000,
      recoverablePaise: 2000000,
      splits: [
        { personId: 'p-1', personName: 'Friend A', amountPaise: 1000000, repaidPaise: 1000000, settledAt: dummyNow as any },
        { personId: 'p-2', personName: 'Friend B', amountPaise: 1000000, repaidPaise: 0, settledAt: null },
      ],
      categoryId: 'cat-food',
    })

    const tx2 = createTx({ date: dummyNow as any, amountPaise: 200000 })
    const tx3 = createTx({ date: dummyNow as any, amountPaise: 100000 })

    const summary = deriveInsightsData([txRepaid, tx2, tx3], mockCategories, dummyNow)
    assert.ok(summary)

    // Net spend of txRepaid remains ₹10,000. Total this month = ₹10,000 + ₹2,000 + ₹1,000 = ₹13,000.
    const currentMonthPoint = summary!.monthlyTrend!.find(m => m.isCurrentMonth)
    assert.equal(currentMonthPoint!.totalPaise, 1300000)
  })

  it('4. identifies largest single personal expense using net spend', () => {
    // Expense A: ₹1,00,000 company trip (100% recoverable -> net spend ₹0)
    const txCorporate = createTx({
      id: 'tx-corp',
      description: 'Corporate Flight & Stay',
      amountPaise: 10000000,
      recoverablePaise: 10000000,
    })

    // Expense B: ₹25,000 personal laptop purchase (net spend ₹25,000)
    const txLaptop = createTx({
      id: 'tx-laptop',
      description: 'Personal Monitor',
      amountPaise: 2500000,
      recoverablePaise: 0,
    })

    // Expense C: ₹12,000 shared dinner (net share ₹4,000)
    const txDinner = createTx({
      id: 'tx-dinner',
      description: 'Group Party',
      amountPaise: 1200000,
      recoverablePaise: 800000,
    })

    const summary = deriveInsightsData([txCorporate, txLaptop, txDinner], mockCategories, dummyNow)
    assert.ok(summary)

    // Largest expense must be the laptop purchase (₹25,000 net), NOT the corporate bill
    assert.equal(summary!.largestSingleExpense?.id, 'tx-laptop')
    assert.equal(summary!.largestSingleExpense?.amountPaise, 2500000)
  })

  it('5. calculates spending pace, daily burn rate, and month-end projection correctly', () => {
    // 15 days elapsed in a 30-day month (November has 30 days)
    const netSpendPaise = 3000000 // ₹30,000 net spend so far

    const pace = calculateSpendingPace(netSpendPaise, dummyNow)

    assert.equal(pace.daysElapsed, 15)
    assert.equal(pace.daysInMonth, 30)
    assert.equal(pace.hasEnoughDaysForPace, true)
    // Daily burn rate: ₹30,000 / 15 days = ₹2,000/day
    assert.equal(pace.dailyPacePaise, 200000)
    // Projected month-end: ₹2,000 * 30 days = ₹60,000
    assert.equal(pace.projectedMonthEndPaise, 6000000)
  })

  it('6. safely handles legacy type="reimbursable" transactions in insights', () => {
    const legacyTx = createTx({
      type: 'reimbursable',
      amountPaise: 5000000, // ₹50,000
      recoverablePaise: undefined,
      splits: undefined,
    })
    const tx2 = createTx({ amountPaise: 200000 })
    const tx3 = createTx({ amountPaise: 300000 })

    const summary = deriveInsightsData([legacyTx, tx2, tx3], mockCategories, dummyNow)
    assert.ok(summary)

    // Legacy reimbursable has 0 net spend
    const currentMonthPoint = summary!.monthlyTrend!.find(m => m.isCurrentMonth)
    assert.equal(currentMonthPoint!.totalPaise, 500000) // ₹2,000 + ₹3,000 only
  })

  it('7. retains all payment methods for payment mode insights', () => {
    // Even when transactions are split or recoverable, payment mode frequency tracks actual outflow accounts
    const tx1 = createTx({ paymentMode: 'UPI', amountPaise: 100000, recoverablePaise: 100000 })
    const tx2 = createTx({ paymentMode: 'UPI', amountPaise: 200000, recoverablePaise: 0 })
    const tx3 = createTx({ paymentMode: 'Card', amountPaise: 50000, recoverablePaise: 0 })

    const summary = deriveInsightsData([tx1, tx2, tx3], mockCategories, dummyNow)
    assert.ok(summary)

    assert.equal(summary!.paymentModeInsight?.dominantMode, 'UPI')
    assert.equal(summary!.paymentModeInsight?.dominantCount, 2)
  })
})
