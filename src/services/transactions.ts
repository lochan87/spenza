import {
  collection,
  doc,
  setDoc,
  getDoc,
  getDocs,
  getDocsFromServer,
  deleteDoc,
  query,
  where,
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
import { assertExpenseCanBeDeleted, ExpenseDeletionError } from '@/utils/expenseDeletion'

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
  notifyFinancialChange('transaction_created', uid, ref.id)
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
  notifyFinancialChange('transaction_updated', uid, id)
}

export async function deleteTransaction(uid: string, id: string): Promise<void> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new ExpenseDeletionError('You are offline. Deleting an expense requires a connection to verify repayment history. Reconnect and try again.')
  }
  const ref = doc(db, 'users', uid, 'transactions', id)
  try {
    await runTransaction(db, async txn => {
      const snap = await txn.get(ref)
      if (!snap.exists()) return
      assertExpenseCanBeDeleted(snap.data() as Transaction)
      txn.delete(ref)
    })
  } catch (error) {
    if (error instanceof ExpenseDeletionError) throw error
    throw new ExpenseDeletionError('Could not verify repayment history or confirm deletion. Check your connection and refresh before trying again.')
  }
  const cacheOk = await invalidateInsightsCache(uid)
  if (!cacheOk) {
    console.warn('[Spenza Transactions] Deleted transaction, but failed to invalidate insights cache.')
  }
  notifyFinancialChange('transaction_deleted', uid, id)
}

/** Settings maintenance: each chunk is atomic; earlier chunks can already have committed. */
export async function deleteTransactionsSafely(
  uid: string,
  ids: string[],
  importedOnly = false
): Promise<{ deleted: number; cacheInvalidated: boolean }> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new ExpenseDeletionError('You are offline. Reconnect before clearing transactions so repayment history can be verified.')
  }
  let deleted = 0
  const uniqueIds = [...new Set(ids)]
  try {
    for (let offset = 0; offset < uniqueIds.length; offset += 400) {
      const refs = uniqueIds.slice(offset, offset + 400).map(id => doc(db, 'users', uid, 'transactions', id))
      deleted += await runTransaction(db, async txn => {
        const snapshots = await Promise.all(refs.map(ref => txn.get(ref)))
        const eligible = snapshots.filter(snap => snap.exists() && (!importedOnly || snap.data().isImported === true))
        // Check every document before staging any deletes; repeat on every retry.
        for (const snap of eligible) assertExpenseCanBeDeleted(snap.data() as Transaction)
        for (const snap of eligible) txn.delete(snap.ref)
        if (eligible.length > 0) txn.delete(doc(db, 'users', uid, 'insights', 'summary'))
        return eligible.length
      })
    }
  } catch (error) {
    const reason = error instanceof ExpenseDeletionError ? error.message : 'Deletion could not be verified. Check your connection.'
    throw new ExpenseDeletionError(`Clear stopped. Confirmed deletions: ${deleted}. ${reason} Refresh to review remaining transactions.`)
  }
  if (deleted > 0) {
    notifyFinancialChange('bulk_cleared', uid)
  }
  // Cache invalidation commits with each successful chunk, including on partial completion.
  return { deleted, cacheInvalidated: true }
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

export interface AllTransactionsResult {
  transactions: Transaction[]
  fromCache: boolean
}

export async function getAllTransactionsWithMeta(uid: string): Promise<AllTransactionsResult> {
  const ref = collection(db, 'users', uid, 'transactions')
  const snap = await getDocs(query(ref, orderBy('date', 'desc')))
  const list = snap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction)
  const sorted = list.sort((a, b) => {
    const dDiff = (b.date?.seconds ?? 0) - (a.date?.seconds ?? 0)
    if (dDiff !== 0) return dDiff
    const cDiff = (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0)
    if (cDiff !== 0) return cDiff
    return a.id.localeCompare(b.id)
  })
  const fromCache = snap.metadata ? Boolean(snap.metadata.fromCache) : false
  return { transactions: sorted, fromCache }
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
  const sorted = list.sort((a, b) => {
    const dDiff = (b.date?.seconds ?? 0) - (a.date?.seconds ?? 0)
    if (dDiff !== 0) return dDiff
    const cDiff = (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0)
    if (cDiff !== 0) return cDiff
    return a.id.localeCompare(b.id)
  })
  if (snap.metadata?.fromCache) {
    (sorted as any).fromCache = true
  }
  return sorted
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
  notifyFinancialChange('account_changed', uid, ref.id)
  return ref.id
}

export async function updatePaymentAccount(
  uid: string,
  id: string,
  data: Partial<PaymentAccount>
): Promise<void> {
  await setDoc(doc(db, 'users', uid, 'paymentAccounts', id), data, { merge: true })
  notifyFinancialChange('account_changed', uid, id)
}

export async function archivePaymentAccount(
  uid: string,
  id: string,
  isArchived = true
): Promise<void> {
  const cleanUid = uid.trim()
  const cleanId = id.trim()
  const patch: Partial<PaymentAccount> = { isArchived }
  if (isArchived) {
    patch.isDefault = false
  }
  await updatePaymentAccount(cleanUid, cleanId, patch)
}

/**
 * Delete a payment account if no transactions or recurring items reference it.
 * Reference check queries authoritative server data to prevent deleting accounts with un-synced transactions.
 * If references exist, safely archive the account instead to protect financial integrity.
 *
 * Concurrency note:
 * Client-side reference checks are not atomic with deleteDoc; a concurrent transaction creation
 * after getDocsFromServer could produce a dangling reference. Where absolute safety against races
 * is required, records are preserved via archivePaymentAccount rather than hard deletion.
 */
export async function deletePaymentAccount(
  uid: string,
  id: string
): Promise<{ deleted: boolean; archived: boolean }> {
  const cleanUid = uid.trim()
  const cleanId = id.trim()

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('Cannot delete payment account while offline')
  }

  // Check transactions referencing this payment account using authoritative server data
  const txSnap = await getDocsFromServer(
    query(
      collection(db, 'users', cleanUid, 'transactions'),
      where('paymentAccountId', '==', cleanId)
    )
  )

  let isReferenced = !txSnap.empty
  if (!isReferenced) {
    // Check recurring items referencing this payment account on server
    const recSnap = await getDocsFromServer(
      query(
        collection(db, 'users', cleanUid, 'recurring'),
        where('paymentAccountId', '==', cleanId)
      )
    )
    isReferenced = !recSnap.empty
  }

  if (isReferenced) {
    await archivePaymentAccount(cleanUid, cleanId, true)
    return { deleted: false, archived: true }
  }

  await deleteDoc(doc(db, 'users', cleanUid, 'paymentAccounts', cleanId))
  notifyFinancialChange('account_changed', cleanUid, cleanId)
  return { deleted: true, archived: false }
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
  notifyFinancialChange('category_changed', uid, ref.id)
  return ref.id
}

export async function updateCategory(
  uid: string,
  id: string,
  data: Partial<Category>
): Promise<void> {
  await setDoc(doc(db, 'users', uid, 'categories', id), data, { merge: true })
  notifyFinancialChange('category_changed', uid, id)
}

export async function archiveCategory(
  uid: string,
  id: string,
  isArchived = true
): Promise<void> {
  const cleanUid = uid.trim()
  const cleanId = id.trim()
  await updateCategory(cleanUid, cleanId, { isArchived })
}

/**
 * Delete a category if no transactions, recurring items, or budgets reference it.
 * Reference check queries authoritative server data to prevent deleting categories with un-synced transactions.
 * If references exist, safely archive the category instead to protect financial integrity.
 *
 * Concurrency note:
 * Client-side reference checks are not atomic with deleteDoc; a concurrent transaction creation
 * after getDocsFromServer could produce a dangling reference. Where absolute safety against races
 * is required, records are preserved via archiveCategory rather than hard deletion.
 */
export async function deleteCategory(
  uid: string,
  id: string
): Promise<{ deleted: boolean; archived: boolean }> {
  const cleanUid = uid.trim()
  const cleanId = id.trim()

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('Cannot delete category while offline')
  }

  // Check transactions referencing this category using authoritative server data
  const txSnap = await getDocsFromServer(
    query(
      collection(db, 'users', cleanUid, 'transactions'),
      where('categoryId', '==', cleanId)
    )
  )

  let isReferenced = !txSnap.empty
  if (!isReferenced) {
    // Check recurring items referencing this category on server
    const recSnap = await getDocsFromServer(
      query(
        collection(db, 'users', cleanUid, 'recurring'),
        where('categoryId', '==', cleanId)
      )
    )
    isReferenced = !recSnap.empty
  }

  if (!isReferenced) {
    // Check monthly budgets referencing this category on server
    const budgetSnap = await getDocsFromServer(collection(db, 'users', cleanUid, 'budgets'))
    for (const bDoc of budgetSnap.docs) {
      const bData = bDoc.data()
      if (bData?.categoryBudgets && Object.prototype.hasOwnProperty.call(bData.categoryBudgets, cleanId)) {
        isReferenced = true
        break
      }
    }
  }

  if (isReferenced) {
    await archiveCategory(cleanUid, cleanId, true)
    return { deleted: false, archived: true }
  }

  await deleteDoc(doc(db, 'users', cleanUid, 'categories', cleanId))
  notifyFinancialChange('category_changed', cleanUid, cleanId)
  return { deleted: true, archived: false }
}
