/**
 * Skeleton loading cards — theme-aware, pulse animated.
 * Uses --surface-2 as base color.
 */

interface SkeletonCardProps {
  height?: string
  className?: string
}

export function SkeletonCard({ height = 'h-24', className = '' }: SkeletonCardProps) {
  return (
    <div
      className={`animate-pulse rounded-2xl bg-[var(--surface-2)] ${height} ${className}`}
    />
  )
}

export function SkeletonRow({ className = '' }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-xl bg-[var(--surface-2)] h-10 ${className}`} />
  )
}

export function SkeletonText({ className = '' }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-lg bg-[var(--surface-2)] h-4 ${className}`} />
  )
}

/** Full dashboard skeleton — mirrors the real layout */
export function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-5 pb-20 md:pb-6">
      {/* Header */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6">
        <SkeletonText className="w-40 mb-3" />
        <SkeletonText className="w-48 h-10 mb-2" />
        <SkeletonText className="w-24" />
      </div>

      {/* Quick stats row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map(i => (
          <SkeletonCard key={i} height="h-20" />
        ))}
      </div>

      {/* Breakdown */}
      <SkeletonCard height="h-36" />

      {/* Chart */}
      <SkeletonCard height="h-56" />

      {/* Categories + Biggest */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SkeletonCard height="h-48" />
        <SkeletonCard height="h-48" />
      </div>

      {/* Micro + Payment */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SkeletonCard height="h-32" />
        <SkeletonCard height="h-32" />
      </div>
    </div>
  )
}
