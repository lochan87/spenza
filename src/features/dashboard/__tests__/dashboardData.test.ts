import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as dateFns from 'date-fns'
import * as splitMath from '../../../utils/splitMath.ts'
import { subMonths } from 'date-fns'
import { deriveDashboardData } from '../dashboardData.ts'
import type { Transaction, Category, PaymentAccount } from '../../../types/index.ts'

describe('Dashboard Integration — Net Spending & Recoverables Ledger', () => {
  const dummyDate = new Date()
  const lastMonthDate = subMonths(dummyDate, 1)
  const threeMonthsAgoDate = subMonths(dummyDate, 3)

  const mockCategories: Category[] = [
    { id: 'cat-food', name: 'Food & Dining', color: '#ff5722', icon: 'utensils', isArchived: false },
    { id: 'cat-groceries', name: 'Groceries', color: '#4caf50', icon: 'shopping-cart', isArchived: false },
    { id: 'cat-travel', name: 'Travel', color: '#2196f3', icon: 'plane', isArchived: false },
    { id: 'cat-bills', name: 'Bills & Utilities', color: '#ff9800', icon: 'receipt', isArchived: false },
  ]

  const mockAccounts: PaymentAccount[] = [
    { id: 'acc-hdfc', name: 'HDFC Salary Bank', type: 'Bank', isDefault: true, isArchived: false, createdAt: dummyDate as any },
    { id: 'acc-icici-cc', name: 'ICICI Amazon Pay Card', type: 'Card', isDefault: false, isArchived: false, createdAt: dummyDate as any },
  ]

  function createTx(overrides: Partial<Transaction> = {}): Transaction {
    return {
      id: 'tx-' + Math.random().toString(36).substring(2, 9),
      amountPaise: 100000, // ₹1,000 default
      description: 'Test Expense',
      categoryId: 'cat-food',
      type: 'everyday',
      date: dummyDate as any,
      paymentMode: 'UPI',
      paymentAccountId: 'acc-hdfc',
      tripId: null,
      personId: null,
      tags: [],
      notes: '',
      receiptUrl: null,
      createdAt: dummyDate as any,
      updatedAt: dummyDate as any,
      ...overrides,
    }
  }

  function historicalSplit(id: string, repaidPaise: number): Transaction {
    return createTx({
      id, date: subMonths(dummyDate, 12) as unknown as Transaction['date'],
      amountPaise: 15003, recoverablePaise: 10001,
      splits: [{ personId: id, personName: id, amountPaise: 10001, repaidPaise,
        settledAt: repaidPaise === 10001 ? dummyDate as unknown as Transaction['date'] : null }],
    })
  }

  const history = () => [
    historicalSplit('unpaid', 0),
    historicalSplit('partial', 3333),
    historicalSplit('settled', 10001),
    createTx({ id: 'legacy', date: subMonths(dummyDate, 24) as unknown as Transaction['date'],
      type: 'reimbursable', personId: 'legacy-person', amountPaise: 7003 }),
  ]

  for (const [label, repaid] of [['unpaid', 0], ['partially repaid', 3333], ['fully repaid', 10001]] as const) {
    it(`includes an older ${label} split older than six months in all-time balances`, () => {
      const data = deriveDashboardData([historicalSplit(label, repaid)], [], [])
      assert.equal(data.allTimeRecoverableTotal, 10001)
      assert.equal(data.allTimeRepaidTotal, repaid)
      assert.equal(data.allTimePendingDuesTotal, 10001 - repaid)
      assert.equal(data.thisMonthTotal, 0)
    })
  }

  it('matches Friends full-history dues for multiple people, legacy records and future dates in integer paise', () => {
    const future = historicalSplit('future', 0)
    future.date = subMonths(dummyDate, -2) as unknown as Transaction['date']
    const fullHistory = [...history(), future]
    const data = deriveDashboardData(fullHistory, [], [])
    assert.equal(data.allTimeRecoverableTotal, 47007)
    assert.equal(data.allTimeRepaidTotal, 13334)
    assert.equal(data.allTimePendingDuesTotal, 33673)
    assert.deepEqual(data.peopleDues, splitMath.aggregatePeopleDues(fullHistory))
    assert.equal(data.peopleDues.filter(person => person.pendingDuesPaise > 0).length, 4)
    assert.equal(data.allTimeRecoverableTotal, data.allTimeRepaidTotal + data.allTimePendingDuesTotal)
    const gross = fullHistory.reduce((sum, tx) => sum + tx.amountPaise, 0)
    const net = fullHistory.reduce((sum, tx) => sum + splitMath.getNetSpendPaise(tx), 0)
    assert.equal(gross, net + data.allTimeRecoverableTotal)
    for (const value of [gross, net, data.allTimeRecoverableTotal, data.allTimeRepaidTotal, data.allTimePendingDuesTotal]) {
      assert.ok(Number.isInteger(value))
    }
  })

  it('keeps every recent-period analytic unchanged when older and future-month history is added', () => {
    const recent = [0, 1, 3, 5].map(months => createTx({
      date: subMonths(dummyDate, months) as unknown as Transaction['date'], amountPaise: 15003,
    }))
    const future = createTx({ date: subMonths(dummyDate, -2) as unknown as Transaction['date'] })
    const baseline = deriveDashboardData(recent, mockCategories, mockAccounts)
    const expanded = deriveDashboardData([...recent, ...history(), future], mockCategories, mockAccounts)
    for (const key of Object.keys(baseline) as Array<keyof typeof baseline>) {
      if (key.startsWith('allTime') || key === 'peopleDues') continue
      assert.deepEqual(expanded[key], baseline[key], key)
    }
    assert.deepEqual(expanded.monthlyTotals.map(month => month.totalPaise), [15003, 0, 15003, 0, 15003, 15003])
  })

  it('fetches actual owner history without excluding old or future records and propagates read failures', async () => {
    // Execute the production module with only its I/O replaced; no Firebase configuration
    // or network access. CommonJS transpilation lets the dynamic import use the stub.
    const source = readFileSync(new URL('../dashboardData.ts', import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
    }).outputText
    const records = [...history(), createTx({ id: 'current' }), createTx({
      id: 'future', date: subMonths(dummyDate, -2) as unknown as Transaction['date'],
    })]
    type Constraint = { field: string; operator: string; value: Date }
    type Reference = { path: string[]; constraints: Constraint[] }
    let failure: Error | undefined
    let configLoads = 0
    const db = {}
    const exports: { fetchDashboardTransactions?: (uid: string) => Promise<Transaction[]> } = {}
    runInNewContext(compiled, { exports, require: (name: string) => {
      if (name === '../../firebase/config.ts') { configLoads++; return { db } }
      if (name === 'date-fns') return dateFns
      if (name === '../../utils/splitMath.ts') return splitMath
      assert.equal(name, 'firebase/firestore')
      return {
        collection: (database: unknown, ...path: string[]) => {
          assert.equal(database, db)
          assert.deepEqual(path, ['users', 'test-owner', 'transactions'])
          return { path, constraints: [] }
        },
        query: (ref: Reference, ...constraints: Constraint[]) => ({ ...ref, constraints }),
        where: (field: string, operator: string, value: Date) => ({ field, operator, value }),
        Timestamp: { fromDate: (date: Date) => date },
        getDocs: async (ref: Reference) => {
          if (failure) throw failure
          const matching = records.filter(tx => ref.constraints.every(({ field, operator, value }) => {
            assert.equal(field, 'date')
            const date = tx.date as unknown as Date
            if (operator === '>=') return date >= value
            if (operator === '<=') return date <= value
            throw new Error(`Unexpected operator: ${operator}`)
          }))
          return { docs: matching.map(({ id, ...data }) => ({ id, data: () => data })) }
        },
      }
    } })
    assert.equal(configLoads, 0, 'configuration remains lazy')
    const fetched = await exports.fetchDashboardTransactions!('test-owner')
    assert.deepEqual(Array.from(fetched, tx => tx.id), records.map(tx => tx.id))
    assert.deepEqual(deriveDashboardData(structuredClone(fetched), [], []), deriveDashboardData(records, [], []))
    failure = new Error('read failed')
    await assert.rejects(exports.fetchDashboardTransactions!('test-owner'), failure)
  })

  it('1. calculates personal transactions where net spend equals gross outflow', () => {
    const tx1 = createTx({ amountPaise: 150000, categoryId: 'cat-food', type: 'everyday' }) // ₹1,500
    const tx2 = createTx({ amountPaise: 50000, categoryId: 'cat-groceries', type: 'recurring' }) // ₹500

    const data = deriveDashboardData([tx1, tx2], mockCategories, mockAccounts)

    assert.equal(data.thisMonthTotal, 200000) // ₹2,000 net spend
    assert.equal(data.thisMonthGrossOutflow, 200000) // ₹2,000 gross outflow
    assert.equal(data.everydayTotal, 150000)
    assert.equal(data.recurringTotal, 50000)
    assert.equal(data.normalSpendTotal, 200000)
    assert.equal(data.thisMonthRecoverableTotal, 0)
    assert.equal(data.thisMonthPendingDuesTotal, 0)
    assert.equal(data.allTimePendingDuesTotal, 0)

    // Top categories
    assert.equal(data.topCategories.length, 2)
    assert.equal(data.topCategories[0].name, 'Food & Dining')
    assert.equal(data.topCategories[0].totalPaise, 150000)
  })

  it('2. excludes 100% recoverable expenses from net spending while preserving gross outflow', () => {
    // User fronted ₹50,000 for office team dinner or friend
    const recoverableTx = createTx({
      amountPaise: 5000000, // ₹50,000 gross outflow
      categoryId: 'cat-food',
      type: 'everyday',
      recoverablePaise: 5000000, // 100% recoverable
      splits: [
        {
          personId: 'person-bob',
          personName: 'Bob',
          amountPaise: 5000000,
          repaidPaise: 0,
          settledAt: null,
        },
      ],
      paymentMode: 'Card',
      paymentAccountId: 'acc-icici-cc',
    })

    const data = deriveDashboardData([recoverableTx], mockCategories, mockAccounts)

    // Net personal spend MUST be 0!
    assert.equal(data.thisMonthTotal, 0)
    assert.equal(data.normalSpendTotal, 0)
    assert.equal(data.everydayTotal, 0)

    // Category spend for Food must be 0
    assert.equal(data.topCategories.length, 0)

    // Gross outflow MUST preserve ₹50,000 for bank/card reconciliation
    assert.equal(data.thisMonthGrossOutflow, 5000000)
    assert.equal(data.paymentModeTotals.find(m => m.mode === 'Card')?.totalPaise, 5000000)
    assert.equal(data.accountTotals.find(a => a.accountId === 'acc-icici-cc')?.totalPaise, 5000000)

    // Recoverable & pending dues ledger
    assert.equal(data.thisMonthRecoverableTotal, 5000000)
    assert.equal(data.thisMonthRepaidTotal, 0)
    assert.equal(data.thisMonthPendingDuesTotal, 5000000)
    assert.equal(data.allTimePendingDuesTotal, 5000000)
  })

  it('3. isolates user net share from shared split expenses and tracks friends dues', () => {
    // ₹3,000 dinner bill: user share = ₹1,000; friends owe ₹2,000
    const sharedTx = createTx({
      amountPaise: 300000, // ₹3,000 gross
      categoryId: 'cat-food',
      type: 'everyday',
      recoverablePaise: 200000, // ₹2,000 recoverable
      splits: [
        { personId: 'p-1', personName: 'Aarav', amountPaise: 100000, repaidPaise: 0, settledAt: null },
        { personId: 'p-2', personName: 'Meera', amountPaise: 100000, repaidPaise: 0, settledAt: null },
      ],
      paymentMode: 'UPI',
      paymentAccountId: 'acc-hdfc',
    })

    const personalTx = createTx({
      amountPaise: 50000, // ₹500 personal
      categoryId: 'cat-groceries',
      type: 'everyday',
    })

    const data = deriveDashboardData([sharedTx, personalTx], mockCategories, mockAccounts)

    // Net personal spend = ₹1,000 (user share of dinner) + ₹500 (personal groceries) = ₹1,500
    assert.equal(data.thisMonthTotal, 150000)
    assert.equal(data.everydayTotal, 150000)
    assert.equal(data.normalSpendTotal, 150000)

    // Gross outflow = ₹3,000 + ₹500 = ₹3,500
    assert.equal(data.thisMonthGrossOutflow, 350000)

    // Category breakdown reflects net share: Food = ₹1,000, Groceries = ₹500
    const foodCat = data.topCategories.find(c => c.categoryId === 'cat-food')
    const grocCat = data.topCategories.find(c => c.categoryId === 'cat-groceries')
    assert.equal(foodCat?.totalPaise, 100000)
    assert.equal(grocCat?.totalPaise, 50000)

    // Recoverable & pending dues
    assert.equal(data.thisMonthRecoverableTotal, 200000)
    assert.equal(data.thisMonthRepaidTotal, 0)
    assert.equal(data.thisMonthPendingDuesTotal, 200000)
    assert.equal(data.allTimePendingDuesTotal, 200000)
  })

  it('4. ensures repayments never alter net personal spend or gross outflow', () => {
    // Shared ₹3,000 bill where Aarav has repaid ₹1,000, Meera still owes ₹1,000
    const partiallyRepaidTx = createTx({
      amountPaise: 300000,
      categoryId: 'cat-food',
      type: 'everyday',
      recoverablePaise: 200000,
      splits: [
        { personId: 'p-1', personName: 'Aarav', amountPaise: 100000, repaidPaise: 100000, settledAt: dummyDate as any },
        { personId: 'p-2', personName: 'Meera', amountPaise: 100000, repaidPaise: 0, settledAt: null },
      ],
      paymentMode: 'UPI',
    })

    const data = deriveDashboardData([partiallyRepaidTx], mockCategories, mockAccounts)

    // Net spend remains exactly user share ₹1,000
    assert.equal(data.thisMonthTotal, 100000)
    // Gross outflow remains ₹3,000
    assert.equal(data.thisMonthGrossOutflow, 300000)

    // Recoverable ledger metrics
    assert.equal(data.thisMonthRecoverableTotal, 200000)
    assert.equal(data.thisMonthRepaidTotal, 100000)
    assert.equal(data.thisMonthPendingDuesTotal, 100000)
    assert.equal(data.allTimePendingDuesTotal, 100000)
    assert.equal(data.allTimeRepaidTotal, 100000)
  })

  it('5. handles legacy type="reimbursable" transactions safely', () => {
    const legacyTx = createTx({
      amountPaise: 250000, // ₹2,500
      type: 'reimbursable',
      recoverablePaise: undefined,
      splits: undefined,
      personId: 'legacy-person-1',
    })

    const data = deriveDashboardData([legacyTx], mockCategories, mockAccounts)

    // Legacy reimbursable has 0 net spend
    assert.equal(data.thisMonthTotal, 0)
    assert.equal(data.reimbursableTotal, 0)
    assert.equal(data.thisMonthGrossOutflow, 250000)
    assert.equal(data.thisMonthRecoverableTotal, 250000)
    assert.equal(data.thisMonthPendingDuesTotal, 250000)
  })

  it('6. aggregates 6-month monthly trends using net spend', () => {
    // Current month: ₹2,000 gross, ₹1,500 recoverable -> ₹500 net
    const curMonthTx = createTx({
      date: dummyDate as any,
      amountPaise: 200000,
      recoverablePaise: 150000,
    })

    // Last month: ₹5,000 personal spend
    const lastMonthTx = createTx({
      date: lastMonthDate as any,
      amountPaise: 500000,
      recoverablePaise: 0,
    })

    // 3 months ago: ₹10,000 gross, ₹10,000 recoverable -> ₹0 net
    const oldTx = createTx({
      date: threeMonthsAgoDate as any,
      amountPaise: 1000000,
      recoverablePaise: 1000000,
    })

    const data = deriveDashboardData([curMonthTx, lastMonthTx, oldTx], mockCategories, mockAccounts)

    assert.equal(data.thisMonthTotal, 50000) // ₹500
    assert.equal(data.lastMonthTotal, 500000) // ₹5,000

    // Pct change vs last month: (500 - 5000) / 5000 = -90%
    assert.equal(data.pctChange, -90)

    // Check monthly trend totals
    const currentTrend = data.monthlyTotals[data.monthlyTotals.length - 1]
    assert.equal(currentTrend.totalPaise, 50000)

    const lastTrend = data.monthlyTotals[data.monthlyTotals.length - 2]
    assert.equal(lastTrend.totalPaise, 500000)
  })

  it('7. ranks biggest expenses by net spend and filters micro spending by net share', () => {
    // Expense A: ₹50,000 gross, but 100% recoverable (net spend = 0)
    const txA = createTx({ id: 'tx-A', amountPaise: 5000000, recoverablePaise: 5000000, description: 'Office Equipment' })

    // Expense B: ₹4,000 personal (net spend = ₹4,000)
    const txB = createTx({ id: 'tx-B', amountPaise: 400000, recoverablePaise: 0, description: 'Weekend Stay' })

    // Expense C: ₹6,000 split, user share = ₹2,000 (net spend = ₹2,000)
    const txC = createTx({ id: 'tx-C', amountPaise: 600000, recoverablePaise: 400000, description: 'Team Outing' })

    // Expense D: ₹80 personal micro purchase
    const txD = createTx({ id: 'tx-D', amountPaise: 8000, recoverablePaise: 0, description: 'Chai' })

    // Expense E: ₹120 gross split in half (net share = ₹60 <= ₹100 micro spend)
    const txE = createTx({ id: 'tx-E', amountPaise: 12000, recoverablePaise: 6000, description: 'Snacks shared' })

    // Expense F: ₹80 gross but 100% recoverable (net share = 0 -> not micro spend purchase)
    const txF = createTx({ id: 'tx-F', amountPaise: 8000, recoverablePaise: 8000, description: 'Friend chai' })

    const data = deriveDashboardData([txA, txB, txC, txD, txE, txF], mockCategories, mockAccounts)

    // Biggest expenses sorted by net spend: txB (₹4,000) > txC (₹2,000) > txD (₹80) > txE (₹60) > txA (₹0)
    assert.equal(data.biggestExpenses[0].id, 'tx-B')
    assert.equal(data.biggestExpenses[1].id, 'tx-C')
    assert.equal(data.biggestExpenses[2].id, 'tx-D')
    assert.equal(data.biggestExpenses[3].id, 'tx-E')

    // Micro transactions: txD (₹80) and txE (₹60). txF (₹0 net) excluded.
    assert.equal(data.microCount, 2)
    assert.equal(data.microTotal, 14000) // ₹140
    assert.equal(data.microAvg, 7000) // ₹70
  })

  it('8. accumulates historical all-time pending dues across all 6 months', () => {
    // Current month: ₹2,000 fronted, fully repaid
    const tx1 = createTx({
      date: dummyDate as any,
      amountPaise: 200000,
      recoverablePaise: 200000,
      splits: [{ personId: 'p-1', personName: 'Aarav', amountPaise: 200000, repaidPaise: 200000, settledAt: dummyDate as any }],
    })

    // 3 months ago: ₹5,000 fronted, ₹0 repaid (pending)
    const tx2 = createTx({
      date: threeMonthsAgoDate as any,
      amountPaise: 500000,
      recoverablePaise: 500000,
      splits: [{ personId: 'p-2', personName: 'Meera', amountPaise: 500000, repaidPaise: 0, settledAt: null }],
    })

    const data = deriveDashboardData([tx1, tx2], mockCategories, mockAccounts)

    // This month has 0 pending
    assert.equal(data.thisMonthRecoverableTotal, 200000)
    assert.equal(data.thisMonthRepaidTotal, 200000)
    assert.equal(data.thisMonthPendingDuesTotal, 0)

    // All-time has ₹5,000 pending from 3 months ago
    assert.equal(data.allTimeRecoverableTotal, 700000)
    assert.equal(data.allTimeRepaidTotal, 200000)
    assert.equal(data.allTimePendingDuesTotal, 500000)
  })
})
