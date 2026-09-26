import {
  doc, getDoc, setDoc, serverTimestamp,
} from 'firebase/firestore'
import { format, subMonths } from 'date-fns'
import { db } from '@/firebase/config'
import type { Budget } from '@/types'

const budgetRef = (uid: string, month: string) =>
  doc(db, 'users', uid, 'budgets', month)

/** month = "YYYY-MM", e.g. "2026-09" */
export async function getBudget(uid: string, month: string): Promise<Budget | null> {
  const snap = await getDoc(budgetRef(uid, month))
  return snap.exists() ? ({ id: snap.id, ...snap.data() } as Budget) : null
}

export async function getCurrentBudget(uid: string): Promise<Budget | null> {
  return getBudget(uid, format(new Date(), 'yyyy-MM'))
}

export async function getLastMonthBudget(uid: string): Promise<Budget | null> {
  return getBudget(uid, format(subMonths(new Date(), 1), 'yyyy-MM'))
}

export async function saveBudget(
  uid: string,
  month: string,
  data: { totalBudgetPaise: number | null; categoryBudgets: Record<string, number> }
): Promise<void> {
  const ref = budgetRef(uid, month)
  const existing = await getDoc(ref)
  await setDoc(ref, {
    id: month,
    ...data,
    createdAt: existing.exists() ? existing.data().createdAt : serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
}
