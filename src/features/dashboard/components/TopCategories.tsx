import { getCategoryMeta } from '@/utils/categoryColors'
import { formatINRCompact } from '@/utils/format'
import type { CategoryTotal } from '../dashboardData'

interface TopCategoriesProps {
  topCategories: CategoryTotal[]
  totalThisMonth: number
}

export function TopCategories({ topCategories, totalThisMonth }: TopCategoriesProps) {
  if (topCategories.length === 0) {
    return (
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <h3 className="mb-3 text-sm font-semibold text-[var(--text-primary)]">Top Categories</h3>
        <p className="text-sm text-[var(--text-muted)]">No data yet.</p>
      </div>
    )
  }

  const maxTotal = topCategories[0].totalPaise

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-sm)]">
      <h3 className="mb-4 text-sm font-semibold text-[var(--text-primary)]">
        Top Categories
      </h3>
      <div className="flex flex-col gap-3">
        {topCategories.map(({ categoryId, name, totalPaise }) => {
          const meta = getCategoryMeta(name)
          const pct = totalThisMonth > 0 ? (totalPaise / totalThisMonth) * 100 : 0
          const barPct = maxTotal > 0 ? (totalPaise / maxTotal) * 100 : 0

          return (
            <div key={categoryId}>
              <div className="mb-1 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-sm"
                    style={{ backgroundColor: meta.color + '22' }}
                  >
                    {meta.emoji}
                  </span>
                  <span className="text-sm font-medium text-[var(--text-primary)]">{name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--text-muted)]">{pct.toFixed(0)}%</span>
                  <span className="text-sm font-semibold text-[var(--text-primary)]">
                    {formatINRCompact(totalPaise)}
                  </span>
                </div>
              </div>
              {/* Horizontal bar */}
              <div className="h-1.5 w-full rounded-full bg-[var(--surface-2)]">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${barPct}%`,
                    backgroundColor: meta.color,
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
