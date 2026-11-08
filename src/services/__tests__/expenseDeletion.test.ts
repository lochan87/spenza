import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as helpers from '../../utils/expenseDeletion.ts'
import * as editHelpers from '../../utils/expenseEdit.ts'
import { getNetSpendPaise, getRecoverablePaise, getRepaidPaise, getPendingRecoverablePaise } from '../../utils/splitMath.ts'
import type { Transaction } from '../../types/index.ts'

const source = readFileSync(new URL('../transactions.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText
function loadService(sdk: unknown, db: unknown, invalidate: () => Promise<boolean>, offline = false) {
  const exports = {} as { deleteTransaction: (uid: string, id: string) => Promise<void> }
  runInNewContext(compiled, { exports, navigator: { onLine: !offline }, require: (name: string) => {
    if (name === 'firebase/firestore') return sdk
    if (name === '@/firebase/config') return { db }
    if (name === '@/utils/expenseDeletion') return helpers
    if (name === '@/utils/expenseEdit') return editHelpers
    if (name === '@/services/insights') return { invalidateInsightsCache: invalidate }
    throw new Error(`Unexpected import: ${name}`)
  } })
  return exports.deleteTransaction
}

function fixture(repaidPaise = 0): Transaction {
  return { id: 'expense', amountPaise: 10003, type: 'everyday', recoverablePaise: 5001,
    splits: [{ personId: 'friend', personName: 'Friend', amountPaise: 5001, repaidPaise, settledAt: null }],
    reimbursementStatus: repaidPaise === 0 ? 'pending' : repaidPaise === 5001 ? 'settled' : 'partial',
  } as Transaction
}

function harness(original = fixture(), options: { concurrent?: boolean; offline?: boolean; failRead?: boolean; failCommit?: boolean } = {}) {
  let stored: Transaction | undefined = structuredClone(original)
  let attempts = 0, invalidations = 0
  const sdk = {
    doc: (_db: unknown, ...path: string[]) => { assert.deepEqual(path, ['users', 'owner', 'transactions', 'expense']); return 'ref' },
    deleteDoc: () => assert.fail('Blind deletes are forbidden'),
    runTransaction: async (_db: unknown, callback: (tx: unknown) => Promise<void>) => {
      for (;;) {
        attempts++
        let pending = false
        await callback({
          get: async () => {
            if (options.failRead) throw new Error('unavailable')
            return { exists: () => !!stored, data: () => stored }
          },
          delete: (ref: string) => { assert.equal(ref, 'ref'); pending = true },
        })
        if (options.concurrent && attempts === 1) { stored = fixture(2001); continue }
        if (options.failCommit) throw new Error('unavailable')
        if (pending) stored = undefined
        return
      }
    },
  }
  const remove = loadService(sdk, {}, async () => { invalidations++; return true }, options.offline)
  return { remove: () => remove('owner', 'expense'), state: () => ({ stored, attempts, invalidations }) }
}

it('deletes unpaid split and legacy transactions, invalidating cache only after success', async () => {
  for (const tx of [fixture(), { ...fixture(), splits: undefined, reimbursementStatus: undefined },
    { ...fixture(), type: 'reimbursable' as const, splits: undefined }]) {
    const h = harness(tx)
    await h.remove()
    assert.equal(h.state().stored, undefined)
    assert.equal(h.state().invalidations, 1)
  }
})

for (const repaid of [2001, 5001]) {
  it(`protects ${repaid === 5001 ? 'fully' : 'partially'} repaid expenses and preserves integer-paise accounting`, async () => {
    const tx = fixture(repaid), h = harness(tx)
    await assert.rejects(h.remove(), { code: 'expense-deletion-blocked', message: helpers.repaymentDeletionMessage })
    assert.deepEqual(h.state().stored, tx)
    assert.equal(h.state().invalidations, 0)
    assert.equal(tx.amountPaise, getNetSpendPaise(tx) + getRecoverablePaise(tx))
    assert.equal(getRecoverablePaise(tx), getRepaidPaise(tx) + getPendingRecoverablePaise(tx))
    assert.ok(Number.isInteger(getRepaidPaise(tx)))
  })
}

it('rechecks the persisted ledger on a simulated retry after another client repays', async () => {
  const h = harness(fixture(), { concurrent: true })
  await assert.rejects(h.remove(), helpers.ExpenseDeletionError)
  assert.equal(h.state().attempts, 2)
  assert.deepEqual(h.state().stored, fixture(2001))
  assert.equal(h.state().invalidations, 0)
})

it('fails safely on offline, read and commit failures without modifying the expense', async () => {
  for (const options of [{ offline: true }, { failRead: true }, { failCommit: true }]) {
    const h = harness(fixture(), options)
    await assert.rejects(h.remove(), helpers.ExpenseDeletionError)
    assert.deepEqual(h.state().stored, fixture())
    assert.equal(h.state().invalidations, 0)
    if ('offline' in options) assert.equal(h.state().attempts, 0)
  }
})

it('protects legacy settlement and raw repayment evidence even when normalization would discard it', async () => {
  const shapes = [
    { ...fixture(5001), type: 'reimbursable', splits: undefined },
    { ...fixture(2001), splits: [] },
    { ...fixture(), amountPaise: 0, splits: [{ amountPaise: 0, repaidPaise: 1 }] },
    { ...fixture(), splits: [{ amountPaise: 5001, repaidPaise: 0, settledAt: { seconds: 1 } }] },
    { ...fixture(), splits: [{ repaidPaise: '2001' }] },
    { ...fixture(), splits: {} },
  ]
  for (const shape of shapes) {
    const h = harness(shape as Transaction)
    await assert.rejects(h.remove(), helpers.ExpenseDeletionError)
    assert.deepEqual(h.state().stored, shape)
  }
})

it('the actual deletion dialog handler displays protected errors and blocks duplicate submissions', async () => {
  const file = new URL('../../features/transactions/TransactionsPage.tsx', import.meta.url)
  const ast = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let handler = ''
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'confirmDelete') handler = node.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(handler)
  let calls = 0
  const errors: unknown[] = [], busy: boolean[] = [], inFlight = { current: false }
  const confirm = runInNewContext(ts.transpileModule(`(${handler})`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText, {
    inFlight, ExpenseDeletionError: helpers.ExpenseDeletionError,
    setDeleting: (value: boolean) => busy.push(value), setError: (value: unknown) => errors.push(value),
    onConfirm: async () => { calls++; throw new helpers.ExpenseDeletionError(helpers.repaymentDeletionMessage) },
  }) as () => Promise<void>
  await Promise.all([confirm(), confirm()])
  assert.equal(calls, 1)
  assert.deepEqual(errors, [null, helpers.repaymentDeletionMessage])
  assert.deepEqual(busy, [true, false])
  assert.equal(inFlight.current, false)
})

const host = process.env.SPENZA_FIRESTORE_EMULATOR_HOST
it('Firestore emulator: real deletion transaction retries after a concurrent repayment', { skip: !host }, async () => {
  assert.match(host!, /^(localhost|127\.0\.0\.1):\d+$/)
  const projectId = 'demo-spenza-deletion'
  const rules = readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8')
  const response = await fetch(`http://${host}/emulator/v1/projects/${projectId}:securityRules`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: rules }] } }),
  })
  assert.ok(response.ok, await response.text())
  const { initializeApp, deleteApp } = await import('firebase/app')
  const sdk = await import('firebase/firestore')
  const app = initializeApp({ projectId }, `delete-${Date.now()}`)
  const db = sdk.getFirestore(app)
  const [hostname, port] = host!.split(':')
  sdk.connectFirestoreEmulator(db, hostname, Number(port), { mockUserToken: { sub: 'owner', user_id: 'owner' } })
  const id = crypto.randomUUID(), ref = sdk.doc(db, 'users', 'owner', 'transactions', id)
  let attempts = 0
  try {
    await sdk.setDoc(ref, fixture())
    const remove = loadService({ ...sdk, runTransaction: (_db: unknown, callback: (tx: unknown) => Promise<void>) =>
      sdk.runTransaction(db, async tx => {
        attempts++
        await callback(tx)
        if (attempts === 1) await sdk.updateDoc(ref, { splits: fixture(2001).splits, reimbursementStatus: 'partial' })
      }),
    }, db, async () => true)
    await assert.rejects(remove('owner', id), helpers.ExpenseDeletionError)
    assert.ok(attempts >= 2)
    assert.equal((await sdk.getDoc(ref)).data()!.splits[0].repaidPaise, 2001)
  } finally {
    await sdk.terminate(db)
    await deleteApp(app)
  }
})
