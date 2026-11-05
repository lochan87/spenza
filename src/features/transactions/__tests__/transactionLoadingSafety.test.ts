import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const transactionsPage = new URL('../TransactionsPage.tsx', import.meta.url)
const importPage = new URL('../../import/ImportPage.tsx', import.meta.url)
const transactionService = new URL('../../../services/transactions.ts', import.meta.url)

// Execute the actual source callbacks with injected dependencies, without mounting
// React or importing Firebase configuration. This uses the existing TS dependency
// and Node test runner; no real database or destructive service is ever invoked.
function readCallback(file: URL, name: string, dependencies: Record<string, unknown>) {
  const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      expression = node.getText(source).replace(/^export\s+/, '')
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer) {
      const init = node.initializer
      expression = ts.isCallExpression(init) && init.expression.getText(source) === 'useCallback'
        ? init.arguments[0].getText(source)
        : init.getText(source)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(expression, `Missing production callback: ${name}`)
  const compiled = ts.transpileModule(`(${expression})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None },
  }).outputText
  return runInNewContext(compiled, dependencies) as (...args: unknown[]) => Promise<unknown>
}

function fixtureRecords() {
  return [
    { id: 'manual', description: 'Gokarna Trip', amountPaise: 400000, isImported: false, tripId: null,
      date: { seconds: 20 }, createdAt: { seconds: 1 }, categoryId: 'travel', paymentAccountId: 'bank',
      recoverablePaise: 200000, splits: [{ personId: 'friend', amountPaise: 200000, repaidPaise: 50000 }] },
    { id: 'trip-b', description: 'Hotel', amountPaise: 200000, isImported: true, tripId: 'trip',
      date: { seconds: 10 }, createdAt: { seconds: 2 } },
    { id: 'trip-a', description: 'Travel', amountPaise: 200000, isImported: true, tripId: 'trip',
      date: { seconds: 10 }, createdAt: { seconds: 2 } },
  ]
}

describe('Transactions and import — non-destructive loading', () => {
  it('keeps cleanup disconnected from both page modules', () => {
    for (const file of [transactionsPage, importPage]) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /\bdeduplicateTripSummaryTransactions\b/)
    }
  })

  it('loads and reloads the same records and metadata without invoking cleanup', async () => {
    const records = fixtureRecords()
    const original = structuredClone(records)
    const state: Record<string, unknown> = {}
    const loading: boolean[] = []
    const categories = [{ id: 'travel' }]
    const accounts = [{ id: 'bank' }]
    const trips = [{ id: 'trip', name: 'Gokarna Trip' }]
    let cleanupCalls = 0
    const load = readCallback(transactionsPage, 'loadAll', {
      user: { uid: 'test-user' },
      getAllTransactions: async (uid: string) => { assert.equal(uid, 'test-user'); return records },
      getCategories: async () => categories,
      getPaymentAccounts: async () => accounts,
      getTrips: async () => trips,
      setLoading: (value: boolean) => loading.push(value),
      setTransactions: (value: unknown) => { state.transactions = value },
      setCategories: (value: unknown) => { state.categories = value },
      setAccounts: (value: unknown) => { state.accounts = value },
      setTrips: (value: unknown) => { state.trips = value },
      deduplicateTripSummaryTransactions: async () => { cleanupCalls++; return 0 },
    })
    await load()
    await load()
    assert.equal(cleanupCalls, 0)
    assert.deepEqual(loading, [true, false, true, false])
    assert.equal(state.transactions, records)
    assert.equal(state.categories, categories)
    assert.equal(state.accounts, accounts)
    assert.equal(state.trips, trips)
    assert.deepEqual(records, original)
  })

  it('fetches full and paginated ledgers without writes and preserves display ordering', async () => {
    const records = fixtureRecords()
    const original = structuredClone(records)
    const docs = records.map(record => ({ id: record.id, data: () => record }))
    let writes = 0
    const forbiddenWrite = () => { writes++; throw new Error('Fetching must not write') }
    const dependencies = {
      db: {}, PAGE_SIZE: 30,
      collection: (_db: unknown, ...path: string[]) => { assert.deepEqual(path, ['users', 'test-user', 'transactions']); return path },
      query: (...parts: unknown[]) => parts,
      orderBy: (...parts: unknown[]) => parts,
      limit: (size: number) => size,
      startAfter: (cursor: unknown) => cursor,
      getDocs: async () => ({ docs }),
      deleteDoc: forbiddenWrite, setDoc: forbiddenWrite, updateDoc: forbiddenWrite, writeBatch: forbiddenWrite,
      invalidateInsightsCache: forbiddenWrite, deduplicateTripSummaryTransactions: forbiddenWrite,
    }
    const all = await readCallback(transactionService, 'getAllTransactions', dependencies)('test-user') as typeof records
    assert.deepEqual(Array.from(all, row => row.id), ['manual', 'trip-a', 'trip-b'])
    const page = await readCallback(transactionService, 'getTransactions', dependencies)('test-user', 30, docs[0]) as {
      transactions: typeof records; lastDoc: unknown
    }
    assert.deepEqual(Array.from(page.transactions, row => row.id), records.map(row => row.id))
    assert.equal(page.lastDoc, docs[2])
    assert.equal(writes, 0)
    assert.deepEqual(records, original)
  })

  it('imports selected incoming rows without cleaning up manual expenses or repayment history', async () => {
    const records = fixtureRecords()
    const original = structuredClone(records)
    const steps: string[] = []
    const errors: unknown[] = []
    const imported: string[] = []
    let cleanupCalls = 0
    const incomingRows = [
      { rowId: 'summary', description: 'Gokarna Trip', amountPaise: 400000 },
      { rowId: 'keep', description: 'Lunch', amountPaise: 10000 },
      { rowId: 'skip-date', description: 'Unknown date', amountPaise: 5000 },
    ]
    const runImport = readCallback(importPage, 'handleImport', {
      user: { uid: 'test-user' }, unresolvedRows: [], categories: [{ id: 'other', name: 'Other' }],
      tripIdMap: {}, catOverrides: {}, dateDecisions: { 'skip-date': 'skip' },
      excludedTripSheets: new Set(), excludedMonthlyRowIds: new Set(['summary']),
      parseResults: [{ sheet: { name: 'November 2026', kind: 'monthly' }, rows: incomingRows }],
      setStep: (step: string) => steps.push(step), setError: (error: unknown) => errors.push(error),
      setTripIdMap: () => {}, setProgress: () => {}, setResult: () => {},
      batchImportTransactions: async (uid: string, rows: Array<{ rowId: string }>) => {
        assert.equal(uid, 'test-user')
        imported.push(...rows.map(row => row.rowId))
        return { imported: rows.length, skipped: 0, cacheInvalidated: true }
      },
      deduplicateTripSummaryTransactions: async () => { cleanupCalls++; return 0 },
      console: { error: (...args: unknown[]) => errors.push(args) },
    })
    await runImport()
    assert.deepEqual(steps, ['importing', 'done'])
    assert.deepEqual(errors, [null])
    assert.deepEqual(imported, ['keep'])
    assert.equal(cleanupCalls, 0)
    assert.deepEqual(records, original)
  })
})
