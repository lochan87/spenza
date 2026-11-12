import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import XLSX from 'xlsx'
import { Timestamp } from 'firebase/firestore'
import * as importPlan from '../../utils/importPlan.ts'
import { executeTrustedImport } from '../../../functions/src/importExecutor.ts'
import type { ParsedRow } from '../importExcel.ts'
const basePath = 'users/test-user'
type StoredDoc = Record<string, any>
interface Write { type: 'set' | 'update' | 'delete'; ref: string; data?: StoredDoc }
// Actual service functions; an optimistic, staged transaction double. No Firebase
// configuration is loaded, and no network or production writes are possible.
function createHarness(options: { failOnPath?: string; loseResponseOn?: string; failRead?: boolean; callableError?: string; callableDetails?: unknown; beforeTransaction?: () => void } = {}) {
  const docs = new Map<string, StoredDoc>()
  const versions = new Map<string, number>()
  const nav = { onLine: true }
  let reads = 0
  let calls = 0
  let attempts = 0
  let appliedWrites = 0
  let commitQueue: Promise<void> = Promise.resolve()

  const bump = (path: string) => versions.set(path, (versions.get(path) ?? 0) + 1)

  const sdk = {
    Timestamp,
    doc: (_db: unknown, ...segments: string[]) => segments.join('/'),
    collection: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
    query: (target: unknown) => target,
    orderBy: () => undefined,
    where: () => undefined,
    getDocsFromServer: async (target: { path: string }) => ({ docs: [...docs].filter(([path]) => path.startsWith(target.path + '/') && path.slice(target.path.length + 1).indexOf('/') < 0).map(([path, data]) => ({ id: path.split('/').pop(), data: () => data })) }),
    getDocFromServer: async (ref: string) => { if (options.failRead) throw new Error('Network unavailable'); return { exists: () => docs.has(ref), data: () => docs.get(ref) } },
    serverTimestamp: () => Timestamp.now(),
    runTransaction: async (_db: unknown, callback: (txn: any) => Promise<unknown>) => {
      options.beforeTransaction?.()
      for (let attempt = 1; attempt <= 5; attempt++) {
        attempts++
        const readVersions = new Map<string, number>()
        const writes: Write[] = []
        let wrote = false
        const txn = {
          get: async (ref: string) => {
            if (wrote) throw new Error('Firestore transactions must complete all reads before writing')
            reads++
            readVersions.set(ref, versions.get(ref) ?? 0)
            const data = docs.get(ref)
            return {
              exists: () => data !== undefined,
              id: ref.split('/').pop(),
              data: () => (data === undefined ? undefined : { ...data }),
            }
          },
          set: (ref: string, data: StoredDoc) => {
            wrote = true
            writes.push({ type: 'set', ref, data })
          },
          update: (ref: string, data: StoredDoc) => {
            wrote = true
            writes.push({ type: 'update', ref, data })
          },
          delete: (ref: string) => {
            wrote = true
            writes.push({ type: 'delete', ref })
          },
        }
        const result = await callback(txn)

        // Serialize commits like the Firestore backend and reject the commit if
        // any document read by this attempt changed in the meantime.
        const previous = commitQueue
        let release!: () => void
        commitQueue = new Promise<void>(resolve => { release = resolve })
        await previous
        let conflict = false
        try {
          for (const [path, version] of readVersions) {
            if ((versions.get(path) ?? 0) !== version) {
              conflict = true
              break
            }
          }
          if (!conflict) {

            // Stage every mutation, including bookkeeping. Failed attempts publish nothing.
            const stagedDocs = new Map(docs)
            const stagedVersions = new Map(versions)
            for (const write of writes) {
              if (options.failOnPath === write.ref) throw new Error(`Simulated ${write.type} failure`)
              if (write.type === 'delete') stagedDocs.delete(write.ref)
              else {
                const existing = stagedDocs.get(write.ref)
                if (write.type === 'update' && !existing) throw new Error('Simulated document not found')
                stagedDocs.set(write.ref, write.type === 'update' ? { ...existing, ...write.data } : { ...write.data })
              }
              stagedVersions.set(write.ref, (stagedVersions.get(write.ref) ?? 0) + 1)
            }
            docs.clear()
            for (const [path, data] of stagedDocs) docs.set(path, data)
            versions.clear()
            for (const [path, version] of stagedVersions) versions.set(path, version)
            appliedWrites += writes.length
          }
        } finally {
          release()
        }
        if (conflict) continue
        if (writes.some(w => w.ref === options.loseResponseOn)) {
          options.loseResponseOn = undefined
          throw new Error('Simulated lost response after commit')
        }
        return result
      }
      throw new Error('Simulated transaction retry limit')
    },
  }

  // Adapter shares the optimistic store with the actual callable core. This is
  // an in-memory concurrency simulation, not a security-rules emulator.
  const ref = (path: string): any => ({ path, get: async () => { reads++; return { exists: docs.has(path), data: () => docs.get(path) } },
    collection: (name: string) => ({ doc: (key: string) => ref(`${path}/${name}/${key}`) }) })
  const admin = { doc: ref, runTransaction: (callback: (txn: any) => Promise<unknown>) => sdk.runTransaction({}, txn => {
    const adapter: any = {
      get: async (r: any) => { const snap = await txn.get(r.path); return { exists: snap.exists(), data: snap.data } },
      getAll: (...refs: any[]) => Promise.all(refs.map(r => adapter.get(r))),
      create: (r: any, data: StoredDoc) => { if (docs.has(r.path)) throw new Error('Create collision'); txn.set(r.path, data) },
      set: (r: any, data: StoredDoc) => txn.set(r.path, data),
      delete: (r: any) => txn.delete(r.path),
    }
    return callback(adapter)
  }) } as unknown as Parameters<typeof executeTrustedImport>[0]
  const invoke = (uid = 'test-user', input: unknown = { operationId: fingerprint }) => { calls++; return executeTrustedImport(admin, uid, input) }
  docs.set(`${basePath}/categories/other`, { name: 'Other' })
  docs.set(`${basePath}/categories/reviewed-category`, { name: 'Reviewed' })
  const source = readFileSync(new URL('../importOperations.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText
  const serviceExports: Record<string, unknown> = {}
  runInNewContext(compiled, {
    exports: serviceExports,
    navigator: nav,
    console, TextEncoder, Date, Error,
    require: (name: string) => {
      if (name === 'firebase/functions') return { getFunctions: () => ({}), httpsCallable: () => async (input: unknown) => {
        if (options.callableError) throw Object.assign(new Error('Callable failed'), { code: options.callableError, details: options.callableDetails })
        return { data: await invoke('test-user', input) }
      } }
      if (name === 'firebase/firestore') return sdk
      if (name === '@/firebase/config') return { db: {} }
      if (name === '@/services/backendApi') {
        return {
          callBackend: async (opts: any) => {
            if (options.callableError) throw Object.assign(new Error('Callable failed'), { code: options.callableError, details: options.callableDetails })
            return { data: await invoke('test-user', opts.payload) }
          },
        }
      }
      if (name === '@/utils/importPlan') return importPlan
      if (name === '@/utils/tripBuckets') return { TRIP_ACCENT_COLOR: '#123456' }
      throw new Error(`Unexpected import: ${name}`)
    },
  })

  return {
    service: serviceExports as typeof import('../importOperations.ts'),
    options, nav, invoke, reads: () => reads, calls: () => calls,
    docs,
    setOnline: (value: boolean) => { nav.onLine = value },
    attempts: () => attempts,
    appliedWrites: () => appliedWrites,
    versions: () => new Map(versions),
    read: (path: string) => docs.get(path),
    directWrite: (path: string, data: StoredDoc) => {
      docs.set(path, { ...data })
      bump(path)
    },
    transactionPath: (id: string) => `${basePath}/transactions/${id}`,
    recurringPath: (id: string) => `${basePath}/recurring/${id}`,
    insightsPath: `${basePath}/insights/summary`,
  }
}

const fingerprint = 'a'.repeat(64)
const receiptPath = (index: number) => `${basePath}/importOperations/${fingerprint}/trustedV2Receipts/${index}`
function rows(count: number): ParsedRow[] {
  return Array.from({ length: count }, (_, i) => ({ rowId: `January::${i}`, description: 'Identical lunch', amountPaise: 12345,
    dateStr: '2026-01-01', rawDate: '01/01/2026', rawAmount: '123.45', dateIssue: null, suggestedCategoryName: null,
    resolvedCategoryId: null, sheetName: 'January', isTripRow: false, tripId: null }))
}
async function prepare(h: ReturnType<typeof createHarness>, count = 2, id = fingerprint, input = rows(count), trips = {}) {
  const plan = await h.service.buildImportPlan('test-user', id, fingerprint, 'January.csv', input, new Map(), 'other', trips, 3)
  await h.service.saveImportPlan('test-user', plan)
  return plan
}
const expenses = (h: ReturnType<typeof createHarness>) => [...h.docs].filter(([p]) => p.includes('/transactions/'))

describe('Durable imports: actual service against optimistic persistence double', () => {
  for (const count of [2, 43]) it(`imports ${count} rows with bounded atomic chunks and accurate counts`, async () => {
    const h = createHarness()
    await prepare(h, count)
    h.directWrite(`${basePath}/insights/summary`, { cached: true })
    const result = await h.service.executeImport('test-user', fingerprint, fingerprint)
    assert.equal(result.imported, count)
    assert.equal(result.skipped, 3)
    assert.equal(result.complete, true)
    assert.equal(expenses(h).length, count)
    assert.equal(h.read(`${basePath}/insights/summary`), undefined)
    assert.equal(expenses(h)[0][1].paymentAccountId, null)
    assert.equal(expenses(h)[0][1].amountPaise, 12345)
  })
  it('keeps earlier chunks after failure and resumes without repeating them', async () => {
    const h = createHarness()
    await prepare(h, 43)
    h.options.failOnPath = receiptPath(1)
    await assert.rejects(h.service.executeImport('test-user', fingerprint, fingerprint), (e: any) => e.result.imported === 20 && e.result.unresolved === 23)
    assert.equal(expenses(h).length, 20)
    h.options.failOnPath = undefined
    const result = await h.service.executeImport('test-user', fingerprint, fingerprint)
    assert.equal(result.imported, 23)
    assert.equal(result.alreadyCommitted, 20)
    assert.equal(expenses(h).length, 43)
  })
  it('reconciles a lost commit acknowledgment using the server receipt', async () => {
    const h = createHarness()
    await prepare(h)
    h.options.loseResponseOn = receiptPath(0)
    await assert.rejects(h.service.executeImport('test-user', fingerprint, fingerprint), /remain unconfirmed/)
    const result = await h.service.executeImport('test-user', fingerprint, fingerprint)
    assert.equal(result.complete, true)
    assert.equal(result.alreadyCommitted, 2)
    assert.equal(expenses(h).length, 2)
  })
  it('serializes two concurrent retries to one set of transactions', async () => {
    const h = createHarness()
    await prepare(h, 23)
    const results = await Promise.all([h.service.executeImport('test-user', fingerprint, fingerprint), h.service.executeImport('test-user', fingerprint, fingerprint)])
    assert.equal(results.reduce((s, r) => s + r.imported, 0), 23)
    assert.equal(expenses(h).length, 23)
  })
  it('reopens the frozen plan and preserves corrections, categories and selection', async () => {
    const h = createHarness()
    const input = rows(3).slice(1)
    input[0].resolvedCategoryId = 'reviewed-category'
    input[0].dateStr = '2026-02-02'
    await prepare(h, 2, fingerprint, input)
    const loaded = await h.service.loadImportPlan('test-user', fingerprint, fingerprint)
    assert.equal(loaded.chunks[0].rows[0].sourceRowId, 'January::1')
    assert.equal(loaded.chunks[0].rows[0].categoryId, 'reviewed-category')
    assert.equal(loaded.chunks[0].rows[0].dateMillis, new Date('2026-02-02T12:00:00').getTime())
    await h.service.executeImport('test-user', loaded.header.operationId, loaded.header.fingerprint)
    assert.equal(expenses(h).length, 2)
  })
  it('preserves identical source rows and unrelated manual transactions', async () => {
    const h = createHarness()
    h.directWrite(`${basePath}/transactions/manual`, { amountPaise: 12345, description: 'Identical lunch', splits: [{ repaidPaise: 100 }] })
    await prepare(h)
    await h.service.executeImport('test-user', fingerprint, fingerprint)
    assert.equal(expenses(h).length, 3)
    assert.equal(h.read(`${basePath}/transactions/manual`)!.splits[0].repaidPaise, 100)
  })
  it('never recreates a deleted transaction from a completed operation', async () => {
    const h = createHarness()
    await prepare(h)
    await h.service.executeImport('test-user', fingerprint, fingerprint)
    h.docs.delete(expenses(h)[0][0])
    const result = await h.service.executeImport('test-user', fingerprint, fingerprint)
    assert.equal(result.alreadyCommitted, 2)
    assert.equal(expenses(h).length, 1)
  })
  it('allows an explicitly new operation for the same source', async () => {
    const h = createHarness()
    await prepare(h)
    await h.service.executeImport('test-user', fingerprint, fingerprint)
    const id = importPlan.newImportOperation(fingerprint, true)
    await prepare(h, 2, id)
    await h.service.executeImport('test-user', id, fingerprint)
    assert.equal(expenses(h).length, 4)
  })
  it('creates trips with their first chunk, preserves metadata and reuses after partial failure', async () => {
    const h = createHarness()
    const tripId = await importPlan.importRecordId(fingerprint, 'trip', 'January')
    const input = rows(23).map(r => ({ ...r, isTripRow: true, tripId }))
    const draft = { name: 'Goa', startMillis: 1700000000000, endMillis: 1700000000000 }
    await prepare(h, 23, fingerprint, input, { [tripId]: draft })
    h.options.failOnPath = receiptPath(1)
    await assert.rejects(h.service.executeImport('test-user', fingerprint, fingerprint))
    const tripPath = `${basePath}/trips/${tripId}`
    h.directWrite(tripPath, { ...h.read(tripPath), name: 'Edited after first chunk' })
    h.options.failOnPath = undefined
    await h.service.executeImport('test-user', fingerprint, fingerprint)
    assert.equal(h.read(tripPath)!.name, 'Edited after first chunk')
    assert.equal([...h.docs.keys()].filter(p => p.startsWith(`${basePath}/trips/`)).length, 1)
    assert.ok(expenses(h).every(([, d]) => d.tripId === tripId))
  })
  it('does not recreate a deleted imported trip for remaining chunks', async () => {
    const h = createHarness()
    const tripId = await importPlan.importRecordId(fingerprint, 'trip', 'January')
    await prepare(h, 23, fingerprint, rows(23).map(r => ({ ...r, isTripRow: true, tripId })), { [tripId]: { name: 'Goa', startMillis: 1, endMillis: 2 } })
    h.options.failOnPath = receiptPath(1)
    await assert.rejects(h.service.executeImport('test-user', fingerprint, fingerprint))
    h.docs.delete(`${basePath}/trips/${tripId}`)
    h.options.failOnPath = undefined
    await assert.rejects(h.service.executeImport('test-user', fingerprint, fingerprint), /trip was deleted/)
    assert.equal(expenses(h).length, 20)
  })
  it('rolls back documents, versions and counts if cache invalidation fails', async () => {
    const h = createHarness()
    await prepare(h)
    const docs = new Map(h.docs), versions = h.versions(), writes = h.appliedWrites()
    h.options.failOnPath = `${basePath}/insights/summary`
    await assert.rejects(h.service.executeImport('test-user', fingerprint, fingerprint))
    assert.deepEqual(h.docs, docs)
    assert.deepEqual(h.versions(), versions)
    assert.equal(h.appliedWrites(), writes)
  })
  it('rejects collisions without overwriting existing transactions', async () => {
    const h = createHarness()
    const plan = await prepare(h)
    const path = `${basePath}/transactions/${plan.chunks[0].rows[0].transactionId}`
    h.directWrite(path, { manual: true })
    await assert.rejects(h.service.executeImport('test-user', fingerprint, fingerprint), /conflicts/)
    assert.deepEqual(h.read(path), { manual: true })
  })
  it('rejects missing trip references atomically', async () => {
    const h = createHarness()
    await prepare(h, 2, fingerprint, rows(2).map(r => ({ ...r, tripId: 'missing', isTripRow: true })))
    await assert.rejects(h.service.executeImport('test-user', fingerprint, fingerprint), /trip no longer exists/)
    assert.equal(expenses(h).length, 0)
  })
  it('rejects invalid rows, source binding, duplicate row identities and payment modes', async () => {
    const h = createHarness()
    for (const patch of [{ amountPaise: 1.5 }, { amountPaise: -100 }, { dateStr: '2026-02-31' }, { description: '' }]) {
      await assert.rejects(prepare(h, 1, fingerprint, [{ ...rows(1)[0], ...patch }]))
    }
    await assert.rejects(prepare(h, 2, fingerprint, [rows(1)[0], rows(1)[0]]), /source-row/)
    const plan = await prepare(h)
    await assert.rejects(importPlan.validatePlan(plan, 'another-user', fingerprint), /owner/)
    await assert.rejects(h.service.loadImportPlan('test-user', fingerprint, 'b'.repeat(64)), /source/)
    assert.throws(() => importPlan.chunkSchema.parse({ ...plan.chunks[0], rows: [{ ...plan.chunks[0].rows[0], paymentMode: 'Card', paymentAccountId: null }] }))
  })
  it('stops on incomplete, modified or incompatible manifests', async () => {
    const h = createHarness()
    await prepare(h)
    const path = `${basePath}/importOperations/${fingerprint}/chunks/0`
    const chunk = h.read(path)!
    h.docs.delete(path)
    await assert.rejects(h.service.loadImportPlan('test-user', fingerprint, fingerprint), /incomplete/)
    h.directWrite(path, { ...chunk, payload: chunk.payload.replace('Identical lunch', 'Changed lunch') })
    await assert.rejects(h.service.executeImport('test-user', fingerprint, fingerprint), /damaged/)
    assert.equal(expenses(h).length, 0)
  })
  it('rejects re-reviewing an existing operation with different choices', async () => {
    const h = createHarness()
    await prepare(h)
    await assert.rejects(prepare(h, 1), /different reviewed plan/)
  })
})


describe('Trusted v2 execution boundary', () => {
  it('rejects unauthenticated, cross-user and supplied UID calls', async () => {
    const h = createHarness()
    await prepare(h)
    await assert.rejects(h.invoke(''), /Sign in/)
    await assert.rejects(h.invoke('stranger'), /not found/)
    await assert.rejects(h.invoke('test-user', { operationId: fingerprint, uid: 'stranger' }), /only an operation/)
    assert.equal(expenses(h).length, 0)
  })
  it('blocks v1 operations even with valid-looking legacy receipts', async () => {
    const h = createHarness()
    await prepare(h)
    const path = `${basePath}/importOperations/${fingerprint}`
    h.directWrite(path, { ...h.read(path), version: 1 })
    h.directWrite(`${path}/receipts/0`, { hash: h.read(path)!.hashes[0], count: 2 })
    await assert.rejects(h.invoke(), /reconciliation/)
    await assert.rejects(h.service.executeImport('test-user', fingerprint, fingerprint), /reconciliation/)
    assert.equal(expenses(h).length, 0)
  })
  it('ignores forged legacy receipts and rejects forged legacy trip provenance', async () => {
    const h = createHarness()
    const tripId = await importPlan.importRecordId(fingerprint, 'trip', 'January')
    await prepare(h, 2, fingerprint, rows(2).map(r => ({ ...r, tripId, isTripRow: true })), { [tripId]: { name: 'Goa', startMillis: 1, endMillis: 2 } })
    const path = `${basePath}/importOperations/${fingerprint}`
    h.directWrite(`${path}/receipts/0`, { hash: h.read(path)!.hashes[0], count: 2 })
    h.directWrite(`${path}/tripReceipts/${tripId}`, { tripId, operationId: fingerprint })
    h.directWrite(`${basePath}/trips/${tripId}`, { importOperationId: fingerprint })
    await assert.rejects(h.invoke(), /collision/)
    assert.equal(expenses(h).length, 0)
    h.docs.delete(`${basePath}/trips/${tripId}`)
    assert.equal((await h.invoke()).imported, 2)
  })
  it('validates the entire plan before writing the first chunk', async () => {
    const h = createHarness()
    await prepare(h, 23)
    const path = `${basePath}/importOperations/${fingerprint}/chunks/1`
    h.directWrite(path, { ...h.read(path), payload: '{}' })
    await assert.rejects(h.invoke())
    assert.equal(expenses(h).length, 0)
  })
  it('rejects missing category references without financial writes', async () => {
    const h = createHarness()
    await prepare(h)
    h.docs.delete(`${basePath}/categories/other`)
    await assert.rejects(h.invoke(), /category/)
    assert.equal(expenses(h).length, 0)
  })
  it('rejects malicious financial fields even with recomputed valid hashes', async () => {
    for (const patch of [{ amountPaise: 1.5 }, { amountPaise: -1 }, { amountPaise: Number.MAX_SAFE_INTEGER + 1 },
      { paymentMode: 'Card', paymentAccountId: 'foreign-account' }, { splits: [{ repaidPaise: 500 }] }, { transactionId: 'manual' },
      { newTrip: { name: 'Forged', startMillis: 1, endMillis: 2 }, tripId: `import-v1-trip-${'f'.repeat(64)}` }]) {
      const h = createHarness()
      const plan = await prepare(h)
      const chunk = { ...plan.chunks[0], rows: [{ ...plan.chunks[0].rows[0], ...patch }, plan.chunks[0].rows[1]] }
      const hash = await importPlan.sha256(JSON.stringify(chunk))
      const path = `${basePath}/importOperations/${fingerprint}`
      h.directWrite(path, { ...h.read(path), hashes: [hash] })
      h.directWrite(`${path}/chunks/0`, { index: 0, hash, payload: JSON.stringify(chunk) })
      await assert.rejects(h.invoke())
      assert.equal(expenses(h).length, 0)
    }
  })
  it('rejects a frozen header changed between validation and commit', async () => {
    const h = createHarness()
    await prepare(h)
    const path = `${basePath}/importOperations/${fingerprint}`
    h.options.beforeTransaction = () => h.directWrite(path, { ...h.read(path), fileName: 'mutated.csv' })
    await assert.rejects(h.invoke(), /Frozen plan changed/)
    assert.equal(expenses(h).length, 0)
    assert.equal(h.read(receiptPath(0)), undefined)
  })
  it('rejects inconsistent trusted receipts instead of inferring completion', async () => {
    const h = createHarness()
    await prepare(h)
    h.directWrite(receiptPath(0), { hash: 'forged', count: 2 })
    await assert.rejects(h.invoke(), /Invalid trusted receipt/)
    assert.equal(expenses(h).length, 0)
  })
  it('can confirm completed imports after their original references were deleted', async () => {
    const h = createHarness()
    await prepare(h)
    await h.invoke()
    h.docs.delete(`${basePath}/categories/other`)
    assert.equal((await h.invoke()).complete, true)
  })
  for (const code of ['functions/unauthenticated', 'functions/permission-denied', 'functions/unavailable', 'functions/not-found']) it(`handles ${code} without client fallback`, async () => {
    const h = createHarness({ callableError: code })
    await prepare(h)
    await assert.rejects(h.service.executeImport('test-user', fingerprint, fingerprint), (e: any) => !e.result.complete && e.result.unresolved === 2)
    assert.equal(expenses(h).length, 0)
  })
})

describe('Import limits and trusted validation cursor', () => {
  it('rejects the audit multibyte 10,000-row plan before any persistence', async () => {
    const h = createHarness()
    const before = new Map(h.docs)
    await assert.rejects(prepare(h, 10000, fingerprint, rows(10000).map(r => ({ ...r, description: '費'.repeat(200) }))), /Split the source file/)
    assert.deepEqual(h.docs, before)
    // A hostile/old client bypassing preflight must still fail on the server.
    const plan = await h.service.buildImportPlan('test-user', fingerprint, fingerprint, 'audit.csv', rows(10000), new Map(), 'other', {}, 0)
    const path = `${basePath}/importOperations/${fingerprint}`
    for (const chunk of plan.chunks) {
      for (const row of chunk.rows) row.description = '費'.repeat(200)
      const payload = JSON.stringify(chunk)
      plan.header.hashes[chunk.index] = await importPlan.sha256(payload)
      h.directWrite(`${path}/chunks/${chunk.index}`, { index: chunk.index, hash: plan.header.hashes[chunk.index], payload })
    }
    h.directWrite(path, { ...plan.header, ready: true })
    await assert.rejects(h.invoke(), error => error instanceof importPlan.ImportSizeError)
    assert.equal(expenses(h).length, 0)
    assert.equal(h.read(`${path}/trustedV2State/execution`), undefined)
  })
  it('surfaces non-retryable server size errors without retry advice or fallback', async () => {
    const h = createHarness({ callableError: 'functions/invalid-argument', callableDetails: { reason: 'import-size-limit', retryable: false } })
    await prepare(h)
    await assert.rejects(h.service.executeImport('test-user', fingerprint, fingerprint), (error: unknown) => error instanceof importPlan.ImportSizeError && !error.message.includes('Resume this same operation'))
    assert.equal(expenses(h).length, 0)
  })
  it('uses exact UTF-8 chunk and aggregate byte boundaries', () => {
    const { addImportPayloadBytes: add, IMPORT_MAX_PLAN_BYTES: max, IMPORT_MAX_CHUNK_BYTES: chunk } = importPlan
    assert.equal(add('費'), 3)
    assert.equal(add('a', max - 2), max - 1)
    assert.equal(add('a', max - 1), max)
    assert.throws(() => add('a', max), /size limit/)
    assert.equal(add('a'.repeat(chunk)), chunk)
    assert.throws(() => add('a'.repeat(chunk + 1)), /size limit/)
  })
  it('binds server state to the header and rejects subsequent header mutation', async () => {
    const h = createHarness()
    await prepare(h, 23)
    await h.invoke()
    const path = `${basePath}/importOperations/${fingerprint}`
    h.directWrite(path, { ...h.read(path), fileName: 'changed' })
    await assert.rejects(h.invoke(), /validation state/)
    assert.equal(expenses(h).length, 20)
  })
  it('rejects chunk replacement after validation without advancing progress', async () => {
    const h = createHarness()
    await prepare(h, 23)
    await h.invoke()
    const path = `${basePath}/importOperations/${fingerprint}`
    const chunk = h.read(`${path}/chunks/1`)!
    h.directWrite(`${path}/chunks/1`, { ...chunk, payload: chunk.payload.replace('Identical lunch', 'Tampered lunch') })
    await assert.rejects(h.invoke(), /Validated chunk changed/)
    assert.equal(h.read(`${path}/trustedV2State/execution`)!.committed, 20)
    assert.equal(expenses(h).length, 20)
  })
  it('rolls back financial writes and proof when the state update fails', async () => {
    const h = createHarness()
    await prepare(h)
    const before = new Map(h.docs)
    h.options.failOnPath = `${basePath}/importOperations/${fingerprint}/trustedV2State/execution`
    await assert.rejects(h.invoke())
    assert.deepEqual(h.docs, before)
  })
  it('reconciles pre-cursor v2 receipts without recreating deleted expenses', async () => {
    const h = createHarness()
    await prepare(h, 23)
    await h.invoke()
    h.docs.delete(`${basePath}/importOperations/${fingerprint}/trustedV2State/execution`)
    h.docs.delete(expenses(h)[0][0])
    const first = await h.invoke()
    assert.equal(first.imported, 3)
    assert.equal(first.alreadyCommitted, 20)
    assert.equal(first.complete, true)
    assert.equal(expenses(h).length, 22)
  })
  it('read budget for 1,000 rows without full-plan rereads', async () => {
    const h = createHarness()
    await prepare(h, 1000)
    const before = h.reads(), started = performance.now(), memory = process.memoryUsage().heapUsed
    let result
    let firstCallMs = 0, firstCallReads = 0
    do {
      result = await h.invoke()
      if (h.calls() === 1) { firstCallMs = Math.round(performance.now() - started); firstCallReads = h.reads() - before }
    } while (!result.complete)
    assert.equal(firstCallReads, 128) // 101 one-time validation reads + 27 execution reads
    const reads = h.reads() - before
    assert.equal(reads, 1451)
    assert.equal(h.calls(), 50)
    console.log(JSON.stringify({ benchmark: 'in-memory production executor', rows: 1000, reads, calls: h.calls(),
      firstCallMs, firstCallReads, elapsedMs: Math.round(performance.now() - started), heapDeltaBytes: process.memoryUsage().heapUsed - memory,
      previousReadsCalculated: 6250, rows10000ReadsEstimated: 14501, previous10000ReadsCalculated: 512500 }))
  })
  it('checks a completed operation using four reads and no financial writes', async () => {
    const h = createHarness()
    await prepare(h)
    await h.invoke()
    const reads = h.reads(), writes = h.appliedWrites()
    assert.equal((await h.invoke()).complete, true)
    assert.equal(h.reads() - reads, 4)
    assert.equal(h.appliedWrites(), writes)
  })
})

describe('Spreadsheet import parsing and normalization', () => {
  const service: Record<string, any> = {}
  const source = readFileSync(new URL('../importExcel.ts', import.meta.url), 'utf8')
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports: service, Date, console: { debug: () => {} },
    require: (name: string) => {
      if (name === 'xlsx') return XLSX
      if (name === 'firebase/firestore') return {}
      if (name === '@/firebase/config') return { db: {} }
      if (name === '@/utils/categoryKeywords') return { suggestCategory: () => null }
      if (name === '@/services/insights') return { invalidateInsightsCache: () => { throw new Error('Parsing cannot write') } }
      if (name === '@/services/transactions') return { deleteTransactionsSafely: () => { throw new Error('Parsing cannot delete') } }
      throw new Error(name)
    },
  })
  it('normalizes amounts to integer paise and rejects invalid amounts/dates', () => {
    assert.equal(service.parseAmount('₹1,234.56'), 123456)
    assert.equal(service.parseAmount(1.005), Math.round(1.005 * 100))
    for (const invalid of ['12garbage', '', '-3', Infinity, Number.MAX_SAFE_INTEGER]) assert.equal(service.parseAmount(invalid), null)
    assert.equal(service.parseExcelDate('29/02/2024'), '2024-02-29')
    assert.equal(service.parseExcelDate('31/02/2026'), null)
    assert.equal(service.parseExcelDate(46023), '2026-01-01')
  })
  it('keeps identical rows separate across a multi-sheet workbook', () => {
    const workbook = XLSX.utils.book_new()
    for (const name of ['January', 'February']) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['Description', 'Amount', 'Date'], ['Lunch', 100, '01/01/2026'], ['Lunch', 100, '01/01/2026'],
    ]), name)
    const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })
    const parsed = service.parseWorkbook(bytes, 'history.xlsx')
    const all = parsed.sheets.flatMap((sheet: { name: string }) => service.parseSheet(parsed.workbook, sheet.name, 'monthly').rows)
    assert.equal(all.length, 4)
    assert.equal(new Set(all.map((r: ParsedRow) => r.rowId)).size, 4)
    assert.ok(all.every((r: ParsedRow) => r.amountPaise === 10000))
  })
  it('parses CSV and flags invalid dates for review without merging identical rows', () => {
    const data = new TextEncoder().encode('Description,Amount,Date\nLunch,100,2026-01-01\nLunch,100,2026-01-01\nUnknown,50,nonsense').buffer
    const parsed = service.parseWorkbook(data, 'January.csv')
    const result = service.parseSheet(parsed.workbook, 'January', 'monthly')
    assert.equal(result.rows.length, 3)
    assert.equal(result.rows[2].dateIssue, 'unparseable')
    assert.notEqual(result.rows[0].rowId, result.rows[1].rowId)
  })
})
