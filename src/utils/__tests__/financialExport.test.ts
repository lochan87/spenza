import { it } from 'node:test'
import assert from 'node:assert/strict'
import { initializeApp, deleteApp } from 'firebase/app'
import { Bytes, Timestamp, GeoPoint, doc, getFirestore, terminate } from 'firebase/firestore'
import { serializeValue, deserializeValue, buildFinancialExportDocument, validateExportIntegrity, type ArchiveInput } from '../financialExport.ts'

function input(data: Record<string, unknown> = {}): ArchiveInput {
  return { uid: 'owner', transactions: [{ id: 'actual-id', path: 'users/owner/transactions/actual-id', data }], categories: [], paymentAccounts: [], people: [] }
}
const roundTrip = (value: unknown) => deserializeValue(JSON.parse(JSON.stringify(serializeValue(value))))

it('preserves malformed monetary values, legacy absence, unknown fields and conflicting stored IDs', () => {
  const raw = { id: 'wrong-id', amountPaise: 100.6, recoverablePaise: 900, type: 'reimbursable',
    splits: [{ amountPaise: -2, repaidPaise: '500', customEvidence: [false, null] }], unknown: { schema: 'old' } }
  const source = input(raw), before = structuredClone(raw)
  const archive = buildFinancialExportDocument(source)
  assert.equal(archive.version, 2)
  assert.equal(archive.data.transactions[0].id, 'actual-id')
  assert.equal(archive.data.transactions[0].path, 'users/owner/transactions/actual-id')
  const restored = deserializeValue(archive.data.transactions[0].data) as Record<string, unknown>
  assert.deepEqual(restored, raw)
  assert.equal(Object.hasOwn(restored, 'date'), false)
  assert.equal(Object.hasOwn(restored, 'reimbursementStatus'), false)
  assert.deepEqual(raw, before)
  assert.ok(archive.metadata.derived.warnings.length > 1)
  assert.equal(validateExportIntegrity(JSON.parse(JSON.stringify(archive)), source).valid, true)
})

it('round-trips nested Timestamp, Date, GeoPoint, Bytes, arrays and maps without tag collisions', () => {
  const value = { timestamp: new Timestamp(-1, 999999999), date: new Date(-1), invalidDate: new Date(NaN),
    geo: new GeoPoint(12.345, -78.9), bytes: Bytes.fromUint8Array(new Uint8Array([0, 255, 128])),
    negativeZero: [new GeoPoint(-0, -0), new Timestamp(-0, -0)],
    array: [null, true, '2020-01-01', { seconds: 123, nanoseconds: 42 }],
    tagCollision: { type: 'timestamp', seconds: 50, nanoseconds: 42 },
    specialKey: JSON.parse('{"__proto__":{"evidence":"kept"},"constructor":null}') }
  const restored = roundTrip(value) as typeof value
  assert.ok(restored.timestamp.isEqual(value.timestamp))
  assert.ok(restored.geo.isEqual(value.geo))
  assert.ok(restored.bytes.isEqual(value.bytes))
  assert.equal(restored.date.getTime(), -1)
  assert.ok(Number.isNaN(restored.invalidDate.getTime()))
  assert.deepEqual(serializeValue(restored), serializeValue(value))
  assert.ok(Object.hasOwn(restored.specialKey, '__proto__'))
  assert.equal(({} as Record<string, unknown>).evidence, undefined)
})

it('preserves NaN, infinities, negative zero and original string/null monetary representations', () => {
  for (const value of [NaN, Infinity, -Infinity, -0, 0, -15, 3.14, '12.50', null]) {
    assert.ok(Object.is(roundTrip(value), value))
    const source = input({ amountPaise: value })
    const archive = buildFinancialExportDocument(source)
    assert.equal(validateExportIntegrity(JSON.parse(JSON.stringify(archive)), source).valid, true)
  }
})

it('round-trips references with project, named database and path identity without network access', async () => {
  const app = initializeApp({ projectId: 'demo-archive-test' }, 'archive-codec-test')
  const db = getFirestore(app, 'financial-history')
  try {
    const ref = doc(db, 'users/owner/transactions/linked')
    const encoded = serializeValue(ref)
    assert.deepEqual(encoded, { type: 'reference', projectId: 'demo-archive-test', databaseId: 'financial-history', path: ref.path })
    assert.equal(deserializeValue(encoded, () => ref), ref)
    assert.throws(() => deserializeValue(encoded), /resolver/)
    assert.throws(() => deserializeValue(encoded, () => doc(db, 'other/path')), /identity/)
    const source = input({ reference: ref })
    assert.equal(validateExportIntegrity(JSON.parse(JSON.stringify(buildFinancialExportDocument(source))), source).valid, true)
  } finally { await terminate(db); await deleteApp(app) }
})

it('rejects unsupported values, cycles, sparse arrays, getters and symbol fields explicitly', () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  const getter = Object.defineProperty({}, 'field', { enumerable: true, get: () => assert.fail('Getter executed') })
  for (const value of [undefined, 2n, Symbol('s'), () => 1, new Map(), new Set(), /pattern/, cyclic,
    [undefined], Array(2), { field: undefined }, getter, { [Symbol('key')]: 1 }]) {
    assert.throws(() => serializeValue(value))
  }
})

it('verifies every collection against fetched source, detecting missing records, fields, identity and corrupted repayment values', () => {
  const source = input({ amountPaise: 10003, recoverablePaise: 5001, splits: [{ personId: 'p', amountPaise: 5001, repaidPaise: 2001 }] })
  source.people.push({ id: 'p', path: 'users/owner/people/p', data: { name: 'Person', extra: null } })
  const original = buildFinancialExportDocument(source)
  assert.equal(validateExportIntegrity(original, source).valid, true)
  for (const mutate of [
    (a: typeof original) => { a.data.transactions = [] },
    (a: typeof original) => { a.data.people = [] },
    (a: typeof original) => { a.data.transactions[0].id = 'different' },
    (a: typeof original) => { a.data.transactions[0].path = 'users/other/transactions/actual-id' },
    (a: typeof original) => { a.data.transactions[0].data = serializeValue({ amountPaise: 10003 }) },
    (a: typeof original) => { a.data.transactions[0].data = serializeValue({ ...source.transactions[0].data, splits: [] }) },
    (a: typeof original) => { a.metadata.derived.totalRepaidPaise = 0 },
  ]) {
    const changed = structuredClone(original); mutate(changed)
    assert.equal(validateExportIntegrity(changed, source).valid, false)
  }
  assert.throws(() => buildFinancialExportDocument({ ...source, transactions: [...source.transactions, ...source.transactions] }), /Duplicate/)
  assert.match(original.disclaimer, /do not prove database completeness/)
})

it('keeps normalized integer-paise summaries separate from the raw ledger', () => {
  const source = input({ amountPaise: 10003, recoverablePaise: 5001, splits: [{ personId: 'p', amountPaise: 5001, repaidPaise: 2001 }] })
  const { derived } = buildFinancialExportDocument(source).metadata
  assert.equal(derived.totalGrossPaise, 10003)
  assert.equal(derived.totalRecoverablePaise, 5001)
  assert.equal(derived.totalNetPaise, 5002)
  assert.equal(derived.totalRepaidPaise, 2001)
})
