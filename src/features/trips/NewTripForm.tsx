import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { format } from 'date-fns'
import { Timestamp } from 'firebase/firestore'
import { X, Loader2, Map } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { addTrip, updateTrip } from '@/services/trips'
import { TRIP_ACCENT_COLOR } from '@/utils/tripBuckets'
import type { Trip } from '@/types'

const TripSchema = z.object({
  name: z.string().min(1, 'Trip name required'),
  startDate: z.string().min(1, 'Start date required'),
  endDate: z.string().optional(),
  coverEmoji: z.string().default('✈️'),
  budgetPaise: z.number().min(0).nullable(),
  notes: z.string().optional(),
})

type TripForm = z.infer<typeof TripSchema>

const TRIP_EMOJIS = ['✈️', '🏖️', '🏔️', '🏕️', '🚂', '🚢', '🏙️', '🌴', '🗺️', '🎡']
const TRIP_COLORS = [
  '#06B6D4', '#3B82F6', '#8B5CF6', '#F59E0B',
  '#14B8A6', '#EC4899', '#F43F5E', '#10B981',
]

interface NewTripFormProps {
  onSuccess: (tripId: string) => void
  onClose: () => void
  editTrip?: Trip | null
}

export function NewTripForm({ onSuccess, onClose, editTrip }: NewTripFormProps) {
  const { user } = useAuth()
  const [submitting, setSubmitting] = useState(false)
  const [pickedColor, setPickedColor] = useState(editTrip?.coverColor ?? TRIP_ACCENT_COLOR)

  const { register, handleSubmit, watch, setValue, formState: { errors } } = useForm<TripForm>({
    resolver: zodResolver(TripSchema) as any,
    defaultValues: {
      name: editTrip?.name ?? '',
      startDate: editTrip?.startDate
        ? format((editTrip.startDate as Timestamp).toDate(), 'yyyy-MM-dd')
        : format(new Date(), 'yyyy-MM-dd'),
      endDate: editTrip?.endDate
        ? format((editTrip.endDate as Timestamp).toDate(), 'yyyy-MM-dd')
        : '',
      coverEmoji: editTrip?.coverEmoji ?? '✈️',
      budgetPaise: editTrip?.budgetPaise ?? null,
      notes: editTrip?.notes ?? '',
    },
  })

  const watchedEmoji = watch('coverEmoji')

  const onSubmit = async (data: TripForm) => {
    if (!user) return
    setSubmitting(true)
    try {
      const payload = {
        name: data.name,
        startDate: Timestamp.fromDate(new Date(data.startDate)),
        endDate: data.endDate ? Timestamp.fromDate(new Date(data.endDate)) : null,
        coverEmoji: data.coverEmoji,
        coverColor: pickedColor,
        budgetPaise: data.budgetPaise,
        isArchived: false,
        notes: data.notes ?? '',
      }
      if (editTrip) {
        await updateTrip(user.uid, editTrip.id, payload)
        onSuccess(editTrip.id)
      } else {
        const id = await addTrip(user.uid, payload)
        onSuccess(id)
      }
    } catch (err) {
      console.error('[Spenza] Trip save error:', err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">
          {editTrip ? 'Edit Trip' : 'New Trip'}
        </h2>
        <button
          onClick={onClose}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-1 flex-col gap-5 overflow-y-auto p-5">
        {/* Emoji + Name row */}
        <div className="flex items-start gap-3">
          {/* Emoji display */}
          <div
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-2xl"
            style={{ backgroundColor: pickedColor + '22' }}
          >
            {watchedEmoji}
          </div>
          <div className="flex-1">
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Trip Name</label>
            <input
              {...register('name')}
              placeholder="Goa Trip, Europe 2026…"
              autoFocus
              className={`w-full rounded-xl border bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary-muted)] ${errors.name ? 'border-[var(--danger)]' : 'border-[var(--border)]'}`}
            />
            {errors.name && <p className="mt-1 text-xs text-[var(--danger)]">{errors.name.message}</p>}
          </div>
        </div>

        {/* Emoji picker */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Cover Emoji</label>
          <div className="flex flex-wrap gap-2">
            {TRIP_EMOJIS.map(e => (
              <button
                key={e}
                type="button"
                onClick={() => setValue('coverEmoji', e)}
                className={`flex h-9 w-9 items-center justify-center rounded-lg border text-lg transition-all ${watchedEmoji === e ? 'border-[var(--primary)] bg-[var(--primary-muted)]' : 'border-[var(--border)] hover:border-[var(--border-strong)]'}`}
              >
                {e}
              </button>
            ))}
          </div>
        </div>

        {/* Color picker */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Card Color</label>
          <div className="flex flex-wrap gap-2">
            {TRIP_COLORS.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setPickedColor(c)}
                className="h-8 w-8 rounded-full border-2 transition-all"
                style={{
                  backgroundColor: c,
                  borderColor: pickedColor === c ? 'var(--text-primary)' : 'transparent',
                  transform: pickedColor === c ? 'scale(1.2)' : 'scale(1)',
                }}
              />
            ))}
          </div>
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Start Date *</label>
            <input
              type="date"
              {...register('startDate')}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">End Date</label>
            <input
              type="date"
              {...register('endDate')}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
            />
          </div>
        </div>

        {/* Budget */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Budget (optional)</label>
          <div className="relative flex items-center">
            <span className="absolute left-4 text-sm font-semibold text-[var(--text-muted)]">₹</span>
            <input
              type="number"
              min="0"
              step="100"
              placeholder="0"
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] pl-9 pr-4 py-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
              onChange={e => setValue('budgetPaise', e.target.value ? Number(e.target.value) * 100 : null)}
              defaultValue={editTrip?.budgetPaise != null ? editTrip.budgetPaise / 100 : ''}
            />
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">Notes (optional)</label>
          <textarea
            {...register('notes')}
            placeholder="Itinerary notes, packing list…"
            rows={2}
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--primary)]"
          />
        </div>
      </form>

      {/* Submit footer */}
      <div className="border-t border-[var(--border)] px-5 py-4">
        <button
          type="submit"
          form="new-trip-form"
          onClick={handleSubmit(onSubmit)}
          disabled={submitting}
          className="flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-semibold text-white shadow-[var(--shadow-md)] transition-all active:scale-[0.98] disabled:opacity-60"
          style={{ backgroundColor: pickedColor }}
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Map className="h-4 w-4" />}
          {editTrip ? 'Save Changes' : 'Create Trip'}
        </button>
      </div>
    </div>
  )
}
