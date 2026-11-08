/**
 * Excel Import Service — Spenza Phase 5
 *
 * Handles parsing, date normalization, duplicate detection, and Firestore batch writes.
 * Uses SheetJS (xlsx) for client-side parsing — no server round-trip needed.
 */

import * as XLSX from 'xlsx'
import { writeBatch, collection, getDocs, getCountFromServer, query, where } from 'firebase/firestore'
import { db } from '@/firebase/config'
import { suggestCategory } from '@/utils/categoryKeywords'
import { invalidateInsightsCache } from '@/services/insights'
import { deleteTransactionsSafely } from '@/services/transactions'


// ─── Types ─────────────────────────────────────────────────────────────────────

export type SheetKind = 'monthly' | 'trip' | 'unknown'

export interface DetectedSheet {
  name: string
  rowCount: number
  kind: SheetKind
  /** For trip sheets, the guessed trip name from sheet name */
  guessedTripName?: string
}

/** A row is flagged when its date can't be parsed, or lies after today */
export type DateIssue = 'unparseable' | 'future'

/** A single parsed row before category + trip assignment */
export interface ParsedRow {
  /** Stable id within one parse run: `${sheetName}::${rowIndex}` — used to target per-row date fixes */
  rowId: string
  description: string
  amountPaise: number
  /** ISO "YYYY-MM-DD", or '' when the original date could not be parsed */
  dateStr: string
  rawDate: string      // original cell value for display
  rawAmount: string    // original amount string for display
  /** Set when the date is unparseable or in the future; must be resolved before import */
  dateIssue: DateIssue | null
  /** True when a trip row's date was auto-derived from the trip range / "Day N" marker rather than an explicit cell date */
  isApproximateDate?: boolean
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
  /** Available column headers in the sheet */
  headers: string[]
  /** Column header → field mapping detected (date is '' when sheet has no date column) */
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

/** Today's local date as ISO "YYYY-MM-DD" */
export function todayISO(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

/** True only for real calendar dates in "YYYY-MM-DD" form (rejects e.g. 2026-02-31) */
export function isValidISODate(s: string): boolean {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (y < 1900 || mo < 1 || mo > 12 || d < 1) return false
  const dt = new Date(y, mo - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d
}

/** Classify a row's date: unparseable/invalid, later than today, or fine (null) */
export function getDateIssue(dateStr: string): DateIssue | null {
  if (!dateStr || !isValidISODate(dateStr)) return 'unparseable'
  return dateStr > todayISO() ? 'future' : null
}

/**
 * Normalize dates from various Excel formats:
 *  - Excel serial number (number)
 *  - "DD/MM/YY" or "DD/MM/YYYY"
 *  - "YYYY-MM-DD"
 *  - JS Date object (already parsed by xlsx)
 *  Returns ISO "YYYY-MM-DD" or null on failure (including impossible dates like 31/02/2026).
 */
export function parseExcelDate(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null

  // ── Diagnostic: remove after confirming correct dates ──────────────────────
  if (typeof val === 'string' || typeof val === 'number') {
    console.debug('[Spenza Date Debug] raw date cell →', typeof val, JSON.stringify(val))
  }
  // ──────────────────────────────────────────────────────────────────────────

  const valid = (iso: string): string | null => (isValidISODate(iso) ? iso : null)

  // Excel numeric serial date (e.g. from an unformatted number cell)
  if (typeof val === 'number' && val > 0) {
    const date = XLSX.SSF.parse_date_code(val)
    if (!date) return null
    return valid(`${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`)
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
      return valid(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`)
    }
    // "YYYY-MM-DD"
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (isoMatch) return valid(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`)
    // "DD-MM-YYYY"
    const dmy2Match = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
    if (dmy2Match) {
      const [, d, m, y] = dmy2Match
      return valid(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`)
    }
  }

  // Already a JS Date from xlsx
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null
    const y = val.getFullYear()
    const m = String(val.getMonth() + 1).padStart(2, '0')
    const d = String(val.getDate()).padStart(2, '0')
    return valid(`${y}-${m}-${d}`)
  }

  return null
}

/** Parse amount from cell: strips ₹, commas, handles negatives */
export function parseAmount(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null
  if (typeof val === 'number') {
    const paise = Math.round(val * 100)
    return Number.isSafeInteger(paise) && paise > 0 ? paise : null
  }
  const str = String(val).replace(/[₹,\s]/g, '').trim()
  const paise = Math.round(Number(str) * 100)
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null
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

/** Derive a clean human-readable trip name from a worksheet name (e.g. "Gokarna Trip - Feb 2026" → "Gokarna Trip") */
export function inferTripNameFromSheet(sheetName: string): string {
  const cleaned = sheetName
    .replace(/[-–—]\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{2,4}/i, '')
    .trim()
  return cleaned || sheetName.trim()
}

/** Extract a 1-based day number from text like "Day 1 Breakfast", "Day 2 Lunch", etc. */
export function extractDayNumber(text: string): number | null {
  const m = text.match(/\bday\s*(\d{1,2})\b/i)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= 60 ? n : null
}

/** Add days to an ISO "YYYY-MM-DD" date string */
export function addDaysISO(isoDate: string, daysToAdd: number): string {
  if (!isValidISODate(isoDate)) return isoDate
  const [y, m, d] = isoDate.split('-').map(Number)
  const dt = new Date(y, m - 1, d + daysToAdd)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

/** Try to infer "YYYY-MM-01" from a sheet name like "Gokarna Trip - Feb 2026" */
export function inferMonthStartFromSheetName(sheetName: string): string | null {
  const lower = sheetName.toLowerCase()
  let monthIdx = -1
  for (let i = 0; i < MONTH_NAMES.length; i++) {
    if (lower.includes(MONTH_NAMES[i])) {
      monthIdx = i + 1
      break
    }
  }
  if (monthIdx === -1) return null

  const yearMatch = sheetName.match(/\b(20\d{2}|\d{2})\b/)
  let year = new Date().getFullYear()
  if (yearMatch) {
    const rawYr = Number(yearMatch[1])
    year = rawYr < 100 ? 2000 + rawYr : rawYr
  }
  const iso = `${year}-${String(monthIdx).padStart(2, '0')}-01`
  return isValidISODate(iso) ? iso : null
}

/**
 * Infer start and end ISO dates ("YYYY-MM-DD") from a trip sheet's parsed rows and sheet name.
 * Uses explicit valid row dates if present; otherwise falls back to the month/year in the
 * sheet name (e.g. "Gokarna Trip - Feb 2026" → "2026-02-01") and extends `endDate` by any
 * "Day N" markers found in row descriptions.
 */
export function inferTripDateRange(
  rows: ParsedRow[],
  sheetName?: string
): { startDate: string; endDate: string } {
  const explicitDates = rows
    .filter(r => !r.isApproximateDate && r.dateStr && isValidISODate(r.dateStr) && !getDateIssue(r.dateStr))
    .map(r => r.dateStr)
    .sort()

  const maxDayNum = rows.reduce((max, r) => {
    const dDesc = extractDayNumber(r.description)
    const dRaw = extractDayNumber(r.rawDate)
    return Math.max(max, dDesc ?? 1, dRaw ?? 1)
  }, 1)

  if (explicitDates.length > 0) {
    const startDate = explicitDates[0]
    const minEndByDay = addDaysISO(startDate, maxDayNum - 1)
    const lastExplicit = explicitDates[explicitDates.length - 1]
    return {
      startDate,
      endDate: lastExplicit >= minEndByDay ? lastExplicit : minEndByDay,
    }
  }

  const startDate = (sheetName ? inferMonthStartFromSheetName(sheetName) : null) ?? todayISO()
  const endDate = addDaysISO(startDate, Math.max(0, maxDayNum - 1))
  return { startDate, endDate }
}

/**
 * Hybrid trip row date assignment:
 *  - If a row has its own valid, non-future calendar date (`!r.isApproximateDate`), keep it.
 *  - Otherwise, track "Day N" markers in `description` or `rawDate` sequentially down the sheet:
 *    - Rows before "Day 1" (and rows in sheets with no "Day N" markers) use offset 0 (`startDate`).
 *    - When a row contains "Day N" (e.g. "Day 2 Breakfast"), `currentDayOffset` updates to `N - 1`,
 *      so that row and subsequent undated rows on the same day receive `startDate + (N - 1) days`
 *      (clamped to `endDate`).
 *  - Clears `dateIssue` (`null`) so trip sheets never block import on per-row date review.
 */
export function resolveTripRowDates(
  rows: ParsedRow[],
  startDate: string,
  endDate: string
): ParsedRow[] {
  const validStart = isValidISODate(startDate) ? startDate : todayISO()
  const validEnd = isValidISODate(endDate) && endDate >= validStart ? endDate : validStart

  let currentDayOffset = 0

  return rows.map(row => {
    const dayFromDesc = extractDayNumber(row.description)
    const dayFromRaw = extractDayNumber(row.rawDate)
    const detectedDay = dayFromDesc ?? dayFromRaw
    if (detectedDay !== null) {
      currentDayOffset = Math.max(0, detectedDay - 1)
    }

    // Keep an explicit valid calendar date from a real Date column
    if (!row.isApproximateDate && row.dateStr && isValidISODate(row.dateStr) && !getDateIssue(row.dateStr)) {
      return {
        ...row,
        dateIssue: null,
        isApproximateDate: false,
      }
    }

    const candidateDate = addDaysISO(validStart, currentDayOffset)
    const clampedDate = candidateDate > validEnd ? validEnd : candidateDate

    return {
      ...row,
      dateStr: clampedDate,
      dateIssue: null,
      isApproximateDate: true,
    }
  })
}

// ─── Column auto-detection ────────────────────────────────────────────────────

const DESC_CANDIDATES = ['expense', 'description', 'item', 'particulars', 'details', 'name', 'title', 'narration']
const AMT_CANDIDATES  = ['gross amount', 'net amount', 'amount', 'amt', 'cost', 'price', 'value', 'spend', 'rupees', 'rs', '₹', 'paid']
const DATE_CANDIDATES = ['date', 'dt', 'day', 'when']

function isSyntheticEmptyHeader(h: string): boolean {
  return h.startsWith('__EMPTY')
}

/**
 * Try to auto-detect which columns are Expense/Amount/Date from headers and sample rows.
 * Never reuses the description or amount column as a fallback for date — if a sheet has
 * no date column (e.g. a 2-column Trip sheet with only "Expenses" and "Amount"),
 * `date` is returned as `''`.
 */
function detectColumns(
  headers: string[],
  sampleRows: Record<string, unknown>[] = []
): { description: string; amount: string; date: string } {
  const realHeaders = headers.filter(h => !isSyntheticEmptyHeader(h))
  const pool = realHeaders.length > 0 ? realHeaders : headers

  const findByHeader = (candidates: string[], exclude: Set<string>): string | null => {
    for (const c of candidates) {
      const h = pool.find(col => !exclude.has(col) && col.toLowerCase().trim().includes(c))
      if (h) return h
    }
    return null
  }

  const used = new Set<string>()

  // 1. Description column
  let description = findByHeader(DESC_CANDIDATES, used)
  if (!description) {
    // Fallback: pick first column whose sample values are mostly non-numeric, non-date strings
    description = pool.find(col => {
      const vals = sampleRows.slice(0, 10).map(r => String(r[col] ?? '').trim()).filter(Boolean)
      if (vals.length === 0) return false
      const textCount = vals.filter(v => parseAmount(v) === null && parseExcelDate(v) === null).length
      return textCount >= Math.ceil(vals.length * 0.5)
    }) ?? pool[0] ?? ''
  }
  if (description) used.add(description)

  // 2. Amount column (must be distinct from description)
  let amount = findByHeader(AMT_CANDIDATES, used)
  if (!amount) {
    // Fallback: pick first remaining column whose sample values parse as positive numbers
    amount = pool.find(col => {
      if (used.has(col)) return false
      const vals = sampleRows.slice(0, 10).map(r => r[col]).filter(v => v !== '' && v !== null && v !== undefined)
      if (vals.length === 0) return false
      const numCount = vals.filter(v => parseAmount(v) !== null).length
      return numCount >= Math.ceil(vals.length * 0.5)
    }) ?? pool.find(col => !used.has(col)) ?? ''
  }
  if (amount) used.add(amount)

  // 3. Date column (must be distinct from description and amount; '' if sheet has no date column)
  let date = findByHeader(DATE_CANDIDATES, used)
  if (!date) {
    // Content fallback: only pick a remaining column if its sample cells actually parse as dates
    date = pool.find(col => {
      if (used.has(col)) return false
      const vals = sampleRows.slice(0, 10).map(r => r[col]).filter(v => v !== '' && v !== null && v !== undefined)
      if (vals.length === 0) return false
      const dateCount = vals.filter(v => parseExcelDate(v) !== null).length
      return dateCount >= Math.max(1, Math.ceil(vals.length * 0.3))
    }) ?? ''
  }

  return { description, amount, date }
}

/**
 * Find the 0-based row index of the actual table header row within the first 10 rows.
 * Handles sheets that have a title banner or blank row above the "Expenses | Amount | Date" headers.
 */
function findHeaderRowIndex(ws: XLSX.WorkSheet): number {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: '',
    raw: false,
  })
  const limit = Math.min(matrix.length, 10)
  const allHeaderKeywords = [...DESC_CANDIDATES, ...AMT_CANDIDATES, ...DATE_CANDIDATES]

  for (let r = 0; r < limit; r++) {
    const row = matrix[r] ?? []
    const cells = row.map(c => String(c ?? '').toLowerCase().trim()).filter(Boolean)
    if (cells.length < 2) continue
    const keywordHits = cells.filter(cell =>
      allHeaderKeywords.some(kw => cell.includes(kw))
    ).length
    if (keywordHits >= 2 || (keywordHits >= 1 && parseAmount(row[1]) === null)) {
      return r
    }
  }
  return 0
}

// ─── Main parse function ──────────────────────────────────────────────────────

export function parseWorkbook(buffer: ArrayBuffer, fileName?: string): {
  sheets: DetectedSheet[]
  workbook: XLSX.WorkBook
} {
  const isCsv = fileName?.toLowerCase().endsWith('.csv') ?? false
  const workbook = XLSX.read(buffer, {
    type: 'array',
    cellDates: false,
    // For CSV: treat as raw text so dates arrive as display strings (DD/MM/YY, etc.)
    raw: isCsv ? false : true,
  })

  // For CSV files, XLSX names the single sheet "Sheet1". Rename it to the
  // file's basename so classifySheet can use the filename for month/trip detection.
  if (isCsv && fileName && workbook.SheetNames.length === 1 && workbook.SheetNames[0] === 'Sheet1') {
    const baseName = fileName.replace(/\.csv$/i, '')
    const ws = workbook.Sheets['Sheet1']
    workbook.SheetNames[0] = baseName
    workbook.Sheets[baseName] = ws
    delete workbook.Sheets['Sheet1']
  }

  const sheets: DetectedSheet[] = workbook.SheetNames.map(name => {
    const ws = workbook.Sheets[name]
    const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
    const rowCount = Math.max(0, range.e.r - range.s.r) // exclude header
    const kind = classifySheet(name)
    return {
      name,
      rowCount,
      kind,
      guessedTripName: kind === 'trip' ? inferTripNameFromSheet(name) : undefined,
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
  const headerRowIndex = findHeaderRowIndex(ws)
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: '',
    raw: false,   // return formatted cell text (what the user sees), not raw serials
    range: headerRowIndex,
  })

  const warnings: string[] = []

  const guessedTripName = kind === 'trip' ? inferTripNameFromSheet(sheetName) : undefined

  if (rawRows.length === 0) {
    return {
      sheet: { name: sheetName, rowCount: 0, kind, guessedTripName },
      rows: [],
      headers: [],
      colMap: colMapOverride ?? { description: '', amount: '', date: '' },
      previewRows: [],
      warnings: ['Sheet appears to be empty'],
    }
  }

  const allRawHeaders = Object.keys(rawRows[0])
  const colMap = colMapOverride ?? detectColumns(allRawHeaders, rawRows)
  const namedHeaders = allRawHeaders.filter(
    h => !isSyntheticEmptyHeader(h) || h === colMap.description || h === colMap.amount || h === colMap.date
  )
  const headers = namedHeaders.length > 0 ? namedHeaders : allRawHeaders

  const rows: ParsedRow[] = []

  for (const [rowIndex, raw] of rawRows.entries()) {
    const descRaw = colMap.description ? String(raw[colMap.description] ?? '').trim() : ''
    const amtRaw  = colMap.amount ? raw[colMap.amount] : ''
    const dateRaw = colMap.date ? raw[colMap.date] : ''

    if (
      !descRaw ||
      /^(grand\s+|sub\s*)?total(\s+(expenses?|amount|spend|cost))?$/i.test(descRaw)
    ) {
      continue
    }

    const amountPaise = parseAmount(amtRaw)
    if (!amountPaise) {
      if (descRaw) warnings.push(`Skipped "${descRaw}": invalid amount "${amtRaw}"`)
      continue
    }

    // Rows with a bad or future date are KEPT and flagged (dateIssue) so the user can
    // correct them in the preview step, rather than being silently dropped.
    const dateStr = parseExcelDate(dateRaw) ?? ''

    rows.push({
      rowId: `${sheetName}::${rowIndex}`,
      description: descRaw,
      amountPaise,
      dateStr,
      rawDate: colMap.date ? String(dateRaw ?? '') : '',
      rawAmount: String(amtRaw ?? ''),
      dateIssue: getDateIssue(dateStr),
      suggestedCategoryName: suggestCategory(descRaw),
      resolvedCategoryId: null,
      sheetName,
      isTripRow: kind === 'trip',
      tripId: null,
    })
  }

  const finalRows = kind === 'trip'
    ? (() => {
        const range = inferTripDateRange(rows, sheetName)
        return resolveTripRowDates(rows, range.startDate, range.endDate)
      })()
    : rows

  return {
    sheet: { name: sheetName, rowCount: finalRows.length, kind, guessedTripName },
    rows: finalRows,
    headers,
    colMap,
    previewRows: finalRows.slice(0, 10),
    warnings,
  }
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

/**
 * Find monthly-sheet summary rows that represent the single-line total of a detailed Trip sheet.
 * A Trip sheet is the detailed split-up of that single line in the monthly sheet, never a separate
 * expenditure — so matching monthly summary rows are excluded by default when importing the Trip sheet.
 */
export function detectDuplicates(
  monthlyRows: ParsedRow[],
  tripSheetResults: SheetParseResult[]
): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = []
  const seenMonthlyRowIds = new Set<string>()

  for (const tripResult of tripSheetResults) {
    if (tripResult.rows.length === 0) continue

    const cleanTripName = inferTripNameFromSheet(tripResult.sheet.name).toLowerCase().trim()
    // Extract location/topic keywords from trip sheet name (e.g. "Gokarna Trip - Feb 2026" → ["gokarna"])
    const tripKeywords = tripResult.sheet.name
      .toLowerCase()
      .split(/[\s\-–—,]+/)
      .filter(w => w.length > 2 && !MONTH_NAMES.includes(w) && !['trip', 'travel', 'tour', '2023', '2024', '2025', '2026', '2027'].includes(w))

    const tripTotal = tripResult.rows.reduce((s, r) => s + r.amountPaise, 0)

    for (const mRow of monthlyRows) {
      if (seenMonthlyRowIds.has(mRow.rowId)) continue
      const descLower = mRow.description.toLowerCase().trim()
      const keywordMatch = tripKeywords.some(kw => descLower.includes(kw))
      if (!keywordMatch) continue

      // Match when the monthly row is the single-line summary of the trip:
      // 1. Amount matches the sum of the detailed trip sheet (within 5%), OR
      // 2. Description explicitly names the trip (e.g. "Gokarna Trip")
      const amtMatchesTotal =
        tripTotal > 0 && Math.abs(mRow.amountPaise - tripTotal) / tripTotal <= 0.05
      const descNamesTrip =
        (cleanTripName.length > 0 && descLower === cleanTripName) ||
        /\b(trip|travel|tour|outing|vacation)\b/i.test(descLower)

      if (amtMatchesTotal || descNamesTrip) {
        seenMonthlyRowIds.add(mRow.rowId)
        candidates.push({
          monthlyRow: mRow,
          tripRows: tripResult.rows,
          reason: amtMatchesTotal
            ? `"${mRow.description}" (₹${(mRow.amountPaise / 100).toFixed(0)}) in ${mRow.sheetName} is the single-line summary of ${tripResult.sheet.name} (${tripResult.rows.length} detailed rows totaling ₹${(tripTotal / 100).toFixed(0)})`
            : `"${mRow.description}" (₹${(mRow.amountPaise / 100).toFixed(0)}) in ${mRow.sheetName} is the monthly summary line for ${tripResult.sheet.name}`,
        })
      }
    }
  }

  return candidates
}

/**
 * Remove any single-line non-trip summary transactions in Firestore that duplicate an existing
 * Trip's detailed transactions (e.g. when a monthly sheet with "Gokarna Trip = ₹4,016" and a
 * detailed trip sheet "Gokarna Trip - Feb 2026" totaling ₹4,016 were both imported).
 * Returns the number of duplicate summary rows removed.
 */
export async function deduplicateTripSummaryTransactions(uid: string): Promise<number> {
  const tripsSnap = await getDocs(collection(db, 'users', uid, 'trips'))
  if (tripsSnap.empty) return 0

  const txnColl = collection(db, 'users', uid, 'transactions')
  const txnsSnap = await getDocs(txnColl)
  if (txnsSnap.empty) return 0

  const allTxns = txnsSnap.docs.map(d => ({
    ref: d.ref,
    data: { id: d.id, ...d.data() } as {
      id: string
      description: string
      amountPaise: number
      type: string
      tripId: string | null
    },
  }))

  const toDeleteRefs: (typeof allTxns)[number]['ref'][] = []
  const deletedIds = new Set<string>()

  for (const tripDoc of tripsSnap.docs) {
    const tripId = tripDoc.id
    const tripName = String(tripDoc.data().name ?? '').trim()
    if (!tripName) continue

    const tripTxns = allTxns.filter(t => t.data.tripId === tripId || (t.data.type === 'trip' && t.data.tripId === tripId))
    if (tripTxns.length < 2) continue

    const tripTotalPaise = tripTxns.reduce((s, t) => s + (t.data.amountPaise ?? 0), 0)
    if (tripTotalPaise <= 0) continue

    const cleanTripName = tripName.toLowerCase()
    const tripKeywords = cleanTripName
      .split(/[\s\-–—,]+/)
      .filter(w => w.length > 2 && !MONTH_NAMES.includes(w) && !['trip', 'travel', 'tour'].includes(w))

    for (const item of allTxns) {
      if (deletedIds.has(item.data.id)) continue
      // Only consider non-trip rows (the single-line summary from a monthly sheet)
      if (item.data.tripId || item.data.type === 'trip') continue

      const descLower = (item.data.description ?? '').toLowerCase().trim()
      const hasKeyword = tripKeywords.length > 0
        ? tripKeywords.some(kw => descLower.includes(kw))
        : descLower === cleanTripName
      if (!hasKeyword) continue

      const amtMatchesTotal =
        Math.abs(item.data.amountPaise - tripTotalPaise) <= Math.max(100, tripTotalPaise * 0.02)
      const exactTripNameMatch =
        descLower === cleanTripName &&
        Math.abs(item.data.amountPaise - tripTotalPaise) <= Math.max(500, tripTotalPaise * 0.05)

      if (amtMatchesTotal || exactTripNameMatch) {
        deletedIds.add(item.data.id)
        toDeleteRefs.push(item.ref)
      }
    }
  }

  if (toDeleteRefs.length === 0) return 0

  const batch = writeBatch(db)
  toDeleteRefs.forEach(ref => batch.delete(ref))
  await batch.commit()
  await invalidateInsightsCache(uid)
  return toDeleteRefs.length
}

// ─── Batch import ─────────────────────────────────────────────────────────────

/** Progress reports only server-confirmed chunks, never queued local writes. */
export interface ImportProgress {
  total: number
  done: number
  batchNum: number
  totalBatches: number
}

// ─── Clear & Count imports ────────────────────────────────────────────────────

/**
 * Count how many imported transactions (`isImported === true`) exist for a user.
 */
export async function getImportedTransactionsCount(uid: string): Promise<number> {
  const q = query(collection(db, 'users', uid, 'transactions'), where('isImported', '==', true))
  try {
    const snap = await getCountFromServer(q)
    return snap.data().count
  } catch {
    const snap = await getDocs(q)
    return snap.size
  }
}

/** Clear imported records through repayment-protected transactional chunks. */
export async function clearImportedTransactions(
  uid: string
): Promise<{ deleted: number; cacheInvalidated: boolean }> {
  const txnColl = collection(db, 'users', uid, 'transactions')
  const snap = await getDocs(query(txnColl, where('isImported', '==', true)))
  return deleteTransactionsSafely(uid, snap.docs.map(d => d.id), true)
}

/** Clear all records through repayment-protected transactional chunks. */
export async function clearAllTransactions(
  uid: string
): Promise<{ deleted: number; cacheInvalidated: boolean }> {
  const snap = await getDocs(collection(db, 'users', uid, 'transactions'))
  return deleteTransactionsSafely(uid, snap.docs.map(d => d.id))
}
