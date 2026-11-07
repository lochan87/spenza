import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import { headerSchema, chunkSchema, validatePlan, operationIdSchema, sha256, addImportPayloadBytes, type ImportChunk } from '../../src/utils/importPlan.ts'

/** Executes at most one chunk per call. Client plans are immutable by rules,
 * but remain untrusted inputs. The first commit seals a fully validated plan.
 * Only this Admin SDK boundary can create trustedV2 proof documents.
 */
export async function executeTrustedImport(db: Firestore, uid: string, input: unknown) {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in before importing.')
  if (!input || typeof input !== 'object' || Object.keys(input).join(',') !== 'operationId') throw new HttpsError('invalid-argument', 'Supply only an operation ID.')
  const id = operationIdSchema.parse((input as { operationId: unknown }).operationId)
  const op = db.doc(`users/${uid}/importOperations/${id}`)
  const snapshot = await op.get()
  if (!snapshot.exists) throw new HttpsError('not-found', 'Import operation not found.')
  if (snapshot.data()!.version !== 2) throw new HttpsError('failed-precondition', 'Previous import requires reconciliation. No transactions have been changed.')
  const header = headerSchema.parse(snapshot.data())
  if (header.operationId !== id || header.ownerUid !== uid) throw new Error('Operation identity mismatch')
  if (!header.ready) throw new HttpsError('failed-precondition', 'Finish saving the reviewed plan before executing.')
  const binding = await sha256(JSON.stringify(header))
  const stateRef = op.collection('trustedV2State').doc('execution')
  const sealed = await stateRef.get()
  const initialState = { version: 1, binding, nextChunk: 0, committed: 0 }
  if (!sealed.exists) {
    const chunks: ImportChunk[] = []
    let bytes = 0
    for (let start = 0; start < header.hashes.length; start += 20) {
      const parts = await Promise.all(header.hashes.slice(start, start + 20).map((_, offset) => op.collection('chunks').doc(String(start + offset)).get()))
      for (const [offset, snap] of parts.entries()) {
        const index = start + offset
        const data = snap.data()
        if (!data || Object.keys(data).sort().join(',') !== 'hash,index,payload' || data.index !== index || data.hash !== header.hashes[index] || typeof data.payload !== 'string') throw new Error('Invalid manifest chunk')
        bytes = addImportPayloadBytes(data.payload, bytes)
        chunks.push(chunkSchema.parse(JSON.parse(data.payload)))
      }
    }
    await validatePlan({ header, chunks }, uid, header.fingerprint)
    // Receipts are server-owned. Completed chunks need no live references: users
    // may legitimately delete their expenses, categories or trips afterwards.
    const receipts = new Map<number, boolean>()
    for (let start = 0; start < chunks.length; start += 20) {
      await Promise.all(chunks.slice(start, start + 20).map(async chunk => {
        const proof = await op.collection('trustedV2Receipts').doc(String(chunk.index)).get()
        if (proof.exists && (proof.data()!.hash !== header.hashes[chunk.index] || proof.data()!.count !== chunk.rows.length)) throw new Error('Invalid trusted receipt')
        receipts.set(chunk.index, proof.exists)
        for (const row of chunk.rows) {
          Timestamp.fromMillis(row.dateMillis)
          if (row.newTrip) { Timestamp.fromMillis(row.newTrip.startMillis); Timestamp.fromMillis(row.newTrip.endMillis) }
        }
      }))
    }
    for (const chunk of chunks) {
      if (!receipts.get(chunk.index)) break
      initialState.nextChunk++
      initialState.committed += chunk.rows.length
    }
    // Validate every outstanding reference before the first write, then recheck the
    // chosen chunk transactionally. Only Other/null payments are supported by v2.
    const pending = chunks.filter(c => !receipts.get(c.index)).flatMap(c => c.rows)
    const references = new Set(pending.flatMap(r => [
      `users/${uid}/categories/${r.categoryId}`,
      ...(r.tripId && !r.newTrip ? [`users/${uid}/trips/${r.tripId}`] : []),
    ]))
    const paths = [...references]
    for (let start = 0; start < paths.length; start += 20) {
      await Promise.all(paths.slice(start, start + 20).map(async path => {
        if (!(await db.doc(path).get()).exists) throw new HttpsError('failed-precondition', path.includes('/categories/') ? 'A reviewed category no longer exists.' : 'A reviewed trip no longer exists.')
      }))
    }
  }
  // The cursor and count are server-owned and advance in the same transaction
  // as the proof. Existing v2 receipts seed the validated prefix; none are replayed.
  const outcome = await db.runTransaction(async txn => {
    const current = await txn.get(op)
    const savedState = await txn.get(stateRef)
    if (JSON.stringify(headerSchema.parse(current.data())) !== JSON.stringify(header)) throw new Error('Frozen plan changed')
    if (sealed.exists && !savedState.exists) throw new Error('Trusted validation state disappeared')
    const state = savedState.exists ? savedState.data()! : initialState
    if (state.version !== 1 || state.binding !== binding || !Number.isSafeInteger(state.nextChunk) || state.nextChunk < 0 || state.nextChunk > header.hashes.length ||
        !Number.isSafeInteger(state.committed) || state.committed < 0 || state.committed > header.total) throw new Error('Invalid trusted validation state')
    if (state.nextChunk === header.hashes.length) {
      if (state.committed !== header.total) throw new Error('Invalid trusted completion count')
      if (!savedState.exists) txn.set(stateRef, state)
      return { imported: 0, trips: 0, committed: state.committed }
    }
    const chunkSnap = await txn.get(op.collection('chunks').doc(String(state.nextChunk)))
    const data = chunkSnap.data()
    if (!data || typeof data.payload !== 'string' || data.index !== state.nextChunk || data.hash !== header.hashes[state.nextChunk]) throw new Error('Invalid validated chunk')
    addImportPayloadBytes(data.payload)
    const chunk = chunkSchema.parse(JSON.parse(data.payload))
    if (chunk.index !== state.nextChunk || chunk.operationId !== id || chunk.fingerprint !== header.fingerprint || await sha256(JSON.stringify(chunk)) !== data.hash) throw new Error('Validated chunk changed')
    const proof = op.collection('trustedV2Receipts').doc(String(chunk.index))
    const receipt = await txn.get(proof)
    const committed = state.committed + chunk.rows.length
    const nextState = { version: 1, binding, nextChunk: state.nextChunk + 1, committed }
    if (committed > header.total || (nextState.nextChunk === header.hashes.length && committed !== header.total)) throw new Error('Invalid completion count')
    if (receipt.exists) {
      if (receipt.data()!.hash !== header.hashes[chunk.index] || receipt.data()!.count !== chunk.rows.length) throw new Error('Invalid trusted receipt')
      txn.set(stateRef, nextState)
      return { imported: 0, trips: 0, committed }
    }
    const expenseRefs = chunk.rows.map(row => db.doc(`users/${uid}/transactions/${row.transactionId}`))
    const expenses = await txn.getAll(...expenseRefs)
    if (expenses.some(e => e.exists)) throw new HttpsError('already-exists', 'An existing expense conflicts with this import; nothing was overwritten.')
    const categoryRefs = [...new Set(chunk.rows.map(r => r.categoryId))].map(key => db.doc(`users/${uid}/categories/${key}`))
    if ((await txn.getAll(...categoryRefs)).some(s => !s.exists)) throw new Error('Category missing')
    const tripRows = [...new Map(chunk.rows.filter(r => r.tripId).map(r => [r.tripId!, r])).values()]
    const trips = []
    for (const row of tripRows) {
      const ref = db.doc(`users/${uid}/trips/${row.tripId}`)
      const marker = op.collection('trustedV2Trips').doc(row.tripId!)
      const trip = await txn.get(ref)
      const previous = await txn.get(marker)
      if (previous.exists && (previous.data()!.operationId !== id || previous.data()!.tripId !== row.tripId)) throw new Error('Invalid trusted trip marker')
      if (!row.newTrip && !trip.exists) throw new HttpsError('failed-precondition', 'A reviewed trip no longer exists.')
      if (row.newTrip && previous.exists && !trip.exists) throw new HttpsError('failed-precondition', 'Imported trip was deleted; reconciliation required')
      if (row.newTrip && trip.exists && !previous.exists) throw new HttpsError('already-exists', 'Trip ID collision; reconciliation required')
      trips.push({ row, ref, marker, create: !!row.newTrip && !trip.exists })
    }
    for (const { row, ref, marker, create } of trips) if (create) {
      const draft = row.newTrip!
      txn.create(ref, { id: row.tripId, name: draft.name, startDate: Timestamp.fromMillis(draft.startMillis), endDate: Timestamp.fromMillis(draft.endMillis),
        coverEmoji: '✈️', coverColor: '#06B6D4', budgetPaise: null, isArchived: false, notes: 'Imported from spreadsheet', importOperationId: id,
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
      txn.create(marker, { operationId: id, tripId: row.tripId })
    }
    chunk.rows.forEach((row, i) => txn.create(expenseRefs[i], {
      id: row.transactionId, amountPaise: row.amountPaise, description: row.description, categoryId: row.categoryId,
      type: row.tripId ? 'trip' : 'everyday', date: Timestamp.fromMillis(row.dateMillis), paymentMode: 'Other', paymentAccountId: null,
      tripId: row.tripId, personId: null, tags: [], notes: '', receiptUrl: null, recoverablePaise: 0, splits: [], reimbursementStatus: 'none',
      isImported: true, importSource: 'excel', importOperationId: id, importSourceRowId: row.sourceRowId,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    }))
    txn.delete(db.doc(`users/${uid}/insights/summary`))
    txn.create(proof, { hash: header.hashes[chunk.index], count: chunk.rows.length, committedAt: FieldValue.serverTimestamp() })
    txn.set(stateRef, nextState)
    return { imported: chunk.rows.length, trips: trips.filter(t => t.create).length, committed }
  })
  return { imported: outcome.imported, alreadyCommitted: outcome.committed - outcome.imported, skipped: header.skipped,
    unresolved: header.total - outcome.committed, complete: outcome.committed === header.total, tripsCreated: outcome.trips, total: header.total }
}
