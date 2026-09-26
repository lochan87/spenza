import { useState, useEffect } from 'react'
import { format, addDays } from 'date-fns'
import { Timestamp } from 'firebase/firestore'
import { RepeatIcon, ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { getUpcomingRecurring } from '@/services/recurring'
import { formatINR } from '@/utils/format'
import { getCategoryMeta } from '@/utils/categoryColors'
import type { RecurringItem, Category } from '@/types'

interface UpcomingRecurringCardProps {
  categories: Category[]
}

export function UpcomingRecurringCard({ categories }: UpcomingRecurringCardProps) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [upcoming, setUpcoming] = useState<RecurringItem[]>([])

  useEffect(() => {
    if (!user) return
    getUpcomingRecurring(user.uid, 7)
      .then(setUpcoming)
      .catch(err => console.error('[Spenza] Upcoming recurring fetch error:', err))
  }, [user])

  if (upcoming.length === 0) return null

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--primary-muted)]">
            <RepeatIcon className="h-3.5 w-3.5 text-[var(--primary)]" />
          </div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Upcoming this week
          </h3>
        </div>
        <button
          onClick={() => navigate('/app/recurring')}
          className="flex items-center gap-1 text-xs text-[var(--primary)] hover:underline"
        >
          Manage <ChevronRight className="h-3 w-3" />
        </button>
      </div>

      <div className="flex flex-col gap-2">
        {upcoming.slice(0, 5).map(item => {
          const cat = categories.find(c => c.id === item.categoryId)
          const catMeta = getCategoryMeta(cat?.name ?? 'Other')
          const dueDate = (item.nextDueDate as Timestamp).toDate()
          const daysLeft = Math.ceil((dueDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))

          return (
            <div key={item.id} className="flex items-center gap-3 rounded-xl bg-[var(--surface-2)] px-3 py-2.5">
              <span className="text-base">{catMeta.emoji}</span>
              <div className="flex-1 min-w-0">
                <p className="truncate text-sm font-medium text-[var(--text-primary)]">
                  {item.description}
                </p>
                <p className="text-[10px] text-[var(--text-muted)]">
                  {daysLeft === 0 ? 'Today' : daysLeft === 1 ? 'Tomorrow' : `In ${daysLeft} days`}
                  {' · '}{format(dueDate, 'd MMM')}
                </p>
              </div>
              <span className="shrink-0 text-sm font-bold text-[var(--text-primary)]">
                {formatINR(item.amountPaise)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
