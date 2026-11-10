import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { app, db } from '@/firebase/config'
import { PersonSchema } from '@/utils/schemas'
import { toNonNegativeIntPaise, UNASSIGNED_PERSON_ID } from '@/utils/splitMath'
import type { Person, Transaction } from '@/types'

function notifyFinancialChange(type: string, uid: string, entityId?: string) {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent('spenza_financial_mutation', {
          detail: { type, uid, entityId, timestamp: Date.now() },
        })
      )
    } catch {
      // Ignore
    }
  }
}

function toClientTimestamp(ts: any): Timestamp | null | undefined {
  if (ts === null || ts === undefined) return ts
  if (typeof ts.toMillis === 'function') return ts
  if (typeof ts.seconds === 'number') return new Timestamp(ts.seconds, ts.nanoseconds ?? 0)
  if (typeof ts._seconds === 'number') return new Timestamp(ts._seconds, ts._nanoseconds ?? 0)
  if (typeof ts === 'string' || typeof ts === 'number') return Timestamp.fromDate(new Date(ts))
  return ts
}

function hydrateTransaction(rawTx: any): Transaction {
  return {
    ...rawTx,
    date: toClientTimestamp(rawTx.date)!,
    createdAt: toClientTimestamp(rawTx.createdAt) ?? undefined,
    updatedAt: toClientTimestamp(rawTx.updatedAt) ?? undefined,
    splits: Array.isArray(rawTx.splits)
      ? rawTx.splits.map((s: any) => ({
          ...s,
          settledAt: toClientTimestamp(s.settledAt),
        }))
      : rawTx.splits,
  }
}

// Durable pending idempotency key lifecycle for network retry safety
const pendingKeys = new Map<string, { key: string; timestamp: number }>()

export function getOrCreatePendingKey(operationType: string, id: string, extra = ''): string {
  const cacheKey = `spenza_pending_${operationType}_${id}_${extra}`
  const now = Date.now()
  const existingMem = pendingKeys.get(cacheKey)
  if (existingMem && now - existingMem.timestamp < 300_000) {
    return existingMem.key
  }
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      const stored = window.sessionStorage.getItem(cacheKey)
      if (stored) {
        const parsed = JSON.parse(stored)
        if (now - parsed.timestamp < 300_000) {
          pendingKeys.set(cacheKey, parsed)
          return parsed.key
        }
      }
    } catch {
      // Storage unavailable or disabled
    }
  }

  const newKey = crypto.randomUUID()
  const entry = { key: newKey, timestamp: now }
  pendingKeys.set(cacheKey, entry)
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      window.sessionStorage.setItem(cacheKey, JSON.stringify(entry))
    } catch {
      // Storage unavailable or disabled
    }
  }
  return newKey
}

export function clearPendingKey(operationType: string, id: string, extra = '') {
  const cacheKey = `spenza_pending_${operationType}_${id}_${extra}`
  pendingKeys.delete(cacheKey)
  if (typeof window !== 'undefined' && window.sessionStorage) {
    try {
      window.sessionStorage.removeItem(cacheKey)
    } catch {
      // Storage unavailable or disabled
    }
  }
}

const peopleColl = (uid: string) => collection(db, 'users', uid, 'people')
const personRef = (uid: string, id: string) => doc(db, 'users', uid, 'people', id)

function validateUid(uid: string): string {
  if (!uid || typeof uid !== 'string' || !uid.trim()) {
    throw new Error('User ID is required')
  }
  return uid.trim()
}

function validatePersonId(personId: string): string {
  if (!personId || typeof personId !== 'string' || !personId.trim()) {
    throw new Error('Person ID is required')
  }
  return personId.trim()
}

function validateTransactionId(transactionId: string): string {
  if (!transactionId || typeof transactionId !== 'string' || !transactionId.trim()) {
    throw new Error('Transaction ID is required')
  }
  return transactionId.trim()
}

// ─── Person CRUD ──────────────────────────────────────────────────────────────

/**
 * Fetch all people for the user, ordered by name ascending.
 * By default filters out archived people.
 */
export async function getPeople(uid: string, includeArchived = false): Promise<Person[]> {
  const cleanUid = validateUid(uid)
  const snap = await getDocs(query(peopleColl(cleanUid), orderBy('name', 'asc')))
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }) as Person)
  return includeArchived ? all : all.filter(p => !p.isArchived)
}

/**
 * Retrieve a single Person by ID.
 */
export async function getPerson(uid: string, personId: string): Promise<Person | null> {
  const cleanUid = validateUid(uid)
  const cleanPersonId = validatePersonId(personId)
  const snap = await getDoc(personRef(cleanUid, cleanPersonId))
  if (!snap.exists()) return null
  return { id: snap.id, ...snap.data() } as Person
}

/**
 * Add a new person. Input is validated using PersonSchema.
 */
export async function addPerson(
  uid: string,
  data: { name: string; isArchived?: boolean } | string
): Promise<Person> {
  const cleanUid = validateUid(uid)
  const raw = typeof data === 'string' ? { name: data } : data
  const validated = PersonSchema.parse(raw)

  const ref = doc(peopleColl(cleanUid))
  const newPerson: Omit<Person, 'createdAt'> & { createdAt: any } = {
    id: ref.id,
    name: validated.name,
    isArchived: validated.isArchived ?? false,
    createdAt: serverTimestamp(),
  }

  await setDoc(ref, newPerson)
  notifyFinancialChange('person_changed', cleanUid, ref.id)
  return newPerson as Person
}

/**
 * Find an active person by name (case-insensitive) or create a new one.
 */
export async function getOrCreatePerson(uid: string, name: string): Promise<Person> {
  const cleanUid = validateUid(uid)
  const cleanName = name?.trim()
  if (!cleanName) {
    throw new Error('Person name is required')
  }

  // Check active (non-archived) people first to prevent accidental duplicate entries
  const activePeople = await getPeople(cleanUid, false)
  const matched = activePeople.find(p => p.name.trim().toLowerCase() === cleanName.toLowerCase())
  if (matched) {
    return matched
  }

  // Create as new active person (archived records are preserved as historical references)
  return addPerson(cleanUid, { name: cleanName, isArchived: false })
}

/**
 * Update editable details for a person.
 */
export async function updatePerson(
  uid: string,
  personId: string,
  data: Partial<Omit<Person, 'id' | 'createdAt'>>
): Promise<void> {
  const cleanUid = validateUid(uid)
  const cleanPersonId = validatePersonId(personId)

  if (data.name !== undefined) {
    data.name = data.name.trim()
    if (!data.name) {
      throw new Error('Person name cannot be empty')
    }
  }

  await setDoc(personRef(cleanUid, cleanPersonId), data, { merge: true })
  notifyFinancialChange('person_changed', cleanUid, cleanPersonId)
}

/**
 * Soft-delete or restore a person via isArchived flag.
 */
export async function archivePerson(
  uid: string,
  personId: string,
  isArchived = true
): Promise<void> {
  return updatePerson(uid, personId, { isArchived })
}

/**
 * Delete a person if they have no historical transactions; archive them instead if referenced.
 */
export async function deletePerson(
  uid: string,
  personId: string
): Promise<{ deleted: boolean; archived: boolean }> {
  const cleanUid = validateUid(uid)
  const cleanPersonId = validatePersonId(personId)

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('Cannot delete person while offline')
  }

  const existing = await getPerson(cleanUid, cleanPersonId)
  if (!existing) {
    throw new Error(`Person "${cleanPersonId}" not found`)
  }

  // Check if referenced in transactions
  const txQuery = query(
    collection(db, 'users', cleanUid, 'transactions'),
    where('personId', '==', cleanPersonId)
  )
  const snap = await getDocs(txQuery)

  let isReferenced = !snap.empty
  if (!isReferenced) {
    // Also check transactions where splits or legacy names reference this person
    const allTxSnap = await getDocs(collection(db, 'users', cleanUid, 'transactions'))
    const cleanName = existing.name.trim().toLowerCase()
    for (const d of allTxSnap.docs) {
      const data = d.data() as Transaction
      // Direct split match by personId
      if (data.splits?.some(s => s.personId === cleanPersonId)) {
        isReferenced = true
        break
      }
      // Legacy split match: unassigned or missing personId with matching name
      if (
        data.splits?.some(
          s =>
            (!s.personId || s.personId === UNASSIGNED_PERSON_ID) &&
            s.personName &&
            s.personName.trim().toLowerCase() === cleanName
        )
      ) {
        isReferenced = true
        break
      }
      // Legacy top-level personName match
      const legacyPersonName = (data as any).personName
      if (
        (!data.personId || data.personId === UNASSIGNED_PERSON_ID) &&
        typeof legacyPersonName === 'string' &&
        legacyPersonName.trim().toLowerCase() === cleanName
      ) {
        isReferenced = true
        break
      }
    }
  }

  if (isReferenced) {
    await archivePerson(cleanUid, cleanPersonId, true)
    return { deleted: false, archived: true }
  }

  await deleteDoc(personRef(cleanUid, cleanPersonId))
  notifyFinancialChange('person_changed', cleanUid, cleanPersonId)
  return { deleted: true, archived: false }
}

// ─── Repayment Operations ─────────────────────────────────────────────────────

/**
 * Record a partial (or full) repayment against a person's split on an expense.
 *
 * Architecture & Concurrency:
 * - Migrated in Phase 7.2A to trusted Cloud Function execution (`executeRepaymentV1`).
 * - Client performs fast offline validation, input sanitization and generates a UUID idempotency key.
 * - Cloud Function executes in an Admin SDK transaction to verify participants, enforce
 *   integer-paise balances, preserve repayment history, record a trusted idempotency receipt,
 *   and atomically invalidate the insights cache.
 * - Caller interface and return types are strictly preserved.
 */
export async function recordSplitRepayment(
  uid: string,
  transactionId: string,
  personId: string,
  repaymentPaise: number,
  customIdempotencyKey?: string
): Promise<{ tx: Transaction; appliedPaise: number }> {
  const cleanUid = validateUid(uid)
  const cleanTxId = validateTransactionId(transactionId)
  const cleanPersonId = validatePersonId(personId)
  const paise = toNonNegativeIntPaise(repaymentPaise)

  if (paise <= 0 || !Number.isInteger(repaymentPaise)) {
    throw new Error('Repayment amount must be a positive integer number of paise')
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('You are offline. Recording a repayment requires an internet connection.')
  }

  const opKey = `${cleanTxId}_${cleanPersonId}`
  const idempotencyKey =
    customIdempotencyKey || getOrCreatePendingKey('repay', opKey, String(paise))

  const functions = getFunctions(app, 'us-central1')
  const executeRepayment = httpsCallable<
    { transactionId: string; personId: string; repaymentPaise: number; idempotencyKey: string },
    { tx: any; appliedPaise: number; replayed?: boolean }
  >(functions, 'executeRepaymentV1')

  try {
    const res = await executeRepayment({
      transactionId: cleanTxId,
      personId: cleanPersonId,
      repaymentPaise: paise,
      idempotencyKey,
    })

    clearPendingKey('repay', opKey, String(paise))
    notifyFinancialChange('repayment_recorded', cleanUid, cleanTxId)

    return {
      tx: hydrateTransaction(res.data.tx),
      appliedPaise: res.data.appliedPaise,
    }
  } catch (err) {
    throw err
  }
}

/**
 * Settle the entire remaining balance for a specific person on a transaction.
 *
 * Migrated in Phase 7.2B to trusted Cloud Function execution (`executeSettlementV1`).
 */
export async function settleSplitShare(
  uid: string,
  transactionId: string,
  personId: string,
  customIdempotencyKey?: string
): Promise<{ tx: Transaction; settledPaise: number }> {
  const cleanUid = validateUid(uid)
  const cleanTxId = validateTransactionId(transactionId)
  const cleanPersonId = validatePersonId(personId)

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('You are offline. Settling dues requires an internet connection.')
  }

  const opKey = `${cleanTxId}_${cleanPersonId}`
  const idempotencyKey =
    customIdempotencyKey || getOrCreatePendingKey('settleSplit', opKey)

  const functions = getFunctions(app, 'us-central1')
  const executeSettlement = httpsCallable<
    { mode: 'splitShare'; transactionId: string; personId: string; idempotencyKey: string },
    { tx: any; settledPaise: number; replayed?: boolean }
  >(functions, 'executeSettlementV1')

  try {
    const res = await executeSettlement({
      mode: 'splitShare',
      transactionId: cleanTxId,
      personId: cleanPersonId,
      idempotencyKey,
    })

    clearPendingKey('settleSplit', opKey)
    notifyFinancialChange('settlement_completed', cleanUid, cleanTxId)

    return {
      tx: hydrateTransaction(res.data.tx),
      settledPaise: res.data.settledPaise,
    }
  } catch (err) {
    throw err
  }
}

/**
 * Settle all participants on a transaction in one atomic operation.
 *
 * Migrated in Phase 7.2B to trusted Cloud Function execution (`executeSettlementV1`).
 */
export async function settleAllTransactionSplits(
  uid: string,
  transactionId: string,
  customIdempotencyKey?: string
): Promise<{ tx: Transaction; settledPaise: number }> {
  const cleanUid = validateUid(uid)
  const cleanTxId = validateTransactionId(transactionId)

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('You are offline. Settling dues requires an internet connection.')
  }

  const opKey = cleanTxId
  const idempotencyKey =
    customIdempotencyKey || getOrCreatePendingKey('settleTx', opKey)

  const functions = getFunctions(app, 'us-central1')
  const executeSettlement = httpsCallable<
    { mode: 'transactionSplits'; transactionId: string; idempotencyKey: string },
    { tx: any; settledPaise: number; replayed?: boolean }
  >(functions, 'executeSettlementV1')

  try {
    const res = await executeSettlement({
      mode: 'transactionSplits',
      transactionId: cleanTxId,
      idempotencyKey,
    })

    clearPendingKey('settleTx', opKey)
    notifyFinancialChange('settlement_completed', cleanUid, cleanTxId)

    return {
      tx: hydrateTransaction(res.data.tx),
      settledPaise: res.data.settledPaise,
    }
  } catch (err) {
    throw err
  }
}

export class MultiSettlementPartialError extends Error {
  readonly settledCount: number
  readonly totalSettledPaise: number
  readonly updatedTxns: Transaction[]
  readonly failedTransactionId: string | null

  constructor(
    message: string,
    details: {
      settledCount: number
      totalSettledPaise: number
      updatedTxns: any[]
      failedTransactionId?: string | null
    }
  ) {
    super(message)
    this.name = 'MultiSettlementPartialError'
    this.settledCount = details.settledCount
    this.totalSettledPaise = details.totalSettledPaise
    this.updatedTxns = (details.updatedTxns || []).map(hydrateTransaction)
    this.failedTransactionId = details.failedTransactionId ?? null
  }
}

/**
 * Settle all outstanding dues for a specific person across all transactions.
 *
 * Migrated in Phase 7.2B to trusted Cloud Function execution (`executeSettlementV1`).
 * Handles bounded batching and partial progress reporting.
 */
export async function settlePersonAllDues(
  uid: string,
  personId: string,
  customIdempotencyKey?: string
): Promise<{ settledCount: number; totalSettledPaise: number; updatedTxns: Transaction[]; complete?: boolean }> {
  const cleanUid = validateUid(uid)
  const cleanPersonId = validatePersonId(personId)

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('You are offline. Settling dues requires an internet connection.')
  }

  const opKey = cleanPersonId
  const idempotencyKey =
    customIdempotencyKey || getOrCreatePendingKey('settlePerson', opKey)

  const functions = getFunctions(app, 'us-central1')
  const executeSettlement = httpsCallable<
    { mode: 'personAllDues'; personId: string; idempotencyKey: string; maxTransactions?: number },
    {
      settledCount: number
      totalSettledPaise: number
      updatedTxns: any[]
      complete: boolean
      replayed?: boolean
      failedTransactionId?: string | null
      error?: string | null
    }
  >(functions, 'executeSettlementV1')

  try {
    const res = await executeSettlement({
      mode: 'personAllDues',
      personId: cleanPersonId,
      idempotencyKey,
    })

    const data = res.data
    const hydratedTxns = (data.updatedTxns || []).map(hydrateTransaction)

    if (data.error && data.failedTransactionId) {
      clearPendingKey('settlePerson', opKey)
      throw new MultiSettlementPartialError(data.error, {
        settledCount: data.settledCount,
        totalSettledPaise: data.totalSettledPaise,
        updatedTxns: hydratedTxns,
        failedTransactionId: data.failedTransactionId,
      })
    }

    clearPendingKey('settlePerson', opKey)
    if (data.settledCount > 0) {
      notifyFinancialChange('settlement_completed', cleanUid, cleanPersonId)
    }

    return {
      settledCount: data.settledCount,
      totalSettledPaise: data.totalSettledPaise,
      updatedTxns: hydratedTxns,
      complete: data.complete,
    }
  } catch (err: any) {
    if (err?.details && typeof err.details.settledCount === 'number') {
      clearPendingKey('settlePerson', opKey)
      throw new MultiSettlementPartialError(err.message || 'Settlement partially failed', err.details)
    }
    throw err
  }
}
