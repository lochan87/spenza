import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Explicit opt-in, loopback only, demo project only. Never uses .env or production config.
const host = process.env.SPENZA_FIRESTORE_EMULATOR_HOST
it('Firestore emulator: import ownership, immutable plans, schema bounds and receipts', { skip: !host }, async () => {
  assert.match(host!, /^(localhost|127\.0\.0\.1):\d+$/)
  const projectId = 'demo-spenza-import'
  const rules = readFileSync(new URL('../../../firestore.rules', import.meta.url), 'utf8')
  const response = await fetch(`http://${host}/emulator/v1/projects/${projectId}:securityRules`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: { files: [{ name: 'firestore.rules', content: rules }] } }),
  })
  assert.ok(response.ok, await response.text())
  const { initializeApp, deleteApp } = await import('firebase/app')
  const { getFirestore, connectFirestoreEmulator, doc, setDoc, getDoc, updateDoc, deleteDoc, serverTimestamp, terminate } = await import('firebase/firestore')
  const owner = initializeApp({ projectId }, `import-owner-${Date.now()}`)
  const stranger = initializeApp({ projectId }, `import-stranger-${Date.now()}`)
  const anonymous = initializeApp({ projectId }, `import-anonymous-${Date.now()}`)
  const db = getFirestore(owner), other = getFirestore(stranger), anon = getFirestore(anonymous)
  const [hostname, port] = host!.split(':')
  connectFirestoreEmulator(db, hostname, Number(port), { mockUserToken: { sub: 'owner', user_id: 'owner' } })
  connectFirestoreEmulator(other, hostname, Number(port), { mockUserToken: { sub: 'stranger', user_id: 'stranger' } })
  connectFirestoreEmulator(anon, hostname, Number(port))
  try {
    const fingerprint = 'a'.repeat(64)
    const id = `${fingerprint}-${crypto.randomUUID()}`
    const path = `users/owner/importOperations/${id}`
    const header = { version: 1, ownerUid: 'owner', operationId: id, fingerprint, fileName: 'test.csv', hashes: ['b'.repeat(64)], total: 1, skipped: 0, ready: false }
    await assert.rejects(setDoc(doc(other, path), header))
    await assert.rejects(setDoc(doc(anon, path), header))
    await assert.rejects(setDoc(doc(db, path), { ...header, total: 10001 }))
    await assert.rejects(setDoc(doc(db, path), { ...header, extra: true }))
    await assert.rejects(setDoc(doc(db, path), { ...header, ownerUid: 'stranger' }))
    await assert.rejects(setDoc(doc(db, path), { ...header, ready: true }))
    await setDoc(doc(db, path), header)
    await assert.rejects(getDoc(doc(other, path)))
    await assert.rejects(getDoc(doc(anon, path)))
    const chunk = { index: 0, hash: header.hashes[0], payload: '{}' }
    await assert.rejects(setDoc(doc(db, `${path}/chunks/0`), { ...chunk, payload: 'x'.repeat(90001) }))
    await assert.rejects(setDoc(doc(db, `${path}/chunks/1`), chunk))
    await setDoc(doc(db, `${path}/chunks/0`), chunk)
    await assert.rejects(setDoc(doc(db, `${path}/chunks/0`), chunk))
    await assert.rejects(getDoc(doc(other, `${path}/chunks/0`)))
    await assert.rejects(updateDoc(doc(db, path), { fileName: 'changed' }))
    await updateDoc(doc(db, path), { ready: true })
    await assert.rejects(updateDoc(doc(db, path), { ready: false }))
    const receipt = { hash: chunk.hash, count: 1, committedAt: serverTimestamp() }
    await assert.rejects(setDoc(doc(db, `${path}/receipts/0`), { ...receipt, count: 21 }))
    await setDoc(doc(db, `${path}/receipts/0`), receipt)
    await assert.rejects(getDoc(doc(other, `${path}/receipts/0`)))
    await assert.rejects(deleteDoc(doc(db, `${path}/receipts/0`)))
    await assert.rejects(deleteDoc(doc(db, path)))
    const tripId = `import-v1-trip-${'c'.repeat(64)}`
    await setDoc(doc(db, `${path}/tripReceipts/${tripId}`), { tripId, operationId: id })
    await assert.rejects(getDoc(doc(other, `${path}/tripReceipts/${tripId}`)))
    await assert.rejects(deleteDoc(doc(db, `${path}/tripReceipts/${tripId}`)))
    await assert.rejects(setDoc(doc(other, 'users/owner/transactions/collision'), { amountPaise: 1 }))
  } finally {
    await Promise.all([terminate(db), terminate(other), terminate(anon)])
    await Promise.all([deleteApp(owner), deleteApp(stranger), deleteApp(anonymous)])
  }
})
