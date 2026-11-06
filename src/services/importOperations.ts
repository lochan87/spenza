/**
 * Import protocol v1 (requires separately reviewed/deployed importOperations rules).
 * Header: owner, exact source-byte SHA-256, operation ID, ordered chunk hashes and
 * counts. Chunks: immutable JSON of selected rows with frozen dates/categories/
 * payment and trip choices. Header sealing happens only after every hash verifies.
 * Receipts are permanent: never infer missing work from deleted/edited expenses.
 * Default operation ID is the fingerprint; explicit repeats append a UUID.
 * Legacy random-ID imports cannot be identified retrospectively and are untouched.
 *
 * Limits: 20 rows/chunk, 500 chunks (10,000 rows), 90 KB encoded chunk. Worst case
 * execution creates 20 expenses + 20 trips + 20 trip receipts + one completion
 * receipt and deletes only insights/summary (62 writes). Rules use two dependent
 * reads for a completion receipt and none per financial/trip-receipt write.
 * Preparation is resumable in the open review; incomplete plans after reopening
 * stop safely. Execution is atomic per chunk, never across an entire import.
 * Dates retain the existing local-noon policy, frozen to epoch milliseconds so
 * resumption in another timezone cannot alter reviewed dates.
 * Source files are not uploaded. Rules/SDK limits: firebase.google.com/docs/firestore/quotas
 */
import { collection, doc, getDocFromServer, getDocsFromServer, query, where, runTransaction, serverTimestamp, Timestamp } from 'firebase/firestore'
import { db } from '@/firebase/config'
import { headerSchema, chunkSchema, operationIdSchema, IMPORT_CHUNK_ROWS, IMPORT_MAX_CHUNKS, sha256, importRecordId, validatePlan, type ImportPlan, type ImportHeader, type ImportChunk, type ImportTripDraft } from '@/utils/importPlan'
import type { ParsedRow, ImportProgress } from './importExcel'
import { TRIP_ACCENT_COLOR } from '@/utils/tripBuckets'

const opRef = (uid: string, id: string) => doc(db, 'users', uid, 'importOperations', operationIdSchema.parse(id))
const childRef = (uid: string, id: string, kind: string, key: string) => doc(db, 'users', uid, 'importOperations', operationIdSchema.parse(id), kind, key)
const online = () => {
  if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('Imports require a connection. Reconnect and resume the same operation.')
}
export interface ImportResult {
  imported: number; alreadyCommitted: number; skipped: number; unresolved: number; complete: boolean; tripsCreated: number
}
export class ImportExecutionError extends Error {
  result: ImportResult
  constructor(message: string, result: ImportResult) { super(message); this.result = result }
}

export async function buildImportPlan(uid: string, operationId: string, fingerprint: string, fileName: string,
  rows: ParsedRow[], categories: Map<string, string>, otherId: string, newTrips: Record<string, ImportTripDraft>, skipped: number): Promise<ImportPlan> {
  if (!rows.length || rows.length > IMPORT_CHUNK_ROWS * IMPORT_MAX_CHUNKS) throw new Error('Select between 1 and 10,000 rows per import operation.')
  const frozen = await Promise.all(rows.map(async row => {
    // Preserve the existing local-noon import policy, freezing the exact instant once.
    const date = new Date(row.dateStr + 'T12:00:00')
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.dateStr) || key !== row.dateStr) throw new Error(`Correct the date for ${row.description} before importing.`)
    if (row.isTripRow && !row.tripId) throw new Error('A trip row must reference a reviewed trip.')
    return {
      sourceRowId: row.rowId, transactionId: await importRecordId(operationId, 'row', row.rowId),
      amountPaise: row.amountPaise, description: row.description,
      categoryId: row.resolvedCategoryId ?? (row.suggestedCategoryName ? categories.get(row.suggestedCategoryName) : null) ?? otherId,
      dateMillis: date.getTime(), tripId: row.tripId, newTrip: row.tripId ? newTrips[row.tripId] ?? null : null,
      paymentMode: 'Other' as const, paymentAccountId: null,
    }
  }))
  const chunks: ImportChunk[] = []
  for (let start = 0; start < frozen.length; start += IMPORT_CHUNK_ROWS) {
    chunks.push(chunkSchema.parse({ version: 1, operationId, fingerprint, index: chunks.length, rows: frozen.slice(start, start + IMPORT_CHUNK_ROWS) }))
  }
  // Keep well below Firestore's 1 MiB document and 10 MiB transaction limits.
  for (const chunk of chunks) if (new TextEncoder().encode(JSON.stringify(chunk)).length > 90000) throw new Error('Import chunk is too large. Shorten source descriptions or split the file.')
  const header = headerSchema.parse({ version: 1, ownerUid: uid, operationId, fingerprint, fileName,
    hashes: await Promise.all(chunks.map(c => sha256(JSON.stringify(c)))), total: rows.length, skipped, ready: false })
  return validatePlan({ header, chunks }, uid, fingerprint)
}

export async function findImportOperations(uid: string, fingerprint: string): Promise<ImportHeader[]> {
  online()
  const snap = await getDocsFromServer(query(collection(db, 'users', uid, 'importOperations'), where('fingerprint', '==', fingerprint)))
  return snap.docs.map(d => {
    const header = headerSchema.parse(d.data())
    if (header.ownerUid !== uid || header.operationId !== d.id) throw new Error('Invalid saved import identity.')
    return header
  })
}

export async function loadImportPlan(uid: string, id: string, fingerprint: string): Promise<ImportPlan> {
  online()
  const snap = await getDocFromServer(opRef(uid, id))
  if (!snap.exists()) throw new Error('The saved import operation was not found.')
  const header = headerSchema.parse(snap.data())
  if (header.operationId !== id) throw new Error('Invalid saved import identity.')
  const chunks: ImportChunk[] = []
  for (let index = 0; index < header.hashes.length; index++) {
    const part = await getDocFromServer(childRef(uid, id, 'chunks', String(index)))
    if (!part.exists()) throw new Error('Saved plan is incomplete; no financial writes can start. Reopen the original review or explicitly start a new operation.')
    const data = part.data()
    if (data.hash !== header.hashes[index] || typeof data.payload !== 'string' || data.payload.length > 90000) throw new Error('Saved import chunk is incompatible.')
    chunks.push(chunkSchema.parse(JSON.parse(data.payload)))
  }
  const plan = await validatePlan({ header, chunks }, uid, fingerprint)
  if (!header.ready) {
    // Chunks are create-only; once all hashes verify, sealing needs only the header read.
    await runTransaction(db, async txn => {
      const current = await txn.get(opRef(uid, id))
      if (JSON.stringify(headerSchema.parse(current.data())) !== JSON.stringify(header)) throw new Error('Import preparation changed. Reload and resume.')
      txn.update(opRef(uid, id), { ready: true })
    })
    plan.header.ready = true
  }
  return plan
}

export async function saveImportPlan(uid: string, input: ImportPlan): Promise<ImportPlan> {
  online()
  const plan = await validatePlan(input, uid, input.header.fingerprint)
  const { header, chunks } = plan
  const ref = opRef(uid, header.operationId)
  await runTransaction(db, async txn => {
    const existing = await txn.get(ref)
    if (existing.exists()) {
      const saved = headerSchema.parse(existing.data())
      if (JSON.stringify({ ...saved, ready: false }) !== JSON.stringify({ ...header, ready: false })) throw new Error('This source already has a different reviewed plan. Resume that operation instead.')
    } else txn.set(ref, { ...header, ready: false })
  })
  for (const chunk of chunks) {
    const ref = childRef(uid, header.operationId, 'chunks', String(chunk.index))
    const data = { index: chunk.index, hash: header.hashes[chunk.index], payload: JSON.stringify(chunk) }
    await runTransaction(db, async txn => {
      const existing = await txn.get(ref)
      if (existing.exists()) {
        if (existing.data().hash !== data.hash || existing.data().payload !== data.payload) throw new Error('Conflicting immutable import chunk.')
      } else txn.set(ref, data)
    })
  }
  return loadImportPlan(uid, header.operationId, header.fingerprint)
}

// Receipt reads are server-confirmed. A missing expense is not a reason to repeat
// a completed chunk: users may have subsequently edited/deleted its expenses.
export async function executeImport(uid: string, id: string, fingerprint: string, onProgress: (p: ImportProgress) => void = () => {}): Promise<ImportResult> {
  const plan = await loadImportPlan(uid, id, fingerprint)
  const result: ImportResult = { imported: 0, alreadyCommitted: 0, skipped: plan.header.skipped, unresolved: plan.header.total, complete: false, tripsCreated: 0 }
  for (const chunk of plan.chunks) {
    const receiptRef = childRef(uid, id, 'receipts', String(chunk.index))
    try {
      const outcome = await runTransaction(db, async txn => {
        const headerSnap = await txn.get(opRef(uid, id))
        const receipt = await txn.get(receiptRef)
        const saved = headerSchema.parse(headerSnap.data())
        if (!saved.ready || saved.ownerUid !== uid || saved.fingerprint !== fingerprint || saved.hashes[chunk.index] !== plan.header.hashes[chunk.index]) throw new Error('Import plan changed; stop and review.')
        if (receipt.exists()) {
          if (receipt.data().hash !== saved.hashes[chunk.index] || receipt.data().count !== chunk.rows.length) throw new Error('Invalid completion receipt.')
          return { already: true, trips: 0 }
        }
        const expenseRefs = chunk.rows.map(r => doc(db, 'users', uid, 'transactions', r.transactionId))
        const expenses = await Promise.all(expenseRefs.map(ref => txn.get(ref)))
        // Even a matching-looking transaction without a receipt is a collision.
        if (expenses.some(s => s.exists())) throw new Error('An existing transaction conflicts with this import. Nothing was overwritten.')
        const tripRows = [...new Map(chunk.rows.filter(r => r.tripId).map(r => [r.tripId!, r])).values()]
        const trips = await Promise.all(tripRows.map(async row => {
          const ref = doc(db, 'users', uid, 'trips', row.tripId!)
          const snap = await txn.get(ref)
          const marker = childRef(uid, id, 'tripReceipts', row.tripId!)
          const previous = row.newTrip ? await txn.get(marker) : null
          if (!row.newTrip && !snap.exists()) throw new Error('A selected trip no longer exists. The frozen plan cannot change its trip choice.')
          if (row.newTrip && previous?.exists() && !snap.exists()) throw new Error('An imported trip was deleted. Restore or review it before resuming; it will not be recreated.')
          if (row.newTrip && snap.exists() && (!previous?.exists() || snap.data().importOperationId !== id)) throw new Error('An existing trip conflicts with this import.')
          return { row, ref, marker, create: !!row.newTrip && !snap.exists() }
        }))
        for (const { row, ref, marker, create } of trips) if (create) {
          const draft = row.newTrip!
          txn.set(ref, { id: row.tripId, name: draft.name, startDate: Timestamp.fromMillis(draft.startMillis), endDate: Timestamp.fromMillis(draft.endMillis),
            coverEmoji: '✈️', coverColor: TRIP_ACCENT_COLOR, budgetPaise: null, isArchived: false, notes: 'Imported from spreadsheet', importOperationId: id,
            createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
          txn.set(marker, { tripId: row.tripId, operationId: id })
        }
        chunk.rows.forEach((row, index) => txn.set(expenseRefs[index], {
          id: row.transactionId, amountPaise: row.amountPaise, description: row.description, categoryId: row.categoryId,
          type: row.tripId ? 'trip' : 'everyday', date: Timestamp.fromMillis(row.dateMillis), paymentMode: row.paymentMode, paymentAccountId: row.paymentAccountId,
          tripId: row.tripId, personId: null, tags: [], notes: '', receiptUrl: null, recoverablePaise: 0, splits: [], reimbursementStatus: 'none',
          isImported: true, importSource: 'excel', importOperationId: id, importSourceRowId: row.sourceRowId,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        }))
        txn.delete(doc(db, 'users', uid, 'insights', 'summary'))
        txn.set(receiptRef, { hash: saved.hashes[chunk.index], count: chunk.rows.length, committedAt: serverTimestamp() })
        return { already: false, trips: trips.filter(t => t.create).length }
      })
      if (outcome.already) result.alreadyCommitted += chunk.rows.length
      else result.imported += chunk.rows.length
      result.tripsCreated += outcome.trips
    } catch (error) {
      // Lost acknowledgments are reconciled against the durable receipt. Never
      // classify unacknowledged rows as failed-to-write merely from a network error.
      try {
        const receipt = await getDocFromServer(receiptRef)
        if (!receipt.exists() || receipt.data().hash !== plan.header.hashes[chunk.index] || receipt.data().count !== chunk.rows.length) throw error
        result.alreadyCommitted += chunk.rows.length
      } catch {
        result.unresolved = plan.header.total - result.imported - result.alreadyCommitted
        throw new ImportExecutionError(`${error instanceof Error ? error.message : 'Could not verify import.'} ${result.unresolved} rows remain unresolved. Resume this same operation safely after reconnecting; do not start a new import to retry.`, { ...result })
      }
    }
    result.unresolved = plan.header.total - result.imported - result.alreadyCommitted
    onProgress({ total: plan.header.total, done: plan.header.total - result.unresolved, batchNum: chunk.index + 1, totalBatches: plan.chunks.length })
  }
  result.complete = result.unresolved === 0
  return result
}
