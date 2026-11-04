import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveBudgetStatus,
  calculateCategoryNetSpend,
  calculateTotalNetSpend,
  calculateCategoryActualsMap,
} from '../budgetMath.ts'
import type { Budget, Category, Transaction } from '../../types/index.ts'

describe('budgetMath — Net Spending Budget Consumption & Invariants', () => {
  const dummyDate = { seconds: 1772000000, nanoseconds: 0 } as any

  const mockCategories: Category[] = [
    { id: 'cat-food', name: 'Food & Dining', color: '#ff5722', icon: 'utensils', isArchived: false },
    { id: 'cat-travel', name: 'Travel', color: '#2196f3', icon: 'plane', isArchived: false },
    { id: 'cat-groceries', name: 'Groceries', color: '#4caf50', icon: 'shopping-cart', isArchived: false },
    { id: 'cat-shopping', name: 'Shopping', color: '#9c27b0', icon: 'shopping-bag', isArchived: false },
  ]

  const mockBudget: Budget = {
    id: '2026-11',
    totalBudgetPaise: 5000000, // ₹50,000 overall limit
    categoryBudgets: {
      'cat-food': 1000000, // ₹10,000
      'cat-travel': 2000000, // ₹20,000
      'cat-groceries': 800000, // ₹8,000
    },
    createdAt: dummyDate,
    updatedAt: dummyDate,
  }

  function createTx(overrides: Partial<Transaction> = {}): Transaction {
    return {
      id: 'tx-' + Math.random().toString(36).substring(2, 9),
      amountPaise: 100000, // ₹1,000
      description: 'Sample expense',
      categoryId: 'cat-food',
      type: 'everyday',
      date: dummyDate,
      paymentMode: 'UPI',
      paymentAccountId: 'acc-1',
      tripId: null,
      personId: null,
      tags: [],
      notes: '',
      receiptUrl: null,
      createdAt: dummyDate,
      updatedAt: dummyDate,
      ...overrides,
    }
  }

  it('1. tracks normal personal expenses against overall and category budgets', () => {
    const tx1 = createTx({ categoryId: 'cat-food', amountPaise: 250000 }) // ₹2,500
    const tx2 = createTx({ categoryId: 'cat-groceries', amountPaise: 200000 }) // ₹2,000

    const summary = deriveBudgetStatus(mockBudget, [tx1, tx2], mockCategories)

    // Overall: ₹4,500 of ₹50,000 consumed (9%)
    assert.equal(summary.overall.actualPaise, 450000)
    assert.equal(summary.overall.totalBudgetPaise, 5000000)
    assert.equal(summary.overall.remainingPaise, 4550000) // ₹45,500 left
    assert.equal(summary.overall.pct, 9)
    assert.equal(summary.overall.isOverBudget, false)

    // Food category: ₹2,500 of ₹10,000 consumed (25%)
    const foodRow = summary.categoryRows.find(r => r.categoryId === 'cat-food')
    assert.ok(foodRow)
    assert.equal(foodRow.actualPaise, 250000)
    assert.equal(foodRow.remainingPaise, 750000) // ₹7,500 left
    assert.equal(foodRow.pct, 25)
    assert.equal(foodRow.isOverBudget, false)

    // Groceries category: ₹2,000 of ₹8,000 consumed (25%)
    const grocRow = summary.categoryRows.find(r => r.categoryId === 'cat-groceries')
    assert.ok(grocRow)
    assert.equal(grocRow.actualPaise, 200000)
    assert.equal(grocRow.remainingPaise, 600000)
    assert.equal(grocRow.pct, 25)
  })

  it('2. excludes 100% recoverable expenses fronted for others from consuming budget', () => {
    // User pays ₹50,000 for travel on company/friend card (100% recoverable)
    const recoverableTx = createTx({
      categoryId: 'cat-travel',
      amountPaise: 5000000, // ₹50,000 gross outflow
      recoverablePaise: 5000000, // 100% recoverable
      splits: [
        { personId: 'p-1', personName: 'Client', amountPaise: 5000000, repaidPaise: 0, settledAt: null },
      ],
    })

    const summary = deriveBudgetStatus(mockBudget, [recoverableTx], mockCategories)

    // Net spend = ₹0. Budget consumption MUST be 0!
    assert.equal(summary.overall.actualPaise, 0)
    assert.equal(summary.overall.remainingPaise, 5000000)
    assert.equal(summary.overall.pct, 0)
    assert.equal(summary.overall.isOverBudget, false)

    // Travel category budget remains completely untouched
    const travelRow = summary.categoryRows.find(r => r.categoryId === 'cat-travel')
    assert.ok(travelRow)
    assert.equal(travelRow.actualPaise, 0)
    assert.equal(travelRow.remainingPaise, 2000000)
    assert.equal(travelRow.pct, 0)
    assert.equal(travelRow.isOverBudget, false)
    assert.equal(summary.alertCategories.length, 0)
  })

  it('3. consumes only the user net personal share of a shared bill', () => {
    // User pays ₹6,000 dinner bill. User share is ₹2,000; friends owe ₹4,000.
    const sharedTx = createTx({
      categoryId: 'cat-food',
      amountPaise: 600000, // ₹6,000 gross
      recoverablePaise: 400000, // ₹4,000 recoverable
      splits: [
        { personId: 'p-1', personName: 'Aarav', amountPaise: 200000, repaidPaise: 0, settledAt: null },
        { personId: 'p-2', personName: 'Meera', amountPaise: 200000, repaidPaise: 0, settledAt: null },
      ],
    })

    const summary = deriveBudgetStatus(mockBudget, [sharedTx], mockCategories)

    // Consumed: only ₹2,000 (user share), NOT ₹6,000!
    assert.equal(summary.overall.actualPaise, 200000)
    assert.equal(summary.overall.remainingPaise, 4800000)

    const foodRow = summary.categoryRows.find(r => r.categoryId === 'cat-food')
    assert.ok(foodRow)
    assert.equal(foodRow.actualPaise, 200000)
    assert.equal(foodRow.remainingPaise, 800000) // ₹8,000 left
    assert.equal(foodRow.pct, 20)
    assert.equal(foodRow.isOverBudget, false)
  })

  it('4. guarantees repayments never create artificial budget room or double-count', () => {
    // Starting with shared ₹6,000 bill (user share ₹2,000).
    // Later, Aarav repays his ₹2,000 share.
    const repaidSharedTx = createTx({
      categoryId: 'cat-food',
      amountPaise: 600000,
      recoverablePaise: 400000,
      splits: [
        { personId: 'p-1', personName: 'Aarav', amountPaise: 200000, repaidPaise: 200000, settledAt: dummyDate },
        { personId: 'p-2', personName: 'Meera', amountPaise: 200000, repaidPaise: 0, settledAt: null },
      ],
    })

    const summary = deriveBudgetStatus(mockBudget, [repaidSharedTx], mockCategories)

    // INVARIANT: Repayments must NEVER alter net personal spend or create extra budget room!
    // Consumed remains exactly ₹2,000.
    assert.equal(summary.overall.actualPaise, 200000)
    assert.equal(summary.overall.remainingPaise, 4800000)

    const foodRow = summary.categoryRows.find(r => r.categoryId === 'cat-food')
    assert.ok(foodRow)
    assert.equal(foodRow.actualPaise, 200000)
    assert.equal(foodRow.remainingPaise, 800000)
  })

  it('5. triggers alerts at >= 90% and detects over-budget states with negative remaining', () => {
    // Budget: Food = ₹10,000. User spends ₹9,500 net (95%).
    const txAlert = createTx({ categoryId: 'cat-food', amountPaise: 950000 })
    // Budget: Groceries = ₹8,000. User spends ₹9,000 net (112.5% -> over budget).
    const txOver = createTx({ categoryId: 'cat-groceries', amountPaise: 900000 })

    const summary = deriveBudgetStatus(mockBudget, [txAlert, txOver], mockCategories)

    const foodRow = summary.categoryRows.find(r => r.categoryId === 'cat-food')!
    assert.equal(foodRow.pct, 95)
    assert.equal(foodRow.remainingPaise, 50000) // ₹500 left
    assert.equal(foodRow.isOverBudget, false)

    const grocRow = summary.categoryRows.find(r => r.categoryId === 'cat-groceries')!
    assert.equal(grocRow.pct, 112.5)
    assert.equal(grocRow.remainingPaise, -100000) // ₹1,000 over budget!
    assert.equal(grocRow.isOverBudget, true)

    // Both categories should be in alertCategories
    assert.equal(summary.alertCategories.length, 2)
    assert.equal(summary.alertCategories[0].categoryId, 'cat-groceries') // Sorted highest % first
    assert.equal(summary.alertCategories[1].categoryId, 'cat-food')
  })

  it('6. safely handles legacy type="reimbursable" transactions', () => {
    const legacyTx = createTx({
      categoryId: 'cat-travel',
      amountPaise: 1500000, // ₹15,000
      type: 'reimbursable',
      recoverablePaise: undefined,
      splits: undefined,
    })

    const summary = deriveBudgetStatus(mockBudget, [legacyTx], mockCategories)

    // Net spend is 0, so travel budget consumption is 0
    assert.equal(summary.overall.actualPaise, 0)
    const travelRow = summary.categoryRows.find(r => r.categoryId === 'cat-travel')!
    assert.equal(travelRow.actualPaise, 0)
    assert.equal(travelRow.remainingPaise, 2000000)
  })

  it('7. handles null budget and empty transactions gracefully', () => {
    const emptySummary = deriveBudgetStatus(null, [], mockCategories)

    assert.equal(emptySummary.overall.actualPaise, 0)
    assert.equal(emptySummary.overall.totalBudgetPaise, null)
    assert.equal(emptySummary.overall.remainingPaise, null)
    assert.equal(emptySummary.overall.pct, null)
    assert.equal(emptySummary.overall.isOverBudget, false)
    assert.equal(emptySummary.categoryRows.length, 0)
    assert.equal(emptySummary.alertCategories.length, 0)
  })

  it('8. helper calculations map category actuals and total net spend accurately', () => {
    const tx1 = createTx({ categoryId: 'cat-food', amountPaise: 300000, recoverablePaise: 100000 }) // Net ₹2,000
    const tx2 = createTx({ categoryId: 'cat-food', amountPaise: 100000, recoverablePaise: 0 }) // Net ₹1,000
    const tx3 = createTx({ categoryId: 'cat-travel', amountPaise: 500000, recoverablePaise: 500000 }) // Net ₹0

    const txns = [tx1, tx2, tx3]

    assert.equal(calculateCategoryNetSpend(txns, 'cat-food'), 300000)
    assert.equal(calculateCategoryNetSpend(txns, 'cat-travel'), 0)
    assert.equal(calculateTotalNetSpend(txns), 300000)

    const map = calculateCategoryActualsMap(txns)
    assert.equal(map.get('cat-food'), 300000)
    assert.equal(map.has('cat-travel'), false) // Zero net spend excluded from map
  })
})
