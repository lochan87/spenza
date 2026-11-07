import { it } from 'node:test'
import assert from 'node:assert/strict'
import { executeTrustedImport } from '../src/importExecutor.ts'
import { importRecordId, sha256 } from '../../src/utils/importPlan.ts'

const host = process.env.SPENZA_FIRESTORE_EMULATOR_HOST
it('Firestore emulator: concurrent Admin execution, atomic proof and deleted-row preservation', { skip: !host }, async () => {
  assert.match(host!, /^(localhost|127\.0\.0\.1):\d+$/)
  // Explicit isolated emulator only; never load application Firebase configuration.
  process.env.FIRESTORE_EMULATOR_HOST = host
  const { initializeApp, deleteApp } = await import('firebase-admin/app')
  const { getFirestore } = await import('firebase-admin/firestore')
  const app = initializeApp({ projectId: 'demo-spenza-import' }, `executor-${Date.now()}`)
  const db = getFirestore(app)
  try {
    const uid = `executor-${crypto.randomUUID()}`
    const fingerprint = 'e'.repeat(64)
    const operationId = `${fingerprint}-${crypto.randomUUID()}`
    const op = db.doc(`users/${uid}/importOperations/${operationId}`)
    const tripId = await importRecordId(operationId, 'trip', 'Sheet')
    const rows = await Promise.all([0, 1].map(async index => ({ sourceRowId: `Sheet::${index}`,
      transactionId: await importRecordId(operationId, 'row', `Sheet::${index}`), amountPaise: 12345,
      description: 'Identical rows', categoryId: 'other', dateMillis: 1700000000000,
      tripId, newTrip: { name: 'Trip', startMillis: 1700000000000, endMillis: 1700000000000 }, paymentMode: 'Other', paymentAccountId: null })))
    const chunk = { version: 2, operationId, fingerprint, index: 0, rows }
    const payload = JSON.stringify(chunk), hash = await sha256(payload)
    await op.create({ version: 2, ownerUid: uid, operationId, fingerprint, fileName: 'test.csv', hashes: [hash], total: 2, skipped: 0, ready: true })
    await op.collection('chunks').doc('0').create({ index: 0, hash, payload })
    await db.doc(`users/${uid}/categories/other`).create({ name: 'Other' })
    const cache = db.doc(`users/${uid}/insights/summary`)
    await cache.create({ cached: true })
    const results = await Promise.all([executeTrustedImport(db, uid, { operationId }), executeTrustedImport(db, uid, { operationId })])
    assert.equal(results.reduce((sum, r) => sum + r.imported, 0), 2)
    assert.ok(results.every(r => r.complete))
    assert.equal((await db.collection(`users/${uid}/transactions`).get()).size, 2)
    assert.equal((await cache.get()).exists, false)
    assert.equal((await op.collection('trustedV2Receipts').doc('0').get()).data()!.count, 2)
    const { initializeApp: clientApp, deleteApp: deleteClient } = await import('firebase/app')
    const { getFirestore: clientDb, connectFirestoreEmulator, doc, getDoc, setDoc, updateDoc, deleteDoc, terminate } = await import('firebase/firestore')
    const client = clientApp({ projectId: 'demo-spenza-import' }, uid)
    const firestore = clientDb(client)
    const [hostname, port] = host!.split(':')
    connectFirestoreEmulator(firestore, hostname, Number(port), { mockUserToken: { sub: uid, user_id: uid } })
    try {
      for (const child of ['trustedV2Receipts/0', `trustedV2Trips/${tripId}`, 'trustedV2State/execution']) {
        const proof = doc(firestore, `${op.path}/${child}`)
        const stored = await getDoc(proof)
        assert.equal(stored.exists(), true)
        await assert.rejects(setDoc(proof, stored.data()!))
        await assert.rejects(updateDoc(proof, { operationId }))
        await assert.rejects(deleteDoc(proof))
      }
    } finally {
      await terminate(firestore)
      await deleteClient(client)
    }
    // Discarding the first response and retrying has the same durable outcome.
    await db.doc(`users/${uid}/transactions/${rows[0].transactionId}`).delete()
    const retry = await executeTrustedImport(db, uid, { operationId })
    assert.equal(retry.alreadyCommitted, 2)
    assert.equal((await db.collection(`users/${uid}/transactions`).get()).size, 1)
  } finally {
    await db.terminate()
    await deleteApp(app)
  }
})
