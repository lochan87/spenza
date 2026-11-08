import { useState, useEffect, useMemo, useCallback } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useFinancialSync } from '@/hooks/useFinancialSync'
import { getCategories, getPaymentAccounts } from '@/services/transactions'
import { fetchDashboardTransactionsWithMeta, deriveDashboardData, type DashboardData } from './dashboardData'
import type { Category, PaymentAccount } from '@/types'

interface UseDashboardReturn {
  data: DashboardData | null
  categories: Category[]
  accounts: PaymentAccount[]
  loading: boolean
  error: string | null
  refetch: () => void
  isStale: boolean
  isFromCache: boolean
  isOnline: boolean
}

/**
 * Custom hook — fetches everything needed for the Dashboard in one place.
 * Caches results; re-fetches when the user changes, refetch() is called,
 * a cross-tab mutation event arrives, or network connectivity is restored.
 *
 * Data strategy:
 *   ONE full owner-history query + two metadata queries (categories, accounts).
 *   All-time dues include historical/future records; recent analytics filter locally.
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
  const [isFromCache, setIsFromCache] = useState(false)

  const refetch = useCallback(() => setFetchTick(t => t + 1), [])

  const { isOnline, isStale } = useFinancialSync({
    uid: user?.uid,
    onRefresh: refetch,
    isFromCache,
  })

  useEffect(() => {
    if (!user) return
    setLoading(true)
    setError(null)

    Promise.all([
      fetchDashboardTransactionsWithMeta(user.uid),
      getCategories(user.uid),
      getPaymentAccounts(user.uid),
    ])
      .then(([txnRes, cats, accs]) => {
        setRawTxns(txnRes.transactions)
        setIsFromCache(txnRes.fromCache)
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

  return { data, categories, accounts, loading, error, refetch, isStale, isFromCache, isOnline }
}
