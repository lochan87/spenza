import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { getOverdueRecurring } from '@/services/recurring'
import { addTransaction } from '@/services/transactions'
import { invalidateInsightsCache } from '@/services/insights'
import { computeNextDueDate, updateRecurringItem } from '@/services/recurring'
import { Timestamp } from 'firebase/firestore'
import type { RecurringItem } from '@/types'

export interface OverduePromptItem {
  item: RecurringItem
  /** Amount user can edit before confirming */
  confirmedAmountPaise: number
}

interface UseRecurringCheckReturn {
  overdueItems: RecurringItem[]
  dismiss: (id: string) => void
  confirm: (item: RecurringItem, amountPaise: number) => Promise<void>
  dismissAll: () => void
}

/**
 * Runs once per app session on mount.
 * Checks for recurring items whose nextDueDate has passed.
 * NEVER creates transactions automatically — always surfaces them as prompts.
 * The user must explicitly confirm each item (amounts may vary slightly).
 */
export function useRecurringCheck(): UseRecurringCheckReturn {
  const { user } = useAuth()
  const [overdueItems, setOverdueItems] = useState<RecurringItem[]>([])

  useEffect(() => {
    if (!user) return
    getOverdueRecurring(user.uid)
      .then(items => setOverdueItems(items))
      .catch(err => console.error('[Spenza] Recurring check error:', err))
  }, [user]) // Run once per session

  const dismiss = useCallback((id: string) => {
    setOverdueItems(prev => prev.filter(i => i.id !== id))
  }, [])

  const dismissAll = useCallback(() => {
    setOverdueItems([])
  }, [])

  const confirm = useCallback(async (item: RecurringItem, amountPaise: number) => {
    if (!user) return

    // 1. Create the actual transaction (type: 'recurring')
    await addTransaction(user.uid, {
      amountPaise,
      description: item.description,
      categoryId: item.categoryId,
      type: 'recurring',
      date: Timestamp.fromDate(item.nextDueDate.toDate()),
      paymentMode: item.paymentMode,
      paymentAccountId: item.paymentAccountId,
      tripId: null,
      personId: null,
      tags: [],
      notes: `Auto-logged from recurring: ${item.description}`,
      receiptUrl: null,
    })

    // 2. Advance nextDueDate to next cycle
    const nextDate = computeNextDueDate(
      item.nextDueDate.toDate(),
      item.frequency,
      item.dayOfMonth,
      item.dayOfWeek
    )
    await updateRecurringItem(user.uid, item.id, {
      nextDueDate: Timestamp.fromDate(nextDate),
      lastGeneratedDate: Timestamp.now(),
    })
    await invalidateInsightsCache(user.uid)

    // 3. Remove from prompts
    setOverdueItems(prev => prev.filter(i => i.id !== item.id))
  }, [user])

  return { overdueItems, dismiss, confirm, dismissAll }
}
