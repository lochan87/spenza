import type { RecurringFrequency } from '../types/index.ts'

/**
 * Recurring schedules use UTC calendar dates, matching persisted date-only input.
 * New/explicitly changed dates are UTC midnight. Existing timestamps are never
 * migrated: unchanged edits retain the exact timestamp, and progression preserves
 * its UTC time-of-day. Due checks remain instant comparisons against the clock.
 * A legacy non-midnight timestamp is displayed by its UTC date, not the viewer's
 * timezone; no attempt is made to infer an unavailable original timezone.
 */
export function recurringDateKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function parseRecurringDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || recurringDateKey(date) !== value) {
    throw new Error('Select a valid recurring date.')
  }
  return date
}

export function formatRecurringDate(date: Date, includeYear = true): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', day: 'numeric', month: 'short', ...(includeYear ? { year: 'numeric' as const } : {}),
  }).format(date)
}

export function recurringDaysUntil(date: Date, now = new Date()): number {
  return (parseRecurringDate(recurringDateKey(date)).getTime() - parseRecurringDate(recurringDateKey(now)).getTime()) / 86_400_000
}

export function computeNextDueDate(current: Date, frequency: RecurringFrequency, dayOfMonth: number | null, _dayOfWeek: number | null): Date {
  const next = new Date(current.getTime())
  if (frequency === 'weekly') {
    next.setUTCDate(next.getUTCDate() + 7)
    return next
  }
  const day = frequency === 'monthly' ? dayOfMonth || current.getUTCDate() : current.getUTCDate()
  next.setUTCDate(1)
  if (frequency === 'monthly') next.setUTCMonth(next.getUTCMonth() + 1)
  else if (frequency === 'yearly') next.setUTCFullYear(next.getUTCFullYear() + 1)
  else throw new Error('Invalid recurring frequency.')
  const end = new Date(next.getTime())
  end.setUTCMonth(end.getUTCMonth() + 1, 0)
  next.setUTCDate(Math.min(day, end.getUTCDate()))
  return next
}
