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

function backupHarness(options: { failPath?: string; cache?: boolean; pending?: boolean; pendingDocument?: boolean; changePath?: string; emptyPath?: string } = {}) {
  const raw = { id: 'conflicting-id', amountPaise: '100.50', legacyExtra: { evidence: -2 } }
  let download: Blob | undefined
  let clicks = 0
  const reads = new Map<string, number>()
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
        collection: (_db: unknown, path: string) => { assert.ok(path.startsWith('users/owner/')); return path },
        getDocs: () => assert.fail('Server-only reads required'),
        query: () => assert.fail('Archive reads must not filter documents by date'),
        getDocsFromServer: async (path: string) => {
          const pass = (reads.get(path) ?? 0) + 1
          reads.set(path, pass)
          if (path === options.failPath) throw new Error('Server read failed')
          return {
            metadata: { fromCache: !!options.cache, hasPendingWrites: !!options.pending },
            docs: path === options.emptyPath ? [] : [{ id: 'actual', ref: { path: `${path}/actual` },
              metadata: { fromCache: false, hasPendingWrites: !!options.pendingDocument },
              data: () => path === options.changePath && pass === 2 ? { ...raw, changed: true } : raw }],
          }
        },
      }
      throw new Error(name)
    },
  })
  return { raw, reads, run: () => exports.exportCompleteFinancialData('owner', {}), clicks: () => clicks,
    archive: async () => JSON.parse(await download!.text()) as archiveHelpers.FinancialExportDocument }
}

it('exports every financial collection and nested import collection through two matching server passes', async () => {
  const h = backupHarness()
  assert.equal((await h.run()).transactionCount, 1)
  assert.equal(h.clicks(), 1)
  const archive = await h.archive()
  for (const collection of archiveHelpers.archiveCollections) {
    const record = archive.data[collection][0]
    assert.equal(record.id, 'actual')
    assert.equal(record.path, `users/owner/${collection}/actual`)
    assert.deepEqual(archiveHelpers.deserializeValue(record.data), h.raw)
  }
  for (const child of archiveHelpers.importArchiveCollections) {
    const path = `users/owner/importOperations/actual/${child}`
    assert.equal(archive.nestedCollections[path][0].path, `${path}/actual`)
    assert.deepEqual(archiveHelpers.deserializeValue(archive.nestedCollections[path][0].data), h.raw)
  }
  assert.equal(archive.metadata.collectionManifests.length, 15)
  assert.equal(h.reads.size, 15)
  assert.ok([...h.reads.values()].every(count => count === 2))
  assert.equal(archive.metadata.readVerification!.globallyAtomic, false)
})

it('includes manifests for empty root and nested collections', async () => {
  for (const path of ['users/owner/trips', 'users/owner/importOperations/actual/trustedV2Trips']) {
    const h = backupHarness({ emptyPath: path }); await h.run()
    const manifest = (await h.archive()).metadata.collectionManifests.find(entry => entry.path === path)!
    assert.equal(manifest.count, 0)
    assert.deepEqual(manifest.documentPaths, [])
  }
})

it('fails closed on root/nested read errors, cached snapshots and pending writes without initiating a download', async () => {
  for (const options of [
    { failPath: 'users/owner/budgets' }, { failPath: 'users/owner/importOperations/actual/chunks' },
    { cache: true }, { pending: true }, { pendingDocument: true },
  ]) {
    const h = backupHarness(options)
    await assert.rejects(h.run(), /Server read failed|cached data or pending/)
    assert.equal(h.clicks(), 0)
  }
})

it('rejects observed concurrent changes in root and nested documents', async () => {
  for (const path of ['users/owner/transactions', 'users/owner/repaymentReceipts', 'users/owner/importOperations/actual/trustedV2State']) {
    const h = backupHarness({ changePath: path })
    await assert.rejects(h.run(), /records changed during export/)
    assert.equal(h.clicks(), 0)
  }
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

