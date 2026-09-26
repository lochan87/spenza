import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { getCategories, getPaymentAccounts } from '@/services/transactions'
import { fetchDashboardTransactions, deriveDashboardData, type DashboardData } from './dashboardData'
import type { Category, PaymentAccount } from '@/types'

interface UseDashboardReturn {
  data: DashboardData | null
  categories: Category[]
  accounts: PaymentAccount[]
  loading: boolean
  error: string | null
  refetch: () => void
}

/**
 * Custom hook — fetches everything needed for the Dashboard in one place.
 * Caches results; re-fetches only when the user changes or refetch() is called.
 *
 * Data strategy:
 *   ONE Firestore query (6-month date range) + two metadata queries (categories, accounts).
 *   All 8 dashboard sections are derived from this data via memoized computation.
 *   No redundant reads happen across sections.
 */
export function useDashboardData(): UseDashboardReturn {
  const { user } = useAuth()
  const [rawTxns, setRawTxns] = useState<any[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [accounts, setAccounts] = useState<PaymentAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchTick, setFetchTick] = useState(0)

  const refetch = useCallback(() => setFetchTick(t => t + 1), [])

  useEffect(() => {
    if (!user) return
    setLoading(true)
    setError(null)

    Promise.all([
      fetchDashboardTransactions(user.uid),
      getCategories(user.uid),
      getPaymentAccounts(user.uid),
    ])
      .then(([txns, cats, accs]) => {
        setRawTxns(txns)
        setCategories(cats)
        setAccounts(accs)
      })
      .catch(err => {
        console.error('[Spenza] Dashboard fetch error:', err)
        setError('Failed to load dashboard data.')
      })
      .finally(() => setLoading(false))
  }, [user, fetchTick])

  // Memoize derivation — only recomputes when raw data changes
  const data = useMemo<DashboardData | null>(() => {
    if (loading) return null  // Show skeleton while loading
    // Empty array is fine — deriveDashboardData handles it with zeroes
    return deriveDashboardData(rawTxns, categories, accounts)
  }, [rawTxns, categories, accounts, loading])

  return { data, categories, accounts, loading, error, refetch }
}
