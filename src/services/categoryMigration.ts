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
  {
    // Same icon/color as DEFAULT_CATEGORIES in seed.ts and CATEGORY_COLORS in categoryColors.ts
    name: 'Entertainment',
    icon: '🎮',
    color: '#F43F5E',
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

export type MigrationOperationStatus = 'success' | 'skipped' | 'failed'

/** Outcome of a single document write (rename or create) during the migration. */
export interface MigrationOperationResult {
  kind: 'rename' | 'create'
  /** Document id (renames) or null (creates, where the id is assigned by Firestore) */
  id: string | null
  /** Human-readable description, e.g. "Transport → Transport & Vehicle" */
  label: string
  status: MigrationOperationStatus
  /** Reason for skipped/failed operations */
  detail?: string
}

export interface CategoryMigrationResult {
  before: Category[]
  after: Category[]
  renamedCount: number
  addedCount: number
  skippedCount: number
  failedCount: number
  operations: MigrationOperationResult[]
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
 * 2. Adds "Outings & Social" and "Entertainment" if they do not already exist.
 * 3. Invalidates the cached Insights summary so renamed categories appear immediately.
 *
 * Every document write is isolated in its own try/catch and reported individually in
 * `operations` (success / skipped / failed), so one failure never aborts the rest.
 */
export async function runCategoryMigration(
  uid: string
): Promise<CategoryMigrationResult> {
  const preview = await previewCategoryMigration(uid)
  const before = preview.existingCategories

  const operations: MigrationOperationResult[] = []
  const errorMessage = (err: unknown) =>
    err instanceof Error ? err.message : String(err)

  for (const rename of preview.plannedRenames) {
    const label = `${rename.fromName} → ${rename.toName}`
    if (rename.targetAlreadyExists) {
      console.warn(
        `[Spenza CategoryMigration] Skipping rename of "${rename.fromName}" (${rename.id}) because "${rename.toName}" already exists.`
      )
      operations.push({
        kind: 'rename',
        id: rename.id,
        label,
        status: 'skipped',
        detail: 'skipped: target already exists',
      })
      continue
    }
    try {
      await updateCategory(uid, rename.id, {
        name: rename.toName,
        icon: rename.icon,
        color: rename.color,
      })
      operations.push({ kind: 'rename', id: rename.id, label, status: 'success' })
    } catch (err) {
      console.error(`[Spenza CategoryMigration] Rename failed: ${label} (${rename.id})`, err)
      operations.push({
        kind: 'rename',
        id: rename.id,
        label,
        status: 'failed',
        detail: errorMessage(err),
      })
    }
  }

  for (const addition of preview.plannedAdditions) {
    const label = `Create ${addition.name}`
    try {
      await addCategory(uid, addition)
      operations.push({ kind: 'create', id: null, label, status: 'success' })
    } catch (err) {
      console.error(`[Spenza CategoryMigration] Create failed: ${addition.name}`, err)
      operations.push({
        kind: 'create',
        id: null,
        label,
        status: 'failed',
        detail: errorMessage(err),
      })
    }
  }

  const count = (kind: 'rename' | 'create', status: MigrationOperationStatus) =>
    operations.filter(o => o.kind === kind && o.status === status).length

  // Invalidate only if something was actually written; never let a read failure hide the per-document results.
  const anyWritten = operations.some(o => o.status === 'success')
  const cacheInvalidated = anyWritten ? await invalidateInsightsCache(uid) : false
  let after: Category[] = before
  try {
    after = await getCategories(uid)
  } catch (err) {
    console.error('[Spenza CategoryMigration] Failed to re-read categories after migration', err)
  }

  return {
    before,
    after,
    renamedCount: count('rename', 'success'),
    addedCount: count('create', 'success'),
    skippedCount: operations.filter(o => o.status === 'skipped').length,
    failedCount: operations.filter(o => o.status === 'failed').length,
    operations,
    cacheInvalidated,
  }
}
