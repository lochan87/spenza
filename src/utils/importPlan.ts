import { z } from 'zod'
import { TransactionSchema } from './schemas.ts'

// Versioned, bounded frozen plans. No source workbook or secrets are persisted.
export const IMPORT_CHUNK_ROWS = 20
export const IMPORT_MAX_CHUNKS = 500
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const id = z.string().min(1).max(200).refine(v => !v.includes('/') && v !== '.' && v !== '..')
export const operationIdSchema = z.string().regex(/^[a-f0-9]{64}(?:-[a-f0-9-]{36})?$/)
const tripDraftSchema = z.object({
  name: z.string().min(1).max(200), startMillis: z.number().int(), endMillis: z.number().int(),
}).strict().refine(t => t.endMillis >= t.startMillis && Number.isFinite(new Date(t.startMillis).getTime()) && Number.isFinite(new Date(t.endMillis).getTime()))
export type ImportTripDraft = z.infer<typeof tripDraftSchema>
const rowSchema = z.object({
  sourceRowId: z.string().min(1).max(500).refine(value => {
    const separator = value.lastIndexOf('::')
    const index = value.slice(separator + 2)
    return separator > 0 && /^(0|[1-9]\d*)$/.test(index) && Number.isSafeInteger(Number(index))
  }), transactionId: id,
  amountPaise: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  description: z.string().min(1).max(200), categoryId: id, dateMillis: z.number().int(),
  tripId: id.nullable(), newTrip: tripDraftSchema.nullable(),
  paymentMode: z.literal('Other'), paymentAccountId: z.null(),
}).strict().superRefine((r, ctx) => {
  if (!Number.isFinite(new Date(r.dateMillis).getTime()) || (r.newTrip && !r.tripId)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid import date or trip' })
  }
  const result = TransactionSchema.safeParse({ ...r, date: String(r.dateMillis), type: r.tripId ? 'trip' : 'everyday' })
  if (!result.success) ctx.addIssue({ code: 'custom', message: 'Invalid financial row' })
})
export type FrozenImportRow = z.infer<typeof rowSchema>
export const chunkSchema = z.object({
  version: z.literal(2), operationId: operationIdSchema, fingerprint: hash,
  index: z.number().int().min(0).max(IMPORT_MAX_CHUNKS - 1), rows: z.array(rowSchema).min(1).max(IMPORT_CHUNK_ROWS),
}).strict()
export type ImportChunk = z.infer<typeof chunkSchema>
export const headerSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), ownerUid: z.string().min(1), operationId: operationIdSchema, fingerprint: hash,
  fileName: z.string().min(1).max(250), hashes: z.array(hash).min(1).max(IMPORT_MAX_CHUNKS),
  total: z.number().int().min(1).max(IMPORT_MAX_CHUNKS * IMPORT_CHUNK_ROWS),
  skipped: z.number().int().min(0).max(1000000), ready: z.boolean(),
}).strict()
export type ImportHeader = z.infer<typeof headerSchema>
export interface ImportPlan { header: ImportHeader; chunks: ImportChunk[] }

export async function sha256(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
}
export function newImportOperation(fingerprint: string, explicitlyNew = false): string {
  hash.parse(fingerprint)
  return fingerprint + (explicitlyNew ? `-${crypto.randomUUID()}` : '')
}
export async function importRecordId(operationId: string, kind: 'row' | 'trip', source: string): Promise<string> {
  operationIdSchema.parse(operationId)
  return `import-v1-${kind}-${await sha256(JSON.stringify([operationId, source]))}`
}
export async function validatePlan(plan: ImportPlan, uid: string, fingerprint: string): Promise<ImportPlan> {
  const header = headerSchema.parse(plan.header)
  if (header.version !== 2) throw new Error('Previous import requires reconciliation. No transactions have been changed.')
  if (header.ownerUid !== uid || header.fingerprint !== fingerprint || !(header.operationId === fingerprint || header.operationId.startsWith(fingerprint + '-'))) throw new Error('Import owner or source does not match.')
  if (plan.chunks.length !== header.hashes.length) throw new Error('Saved import plan is incomplete. No rows were changed.')
  const seen = new Set<string>()
  const trips = new Map<string, string>()
  const chunks: ImportChunk[] = []
  for (const [index, raw] of plan.chunks.entries()) {
    const chunk = chunkSchema.parse(raw)
    if (chunk.index !== index || chunk.operationId !== header.operationId || chunk.fingerprint !== fingerprint ||
        await sha256(JSON.stringify(chunk)) !== header.hashes[index]) throw new Error('Saved import plan is incompatible or damaged.')
    for (const row of chunk.rows) {
      if (seen.has(row.sourceRowId) || row.transactionId !== await importRecordId(header.operationId, 'row', row.sourceRowId)) throw new Error('Conflicting source-row identity.')
      seen.add(row.sourceRowId)
      if (row.tripId) {
        const draft = JSON.stringify(row.newTrip)
        if (trips.has(row.tripId) && trips.get(row.tripId) !== draft) throw new Error('Conflicting trip choices.')
        trips.set(row.tripId, draft)
        const separator = row.sourceRowId.lastIndexOf('::')
        if (row.newTrip && (separator < 1 || row.tripId !== await importRecordId(header.operationId, 'trip', row.sourceRowId.slice(0, separator)))) throw new Error('Invalid imported trip identity.')
      }
    }
    chunks.push(chunk)
  }
  if (seen.size !== header.total) throw new Error('Import row count does not match the saved plan.')
  return { header, chunks }
}
