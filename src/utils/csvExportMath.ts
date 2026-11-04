import { format } from 'date-fns'
import type { Category, PaymentAccount, Transaction } from '../types/index.ts'
import {
  getNetSpendPaise,
  getRecoverablePaise,
  getRepaidPaise,
  getPendingRecoverablePaise,
  getReimbursementStatus,
  getNormalizedSplits,
  toNonNegativeIntPaise,
} from './splitMath.ts'

/** Escape a CSV field (wrap in quotes if it contains comma, quote, or newline) */
export function csvField(val: string | number | boolean | null | undefined): string {
  const s = String(val ?? '')
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export function csvRow(fields: (string | number | boolean | null | undefined)[]): string {
  return fields.map(csvField).join(',')
}

/**
 * Pure helper: converts transactions array, categories, and payment accounts into CSV string.
 * Includes gross outflow, net personal spend, recoverable amounts, repayments, pending dues,
 * reimbursement status, and per-participant split breakdowns.
 */
export function generateTransactionsCSV(
  txns: Transaction[],
  categories: Category[],
  accounts: PaymentAccount[]
): string {
  const catMap = new Map(categories.map(c => [c.id, c.name]))
  const accMap = new Map(accounts.map(a => [a.id, a.name]))

  const header = csvRow([
    'Date',
    'Description',
    'Gross Amount (₹)',
    'Net Amount (₹)',
    'Recoverable (₹)',
    'Repaid (₹)',
    'Pending Dues (₹)',
    'Reimbursement Status',
    'Split Breakdown',
    'Category',
    'Type',
    'Payment Mode',
    'Account',
    'Trip ID',
    'Notes',
    'Is Imported',
    'Import Source',
    'ID',
  ])

  const rows = txns.map(tx => {
    const toDate = (ts: any): Date => (ts?.toDate ? ts.toDate() : new Date(ts))
    const date = toDate(tx.date)
    const grossPaise = toNonNegativeIntPaise(tx.amountPaise)
    const netPaise = getNetSpendPaise(tx)
    const recoverablePaise = getRecoverablePaise(tx)
    const repaidPaise = getRepaidPaise(tx)
    const pendingPaise = getPendingRecoverablePaise(tx)
    const status = getReimbursementStatus(tx)

    let splitBreakdown = ''
    const normalizedSplits = getNormalizedSplits(tx)
    if (normalizedSplits.length > 0) {
      splitBreakdown = normalizedSplits
        .map(
          s =>
            `${s.personName}: ₹${(s.amountPaise / 100).toFixed(2)} (Repaid: ₹${(s.repaidPaise / 100).toFixed(2)})`
        )
        .join('; ')
    }

    return csvRow([
      format(date, 'yyyy-MM-dd'),
      tx.description,
      (grossPaise / 100).toFixed(2),
      (netPaise / 100).toFixed(2),
      (recoverablePaise / 100).toFixed(2),
      (repaidPaise / 100).toFixed(2),
      (pendingPaise / 100).toFixed(2),
      status,
      splitBreakdown,
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

  return [header, ...rows].join('\n')
}
