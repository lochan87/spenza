import { getDocs, collection, query, orderBy } from 'firebase/firestore'
import { format } from 'date-fns'
import type { Transaction, Category, PaymentAccount, Person } from '../types/index.ts'
import {
  buildFinancialExportDocument,
  validateExportIntegrity,
  type FinancialExportDocument,
} from '../utils/financialExport.ts'

export interface FinancialExportResult {
  success: true
  filename: string
  transactionCount: number
  totalGrossPaise: number
  totalRecoverablePaise: number
}

/** Trigger a browser file download of the given text content */
function downloadBlob(content: string, filename: string, mimeType: string) {
  if (typeof document === 'undefined') return
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Perform a complete, lossless export of user financial records in raw integer paise.
 * Fetches transactions, categories, payment accounts, and people.
 * Fails closed if any fetch error occurs, never creating partial exports.
 */
export async function exportCompleteFinancialData(uid: string, customDb?: any): Promise<FinancialExportResult> {
  if (!uid || typeof uid !== 'string' || uid.trim() === '') {
    throw new Error('User UID is required to export financial data.')
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('You are offline. Exporting a complete backup requires an active internet connection.')
  }

  const firestore = customDb || (await import('../firebase/config.ts')).db

  // Fetch all collections in parallel; any single collection failure aborts the entire export.
  const [txSnap, catSnap, accSnap, peopleSnap] = await Promise.all([
    getDocs(query(collection(firestore, 'users', uid, 'transactions'), orderBy('date', 'desc'))),
    getDocs(collection(firestore, 'users', uid, 'categories')),
    getDocs(collection(firestore, 'users', uid, 'paymentAccounts')),
    getDocs(collection(firestore, 'users', uid, 'people')),
  ])

  const transactions = txSnap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction)
  const categories = catSnap.docs.map(d => ({ id: d.id, ...d.data() }) as Category)
  const paymentAccounts = accSnap.docs.map(d => ({ id: d.id, ...d.data() }) as PaymentAccount)
  const people = peopleSnap.docs.map(d => ({ id: d.id, ...d.data() }) as Person)

  const doc: FinancialExportDocument = buildFinancialExportDocument({
    uid,
    transactions,
    categories,
    paymentAccounts,
    people,
  })

  const integrity = validateExportIntegrity(doc)
  if (!integrity.valid) {
    throw new Error(`Export integrity verification failed: ${integrity.errors.join('; ')}`)
  }

  const dateStr = format(new Date(), 'yyyy-MM-dd')
  const filename = `spenza-financial-archive-${dateStr}.json`
  const jsonContent = JSON.stringify(doc, null, 2)

  downloadBlob(jsonContent, filename, 'application/json;charset=utf-8;')

  return {
    success: true,
    filename,
    transactionCount: doc.metadata.transactionCount,
    totalGrossPaise: doc.metadata.totalGrossPaise,
    totalRecoverablePaise: doc.metadata.totalRecoverablePaise,
  }
}
