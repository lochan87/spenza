import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as dateFns from 'date-fns'
import * as archiveHelpers from '../../utils/financialExport.ts'
import { assertExpenseCanBeDeleted, ExpenseDeletionError, repaymentDeletionMessage } from '../../utils/expenseDeletion.ts'
import { exportCompleteFinancialData } from '../financialBackup.ts'
import type { Transaction } from '../../types/index.ts'

it('exports missing-date documents and authoritative identities through the real service without modifying raw data', async () => {
  const raw = { id: 'conflicting-id', amountPaise: '100.50', legacyExtra: { evidence: -2 } }
  const stored = { ...raw }
  let download: Blob | undefined
  let clicks = 0
  const exports = {} as { exportCompleteFinancialData: (uid: string, db: unknown) => Promise<{ transactionCount: number; success: boolean }> }
  const source = readFileSync(new URL('../financialBackup.ts', import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, {
    exports, Date, Blob, navigator: { onLine: true },
    URL: { createObjectURL: (blob: Blob) => { download = blob; return 'blob:test' }, revokeObjectURL: () => {} },
    document: { createElement: () => ({ click: () => { clicks++ } }), body: { appendChild: () => {}, removeChild: () => {} } },
    require: (name: string) => {
      if (name === 'date-fns') return dateFns
      if (name === '../utils/financialExport.ts') return archiveHelpers
      if (name === 'firebase/firestore') return {
        collection: (_db: unknown, ...path: string[]) => {
          assert.equal(path[0], 'users'); assert.equal(path[1], 'owner')
          return path.join('/')
        },
        query: () => assert.fail('Archive reads must not filter documents by date'),
        orderBy: () => assert.fail('Archive reads must not omit missing dates'),
        getDocs: async (path: string) => ({ docs: [{ id: 'actual', ref: { path: `${path}/actual` }, data: () => raw }] }),
      }
      throw new Error(name)
    },
  })
  const result = await exports.exportCompleteFinancialData('owner', {})
  assert.equal(result.success, true)
  assert.equal(result.transactionCount, 1)
  assert.equal(clicks, 1)
  const document = JSON.parse(await download!.text()) as archiveHelpers.FinancialExportDocument
  for (const collection of archiveHelpers.archiveCollections) {
    const record = document.data[collection][0]
    assert.equal(record.id, 'actual')
    assert.equal(record.path, `users/owner/${collection}/actual`)
    assert.deepEqual(archiveHelpers.deserializeValue(record.data), stored)
  }
  assert.deepEqual(raw, stored)
})

describe('financialBackup & Destructive Operation Safeguards (Phase 8.1)', () => {
  it('1. exportCompleteFinancialData rejects missing or invalid UID', async () => {
    await assert.rejects(
      async () => {
        await exportCompleteFinancialData('')
      },
      /User UID is required/
    )

    await assert.rejects(
      async () => {
        await exportCompleteFinancialData('   ')
      },
      /User UID is required/
    )
  })

  it('2. destructive safeguard: assertExpenseCanBeDeleted blocks deletion of partially repaid expenses', () => {
    const tx: Transaction = {
      id: 'tx-part-repaid',
      amountPaise: 5000,
      type: 'everyday',
      description: 'Dinner',
      categoryId: 'food',
      date: new Date(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 2500,
      reimbursementStatus: 'partial',
      splits: [
        {
          personId: 'p-1',
          personName: 'Alice',
          amountPaise: 5000,
          repaidPaise: 2500,
          settledAt: null,
        },
      ],
    } as any

    assert.throws(
      () => {
        assertExpenseCanBeDeleted(tx)
      },
      (err: any) => {
        assert.ok(err instanceof ExpenseDeletionError)
        assert.equal(err.message, repaymentDeletionMessage)
        return true
      }
    )
  })

  it('3. destructive safeguard: assertExpenseCanBeDeleted blocks deletion of fully settled expenses', () => {
    const tx: Transaction = {
      id: 'tx-settled',
      amountPaise: 5000,
      type: 'everyday',
      description: 'Movie ticket',
      categoryId: 'entertainment',
      date: new Date(),
      paymentMode: 'UPI',
      paymentAccountId: 'acc-1',
      recoverablePaise: 0,
      reimbursementStatus: 'settled',
      splits: [
        {
          personId: 'p-1',
          personName: 'Alice',
          amountPaise: 5000,
          repaidPaise: 5000,
          settledAt: new Date(),
        },
      ],
    } as any

    assert.throws(
      () => {
        assertExpenseCanBeDeleted(tx)
      },
      (err: any) => {
        assert.ok(err instanceof ExpenseDeletionError)
        assert.equal(err.message, repaymentDeletionMessage)
        return true
      }
    )
  })

  it('4. destructive safeguard: blocks deletion when split item has repaidPaise > 0 even if status is not partial/settled', () => {
    const tx: Transaction = {
      id: 'tx-status-none-but-repaid',
      amountPaise: 5000,
      type: 'everyday',
      description: 'Cab fare',
      categoryId: 'travel',
      date: new Date(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 5000,
      reimbursementStatus: 'none',
      splits: [
        {
          personId: 'p-1',
          personName: 'Bob',
          amountPaise: 5000,
          repaidPaise: 1000,
          settledAt: null,
        },
      ],
    } as any

    assert.throws(
      () => {
        assertExpenseCanBeDeleted(tx)
      },
      (err: any) => {
        assert.ok(err instanceof ExpenseDeletionError)
        assert.equal(err.message, repaymentDeletionMessage)
        return true
      }
    )
  })

  it('5. destructive safeguard: allows deletion of clean unpaid expenses and personal expenses', () => {
    // Unpaid split expense
    const unpaidSplit: Transaction = {
      id: 'tx-unpaid-split',
      amountPaise: 4000,
      type: 'everyday',
      description: 'Unpaid coffee',
      categoryId: 'food',
      date: new Date(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 4000,
      reimbursementStatus: 'pending',
      splits: [
        {
          personId: 'p-1',
          personName: 'Charlie',
          amountPaise: 4000,
          repaidPaise: 0,
          settledAt: null,
        },
      ],
    } as any

    // Should not throw
    assert.doesNotThrow(() => {
      assertExpenseCanBeDeleted(unpaidSplit)
    })

    // Unsplit personal expense
    const personal: Transaction = {
      id: 'tx-personal',
      amountPaise: 1500,
      type: 'everyday',
      description: 'Personal lunch',
      categoryId: 'food',
      date: new Date(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 0,
      reimbursementStatus: 'none',
      splits: [],
    } as any

    // Should not throw
    assert.doesNotThrow(() => {
      assertExpenseCanBeDeleted(personal)
    })
  })
})

