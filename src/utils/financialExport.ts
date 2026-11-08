import type { Transaction, Category, PaymentAccount, Person } from '../types/index.ts'
import {
  getNetSpendPaise,
  getRecoverablePaise,
  getRepaidPaise,
  toNonNegativeIntPaise,
} from './splitMath.ts'

export interface SerializedTimestamp {
  iso: string
  seconds: number
  nanoseconds: number
}

export interface SerializedSplit {
  personId: string
  personName: string
  amountPaise: number
  repaidPaise: number
  settledAt: SerializedTimestamp | null
}

export interface SerializedTransaction {
  id: string
  amountPaise: number
  type: string
  description: string
  categoryId: string
  date: SerializedTimestamp | null
  paymentMode: string
  paymentAccountId: string | null
  tripId: string | null
  personId: string | null
  tags: string[]
  notes: string
  receiptUrl: string | null
  recoverablePaise: number
  reimbursementStatus: string
  splits: SerializedSplit[]
  createdAt: SerializedTimestamp | null
  updatedAt: SerializedTimestamp | null
  settledAt: SerializedTimestamp | null
  isImported?: boolean
  importSource?: string | null
  importOperationId?: string | null
  importSourceRowId?: string | null
  recurringItemId?: string | null
  recurringOccurrenceDate?: SerializedTimestamp | null
}

export interface FinancialExportDocument {
  format: 'spenza-financial-export'
  version: 1
  exportedAt: string
  exportedAtEpochMs: number
  uid: string
  disclaimer: string
  metadata: {
    transactionCount: number
    categoryCount: number
    paymentAccountCount: number
    peopleCount: number
    totalGrossPaise: number
    totalRecoverablePaise: number
    totalNetPaise: number
    totalRepaidPaise: number
  }
  data: {
    transactions: SerializedTransaction[]
    categories: Category[]
    paymentAccounts: PaymentAccount[]
    people: Person[]
  }
}

export function serializeTimestamp(val: unknown): SerializedTimestamp | null {
  if (val === null || val === undefined) return null

  // Firestore Timestamp with toDate() and seconds/nanoseconds
  if (typeof val === 'object' && val !== null && 'toDate' in val && typeof (val as any).toDate === 'function') {
    const d = (val as any).toDate() as Date
    return {
      iso: d.toISOString(),
      seconds: (val as any).seconds ?? Math.floor(d.getTime() / 1000),
      nanoseconds: (val as any).nanoseconds ?? 0,
    }
  }

  // Raw seconds / _seconds representation
  if (typeof val === 'object' && val !== null && ('seconds' in val || '_seconds' in val)) {
    const sec = ((val as any).seconds ?? (val as any)._seconds) as number
    const nano = ((val as any).nanoseconds ?? (val as any)._nanoseconds ?? 0) as number
    return {
      iso: new Date(sec * 1000 + Math.floor(nano / 1_000_000)).toISOString(),
      seconds: sec,
      nanoseconds: nano,
    }
  }

  // JS Date instance
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null
    return {
      iso: val.toISOString(),
      seconds: Math.floor(val.getTime() / 1000),
      nanoseconds: (val.getTime() % 1000) * 1_000_000,
    }
  }

  // ISO string or numeric epoch ms
  if (typeof val === 'string' || typeof val === 'number') {
    const d = new Date(val)
    if (isNaN(d.getTime())) return null
    return {
      iso: d.toISOString(),
      seconds: Math.floor(d.getTime() / 1000),
      nanoseconds: (d.getTime() % 1000) * 1_000_000,
    }
  }

  return null
}

export function serializeTransaction(tx: Transaction): SerializedTransaction {
  const splits: SerializedSplit[] = Array.isArray(tx.splits)
    ? tx.splits.map(s => ({
        personId: s.personId ?? '',
        personName: s.personName ?? '',
        amountPaise: toNonNegativeIntPaise(s.amountPaise),
        repaidPaise: toNonNegativeIntPaise(s.repaidPaise),
        settledAt: serializeTimestamp(s.settledAt),
      }))
    : []

  const serialized: SerializedTransaction = {
    id: tx.id,
    amountPaise: toNonNegativeIntPaise(tx.amountPaise),
    type: tx.type ?? 'everyday',
    description: tx.description ?? '',
    categoryId: tx.categoryId ?? '',
    date: serializeTimestamp(tx.date),
    paymentMode: tx.paymentMode ?? 'Cash',
    paymentAccountId: tx.paymentAccountId ?? null,
    tripId: tx.tripId ?? null,
    personId: tx.personId ?? null,
    tags: Array.isArray(tx.tags) ? [...tx.tags] : [],
    notes: tx.notes ?? '',
    receiptUrl: tx.receiptUrl ?? null,
    recoverablePaise: getRecoverablePaise(tx),
    reimbursementStatus: tx.reimbursementStatus ?? 'none',
    splits,
    createdAt: serializeTimestamp(tx.createdAt),
    updatedAt: serializeTimestamp(tx.updatedAt),
    settledAt: serializeTimestamp((tx as unknown as { settledAt?: unknown }).settledAt),
  }

  if (tx.isImported !== undefined) serialized.isImported = tx.isImported
  if (tx.importSource !== undefined) serialized.importSource = tx.importSource
  if (tx.importOperationId !== undefined) serialized.importOperationId = tx.importOperationId
  if (tx.importSourceRowId !== undefined) serialized.importSourceRowId = tx.importSourceRowId
  if (tx.recurringItemId !== undefined) serialized.recurringItemId = tx.recurringItemId
  if (tx.recurringOccurrenceDate !== undefined) serialized.recurringOccurrenceDate = serializeTimestamp(tx.recurringOccurrenceDate)

  return serialized
}

export function buildFinancialExportDocument(params: {
  uid: string
  transactions: Transaction[]
  categories: Category[]
  paymentAccounts: PaymentAccount[]
  people: Person[]
  now?: Date
}): FinancialExportDocument {
  const { uid, transactions, categories, paymentAccounts, people } = params
  const now = params.now ?? new Date()

  let totalGrossPaise = 0
  let totalRecoverablePaise = 0
  let totalNetPaise = 0
  let totalRepaidPaise = 0

  const serializedTxns = transactions.map(tx => {
    const serialized = serializeTransaction(tx)
    totalGrossPaise += serialized.amountPaise
    totalRecoverablePaise += serialized.recoverablePaise
    totalNetPaise += getNetSpendPaise(tx)
    totalRepaidPaise += getRepaidPaise(tx)
    return serialized
  })

  return {
    format: 'spenza-financial-export',
    version: 1,
    exportedAt: now.toISOString(),
    exportedAtEpochMs: now.getTime(),
    uid,
    disclaimer:
      'This export contains complete financial ledger records in raw integer paise for archival and backup inspection. Automated restore is not supported in this version.',
    metadata: {
      transactionCount: serializedTxns.length,
      categoryCount: categories.length,
      paymentAccountCount: paymentAccounts.length,
      peopleCount: people.length,
      totalGrossPaise,
      totalRecoverablePaise,
      totalNetPaise,
      totalRepaidPaise,
    },
    data: {
      transactions: serializedTxns,
      categories: categories.map(c => ({ ...c })),
      paymentAccounts: paymentAccounts.map(a => ({ ...a })),
      people: people.map(p => ({ ...p })),
    },
  }
}

export function validateExportIntegrity(doc: FinancialExportDocument): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (doc.format !== 'spenza-financial-export' || doc.version !== 1) {
    errors.push('Invalid export document format or schema version')
  }

  if (!doc.uid || typeof doc.uid !== 'string') {
    errors.push('Missing or invalid owner UID')
  }

  if (doc.data.transactions.length !== doc.metadata.transactionCount) {
    errors.push(
      `Transaction count mismatch: metadata reports ${doc.metadata.transactionCount}, but data contains ${doc.data.transactions.length}`
    )
  }

  let calculatedGross = 0
  let calculatedRecoverable = 0

  for (let i = 0; i < doc.data.transactions.length; i++) {
    const tx = doc.data.transactions[i]
    if (!tx.id) {
      errors.push(`Transaction at index ${i} is missing an ID`)
    }
    if (!Number.isSafeInteger(tx.amountPaise) || tx.amountPaise < 0) {
      errors.push(`Transaction ${tx.id} has invalid amountPaise: ${tx.amountPaise}`)
    }
    if (!Number.isSafeInteger(tx.recoverablePaise) || tx.recoverablePaise < 0) {
      errors.push(`Transaction ${tx.id} has invalid recoverablePaise: ${tx.recoverablePaise}`)
    }
    calculatedGross += tx.amountPaise
    calculatedRecoverable += tx.recoverablePaise

    for (const split of tx.splits) {
      if (!Number.isSafeInteger(split.amountPaise) || split.amountPaise < 0) {
        errors.push(`Transaction ${tx.id} split has invalid amountPaise: ${split.amountPaise}`)
      }
      if (!Number.isSafeInteger(split.repaidPaise) || split.repaidPaise < 0) {
        errors.push(`Transaction ${tx.id} split has invalid repaidPaise: ${split.repaidPaise}`)
      }
    }
  }

  if (calculatedGross !== doc.metadata.totalGrossPaise) {
    errors.push(
      `Total gross paise mismatch: metadata reports ${doc.metadata.totalGrossPaise}, calculated ${calculatedGross}`
    )
  }

  if (calculatedRecoverable !== doc.metadata.totalRecoverablePaise) {
    errors.push(
      `Total recoverable paise mismatch: metadata reports ${doc.metadata.totalRecoverablePaise}, calculated ${calculatedRecoverable}`
    )
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
