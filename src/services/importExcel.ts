/**
 * Excel Import Service — Spenza Phase 5
 *
 * Handles parsing, date normalization, duplicate detection, and Firestore batch writes.
 * Uses SheetJS (xlsx) for client-side parsing — no server round-trip needed.
 */

import * as XLSX from 'xlsx'
import { writeBatch, doc, collection, serverTimestamp, Timestamp } from 'firebase/firestore'
import { db } from '@/firebase/config'
import { suggestCategory } from '@/utils/categoryKeywords'


// ─── Types ─────────────────────────────────────────────────────────────────────

export type SheetKind = 'monthly' | 'trip' | 'unknown'

export interface DetectedSheet {
  name: string
  rowCount: number
  kind: SheetKind
  /** For trip sheets, the guessed trip name from sheet name */
  guessedTripName?: string
}

/** A single parsed row before category + trip assignment */
export interface ParsedRow {
  description: string
  amountPaise: number
  dateStr: string      // ISO "YYYY-MM-DD"
  rawDate: string      // original cell value for display
  rawAmount: string    // original amount string for display
  /** Auto-suggested category name from keyword matching */
  suggestedCategoryName: string | null
  /** Final resolved category id — set after user review */
  resolvedCategoryId: string | null
  /** Source sheet name */
  sheetName: string
  /** True if this row is from a trip sheet */
  isTripRow: boolean
  /** Trip ID assigned (after user confirms) */
  tripId: string | null
}

export interface SheetParseResult {
  sheet: DetectedSheet
  rows: ParsedRow[]
  /** Column letter → field mapping detected */
  colMap: { description: string; amount: string; date: string }
  /** Preview rows (first 10) */
  previewRows: ParsedRow[]
  /** Parse warnings */
  warnings: string[]
}

/** Candidate duplicate pair */
export interface DuplicateCandidate {
  monthlyRow: ParsedRow
  tripRows: ParsedRow[]
  reason: string
}

// ─── Date parsing ─────────────────────────────────────────────────────────────

/**
 * Normalize dates from various Excel formats:
 *  - Excel serial number (number)
 *  - "DD/MM/YY" or "DD/MM/YYYY"
 *  - "YYYY-MM-DD"
 *  - JS Date object (already parsed by xlsx)
 *  Returns ISO "YYYY-MM-DD" or null on failure.
 */
export function parseExcelDate(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null

  // Excel numeric serial date
  if (typeof val === 'number') {
    const date = XLSX.SSF.parse_date_code(val)
    if (!date) return null
    const y = date.y
    const m = String(date.m).padStart(2, '0')
    const d = String(date.d).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  if (typeof val === 'string') {
    const s = val.trim()
    // "DD/MM/YY" or "DD/MM/YYYY"
    const dmyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
    if (dmyMatch) {
      let [, d, m, y] = dmyMatch
      if (y.length === 2) {
        const yr = parseInt(y)
        y = (yr >= 50 ? `19${y}` : `20${y}`)
      }
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    }
    // "YYYY-MM-DD"
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`
    // "DD-MM-YYYY"
    const dmy2Match = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
    if (dmy2Match) {
      const [, d, m, y] = dmy2Match
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    }
  }

  // Already a JS Date from xlsx
  if (val instanceof Date) {
    const y = val.getFullYear()
    const m = String(val.getMonth() + 1).padStart(2, '0')
    const d = String(val.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  return null
}

/** Parse amount from cell: strips ₹, commas, handles negatives */
export function parseAmount(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null
  if (typeof val === 'number') {
    return isFinite(val) && val > 0 ? Math.round(val * 100) : null
  }
  const str = String(val).replace(/[₹,\s]/g, '').trim()
  const n = parseFloat(str)
  return isFinite(n) && n > 0 ? Math.round(n * 100) : null
}

// ─── Sheet classification ─────────────────────────────────────────────────────

const MONTH_NAMES = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]

export function classifySheet(name: string): SheetKind {
  const lower = name.toLowerCase()
  if (lower.includes('trip') || lower.includes('travel') || lower.includes('goa') ||
      lower.includes('gokarna') || lower.includes('ooty') || lower.includes('kerala') ||
      lower.includes('mumbai') || lower.includes('delhi') || lower.includes('bangalore') ||
      lower.includes('hyderabad') || lower.includes('pune') || lower.includes('europe') ||
      lower.includes('tour')) {
    return 'trip'
  }
  for (const m of MONTH_NAMES) {
    if (lower.includes(m)) return 'monthly'
  }
  return 'unknown'
}

// ─── Column auto-detection ────────────────────────────────────────────────────

/** Try to auto-detect which columns are Expense/Amount/Date from headers */
function detectColumns(
  headers: string[]
): { description: string; amount: string; date: string } {
  const descCandidates = ['expense', 'description', 'item', 'particulars', 'details', 'name']
  const amtCandidates  = ['amount', 'amt', 'cost', 'price', 'value', 'spend', 'rupees', 'rs', '₹']
  const dateCandidates = ['date', 'dt', 'day', 'when']

  const find = (candidates: string[]) => {
    for (const c of candidates) {
      const h = headers.find(h => h.toLowerCase().includes(c))
      if (h) return h
    }
    return headers[0] ?? 'A'
  }

  return {
    description: find(descCandidates),
    amount: find(amtCandidates),
    date: find(dateCandidates),
  }
}

// ─── Main parse function ──────────────────────────────────────────────────────

export function parseWorkbook(buffer: ArrayBuffer): {
  sheets: DetectedSheet[]
  workbook: XLSX.WorkBook
} {
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: false })
  const sheets: DetectedSheet[] = workbook.SheetNames.map(name => {
    const ws = workbook.Sheets[name]
    const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
    const rowCount = Math.max(0, range.e.r - range.s.r) // exclude header
    return {
      name,
      rowCount,
      kind: classifySheet(name),
      guessedTripName: classifySheet(name) === 'trip' ? name.replace(/[-–—]\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\d{4}/i, '').trim() : undefined,
    }
  })
  return { sheets, workbook }
}

export function parseSheet(
  workbook: XLSX.WorkBook,
  sheetName: string,
  kind: SheetKind,
  colMapOverride?: { description: string; amount: string; date: string }
): SheetParseResult {
  const ws = workbook.Sheets[sheetName]
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: '',
    raw: true,
  })

  const warnings: string[] = []

  if (rawRows.length === 0) {
    return {
      sheet: { name: sheetName, rowCount: 0, kind },
      rows: [],
      colMap: colMapOverride ?? { description: '', amount: '', date: '' },
      previewRows: [],
      warnings: ['Sheet appears to be empty'],
    }
  }

  const headers = Object.keys(rawRows[0])
  const colMap = colMapOverride ?? detectColumns(headers)

  const rows: ParsedRow[] = []

  for (const raw of rawRows) {
    const descRaw = String(raw[colMap.description] ?? '').trim()
    const amtRaw  = raw[colMap.amount]
    const dateRaw = raw[colMap.date]

    if (!descRaw || descRaw.toLowerCase() === 'total' || descRaw.toLowerCase() === 'grand total') continue

    const amountPaise = parseAmount(amtRaw)
    if (!amountPaise) {
      if (descRaw) warnings.push(`Skipped "${descRaw}": invalid amount "${amtRaw}"`)
      continue
    }

    const dateStr = parseExcelDate(dateRaw)
    if (!dateStr) {
      if (descRaw) warnings.push(`Skipped "${descRaw}": unrecognised date "${dateRaw}"`)
      continue
    }

    rows.push({
      description: descRaw,
      amountPaise,
      dateStr,
      rawDate: String(dateRaw),
      rawAmount: String(amtRaw),
      suggestedCategoryName: suggestCategory(descRaw),
      resolvedCategoryId: null,
      sheetName,
      isTripRow: kind === 'trip',
      tripId: null,
    })
  }

  return {
    sheet: { name: sheetName, rowCount: rows.length, kind },
    rows,
    colMap,
    previewRows: rows.slice(0, 10),
    warnings,
  }
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

/**
 * Find monthly-sheet rows that are likely summaries of trip-sheet rows.
 * Criteria: same or adjacent amount (within ±1%), dates within 3 days,
 * and description contains keywords from the trip sheet name.
 */
export function detectDuplicates(
  monthlyRows: ParsedRow[],
  tripSheetResults: SheetParseResult[]
): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = []

  for (const tripResult of tripSheetResults) {
    // Extract keywords from trip sheet name (e.g. "Gokarna Trip - Feb 2026" → ["gokarna"])
    const tripKeywords = tripResult.sheet.name
      .toLowerCase()
      .split(/[\s\-–—,]+/)
      .filter(w => w.length > 3 && !MONTH_NAMES.includes(w) && !['trip', 'travel', '2024', '2025', '2026', '2023'].includes(w))

    const tripTotal = tripResult.rows.reduce((s, r) => s + r.amountPaise, 0)

    for (const mRow of monthlyRows) {
      const descLower = mRow.description.toLowerCase()
      const keywordMatch = tripKeywords.some(kw => descLower.includes(kw))
      if (!keywordMatch) continue

      // Check amount: either it matches the full trip total (summary row)
      // or matches any individual trip row amount closely
      const amtMatchesTotal = Math.abs(mRow.amountPaise - tripTotal) / tripTotal < 0.02
      const amtMatchesRow = tripResult.rows.some(tr =>
        Math.abs(tr.amountPaise - mRow.amountPaise) / mRow.amountPaise < 0.02
      )

      if (amtMatchesTotal || amtMatchesRow) {
        candidates.push({
          monthlyRow: mRow,
          tripRows: tripResult.rows,
          reason: amtMatchesTotal
            ? `Amount (₹${(mRow.amountPaise / 100).toFixed(0)}) matches total of ${tripResult.sheet.name} trip`
            : `Amount matches individual row in ${tripResult.sheet.name}`,
        })
      }
    }
  }

  return candidates
}

// ─── Batch import ─────────────────────────────────────────────────────────────

const BATCH_SIZE = 499 // Firestore limit is 500 ops per batch

export interface ImportProgress {
  total: number
  done: number
  batchNum: number
  totalBatches: number
}

export async function batchImportTransactions(
  uid: string,
  rows: ParsedRow[],
  categoryMap: Map<string, string>, // categoryName → categoryId
  otherCategoryId: string,
  onProgress: (p: ImportProgress) => void
): Promise<{ imported: number; skipped: number }> {
  const txnColl = collection(db, 'users', uid, 'transactions')
  const totalBatches = Math.ceil(rows.length / BATCH_SIZE)
  let imported = 0
  let skipped  = 0

  for (let bi = 0; bi < totalBatches; bi++) {
    const chunk = rows.slice(bi * BATCH_SIZE, (bi + 1) * BATCH_SIZE)
    const batch = writeBatch(db)

    for (const row of chunk) {
      if (!row.amountPaise || !row.dateStr) { skipped++; continue }

      const catId = row.resolvedCategoryId
        ?? (row.suggestedCategoryName ? categoryMap.get(row.suggestedCategoryName) : null)
        ?? otherCategoryId

      const ref = doc(txnColl)
      const date = Timestamp.fromDate(new Date(row.dateStr + 'T12:00:00'))

      batch.set(ref, {
        id: ref.id,
        amountPaise: row.amountPaise,
        description: row.description,
        categoryId: catId,
        type: row.isTripRow ? 'trip' : 'everyday',
        date,
        paymentMode: 'Other',
        paymentAccountId: null,
        tripId: row.tripId ?? null,
        personId: null,
        tags: [],
        notes: '',
        receiptUrl: null,
        isImported: true,
        importSource: 'excel',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      imported++
    }

    await batch.commit()
    onProgress({ total: rows.length, done: Math.min((bi + 1) * BATCH_SIZE, rows.length), batchNum: bi + 1, totalBatches })
  }

  return { imported, skipped }
}
