import { getCategories, addCategory, updateCategory } from '@/services/transactions'
import { invalidateInsightsCache } from '@/services/insights'
import type { Category } from '@/types'

export interface CategoryRenameRule {
  from: string
  to: string
  icon: string
  color: string
}

export const CATEGORY_RENAME_RULES: CategoryRenameRule[] = [
  {
    from: 'Transport',
    to: 'Transport & Vehicle',
    icon: '🚗',
    color: '#3B82F6',
  },
  {
    from: 'Health',
    to: 'Health & Medical',
    icon: '🏥',
    color: '#EF4444',
  },
  {
    from: 'Education',
    to: 'Education & Career',
    icon: '🎓',
    color: '#6366F1',
  },
  {
    from: 'Personal',
    to: 'Personal/Household',
    icon: '🏠',
    color: '#A855F7',
  },
]

export const NEW_CATEGORIES_TO_ADD: Omit<Category, 'id'>[] = [
  {
    name: 'Outings & Social',
    icon: '🥂',
    color: '#10B981',
    isArchived: false,
  },
]

export interface PlannedCategoryRename {
  id: string
  fromName: string
  toName: string
  icon: string
  color: string
  targetAlreadyExists: boolean
}

export interface CategoryMigrationPreview {
  existingCategories: Category[]
  plannedRenames: PlannedCategoryRename[]
  plannedAdditions: Omit<Category, 'id'>[]
  alreadyUpToDate: boolean
  hasDuplicateConflicts: boolean
}

export interface CategoryMigrationResult {
  before: Category[]
  after: Category[]
  renamedCount: number
  addedCount: number
  cacheInvalidated: boolean
}

/**
 * Inspects the user's current Firestore categories without modifying anything.
 * Reports exact document IDs to be renamed in-place, checks for duplicate target names,
 * and lists any new categories to be created.
 */
export async function previewCategoryMigration(
  uid: string
): Promise<CategoryMigrationPreview> {
  const existingCategories = await getCategories(uid)
  const existingNamesLower = new Set(
    existingCategories.map(c => c.name.trim().toLowerCase())
  )

  const plannedRenames: PlannedCategoryRename[] = []
  for (const cat of existingCategories) {
    const rule = CATEGORY_RENAME_RULES.find(
      r => r.from.toLowerCase() === cat.name.trim().toLowerCase()
    )
    if (rule) {
      const targetAlreadyExists = existingNamesLower.has(rule.to.toLowerCase())
      plannedRenames.push({
        id: cat.id,
        fromName: cat.name,
        toName: rule.to,
        icon: rule.icon,
        color: rule.color,
        targetAlreadyExists,
      })
    }
  }

  const plannedAdditions: Omit<Category, 'id'>[] = []
  for (const newCat of NEW_CATEGORIES_TO_ADD) {
    if (!existingNamesLower.has(newCat.name.toLowerCase())) {
      plannedAdditions.push(newCat)
    }
  }

  const hasDuplicateConflicts = plannedRenames.some(r => r.targetAlreadyExists)
  const alreadyUpToDate =
    plannedRenames.length === 0 && plannedAdditions.length === 0

  return {
    existingCategories,
    plannedRenames,
    plannedAdditions,
    alreadyUpToDate,
    hasDuplicateConflicts,
  }
}

/**
 * Runs the one-time category taxonomy migration:
 * 1. Updates old category names IN-PLACE on their existing Firestore documents
 *    (preserving document IDs so 100% of existing transaction categoryId references remain intact).
 * 2. Adds "Outings & Social" if it does not already exist.
 * 3. Invalidates the cached Insights summary so renamed categories appear immediately.
 */
export async function runCategoryMigration(
  uid: string
): Promise<CategoryMigrationResult> {
  const preview = await previewCategoryMigration(uid)
  const before = preview.existingCategories

  let renamedCount = 0
  for (const rename of preview.plannedRenames) {
    if (rename.targetAlreadyExists) {
      console.warn(
        `[Spenza CategoryMigration] Skipping rename of "${rename.fromName}" (${rename.id}) because "${rename.toName}" already exists.`
      )
      continue
    }
    await updateCategory(uid, rename.id, {
      name: rename.toName,
      icon: rename.icon,
      color: rename.color,
    })
    renamedCount++
  }

  let addedCount = 0
  for (const addition of preview.plannedAdditions) {
    await addCategory(uid, addition)
    addedCount++
  }

  const cacheInvalidated = await invalidateInsightsCache(uid)
  const after = await getCategories(uid)

  return {
    before,
    after,
    renamedCount,
    addedCount,
    cacheInvalidated,
  }
}
