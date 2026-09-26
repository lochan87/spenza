import { useState, useEffect, useCallback } from 'react'
import { format } from 'date-fns'
import { Timestamp } from 'firebase/firestore'
import { Plus, Pause, Play, Trash2, RepeatIcon, Loader2, X, Pencil } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useAuth } from '@/hooks/useAuth'
import {
  getRecurringItems, addRecurringItem, updateRecurringItem,
  deleteRecurringItem, formatFrequency, computeNextDueDate,
} from '@/services/recurring'
import { getCategories, getPaymentAccounts } from '@/services/transactions'
import { formatINR } from '@/utils/format'
import { getCategoryMeta } from '@/utils/categoryColors'
import { getPaymentMeta } from '@/utils/paymentColors'
import { Drawer } from '@/components/layout/Drawer'
import { SkeletonCard } from '@/features/dashboard/components/SkeletonCard'
import type { RecurringItem, Category, PaymentAccount, PaymentMode, RecurringFrequency } from '@/types'

const RecurringSchema = z.object({
  description: z.string().min(1, 'Description required'),
  amountRupees: z.number().min(1, 'Amount required'),
  categoryId: z.string().min(1, 'Category required'),
  frequency: z.enum(['weekly', 'monthly', 'yearly']),
  dayOfMonth: z.number().min(1).max(28).nullable(),
  dayOfWeek: z.number().min(0).max(6).nullable(),
  paymentMode: z.string(),
  paymentAccountId: z.string().nullable(),
  nextDueDateStr: z.string().min(1, 'Next due date required'),
})

type RecurringForm = z.infer<typeof RecurringSchema>

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const PAYMENT_MODES: PaymentMode[] = ['Cash', 'UPI', 'Bank Transfer', 'Card', 'Other']
const ACCOUNT_MODES: PaymentMode[] = ['UPI', 'Bank Transfer', 'Card']

export function RecurringPage() {
  const { user } = useAuth()
  const [items, setItems] = useState<RecurringItem[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [accounts, setAccounts] = useState<PaymentAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editItem, setEditItem] = useState<RecurringItem | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!user) return
    setLoading(true)
    try {
      const [recItems, cats, accs] = await Promise.all([
        getRecurringItems(user.uid),
        getCategories(user.uid),
        getPaymentAccounts(user.uid),
      ])
      setItems(recItems)
      setCategories(cats)
      setAccounts(accs)
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => { load() }, [load])

  const handleDelete = async (id: string) => {
    if (!user || !confirm('Delete this recurring expense?')) return
    setDeletingId(id)
    try {
      await deleteRecurringItem(user.uid, id)
      setItems(prev => prev.filter(i => i.id !== id))
    } finally {
      setDeletingId(null)
    }
  }

  const handleTogglePause = async (item: RecurringItem) => {
    if (!user) return
    await updateRecurringItem(user.uid, item.id, { isActive: !item.isActive })
    setItems(prev => prev.map(i => i.id === item.id ? { ...i, isActive: !i.isActive } : i))
  }

  const active = items.filter(i => i.isActive)
  const paused = items.filter(i => !i.isActive)

  return (
    <div className="flex flex-col gap-5 pb-20 md:pb-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Recurring</h1>
          <p className="text-sm text-[var(--text-muted)]">{active.length} active</p>
        </div>
        <button
          onClick={() => { setEditItem(null); setDrawerOpen(true) }}
          className="flex items-center gap-1.5 rounded-xl bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white"
        >
          <Plus className="h-4 w-4" /> Add
        </button>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">{[0,1,2].map(i => <SkeletonCard key={i} height="h-20" />)}</div>
      ) : (
        <>
          {active.length === 0 && paused.length === 0 && (
            <div className="flex h-44 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)]">
              <RepeatIcon className="h-8 w-8 text-[var(--text-subtle)]" />
              <p className="text-sm text-[var(--text-muted)]">No recurring expenses yet</p>
            </div>
          )}

          {active.length > 0 && (
            <section>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Active</p>
              <div className="flex flex-col gap-2">
                {active.map(item => (
                  <RecurringRow key={item.id}
                    item={item} categories={categories}
                    onEdit={() => { setEditItem(item); setDrawerOpen(true) }}
                    onToggle={() => handleTogglePause(item)}
                    onDelete={() => handleDelete(item.id)}
                    deleting={deletingId === item.id}
                  />
                ))}
              </div>
            </section>
          )}

          {paused.length > 0 && (
            <section>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Paused</p>
              <div className="flex flex-col gap-2">
                {paused.map(item => (
                  <RecurringRow key={item.id}
                    item={item} categories={categories}
                    onEdit={() => { setEditItem(item); setDrawerOpen(true) }}
                    onToggle={() => handleTogglePause(item)}
                    onDelete={() => handleDelete(item.id)}
                    deleting={deletingId === item.id}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      <Drawer open={drawerOpen} onClose={() => { setDrawerOpen(false); setEditItem(null) }}>
        <RecurringForm
          editItem={editItem}
          categories={categories}
          accounts={accounts}
          onClose={() => { setDrawerOpen(false); setEditItem(null) }}
          onSuccess={() => { setDrawerOpen(false); setEditItem(null); load() }}
          uid={user?.uid ?? ''}
        />
      </Drawer>
    </div>
  )
}

// ── Row component ─────────────────────────────────────────────────────────────

function RecurringRow({
  item, categories, onEdit, onToggle, onDelete, deleting,
}: {
  item: RecurringItem
  categories: Category[]
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
  deleting: boolean
}) {
  const cat = categories.find(c => c.id === item.categoryId)
  const catMeta = getCategoryMeta(cat?.name ?? 'Other')
  const dueDate = (item.nextDueDate as Timestamp).toDate()

  return (
    <div className={`flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 ${!item.isActive ? 'opacity-60' : ''}`}>
      <div className="flex h-10 w-10 items-center justify-center rounded-xl text-xl"
        style={{ backgroundColor: catMeta.color + '18' }}>
        {catMeta.emoji}
      </div>
      <div className="flex-1 min-w-0">
        <p className="truncate text-sm font-medium text-[var(--text-primary)]">{item.description}</p>
        <p className="text-xs text-[var(--text-muted)]">
          {formatFrequency(item)} · next {format(dueDate, 'd MMM yyyy')}
        </p>
      </div>
      <span className="shrink-0 text-sm font-bold text-[var(--text-primary)]">
        {formatINR(item.amountPaise)}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <button onClick={onEdit}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]">
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button onClick={onToggle}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]">
          {item.isActive ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </button>
        <button onClick={onDelete} disabled={deleting}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--danger-muted)] hover:text-[var(--danger)] disabled:opacity-40">
          {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  )
}

// ── Add/Edit Form ─────────────────────────────────────────────────────────────

function RecurringForm({
  editItem, categories, accounts, onClose, onSuccess, uid,
}: {
  editItem: RecurringItem | null
  categories: Category[]
  accounts: PaymentAccount[]
  onClose: () => void
  onSuccess: () => void
  uid: string
}) {
  const [submitting, setSubmitting] = useState(false)

  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<RecurringForm>({
    resolver: zodResolver(RecurringSchema) as any,
    defaultValues: {
      description: editItem?.description ?? '',
      amountRupees: editItem ? editItem.amountPaise / 100 : undefined,
      categoryId: editItem?.categoryId ?? '',
      frequency: editItem?.frequency ?? 'monthly',
      dayOfMonth: editItem?.dayOfMonth ?? new Date().getDate(),
      dayOfWeek: editItem?.dayOfWeek ?? null,
      paymentMode: editItem?.paymentMode ?? 'UPI',
      paymentAccountId: editItem?.paymentAccountId ?? null,
      nextDueDateStr: editItem
        ? format((editItem.nextDueDate as Timestamp).toDate(), 'yyyy-MM-dd')
        : format(new Date(), 'yyyy-MM-dd'),
    },
  })

  const freq = watch('frequency')
  const payMode = watch('paymentMode') as PaymentMode
  const filteredAccounts = accounts.filter(a =>
    (payMode === 'UPI' && a.type === 'UPI') ||
    (payMode === 'Bank Transfer' && a.type === 'Bank') ||
    (payMode === 'Card' && a.type === 'Card')
  )

  const onSubmit = async (data: RecurringForm) => {
    setSubmitting(true)
    try {
      const nextDue = Timestamp.fromDate(new Date(data.nextDueDateStr))
      const payload = {
        description: data.description,
        amountPaise: Math.round(data.amountRupees * 100),
        categoryId: data.categoryId,
        frequency: data.frequency as RecurringFrequency,
        dayOfMonth: data.frequency === 'monthly' ? (data.dayOfMonth ?? null) : null,
        dayOfWeek: data.frequency === 'weekly' ? (data.dayOfWeek ?? null) : null,
        monthDay: null,
        nextDueDate: nextDue,
        lastGeneratedDate: editItem?.lastGeneratedDate ?? null,
        paymentMode: data.paymentMode as PaymentMode,
        paymentAccountId: ACCOUNT_MODES.includes(data.paymentMode as PaymentMode) ? (data.paymentAccountId ?? null) : null,
        isActive: editItem?.isActive ?? true,
      }
      if (editItem) {
        await updateRecurringItem(uid, editItem.id, payload)
      } else {
        await addRecurringItem(uid, payload)
      }
      onSuccess()
    } catch (err) {
      console.error('[Spenza] Recurring save error:', err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">
          {editItem ? 'Edit Recurring' : 'Add Recurring Expense'}
        </h2>
        <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]">
          <X className="h-4 w-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
        {/* Description */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Description *</label>
          <input {...register('description')} placeholder="Jio Recharge, Netflix…"
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)]" />
          {errors.description && <p className="mt-1 text-xs text-[var(--danger)]">{errors.description.message}</p>}
        </div>

        {/* Amount */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Amount (₹) *</label>
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 font-semibold text-[var(--text-muted)]">₹</span>
            <input type="number" step="0.01" min="0"
              {...register('amountRupees', { valueAsNumber: true })}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] pl-9 pr-4 py-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)]" />
          </div>
          {errors.amountRupees && <p className="mt-1 text-xs text-[var(--danger)]">{errors.amountRupees.message}</p>}
        </div>

        {/* Category */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Category *</label>
          <select {...register('categoryId')}
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)]">
            <option value="">Select category</option>
            {categories.filter(c => !c.isArchived).map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        {/* Frequency */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Frequency *</label>
          <div className="grid grid-cols-3 gap-2">
            {(['weekly', 'monthly', 'yearly'] as RecurringFrequency[]).map(f => (
              <button key={f} type="button"
                onClick={() => setValue('frequency', f)}
                className={`rounded-xl border py-2.5 text-sm font-medium capitalize transition-all ${freq === f ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)]' : 'border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)]'}`}>
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* Day of month (monthly) / Day of week (weekly) */}
        {freq === 'monthly' && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Day of Month</label>
            <input type="number" min="1" max="28"
              {...register('dayOfMonth', { valueAsNumber: true })}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)]" />
          </div>
        )}
        {freq === 'weekly' && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Day of Week</label>
            <div className="grid grid-cols-7 gap-1">
              {DAYS_OF_WEEK.map((d, i) => (
                <button key={d} type="button"
                  onClick={() => setValue('dayOfWeek', i)}
                  className={`rounded-lg py-2 text-[11px] font-medium transition-all ${watch('dayOfWeek') === i ? 'bg-[var(--primary)] text-white' : 'bg-[var(--surface-2)] text-[var(--text-muted)] hover:bg-[var(--surface-3)]'}`}>
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Next due date */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Next Due Date *</label>
          <input type="date" {...register('nextDueDateStr')}
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)]" />
        </div>

        {/* Payment mode */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Payment Mode</label>
          <div className="flex flex-wrap gap-2">
            {PAYMENT_MODES.map(m => (
              <button key={m} type="button"
                onClick={() => setValue('paymentMode', m)}
                className={`rounded-xl border px-3 py-1.5 text-xs font-medium transition-all ${payMode === m ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)]' : 'border-[var(--border)] text-[var(--text-muted)]'}`}>
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Account (if mode requires it) */}
        {ACCOUNT_MODES.includes(payMode) && filteredAccounts.length > 0 && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Account</label>
            <select {...register('paymentAccountId')}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)]">
              <option value="">Select account</option>
              {filteredAccounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}

        {/* Submit */}
        <button type="submit" disabled={submitting}
          className="mt-auto flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3.5 text-sm font-semibold text-white disabled:opacity-60">
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RepeatIcon className="h-4 w-4" />}
          {editItem ? 'Save Changes' : 'Add Recurring'}
        </button>
      </form>
    </div>
  )
}
