import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  query,
  orderBy,
  limit,
  startAfter,
  serverTimestamp,
  runTransaction,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'
import { db } from '@/firebase/config'
import { invalidateInsightsCache } from '@/services/insights'
import type { Transaction, PaymentAccount, Category } from '@/types'
import { prepareExpenseEdit, ExpenseEditError, type ExpenseEdit } from '@/utils/expenseEdit'

const PAGE_SIZE = 30

// ─── Transactions ─────────────────────────────────────────────────────────────

export async function addTransaction(
  uid: string,
  data: Omit<Transaction, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const ref = doc(collection(db, 'users', uid, 'transactions'))
  await setDoc(ref, {
    ...data,
    id: ref.id,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  const cacheOk = await invalidateInsightsCache(uid)
  if (!cacheOk) {
    console.warn('[Spenza Transactions] Added transaction, but failed to invalidate insights cache.')
  }
  return ref.id
}

export async function updateTransaction(
  uid: string,
  id: string,
  data: ExpenseEdit,
  original: Transaction
): Promise<void> {
  if (original.id !== id) throw new ExpenseEditError('Please reopen this expense before editing it.')
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new ExpenseEditError('You are offline. Expense edits require a connection to protect repayments. Reconnect and try again.')
  }
  const ref = doc(db, 'users', uid, 'transactions', id)
  await runTransaction(db, async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists()) throw new ExpenseEditError('This expense no longer exists. Close the form and refresh your transactions.')
    const latest = { ...snap.data(), id: snap.id } as Transaction
    const patch = prepareExpenseEdit(latest, original, data)
    if (Object.keys(patch).length > 0) {
      txn.update(ref, { ...patch, updatedAt: serverTimestamp() })
    }
  })
  const cacheOk = await invalidateInsightsCache(uid)
  if (!cacheOk) {
    console.warn('[Spenza Transactions] Updated transaction, but failed to invalidate insights cache.')
  }
}

export async function deleteTransaction(uid: string, id: string): Promise<void> {
  await deleteDoc(doc(db, 'users', uid, 'transactions', id))
  const cacheOk = await invalidateInsightsCache(uid)
  if (!cacheOk) {
    console.warn('[Spenza Transactions] Deleted transaction, but failed to invalidate insights cache.')
  }
}

export async function getTransaction(uid: string, id: string): Promise<Transaction | null> {
  const snap = await getDoc(doc(db, 'users', uid, 'transactions', id))
  if (!snap.exists()) return null
  return { id: snap.id, ...snap.data() } as Transaction
}

/** Paginated transaction fetch, newest first */
export async function getTransactions(
  uid: string,
  pageSize = PAGE_SIZE,
  after?: QueryDocumentSnapshot | DocumentSnapshot
): Promise<{ transactions: Transaction[]; lastDoc: QueryDocumentSnapshot | null }> {
  const ref = collection(db, 'users', uid, 'transactions')
  let q = query(ref, orderBy('date', 'desc'), limit(pageSize))
  if (after) q = query(ref, orderBy('date', 'desc'), startAfter(after), limit(pageSize))
  const snap = await getDocs(q)
  const transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction)
  return {
    transactions,
    lastDoc: snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null,
  }
}

/**
 * Fetch all transactions for a user ordered newest-first with a deterministic tie-breaker
 * (createdAt desc, then id) so same-day transactions maintain a stable order across edits
 * and daily subtotals / filtered totals are never split across arbitrary page boundaries.
 */
export async function getAllTransactions(uid: string): Promise<Transaction[]> {
  const ref = collection(db, 'users', uid, 'transactions')
  const snap = await getDocs(query(ref, orderBy('date', 'desc')))
  const list = snap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction)
  return list.sort((a, b) => {
    const dDiff = (b.date?.seconds ?? 0) - (a.date?.seconds ?? 0)
    if (dDiff !== 0) return dDiff
    const cDiff = (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0)
    if (cDiff !== 0) return cDiff
    return a.id.localeCompare(b.id)
  })
}

/** Get past descriptions for autocomplete (limited to recent 100) */
export async function getPastDescriptions(uid: string): Promise<string[]> {
  const ref = collection(db, 'users', uid, 'transactions')
  const snap = await getDocs(query(ref, orderBy('date', 'desc'), limit(100)))
  const seen = new Set<string>()
  return snap.docs
    .map(d => d.data().description as string)
    .filter(d => d && seen.size < 50 && !seen.has(d) && (seen.add(d), true))
}

/** Get most-used transactions for Quick Add (top 4 by frequency) */
export async function getFrequentTransactions(uid: string): Promise<Transaction[]> {
  const ref = collection(db, 'users', uid, 'transactions')
  const snap = await getDocs(query(ref, orderBy('date', 'desc'), limit(200)))
  const freq = new Map<string, { tx: Transaction; count: number }>()
  for (const d of snap.docs) {
    const tx = { id: d.id, ...d.data() } as Transaction
    const key = `${tx.description}::${tx.amountPaise}::${tx.categoryId}`
    const existing = freq.get(key)
    if (existing) {
      existing.count++
    } else {
      freq.set(key, { tx, count: 1 })
    }
  }
  return [...freq.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .map(e => e.tx)
}

// ─── Payment Accounts ─────────────────────────────────────────────────────────

export async function getPaymentAccounts(uid: string): Promise<PaymentAccount[]> {
  const snap = await getDocs(
    query(collection(db, 'users', uid, 'paymentAccounts'), orderBy('isDefault', 'desc'))
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as PaymentAccount)
}

export async function addPaymentAccount(
  uid: string,
  data: Omit<PaymentAccount, 'id' | 'createdAt'>
): Promise<string> {
  const ref = doc(collection(db, 'users', uid, 'paymentAccounts'))
  await setDoc(ref, { ...data, id: ref.id, createdAt: serverTimestamp() })
  return ref.id
}

export async function updatePaymentAccount(
  uid: string,
  id: string,
  data: Partial<PaymentAccount>
): Promise<void> {
  await setDoc(doc(db, 'users', uid, 'paymentAccounts', id), data, { merge: true })
}

// ─── Categories ───────────────────────────────────────────────────────────────

export async function getCategories(uid: string): Promise<Category[]> {
  const snap = await getDocs(collection(db, 'users', uid, 'categories'))
  return snap.docs.map(d => ({ id: d.id, ...d.data() }) as Category)
}

export async function addCategory(
  uid: string,
  data: Omit<Category, 'id'>
): Promise<string> {
  const ref = doc(collection(db, 'users', uid, 'categories'))
  await setDoc(ref, { ...data, id: ref.id })
  return ref.id
}

export async function updateCategory(
  uid: string,
  id: string,
  data: Partial<Category>
): Promise<void> {
  await setDoc(doc(db, 'users', uid, 'categories', id), data, { merge: true })
}
