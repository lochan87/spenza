import { useEffect, useRef, useState, useCallback } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { format } from 'date-fns'
import { Timestamp } from 'firebase/firestore'
import {
  X, Plus, Check, Loader2
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { addTransaction, updateTransaction, getPaymentAccounts, addPaymentAccount, getPastDescriptions } from '@/services/transactions'
import { getCategoryMeta, DEFAULT_CATEGORY_ORDER } from '@/utils/categoryColors'
import { getPaymentMeta, getAccountTypeMeta } from '@/utils/paymentColors'
import { suggestCategory } from '@/utils/categoryKeywords'
import { TransactionSchema } from '@/utils/schemas'
import type { Transaction, PaymentAccount, Category, PaymentMode, TransactionType } from '@/types'

// ─── Types ────────────────────────────────────────────────────────────────────

type FormSchema = z.infer<typeof TransactionSchema>

interface AddExpenseFormProps {
  categories: Category[]
  onSuccess: () => void
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
  const [showNotes, setShowNotes] = useState(false)
  const [showPerson, setShowPerson] = useState(false)
  const [descSuggestions, setDescSuggestions] = useState<string[]>([])
  const [allDescriptions, setAllDescriptions] = useState<string[]>([])
  const [categorySuggestion, setCategorySuggestion] = useState<string | null>(null)
  const [addingAccount, setAddingAccount] = useState(false)
  const [newAccountName, setNewAccountName] = useState('')
  const [newAccountType, setNewAccountType] = useState<'Bank' | 'UPI' | 'Card' | 'Wallet'>('Bank')
  const [toast, setToast] = useState<string | null>(null)

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

  const watchedPaymentMode = watch('paymentMode')
  const watchedCategoryId = watch('categoryId')
  const watchedDescription = watch('description')
  const watchedType = watch('type')
  const needsAccount = ACCOUNT_REQUIRED.includes(watchedPaymentMode as PaymentMode)

  // Load payment accounts
  useEffect(() => {
    if (!user) return
    getPaymentAccounts(user.uid).then(setPaymentAccounts)
  }, [user])

  // Load past descriptions
  useEffect(() => {
    if (!user) return
    getPastDescriptions(user.uid).then(setAllDescriptions)
  }, [user])

  // Auto-focus amount on mount
  useEffect(() => {
    amountRef.current?.focus()
    amountRef.current?.select()
  }, [])

  // Auto-suggest category from description
  useEffect(() => {
    if (!watchedDescription || isEditing) return
    const suggestion = suggestCategory(watchedDescription)
    if (suggestion) {
      const cat = categories.find(c => c.name === suggestion)
      if (cat && !watchedCategoryId) {
        setCategorySuggestion(cat.name)
      }
    } else {
      setCategorySuggestion(null)
    }
  }, [watchedDescription, categories, watchedCategoryId, isEditing])

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

  const showSuccessToast = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }, [])

  const onSubmit = async (data: Record<string, any>) => {
    if (!user) return
    setSubmitting(true)
    try {
      const payload = {
        amountPaise: data.amountPaise,
        description: data.description,
        categoryId: data.categoryId,
        type: data.type as TransactionType,
        date: Timestamp.fromDate(new Date(data.date)),
        paymentMode: data.paymentMode as PaymentMode,
        paymentAccountId: data.paymentAccountId,
        tripId: data.tripId ?? null,
        personId: data.personId ?? null,
        tags: data.tags ?? [],
        notes: data.notes ?? '',
        receiptUrl: data.receiptUrl ?? null,
      }
      if (isEditing && editTransaction) {
        await updateTransaction(user.uid, editTransaction.id, payload)
        showSuccessToast('Expense updated ✓')
      } else {
        await addTransaction(user.uid, payload)
        showSuccessToast('Expense added ✓')
      }
      onSuccess()
      if (!isEditing) {
        reset({
          amountPaise: 0,
          description: '',
          categoryId: '',
          type: 'everyday',
          date: format(new Date(), 'yyyy-MM-dd'),
          paymentMode: data.paymentMode, // keep last used mode
          paymentAccountId: data.paymentAccountId, // keep last used account
          tripId: null,
          personId: null,
          tags: [],
          notes: '',
          receiptUrl: null,
        })
        amountRef.current?.focus()
      }
    } catch (err) {
      console.error('[Spenza] Submit error:', err)
    } finally {
      setSubmitting(false)
    }
  }


  return (
    <div className="flex h-full flex-col">
      {/* Toast */}
      {toast && (
        <div className="absolute top-4 left-1/2 z-50 -translate-x-1/2 flex items-center gap-2 rounded-xl border border-[var(--success)] bg-[var(--success-muted)] px-4 py-2 text-sm font-medium text-[var(--success)] shadow-[var(--shadow-md)]">
          <Check className="h-4 w-4" /> {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">
          {isEditing ? 'Edit Expense' : 'Add Expense'}
        </h2>
        <button
          onClick={onClose}
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
            {DEFAULT_CATEGORY_ORDER.map(catName => {
              const cat = categories.find(c => c.name === catName)
              if (!cat) return null
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
                  className={`flex flex-col items-center gap-1 rounded-xl border p-2 text-xs transition-all ${
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
                    className="text-center leading-tight"
                    style={{ fontSize: '10px', color: selected ? meta.color : 'var(--text-muted)' }}
                  >
                    {catName.replace(' & ', ' &\n').split('\n')[0]}
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
            <input
              id="date-input"
              type="date"
              {...register('date')}
              className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
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

        {/* Payment Account — conditional, animates in */}
        {needsAccount && (
          <div className="animate-in slide-in-from-top-2 duration-200">
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">
              Payment Account
              <span className="ml-1 text-[var(--danger)]">*</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {paymentAccounts
                .filter(acc => !acc.isArchived)
                .filter(acc => {
                  // Show accounts matching the payment mode type
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
                  <select
                    value={newAccountType}
                    onChange={e => setNewAccountType(e.target.value as typeof newAccountType)}
                    className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--text-muted)]"
                  >
                    <option value="Bank">Bank</option>
                    <option value="UPI">UPI</option>
                    <option value="Card">Card</option>
                    <option value="Wallet">Wallet</option>
                  </select>
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

        {/* Optional: Person / Event */}
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
      </form>

      {/* Submit footer */}
      <div className="border-t border-[var(--border)] px-5 py-4">
        <button
          id="submit-expense-btn"
          form="add-expense-form"
          type="submit"
          disabled={submitting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3.5 text-sm font-semibold text-white shadow-[var(--shadow-md)] transition-all hover:bg-[var(--primary-hover)] active:scale-[0.98] disabled:opacity-60"
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
