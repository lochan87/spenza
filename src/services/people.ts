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
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/firebase/config'
import { invalidateInsightsCache } from '@/services/insights'
import { PersonSchema } from '@/utils/schemas'
import {
  applyRepayment,
  applyFullSettlement,
  getRecoverablePaise,
  getNormalizedSplits,
  toNonNegativeIntPaise,
  UNASSIGNED_PERSON_ID,
} from '@/utils/splitMath'
import type { Person, Transaction } from '@/types'

const peopleColl = (uid: string) => collection(db, 'users', uid, 'people')
const personRef = (uid: string, id: string) => doc(db, 'users', uid, 'people', id)
const txRef = (uid: string, id: string) => doc(db, 'users', uid, 'transactions', id)

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
    // Also check transactions where splits might reference this person
    const allTxSnap = await getDocs(collection(db, 'users', cleanUid, 'transactions'))
    for (const d of allTxSnap.docs) {
      const data = d.data() as Transaction
      if (data.splits?.some(s => s.personId === cleanPersonId)) {
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
  return { deleted: true, archived: false }
}

// ─── Repayment Operations ─────────────────────────────────────────────────────

/**
 * Record a partial or full repayment of `repaymentPaise` (integer paise) from `personId`
 * against an existing transaction.
 *
 * Concurrency strategy:
 * - Uses atomic Firestore `runTransaction` to guarantee optimistic concurrency control (OCC).
 * - Reads latest transaction snapshot, validates repayment against current balance,
 *   updates splits and derived reimbursementStatus, and commits atomically.
 * - Does not use a blind read-modify-write setDoc fallback to prevent lost updates or
 *   silent erasure of concurrent repayments on multi-person splits.
 * - Automatically invalidates the insights cache on success.
 */
export async function recordSplitRepayment(
  uid: string,
  transactionId: string,
  personId: string,
  repaymentPaise: number
): Promise<{ tx: Transaction; appliedPaise: number }> {
  const cleanUid = validateUid(uid)
  const cleanTxId = validateTransactionId(transactionId)
  const cleanPersonId = validatePersonId(personId)
  const paise = toNonNegativeIntPaise(repaymentPaise)

  if (paise <= 0 || !Number.isInteger(repaymentPaise)) {
    throw new Error('Repayment amount must be a positive integer number of paise')
  }

  const targetDocRef = txRef(cleanUid, cleanTxId)

  const result = await runTransaction(db, async txn => {
    const snap = await txn.get(targetDocRef)
    if (!snap.exists()) {
      throw new Error(`Transaction "${cleanTxId}" not found`)
    }

    const currentTx = { id: snap.id, ...snap.data() } as Transaction
    const update = applyRepayment(currentTx, cleanPersonId, paise)
    const newRecoverable = getRecoverablePaise({ ...currentTx, splits: update.splits })

    txn.update(targetDocRef, {
      recoverablePaise: newRecoverable,
      splits: update.splits,
      reimbursementStatus: update.reimbursementStatus,
      updatedAt: serverTimestamp(),
    })

    return {
      tx: {
        ...currentTx,
        recoverablePaise: newRecoverable,
        splits: update.splits,
        reimbursementStatus: update.reimbursementStatus,
      },
      appliedPaise: update.appliedPaise,
    }
  })

  await invalidateInsightsCache(cleanUid)
  return result
}

/**
 * Settle the entire remaining balance for a specific person on a transaction.
 */
export async function settleSplitShare(
  uid: string,
  transactionId: string,
  personId: string
): Promise<{ tx: Transaction; settledPaise: number }> {
  const cleanUid = validateUid(uid)
  const cleanTxId = validateTransactionId(transactionId)
  const cleanPersonId = validatePersonId(personId)

  const targetDocRef = txRef(cleanUid, cleanTxId)

  const result = await runTransaction(db, async txn => {
    const snap = await txn.get(targetDocRef)
    if (!snap.exists()) {
      throw new Error(`Transaction "${cleanTxId}" not found`)
    }

    const currentTx = { id: snap.id, ...snap.data() } as Transaction
    const update = applyFullSettlement(currentTx, cleanPersonId)
    const newRecoverable = getRecoverablePaise({ ...currentTx, splits: update.splits })

    if (update.settledPaise > 0) {
      txn.update(targetDocRef, {
        recoverablePaise: newRecoverable,
        splits: update.splits,
        reimbursementStatus: update.reimbursementStatus,
        updatedAt: serverTimestamp(),
      })
    }

    return {
      tx: {
        ...currentTx,
        recoverablePaise: newRecoverable,
        splits: update.splits,
        reimbursementStatus: update.reimbursementStatus,
      },
      settledPaise: update.settledPaise,
    }
  })

  if (result.settledPaise > 0) {
    await invalidateInsightsCache(cleanUid)
  }
  return result
}

/**
 * Settle all participants on a transaction in one atomic operation.
 */
export async function settleAllTransactionSplits(
  uid: string,
  transactionId: string
): Promise<{ tx: Transaction; settledPaise: number }> {
  const cleanUid = validateUid(uid)
  const cleanTxId = validateTransactionId(transactionId)

  const targetDocRef = txRef(cleanUid, cleanTxId)

  const result = await runTransaction(db, async txn => {
    const snap = await txn.get(targetDocRef)
    if (!snap.exists()) {
      throw new Error(`Transaction "${cleanTxId}" not found`)
    }

    const currentTx = { id: snap.id, ...snap.data() } as Transaction
    const update = applyFullSettlement(currentTx)
    const newRecoverable = getRecoverablePaise({ ...currentTx, splits: update.splits })

    if (update.settledPaise > 0) {
      txn.update(targetDocRef, {
        recoverablePaise: newRecoverable,
        splits: update.splits,
        reimbursementStatus: update.reimbursementStatus,
        updatedAt: serverTimestamp(),
      })
    }

    return {
      tx: {
        ...currentTx,
        recoverablePaise: newRecoverable,
        splits: update.splits,
        reimbursementStatus: update.reimbursementStatus,
      },
      settledPaise: update.settledPaise,
    }
  })

  if (result.settledPaise > 0) {
    await invalidateInsightsCache(cleanUid)
  }
  return result
}

/**
 * Settle all outstanding dues for a specific person across all transactions.
 * Safely iterates through every transaction where `personId` has an unsettled split share
 * and settles it atomically using `settleSplitShare`.
 */
export async function settlePersonAllDues(
  uid: string,
  personId: string
): Promise<{ settledCount: number; totalSettledPaise: number; updatedTxns: Transaction[] }> {
  const cleanUid = validateUid(uid)
  const cleanPersonId = validatePersonId(personId)

  const txRefColl = collection(db, 'users', cleanUid, 'transactions')
  const snap = await getDocs(txRefColl)

  const matchingDocs = snap.docs.filter(d => {
    const data = d.data() as Transaction
    const splits = getNormalizedSplits(data)
    const share = splits.find(
      s =>
        s.personId === cleanPersonId ||
        (s.personId === UNASSIGNED_PERSON_ID &&
          s.personName.toLowerCase() === cleanPersonId.toLowerCase())
    )
    return share && share.amountPaise > share.repaidPaise
  })

  if (matchingDocs.length === 0) {
    return { settledCount: 0, totalSettledPaise: 0, updatedTxns: [] }
  }

  let totalSettled = 0
  const updatedTxns: Transaction[] = []

  for (const docSnap of matchingDocs) {
    const res = await settleSplitShare(cleanUid, docSnap.id, cleanPersonId)
    if (res.settledPaise > 0) {
      totalSettled += res.settledPaise
      updatedTxns.push(res.tx)
    }
  }

  return {
    settledCount: updatedTxns.length,
    totalSettledPaise: totalSettled,
    updatedTxns,
  }
}
