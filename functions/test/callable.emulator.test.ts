import { it } from 'node:test'
import assert from 'node:assert/strict'
import { chunkSchema, importRecordId, sha256 } from '../../src/utils/importPlan.ts'

// Fixed loopback/demo endpoints: never use frontend Firebase config or credentials.
const enabled = process.env.SPENZA_CALLABLE_EMULATORS === '1'
it('Auth + Functions + Firestore emulators: authenticated callable, retries and protected state', { skip: !enabled }, async () => {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
  const { initializeApp, deleteApp } = await import('firebase-admin/app')
  const { getFirestore } = await import('firebase-admin/firestore')
  const app = initializeApp({ projectId: 'demo-spenza-import' }, `callable-${Date.now()}`)
  const db = getFirestore(app)
  const signIn = async () => {
    const response = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
    })
    assert.equal(response.ok, true)
    return response.json() as Promise<{ localId: string; idToken: string }>
  }
  const call = async (data: unknown, token?: string) => {
    const response = await fetch('http://127.0.0.1:5001/demo-spenza-import/us-central1/executeImportV2', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ data }),
    })
    return response.json()
  }
  try {
    const owner = await signIn(), stranger = await signIn()
    const fingerprint = 'd'.repeat(64), id = `${fingerprint}-${crypto.randomUUID()}`
    const path = `users/${owner.localId}/importOperations/${id}`
    const chunks = []
    for (let index = 0; index < 2; index++) {
      const rows = await Promise.all(Array.from({ length: index ? 1 : 20 }, async (_, i) => ({
        sourceRowId: `Sheet::${index * 20 + i}`, transactionId: await importRecordId(id, 'row', `Sheet::${index * 20 + i}`),
        description: 'Lunch', amountPaise: 100, categoryId: 'other', dateMillis: 1700000000000,
        tripId: null, newTrip: null, paymentMode: 'Other', paymentAccountId: null,
      })))
      chunks.push(chunkSchema.parse({ version: 2, operationId: id, fingerprint, index, rows }))
    }
    const hashes = await Promise.all(chunks.map(c => sha256(JSON.stringify(c))))
    await db.doc(path).create({ version: 2, ownerUid: owner.localId, operationId: id, fingerprint, fileName: 'test.csv', hashes, total: 21, skipped: 0, ready: true })
    for (const chunk of chunks) await db.doc(`${path}/chunks/${chunk.index}`).create({ index: chunk.index, hash: hashes[chunk.index], payload: JSON.stringify(chunk) })
    await db.doc(`users/${owner.localId}/categories/other`).create({ name: 'Other' })
    assert.equal((await call({ operationId: id })).error.status, 'UNAUTHENTICATED')
    assert.equal((await call({ operationId: id }, stranger.idToken)).error.status, 'NOT_FOUND')
    assert.equal((await call({ operationId: id, uid: stranger.localId }, owner.idToken)).error.status, 'INVALID_ARGUMENT')
    const first = await call({ operationId: id }, owner.idToken)
    assert.equal(first.result.imported, 20)
    assert.equal(first.result.unresolved, 1)
    assert.equal((await db.doc(`${path}/trustedV2State/execution`).get()).data()!.committed, 20)
    const collision = db.doc(`users/${owner.localId}/transactions/${chunks[1].rows[0].transactionId}`)
    await collision.create({ manual: true })
    assert.equal((await call({ operationId: id }, owner.idToken)).error.status, 'ALREADY_EXISTS')
    assert.equal((await db.doc(`${path}/trustedV2Receipts/1`).get()).exists, false)
    await collision.delete() // remove only this test's deliberately injected collision
    await db.doc(`users/${owner.localId}/transactions/${chunks[0].rows[0].transactionId}`).delete()
    const concurrent = await Promise.all([call({ operationId: id }, owner.idToken), call({ operationId: id }, owner.idToken)])
    assert.ok(concurrent.every(r => r.result.complete))
    assert.equal(concurrent.reduce((sum, r) => sum + r.result.imported, 0), 1)
    assert.equal((await db.collection(`users/${owner.localId}/transactions`).get()).size, 20)
    assert.equal((await db.doc(`${path}/trustedV2Receipts/1`).get()).data()!.count, 1)
    // A malformed oversized persisted payload must produce a non-retryable error.
    const oversized = `${fingerprint}-${crypto.randomUUID()}`
    const oversizedPath = `users/${owner.localId}/importOperations/${oversized}`
    const header = (await db.doc(path).get()).data()!
    await db.doc(oversizedPath).create({ ...header, operationId: oversized, hashes: [hashes[0]], total: 20 })
    await db.doc(`${oversizedPath}/chunks/0`).create({ index: 0, hash: hashes[0], payload: 'x'.repeat(90001) })
    const rejected = await call({ operationId: oversized }, owner.idToken)
    assert.equal(rejected.error.status, 'INVALID_ARGUMENT')
    assert.equal(rejected.error.details.retryable, false)
    assert.equal(rejected.error.details.reason, 'import-size-limit')
  } finally {
    await db.terminate()
    await deleteApp(app)
  }
})
