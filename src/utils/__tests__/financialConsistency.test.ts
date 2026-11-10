import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Timestamp } from 'firebase/firestore'
import { parseTransactionDate } from '../format.ts'
import { generateTransactionsCSV } from '../csvExportMath.ts'
import { calculateTripDayTotals, calculateTripAccountingSummary } from '../tripBuckets.ts'
import type { Transaction, Trip, Category, PaymentAccount } from '../../types/index.ts'

describe('Phase 8.2.3 — Financial Consistency & Robust Date Parsing', () => {
  describe('parseTransactionDate parsing matrix', () => {
    it('parses Firestore Timestamp instance with .toDate()', () => {
      const ts = Timestamp.fromDate(new Date('2025-06-15T12:00:00.000Z'))
      const parsed = parseTransactionDate(ts)
      assert.ok(parsed instanceof Date)
      assert.equal(parsed.toISOString(), '2025-06-15T12:00:00.000Z')
    })

    it('parses Firestore timestamp POJO from offline cache / JSON serialization ({ seconds, nanoseconds })', () => {
      const pojo = { seconds: 1750000000, nanoseconds: 0 }
      const parsed = parseTransactionDate(pojo)
      assert.ok(parsed instanceof Date)
      assert.equal(parsed.getTime(), 1750000000 * 1000)
    })

    it('parses native JavaScript Date object', () => {
      const d = new Date('2025-01-01T00:00:00.000Z')
      const parsed = parseTransactionDate(d)
      assert.ok(parsed instanceof Date)
      assert.equal(parsed.getTime(), d.getTime())
    })

    it('parses ISO date string and date-only string', () => {
      const parsedIso = parseTransactionDate('2025-04-20T10:30:00.000Z')
      assert.ok(parsedIso instanceof Date)
      assert.equal(parsedIso.toISOString(), '2025-04-20T10:30:00.000Z')

      const parsedDateOnly = parseTransactionDate('2025-04-20')
      assert.ok(parsedDateOnly instanceof Date)
      assert.ok(!Number.isNaN(parsedDateOnly.getTime()))
    })

    it('parses numeric epoch millisecond timestamp', () => {
      const millis = 1740000000000
      const parsed = parseTransactionDate(millis)
      assert.ok(parsed instanceof Date)
      assert.equal(parsed.getTime(), millis)
    })

    it('returns null safely without throwing on null, undefined, empty string, malformed strings or corrupt objects', () => {
      assert.equal(parseTransactionDate(null), null)
      assert.equal(parseTransactionDate(undefined), null)
      assert.equal(parseTransactionDate(''), null)
      assert.equal(parseTransactionDate('not-a-date'), null)
      assert.equal(parseTransactionDate({}), null)
      assert.equal(parseTransactionDate([]), null)
      assert.equal(parseTransactionDate({ toDate: 'not-a-func' }), null)
      assert.equal(parseTransactionDate({ toDate: () => { throw new Error('corrupt') } }), null)
      assert.equal(parseTransactionDate(NaN), null)
    })
  })

  describe('Legacy transactions with missing or malformed dates in CSV export & Trip accounting', () => {
    const validCategory: Category = { id: 'food', name: 'Food', color: '#F59E0B', icon: '🍽️', isArchived: false }
    const validAccount: PaymentAccount = { id: 'acc-1', name: 'HDFC', type: 'Bank', isDefault: true, isArchived: false, createdAt: Timestamp.now() }

    it('exportTransactionsToCsv survives transactions with null, undefined, or malformed dates without throwing RangeError', () => {
      const txns: Transaction[] = [
        {
          id: 'tx-valid',
          amountPaise: 50000,
          description: 'Valid expense',
          categoryId: 'food',
          type: 'everyday',
          date: Timestamp.fromDate(new Date('2025-05-10T10:00:00.000Z')),
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now(),
          paymentMode: 'Bank Transfer',
          paymentAccountId: 'acc-1',
          tripId: null,
          personId: null,
          tags: [],
          notes: '',
          receiptUrl: null,
          recoverablePaise: 0,
          reimbursementStatus: 'none',
          splits: [],
        },
        {
          id: 'tx-null-date',
          amountPaise: 25000,
          description: 'Legacy missing date',
          categoryId: 'food',
          type: 'everyday',
          date: null as any,
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now(),
          paymentMode: 'Cash',
          paymentAccountId: null,
          tripId: null,
          personId: null,
          tags: [],
          notes: '',
          receiptUrl: null,
          recoverablePaise: 0,
          reimbursementStatus: 'none',
          splits: [],
        },
        {
          id: 'tx-malformed-date',
          amountPaise: 15000,
          description: 'Legacy corrupt date',
          categoryId: 'food',
          type: 'everyday',
          date: 'invalid-date-string' as any,
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now(),
          paymentMode: 'Cash',
          paymentAccountId: null,
          tripId: null,
          personId: null,
          tags: [],
          notes: '',
          receiptUrl: null,
          recoverablePaise: 0,
          reimbursementStatus: 'none',
          splits: [],
        },
      ]

      // Must not throw RangeError: Invalid time value
      const csv = generateTransactionsCSV(txns, [validCategory], [validAccount])
      assert.ok(csv.includes('2025-05-10'))
      assert.ok(csv.includes('Valid expense'))
      assert.ok(csv.includes('Legacy missing date'))
      assert.ok(csv.includes('Legacy corrupt date'))
      assert.ok(csv.includes('500.00'))
      assert.ok(csv.includes('250.00'))
      assert.ok(csv.includes('150.00'))
    })

    it('calculateTripDayTotals & calculateTripAccountingSummary survive transactions with missing dates without throwing', () => {
      const trip: Trip = {
        id: 'trip-1',
        name: 'Goa',
        startDate: Timestamp.fromDate(new Date('2025-01-01T00:00:00.000Z')),
        endDate: Timestamp.fromDate(new Date('2025-01-03T00:00:00.000Z')),
        budgetPaise: 1000000,
        coverEmoji: '✈️',
        coverColor: '#06B6D4',
        isArchived: false,
        notes: '',
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      }

      const txns: Transaction[] = [
        {
          id: 'tx-1',
          amountPaise: 30000,
          description: 'Valid day 1 expense',
          categoryId: 'food',
          type: 'trip',
          date: Timestamp.fromDate(new Date('2025-01-01T12:00:00.000Z')),
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now(),
          paymentMode: 'Cash',
          paymentAccountId: null,
          tripId: 'trip-1',
          personId: null,
          tags: [],
          notes: '',
          receiptUrl: null,
          recoverablePaise: 0,
          reimbursementStatus: 'none',
          splits: [],
        },
        {
          id: 'tx-2',
          amountPaise: 20000,
          description: 'Missing date expense',
          categoryId: 'food',
          type: 'trip',
          date: null as any,
          createdAt: Timestamp.now(),
          updatedAt: Timestamp.now(),
          paymentMode: 'Cash',
          paymentAccountId: null,
          tripId: 'trip-1',
          personId: null,
          tags: [],
          notes: '',
          receiptUrl: null,
          recoverablePaise: 0,
          reimbursementStatus: 'none',
          splits: [],
        },
      ]

      // Day totals must not throw
      const dayTotals = calculateTripDayTotals(
        txns,
        new Date('2025-01-01T00:00:00.000Z'),
        new Date('2025-01-03T00:00:00.000Z')
      )
      assert.equal(dayTotals.length, 3)
      assert.equal(dayTotals[0].totalPaise, 30000)

      // Accounting summary includes all transactions in net/gross spend regardless of date validity
      const summary = calculateTripAccountingSummary(trip, txns, [validCategory])
      assert.equal(summary.totalNetSpendPaise, 50000)
      assert.equal(summary.totalGrossOutflowPaise, 50000)
    })
  })

  describe('Archived entities filtering vs historical resolution', () => {
    it('active entity filtering excludes archived records from new choices while preserving them for existing selections', () => {
      const categories: Category[] = [
        { id: 'cat-active', name: 'Active Cat', color: '#10B981', icon: '📁', isArchived: false },
        { id: 'cat-archived-1', name: 'Old Cat 1', color: '#6B7280', icon: '📁', isArchived: true },
        { id: 'cat-archived-2', name: 'Old Cat 2', color: '#6B7280', icon: '📁', isArchived: true },
      ]

      // When creating a new expense (no editTransaction)
      const newChoices = categories.filter(c => !c.isArchived)
      assert.equal(newChoices.length, 1)
      assert.equal(newChoices[0].id, 'cat-active')

      // When editing an expense linked to cat-archived-1
      const editTxCategoryId = 'cat-archived-1'
      const editChoices = categories.filter(c => !c.isArchived || c.id === editTxCategoryId)
      assert.equal(editChoices.length, 2)
      assert.ok(editChoices.some(c => c.id === 'cat-active'))
      assert.ok(editChoices.some(c => c.id === 'cat-archived-1'))
      assert.ok(!editChoices.some(c => c.id === 'cat-archived-2'))
    })
  })
})
