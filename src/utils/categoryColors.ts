/**
 * Category color map — single source of truth.
 * Used in transaction list, charts, badges, pickers.
 * Never hardcode category colors in components.
 */

export interface CategoryMeta {
  color: string
  emoji: string
  label: string
}

/** Map from category name → visual metadata */
export const CATEGORY_COLORS: Record<string, CategoryMeta> = {
  'Food & Drinks':    { color: '#F59E0B', emoji: '🍔', label: 'Food & Drinks' },
  'Transport':        { color: '#3B82F6', emoji: '🚗', label: 'Transport' },
  'Shopping':         { color: '#8B5CF6', emoji: '🛍️', label: 'Shopping' },
  'Gifts & Events':   { color: '#EC4899', emoji: '🎁', label: 'Gifts & Events' },
  'Health':           { color: '#EF4444', emoji: '🏥', label: 'Health' },
  'Education':        { color: '#6366F1', emoji: '🎓', label: 'Education' },
  'Travel':           { color: '#06B6D4', emoji: '✈️', label: 'Travel' },
  'Bills & Recharge': { color: '#14B8A6', emoji: '📱', label: 'Bills & Recharge' },
  'Entertainment':    { color: '#F43F5E', emoji: '🎮', label: 'Entertainment' },
  'Personal/Household': { color: '#A855F7', emoji: '🏠', label: 'Personal/Household' },
  'Other':            { color: '#64748B', emoji: '📌', label: 'Other' },
} as const

export type CategoryName = keyof typeof CATEGORY_COLORS

/** Get color for a category by name, with fallback */
export function getCategoryColor(name: string): string {
  return CATEGORY_COLORS[name]?.color ?? '#64748B'
}

/** Get emoji for a category by name, with fallback */
export function getCategoryEmoji(name: string): string {
  return CATEGORY_COLORS[name]?.emoji ?? '📌'
}

/** Get full meta for a category, with fallback to 'Other' */
export function getCategoryMeta(name: string): CategoryMeta {
  return CATEGORY_COLORS[name] ?? CATEGORY_COLORS['Other']
}

/** Default ordered list of category names */
export const DEFAULT_CATEGORY_ORDER: string[] = [
  'Food & Drinks',
  'Transport',
  'Shopping',
  'Gifts & Events',
  'Health',
  'Education',
  'Travel',
  'Bills & Recharge',
  'Entertainment',
  'Personal/Household',
  'Other',
]
