import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  allocateEqualSplitPaise,
  allocateCustomMyShareSplitPaise,
  validateFinancialInvariants,
} from '../splitMath.ts'
import { deriveBudgetStatus, calculateCategoryActualsMap, calculateTotalNetSpend } from '../budgetMath.ts'
import { calculateTripAccountingSummary } from '../tripBuckets.ts'
import {
  calculateRecurringTransactionsNetSpend,
  calculateRecurringTransactionsGrossOutflow,
} from '../recurringMath.ts'
import { generateTransactionsCSV } from '../csvExportMath.ts'
import type { Budget, Category, PaymentAccount, Transaction, Trip } from '../../types/index.ts'

describe('End-to-End Financial Invariant Audit & Hardening', () => {
  const dummyDate = (isoStr: string) => ({
    toDate: () => new Date(isoStr),
    seconds: Math.floor(new Date(isoStr).getTime() / 1000),
    nanoseconds: 0,
  }) as any

  const mockCategories: Category[] = [
    { id: 'cat-food', name: 'Food & Dining', color: '#ff5722', icon: 'utensils', isArchived: false },
    { id: 'cat-travel', name: 'Travel & Trips', color: '#2196f3', icon: 'plane', isArchived: false },
    { id: 'cat-bills', name: 'Bills & Utilities', color: '#4caf50', icon: 'receipt', isArchived: false },
    { id: 'cat-stay', name: 'Hotel & Stay', color: '#9c27b0', icon: 'hotel', isArchived: false },
  ]

  const mockAccounts: PaymentAccount[] = [
    { id: 'acc-hdfc', name: 'HDFC Bank', type: 'Bank', isDefault: true, isArchived: false, createdAt: dummyDate('2026-01-01T00:00:00Z') },
    { id: 'acc-cc', name: 'ICICI Credit Card', type: 'Card', isDefault: false, isArchived: false, createdAt: dummyDate('2026-01-01T00:00:00Z') },
  ]

  const mockTrip: Trip = {
    id: 'trip-manali',
    name: 'Manali Winter Vacation',
    startDate: dummyDate('2026-11-01T12:00:00Z'),
    endDate: dummyDate('2026-11-06T12:00:00Z'),
    budgetPaise: 5000000, // ₹50,000 budget
    coverColor: '#2196f3',
    coverEmoji: '🏔️',
    notes: '',
    isArchived: false,
    createdAt: dummyDate('2026-10-15T00:00:00Z'),
    updatedAt: dummyDate('2026-10-15T00:00:00Z'),
  }

  const mockBudget: Budget = {
    id: '2026-11',
    totalBudgetPaise: 6000000, // ₹60,000 total monthly limit
    categoryBudgets: {
      'cat-food': 1500000, // ₹15,000
      'cat-bills': 1000000, // ₹10,000
      'cat-travel': 2500000, // ₹25,000
    },
    createdAt: dummyDate('2026-11-01T00:00:00Z'),
    updatedAt: dummyDate('2026-11-01T00:00:00Z'),
  }

  function createTx(overrides: Partial<Transaction> = {}): Transaction {
    return {
      id: 'tx-' + Math.random().toString(36).substring(2, 9),
      amountPaise: 100000,
      description: 'Sample expense',
      categoryId: 'cat-food',
      type: 'everyday',
      date: dummyDate('2026-11-04T12:00:00Z'),
      paymentMode: 'UPI',
      paymentAccountId: 'acc-hdfc',
      tripId: null,
      personId: null,
      tags: [],
      notes: '',
      receiptUrl: null,
      createdAt: dummyDate('2026-11-04T12:00:00Z'),
      updatedAt: dummyDate('2026-11-04T12:00:00Z'),
      ...overrides,
    }
  }

  it('1. Strict mathematical paise conservation across 100 randomized split allocations', () => {
    for (let i = 0; i < 100; i++) {
      // Amount from ₹1.00 (100 paise) to ₹15,000.00 (1,500,000 paise)
      const totalPaise = Math.floor(Math.random() * 1500000) + 100
      // Number of friends between 1 and 8
      const friendCount = Math.floor(Math.random() * 8) + 1
      const participants = Array.from({ length: friendCount }, (_, idx) => ({
        personId: `p-${idx + 1}`,
        personName: `Friend ${idx + 1}`,
      }))

      // Equal split including self
      const equalShared = allocateEqualSplitPaise(totalPaise, participants, true)
      const sumSplitsShared = equalShared.splits.reduce((s, sh) => s + sh.amountPaise, 0)
      assert.equal(
        equalShared.mySharePaise + sumSplitsShared,
        totalPaise,
        `Shared split failed conservation: myShare (${equalShared.mySharePaise}) + splits (${sumSplitsShared}) !== total (${totalPaise})`
      )
      assert.equal(equalShared.recoverablePaise, sumSplitsShared)

      // Equal split 100% recoverable (includeSelf = false)
      const equalRecoverable = allocateEqualSplitPaise(totalPaise, participants, false)
      const sumSplitsRecoverable = equalRecoverable.splits.reduce((s, sh) => s + sh.amountPaise, 0)
      assert.equal(equalRecoverable.mySharePaise, 0)
      assert.equal(sumSplitsRecoverable, totalPaise)
      assert.equal(equalRecoverable.recoverablePaise, totalPaise)

      // Custom user share
      const customMyShare = Math.floor(Math.random() * totalPaise)
      const customSplit = allocateCustomMyShareSplitPaise(totalPaise, customMyShare, participants)
      const sumCustomSplits = customSplit.splits.reduce((s, sh) => s + sh.amountPaise, 0)
      assert.equal(
        customSplit.mySharePaise + sumCustomSplits,
        totalPaise,
        `Custom split failed conservation: myShare (${customSplit.mySharePaise}) + splits (${sumCustomSplits}) !== total (${totalPaise})`
      )
    }
  })

  it('2. End-to-End System Invariant: Repayments NEVER alter net spending, budget consumption, or trends across any feature', () => {
    // ── Build a realistic multi-feature transaction dataset ─────────────────
    // 1. Personal grocery expense: ₹2,450
    const tx1 = createTx({
      id: 'tx-grocery',
      amountPaise: 245000,
      description: 'Weekly Groceries',
      categoryId: 'cat-food',
      type: 'everyday',
    })

    // 2. Shared restaurant dinner: ₹4,500 split 3 ways (User ₹1,500, Alice ₹1,500, Bob ₹1,500)
    const tx2 = createTx({
      id: 'tx-dinner',
      amountPaise: 450000,
      description: 'Weekend Italian Dinner',
      categoryId: 'cat-food',
      type: 'everyday',
      recoverablePaise: 300000,
      reimbursementStatus: 'pending',
      splits: [
        { personId: 'p-alice', personName: 'Alice', amountPaise: 150000, repaidPaise: 0 },
        { personId: 'p-bob', personName: 'Bob', amountPaise: 150000, repaidPaise: 0 },
      ],
    })

    // 3. 100% recoverable corporate flight: ₹18,000 fronted on credit card
    const tx3 = createTx({
      id: 'tx-flight',
      amountPaise: 1800000,
      description: 'Flight to Client HQ',
      categoryId: 'cat-travel',
      type: 'everyday',
      paymentMode: 'Card',
      paymentAccountId: 'acc-cc',
      recoverablePaise: 1800000,
      reimbursementStatus: 'pending',
      splits: [
        { personId: 'p-corp', personName: 'Company Reimbursement', amountPaise: 1800000, repaidPaise: 0 },
      ],
    })

    // 4. Shared recurring Wi-Fi bill: ₹1,179 split with flatmate (User ₹589, Flatmate ₹590)
    const tx4 = createTx({
      id: 'tx-wifi',
      amountPaise: 117900,
      description: 'ACT Fibernet High Speed',
      categoryId: 'cat-bills',
      type: 'recurring',
      recoverablePaise: 59000,
      reimbursementStatus: 'pending',
      splits: [
        { personId: 'p-flatmate', personName: 'Flatmate Dan', amountPaise: 59000, repaidPaise: 0 },
      ],
    })

    // 5. Shared trip stay: ₹30,000 villa split with 2 friends (User ₹10,000, Charlie ₹10,000, Dave ₹10,000)
    const tx5 = createTx({
      id: 'tx-villa',
      amountPaise: 3000000,
      description: 'Manali Riverside Villa',
      categoryId: 'cat-stay',
      type: 'trip',
      tripId: 'trip-manali',
      recoverablePaise: 2000000,
      reimbursementStatus: 'pending',
      splits: [
        { personId: 'p-charlie', personName: 'Charlie', amountPaise: 1000000, repaidPaise: 0 },
        { personId: 'p-dave', personName: 'Dave', amountPaise: 1000000, repaidPaise: 0 },
      ],
    })

    const initialTxns = [tx1, tx2, tx3, tx4, tx5]

    // ── Baseline Calculations (Before Repayments) ───────────────────────────
    const baselineTotalNetSpend = calculateTotalNetSpend(initialTxns)
    const baselineBudgetActuals = calculateCategoryActualsMap(initialTxns)
    const baselineBudgetStatus = deriveBudgetStatus(mockBudget, initialTxns, mockCategories)
    const tripTxns = initialTxns.filter(t => t.tripId === mockTrip.id)
    const baselineTripSummary = calculateTripAccountingSummary(mockTrip, tripTxns, mockCategories)
    const baselineRecurringNetSpend = calculateRecurringTransactionsNetSpend(initialTxns)
    const baselineRecurringOutflow = calculateRecurringTransactionsGrossOutflow(initialTxns)

    // Expected net personal spends:
    // tx1: ₹2,450
    // tx2: ₹4,500 - ₹3,000 = ₹1,500
    // tx3: ₹18,000 - ₹18,000 = ₹0
    // tx4: ₹1,179 - ₹590 = ₹589
    // tx5: ₹30,000 - ₹20,000 = ₹10,000
    // Total net spend: 245000 + 150000 + 0 + 58900 + 1000000 = 1453900 paise (₹14,539)
    assert.equal(baselineTotalNetSpend, 1453900)
    assert.equal(baselineTripSummary.totalNetSpendPaise, 1000000) // ₹10,000
    assert.equal(baselineTripSummary.totalGrossOutflowPaise, 3000000) // ₹30,000
    assert.equal(baselineRecurringNetSpend, 58900) // ₹589
    assert.equal(baselineRecurringOutflow, 117900) // ₹1,179

    // ── Simulate Multiple Repayments ────────────────────────────────────────
    // Alice repays her full ₹1,500 on dinner
    // Flatmate Dan repays his full ₹590 on WiFi
    // Company reimburses full ₹18,000 on flight
    // Charlie repays ₹5,000 partial on villa
    const repaidTx2: Transaction = {
      ...tx2,
      reimbursementStatus: 'partial',
      splits: [
        { personId: 'p-alice', personName: 'Alice', amountPaise: 150000, repaidPaise: 150000 },
        { personId: 'p-bob', personName: 'Bob', amountPaise: 150000, repaidPaise: 0 },
      ],
    }

    const repaidTx3: Transaction = {
      ...tx3,
      reimbursementStatus: 'settled',
      splits: [
        { personId: 'p-corp', personName: 'Company Reimbursement', amountPaise: 1800000, repaidPaise: 1800000 },
      ],
    }

    const repaidTx4: Transaction = {
      ...tx4,
      reimbursementStatus: 'settled',
      splits: [
        { personId: 'p-flatmate', personName: 'Flatmate Dan', amountPaise: 59000, repaidPaise: 59000 },
      ],
    }

    const repaidTx5: Transaction = {
      ...tx5,
      reimbursementStatus: 'partial',
      splits: [
        { personId: 'p-charlie', personName: 'Charlie', amountPaise: 1000000, repaidPaise: 500000 },
        { personId: 'p-dave', personName: 'Dave', amountPaise: 1000000, repaidPaise: 0 },
      ],
    }

    const afterRepaymentTxns = [tx1, repaidTx2, repaidTx3, repaidTx4, repaidTx5]

    // ── Audit Assertions (After Repayments) ──────────────────────────────────
    // 1. Total Net Spending across entire app MUST be strictly identical
    const newTotalNetSpend = calculateTotalNetSpend(afterRepaymentTxns)
    assert.equal(newTotalNetSpend, baselineTotalNetSpend, 'Net spending shifted after repayments!')

    // 2. Budget actuals and alerts MUST be strictly identical
    const newBudgetActuals = calculateCategoryActualsMap(afterRepaymentTxns)
    assert.deepEqual(newBudgetActuals, baselineBudgetActuals, 'Budget category actuals shifted after repayments!')

    const newBudgetStatus = deriveBudgetStatus(mockBudget, afterRepaymentTxns, mockCategories)
    assert.equal(newBudgetStatus.overall.actualPaise, baselineBudgetStatus.overall.actualPaise)
    assert.equal(newBudgetStatus.overall.remainingPaise, baselineBudgetStatus.overall.remainingPaise)
    assert.equal(newBudgetStatus.overall.pct, baselineBudgetStatus.overall.pct)

    // 3. Trip net spend MUST be strictly identical
    const repaidTripTxns = afterRepaymentTxns.filter(t => t.tripId === mockTrip.id)
    const newTripSummary = calculateTripAccountingSummary(mockTrip, repaidTripTxns, mockCategories)
    assert.equal(newTripSummary.totalNetSpendPaise, baselineTripSummary.totalNetSpendPaise)
    assert.equal(newTripSummary.totalGrossOutflowPaise, baselineTripSummary.totalGrossOutflowPaise)
    assert.equal(newTripSummary.budgetPct, baselineTripSummary.budgetPct)

    // 4. Trip pending dues MUST drop by exactly ₹5,000 (500,000 paise)
    assert.equal(newTripSummary.repaidPaise, 500000)
    assert.equal(newTripSummary.pendingPaise, 1500000)

    // 5. Recurring personal spend MUST be strictly identical
    const newRecurringNetSpend = calculateRecurringTransactionsNetSpend(afterRepaymentTxns)
    const newRecurringOutflow = calculateRecurringTransactionsGrossOutflow(afterRepaymentTxns)
    assert.equal(newRecurringNetSpend, baselineRecurringNetSpend)
    assert.equal(newRecurringOutflow, baselineRecurringOutflow)

    // 6. Validate all 4 financial invariants across every transaction individually
    for (const tx of afterRepaymentTxns) {
      const inv = validateFinancialInvariants(tx)
      assert.equal(
        inv.isValid,
        true,
        `Financial invariant check failed on transaction ${tx.id} (${tx.description}): ${inv.errors.join(', ')}`
      )
      assert.equal(inv.errors.length, 0)
    }
  })

  it('3. CSV Export and Data Portability Invariant: All financial dimensions round-trip cleanly', () => {
    const tx: Transaction = {
      id: 'tx-e2e-export',
      amountPaise: 900000, // ₹9,000 gross
      description: 'Conference passes & team dinner',
      categoryId: 'cat-travel',
      type: 'everyday',
      date: dummyDate('2026-11-04T12:00:00Z'),
      paymentMode: 'Card',
      paymentAccountId: 'acc-cc',
      tripId: null,
      personId: null,
      tags: [],
      notes: 'Paid on corporate card',
      receiptUrl: null,
      recoverablePaise: 600000, // ₹6,000 owed by 2 colleagues
      reimbursementStatus: 'partial',
      splits: [
        { personId: 'p-1', personName: 'Alice', amountPaise: 300000, repaidPaise: 300000 },
        { personId: 'p-2', personName: 'Bob', amountPaise: 300000, repaidPaise: 100000 },
      ],
      createdAt: dummyDate('2026-11-04T12:00:00Z'),
      updatedAt: dummyDate('2026-11-04T12:00:00Z'),
    }

    const csv = generateTransactionsCSV([tx], mockCategories, mockAccounts)
    const [header, row] = csv.split('\n')

    assert.match(header, /Gross Amount \(₹\)/)
    assert.match(header, /Net Amount \(₹\)/)
    assert.match(header, /Recoverable \(₹\)/)
    assert.match(header, /Pending Dues \(₹\)/)

    // Gross: 9000.00
    assert.match(row, /9000\.00/)
    // Net: 3000.00
    assert.match(row, /3000\.00/)
    // Recoverable: 6000.00
    assert.match(row, /6000\.00/)
    // Repaid: 4000.00
    assert.match(row, /4000\.00/)
    // Pending: 2000.00
    assert.match(row, /2000\.00/)
    // Status: partial
    assert.match(row, /partial/)
    // Breakdown contains Alice and Bob with respective repayment details
    assert.match(row, /Alice: ₹3000\.00 \(Repaid: ₹3000\.00\)/)
    assert.match(row, /Bob: ₹3000\.00 \(Repaid: ₹1000\.00\)/)
  })
})
