import { useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FileSpreadsheet, CheckCircle2, AlertTriangle, ChevronRight,
  ChevronDown, ChevronUp, Loader2, ArrowRight, Home, Check,
  Info,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { getCategories } from '@/services/transactions'
import { getTrips } from '@/services/trips'
import {
  parseWorkbook, parseSheet, detectDuplicates, batchImportTransactions,
  type DetectedSheet, type SheetParseResult, type ParsedRow,
  type DuplicateCandidate, type SheetKind, type ImportProgress,
} from '@/services/importExcel'
import { formatINR } from '@/utils/format'
import type { Category, Trip } from '@/types'

// ─── Step enum ────────────────────────────────────────────────────────────────

type Step = 'upload' | 'detect' | 'preview' | 'categories' | 'duplicates' | 'confirm' | 'importing' | 'done'

// ─── Main Component ───────────────────────────────────────────────────────────

export function ImportPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>('upload')
  const [fileName, setFileName] = useState('')
  const [workbook, setWorkbook] = useState<any>(null)
  const [detectedSheets, setDetectedSheets] = useState<DetectedSheet[]>([])
  const [sheetKindOverrides, setSheetKindOverrides] = useState<Record<string, SheetKind>>({})
  const [colMapOverrides, setColMapOverrides] = useState<Record<string, { description: string; amount: string; date: string }>>({})
  const [parseResults, setParseResults] = useState<SheetParseResult[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [existingTrips, setExistingTrips] = useState<Trip[]>([])
  const [tripIdMap, setTripIdMap] = useState<Record<string, string | null>>({}) // sheetName → tripId
  const [catOverrides, setCatOverrides] = useState<Record<string, string>>({}) // description → categoryId
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([])
  const [dupResolutions, setDupResolutions] = useState<Record<number, 'monthly' | 'trip' | 'both'>>({})
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [result, setResult] = useState<{ imported: number; skipped: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedSheet, setExpandedSheet] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)

  // ── Step 1: File upload ──────────────────────────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    setError(null)
    setFileName(file.name)
    try {
      const buffer = await file.arrayBuffer()
      const { sheets, workbook } = parseWorkbook(buffer, file.name)
      setWorkbook(workbook)
      setDetectedSheets(sheets)
      setStep('detect')

      // Pre-load categories and trips
      if (user) {
        const [cats, trips] = await Promise.all([getCategories(user.uid), getTrips(user.uid)])
        setCategories(cats.filter(c => !c.isArchived))
        setExistingTrips(trips.filter(t => !t.isArchived))
      }
    } catch (err) {
      setError('Failed to parse file. Make sure it is a valid .xlsx or .csv file.')
      console.error('[Spenza Import]', err)
    }
  }, [user])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file && (file.name.endsWith('.xlsx') || file.name.endsWith('.csv'))) handleFile(file)
    else setError('Please upload a .xlsx or .csv file.')
  }, [handleFile])

  // ── Step 2: Parse selected sheets ────────────────────────────────────────────

  const handleParseSelected = async () => {
    if (!workbook) return
    setParsing(true)
    const selected = detectedSheets.filter(s => {
      const kind = sheetKindOverrides[s.name] ?? s.kind
      return kind !== 'unknown'
    })

    try {
      const results = selected.map(sheet => {
        const kind = (sheetKindOverrides[sheet.name] ?? sheet.kind) as SheetKind
        return parseSheet(workbook, sheet.name, kind, colMapOverrides[sheet.name])
      })
      setParseResults(results)
      setStep('preview')
    } finally {
      setParsing(false)
    }
  }

  // ── Step 3: After preview → category review ──────────────────────────────────

  const handleGoToCategories = () => {
    setStep('categories')
  }

  // ── Step 4: Categories → duplicate check ─────────────────────────────────────

  const handleCheckDuplicates = () => {
    const monthlyResults = parseResults.filter(r => r.sheet.kind === 'monthly')
    const tripResults    = parseResults.filter(r => r.sheet.kind === 'trip')
    const monthlyRows    = monthlyResults.flatMap(r => r.rows)
    const dups = detectDuplicates(monthlyRows, tripResults)
    setDuplicates(dups)
    setStep('duplicates')
  }

  // ── Step 5: Confirm import ───────────────────────────────────────────────────

  const handleConfirm = () => setStep('confirm')

  // ── Step 6: Run import ───────────────────────────────────────────────────────

  const handleImport = async () => {
    if (!user) return
    setStep('importing')
    setError(null)
    try {
      const catNameToId = new Map(categories.map(c => [c.name, c.id]))
      const otherCat = categories.find(c => c.name === 'Other')?.id ?? categories[0]?.id ?? ''

      // Build final rows (apply resolutions, trip ids, cat overrides)
      const allRows: ParsedRow[] = []

      // Track rows excluded by duplicate resolution
      const excludedMonthlyDescs = new Set<string>()
      const excludedTripSheets   = new Set<string>()

      for (const [i, dup] of duplicates.entries()) {
        const res = dupResolutions[i] ?? 'trip' // default: prefer detailed trip rows
        if (res === 'trip') {
          // Exclude the monthly summary row
          excludedMonthlyDescs.add(`${dup.monthlyRow.sheetName}::${dup.monthlyRow.description}::${dup.monthlyRow.dateStr}`)
        } else if (res === 'monthly') {
          // Exclude the trip sheet rows
          excludedTripSheets.add(dup.tripRows[0]?.sheetName ?? '')
        }
        // 'both': include everything
      }

      for (const result of parseResults) {
        const tripId = tripIdMap[result.sheet.name] ?? null
        for (const row of result.rows) {
          // Skip monthly rows excluded by duplicate resolution
          const key = `${row.sheetName}::${row.description}::${row.dateStr}`
          if (excludedMonthlyDescs.has(key)) continue
          if (excludedTripSheets.has(row.sheetName)) continue

          // Apply category overrides
          const overrideCatId = catOverrides[row.description.toLowerCase()]
          if (overrideCatId) row.resolvedCategoryId = overrideCatId

          allRows.push({ ...row, tripId })
        }
      }

      const res = await batchImportTransactions(
        user.uid, allRows, catNameToId, otherCat,
        (p) => setProgress(p)
      )
      if (!res.cacheInvalidated) {
        setError('Transactions imported, but failed to refresh the Insights cache automatically.')
      }
      setResult(res)
      setStep('done')
    } catch (err) {
      console.error('[Spenza Import]', err)
      setError('Import failed — please try again.')
      setStep('confirm')
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  const STEPS: { key: Step; label: string }[] = [
    { key: 'upload', label: 'Upload' },
    { key: 'detect', label: 'Sheets' },
    { key: 'preview', label: 'Preview' },
    { key: 'categories', label: 'Categories' },
    { key: 'duplicates', label: 'Duplicates' },
    { key: 'confirm', label: 'Confirm' },
    { key: 'importing', label: 'Importing' },
    { key: 'done', label: 'Done' },
  ]
  const stepIdx = STEPS.findIndex(s => s.key === step)

  const totalRows = parseResults.reduce((s, r) => s + r.rows.length, 0)

  return (
    <div className="flex flex-col gap-5 pb-20 md:pb-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-[var(--text-primary)]">Import from Excel</h1>
        <p className="text-sm text-[var(--text-muted)]">Bring in years of history in one go</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-1 overflow-x-auto">
        {STEPS.slice(0, -1).map((s, i) => (
          <div key={s.key} className="flex items-center gap-1">
            <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
              i < stepIdx ? 'bg-[var(--success)] text-white'
              : i === stepIdx ? 'bg-[var(--primary)] text-white'
              : 'bg-[var(--surface-2)] text-[var(--text-subtle)]'
            }`}>{i < stepIdx ? <Check className="h-3 w-3" /> : i + 1}</div>
            <span className={`text-[10px] font-medium shrink-0 ${i === stepIdx ? 'text-[var(--text-primary)]' : 'text-[var(--text-subtle)]'}`}>{s.label}</span>
            {i < STEPS.length - 2 && <ChevronRight className="h-3 w-3 shrink-0 text-[var(--text-subtle)]" />}
          </div>
        ))}
      </div>

      {/* ── STEP: UPLOAD ── */}
      {step === 'upload' && (
        <div className="flex flex-col gap-4">
          <div
            onDrop={onDrop}
            onDragOver={e => e.preventDefault()}
            className="flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-[var(--border)] bg-[var(--surface)] p-12 text-center cursor-pointer hover:border-[var(--primary)] transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--primary-muted)]">
              <FileSpreadsheet className="h-8 w-8 text-[var(--primary)]" />
            </div>
            <div>
              <p className="text-base font-semibold text-[var(--text-primary)]">Drop your .xlsx or .csv file here</p>
              <p className="text-sm text-[var(--text-muted)]">or click to browse</p>
            </div>
            <input ref={fileInputRef} type="file" accept=".xlsx,.csv" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
            {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
          </div>
        </div>
      )}

      {/* ── STEP: DETECT sheets ── */}
      {step === 'detect' && (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <p className="mb-1 text-sm font-semibold text-[var(--text-primary)]">{fileName}</p>
            <p className="text-xs text-[var(--text-muted)]">{detectedSheets.length} sheets detected</p>
          </div>

          <div className="flex flex-col gap-2">
            {detectedSheets.map(sheet => {
              const kind = sheetKindOverrides[sheet.name] ?? sheet.kind
              return (
                <div key={sheet.name} className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium text-[var(--text-primary)]">{sheet.name}</p>
                    <p className="text-[10px] text-[var(--text-muted)]">{sheet.rowCount} rows</p>
                  </div>
                  <select
                    value={kind}
                    onChange={e => setSheetKindOverrides(p => ({ ...p, [sheet.name]: e.target.value as SheetKind }))}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none"
                  >
                    <option value="monthly">📅 Monthly</option>
                    <option value="trip">✈️ Trip</option>
                    <option value="unknown">⏭ Skip</option>
                  </select>
                </div>
              )
            })}
          </div>

          <button
            onClick={handleParseSelected}
            disabled={parsing}
            className="flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {parsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            Parse Selected Sheets
          </button>
        </div>
      )}

      {/* ── STEP: PREVIEW ── */}
      {step === 'preview' && (
        <div className="flex flex-col gap-4">
          {parseResults.map(result => (
            <div key={result.sheet.name} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              <button
                className="flex w-full items-center justify-between px-5 py-4"
                onClick={() => setExpandedSheet(expandedSheet === result.sheet.name ? null : result.sheet.name)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-base">{result.sheet.kind === 'trip' ? '✈️' : '📅'}</span>
                  <div className="text-left">
                    <p className="text-sm font-semibold text-[var(--text-primary)]">{result.sheet.name}</p>
                    <p className="text-xs text-[var(--text-muted)]">{result.rows.length} rows · {result.warnings.length > 0 ? `${result.warnings.length} warnings` : 'clean'}</p>
                  </div>
                </div>
                {expandedSheet === result.sheet.name ? <ChevronUp className="h-4 w-4 text-[var(--text-muted)]" /> : <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" />}
              </button>

              {expandedSheet === result.sheet.name && (
                <div className="border-t border-[var(--border)] px-5 pb-5">
                  {/* Trip: assign existing or new trip */}
                  {result.sheet.kind === 'trip' && (
                    <div className="my-3">
                      <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
                        Link to Trip
                      </label>
                      <select
                        value={tripIdMap[result.sheet.name] ?? ''}
                        onChange={e => setTripIdMap(p => ({ ...p, [result.sheet.name]: e.target.value || null }))}
                        className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none"
                      >
                        <option value="">— Create a new trip for this sheet —</option>
                        {existingTrips.map(t => (
                          <option key={t.id} value={t.id}>{t.coverEmoji} {t.name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Column remapping */}
                  <div className="my-3 grid grid-cols-3 gap-2">
                    {(['description', 'amount', 'date'] as const).map(field => {
                      return (
                        <div key={field}>
                          <label className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wide">{field}</label>
                          <select
                            value={colMapOverrides[result.sheet.name]?.[field] ?? result.colMap[field]}
                            onChange={e => setColMapOverrides(p => ({
                              ...p,
                              [result.sheet.name]: { ...(p[result.sheet.name] ?? result.colMap), [field]: e.target.value }
                            }))}
                            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--text-primary)] outline-none"
                          >
                            {Object.keys(result.previewRows[0] ?? {}).map(h => (
                              <option key={h} value={h}>{h}</option>
                            ))}
                          </select>
                        </div>
                      )
                    })}
                  </div>

                  {/* Preview table */}
                  <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]">
                          <th className="px-3 py-2 text-left text-[var(--text-muted)]">Description</th>
                          <th className="px-3 py-2 text-right text-[var(--text-muted)]">Amount</th>
                          <th className="px-3 py-2 text-left text-[var(--text-muted)]">Date</th>
                          <th className="px-3 py-2 text-left text-[var(--text-muted)]">Category</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.previewRows.map((row, i) => (
                          <tr key={i} className="border-b border-[var(--border)] last:border-0">
                            <td className="max-w-[160px] truncate px-3 py-2 text-[var(--text-primary)]">{row.description}</td>
                            <td className="px-3 py-2 text-right font-mono text-[var(--text-primary)]">{formatINR(row.amountPaise)}</td>
                            <td className="px-3 py-2 text-[var(--text-muted)]">{row.dateStr}</td>
                            <td className="px-3 py-2">
                              <span className={`rounded-full px-2 py-0.5 text-[9px] font-medium ${
                                row.suggestedCategoryName
                                  ? 'bg-[var(--success-muted)] text-[var(--success)]'
                                  : 'bg-[var(--warning-muted)] text-[var(--warning)]'
                              }`}>
                                {row.suggestedCategoryName ?? '?'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Warnings */}
                  {result.warnings.length > 0 && (
                    <div className="mt-3 rounded-xl bg-[var(--warning-muted)] p-3">
                      <p className="mb-1 flex items-center gap-1 text-xs font-medium text-[var(--warning)]">
                        <AlertTriangle className="h-3 w-3" /> {result.warnings.length} rows skipped
                      </p>
                      {result.warnings.slice(0, 3).map((w, i) => (
                        <p key={i} className="text-[10px] text-[var(--text-muted)]">{w}</p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          <button onClick={handleGoToCategories}
            className="flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3.5 text-sm font-semibold text-white">
            <ArrowRight className="h-4 w-4" /> Review Categories
          </button>
        </div>
      )}

      {/* ── STEP: CATEGORIES bulk review ── */}
      {step === 'categories' && (
        <CategoryReviewStep
          parseResults={parseResults}
          categories={categories}
          catOverrides={catOverrides}
          onOverride={(desc, catId) => setCatOverrides(p => ({ ...p, [desc.toLowerCase()]: catId }))}
          onNext={handleCheckDuplicates}
        />
      )}

      {/* ── STEP: DUPLICATES ── */}
      {step === 'duplicates' && (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Duplicate Check</h3>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {duplicates.length === 0
                ? '✅ No likely duplicates found between monthly and trip sheets.'
                : `⚠ ${duplicates.length} potential duplicate(s) detected. For each, choose which version to keep.`}
            </p>
          </div>

          {duplicates.map((dup, i) => (
            <div key={i} className="rounded-2xl border border-[var(--warning-muted)] bg-[var(--surface)] p-5">
              <p className="mb-3 text-xs font-medium text-[var(--warning)]">⚠ {dup.reason}</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-[var(--surface-2)] p-3">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Monthly Sheet Row</p>
                  <p className="text-sm font-medium text-[var(--text-primary)]">{dup.monthlyRow.description}</p>
                  <p className="text-xs text-[var(--text-muted)]">{formatINR(dup.monthlyRow.amountPaise)} · {dup.monthlyRow.dateStr}</p>
                </div>
                <div className="rounded-xl bg-[var(--surface-2)] p-3">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">Trip Sheet ({dup.tripRows.length} rows)</p>
                  <p className="text-sm font-medium text-[var(--text-primary)]">{dup.tripRows[0]?.sheetName}</p>
                  <p className="text-xs text-[var(--text-muted)]">{formatINR(dup.tripRows.reduce((s, r) => s + r.amountPaise, 0))} total</p>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                {([['trip', '✈️ Keep trip detail rows', 'primary'], ['monthly', '📅 Keep monthly summary only', 'border'], ['both', '⚠ Keep both', 'warning']] as const).map(([val, label, variant]) => (
                  <button
                    key={val}
                    onClick={() => setDupResolutions(p => ({ ...p, [i]: val }))}
                    className={`flex-1 rounded-xl border py-2 text-xs font-medium transition-all ${
                      dupResolutions[i] === val
                        ? variant === 'primary' ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)]'
                        : variant === 'warning' ? 'border-[var(--warning)] bg-[var(--warning-muted)] text-[var(--warning)]'
                        : 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-primary)]'
                        : 'border-[var(--border)] text-[var(--text-muted)]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}

          <button onClick={handleConfirm}
            className="flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3.5 text-sm font-semibold text-white">
            <ArrowRight className="h-4 w-4" />
            {duplicates.length > 0 ? 'Continue with Resolutions' : 'Continue to Summary'}
          </button>
        </div>
      )}

      {/* ── STEP: CONFIRM ── */}
      {step === 'confirm' && (
        <div className="flex flex-col gap-4">
          {/* Payment mode notice */}
          <div className="flex gap-3 rounded-2xl border border-[var(--primary-muted)] bg-[var(--primary-muted)] p-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" />
            <div>
              <p className="text-sm font-semibold text-[var(--text-primary)]">Historical data — payment mode unknown</p>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Your Excel has no payment mode column. All <strong>{totalRows} imported transactions</strong> will be marked
                as <strong>paymentMode: "Other"</strong> (no bank/UPI account linked) and flagged as <code className="rounded bg-[var(--surface-2)] px-1">isImported: true</code>.
                Only new expenses you log going forward will have accurate payment tracking.
              </p>
            </div>
          </div>

          {/* Summary */}
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
            <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">Import Summary</h3>
            {parseResults.map(r => (
              <div key={r.sheet.name} className="flex items-center justify-between py-2 border-b border-[var(--border)] last:border-0">
                <div className="flex items-center gap-2">
                  <span>{r.sheet.kind === 'trip' ? '✈️' : '📅'}</span>
                  <span className="text-sm text-[var(--text-primary)]">{r.sheet.name}</span>
                </div>
                <span className="text-sm font-semibold text-[var(--text-primary)]">{r.rows.length} rows</span>
              </div>
            ))}
            <div className="mt-3 flex items-center justify-between border-t border-[var(--border)] pt-3">
              <span className="text-sm font-semibold text-[var(--text-primary)]">Total</span>
              <span className="text-sm font-bold text-[var(--primary)]">{totalRows} transactions</span>
            </div>
            {duplicates.length > 0 && (
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                {duplicates.length} duplicate pair(s) resolved per your choice above.
              </p>
            )}
          </div>

          {error && (
            <div className="rounded-xl bg-[var(--danger-muted)] px-4 py-3 text-sm text-[var(--danger)]">{error}</div>
          )}

          <button onClick={handleImport}
            className="flex items-center justify-center gap-2 rounded-xl bg-[var(--success)] py-3.5 text-sm font-semibold text-white">
            <CheckCircle2 className="h-4 w-4" />
            Import {totalRows} Transactions
          </button>
        </div>
      )}

      {/* ── STEP: IMPORTING ── */}
      {step === 'importing' && (
        <div className="flex flex-col items-center justify-center gap-5 py-12">
          <Loader2 className="h-12 w-12 animate-spin text-[var(--primary)]" />
          <div className="text-center">
            <p className="text-base font-semibold text-[var(--text-primary)]">Importing…</p>
            {progress && (
              <>
                <p className="text-sm text-[var(--text-muted)]">
                  Batch {progress.batchNum} of {progress.totalBatches} · {progress.done}/{progress.total}
                </p>
                <div className="mt-3 h-2 w-64 rounded-full bg-[var(--surface-2)]">
                  <div
                    className="h-full rounded-full bg-[var(--primary)] transition-all"
                    style={{ width: `${(progress.done / progress.total) * 100}%` }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── STEP: DONE ── */}
      {step === 'done' && result && (
        <div className="flex flex-col items-center gap-6 py-8">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--success-muted)]">
            <CheckCircle2 className="h-10 w-10 text-[var(--success)]" />
          </div>
          <div className="text-center">
            <h2 className="text-xl font-bold text-[var(--text-primary)]">Import Complete!</h2>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              {result.imported.toLocaleString()} transactions imported
              {result.skipped > 0 ? ` · ${result.skipped} skipped` : ''}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 w-full max-w-xs">
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-center">
              <p className="text-2xl font-bold text-[var(--success)]">{result.imported.toLocaleString()}</p>
              <p className="text-xs text-[var(--text-muted)]">Imported</p>
            </div>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-center">
              <p className="text-2xl font-bold text-[var(--text-muted)]">{result.skipped}</p>
              <p className="text-xs text-[var(--text-muted)]">Skipped</p>
            </div>
          </div>
          <div className="flex flex-col gap-3 w-full">
            <div className="rounded-xl bg-[var(--primary-muted)] px-4 py-3 text-xs text-[var(--text-muted)]">
              📌 All imported transactions are marked <code className="rounded bg-[var(--surface)] px-1">isImported: true</code> with <code className="rounded bg-[var(--surface)] px-1">paymentMode: "Other"</code>. You can filter these in Transactions to update categories or tags over time.
            </div>
            <button onClick={() => navigate('/app')}
              className="flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3.5 text-sm font-semibold text-white">
              <Home className="h-4 w-4" /> View Dashboard
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Category Review Sub-component ────────────────────────────────────────────

interface CategoryReviewProps {
  parseResults: SheetParseResult[]
  categories: Category[]
  catOverrides: Record<string, string>
  onOverride: (desc: string, catId: string) => void
  onNext: () => void
}

function CategoryReviewStep({ parseResults, categories, catOverrides, onOverride, onNext }: CategoryReviewProps) {
  // Group by suggested category, then show all descriptions
  const allRows = parseResults.flatMap(r => r.rows)

  // Group unique descriptions by suggested category
  const grouped = new Map<string, ParsedRow[]>()
  for (const row of allRows) {
    const key = row.suggestedCategoryName ?? '⚠ No match — review needed'
    if (!grouped.has(key)) grouped.set(key, [])
    // Deduplicate by description
    const existing = grouped.get(key)!
    if (!existing.find(r => r.description === row.description)) {
      existing.push(row)
    }
  }

  const noMatchCount = (grouped.get('⚠ No match — review needed') ?? []).length

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
        <p className="text-sm font-semibold text-[var(--text-primary)]">Category Review</p>
        <p className="text-xs text-[var(--text-muted)]">
          {allRows.length} rows · {noMatchCount > 0 ? `${noMatchCount} descriptions need a category` : 'all auto-categorised'}
        </p>
      </div>

      {[...grouped.entries()].sort((a, _b) => a[0] === '⚠ No match — review needed' ? 1 : -1).map(([catName, rows]) => (
        <div key={catName} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div className={`flex items-center justify-between rounded-t-2xl px-4 py-3 ${
            catName.startsWith('⚠') ? 'bg-[var(--warning-muted)]' : 'bg-[var(--surface-2)]'
          }`}>
            <div>
              <p className="text-sm font-semibold text-[var(--text-primary)]">{catName}</p>
              <p className="text-[10px] text-[var(--text-muted)]">{rows.length} unique description(s)</p>
            </div>
            {/* Bulk-assign all in this group */}
            <select
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none"
              onChange={e => { if (e.target.value) rows.forEach(r => onOverride(r.description, e.target.value)) }}
              defaultValue=""
            >
              <option value="">Bulk assign all →</option>
              {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {rows.slice(0, 12).map((row, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <p className="flex-1 truncate text-sm text-[var(--text-primary)]">{row.description}</p>
                <select
                  value={catOverrides[row.description.toLowerCase()] ?? ''}
                  onChange={e => onOverride(row.description, e.target.value)}
                  className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
                >
                  <option value="">Auto: {row.suggestedCategoryName ?? '?'}</option>
                  {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            ))}
            {rows.length > 12 && (
              <p className="px-4 py-2 text-xs text-[var(--text-subtle)]">…and {rows.length - 12} more</p>
            )}
          </div>
        </div>
      ))}

      <button onClick={onNext}
        className="flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3.5 text-sm font-semibold text-white">
        <ArrowRight className="h-4 w-4" /> Check for Duplicates
      </button>
    </div>
  )
}
