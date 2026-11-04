import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateTransactionsCSV, csvField, csvRow } from '../../utils/csvExportMath.ts'
import type { Category, PaymentAccount, Transaction } from '../../types/index.ts'

describe('exportCsv — Transactions CSV Generation & Accounting Completeness', () => {
  const dummyDate = (isoStr: string) => ({
    toDate: () => new Date(isoStr),
    seconds: Math.floor(new Date(isoStr).getTime() / 1000),
    nanoseconds: 0,
  }) as any

  const mockCategories: Category[] = [
    { id: 'cat-dining', name: 'Dining Out', color: '#ff5722', icon: 'utensils', isArchived: false },
    { id: 'cat-travel', name: 'Travel & Trips', color: '#2196f3', icon: 'plane', isArchived: false },
    { id: 'cat-rent', name: 'Rent & Housing', color: '#4caf50', icon: 'home', isArchived: false },
  ]

  const mockAccounts: PaymentAccount[] = [
    {
      id: 'acc-hdfc',
      name: 'HDFC Salary A/c',
      type: 'Bank',
      isDefault: true,
      isArchived: false,
      createdAt: dummyDate('2026-01-01T00:00:00.000Z'),
    },
    {
      id: 'acc-icici-cc',
      name: 'ICICI Sapphiro Card',
      type: 'Card',
      isDefault: false,
      isArchived: false,
      createdAt: dummyDate('2026-01-01T00:00:00.000Z'),
    },
  ]

  function createTx(overrides: Partial<Transaction> = {}): Transaction {
    return {
      id: 'tx-' + Math.random().toString(36).substring(2, 9),
      amountPaise: 100000, // ₹1,000
      description: 'Dinner with friends',
      categoryId: 'cat-dining',
      type: 'everyday',
      date: dummyDate('2026-11-04T12:00:00.000Z'),
      paymentMode: 'UPI',
      paymentAccountId: 'acc-hdfc',
      tripId: null,
      personId: null,
      tags: [],
      notes: '',
      receiptUrl: null,
      createdAt: dummyDate('2026-11-04T12:00:00.000Z'),
      updatedAt: dummyDate('2026-11-04T12:00:00.000Z'),
      ...overrides,
    }
  }

  it('1. formats CSV fields safely escaping commas, quotes, and newlines', () => {
    assert.equal(csvField('Simple text'), 'Simple text')
    assert.equal(csvField('Dinner, drinks'), '"Dinner, drinks"')
    assert.equal(csvField('Quoted "special" value'), '"Quoted ""special"" value"')
    assert.equal(csvField('Line 1\nLine 2'), '"Line 1\nLine 2"')
    assert.equal(csvField(null), '')
    assert.equal(csvField(undefined), '')

    const row = csvRow(['2026-11-04', 'Dinner, drinks', 1000, null])
    assert.equal(row, '2026-11-04,"Dinner, drinks",1000,')
  })

  it('2. includes all 18 required CSV header columns', () => {
    const csv = generateTransactionsCSV([], mockCategories, mockAccounts)
    const [header] = csv.split('\n')

    const expectedHeader =
      'Date,Description,Gross Amount (₹),Net Amount (₹),Recoverable (₹),Repaid (₹),Pending Dues (₹),Reimbursement Status,Split Breakdown,Category,Type,Payment Mode,Account,Trip ID,Notes,Is Imported,Import Source,ID'

    assert.equal(header, expectedHeader)
  })

  it('3. exports standard personal transaction where Gross equals Net and Recoverable is zero', () => {
    const tx = createTx({
      id: 'tx-personal-1',
      amountPaise: 45000, // ₹450
      description: 'Cafe coffee',
      categoryId: 'cat-dining',
      notes: 'Solo coffee',
    })

    const csv = generateTransactionsCSV([tx], mockCategories, mockAccounts)
    const lines = csv.split('\n')

    assert.equal(lines.length, 2)
    const row = lines[1]
    const fields = row.split(',')

    assert.equal(fields[0], '2026-11-04')
    assert.equal(fields[1], 'Cafe coffee')
    assert.equal(fields[2], '450.00') // Gross
    assert.equal(fields[3], '450.00') // Net
    assert.equal(fields[4], '0.00')   // Recoverable
    assert.equal(fields[5], '0.00')   // Repaid
    assert.equal(fields[6], '0.00')   // Pending Dues
    assert.equal(fields[7], 'none')   // Reimbursement Status
    assert.equal(fields[8], '')       // Split Breakdown
    assert.equal(fields[9], 'Dining Out')
    assert.equal(fields[12], 'HDFC Salary A/c')
    assert.equal(fields[14], 'Solo coffee')
  })

  it('4. exports shared split transaction with partial repayments and participant breakdown', () => {
    // ₹3,000 dinner: User ₹1,000, Alice ₹1,000 (repaid ₹1,000), Bob ₹1,000 (unpaid)
    const tx = createTx({
      id: 'tx-shared-1',
      amountPaise: 300000, // ₹3,000
      description: 'Team Dinner',
      recoverablePaise: 200000,
      reimbursementStatus: 'partial',
      splits: [
        { personId: 'p-alice', personName: 'Alice', amountPaise: 100000, repaidPaise: 100000 },
        { personId: 'p-bob', personName: 'Bob', amountPaise: 100000, repaidPaise: 0 },
      ],
    })

    const csv = generateTransactionsCSV([tx], mockCategories, mockAccounts)
    const lines = csv.split('\n')
    assert.equal(lines.length, 2)

    const row = lines[1]
    assert.match(row, /3000\.00/) // Gross
    assert.match(row, /1000\.00/) // Net
    assert.match(row, /2000\.00/) // Recoverable
    assert.match(row, /partial/)   // Status
    assert.match(row, /Alice: ₹1000\.00 \(Repaid: ₹1000\.00\); Bob: ₹1000\.00 \(Repaid: ₹0\.00\)/)
  })

  it('5. exports 100% recoverable transactions where Net spend is zero', () => {
    // Hotel booking fronted for Charlie: ₹5,000
    const tx = createTx({
      id: 'tx-recov-1',
      amountPaise: 500000,
      description: 'Charlie Hotel Stay',
      categoryId: 'cat-travel',
      recoverablePaise: 500000,
      reimbursementStatus: 'pending',
      splits: [
        { personId: 'p-charlie', personName: 'Charlie', amountPaise: 500000, repaidPaise: 0 },
      ],
    })

    const csv = generateTransactionsCSV([tx], mockCategories, mockAccounts)
    const lines = csv.split('\n')
    const fields = lines[1].split(',')

    assert.equal(fields[2], '5000.00') // Gross
    assert.equal(fields[3], '0.00')    // Net spend is 0
    assert.equal(fields[4], '5000.00') // Recoverable
    assert.equal(fields[5], '0.00')    // Repaid
    assert.equal(fields[6], '5000.00') // Pending
    assert.equal(fields[7], 'pending')
  })

  it('6. exports fully settled shared transactions cleanly', () => {
    const tx = createTx({
      id: 'tx-settled-1',
      amountPaise: 200000,
      description: 'Groceries split',
      recoverablePaise: 100000,
      reimbursementStatus: 'settled',
      splits: [
        { personId: 'p-alice', personName: 'Alice', amountPaise: 100000, repaidPaise: 100000 },
      ],
    })

    const csv = generateTransactionsCSV([tx], mockCategories, mockAccounts)
    const lines = csv.split('\n')
    const fields = lines[1].split(',')

    assert.equal(fields[2], '2000.00') // Gross
    assert.equal(fields[3], '1000.00') // Net
    assert.equal(fields[4], '1000.00') // Recoverable
    assert.equal(fields[5], '1000.00') // Repaid
    assert.equal(fields[6], '0.00')    // Pending
    assert.equal(fields[7], 'settled')
  })

  it('7. safely handles legacy reimbursable transactions without explicit splits', () => {
    const tx = createTx({
      id: 'tx-legacy-1',
      type: 'reimbursable',
      amountPaise: 120000,
      description: 'Client lunch',
      personId: 'Client XYZ',
      recoverablePaise: undefined,
      splits: undefined,
    })

    const csv = generateTransactionsCSV([tx], mockCategories, mockAccounts)
    const lines = csv.split('\n')
    const fields = lines[1].split(',')

    assert.equal(fields[2], '1200.00') // Gross
    assert.equal(fields[3], '0.00')    // Net
    assert.equal(fields[4], '1200.00') // Recoverable
    assert.equal(fields[7], 'pending')
  })
})
