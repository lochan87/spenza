import { getDocs, query, collection, orderBy } from 'firebase/firestore'
import { format } from 'date-fns'
import { db } from '@/firebase/config'
import type { Transaction, Category, PaymentAccount } from '@/types'
import {
  generateTransactionsCSV,
  csvField,
  csvRow,
} from '@/utils/csvExportMath'

export { generateTransactionsCSV, csvField, csvRow }

/** Trigger a browser file-save of the given string as filename */
function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Fetch all transactions for a user and export as a CSV file.
 * Includes category name, payment mode, account name, import flags,
 * and comprehensive recoverables/splits accounting breakdown.
 */
export async function exportTransactionsCSV(
  uid: string,
  categories: Category[],
  accounts: PaymentAccount[]
): Promise<void> {
  const snap = await getDocs(
    query(collection(db, 'users', uid, 'transactions'), orderBy('date', 'desc'))
  )
  const txns = snap.docs.map(d => ({ id: d.id, ...d.data() }) as Transaction)
  const csv = generateTransactionsCSV(txns, categories, accounts)
  const filename = `spenza-export-${format(new Date(), 'yyyy-MM-dd')}.csv`
  downloadBlob(csv, filename, 'text/csv;charset=utf-8;')
}
