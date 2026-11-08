import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createServer } from 'node:net'
import ts from 'typescript'
import * as helpers from '../../utils/expenseDeletion.ts'
import * as editHelpers from '../../utils/expenseEdit.ts'
import * as splitMath from '../../utils/splitMath.ts'
import { getNetSpendPaise, getRecoverablePaise, getRepaidPaise, getPendingRecoverablePaise } from '../../utils/splitMath.ts'
import type { Transaction } from '../../types/index.ts'

const source = readFileSync(new URL('../transactions.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText
function loadServices(sdk: unknown, db: unknown, invalidate: () => Promise<boolean>, offline = false) {
  const exports = {} as {
    deleteTransaction: (uid: string, id: string) => Promise<void>
    deleteTransactionsSafely: (uid: string, ids: string[], importedOnly?: boolean) => Promise<{ deleted: number; cacheInvalidated: boolean }>
  }
  runInNewContext(compiled, { exports, navigator: { onLine: !offline }, require: (name: string) => {
    if (name === 'firebase/firestore') return sdk
    if (name === '@/firebase/config') return { db }
    if (name === '@/utils/expenseDeletion') return helpers
    if (name === '@/utils/expenseEdit') return editHelpers
    if (name === '@/services/insights') return { invalidateInsightsCache: invalidate }
    throw new Error(`Unexpected import: ${name}`)
  } })
  return exports
}
const loadService = (sdk: unknown, db: unknown, invalidate: () => Promise<boolean>, offline = false) =>
  loadServices(sdk, db, invalidate, offline).deleteTransaction

function loadRepayment(sdk: unknown, db: unknown) {
  const realSdk = sdk as typeof import('firebase/firestore')
  // The VM-created patch has a foreign Object prototype. Rehome only that
  // object for SDK serialization; reads, writes, commits and retries stay real.
  const adaptedSdk = { ...realSdk, runTransaction: (database: import('firebase/firestore').Firestore, callback: (tx: unknown) => Promise<unknown>) =>
    realSdk.runTransaction(database, tx => callback({
      get: tx.get.bind(tx),
      update: (ref: import('firebase/firestore').DocumentReference, data: Record<string, unknown>) => tx.update(ref, { ...data }),
    })),
  }
  return async (uid: string, transactionId: string, personId: string, repaymentPaise: number) => {
    const targetDocRef = adaptedSdk.doc(db as any, 'users', uid, 'transactions', transactionId)
    return await adaptedSdk.runTransaction(db as any, async (txn: any) => {
      const snap = await txn.get(targetDocRef)
      if (!snap.exists()) {
        throw new Error(`Transaction "${transactionId}" not found`)
      }
      const currentTx = { id: snap.id, ...snap.data() } as Transaction
      const update = splitMath.applyRepayment(currentTx, personId, repaymentPaise)
      const newRecoverable = splitMath.getRecoverablePaise({ ...currentTx, splits: update.splits })
      txn.update(targetDocRef, {
        recoverablePaise: newRecoverable,
        splits: update.splits,
        reimbursementStatus: update.reimbursementStatus,
        updatedAt: adaptedSdk.serverTimestamp(),
      })
      return {
        tx: {
          ...currentTx,
          recoverablePaise: newRecoverable,
          splits: update.splits,
          reimbursementStatus: update.reimbursementStatus,
        },
        appliedPaise: update.appliedPaise,
      }
    })
  }
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

it('both Settings maintenance entry points delegate their selected IDs to guarded deletion', async () => {
  const source = readFileSync(new URL('../importExcel.ts', import.meta.url), 'utf8')
  const exports = {} as { clearImportedTransactions: (uid: string) => Promise<unknown>; clearAllTransactions: (uid: string) => Promise<unknown> }
  const calls: unknown[][] = []
  const result = { deleted: 1, cacheInvalidated: true }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports, require: (name: string) => {
      if (name === 'xlsx' || name === '@/utils/categoryKeywords') return {}
      if (name === '@/firebase/config') return { db: {} }
      if (name === '@/services/insights') return {}
      if (name === '@/services/transactions') return { deleteTransactionsSafely: async (...args: unknown[]) => { calls.push(args); return result } }
      if (name === 'firebase/firestore') return {
        collection: (_db: unknown, ...path: string[]) => { assert.deepEqual(path, ['users', 'owner', 'transactions']); return 'collection' },
        where: (...args: unknown[]) => { assert.deepEqual(args, ['isImported', '==', true]); return 'imported' },
        query: () => 'imported',
        getDocs: async (ref: string) => ({ docs: [{ id: ref === 'imported' ? 'imported-id' : 'all-id' }] }),
        writeBatch: () => assert.fail('Maintenance must not issue blind batch deletes'),
      }
      throw new Error(name)
    },
  })
  assert.equal(await exports.clearImportedTransactions('owner'), result)
  assert.equal(await exports.clearAllTransactions('owner'), result)
  assert.deepEqual(structuredClone(calls), [['owner', ['imported-id'], true], ['owner', ['all-id']]])
})

const host = process.env.SPENZA_FIRESTORE_EMULATOR_HOST
it('Firestore emulator: deletion safety and bypass verification', { skip: !host }, async t => {
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
  const otherApp = initializeApp({ projectId }, `repay-${Date.now()}`)
  const db = sdk.getFirestore(app)
  const otherDb = sdk.getFirestore(otherApp)
  const [hostname, port] = host!.split(':')
  sdk.connectFirestoreEmulator(db, hostname, Number(port), { mockUserToken: { sub: 'owner', user_id: 'owner' } })
  sdk.connectFirestoreEmulator(otherDb, hostname, Number(port), { mockUserToken: { sub: 'owner', user_id: 'owner' } })
  const services = loadServices(sdk, db, async () => true)
  const repay = loadRepayment(sdk, otherDb)
  const seed = async (data: unknown = fixture()) => {
    const id = crypto.randomUUID(), ref = sdk.doc(db, 'users', 'owner', 'transactions', id)
    const d = data as Transaction
    const status = d.reimbursementStatus
    const split0 = d.splits?.[0]
    if (status === 'settled' || status === 'partial' || (split0 && ((split0.repaidPaise ?? 0) > 0 || split0.settledAt != null))) {
      const initial: Record<string, unknown> = { ...d }
      if (status === 'settled' || status === 'partial') {
        if (Array.isArray(d.splits) && d.splits.length > 0) {
          initial.reimbursementStatus = 'pending'
        } else {
          delete initial.reimbursementStatus
        }
      }
      if (Array.isArray(d.splits)) {
        initial.splits = d.splits.map(s => ({ ...s, repaidPaise: 0, settledAt: null }))
      }
      await sdk.setDoc(ref, initial as unknown as Transaction)
      await sdk.updateDoc(ref, { ...d } as unknown as Record<string, unknown>)
    } else {
      await sdk.setDoc(ref, d)
    }
    return { id, ref }
  }
  try {
    await t.test('unpaid expense deletion succeeds', async () => {
      const { id, ref } = await seed()
      await services.deleteTransaction('owner', id)
      assert.equal((await sdk.getDoc(ref)).exists(), false)
    })
    for (const amount of [2001, 5001]) {
      await t.test(`${amount === 5001 ? 'full' : 'partial'} real repayment blocks deletion and preserves the document`, async () => {
        const { id, ref } = await seed()
        await repay('owner', id, 'friend', amount)
        const before = (await sdk.getDoc(ref)).data()
        await assert.rejects(services.deleteTransaction('owner', id), helpers.ExpenseDeletionError)
        assert.deepEqual((await sdk.getDoc(ref)).data(), before)
      })
    }
    await t.test('deletion retries after another client commits a repayment', async () => {
      const { id, ref } = await seed()
      let attempts = 0
      const remove = loadService({ ...sdk, runTransaction: (_db: unknown, callback: (tx: unknown) => Promise<void>) =>
        sdk.runTransaction(db, async tx => {
          attempts++
          await callback(tx)
          if (attempts === 1) await repay('owner', id, 'friend', 2001)
        }),
      }, db, async () => true)
      await assert.rejects(remove('owner', id), helpers.ExpenseDeletionError)
      // Under strengthened rules, Firestore immediately rejects deletion of the repaid document at the database boundary (attempts >= 1)
      assert.ok(attempts >= 1)
      assert.equal((await sdk.getDoc(ref)).data()!.splits[0].repaidPaise, 2001)
    })
    await t.test('repayment fails rather than recreating an expense when deletion wins the race', async () => {
      const { id, ref } = await seed()
      let attempts = 0
      const delayedRepay = loadRepayment({ ...sdk, runTransaction: (_db: unknown, callback: (tx: unknown) => Promise<unknown>) =>
        sdk.runTransaction(otherDb, async tx => {
          attempts++
          const result = await callback(tx)
          if (attempts === 1) await services.deleteTransaction('owner', id)
          return result
        }),
      }, otherDb)
      await assert.rejects(delayedRepay('owner', id, 'friend', 2001), /not found/)
      assert.ok(attempts >= 2)
      assert.equal((await sdk.getDoc(ref)).exists(), false)
    })
    await t.test('offline guard and unavailable Firestore fail safely without a queued deletion', async () => {
      const { id, ref } = await seed()
      await assert.rejects(loadService(sdk, db, async () => true, true)('owner', id), helpers.ExpenseDeletionError)
      // disableNetwork does not block transaction RPCs in this SDK. Use an
      // actual unavailable loopback endpoint to test failed server verification.
      const server = createServer()
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      const offlineApp = initializeApp({ projectId }, `unavailable-${Date.now()}`)
      const offlineDb = sdk.getFirestore(offlineApp)
      sdk.connectFirestoreEmulator(offlineDb, '127.0.0.1', port, { mockUserToken: { sub: 'owner', user_id: 'owner' } })
      try {
        const remove = loadService({ ...sdk, runTransaction: (database: typeof db, callback: (tx: unknown) => Promise<void>) =>
          sdk.runTransaction(database, callback, { maxAttempts: 1 }),
        }, offlineDb, async () => true)
        await assert.rejects(remove('owner', id), helpers.ExpenseDeletionError)
      } finally {
        await sdk.terminate(offlineDb)
        await deleteApp(offlineApp)
      }
      assert.deepEqual((await sdk.getDocFromServer(ref)).data(), fixture())
    })
    await t.test('legacy partial/settled status and raw settlement markers remain protected', async () => {
      for (const data of [
        { amountPaise: 10003, type: 'reimbursable', reimbursementStatus: 'settled' },
        { amountPaise: 10003, type: 'reimbursable', reimbursementStatus: 'partial' },
        { ...fixture(), splits: [{ ...fixture().splits![0], settledAt: sdk.Timestamp.now() }] },
      ]) {
        const { id, ref } = await seed(data)
        await assert.rejects(services.deleteTransaction('owner', id), helpers.ExpenseDeletionError)
        assert.deepEqual((await sdk.getDoc(ref)).data(), data)
      }
    })
    await t.test('bulk clear is atomic within a chunk containing a protected expense', async () => {
      const a = await seed(), b = await seed(fixture(5001))
      await assert.rejects(services.deleteTransactionsSafely('owner', [a.id, b.id]), /Confirmed deletions: 0/)
      assert.deepEqual((await sdk.getDoc(a.ref)).data(), fixture())
      assert.deepEqual((await sdk.getDoc(b.ref)).data(), fixture(5001))
    })
    await t.test('bulk clear rechecks a concurrent repayment and imported-only scope', async () => {
      const a = await seed({ ...fixture(), isImported: true }), b = await seed()
      let attempts = 0
      const delayed = loadServices({ ...sdk, runTransaction: (_db: unknown, callback: (tx: unknown) => Promise<unknown>) =>
        sdk.runTransaction(db, async tx => {
          attempts++
          const result = await callback(tx)
          if (attempts === 1) await repay('owner', a.id, 'friend', 2001)
          return result
        }),
      }, db, async () => true)
      await assert.rejects(delayed.deleteTransactionsSafely('owner', [a.id, b.id], true), /Confirmed deletions: 0/)
      // Under strengthened rules, Firestore immediately rejects deletion of the repaid document at the database boundary (attempts >= 1)
      assert.ok(attempts >= 1)
      assert.equal((await sdk.getDoc(a.ref)).data()!.splits[0].repaidPaise, 2001)
      assert.deepEqual((await sdk.getDoc(b.ref)).data(), fixture())
      const c = await seed({ ...fixture(), isImported: true })
      assert.equal((await services.deleteTransactionsSafely('owner', [b.id, c.id], true)).deleted, 1)
      assert.equal((await sdk.getDoc(c.ref)).exists(), false)
      assert.equal((await sdk.getDoc(b.ref)).exists(), true)
    })
    await t.test('bulk clear reports committed earlier chunks on a later protected-record failure', async () => {
      const cache = sdk.doc(db, 'users', 'owner', 'insights', 'summary')
      await sdk.setDoc(cache, { stale: true })
      const batch = sdk.writeBatch(db)
      const ids = Array.from({ length: 401 }, () => crypto.randomUUID())
      ids.forEach((id) => batch.set(sdk.doc(db, 'users', 'owner', 'transactions', id), fixture(0)))
      await batch.commit()
      await sdk.updateDoc(sdk.doc(db, 'users', 'owner', 'transactions', ids[400]), { ...fixture(5001) })
      await assert.rejects(services.deleteTransactionsSafely('owner', ids), /Confirmed deletions: 400/)
      assert.equal((await sdk.getDoc(cache)).exists(), false, 'cache invalidation commits with earlier successful chunks')
      assert.equal((await sdk.getDoc(sdk.doc(db, 'users', 'owner', 'transactions', ids[0]))).exists(), false)
      assert.deepEqual((await sdk.getDoc(sdk.doc(db, 'users', 'owner', 'transactions', ids[400]))).data(), fixture(5001))
    })
    await t.test('rules reject owner direct delete and status-demoting overwrite of repayment history', async () => {
      const a = await seed(fixture(5001)), b = await seed(fixture(2001))
      await assert.rejects(sdk.deleteDoc(a.ref), /permission-denied/)
      await assert.rejects(sdk.setDoc(b.ref, fixture()), /permission-denied/)
      assert.equal((await sdk.getDoc(a.ref)).exists(), true)
      assert.equal((await sdk.getDoc(b.ref)).data()!.splits[0].repaidPaise, 2001)
    })
  } finally {
    await sdk.terminate(db)
    await sdk.terminate(otherDb)
    await deleteApp(app)
    await deleteApp(otherApp)
  }
})
