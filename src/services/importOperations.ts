import { collection, doc, getDocFromServer, getDocsFromServer, query, where, runTransaction } from 'firebase/firestore'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { app, db } from '@/firebase/config'
import { headerSchema, chunkSchema, ImportSizeError, addImportPayloadBytes, operationIdSchema, IMPORT_CHUNK_ROWS, IMPORT_MAX_CHUNKS, sha256, importRecordId, validatePlan, type ImportPlan, type ImportHeader, type ImportChunk, type ImportTripDraft } from '@/utils/importPlan'
import type { ParsedRow, ImportProgress } from './importExcel'

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
    chunks.push(chunkSchema.parse({ version: 2, operationId, fingerprint, index: chunks.length, rows: frozen.slice(start, start + IMPORT_CHUNK_ROWS) }))
  }
  const header = headerSchema.parse({ version: 2, ownerUid: uid, operationId, fingerprint, fileName,
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
  if (header.version !== 2) throw new Error('Previous import requires reconciliation. Do not replay it or start a new import as a retry.')
  if (header.operationId !== id) throw new Error('Invalid saved import identity.')
  const chunks: ImportChunk[] = []
  let bytes = 0
  for (let index = 0; index < header.hashes.length; index++) {
    const part = await getDocFromServer(childRef(uid, id, 'chunks', String(index)))
    if (!part.exists()) throw new Error('Saved plan is incomplete; no financial writes can start. Reopen the original review or explicitly start a new operation.')
    const data = part.data()
    if (data.hash !== header.hashes[index] || typeof data.payload !== 'string') throw new Error('Saved import chunk is incompatible.')
    bytes = addImportPayloadBytes(data.payload, bytes)
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

// Only the callable creates financial records and trusted completion proof.
export async function executeImport(uid: string, id: string, fingerprint: string, onProgress: (p: ImportProgress) => void = () => {}): Promise<ImportResult> {
  const plan = await loadImportPlan(uid, id, fingerprint)
  const result: ImportResult = { imported: 0, alreadyCommitted: 0, skipped: plan.header.skipped, unresolved: plan.header.total, complete: false, tripsCreated: 0 }
  const execute = httpsCallable<{ operationId: string }, ImportResult & { total: number }>(getFunctions(app, 'us-central1'), 'executeImportV2', { timeout: 150000 })
  try {
    // A lost response is unknown, not failure proof. Resume asks the server to
    // reconcile durable receipts; there is no client financial-write fallback.
    for (let call = 0; call <= plan.chunks.length; call++) {
      online()
      const { data } = await execute({ operationId: id })
      const counts = [data.imported, data.alreadyCommitted, data.unresolved, data.skipped, data.tripsCreated]
      if (counts.some(n => !Number.isSafeInteger(n) || n < 0) || data.total !== plan.header.total ||
          data.skipped !== plan.header.skipped || data.imported + data.alreadyCommitted + data.unresolved !== data.total ||
          data.complete !== (data.unresolved === 0)) throw new Error('Invalid server progress response.')
      result.imported += data.imported
      result.alreadyCommitted = data.total - data.unresolved - result.imported
      result.tripsCreated += data.tripsCreated
      result.unresolved = data.unresolved
      result.complete = data.complete
      onProgress({ total: data.total, done: data.total - data.unresolved, batchNum: call + 1, totalBatches: plan.chunks.length })
      if (result.complete) return result
    }
    throw new Error('The server has not confirmed completion.')
  } catch (error) {
    if ((error as { details?: { reason?: string } })?.details?.reason === 'import-size-limit') throw new ImportSizeError()
    const code = (error as { code?: string })?.code
    const reason = code === 'functions/unauthenticated' ? 'Sign in again to resume.'
      : code === 'functions/permission-denied' ? 'Import access was denied.'
      : code === 'functions/unavailable' || code === 'functions/not-found' ? 'The import backend is unavailable.'
      : error instanceof Error ? error.message : 'The server result is unknown.'
    throw new ImportExecutionError(`${reason} ${result.unresolved} rows remain unconfirmed; some may have committed. Resume this same operation safely; do not start a new import to retry.`, { ...result })
  }
}
