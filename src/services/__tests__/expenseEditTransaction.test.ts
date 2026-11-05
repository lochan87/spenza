import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { Timestamp } from 'firebase/firestore'
import * as editHelpers from '../../utils/expenseEdit.ts'
import type { ExpenseEdit } from '../../utils/expenseEdit.ts'
import type { Transaction } from '../../types/index.ts'

// Run the real service module against a transaction double. No Firebase app is
// initialized. This verifies service wiring/retry handling, not SDK/server OCC.
function harness(options: { failCommit?: boolean; missing?: boolean; offline?: boolean; concurrentRepayment?: boolean } = {}) {
  const original: Transaction = {
    id: 'expense', amountPaise: 10000, description: 'Dinner', categoryId: 'food', type: 'everyday',
    date: Timestamp.fromMillis(1000), createdAt: Timestamp.fromMillis(1000), updatedAt: Timestamp.fromMillis(1000),
    paymentMode: 'Cash', paymentAccountId: null, tripId: null, personId: 'friend', tags: [], notes: '', receiptUrl: null,
    recoverablePaise: 5000, reimbursementStatus: 'pending',
    splits: [{ personId: 'friend', personName: 'Friend', amountPaise: 5000, repaidPaise: 0, settledAt: null }],
  }
  let stored = original
  let attempts = 0
  let invalidations = 0
  const serviceExports: { updateTransaction?: (uid: string, id: string, data: ExpenseEdit, original: Transaction) => Promise<void> } = {}
  const sdk = {
    doc: (_db: unknown, ...path: string[]) => {
      assert.deepEqual(path, ['users', 'test-user', 'transactions', 'expense'])
      return 'expense-ref'
    },
    serverTimestamp: () => Timestamp.fromMillis(2000),
    setDoc: () => assert.fail('Expense edits must not use blind setDoc'),
    runTransaction: async (_db: unknown, callback: (txn: unknown) => Promise<void>) => {
      for (;;) {
        attempts++
        let pending: ExpenseEdit | undefined
        await callback({
          get: async () => ({ exists: () => !options.missing, id: stored.id, data: () => stored }),
          update: (ref: string, patch: ExpenseEdit) => { assert.equal(ref, 'expense-ref'); pending = patch },
        })
        if (options.concurrentRepayment && attempts === 1) {
          stored = { ...stored, reimbursementStatus: 'partial', splits: [{ ...stored.splits![0], repaidPaise: 4000 }] }
          continue // Simulate a server retry: discard the first attempted write.
        }
        if (options.failCommit) throw Object.assign(new Error('Simulated commit failure'), { code: 'unavailable' })
        if (pending) stored = { ...stored, ...pending }
        return
      }
    },
  }
  const source = readFileSync(new URL('../transactions.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText
  runInNewContext(compiled, {
    exports: serviceExports,
    navigator: { onLine: !options.offline },
    require: (name: string) => {
      if (name === 'firebase/firestore') return sdk
      if (name === '@/firebase/config') return { db: {} }
      if (name === '@/utils/expenseEdit') return editHelpers
      if (name === '@/services/insights') return { invalidateInsightsCache: async () => { invalidations++; return true } }
      throw new Error(`Unexpected import: ${name}`)
    },
  })
  return {
    original,
    save: (data: ExpenseEdit) => serviceExports.updateTransaction!('test-user', 'expense', data, original),
    state: () => ({ stored, attempts, invalidations }),
  }
}

describe('Expense edit service — simulated transaction boundaries', () => {
  it('recomputes the merge on retry and preserves the intervening repayment', async () => {
    const h = harness({ concurrentRepayment: true })
    await h.save({ amountPaise: 12000, recoverablePaise: 6000, splits: [{ ...h.original.splits![0], amountPaise: 6000 }] })
    assert.equal(h.state().attempts, 2)
    assert.equal(h.state().stored.splits![0].repaidPaise, 4000)
    assert.equal(h.state().stored.splits![0].amountPaise, 6000)
    assert.equal(h.state().invalidations, 1)
  })

  it('rejects a now-unsafe share reduction on retry without committing any edit', async () => {
    const h = harness({ concurrentRepayment: true })
    await assert.rejects(h.save({ description: 'Must not persist', recoverablePaise: 3000, splits: [{ ...h.original.splits![0], amountPaise: 3000 }] }), /repayment has been recorded/)
    assert.equal(h.state().stored.description, 'Dinner')
    assert.equal(h.state().stored.splits![0].amountPaise, 5000)
    assert.equal(h.state().stored.splits![0].repaidPaise, 4000)
    assert.equal(h.state().invalidations, 0)
  })

  it('does not partially write or invalidate the cache when a commit fails', async () => {
    const h = harness({ failCommit: true })
    await assert.rejects(h.save({ description: 'Not committed' }), /Simulated commit failure/)
    assert.equal(h.state().stored, h.original)
    assert.equal(h.state().invalidations, 0)
  })

  it('does not recreate an expense deleted while the form was open', async () => {
    const h = harness({ missing: true })
    await assert.rejects(h.save({ notes: 'Missing' }), /no longer exists/)
    assert.equal(h.state().invalidations, 0)
  })

  it('explicitly rejects offline edits before starting a transaction', async () => {
    const h = harness({ offline: true })
    await assert.rejects(h.save({ notes: 'Offline' }), /offline/)
    assert.equal(h.state().attempts, 0)
    assert.equal(h.state().stored, h.original)
  })
})
