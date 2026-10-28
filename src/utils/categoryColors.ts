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
  'Food & Drinks':       { color: '#F59E0B', emoji: '🍔', label: 'Food & Drinks' },
  'Transport & Vehicle': { color: '#3B82F6', emoji: '🚗', label: 'Transport & Vehicle' },
  'Shopping':            { color: '#8B5CF6', emoji: '🛍️', label: 'Shopping' },
  'Gifts & Events':      { color: '#EC4899', emoji: '🎁', label: 'Gifts & Events' },
  'Health & Medical':    { color: '#EF4444', emoji: '🏥', label: 'Health & Medical' },
  'Education & Career':  { color: '#6366F1', emoji: '🎓', label: 'Education & Career' },
  'Travel':              { color: '#06B6D4', emoji: '✈️', label: 'Travel' },
  'Outings & Social':    { color: '#10B981', emoji: '🥂', label: 'Outings & Social' },
  'Bills & Recharge':    { color: '#14B8A6', emoji: '📱', label: 'Bills & Recharge' },
  'Entertainment':       { color: '#F43F5E', emoji: '🎮', label: 'Entertainment' },
  'Personal/Household':  { color: '#A855F7', emoji: '🏠', label: 'Personal/Household' },
  'Other':               { color: '#64748B', emoji: '📌', label: 'Other' },
} as const

/** Fallback aliases so pre-migration category names still resolve to their proper visual meta */
const LEGACY_CATEGORY_ALIASES: Record<string, string> = {
  Transport: 'Transport & Vehicle',
  Health: 'Health & Medical',
  Education: 'Education & Career',
  Personal: 'Personal/Household',
}

function resolveCategoryName(name: string): string {
  return LEGACY_CATEGORY_ALIASES[name] ?? name
}

export type CategoryName = keyof typeof CATEGORY_COLORS

/** Get color for a category by name, with fallback */
export function getCategoryColor(name: string): string {
  const resolved = resolveCategoryName(name)
  return CATEGORY_COLORS[resolved]?.color ?? '#64748B'
}

/** Get emoji for a category by name, with fallback */
export function getCategoryEmoji(name: string): string {
  const resolved = resolveCategoryName(name)
  return CATEGORY_COLORS[resolved]?.emoji ?? '📌'
}

/** Get full meta for a category, with fallback to 'Other' */
export function getCategoryMeta(name: string): CategoryMeta {
  const resolved = resolveCategoryName(name)
  return CATEGORY_COLORS[resolved] ?? CATEGORY_COLORS['Other']
}

/** Default ordered list of category names */
export const DEFAULT_CATEGORY_ORDER: string[] = [
  'Food & Drinks',
  'Transport & Vehicle',
  'Shopping',
  'Gifts & Events',
  'Health & Medical',
  'Education & Career',
  'Travel',
  'Outings & Social',
  'Bills & Recharge',
  'Entertainment',
  'Personal/Household',
  'Other',
]
