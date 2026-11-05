import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { getOverdueRecurring, confirmRecurringOccurrence, RecurringConfirmationError } from '@/services/recurring'
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
    if (!user) throw new RecurringConfirmationError('Sign in before confirming a recurring expense.')
    const result = await confirmRecurringOccurrence(user.uid, item, amountPaise)
    const next = result.recurringItem
    // Advance one occurrence at a time, leaving any remaining overdue cycles visible.
    setOverdueItems(prev => prev.flatMap(i => i.id !== item.id ? [i] :
      next?.isActive && next.nextDueDate.toMillis() <= Date.now() ? [next] : []))
  }, [user])

  return { overdueItems, dismiss, confirm, dismissAll }
}
