import type { Budget, Category, Transaction } from '../types/index.ts'
import { getNetSpendPaise, toNonNegativeIntPaise } from './splitMath.ts'

export interface CategoryBudgetProgress {
  categoryId: string
  categoryName: string
  budgetPaise: number
  actualPaise: number
  remainingPaise: number
  pct: number
  isOverBudget: boolean
}

export interface OverallBudgetProgress {
  totalBudgetPaise: number | null
  actualPaise: number
  remainingPaise: number | null
  pct: number | null
  isOverBudget: boolean
}

export interface BudgetStatusSummary {
  overall: OverallBudgetProgress
  categoryRows: CategoryBudgetProgress[]
  alertCategories: CategoryBudgetProgress[]
}

/**
 * Calculates net personal spend across transactions for a specific category.
 */
export function calculateCategoryNetSpend(
  transactions: Transaction[],
  categoryId: string
): number {
  return transactions
    .filter(tx => tx.categoryId === categoryId)
    .reduce((sum, tx) => sum + getNetSpendPaise(tx), 0)
}

/**
 * Calculates total net personal spend across all transactions.
 */
export function calculateTotalNetSpend(
  transactions: Transaction[]
): number {
  return transactions.reduce((sum, tx) => sum + getNetSpendPaise(tx), 0)
}

/**
 * Computes a map of categoryId -> net personal spend in paise.
 */
export function calculateCategoryActualsMap(
  transactions: Transaction[]
): Map<string, number> {
  const map = new Map<string, number>()
  for (const tx of transactions) {
    const net = getNetSpendPaise(tx)
    if (net > 0) {
      map.set(tx.categoryId, (map.get(tx.categoryId) ?? 0) + net)
    }
  }
  return map
}

/**
 * Derives comprehensive budget consumption, remaining balances, and threshold alerts.
 *
 * Financial Invariants Guaranteed:
 * 1. Personal net spend is used for both overall and category consumption.
 * 2. 100% recoverable expenses fronted for others consume ₹0 budget.
 * 3. Shared expenses only consume the user's personal net share.
 * 4. Repayments from others never increase budget room or reduce consumption a second time.
 * 5. Remaining budget is strictly (Budget - Net Spend).
 */
export function deriveBudgetStatus(
  budget: Budget | null | undefined,
  transactions: Transaction[],
  categories: Category[]
): BudgetStatusSummary {
  const actualPaise = calculateTotalNetSpend(transactions)
  const totalBudget = budget?.totalBudgetPaise ?? null

  const overallPct =
    totalBudget != null && totalBudget > 0
      ? (actualPaise / totalBudget) * 100
      : null

  const overallRemaining =
    totalBudget != null ? totalBudget - actualPaise : null

  const overall: OverallBudgetProgress = {
    totalBudgetPaise: totalBudget,
    actualPaise,
    remainingPaise: overallRemaining,
    pct: overallPct,
    isOverBudget: totalBudget != null ? actualPaise > totalBudget : false,
  }

  if (!budget?.categoryBudgets) {
    return {
      overall,
      categoryRows: [],
      alertCategories: [],
    }
  }

  const catActuals = calculateCategoryActualsMap(transactions)

  const categoryRows: CategoryBudgetProgress[] = Object.entries(budget.categoryBudgets)
    .map(([catId, budgetPaise]) => {
      const cat = categories.find(c => c.id === catId)
      const catActual = catActuals.get(catId) ?? 0
      const remaining = budgetPaise - catActual
      const pct = budgetPaise > 0 ? (catActual / budgetPaise) * 100 : 0

      return {
        categoryId: catId,
        categoryName: cat?.name ?? 'Other',
        budgetPaise: toNonNegativeIntPaise(budgetPaise),
        actualPaise: catActual,
        remainingPaise: remaining,
        pct,
        isOverBudget: catActual > budgetPaise,
      }
    })
    .filter(row => row.budgetPaise > 0)
    .sort((a, b) => b.pct - a.pct)

  const alertCategories = categoryRows.filter(row => row.pct >= 90)

  return {
    overall,
    categoryRows,
    alertCategories,
  }
}
