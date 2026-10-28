import { useState, useMemo, useEffect } from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  addMonths,
  subMonths,
  isSameMonth,
  isSameDay,
  setMonth,
  setYear,
} from 'date-fns'
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ThemedSelect } from './ThemedSelect'

export interface DatePickerProps {
  /** ISO date string "YYYY-MM-DD" or "" */
  value: string
  /** Called with ISO date string "YYYY-MM-DD" (or "" when cleared) */
  onChange: (isoDate: string) => void
  /** Optional minimum ISO date "YYYY-MM-DD" */
  minDate?: string
  /** Optional maximum ISO date "YYYY-MM-DD" */
  maxDate?: string
  /** Optional initial month "YYYY-MM-DD" to open on when value is empty */
  defaultMonthDate?: string
  placeholder?: string
  allowClear?: boolean
  disabled?: boolean
  size?: 'sm' | 'md'
  className?: string
  id?: string
  'aria-label'?: string
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

function parseISOLocal(iso: string): Date | null {
  if (!iso) return null
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt
}

function toISOLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function DatePicker({
  value,
  onChange,
  minDate,
  maxDate,
  defaultMonthDate,
  placeholder = 'Pick date',
  allowClear = false,
  disabled = false,
  size = 'md',
  className,
  id,
  'aria-label': ariaLabel,
}: DatePickerProps) {
  const [open, setOpen] = useState(false)

  const selectedDate = useMemo(() => parseISOLocal(value), [value])
  const fallbackMonth = useMemo(
    () => parseISOLocal(defaultMonthDate ?? '') ?? new Date(),
    [defaultMonthDate]
  )

  const [viewMonth, setViewMonth] = useState<Date>(() => selectedDate ?? fallbackMonth)

  useEffect(() => {
    if (selectedDate) {
      setViewMonth(selectedDate)
    } else if (defaultMonthDate) {
      const fb = parseISOLocal(defaultMonthDate)
      if (fb) setViewMonth(fb)
    }
  }, [selectedDate, defaultMonthDate])

  const today = useMemo(() => new Date(), [])
  const todayStr = useMemo(() => toISOLocal(today), [today])
  const yesterdayStr = useMemo(() => {
    const y = new Date(today)
    y.setDate(y.getDate() - 1)
    return toISOLocal(y)
  }, [today])

  const days = useMemo(() => {
    const monthStart = startOfMonth(viewMonth)
    const monthEnd = endOfMonth(viewMonth)
    const calStart = startOfWeek(monthStart, { weekStartsOn: 1 })
    const calEnd = endOfWeek(monthEnd, { weekStartsOn: 1 })
    return eachDayOfInterval({ start: calStart, end: calEnd })
  }, [viewMonth])

  const years = useMemo(() => {
    const currentYear = new Date().getFullYear()
    const list: number[] = []
    for (let y = currentYear + 2; y >= 2015; y--) {
      list.push(y)
    }
    return list
  }, [])

  const isDateDisabled = (iso: string) => {
    if (minDate && iso < minDate) return true
    if (maxDate && iso > maxDate) return true
    return false
  }

  const handleSelect = (iso: string) => {
    if (isDateDisabled(iso)) return
    onChange(iso)
    setOpen(false)
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn(
            'inline-flex items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] text-left font-medium transition-all outline-none',
            'hover:border-[var(--border-strong)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary-muted)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            size === 'sm' ? 'rounded-lg px-2.5 py-1.5 text-xs' : 'px-3 py-2.5 text-xs sm:text-sm',
            className
          )}
        >
          <span
            className={cn(
              'truncate',
              selectedDate ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
            )}
          >
            {selectedDate ? format(selectedDate, 'd MMM yyyy') : placeholder}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {allowClear && selectedDate && (
              <span
                role="button"
                tabIndex={-1}
                aria-label="Clear date"
                onClick={e => {
                  e.stopPropagation()
                  onChange('')
                }}
                className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
              >
                <X className="h-3 w-3" />
              </span>
            )}
            <CalendarIcon className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />
          </span>
        </button>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            'z-[100] w-[276px] rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 text-[var(--text-primary)] shadow-[var(--shadow-lg)] outline-none'
          )}
        >
          {/* Month / Year navigation header */}
          <div className="mb-2.5 flex items-center justify-between gap-1">
            <button
              type="button"
              onClick={() => setViewMonth(m => subMonths(m, 1))}
              aria-label="Previous month"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>

            <div className="flex items-center gap-1">
              <ThemedSelect
                size="xs"
                value={String(viewMonth.getMonth())}
                onChange={val => setViewMonth(m => setMonth(m, Number(val)))}
                options={MONTH_LABELS.map((label, idx) => ({ value: String(idx), label }))}
                aria-label="Select month"
                className="font-semibold"
              />

              <ThemedSelect
                size="xs"
                value={String(viewMonth.getFullYear())}
                onChange={val => setViewMonth(m => setYear(m, Number(val)))}
                options={years.map(yr => ({ value: String(yr), label: String(yr) }))}
                aria-label="Select year"
                className="font-semibold"
              />
            </div>

            <button
              type="button"
              onClick={() => setViewMonth(m => addMonths(m, 1))}
              aria-label="Next month"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-secondary)] hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Weekday headers */}
          <div className="mb-1 grid grid-cols-7 text-center">
            {WEEKDAYS.map(day => (
              <span
                key={day}
                className="py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]"
              >
                {day}
              </span>
            ))}
          </div>

          {/* Days grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {days.map(day => {
              const iso = toISOLocal(day)
              const inMonth = isSameMonth(day, viewMonth)
              const isSelected = selectedDate ? isSameDay(day, selectedDate) : false
              const isToday = iso === todayStr
              const isDisabled = isDateDisabled(iso)

              return (
                <button
                  key={iso}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => handleSelect(iso)}
                  className={cn(
                    'flex h-8 w-full items-center justify-center rounded-lg text-xs transition-all',
                    !inMonth && !isSelected && 'text-[var(--text-subtle)] opacity-45',
                    inMonth && !isSelected && 'text-[var(--text-primary)] hover:bg-[var(--surface-2)]',
                    isToday && !isSelected && 'border border-[var(--primary)] font-semibold text-[var(--primary)]',
                    isSelected && 'bg-[var(--primary)] font-semibold text-white shadow-sm',
                    isDisabled && 'pointer-events-none opacity-25'
                  )}
                >
                  {day.getDate()}
                </button>
              )
            })}
          </div>

          {/* Quick shortcuts footer */}
          <div className="mt-2.5 flex items-center justify-between border-t border-[var(--border)] pt-2">
            <div className="flex items-center gap-1.5">
              {!isDateDisabled(todayStr) && (
                <button
                  type="button"
                  onClick={() => handleSelect(todayStr)}
                  className="rounded-md bg-[var(--surface-2)] px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--primary-muted)] hover:text-[var(--primary)]"
                >
                  Today
                </button>
              )}
              {!isDateDisabled(yesterdayStr) && (
                <button
                  type="button"
                  onClick={() => handleSelect(yesterdayStr)}
                  className="rounded-md bg-[var(--surface-2)] px-2 py-1 text-[11px] font-medium text-[var(--text-secondary)] hover:bg-[var(--primary-muted)] hover:text-[var(--primary)]"
                >
                  Yesterday
                </button>
              )}
            </div>
            {allowClear && value && (
              <button
                type="button"
                onClick={() => {
                  onChange('')
                  setOpen(false)
                }}
                className="rounded-md px-2 py-1 text-[11px] font-medium text-[var(--text-muted)] hover:text-[var(--danger)]"
              >
                Clear
              </button>
            )}
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

