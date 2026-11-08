import { Bytes, DocumentReference, GeoPoint, Timestamp } from 'firebase/firestore'
import type { Transaction } from '../types/index.ts'
import { getNetSpendPaise, getRecoverablePaise, getRepaidPaise, toNonNegativeIntPaise } from './splitMath.ts'

// Every value is tagged, including maps: source fields can never impersonate a codec tag.
export type ArchiveValue =
  | { type: 'null' }
  | { type: 'boolean'; value: boolean }
  | { type: 'string'; value: string }
  | { type: 'number'; value: string }
  | { type: 'date'; value: string }
  | { type: 'timestamp'; seconds: string; nanoseconds: string }
  | { type: 'geopoint'; latitude: string; longitude: string }
  | { type: 'bytes'; value: string }
  | { type: 'reference'; projectId: string; databaseId: string; path: string }
  | { type: 'array'; value: ArchiveValue[] }
  | { type: 'map'; value: [string, ArchiveValue][] }

type ReferenceValue = Extract<ArchiveValue, { type: 'reference' }>
export type ReferenceResolver = (identity: ReferenceValue) => DocumentReference
const referenceKey = (identity: ReferenceValue) => JSON.stringify([identity.projectId, identity.databaseId, identity.path])
const numberText = (value: number) => Object.is(value, -0) ? '-0' : String(value)

/** Operates only on values already read by the caller; never reads or writes Firestore. */
export function serializeValue(value: unknown, references = new Map<string, DocumentReference>()): ArchiveValue {
  const ancestors = new Set<object>()
  function encode(input: unknown): ArchiveValue {
    if (input === null) return { type: 'null' }
    if (typeof input === 'string') return { type: 'string', value: input }
    if (typeof input === 'boolean') return { type: 'boolean', value: input }
    if (typeof input === 'number') return { type: 'number', value: numberText(input) }
    if (input instanceof Timestamp) return { type: 'timestamp', seconds: numberText(input.seconds), nanoseconds: numberText(input.nanoseconds) }
    if (input instanceof Date) return { type: 'date', value: numberText(input.getTime()) }
    if (input instanceof GeoPoint) return { type: 'geopoint', latitude: numberText(input.latitude), longitude: numberText(input.longitude) }
    if (input instanceof Bytes) return { type: 'bytes', value: input.toBase64() }
    if (input instanceof DocumentReference) {
      // toJSON is public SDK API; only copy database identity, never app configuration.
      const { databaseId } = input.firestore.toJSON() as { databaseId: { projectId: string; database: string } }
      const identity: ReferenceValue = { type: 'reference', projectId: databaseId.projectId, databaseId: databaseId.database, path: input.path }
      references.set(referenceKey(identity), input)
      return identity
    }
    if (typeof input !== 'object' || input === undefined) throw new Error(`Unsupported archive value: ${typeof input}`)
    if (ancestors.has(input)) throw new Error('Cyclic archive value')
    ancestors.add(input)
    try {
      const keys = Reflect.ownKeys(input)
      if (keys.some(key => typeof key === 'symbol')) throw new Error('Symbol keys are unsupported')
      if (Array.isArray(input)) {
        if (keys.length !== input.length + 1) throw new Error('Sparse arrays or array properties are unsupported')
        return { type: 'array', value: Array.from({ length: input.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
          if (!descriptor || !('value' in descriptor)) throw new Error('Sparse arrays or accessors are unsupported')
          return encode(descriptor.value)
        }) }
      }
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
        throw new Error('Unsupported archive object type')
      }
      return { type: 'map', value: (keys as string[]).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!
        if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Hidden fields or accessors are unsupported')
        return [key, encode(descriptor.value)]
      }) }
    } finally { ancestors.delete(input) }
  }
  return encode(value)
}

/** Reconstruct values locally. Reference resolution is explicit and must not perform writes. */
export function deserializeValue(encoded: ArchiveValue, resolveReference?: ReferenceResolver): unknown {
  function decode(value: ArchiveValue): unknown {
    switch (value.type) {
      case 'null': return null
      case 'string':
        if (typeof value.value !== 'string') throw new Error('Invalid string')
        return value.value
      case 'boolean':
        if (typeof value.value !== 'boolean') throw new Error('Invalid boolean')
        return value.value
      case 'number':
      case 'date': {
        const number = Number(value.value)
        if (typeof value.value !== 'string' || numberText(number) !== value.value) throw new Error('Invalid numeric encoding')
        return value.type === 'date' ? new Date(number) : number
      }
      case 'timestamp': return new Timestamp(Number(value.seconds), Number(value.nanoseconds))
      case 'geopoint': return new GeoPoint(Number(value.latitude), Number(value.longitude))
      case 'bytes': return Bytes.fromBase64String(value.value)
      case 'reference': {
        if (!resolveReference) throw new Error('A reference resolver is required')
        const reference = resolveReference(value)
        if (JSON.stringify(serializeValue(reference)) !== JSON.stringify(value)) throw new Error('Reference identity mismatch')
        return reference
      }
      case 'array': return value.value.map(decode)
      case 'map': {
        const result: Record<string, unknown> = {}
        for (const [key, entry] of value.value) {
          if (typeof key !== 'string' || Object.hasOwn(result, key)) throw new Error('Invalid or duplicate map field')
          Object.defineProperty(result, key, { value: decode(entry), enumerable: true, writable: true, configurable: true })
        }
        return result
      }
      default: throw new Error('Unknown archive value tag')
    }
  }
  const result = decode(encoded)
  if (JSON.stringify(serializeValue(result)) !== JSON.stringify(encoded)) throw new Error('Noncanonical or lossy archive encoding')
  return result
}

export const archiveCollections = ['transactions', 'categories', 'paymentAccounts', 'people'] as const
export type ArchiveCollection = typeof archiveCollections[number]
export interface SourceDocument { id: string; path: string; data: Record<string, unknown> }
export interface ArchivedDocument { id: string; path: string; data: ArchiveValue }
export interface ArchiveInput {
  uid: string
  transactions: SourceDocument[]
  categories: SourceDocument[]
  paymentAccounts: SourceDocument[]
  people: SourceDocument[]
  now?: Date
}
export interface FinancialExportDocument {
  format: 'spenza-financial-export'
  version: 2
  uid: string
  exportedAt: string
  disclaimer: string
  metadata: {
    counts: Record<ArchiveCollection, number>
    derived: {
      totalGrossPaise: number
      totalRecoverablePaise: number
      totalNetPaise: number
      totalRepaidPaise: number
      warnings: string[]
    }
  }
  data: Record<ArchiveCollection, ArchivedDocument[]>
}

function checkIdentity(record: SourceDocument | ArchivedDocument, uid: string, collection: ArchiveCollection) {
  if (!record.id || record.id.includes('/') || record.path !== `users/${uid}/${collection}/${record.id}`) {
    throw new Error(`Invalid document identity: ${record.path}`)
  }
}

export function buildFinancialExportDocument(input: ArchiveInput): FinancialExportDocument {
  if (!input.uid || input.uid.includes('/')) throw new Error('Invalid owner UID')
  const data = {} as FinancialExportDocument['data']
  const counts = {} as FinancialExportDocument['metadata']['counts']
  for (const collection of archiveCollections) {
    const paths = new Set<string>()
    data[collection] = input[collection].map(record => {
      checkIdentity(record, input.uid, collection)
      if (paths.has(record.path)) throw new Error(`Duplicate document: ${record.path}`)
      paths.add(record.path)
      const value = serializeValue(record.data)
      if (value.type !== 'map') throw new Error('Document data must be a map')
      return { id: record.id, path: record.path, data: value }
    })
    counts[collection] = data[collection].length
  }
  const derived = { totalGrossPaise: 0, totalRecoverablePaise: 0, totalNetPaise: 0, totalRepaidPaise: 0,
    warnings: ['Derived totals use normalized ledger calculations, not raw archival values. They do not verify source completeness.'] }
  for (const record of input.transactions) {
    const tx = record.data as unknown as Transaction
    try {
      const values = [toNonNegativeIntPaise(tx.amountPaise), getRecoverablePaise(tx), getNetSpendPaise(tx), getRepaidPaise(tx)]
      const keys = ['totalGrossPaise', 'totalRecoverablePaise', 'totalNetPaise', 'totalRepaidPaise'] as const
      if (!values.every((value, index) => Number.isSafeInteger(value) && Number.isSafeInteger(derived[keys[index]] + value))) {
        throw new Error('Unrepresentable normalized total')
      }
      keys.forEach((key, index) => { derived[key] += values[index] })
      if (tx.amountPaise !== values[0] || tx.recoverablePaise !== values[1] ||
        (tx.splits !== undefined && (!Array.isArray(tx.splits) || tx.splits.some(s => !s ||
          !Number.isSafeInteger(s.amountPaise) || s.amountPaise < 0 || !Number.isSafeInteger(s.repaidPaise) ||
          s.repaidPaise < 0 || s.repaidPaise > s.amountPaise)))) {
        derived.warnings.push(`${record.path}: derived values normalize or infer legacy/malformed financial fields; raw data is unchanged.`)
      }
    } catch {
      derived.warnings.push(`${record.path}: excluded from derived totals because its financial shape cannot be safely summarized; raw data is preserved.`)
    }
  }
  return { format: 'spenza-financial-export', version: 2, uid: input.uid,
    exportedAt: (input.now ?? new Date()).toISOString(),
    disclaimer: 'Reversible archive of the fetched documents in the four listed collections. Fidelity checks compare these reads only; they do not prove database completeness, a consistent snapshot, or successful file storage. Automated restore is not supported.',
    metadata: { counts, derived }, data }
}

/** Source-bound fidelity check, including the actual JSON parse/stringify boundary. */
export function validateExportIntegrity(archive: FinancialExportDocument, source: ArchiveInput): { valid: boolean; errors: string[] } {
  try {
    if (archive.format !== 'spenza-financial-export' || archive.version !== 2 || archive.uid !== source.uid) throw new Error('Invalid archive identity/version')
    const expected = buildFinancialExportDocument(source)
    if (JSON.stringify(archive.metadata) !== JSON.stringify(expected.metadata)) throw new Error('Metadata differs from fetched source')
    if (JSON.stringify(archive.data) !== JSON.stringify(expected.data)) throw new Error('Document identities, fields or values differ from fetched source')
    for (const collection of archiveCollections) {
      for (let index = 0; index < source[collection].length; index++) {
        const references = new Map<string, DocumentReference>()
        const original = serializeValue(source[collection][index].data, references)
        const record = archive.data[collection][index]
        checkIdentity(record, source.uid, collection)
        const roundTrip = deserializeValue(JSON.parse(JSON.stringify(record.data)), identity => {
          const ref = references.get(referenceKey(identity))
          if (!ref) throw new Error('Unknown document reference')
          return ref
        })
        if (JSON.stringify(serializeValue(roundTrip)) !== JSON.stringify(original)) throw new Error(`Round-trip mismatch: ${record.path}`)
      }
    }
    return { valid: true, errors: [] }
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : 'Invalid archive'] }
  }
}
