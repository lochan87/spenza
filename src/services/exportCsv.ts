import { getDocs, query, collection, orderBy } from 'firebase/firestore'
import { format } from 'date-fns'
import { Timestamp } from 'firebase/firestore'
import { db } from '@/firebase/config'
import type { Transaction, Category, PaymentAccount } from '@/types'

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

/** Escape a CSV field (wrap in quotes if it contains comma/quote/newline) */
function csvField(val: string | number | boolean | null | undefined): string {
  const s = String(val ?? '')
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function csvRow(fields: (string | number | boolean | null | undefined)[]): string {
  return fields.map(csvField).join(',')
}

/**
 * Fetch all transactions for a user and export as a CSV file.
 * Includes category name, payment mode, account name, import flags.
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

  const catMap = new Map(categories.map(c => [c.id, c.name]))
  const accMap = new Map(accounts.map(a => [a.id, a.name]))

  const header = csvRow([
    'Date', 'Description', 'Amount (₹)', 'Category', 'Type',
    'Payment Mode', 'Account', 'Trip ID', 'Notes',
    'Is Imported', 'Import Source', 'ID',
  ])

  const rows = txns.map(tx => {
    const date = (tx.date as Timestamp).toDate()
    return csvRow([
      format(date, 'yyyy-MM-dd'),
      tx.description,
      (tx.amountPaise / 100).toFixed(2),
      catMap.get(tx.categoryId) ?? 'Other',
      tx.type,
      tx.paymentMode,
      tx.paymentAccountId ? (accMap.get(tx.paymentAccountId) ?? tx.paymentAccountId) : '',
      tx.tripId ?? '',
      tx.notes ?? '',
      tx.isImported ? 'true' : 'false',
      tx.importSource ?? '',
      tx.id,
    ])
  })

  const csv = [header, ...rows].join('\n')
  const filename = `spenza-export-${format(new Date(), 'yyyy-MM-dd')}.csv`
  downloadBlob(csv, filename, 'text/csv;charset=utf-8;')
}
