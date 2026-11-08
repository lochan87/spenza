import { getDocs, collection, type QuerySnapshot, type Firestore } from 'firebase/firestore'
import { format } from 'date-fns'
import {
  buildFinancialExportDocument,
  validateExportIntegrity,
  type FinancialExportDocument,
  type SourceDocument,
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
 * Archive the fetched transactions, categories, payment accounts and people.
 * Value fidelity is verified against these reads, not database snapshot completeness.
 */
export async function exportCompleteFinancialData(uid: string, customDb?: Firestore): Promise<FinancialExportResult> {
  if (!uid || typeof uid !== 'string' || uid.trim() === '') {
    throw new Error('User UID is required to export financial data.')
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('You are offline. Exporting a complete backup requires an active internet connection.')
  }

  const firestore = customDb || (await import('../firebase/config.ts')).db

  // Fetch all collections in parallel; any single collection failure aborts the entire export.
  const [txSnap, catSnap, accSnap, peopleSnap] = await Promise.all([
    getDocs(collection(firestore, 'users', uid, 'transactions')),
    getDocs(collection(firestore, 'users', uid, 'categories')),
    getDocs(collection(firestore, 'users', uid, 'paymentAccounts')),
    getDocs(collection(firestore, 'users', uid, 'people')),
  ])

  const records = (snap: QuerySnapshot): SourceDocument[] => snap.docs.map(d => ({ id: d.id, path: d.ref.path, data: d.data() }))
  const source = {
    uid,
    transactions: records(txSnap),
    categories: records(catSnap),
    paymentAccounts: records(accSnap),
    people: records(peopleSnap),
  }
  const doc: FinancialExportDocument = buildFinancialExportDocument(source)
  const jsonContent = JSON.stringify(doc, null, 2)

  const integrity = validateExportIntegrity(JSON.parse(jsonContent), source)
  if (!integrity.valid) {
    throw new Error(`Export integrity verification failed: ${integrity.errors.join('; ')}`)
  }

  const dateStr = format(new Date(), 'yyyy-MM-dd')
  const filename = `spenza-financial-archive-${dateStr}.json`

  downloadBlob(jsonContent, filename, 'application/json;charset=utf-8;')

  return {
    success: true,
    filename,
    transactionCount: doc.metadata.counts.transactions,
    totalGrossPaise: doc.metadata.derived.totalGrossPaise,
    totalRecoverablePaise: doc.metadata.derived.totalRecoverablePaise,
  }
}
