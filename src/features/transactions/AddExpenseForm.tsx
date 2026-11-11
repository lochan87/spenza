import { Notification } from '@/components/ui/Notification'
import { useNotice } from '@/hooks/useNotice'
import { Fragment, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { format } from 'date-fns'
import { Timestamp } from 'firebase/firestore'
import {
  X, Plus, Check, Loader2, AlertTriangle, Users, UserPlus, Search
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { addTransaction, updateTransaction, getPaymentAccounts, addPaymentAccount, getPastDescriptions } from '@/services/transactions'
import { getTrips } from '@/services/trips'
import { getPeople, getOrCreatePerson } from '@/services/people'
import { getCategoryMeta, resolveCategoryName, DEFAULT_CATEGORY_ORDER } from '@/utils/categoryColors'
import { getPaymentMeta, getAccountTypeMeta } from '@/utils/paymentColors'
import { suggestCategory } from '@/utils/categoryKeywords'
import { getNormalizedSplits } from '@/utils/splitMath'
import { TransactionSchema } from '@/utils/schemas'
import { expenseEditErrorMessage } from '@/utils/expenseEdit'
import { DatePicker } from '@/components/ui/DatePicker'
import { ThemedSelect } from '@/components/ui/ThemedSelect'
import {
  computeFormSplits,
  getInitialSharingState,
  validateRepaymentSafety,
  getRecommendedPreset,
  type SharingMode,
  type SplitPreset,
  type ParticipantInput,
} from './splitFormHelpers'
import type { Transaction, PaymentAccount, Category, PaymentMode, TransactionType, Trip, Person } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

type FormSchema = z.infer<typeof TransactionSchema>

interface AddExpenseFormProps {
  categories: Category[]
  onSuccess: (status?: 'confirmed' | 'pending') => void
  onClose: () => void
  editTransaction?: Transaction | null
}

const PAYMENT_MODES: PaymentMode[] = ['Cash', 'UPI', 'Bank Transfer', 'Card', 'Other']
const ACCOUNT_REQUIRED: PaymentMode[] = ['UPI', 'Bank Transfer', 'Card']
const EXPENSE_TYPES: { value: TransactionType; label: string }[] = [
  { value: 'everyday', label: 'Everyday' },
  { value: 'recurring', label: 'Recurring' },
  { value: 'one-time', label: 'One-time' },
  { value: 'trip', label: 'Trip' },
  { value: 'gift-event', label: 'Gift/Event' },
  { value: 'reimbursable', label: 'Reimburse' },
]

// ─── Helper ───────────────────────────────────────────────────────────────────

function paiseToRupees(paise: number) {
  return (paise / 100).toFixed(2)
}
function rupeesToPaise(rupees: string | number) {
  return Math.round(Number(rupees) * 100)
}

// ─── Main component ───────────────────────────────────────────────────────────

export function AddExpenseForm({
  categories,
  onSuccess,
  onClose,
  editTransaction,
}: AddExpenseFormProps) {
  const { user } = useAuth()
  const amountRef = useRef<HTMLInputElement>(null)

  const [paymentAccounts, setPaymentAccounts] = useState<PaymentAccount[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [showNotes, setShowNotes] = useState(false)
  const [showPerson, setShowPerson] = useState(false)
  const [descSuggestions, setDescSuggestions] = useState<string[]>([])
  const [allDescriptions, setAllDescriptions] = useState<string[]>([])
  const [categorySuggestion, setCategorySuggestion] = useState<string | null>(null)
  const [addingAccount, setAddingAccount] = useState(false)
  const [newAccountName, setNewAccountName] = useState('')
  const [newAccountType, setNewAccountType] = useState<'Bank' | 'UPI' | 'Card' | 'Wallet'>('Bank')
  const { notice, showNotice: showSuccessToast, dismiss } = useNotice()
  useEffect(() => {
    const rejected = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (detail?.uid === user?.uid) showSuccessToast(detail.message, 'error')
    }
    window.addEventListener('spenza_write_rejected', rejected)
    return () => window.removeEventListener('spenza_write_rejected', rejected)
  }, [user?.uid, showSuccessToast])
  const submissionInFlight = useRef(false)
  const [trips, setTrips] = useState<Trip[]>([])

  // ─── People & Split States ──────────────────────────────────────────────────
  const [availablePeople, setAvailablePeople] = useState<Person[]>([])
  const [personSearch, setPersonSearch] = useState('')
  const [addingPerson, setAddingPerson] = useState(false)
  const [newPersonName, setNewPersonName] = useState('')
  const [personActionError, setPersonActionError] = useState<string | null>(null)

  const initialSharing = useMemo(() => {
    return getInitialSharingState(editTransaction)
  }, [editTransaction])

  const [sharingMode, setSharingMode] = useState<SharingMode>(initialSharing.sharingMode)
  const [selectedPeople, setSelectedPeople] = useState<ParticipantInput[]>(initialSharing.initialParticipants)
  const [splitPreset, setSplitPreset] = useState<SplitPreset>(initialSharing.splitPreset)
  const [customMySharePaise, setCustomMySharePaise] = useState<number>(initialSharing.customMySharePaise)
  const [customMyShareInput, setCustomMyShareInput] = useState<string>(
    initialSharing.customMySharePaise > 0 ? paiseToRupees(initialSharing.customMySharePaise) : ''
  )

  const isEditing = !!editTransaction

  const {
    register,
    handleSubmit,
    control,
    watch,
    setValue,
    reset,
    formState: { errors },
  } = useForm<FormSchema>({
    resolver: zodResolver(TransactionSchema) as any,
    defaultValues: isEditing
      ? {
          amountPaise: editTransaction.amountPaise,
          description: editTransaction.description,
          categoryId: editTransaction.categoryId,
          type: editTransaction.type,
          date: format(
            (editTransaction.date as Timestamp).toDate?.() ?? new Date(),
            'yyyy-MM-dd'
          ),
          paymentMode: editTransaction.paymentMode,
          paymentAccountId: editTransaction.paymentAccountId,
          tripId: editTransaction.tripId,
          personId: editTransaction.personId,
          tags: editTransaction.tags ?? [],
          notes: editTransaction.notes ?? '',
          receiptUrl: editTransaction.receiptUrl,
        }
      : {
          amountPaise: 0,
          description: '',
          categoryId: '',
          type: 'everyday',
          date: format(new Date(), 'yyyy-MM-dd'),
          paymentMode: 'Cash',
          paymentAccountId: null,
          tripId: null,
          personId: null,
          tags: [],
          notes: '',
          receiptUrl: null,
        },
  })

  const watchedAmountPaise = watch('amountPaise')
  const watchedPaymentMode = watch('paymentMode')
  const watchedCategoryId = watch('categoryId')
  const watchedDescription = watch('description')
  const watchedType = watch('type')
  const watchedTripId = watch('tripId')
  const watchedDate = watch('date')
  const needsAccount = ACCOUNT_REQUIRED.includes(watchedPaymentMode as PaymentMode)

  // ─── Existing Repayment Preservation Maps ──────────────────────────────────
  const existingRepaidMap = useMemo(() => {
    const map = new Map<string, number>()
    if (!editTransaction) return map
    const splits = getNormalizedSplits(editTransaction)
    for (const s of splits) {
      if (s.repaidPaise > 0) {
        map.set(s.personId, s.repaidPaise)
      }
    }
    return map
  }, [editTransaction])

  const existingSettledAtMap = useMemo(() => {
    const map = new Map<string, any>()
    if (!editTransaction) return map
    const splits = getNormalizedSplits(editTransaction)
    for (const s of splits) {
      if (s.settledAt) {
        map.set(s.personId, s.settledAt)
      }
    }
    return map
  }, [editTransaction])

  // ─── Live Split Allocation Calculation ─────────────────────────────────────
  const formSplitResult = useMemo(() => {
    return computeFormSplits({
      amountPaise: watchedAmountPaise,
      sharingMode,
      splitPreset,
      customMySharePaise,
      participants: selectedPeople,
      existingRepaidMap,
      existingSettledAtMap,
    })
  }, [
    watchedAmountPaise,
    sharingMode,
    splitPreset,
    customMySharePaise,
    selectedPeople,
    existingRepaidMap,
    existingSettledAtMap,
  ])

  // ─── Repayment Safety Audit ────────────────────────────────────────────────
  const repaymentSafety = useMemo(() => {
    return validateRepaymentSafety(
      editTransaction,
      sharingMode,
      new Set(selectedPeople.map(p => p.id)),
      formSplitResult.splits
    )
  }, [editTransaction, sharingMode, selectedPeople, formSplitResult.splits])

  const selectedTripRange = useMemo(() => {
    if (watchedType !== 'trip' || !watchedTripId) return null
    const trip = trips.find(t => t.id === watchedTripId)
    if (!trip) return null
    const startDt = (trip.startDate as Timestamp).toDate?.()
    if (!startDt) return null
    const endDt = trip.endDate ? (trip.endDate as Timestamp).toDate?.() : null
    const startISO = format(startDt, 'yyyy-MM-dd')
    const endISO = endDt ? format(endDt, 'yyyy-MM-dd') : null
    const isOutOfRange =
      watchedDate < startISO || (endISO !== null && watchedDate > endISO)
    return {
      trip,
      startDt,
      endDt,
      startISO,
      endISO,
      isOutOfRange,
    }
  }, [watchedType, watchedTripId, watchedDate, trips])

  // Load payment accounts & trips
  useEffect(() => {
    if (!user) return
    getPaymentAccounts(user.uid).then(setPaymentAccounts)
    getTrips(user.uid).then(t => setTrips(t.filter(trip => !trip.isArchived || trip.id === editTransaction?.tripId)))
  }, [user, editTransaction?.tripId])

  // Load past descriptions
  useEffect(() => {
    if (!user) return
    getPastDescriptions(user.uid).then(setAllDescriptions)
  }, [user])

  // Load people for split selection
  useEffect(() => {
    if (!user) return
    getPeople(user.uid, false).then(setAvailablePeople)
  }, [user])

  // Auto-focus amount on mount
  useEffect(() => {
    amountRef.current?.focus()
    amountRef.current?.select()
  }, [])

  // Auto-open 100% recoverable mode when type is set to reimbursable
  useEffect(() => {
    if (watchedType === 'reimbursable') {
      if (sharingMode === 'none') {
        setSharingMode('fully_recoverable')
      }
    }
  }, [watchedType, sharingMode])

  // Auto-suggest category from description
  useEffect(() => {
    if (!watchedDescription || isEditing) return
    const suggestion = suggestCategory(watchedDescription)
    if (suggestion) {
      const cat = categories.find(
        c => !c.isArchived && resolveCategoryName(c.name) === suggestion
      )
      if (cat && !watchedCategoryId) {
        setCategorySuggestion(cat.name)
      }
    } else {
      setCategorySuggestion(null)
    }
  }, [watchedDescription, categories, watchedCategoryId, isEditing])

  // Picker categories
  const pickerCategories = useMemo(() => {
    const rank = (c: Category) => {
      const idx = DEFAULT_CATEGORY_ORDER.indexOf(resolveCategoryName(c.name))
      return idx === -1 ? Number.MAX_SAFE_INTEGER : idx
    }
    return categories
      .filter(c => !c.isArchived || c.id === editTransaction?.categoryId)
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }, [categories, editTransaction?.categoryId])

  // Description autocomplete
  const handleDescriptionChange = useCallback((value: string) => {
    if (!value || value.length < 2) {
      setDescSuggestions([])
      return
    }
    const lower = value.toLowerCase()
    setDescSuggestions(
      allDescriptions.filter(d => d.toLowerCase().includes(lower)).slice(0, 5)
    )
  }, [allDescriptions])

  // Clear paymentAccountId when mode changes to Cash/Other
  useEffect(() => {
    if (!needsAccount) {
      setValue('paymentAccountId', null)
    }
  }, [needsAccount, setValue])

  // Handle new account inline add
  async function handleAddAccount() {
    if (!user || !newAccountName.trim()) return
    const id = await addPaymentAccount(user.uid, {
      name: newAccountName.trim(),
      type: newAccountType,
      isDefault: false,
      isArchived: false,
    })
    const updated = await getPaymentAccounts(user.uid)
    setPaymentAccounts(updated)
    setValue('paymentAccountId', id)
    setAddingAccount(false)
    setNewAccountName('')
  }

  // ─── People Selection Handlers ──────────────────────────────────────────────
  const handleAddParticipant = useCallback((person: ParticipantInput) => {
    setSelectedPeople(prev => {
      const isDup = prev.some(
        p => p.id === person.id || p.name.trim().toLowerCase() === person.name.trim().toLowerCase()
      )
      if (isDup) return prev
      const next = [...prev, person]
      setSplitPreset(current =>
        current === 'custom_my_share' ? current : getRecommendedPreset(next.length)
      )
      return next
    })
    setPersonActionError(null)
  }, [])

  const handleRemoveParticipant = useCallback((personId: string) => {
    if (isEditing && editTransaction) {
      const initialSplits = getNormalizedSplits(editTransaction)
      const match = initialSplits.find(s => s.personId === personId)
      if (match && match.repaidPaise > 0) {
        setPersonActionError(
          `Cannot remove "${match.personName}": ₹${paiseToRupees(match.repaidPaise)} has already been repaid on their share.`
        )
        return
      }
    }
    setPersonActionError(null)
    setSelectedPeople(prev => {
      const next = prev.filter(p => p.id !== personId)
      setSplitPreset(current =>
        current === 'custom_my_share' ? current : getRecommendedPreset(next.length)
      )
      return next
    })
  }, [isEditing, editTransaction])

  async function handleCreatePersonInline(nameToCreate: string) {
    if (!user) return
    const trimmed = nameToCreate.trim()
    if (!trimmed) return
    setPersonActionError(null)
    try {
      const person = await getOrCreatePerson(user.uid, trimmed)
      setAvailablePeople(prev => {
        if (prev.some(p => p.id === person.id)) return prev
        return [...prev, person].sort((a, b) => a.name.localeCompare(b.name))
      })
      handleAddParticipant({ id: person.id, name: person.name })
      setPersonSearch('')
      setNewPersonName('')
      setAddingPerson(false)
    } catch (err: any) {
      console.error('[Spenza] Error creating person:', err)
      setPersonActionError(err?.message || 'Failed to add person')
    }
  }

  function handleModeChange(newMode: SharingMode) {
    if (newMode === 'none' && isEditing && editTransaction) {
      const initialSplits = getNormalizedSplits(editTransaction)
      const totalRepaid = initialSplits.reduce((acc, s) => acc + s.repaidPaise, 0)
      if (totalRepaid > 0) {
        setPersonActionError(
          `Cannot switch to Personal: ₹${paiseToRupees(totalRepaid)} has already been repaid. Remove or refund recorded repayments before unsharing.`
        )
        return
      }
    }
    setPersonActionError(null)
    setSharingMode(newMode)
  }

  function handleCustomMyShareChange(rupeesStr: string) {
    setCustomMyShareInput(rupeesStr)
    const raw = rupeesStr.replace(/[^0-9.]/g, '')
    setCustomMySharePaise(rupeesToPaise(raw))
  }

  const filteredAvailablePeople = useMemo(() => {
    if (!personSearch.trim()) return availablePeople
    const q = personSearch.toLowerCase().trim()
    return availablePeople.filter(p => p.name.toLowerCase().includes(q))
  }, [availablePeople, personSearch])

  // ─── Submission ─────────────────────────────────────────────────────────────
  const onSubmit = async (data: Record<string, any>) => {
    if (!user || submissionInFlight.current) return

    if (!repaymentSafety.canSave) {
      return
    }

    if (sharingMode !== 'none' && formSplitResult.error) {
      return
    }

    submissionInFlight.current = true
    setSubmitting(true)
    setSubmitError(null)
    try {
      const payload: Record<string, any> = {
        amountPaise: data.amountPaise,
        description: data.description,
        categoryId: data.categoryId,
        type: data.type as TransactionType,
        date: editTransaction && data.date === format(editTransaction.date.toDate(), 'yyyy-MM-dd')
          ? editTransaction.date
          : Timestamp.fromDate(new Date(data.date)),
        paymentMode: data.paymentMode as PaymentMode,
        paymentAccountId: data.paymentAccountId,
        tripId: data.tripId ?? null,
        tags: data.tags ?? [],
        notes: data.notes ?? '',
        receiptUrl: data.receiptUrl ?? null,
      }

      if (sharingMode === 'none') {
        payload.recoverablePaise = 0
        payload.splits = []
        payload.reimbursementStatus = 'none'
        payload.personId = data.personId ?? null
      } else {
        payload.recoverablePaise = formSplitResult.recoverablePaise
        payload.splits = formSplitResult.splits
        payload.reimbursementStatus = formSplitResult.reimbursementStatus
        payload.personId =
          formSplitResult.splits.length === 1 ? formSplitResult.splits[0].personId : null
      }

      let status: 'confirmed' | 'pending' = 'confirmed'
      if (isEditing && editTransaction) {
        await updateTransaction(user.uid, editTransaction.id, payload, editTransaction)
        showSuccessToast('Expense updated ✓')
      } else {
        const result = await addTransaction(user.uid, payload as any)
        status = result.status
        showSuccessToast(result.status === 'confirmed' ? 'Expense added ✓' : 'Expense pending sync — not yet confirmed saved. Do not enter it again.', result.status === 'confirmed' ? 'success' : 'warning')
      }
      onSuccess(status)
      if (!isEditing) {
        reset({
          amountPaise: 0,
          description: '',
          categoryId: '',
          type: 'everyday',
          date: format(new Date(), 'yyyy-MM-dd'),
          paymentMode: data.paymentMode,
          paymentAccountId: data.paymentAccountId,
          tripId: null,
          personId: null,
          tags: [],
          notes: '',
          receiptUrl: null,
        })
        setSharingMode('none')
        setSelectedPeople([])
        setSplitPreset('equal_2')
        setCustomMySharePaise(0)
        setCustomMyShareInput('')
        setPersonSearch('')
        setPersonActionError(null)
        amountRef.current?.focus()
      }
    } catch (err) {
      console.error('[Spenza] Submit error:', err)
      setSubmitError(isEditing ? expenseEditErrorMessage(err) : 'Could not save this expense. Please try again.')
    } finally {
      submissionInFlight.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <Notification notice={notice} onDismiss={dismiss} />
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">
          {isEditing ? 'Edit Expense' : 'Add Expense'}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close expense form"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Form */}
      <form
        id="add-expense-form"
        onSubmit={handleSubmit(onSubmit)}
        className="flex flex-1 flex-col gap-5 overflow-y-auto p-5 scrollbar-thin"
      >
        {submitError && (
          <div role="alert" className="rounded-xl border border-[var(--danger)] bg-[var(--danger-muted)] p-3 text-sm text-[var(--danger)]">
            {submitError}
          </div>
        )}
        {/* Amount */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
            Amount (₹)
          </label>
          <div className="relative flex items-center">
            <span className="absolute left-4 text-xl font-semibold text-[var(--text-muted)]">₹</span>
            <Controller
              name="amountPaise"
              control={control}
              render={({ field }) => (
                <input
                  ref={amountRef}
                  id="amount-input"
                  inputMode="decimal"
                  placeholder="0.00"
                  className={`w-full rounded-xl border bg-[var(--surface-2)] pl-9 pr-4 py-3.5 text-2xl font-bold text-[var(--text-primary)] outline-none transition-all placeholder:text-[var(--text-subtle)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary-muted)] ${
                    errors.amountPaise ? 'border-[var(--danger)]' : 'border-[var(--border)]'
                  }`}
                  value={field.value === 0 ? '' : paiseToRupees(field.value)}
                  onChange={e => {
                    const raw = e.target.value.replace(/[^0-9.]/g, '')
                    field.onChange(rupeesToPaise(raw))
                  }}
                />
              )}
            />
          </div>
          {/* Quick amount chips */}
          <div className="mt-2 flex gap-2">
            {[20, 50, 100, 200, 500].map(amt => (
              <button
                key={amt}
                type="button"
                onClick={() => {
                  const current = watch('amountPaise')
                  setValue('amountPaise', current + rupeesToPaise(amt))
                }}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1 text-xs font-medium text-[var(--text-muted)] transition-all hover:border-[var(--primary)] hover:text-[var(--primary)]"
              >
                +₹{amt}
              </button>
            ))}
          </div>
          {errors.amountPaise && (
            <p className="mt-1 text-xs text-[var(--danger)]">{errors.amountPaise.message}</p>
          )}
        </div>

        {/* Description */}
        <div className="relative">
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
            Description
          </label>
          <input
            id="description-input"
            {...register('description', {
              onChange: e => handleDescriptionChange(e.target.value),
            })}
            placeholder="e.g. Swiggy dinner, Auto to office"
            autoComplete="off"
            className={`w-full rounded-xl border bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text-primary)] outline-none transition-all placeholder:text-[var(--text-subtle)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary-muted)] ${
              errors.description ? 'border-[var(--danger)]' : 'border-[var(--border)]'
            }`}
          />
          {/* Autocomplete dropdown */}
          {descSuggestions.length > 0 && (
            <div className="absolute left-0 right-0 z-20 mt-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-md)] overflow-hidden">
              {descSuggestions.map((s, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setValue('description', s)
                    setDescSuggestions([])
                  }}
                  className="flex w-full items-center px-4 py-2.5 text-sm text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {/* Smart category suggestion */}
          {categorySuggestion && !watchedCategoryId && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-[var(--text-muted)]">Suggested category:</span>
              <button
                type="button"
                onClick={() => {
                  const cat = categories.find(c => c.name === categorySuggestion)
                  if (cat) setValue('categoryId', cat.id)
                  setCategorySuggestion(null)
                }}
                className="flex items-center gap-1.5 rounded-full border border-[var(--primary-muted)] bg-[var(--primary-muted)] px-2.5 py-0.5 text-xs font-medium text-[var(--primary)] transition-all hover:opacity-80"
              >
                <span>{getCategoryMeta(categorySuggestion).emoji}</span>
                <span>{categorySuggestion}</span>
              </button>
            </div>
          )}
          {errors.description && (
            <p className="mt-1 text-xs text-[var(--danger)]">{errors.description.message}</p>
          )}
        </div>

        {/* Category picker */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
            Category
          </label>
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-6">
            {pickerCategories.map(cat => {
              const catName = cat.name
              const meta = getCategoryMeta(catName)
              const selected = watchedCategoryId === cat.id
              return (
                <button
                  key={cat.id}
                  type="button"
                  id={`cat-${cat.id}`}
                  onClick={() => {
                    setValue('categoryId', cat.id)
                    setCategorySuggestion(null)
                  }}
                  title={catName}
                  className={`flex min-h-[4.25rem] flex-col items-center gap-1 rounded-xl border px-1 py-2 text-xs transition-all ${
                    selected
                      ? 'border-transparent shadow-[var(--shadow-sm)]'
                      : 'border-[var(--border)] hover:border-[var(--border-strong)]'
                  }`}
                  style={
                    selected
                      ? { backgroundColor: meta.color + '22', borderColor: meta.color + '66' }
                      : {}
                  }
                >
                  <span className="text-lg">{meta.emoji}</span>
                  <span
                    className="w-full break-words text-center leading-tight [hyphens:auto]"
                    style={{ fontSize: '10px', color: selected ? meta.color : 'var(--text-muted)' }}
                  >
                    {catName.split('/').map((part, i) => (
                      <Fragment key={i}>
                        {i > 0 && (
                          <>
                            /<wbr />
                          </>
                        )}
                        {part}
                      </Fragment>
                    ))}
                  </span>
                </button>
              )
            })}
          </div>
          {errors.categoryId && (
            <p className="mt-1 text-xs text-[var(--danger)]">{errors.categoryId.message}</p>
          )}
        </div>

        {/* Date */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Date</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setValue('date', format(new Date(), 'yyyy-MM-dd'))}
              className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                watch('date') === format(new Date(), 'yyyy-MM-dd')
                  ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)]'
                  : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]'
              }`}
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => {
                const y = new Date()
                y.setDate(y.getDate() - 1)
                setValue('date', format(y, 'yyyy-MM-dd'))
              }}
              className={`rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                watch('date') === format(new Date(Date.now() - 86400000), 'yyyy-MM-dd')
                  ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)]'
                  : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]'
              }`}
            >
              Yesterday
            </button>
            <DatePicker
              id="date-input"
              size="sm"
              value={watch('date')}
              onChange={val => setValue('date', val, { shouldValidate: true })}
              className="flex-1 py-2"
              aria-label="Expense date"
            />
          </div>
        </div>

        {/* Payment Mode */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
            Payment Mode
          </label>
          <div className="flex flex-wrap gap-2">
            {PAYMENT_MODES.map(mode => {
              const meta = getPaymentMeta(mode)
              const selected = watchedPaymentMode === mode
              return (
                <button
                  key={mode}
                  type="button"
                  id={`mode-${mode.replace(' ', '-').toLowerCase()}`}
                  onClick={() => setValue('paymentMode', mode)}
                  className="rounded-full border px-4 py-1.5 text-sm font-medium transition-all"
                  style={
                    selected
                      ? {
                          backgroundColor: meta.bgColor,
                          borderColor: meta.color + '80',
                          color: meta.color,
                        }
                      : {
                          backgroundColor: 'transparent',
                          borderColor: 'var(--border)',
                          color: 'var(--text-muted)',
                        }
                  }
                >
                  {mode}
                </button>
              )
            })}
          </div>
        </div>

        {/* Payment Account — conditional */}
        {needsAccount && (
          <div className="animate-in slide-in-from-top-2 duration-200">
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
              Payment Account
              <span className="ml-1 text-[var(--danger)]">*</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {paymentAccounts
                .filter(acc => !acc.isArchived || acc.id === editTransaction?.paymentAccountId)
                .filter(acc => {
                  if (watchedPaymentMode === 'UPI') return acc.type === 'UPI'
                  if (watchedPaymentMode === 'Card') return acc.type === 'Card'
                  if (watchedPaymentMode === 'Bank Transfer') return acc.type === 'Bank'
                  return true
                })
                .map(acc => {
                  const meta = getAccountTypeMeta(acc.type)
                  const selected = watch('paymentAccountId') === acc.id
                  return (
                    <button
                      key={acc.id}
                      type="button"
                      id={`acc-${acc.id}`}
                      onClick={() => setValue('paymentAccountId', acc.id)}
                      className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-all"
                      style={
                        selected
                          ? {
                              backgroundColor: meta.bgColor,
                              borderColor: meta.color + '80',
                              color: meta.color,
                            }
                          : {
                              backgroundColor: 'transparent',
                              borderColor: 'var(--border)',
                              color: 'var(--text-muted)',
                            }
                      }
                    >
                      {selected && <Check className="h-3 w-3" />}
                      {acc.name}
                    </button>
                  )
                })}

              {/* Inline add account */}
              {!addingAccount ? (
                <button
                  type="button"
                  onClick={() => setAddingAccount(true)}
                  className="flex items-center gap-1.5 rounded-full border border-dashed border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-muted)] transition-all hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add account
                </button>
              ) : (
                <div className="flex w-full items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
                  <input
                    autoFocus
                    placeholder="Account name"
                    value={newAccountName}
                    onChange={e => setNewAccountName(e.target.value)}
                    className="flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-subtle)]"
                    onKeyDown={e => e.key === 'Enter' && handleAddAccount()}
                  />
                  <ThemedSelect
                    size="xs"
                    value={newAccountType}
                    onChange={val => setNewAccountType(val as typeof newAccountType)}
                    options={[
                      { value: 'Bank', label: 'Bank' },
                      { value: 'UPI', label: 'UPI' },
                      { value: 'Card', label: 'Card' },
                      { value: 'Wallet', label: 'Wallet' },
                    ]}
                    className="bg-[var(--surface)]"
                  />
                  <button
                    type="button"
                    onClick={handleAddAccount}
                    className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-white"
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    onClick={() => setAddingAccount(false)}
                    className="rounded-lg px-2 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
            {errors.paymentAccountId && (
              <p className="mt-1 text-xs text-[var(--danger)]">{errors.paymentAccountId.message}</p>
            )}
          </div>
        )}

        {/* Expense Type */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
            Expense Type
          </label>
          <div className="flex flex-wrap gap-2">
            {EXPENSE_TYPES.map(({ value, label }) => {
              const selected = watchedType === value
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setValue('type', value)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                    selected
                      ? `badge-${value} border-transparent`
                      : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]'
                  }`}
                >
                  {label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Trip selector — appears when type = 'trip' */}
        {watchedType === 'trip' && (
          <div className="animate-in slide-in-from-top-2 duration-200">
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
              Link to Trip
            </label>
            {trips.length === 0 ? (
              <p className="text-xs text-[var(--text-subtle)]">
                No trips yet — create one from the Trips tab first.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setValue('tripId', null)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                    !watch('tripId')
                      ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)]'
                      : 'border-[var(--border)] text-[var(--text-muted)]'
                  }`}
                >
                  No trip
                </button>
                {trips.map(trip => (
                  <button
                    key={trip.id}
                    type="button"
                    onClick={() => setValue('tripId', trip.id)}
                    className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                      watch('tripId') === trip.id
                        ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)]'
                        : 'border-[var(--border)] text-[var(--text-muted)]'
                    }`}
                  >
                    <span>{trip.coverEmoji}</span>
                    {trip.name}
                  </button>
                ))}
              </div>
            )}
            {selectedTripRange?.isOutOfRange && (
              <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning-muted)] px-3 py-2 text-xs">
                <span className="flex items-center gap-1.5 text-[var(--warning)]">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    Expense date ({watchedDate}) is outside{' '}
                    <strong>{selectedTripRange.trip.name}</strong> (
                    {format(selectedTripRange.startDt, 'd MMM')}
                    {selectedTripRange.endDt
                      ? ` – ${format(selectedTripRange.endDt, 'd MMM yyyy')}`
                      : ` ${format(selectedTripRange.startDt, 'yyyy')}`}
                    ).
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setValue('date', selectedTripRange.startISO, { shouldValidate: true })
                  }
                  className="shrink-0 rounded-lg border border-[var(--warning)] bg-[var(--surface)] px-2.5 py-1 text-[11px] font-semibold text-[var(--warning)] hover:opacity-90"
                >
                  Set to {format(selectedTripRange.startDt, 'd MMM yyyy')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ─── Split Bill / Recover Money Section ──────────────────────────── */}
        <div>
          {sharingMode === 'none' ? (
            <div className="rounded-xl border border-dashed border-[var(--border)] p-3 transition-colors hover:border-[var(--border-strong)]">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[var(--primary)]">
                    <Users className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-[var(--text-primary)]">
                      Split bill / Recover money
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)]">
                      Shared expense or recoverable from others
                    </div>
                  </div>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <button
                    type="button"
                    id="enable-shared-btn"
                    onClick={() => handleModeChange('shared')}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--primary)] hover:text-[var(--primary)] transition-all"
                  >
                    Split bill
                  </button>
                  <button
                    type="button"
                    id="enable-recoverable-btn"
                    onClick={() => handleModeChange('fully_recoverable')}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--text-primary)] hover:border-[var(--primary)] hover:text-[var(--primary)] transition-all"
                  >
                    100% Recoverable
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-[var(--primary)]/30 bg-[var(--surface-2)] p-4 space-y-4 animate-in fade-in-50 duration-200">
              {/* Header with Mode switcher & Close */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-3">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-[var(--primary)]" />
                  <span className="text-xs font-bold uppercase tracking-wider text-[var(--primary)]">
                    Expense Sharing
                  </span>
                </div>

                {/* Mode pills */}
                <div className="flex items-center gap-1 rounded-xl bg-[var(--surface)] p-1 border border-[var(--border)]">
                  <button
                    type="button"
                    id="mode-pill-shared"
                    onClick={() => handleModeChange('shared')}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                      sharingMode === 'shared'
                        ? 'bg-[var(--primary)] text-white shadow-xs'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    Shared (Split)
                  </button>
                  <button
                    type="button"
                    id="mode-pill-recoverable"
                    onClick={() => handleModeChange('fully_recoverable')}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                      sharingMode === 'fully_recoverable'
                        ? 'bg-[var(--primary)] text-white shadow-xs'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    100% Recoverable
                  </button>
                  <button
                    type="button"
                    id="disable-sharing-btn"
                    onClick={() => handleModeChange('none')}
                    className="rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--danger-muted)] hover:text-[var(--danger)] transition-colors"
                    title="Remove sharing (make personal)"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* Explanatory note */}
              <div className="rounded-xl bg-[var(--surface)] p-2.5 text-[11px] text-[var(--text-muted)] border border-[var(--border)] leading-relaxed">
                Total bill paid: <strong className="text-[var(--text-primary)]">₹{paiseToRupees(watchedAmountPaise)}</strong> (full amount paid by you).
                {sharingMode === 'shared' ? (
                  <span> Your net spend is calculated automatically after subtracting recoverable shares.</span>
                ) : (
                  <span> 100% of this expense will be tracked as owed back by selected participants.</span>
                )}
              </div>

              {/* Selected people chips */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
                  Participants ({selectedPeople.length})
                </label>
                {selectedPeople.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedPeople.map(p => {
                      const repaid = existingRepaidMap.get(p.id) ?? 0
                      return (
                        <span
                          key={p.id}
                          className="flex items-center gap-1.5 rounded-full border border-[var(--primary)] bg-[var(--primary-muted)] px-3 py-1 text-xs font-medium text-[var(--primary)]"
                        >
                          <span>{p.name}</span>
                          {repaid > 0 && (
                            <span className="text-[10px] bg-[var(--surface)] px-1.5 py-0.2 rounded-full text-[var(--success)] font-semibold">
                              ₹{paiseToRupees(repaid)} paid
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => handleRemoveParticipant(p.id)}
                            className="flex h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-[var(--primary)]/20 transition-colors"
                            aria-label={`Remove ${p.name}`}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-[var(--text-subtle)]">
                    No participants selected yet. Choose friends below or add a new person.
                  </p>
                )}
              </div>

              {/* Search & Select People */}
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--text-muted)]" />
                  <input
                    value={personSearch}
                    onChange={e => setPersonSearch(e.target.value)}
                    placeholder="Search or add person…"
                    className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] pl-8 pr-8 py-2 text-xs text-[var(--text-primary)] outline-none transition-all placeholder:text-[var(--text-subtle)] focus:border-[var(--primary)]"
                  />
                  {personSearch && (
                    <button
                      type="button"
                      onClick={() => setPersonSearch('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {/* Inline add button when typed person isn't found */}
                {personSearch.trim() &&
                  !availablePeople.some(
                    p => p.name.toLowerCase() === personSearch.trim().toLowerCase()
                  ) && (
                    <button
                      type="button"
                      onClick={() => handleCreatePersonInline(personSearch.trim())}
                      className="flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--primary)] bg-[var(--primary-muted)] px-3 py-1.5 text-xs font-medium text-[var(--primary)] hover:opacity-90 transition-all"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      Add "{personSearch.trim()}" as new person
                    </button>
                  )}

                {/* Quick-pick list of existing people */}
                {availablePeople.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1">
                    {filteredAvailablePeople.map(person => {
                      const isSelected = selectedPeople.some(p => p.id === person.id)
                      return (
                        <button
                          key={person.id}
                          type="button"
                          onClick={() => {
                            if (isSelected) {
                              handleRemoveParticipant(person.id)
                            } else {
                              handleAddParticipant({ id: person.id, name: person.name })
                            }
                          }}
                          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-all ${
                            isSelected
                              ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)] font-semibold'
                              : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                          }`}
                        >
                          {isSelected && <Check className="h-3 w-3 text-[var(--primary)]" />}
                          <span>{person.name}</span>
                        </button>
                      )
                    })}
                  </div>
                )}

                {/* Add new person manual form toggle */}
                {!addingPerson ? (
                  <button
                    type="button"
                    onClick={() => setAddingPerson(true)}
                    className="flex items-center gap-1 text-xs text-[var(--primary)] hover:underline font-medium pt-1"
                  >
                    <Plus className="h-3 w-3" /> Add new person
                  </button>
                ) : (
                  <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2 mt-1">
                    <input
                      autoFocus
                      placeholder="Person name"
                      value={newPersonName}
                      onChange={e => setNewPersonName(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleCreatePersonInline(newPersonName)}
                      className="flex-1 bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-subtle)]"
                    />
                    <button
                      type="button"
                      onClick={() => handleCreatePersonInline(newPersonName)}
                      className="rounded-lg bg-[var(--primary)] px-2.5 py-1 text-xs font-medium text-white"
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAddingPerson(false)
                        setNewPersonName('')
                      }}
                      className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] px-1"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {personActionError && (
                  <div className="flex items-center gap-1.5 text-xs text-[var(--danger)]">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span>{personActionError}</span>
                  </div>
                )}
              </div>

              {/* Shared mode presets */}
              {sharingMode === 'shared' && (
                <div className="space-y-2 border-t border-[var(--border)] pt-3">
                  <label className="block text-xs font-medium text-[var(--text-muted)]">
                    Split Preset
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setSplitPreset('equal_2')}
                      className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-all ${
                        splitPreset === 'equal_2'
                          ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)] font-semibold'
                          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                      }`}
                    >
                      ÷2 (Me + 1)
                    </button>
                    <button
                      type="button"
                      onClick={() => setSplitPreset('equal_3')}
                      className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-all ${
                        splitPreset === 'equal_3'
                          ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)] font-semibold'
                          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                      }`}
                    >
                      ÷3 (Me + 2)
                    </button>
                    <button
                      type="button"
                      onClick={() => setSplitPreset('equal_4')}
                      className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-all ${
                        splitPreset === 'equal_4'
                          ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)] font-semibold'
                          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                      }`}
                    >
                      ÷4 (Me + 3)
                    </button>
                    <button
                      type="button"
                      onClick={() => setSplitPreset('equal_all')}
                      className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-all ${
                        splitPreset === 'equal_all'
                          ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)] font-semibold'
                          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                      }`}
                    >
                      ÷ All (Equal)
                    </button>
                    <button
                      type="button"
                      onClick={() => setSplitPreset('custom_my_share')}
                      className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-all ${
                        splitPreset === 'custom_my_share'
                          ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)] font-semibold'
                          : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                      }`}
                    >
                      Custom My Share
                    </button>
                  </div>

                  {/* Custom my share input */}
                  {splitPreset === 'custom_my_share' && (
                    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2.5 animate-in fade-in-50 duration-150">
                      <label className="block text-[11px] font-medium text-[var(--text-muted)] mb-1">
                        My personal share (₹)
                      </label>
                      <div className="relative flex items-center">
                        <span className="absolute left-3 text-sm font-semibold text-[var(--text-muted)]">₹</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={customMyShareInput}
                          onChange={e => handleCustomMyShareChange(e.target.value)}
                          placeholder="0.00"
                          className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] pl-7 pr-3 py-1.5 text-sm font-semibold text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
                        />
                      </div>
                      <div className="mt-1 text-[11px] text-[var(--text-subtle)]">
                        Remaining ₹{paiseToRupees(Math.max(0, watchedAmountPaise - customMySharePaise))} will be split equally among the {selectedPeople.length} selected participant(s).
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Live Preview Card */}
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 space-y-2.5">
                <div className="text-xs font-semibold text-[var(--text-primary)] flex items-center justify-between">
                  <span>Live Split Summary</span>
                  <span className="text-[11px] font-normal text-[var(--text-muted)]">
                    Status: <strong className="uppercase text-[var(--primary)]">{formSplitResult.reimbursementStatus}</strong>
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-2 text-center border-y border-[var(--border)] py-2">
                  <div>
                    <div className="text-[10px] text-[var(--text-muted)]">Bill Total</div>
                    <div className="text-xs font-bold text-[var(--text-primary)]">
                      ₹{paiseToRupees(formSplitResult.totalPaise)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[var(--text-muted)]">My Net Spend</div>
                    <div className="text-xs font-bold text-[var(--primary)]">
                      ₹{paiseToRupees(formSplitResult.mySharePaise)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[var(--text-muted)]">Recoverable</div>
                    <div className="text-xs font-bold text-[var(--success)]">
                      ₹{paiseToRupees(formSplitResult.recoverablePaise)}
                    </div>
                  </div>
                </div>

                {/* Per-person shares */}
                {formSplitResult.splits.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <div className="text-[11px] font-medium text-[var(--text-muted)]">Individual Owed Shares:</div>
                    <div className="space-y-1">
                      {formSplitResult.splits.map(s => {
                        const isSettled = s.repaidPaise === s.amountPaise && s.amountPaise > 0
                        return (
                          <div
                            key={s.personId}
                            className="flex items-center justify-between rounded-lg bg-[var(--surface-2)] px-2.5 py-1 text-xs"
                          >
                            <span className="font-medium text-[var(--text-primary)] truncate">
                              {s.personName}
                            </span>
                            <div className="flex items-center gap-2">
                              {s.repaidPaise > 0 && (
                                <span className={`text-[10px] px-1.5 py-0.2 rounded-md ${isSettled ? 'bg-[var(--success-muted)] text-[var(--success)] font-semibold' : 'bg-[var(--surface)] text-[var(--text-muted)]'}`}>
                                  {isSettled ? 'Settled ✓' : `₹${paiseToRupees(s.repaidPaise)} repaid`}
                                </span>
                              )}
                              <span className="font-semibold text-[var(--text-primary)]">
                                ₹{paiseToRupees(s.amountPaise)}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Form Split Calculation Warning / Error */}
              {formSplitResult.error && (
                <div className="flex items-start gap-2 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning-muted)] p-2.5 text-xs text-[var(--warning)]">
                  <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>{formSplitResult.error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Optional: Notes */}
        <div>
          <button
            type="button"
            onClick={() => setShowNotes(v => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            <Plus className={`h-3.5 w-3.5 transition-transform ${showNotes ? 'rotate-45' : ''}`} />
            {showNotes ? 'Hide note' : 'Add note'}
          </button>
          {showNotes && (
            <textarea
              id="notes-input"
              {...register('notes')}
              placeholder="Any extra details…"
              rows={2}
              className="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text-primary)] outline-none transition-all placeholder:text-[var(--text-subtle)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary-muted)]"
            />
          )}
        </div>

        {/* Optional: Person / Event (for personal expenses or legacy reference) */}
        {sharingMode === 'none' && (
          <div>
            <button
              type="button"
              onClick={() => setShowPerson(v => !v)}
              className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <Plus className={`h-3.5 w-3.5 transition-transform ${showPerson ? 'rotate-45' : ''}`} />
              {showPerson ? 'Hide person/event' : 'Link person / event'}
            </button>
            {showPerson && (
              <input
                id="person-input"
                {...register('personId')}
                placeholder="Name or event (e.g. Rahul, Diwali trip)"
                className="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text-primary)] outline-none transition-all placeholder:text-[var(--text-subtle)] focus:border-[var(--primary)]"
              />
            )}
          </div>
        )}
      </form>

      {/* Submit footer */}
      <div className="border-t border-[var(--border)] px-5 py-4">
        {(!repaymentSafety.canSave || (sharingMode !== 'none' && !!formSplitResult.error)) && (
          <div className="mb-2.5 flex items-start gap-2 rounded-xl border border-[var(--danger)]/30 bg-[var(--danger-muted)] p-2.5 text-xs text-[var(--danger)]">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              {!repaymentSafety.canSave &&
                repaymentSafety.conflicts.map((c, i) => <div key={i}>{c}</div>)}
              {sharingMode !== 'none' && formSplitResult.error && (
                <div>{formSplitResult.error}</div>
              )}
            </div>
          </div>
        )}

        <button
          id="submit-expense-btn"
          form="add-expense-form"
          type="submit"
          disabled={
            submitting ||
            !repaymentSafety.canSave ||
            (sharingMode !== 'none' && !!formSplitResult.error)
          }
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3.5 text-sm font-semibold text-white shadow-[var(--shadow-md)] transition-all hover:bg-[var(--primary-hover)] active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          {isEditing ? 'Update Expense' : 'Save Expense'}
        </button>
      </div>
    </div>
  )
}
