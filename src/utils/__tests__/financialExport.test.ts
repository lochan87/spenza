import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  serializeTimestamp,
  serializeTransaction,
  buildFinancialExportDocument,
  validateExportIntegrity,
} from '../financialExport.ts'
import type { Transaction, Category, PaymentAccount, Person } from '../../types/index.ts'

describe('financialExport — Complete Financial Archive & Safeguards', () => {
  const mockCategories: Category[] = [
    { id: 'cat-1', name: 'Food', icon: 'utensils', color: '#ff0000', isArchived: false },
    { id: 'cat-2', name: 'Travel', icon: 'plane', color: '#00ff00', isArchived: false },
  ]

  const mockAccounts: PaymentAccount[] = [
    { id: 'acc-1', name: 'HDFC Bank', type: 'Bank', isDefault: true, isArchived: false, createdAt: { seconds: 1700000000, nanoseconds: 0 } as any },
    { id: 'acc-2', name: 'Google Pay', type: 'UPI', isDefault: false, isArchived: false, createdAt: { seconds: 1700000000, nanoseconds: 0 } as any },
  ]

  const mockPeople: Person[] = [
    { id: 'p-1', name: 'Alice', isArchived: false, createdAt: { seconds: 1700000000, nanoseconds: 0 } as any },
    { id: 'p-2', name: 'Bob', isArchived: false, createdAt: { seconds: 1700001000, nanoseconds: 0 } as any },
  ]

  it('1. serializes timestamps losslessly across Firestore timestamps, Dates, and seconds', () => {
    // Firestore Timestamp double with toDate()
    const tsDouble = {
      seconds: 1700000000,
      nanoseconds: 500000,
      toDate: () => new Date('2023-11-14T22:13:20.000Z'),
    }
    const s1 = serializeTimestamp(tsDouble)
    assert.ok(s1)
    assert.equal(s1.seconds, 1700000000)
    assert.equal(s1.nanoseconds, 500000)
    assert.equal(s1.iso, '2023-11-14T22:13:20.000Z')

    // Native JS Date
    const d = new Date('2024-01-01T00:00:00.000Z')
    const s2 = serializeTimestamp(d)
    assert.ok(s2)
    assert.equal(s2.seconds, Math.floor(d.getTime() / 1000))
    assert.equal(s2.iso, '2024-01-01T00:00:00.000Z')

    // Null or undefined
    assert.equal(serializeTimestamp(null), null)
    assert.equal(serializeTimestamp(undefined), null)
  })

  it('2. serializes transactions preserving exact integer paise and split details without float conversion', () => {
    const tx: Transaction = {
      id: 'tx-split-123',
      amountPaise: 10003, // ₹100.03
      type: 'everyday',
      description: 'Dinner with friends',
      categoryId: 'cat-1',
      date: new Date('2026-03-01T19:00:00Z') as any,
      paymentMode: 'UPI',
      paymentAccountId: 'acc-2',
      tripId: 'trip-bali',
      personId: null,
      tags: ['dinner', 'vacation'],
      notes: 'Split three ways with remainder',
      receiptUrl: 'https://example.com/receipt.jpg',
      recoverablePaise: 6668,
      reimbursementStatus: 'partial',
      splits: [
        {
          personId: 'p-1',
          personName: 'Alice',
          amountPaise: 3334,
          repaidPaise: 3334,
          settledAt: new Date('2026-03-02T10:00:00Z') as any,
        },
        {
          personId: 'p-2',
          personName: 'Bob',
          amountPaise: 3334,
          repaidPaise: 1000,
          settledAt: null,
        },
      ],
      createdAt: new Date('2026-03-01T19:05:00Z') as any,
      updatedAt: new Date('2026-03-02T10:05:00Z') as any,
      isImported: true,
      importSource: 'excel',
      importOperationId: 'op-42',
    }

    const s = serializeTransaction(tx)

    // Values remain strict integer paise
    assert.equal(s.id, 'tx-split-123')
    assert.equal(s.amountPaise, 10003)
    assert.equal(s.recoverablePaise, 6668)
    assert.equal(s.splits.length, 2)
    assert.equal(s.splits[0].amountPaise, 3334)
    assert.equal(s.splits[0].repaidPaise, 3334)
    assert.ok(s.splits[0].settledAt)
    assert.equal(s.splits[1].amountPaise, 3334)
    assert.equal(s.splits[1].repaidPaise, 1000)
    assert.equal(s.splits[1].settledAt, null)

    // Relationships preserved
    assert.equal(s.categoryId, 'cat-1')
    assert.equal(s.paymentAccountId, 'acc-2')
    assert.equal(s.tripId, 'trip-bali')
    assert.equal(s.isImported, true)
    assert.equal(s.importSource, 'excel')
  })

  it('3. handles legacy transactions without splits or reimbursementStatus safely', () => {
    const legacyTx: Transaction = {
      id: 'legacy-unsplit',
      amountPaise: 5000,
      type: 'reimbursable',
      description: 'Legacy office stationery',
      categoryId: 'cat-2',
      date: new Date('2022-05-10T00:00:00Z'),
      paymentMode: 'Cash',
      paymentAccountId: null,
      personId: 'p-1',
      recoverablePaise: 5000,
    } as any

    const s = serializeTransaction(legacyTx)
    assert.equal(s.amountPaise, 5000)
    assert.equal(s.recoverablePaise, 5000)
    assert.equal(s.splits.length, 0)
    assert.equal(s.personId, 'p-1')
    assert.equal(s.reimbursementStatus, 'none')
  })

  it('4. builds full financial export document with accurate summary totals', () => {
    const tx1: Transaction = {
      id: 'tx-1',
      amountPaise: 10000,
      type: 'everyday',
      description: 'Personal grocery',
      categoryId: 'cat-1',
      date: new Date('2026-01-01'),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 0,
      reimbursementStatus: 'none',
      splits: [],
    } as any

    const tx2: Transaction = {
      id: 'tx-2',
      amountPaise: 6000,
      type: 'everyday',
      description: 'Shared taxi',
      categoryId: 'cat-2',
      date: new Date('2026-01-02'),
      paymentMode: 'UPI',
      paymentAccountId: 'acc-2',
      recoverablePaise: 4000,
      reimbursementStatus: 'partial',
      splits: [{ personId: 'p-1', personName: 'Alice', amountPaise: 4000, repaidPaise: 1500, settledAt: null }],
    } as any

    const doc = buildFinancialExportDocument({
      uid: 'user-export-test',
      transactions: [tx1, tx2],
      categories: mockCategories,
      paymentAccounts: mockAccounts,
      people: mockPeople,
      now: new Date('2026-11-08T12:00:00Z'),
    })

    assert.equal(doc.format, 'spenza-financial-export')
    assert.equal(doc.version, 1)
    assert.equal(doc.uid, 'user-export-test')
    assert.equal(doc.metadata.transactionCount, 2)
    assert.equal(doc.metadata.categoryCount, 2)
    assert.equal(doc.metadata.paymentAccountCount, 2)
    assert.equal(doc.metadata.peopleCount, 2)

    // Total gross: 10000 + 6000 = 16000 paise
    assert.equal(doc.metadata.totalGrossPaise, 16000)
    // Total recoverable: 0 + 4000 = 4000 paise
    assert.equal(doc.metadata.totalRecoverablePaise, 4000)
    // Total net: 10000 + (6000 - 4000) = 12000 paise
    assert.equal(doc.metadata.totalNetPaise, 12000)
    // Total repaid: 0 + 1500 = 1500 paise
    assert.equal(doc.metadata.totalRepaidPaise, 1500)

    // Integrity check
    const check = validateExportIntegrity(doc)
    assert.equal(check.valid, true)
    assert.equal(check.errors.length, 0)
  })

  it('5. validateExportIntegrity detects corrupted or mismatched export documents', () => {
    const doc = buildFinancialExportDocument({
      uid: 'user-test',
      transactions: [
        {
          id: 'tx-1',
          amountPaise: 5000,
          recoverablePaise: 2000,
          splits: [{ personId: 'p-1', personName: 'P1', amountPaise: 2000, repaidPaise: 0, settledAt: null }],
        } as any,
      ],
      categories: [],
      paymentAccounts: [],
      people: [],
    })

    // Tamper with metadata transactionCount
    const tamperedCount = { ...doc, metadata: { ...doc.metadata, transactionCount: 99 } }
    const res1 = validateExportIntegrity(tamperedCount)
    assert.equal(res1.valid, false)
    assert.match(res1.errors[0], /Transaction count mismatch/)

    // Tamper with totalGrossPaise
    const tamperedGross = { ...doc, metadata: { ...doc.metadata, totalGrossPaise: 99999 } }
    const res2 = validateExportIntegrity(tamperedGross)
    assert.equal(res2.valid, false)
    assert.match(res2.errors[0], /Total gross paise mismatch/)

    // Corrupted split amount (negative)
    const tamperedDoc = JSON.parse(JSON.stringify(doc))
    tamperedDoc.data.transactions[0].splits[0].amountPaise = -500
    const res3 = validateExportIntegrity(tamperedDoc)
    assert.equal(res3.valid, false)
    assert.match(res3.errors[0], /split has invalid amountPaise/)
  })
})
