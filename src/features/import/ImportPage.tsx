import { useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Timestamp } from 'firebase/firestore'
import {
  FileSpreadsheet, CheckCircle2, AlertTriangle, ChevronRight,
  ChevronDown, ChevronUp, Loader2, ArrowRight, Home, Check,
  Info, Map as MapIcon,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { getCategories } from '@/services/transactions'
import { getTrips } from '@/services/trips'
import {
  parseWorkbook, parseSheet, detectDuplicates,
  getDateIssue, todayISO, isValidISODate, inferTripNameFromSheet, inferTripDateRange,
  resolveTripRowDates,
  type DetectedSheet, type SheetParseResult, type ParsedRow,
  type DuplicateCandidate, type SheetKind, type ImportProgress,
} from '@/services/importExcel'
import { sha256, newImportOperation, importRecordId, type ImportHeader, type ImportPlan, type ImportTripDraft } from '@/utils/importPlan'
import { findImportOperations, buildImportPlan, saveImportPlan, executeImport, ImportExecutionError, type ImportResult } from '@/services/importOperations'
import { formatINR } from '@/utils/format'
import { DatePicker } from '@/components/ui/DatePicker'
import { ThemedSelect } from '@/components/ui/ThemedSelect'
import type { Category, Trip } from '@/types'

// ─── Step enum ────────────────────────────────────────────────────────────────

type Step = 'resume' | 'upload' | 'detect' | 'preview' | 'categories' | 'duplicates' | 'confirm' | 'importing' | 'done'

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
  const [newTripConfigs, setNewTripConfigs] = useState<
    Record<string, { name?: string; startDate?: string; endDate?: string }>
  >({})
  const [catOverrides, setCatOverrides] = useState<Record<string, string>>({}) // description → categoryId
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([])
  const [dupResolutions, setDupResolutions] = useState<Record<number, 'monthly' | 'trip'>>({})
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [fingerprint, setFingerprint] = useState('')
  const [operationId, setOperationId] = useState('')
  const [savedOperations, setSavedOperations] = useState<ImportHeader[]>([])
  const inFlight = useRef(false)
  const pendingPlan = useRef<ImportPlan | null>(null)
  const [hasFrozenPlan, setHasFrozenPlan] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedSheet, setExpandedSheet] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)
  /**
   * Deliberate per-row choices for rows with a date issue (keyed by ParsedRow.rowId):
   *  - 'import-anyway': keep a future date as-is
   *  - 'skip': leave the row out of the import (the only as-is option for unparseable dates)
   */
  const [dateDecisions, setDateDecisions] = useState<Record<string, 'import-anyway' | 'skip'>>({})
  const [showAllFlagged, setShowAllFlagged] = useState(false)

  // ── Date review helpers ──────────────────────────────────────────────────────

  const allParsedRows = parseResults.flatMap(r => r.rows)
  // Trip sheet rows use trip-level date range + hybrid Day N mapping and never block import
  const flaggedRows = allParsedRows.filter(r => !r.isTripRow && r.dateIssue)
  const unresolvedRows = flaggedRows.filter(r => !dateDecisions[r.rowId])

  /**
   * Write a corrected date into the underlying parsed rows (not just the preview), so every
   * later step — duplicate detection, trip creation and the final write — uses the fixed date.
   */
  const applyDateFix = (rowIds: string[], newDate: string) => {
    if (!newDate) return
    const ids = new Set(rowIds)
    setParseResults(prev =>
      prev.map(res => {
        if (!res.rows.some(r => ids.has(r.rowId))) return res
        const rows = res.rows.map(r =>
          ids.has(r.rowId) ? { ...r, dateStr: newDate, dateIssue: getDateIssue(newDate) } : r
        )
        return { ...res, rows, previewRows: rows.slice(0, 10) }
      })
    )
    // A correction replaces any earlier decision for these rows
    setDateDecisions(prev => {
      const next = { ...prev }
      for (const id of rowIds) delete next[id]
      return next
    })
  }

  const setDecision = (rowIds: string[], decision: 'import-anyway' | 'skip' | null) => {
    setDateDecisions(prev => {
      const next = { ...prev }
      for (const id of rowIds) {
        if (decision) next[id] = decision
        else delete next[id]
      }
      return next
    })
  }

  /** Resolve trip name + start/end dates for a trip sheet (combining user edits with inferred defaults) */
  const getResolvedTripMeta = (
    res: SheetParseResult,
    overrideCfg?: { name?: string; startDate?: string; endDate?: string }
  ) => {
    const activeRows = res.rows.filter(r => dateDecisions[r.rowId] !== 'skip')
    const inferred = inferTripDateRange(activeRows, res.sheet.name)
    const cfg = overrideCfg ?? newTripConfigs[res.sheet.name]
    const defaultName = res.sheet.guessedTripName || inferTripNameFromSheet(res.sheet.name)
    const name = (cfg?.name !== undefined ? cfg.name : defaultName).trim() || defaultName
    const rawStart = cfg?.startDate && isValidISODate(cfg.startDate) ? cfg.startDate : inferred.startDate
    const rawEnd = cfg?.endDate && isValidISODate(cfg.endDate) ? cfg.endDate : inferred.endDate
    const [startDate, endDate] = rawStart <= rawEnd ? [rawStart, rawEnd] : [rawEnd, rawStart]
    return { name, startDate, endDate }
  }

  /** Re-compute a trip sheet's row dates using the hybrid Day N + startDate rule whenever trip dates change */
  const syncTripSheetDates = (sheetName: string, startDate: string, endDate: string) => {
    setParseResults(prev =>
      prev.map(res => {
        if (res.sheet.name !== sheetName || res.sheet.kind !== 'trip') return res
        const rows = resolveTripRowDates(res.rows, startDate, endDate)
        return { ...res, rows, previewRows: rows.slice(0, 10) }
      })
    )
  }

  // ── Step 1: File upload ──────────────────────────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    if (inFlight.current) return
    inFlight.current = true
    setError(null)
    setFileName(file.name)
    try {
      const buffer = await file.arrayBuffer()
      const { sheets, workbook } = parseWorkbook(buffer, file.name)
      setWorkbook(workbook)
      setDetectedSheets(sheets)
      const source = await sha256(buffer)
      if (!user) throw new Error('Sign in before importing.')
      const previous = await findImportOperations(user.uid, source)
      setFingerprint(source)
      setOperationId(newImportOperation(source))
      setSavedOperations(previous)
      pendingPlan.current = null
      setHasFrozenPlan(false)
      setStep(previous.length ? 'resume' : 'detect')

      // Pre-load categories and trips
      if (user) {
        const [cats, trips] = await Promise.all([getCategories(user.uid), getTrips(user.uid)])
        setCategories(cats.filter(c => !c.isArchived))
        setExistingTrips(trips.filter(t => !t.isArchived))
      }
    } catch (err) {
      setStep('upload')
      setError('Could not open the file or check previous imports. Check your connection and access. Importing requires the updated import rules; no unsafe fallback will run.')
      console.error('[Spenza Import]', err)
    } finally {
      inFlight.current = false
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
      setDateDecisions({})
      setNewTripConfigs({})
      setShowAllFlagged(false)
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
    const activeResults = parseResults.map(r => ({
      ...r,
      rows: r.rows.filter(row => dateDecisions[row.rowId] !== 'skip'),
    }))
    const monthlyResults = activeResults.filter(r => r.sheet.kind === 'monthly')
    const tripResults    = activeResults.filter(r => r.sheet.kind === 'trip')
    const monthlyRows    = monthlyResults.flatMap(r => r.rows)
    const dups = detectDuplicates(monthlyRows, tripResults)
    setDuplicates(dups)
    // Default every trip summary match to 'trip' (use detailed trip rows, skip the single-line monthly summary)
    const defaultResolutions: Record<number, 'monthly' | 'trip'> = {}
    dups.forEach((_, idx) => { defaultResolutions[idx] = 'trip' })
    setDupResolutions(defaultResolutions)
    setStep('duplicates')
  }

  // ── Step 5: Confirm import ───────────────────────────────────────────────────

  const handleConfirm = () => setStep('confirm')

  // Compute excluded row IDs and sheets from duplicate resolutions so counts and import match
  const excludedMonthlyRowIds = new Set<string>()
  const excludedTripSheets = new Set<string>()
  for (const [i, dup] of duplicates.entries()) {
    const res = dupResolutions[i] ?? 'trip'
    if (res === 'trip') {
      excludedMonthlyRowIds.add(dup.monthlyRow.rowId)
    } else if (res === 'monthly') {
      excludedTripSheets.add(dup.tripRows[0]?.sheetName ?? '')
    }
  }

  // ── Step 6: Run import ───────────────────────────────────────────────────────

  const handleImport = async () => {
    if (!user || inFlight.current) return
    // Safety net: never write rows with an unresolved date problem
    if (unresolvedRows.length > 0) {
      setError(`${unresolvedRows.length} row${unresolvedRows.length === 1 ? '' : 's'} still need date correction.`)
      setStep('preview')
      return
    }
    inFlight.current = true
    setStep('importing')
    setError(null)
    try {
      if (pendingPlan.current) {
        await saveImportPlan(user.uid, pendingPlan.current)
        setResult(await executeImport(user.uid, operationId, fingerprint, setProgress))
        setStep('done')
        return
      }
      const catNameToId = new Map(categories.map(c => [c.name, c.id]))
      const otherCat = categories.find(c => c.name === 'Other')?.id ?? categories[0]?.id ?? ''

      // Build final rows (apply resolutions, trip ids, cat overrides)
      const allRows: ParsedRow[] = []

      const resolvedTripIds: Record<string, string | null> = { ...tripIdMap }
      const newTrips: Record<string, ImportTripDraft> = {}

      for (const result of parseResults) {
        if (excludedTripSheets.has(result.sheet.name)) continue

        const activeSheetRows = result.rows.filter(row => {
          if (dateDecisions[row.rowId] === 'skip') return false
          if (excludedMonthlyRowIds.has(row.rowId)) return false
          return true
        })

        if (activeSheetRows.length === 0) continue

        let tripId = resolvedTripIds[result.sheet.name] ?? null
        let tripStartISO = ''
        let tripEndISO = ''

        if (result.sheet.kind === 'trip') {
          if (tripId) {
            const linked = existingTrips.find(t => t.id === tripId)
            if (linked) {
              const s = (linked.startDate as Timestamp).toDate()
              const e = linked.endDate ? (linked.endDate as Timestamp).toDate() : s
              tripStartISO = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`
              tripEndISO = `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`
            }
          } else {
            const meta = getResolvedTripMeta(result)
            tripStartISO = meta.startDate
            tripEndISO = meta.endDate
            tripId = await importRecordId(operationId, 'trip', result.sheet.name)
            newTrips[tripId] = {
              name: meta.name,
              startMillis: new Date(meta.startDate + 'T12:00:00').getTime(),
              endMillis: new Date(meta.endDate + 'T12:00:00').getTime(),
            }
            resolvedTripIds[result.sheet.name] = tripId
          }
        }

        const dateResolvedSheetRows =
          result.sheet.kind === 'trip' && tripStartISO
            ? resolveTripRowDates(activeSheetRows, tripStartISO, tripEndISO || tripStartISO)
            : activeSheetRows

        for (const row of dateResolvedSheetRows) {
          // Apply category overrides
          const overrideCatId = catOverrides[row.description.toLowerCase()]
          const resolvedCategoryId = overrideCatId ?? row.resolvedCategoryId

          allRows.push({
            ...row,
            resolvedCategoryId,
            isTripRow: result.sheet.kind === 'trip',
            tripId: result.sheet.kind === 'trip' ? tripId : null,
          })
        }
      }

      const plan = await buildImportPlan(user.uid, operationId, fingerprint, fileName,
        allRows, catNameToId, otherCat, newTrips, allParsedRows.length - allRows.length)
      pendingPlan.current = plan
      setHasFrozenPlan(true)
      await saveImportPlan(user.uid, plan)
      setResult(await executeImport(user.uid, operationId, fingerprint, setProgress))
      setStep('done')
    } catch (err) {
      setResult(err instanceof ImportExecutionError ? err.result : null)
      setError(err instanceof Error ? err.message : 'Could not verify import. Resume the same operation after reconnecting.')
      setStep('confirm')
    } finally {
      inFlight.current = false
    }
  }

  const handleResume = async (id: string) => {
    if (!user || inFlight.current) return
    inFlight.current = true
    setOperationId(id)
    setError(null)
    setStep('importing')
    try {
      setResult(await executeImport(user.uid, id, fingerprint, setProgress))
      setStep('done')
    } catch (err) {
      setResult(err instanceof ImportExecutionError ? err.result : null)
      setError(err instanceof Error ? err.message : 'Unable to verify this import. Reconnect and resume the same operation.')
      setStep('resume')
    } finally { inFlight.current = false }
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

  const totalRows = parseResults.reduce((s, r) => {
    if (excludedTripSheets.has(r.sheet.name)) return s
    const count = r.rows.filter(
      row => dateDecisions[row.rowId] !== 'skip' && !excludedMonthlyRowIds.has(row.rowId)
    ).length
    return s + count
  }, 0)

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

      {error && step !== 'upload' && (
        <div role="alert" className="rounded-xl bg-[var(--danger-muted)] px-4 py-3 text-sm text-[var(--danger)]">{error}</div>
      )}
      {result && !result.complete && (
        <p className="text-sm text-[var(--text-muted)]">
          Import incomplete: {result.imported} imported · {result.alreadyCommitted} already committed · {result.skipped} skipped · {result.unresolved} unresolved. Resume the same operation safely.
        </p>
      )}
      {step === 'resume' && (
        <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="font-semibold text-[var(--text-primary)]">Previous imports of this source</h2>
          <p className="text-sm text-[var(--text-muted)]">Resume uses the saved selections, corrected dates and trip choices. Completed rows will not be imported again.</p>
          {savedOperations.map(op => (
            <button key={op.operationId} onClick={() => handleResume(op.operationId)} className="rounded-xl border border-[var(--border)] p-3 text-left text-sm text-[var(--primary)]">
              Resume / check results: {op.fileName} · {op.total} selected · {op.skipped} skipped · {op.ready ? 'Reviewed plan saved' : 'Preparation incomplete'} · {op.operationId.slice(-8)}
            </button>
          ))}
          <button onClick={() => { setOperationId(newImportOperation(fingerprint, true)); pendingPlan.current = null; setHasFrozenPlan(false); setResult(null); setError(null); setStep('detect') }} className="rounded-xl border border-[var(--warning)] p-3 text-sm text-[var(--text-primary)]">
            Start a new import — intentionally add these records again
          </button>
        </div>
      )}

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
                  <ThemedSelect
                    size="sm"
                    align="end"
                    value={kind}
                    onChange={val => setSheetKindOverrides(p => ({ ...p, [sheet.name]: val as SheetKind }))}
                    options={[
                      { value: 'monthly', label: '📅 Monthly' },
                      { value: 'trip', label: '✈️ Trip' },
                      { value: 'unknown', label: '⏭ Skip' },
                    ]}
                  />
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
          {/* ── Date review: unparseable or future dates must be fixed (or deliberately overridden) ── */}
          <DateReviewPanel
            flaggedRows={flaggedRows}
            unresolvedCount={unresolvedRows.length}
            decisions={dateDecisions}
            showAll={showAllFlagged}
            onToggleShowAll={() => setShowAllFlagged(v => !v)}
            onFix={applyDateFix}
            onDecide={setDecision}
            error={error}
          />

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
                    <p className="text-xs text-[var(--text-muted)]">{result.rows.length} rows · {result.warnings.length > 0 ? `${result.warnings.length} warnings` : 'clean'}{result.rows.some(r => r.dateIssue) ? ` · ${result.rows.filter(r => r.dateIssue).length} date issue(s)` : ''}</p>
                  </div>
                </div>
                {expandedSheet === result.sheet.name ? <ChevronUp className="h-4 w-4 text-[var(--text-muted)]" /> : <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" />}
              </button>

              {/* Trip Setup: always visible for trip sheets so user can confirm trip name & dates */}
              {result.sheet.kind === 'trip' && (() => {
                const selectedTripId = tripIdMap[result.sheet.name] ?? ''
                const meta = getResolvedTripMeta(result)
                return (
                  <div className="border-t border-[var(--border)] bg-[var(--surface-2)]/50 px-5 py-3.5">
                    <div className="flex flex-col gap-3">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-[var(--text-muted)]">
                          Link to Trip
                        </label>
                        <ThemedSelect
                          size="md"
                          value={selectedTripId}
                          onChange={val => {
                            const nextId = val || null
                            setTripIdMap(p => ({ ...p, [result.sheet.name]: nextId }))
                            if (nextId) {
                              const linked = existingTrips.find(t => t.id === nextId)
                              if (linked) {
                                const s = (linked.startDate as Timestamp).toDate()
                                const en = linked.endDate ? (linked.endDate as Timestamp).toDate() : s
                                const sISO = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`
                                const eISO = `${en.getFullYear()}-${String(en.getMonth() + 1).padStart(2, '0')}-${String(en.getDate()).padStart(2, '0')}`
                                syncTripSheetDates(result.sheet.name, sISO, eISO)
                              }
                            } else {
                              const m = getResolvedTripMeta(result)
                              syncTripSheetDates(result.sheet.name, m.startDate, m.endDate)
                            }
                          }}
                          options={[
                            { value: '', label: '✨ Create a new trip for this sheet' },
                            ...existingTrips.map(t => ({ value: t.id, label: `${t.coverEmoji} ${t.name}` })),
                          ]}
                          className="w-full"
                        />
                      </div>

                      {!selectedTripId && (
                        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                          <div>
                            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                              New Trip Name
                            </label>
                            <input
                              type="text"
                              value={newTripConfigs[result.sheet.name]?.name ?? (result.sheet.guessedTripName || inferTripNameFromSheet(result.sheet.name))}
                              onChange={e =>
                                setNewTripConfigs(p => ({
                                  ...p,
                                  [result.sheet.name]: { ...p[result.sheet.name], name: e.target.value },
                                }))
                              }
                              placeholder="Trip name"
                              className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                              Start Date
                            </label>
                            <DatePicker
                              size="sm"
                              value={meta.startDate}
                              onChange={val => {
                                const nextCfg = { ...newTripConfigs[result.sheet.name], startDate: val }
                                setNewTripConfigs(p => ({ ...p, [result.sheet.name]: nextCfg }))
                                const nextMeta = getResolvedTripMeta(result, nextCfg)
                                syncTripSheetDates(result.sheet.name, nextMeta.startDate, nextMeta.endDate)
                              }}
                              className="w-full bg-[var(--surface)]"
                              aria-label={`Start date for ${result.sheet.name}`}
                            />
                          </div>
                          <div>
                            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                              End Date
                            </label>
                            <DatePicker
                              size="sm"
                              value={meta.endDate}
                              minDate={meta.startDate}
                              defaultMonthDate={meta.startDate}
                              onChange={val => {
                                const nextCfg = { ...newTripConfigs[result.sheet.name], endDate: val }
                                setNewTripConfigs(p => ({ ...p, [result.sheet.name]: nextCfg }))
                                const nextMeta = getResolvedTripMeta(result, nextCfg)
                                syncTripSheetDates(result.sheet.name, nextMeta.startDate, nextMeta.endDate)
                              }}
                              className="w-full bg-[var(--surface)]"
                              aria-label={`End date for ${result.sheet.name}`}
                            />
                          </div>
                        </div>
                      )}

                      <p className="text-[11px] text-[var(--text-muted)]">
                        ✨ Row dates in this trip are auto-assigned from the trip date range (using <code className="rounded bg-[var(--surface)] px-1">Day 1 / Day 2</code> markers or defaulting to Start Date).
                      </p>
                    </div>
                  </div>
                )
              })()}

              {expandedSheet === result.sheet.name && (
                <div className="border-t border-[var(--border)] px-5 pb-5">
                  {/* Column remapping */}
                  <div className="my-3 grid grid-cols-3 gap-2">
                    {(['description', 'amount', 'date'] as const).map(field => {
                      const currentVal = colMapOverrides[result.sheet.name]?.[field] ?? result.colMap[field]
                      return (
                        <div key={field}>
                          <label className="mb-1 block text-[10px] font-medium text-[var(--text-muted)] uppercase tracking-wide">{field}</label>
                          <ThemedSelect
                            size="sm"
                            value={currentVal}
                            onChange={val => {
                              const nextMap = {
                                ...(colMapOverrides[result.sheet.name] ?? result.colMap),
                                [field]: val,
                              }
                              setColMapOverrides(p => ({ ...p, [result.sheet.name]: nextMap }))
                              if (workbook) {
                                const reparsed = parseSheet(workbook, result.sheet.name, result.sheet.kind, nextMap)
                                setParseResults(prev =>
                                  prev.map(r => (r.sheet.name === result.sheet.name ? reparsed : r))
                                )
                              }
                            }}
                            options={[
                              ...(field === 'date' ? [{ value: '', label: '— No date column —' }] : []),
                              ...result.headers.map(h => ({ value: h, label: h })),
                            ]}
                            className="w-full"
                          />
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
                            <td
                              className={`px-3 py-2 ${row.dateIssue ? 'font-semibold text-[var(--warning)]' : 'text-[var(--text-muted)]'}`}
                              title={row.isApproximateDate ? 'Auto-mapped from trip date range / Day marker' : undefined}
                            >
                              {row.isApproximateDate ? `~${row.dateStr}` : (row.dateStr || `? ${row.rawDate}`)}
                            </td>
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
            disabled={unresolvedRows.length > 0}
            className="flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3.5 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed">
            <ArrowRight className="h-4 w-4" />
            {unresolvedRows.length > 0
              ? `Fix ${unresolvedRows.length} date${unresolvedRows.length === 1 ? '' : 's'} to continue`
              : 'Review Categories'}
          </button>
        </div>
      )}

      {/* ── STEP: CATEGORIES bulk review ── */}
      {step === 'categories' && (
        <CategoryReviewStep
          parseResults={parseResults.map(r => ({
            ...r,
            rows: r.rows.filter(row => dateDecisions[row.rowId] !== 'skip'),
          }))}
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
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Trip Split-Up Detection</h3>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {duplicates.length === 0
                ? '✅ No overlapping trip summary rows found between monthly and trip sheets.'
                : `✈️ ${duplicates.length} monthly summary line(s) matched a detailed Trip sheet. A Trip sheet is the detailed breakdown of that single line — not a separate expenditure — so the single monthly line is skipped by default to prevent double-counting.`}
            </p>
          </div>

          {duplicates.map((dup, i) => {
            const activeChoice = dupResolutions[i] ?? 'trip'
            return (
              <div key={i} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
                <p className="mb-3 text-xs font-medium text-[var(--primary)]">✨ {dup.reason}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className={`rounded-xl border p-3 transition-all ${activeChoice === 'monthly' ? 'border-[var(--primary)] bg-[var(--primary-muted)]/30' : 'border-transparent bg-[var(--surface-2)] opacity-60'}`}>
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                      Single Summary Line ({dup.monthlyRow.sheetName}) {activeChoice === 'trip' ? '· Skipped' : '· Kept'}
                    </p>
                    <p className="text-sm font-medium text-[var(--text-primary)]">{dup.monthlyRow.description}</p>
                    <p className="text-xs text-[var(--text-muted)]">{formatINR(dup.monthlyRow.amountPaise)} · {dup.monthlyRow.dateStr}</p>
                  </div>
                  <div className={`rounded-xl border p-3 transition-all ${activeChoice === 'trip' ? 'border-[var(--primary)] bg-[var(--primary-muted)]/30' : 'border-transparent bg-[var(--surface-2)] opacity-60'}`}>
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">
                      Detailed Split-Up ({dup.tripRows.length} rows) {activeChoice === 'trip' ? '· Kept' : '· Skipped'}
                    </p>
                    <p className="text-sm font-medium text-[var(--text-primary)]">{dup.tripRows[0]?.sheetName}</p>
                    <p className="text-xs text-[var(--text-muted)]">{formatINR(dup.tripRows.reduce((s, r) => s + r.amountPaise, 0))} total</p>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  {([
                    ['trip', '✈️ Use detailed trip sheet (skip single summary line)', 'primary'],
                    ['monthly', '📅 Keep single summary line only (skip trip sheet)', 'border'],
                  ] as const).map(([val, label, variant]) => (
                    <button
                      key={val}
                      onClick={() => setDupResolutions(p => ({ ...p, [i]: val }))}
                      className={`flex-1 rounded-xl border px-3 py-2 text-xs font-medium transition-all ${
                        activeChoice === val
                          ? variant === 'primary'
                            ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)]'
                            : 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-primary)]'
                          : 'border-[var(--border)] text-[var(--text-muted)]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )
          })}

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
            {parseResults.map(r => {
              const isTripSheetExcluded = excludedTripSheets.has(r.sheet.name)
              const excludedSummaryCount = r.rows.filter(row => excludedMonthlyRowIds.has(row.rowId)).length
              const activeCount = isTripSheetExcluded
                ? 0
                : r.rows.filter(row => dateDecisions[row.rowId] !== 'skip' && !excludedMonthlyRowIds.has(row.rowId)).length
              const linkedTrip = r.sheet.kind === 'trip' && tripIdMap[r.sheet.name]
                ? existingTrips.find(t => t.id === tripIdMap[r.sheet.name])
                : null
              const newTripMeta = r.sheet.kind === 'trip' && !linkedTrip ? getResolvedTripMeta(r) : null
              return (
                <div key={r.sheet.name} className="flex items-center justify-between py-2.5 border-b border-[var(--border)] last:border-0">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span>{r.sheet.kind === 'trip' ? '✈️' : '📅'}</span>
                      <span className="text-sm text-[var(--text-primary)]">{r.sheet.name}</span>
                    </div>
                    {excludedSummaryCount > 0 && (
                      <p className="mt-0.5 pl-6 text-xs text-[var(--text-muted)]">
                        Skipped {excludedSummaryCount} trip summary row{excludedSummaryCount === 1 ? '' : 's'} (replaced by detailed trip sheet)
                      </p>
                    )}
                    {linkedTrip && activeCount > 0 && (
                      <p className="mt-0.5 pl-6 text-xs text-[var(--primary)]">
                        Linked to existing trip: <strong>{linkedTrip.name}</strong>
                      </p>
                    )}
                    {newTripMeta && activeCount > 0 && (
                      <p className="mt-0.5 pl-6 text-xs text-[var(--primary)]">
                        Will create trip: <strong>{newTripMeta.name}</strong> ({newTripMeta.startDate} → {newTripMeta.endDate})
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 text-sm font-semibold text-[var(--text-primary)]">{activeCount} rows</span>
                </div>
              )
            })}
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

          <button onClick={handleImport}
            className="flex items-center justify-center gap-2 rounded-xl bg-[var(--success)] py-3.5 text-sm font-semibold text-white">
            <CheckCircle2 className="h-4 w-4" />
            {hasFrozenPlan ? 'Resume saved import safely' : `Import ${totalRows} Transactions`}
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
              {result.imported.toLocaleString()} transactions imported · {result.alreadyCommitted.toLocaleString()} already committed
              {result.tripsCreated > 0 ? ` · ${result.tripsCreated} trip${result.tripsCreated === 1 ? '' : 's'} created` : ''}
              {result.skipped > 0 ? ` · ${result.skipped} skipped` : ''}
            </p>
          </div>
          <div className={`grid gap-3 w-full max-w-sm ${result.tripsCreated > 0 ? 'grid-cols-3' : 'grid-cols-2'}`}>
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-center">
              <p className="text-2xl font-bold text-[var(--success)]">{result.imported.toLocaleString()}</p>
              <p className="text-xs text-[var(--text-muted)]">Imported</p>
            </div>
            {result.tripsCreated > 0 && (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-center">
                <p className="text-2xl font-bold text-[var(--primary)]">{result.tripsCreated}</p>
                <p className="text-xs text-[var(--text-muted)]">Trips Created</p>
              </div>
            )}
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-center">
              <p className="text-2xl font-bold text-[var(--text-muted)]">{result.skipped}</p>
              <p className="text-xs text-[var(--text-muted)]">Skipped</p>
            </div>
          </div>
          <div className="flex flex-col gap-3 w-full">
            <div className="rounded-xl bg-[var(--primary-muted)] px-4 py-3 text-xs text-[var(--text-muted)]">
              📌 All imported transactions are marked <code className="rounded bg-[var(--surface)] px-1">isImported: true</code> with <code className="rounded bg-[var(--surface)] px-1">paymentMode: "Other"</code>. You can filter these in Transactions to update categories or tags over time.
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              {result.tripsCreated > 0 && (
                <button onClick={() => navigate('/app/trips')}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] py-3.5 text-sm font-semibold text-[var(--text-primary)] hover:bg-[var(--surface-2)]">
                  <MapIcon className="h-4 w-4 text-[var(--primary)]" /> View Trips
                </button>
              )}
              <button onClick={() => navigate('/app')}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3.5 text-sm font-semibold text-white">
                <Home className="h-4 w-4" /> View Dashboard
              </button>
            </div>
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
            <ThemedSelect
              size="xs"
              align="end"
              value=""
              placeholder="Bulk assign all →"
              onChange={val => { if (val) rows.forEach(r => onOverride(r.description, val)) }}
              options={[
                { value: '', label: 'Bulk assign all →' },
                ...categories.map(c => ({ value: c.id, label: c.name })),
              ]}
              className="bg-[var(--surface)]"
            />
          </div>
          <div className="divide-y divide-[var(--border)]">
            {rows.slice(0, 12).map((row, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <p className="flex-1 truncate text-sm text-[var(--text-primary)]">{row.description}</p>
                <ThemedSelect
                  size="xs"
                  align="end"
                  value={catOverrides[row.description.toLowerCase()] ?? ''}
                  onChange={val => onOverride(row.description, val)}
                  options={[
                    { value: '', label: `Auto: ${row.suggestedCategoryName ?? '?'}` },
                    ...categories.map(c => ({ value: c.id, label: c.name })),
                  ]}
                  className="shrink-0"
                />
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

// ─── Date Review Sub-components ───────────────────────────────────────────────

interface DateReviewProps {
  flaggedRows: ParsedRow[]
  unresolvedCount: number
  decisions: Record<string, 'import-anyway' | 'skip'>
  showAll: boolean
  onToggleShowAll: () => void
  onFix: (rowIds: string[], newDate: string) => void
  onDecide: (rowIds: string[], decision: 'import-anyway' | 'skip' | null) => void
  error: string | null
}

const FLAGGED_PAGE_SIZE = 50

function DateReviewPanel({
  flaggedRows, unresolvedCount, decisions, showAll, onToggleShowAll, onFix, onDecide, error,
}: DateReviewProps) {
  if (flaggedRows.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--success-muted)] px-4 py-3 text-xs font-medium text-[var(--success)]">
        <CheckCircle2 className="h-4 w-4 shrink-0" /> All dates look valid — none are unparseable or in the future.
      </div>
    )
  }

  // Unresolved first, then those already handled
  const ordered = [...flaggedRows].sort(
    (a, b) => Number(!!decisions[a.rowId]) - Number(!!decisions[b.rowId])
  )
  const visible = showAll ? ordered : ordered.slice(0, FLAGGED_PAGE_SIZE)

  // Bulk fix groups: unresolved rows that share the exact same original cell text
  const groups = new Map<string, ParsedRow[]>()
  for (const r of flaggedRows) {
    if (decisions[r.rowId]) continue
    const list = groups.get(r.rawDate) ?? []
    list.push(r)
    groups.set(r.rawDate, list)
  }
  const bulkGroups = [...groups.entries()].filter(([, rows]) => rows.length >= 2)

  const allClear = unresolvedCount === 0

  return (
    <div className={`rounded-2xl border bg-[var(--surface)] ${allClear ? 'border-[var(--success)]' : 'border-[var(--warning)]'}`}>
      <div className={`flex items-start gap-2 rounded-t-2xl px-4 py-3 ${allClear ? 'bg-[var(--success-muted)]' : 'bg-[var(--warning-muted)]'}`}>
        {allClear
          ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" />
          : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />}
        <div>
          <p className={`text-sm font-semibold ${allClear ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>
            {allClear
              ? 'All date issues resolved'
              : `${unresolvedCount} row${unresolvedCount === 1 ? '' : 's'} need date correction before import`}
          </p>
          <p className="text-[11px] text-[var(--text-muted)]">
            Pick the correct date for each row. Future dates can be kept deliberately with "Import anyway";
            rows with an unreadable date can be skipped. Import stays locked until the count reaches zero.
          </p>
        </div>
      </div>

      {error && (
        <p className="border-b border-[var(--border)] px-4 py-2 text-xs font-medium text-[var(--danger)]">{error}</p>
      )}

      {bulkGroups.length > 0 && (
        <div className="flex flex-col gap-2 border-b border-[var(--border)] px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Bulk fix</p>
          {bulkGroups.map(([raw, rows]) => (
            <BulkDateFix key={raw} rawDate={raw} rows={rows} onApply={onFix} />
          ))}
        </div>
      )}

      <ul className="divide-y divide-[var(--border)]">
        {visible.map(row => {
          const decision = decisions[row.rowId]
          return (
            <li key={row.rowId} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[var(--text-primary)]">{row.description}</p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  {formatINR(row.amountPaise)} · {row.sheetName} ·{' '}
                  <span className="font-semibold text-[var(--warning)]">
                    {row.dateIssue === 'future'
                      ? `future date ${row.dateStr}`
                      : `unreadable date “${row.rawDate}”`}
                  </span>
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <DatePicker
                  size="sm"
                  maxDate={todayISO()}
                  value={row.dateIssue === 'future' ? '' : row.dateStr}
                  onChange={val => onFix([row.rowId], val)}
                  aria-label={`Correct date for ${row.description}`}
                  className="min-w-[138px]"
                />
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--text-muted)]">
                  <input
                    type="checkbox"
                    checked={!!decision}
                    onChange={e =>
                      onDecide([row.rowId], e.target.checked ? (row.dateIssue === 'future' ? 'import-anyway' : 'skip') : null)
                    }
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                  />
                  {row.dateIssue === 'future' ? 'Import anyway' : 'Skip row'}
                </label>
              </div>
            </li>
          )
        })}
      </ul>

      {ordered.length > FLAGGED_PAGE_SIZE && (
        <button
          type="button"
          onClick={onToggleShowAll}
          className="w-full rounded-b-2xl border-t border-[var(--border)] px-4 py-2.5 text-xs font-medium text-[var(--primary)]"
        >
          {showAll ? 'Show fewer' : `Show all ${ordered.length} flagged rows`}
        </button>
      )}
    </div>
  )
}

function BulkDateFix({
  rawDate, rows, onApply,
}: { rawDate: string; rows: ParsedRow[]; onApply: (rowIds: string[], newDate: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--surface-2)] px-3 py-2">
      <p className="text-xs text-[var(--text-primary)]">
        {rows.length} rows share the date “{rawDate || '(blank)'}”
      </p>
      <div className="flex items-center gap-2">
        <DatePicker
          size="sm"
          maxDate={todayISO()}
          value={value}
          onChange={setValue}
          aria-label={`Date for all ${rows.length} rows with “${rawDate}”`}
          className="min-w-[138px] bg-[var(--surface)]"
        />
        <button
          type="button"
          disabled={!value}
          onClick={() => { onApply(rows.map(r => r.rowId), value); setValue('') }}
          className="rounded-lg border border-[var(--primary)] px-2.5 py-1.5 text-xs font-semibold text-[var(--primary)] disabled:opacity-40"
        >
          Apply to all {rows.length}
        </button>
      </div>
    </div>
  )
}
