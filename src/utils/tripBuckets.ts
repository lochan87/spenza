/**
 * Trip sub-category buckets — used only within trip breakdowns.
 * These 5 buckets are separate from the main category color palette.
 * Per spec: Transport #3B82F6, Food #F59E0B, Stay #8B5CF6,
 *           Activities #14B8A6, Misc #64748B
 */

export type TripBucket = 'Transport' | 'Food' | 'Stay' | 'Activities' | 'Misc'

export const TRIP_ACCENT_COLOR = '#06B6D4'  // cyan-500, primary accent for trips

export const TRIP_BUCKET_META: Record<TripBucket, { color: string; emoji: string; bg: string }> = {
  Transport:  { color: '#3B82F6', emoji: '🚗', bg: 'rgba(59, 130, 246, 0.12)' },
  Food:       { color: '#F59E0B', emoji: '🍽️', bg: 'rgba(245, 158, 11, 0.12)' },
  Stay:       { color: '#8B5CF6', emoji: '🏨', bg: 'rgba(139, 92, 246, 0.12)' },
  Activities: { color: '#14B8A6', emoji: '🎡', bg: 'rgba(20, 184, 166, 0.12)' },
  Misc:       { color: '#64748B', emoji: '📦', bg: 'rgba(100, 116, 139, 0.12)' },
}

const TRANSPORT_KW  = ['transport', 'vehicle', 'travel', 'auto', 'cab', 'taxi', 'bus', 'train', 'flight', 'metro', 'fuel', 'petrol', 'uber', 'ola', 'rapido', 'rickshaw', 'ferry', 'toll']
const FOOD_KW       = ['food', 'drink', 'restaurant', 'cafe', 'coffee', 'dining', 'eat', 'meal', 'snack', 'breakfast', 'lunch', 'dinner', 'zomato', 'swiggy', 'blinkit', 'grocery']
const STAY_KW       = ['stay', 'hotel', 'accommodation', 'hostel', 'airbnb', 'lodge', 'pg', 'oyo', 'resort', 'guesthouse', 'homestay']
const ACTIVITIES_KW = ['entertainment', 'outing', 'outings', 'social', 'meetup', 'hangout', 'sport', 'cinema', 'movie', 'park', 'museum', 'event', 'show', 'gym', 'activity', 'experience', 'tour', 'adventure', 'trek', 'hike', 'shopping', 'souvenir']

/**
 * Map a main category name to one of the 5 trip buckets.
 * Called per-transaction when computing trip detail breakdown.
 */
export function mapCategoryToTripBucket(categoryName: string): TripBucket {
  const n = categoryName.toLowerCase()
  if (TRANSPORT_KW.some(k => n.includes(k)))  return 'Transport'
  if (FOOD_KW.some(k => n.includes(k)))        return 'Food'
  if (STAY_KW.some(k => n.includes(k)))        return 'Stay'
  if (ACTIVITIES_KW.some(k => n.includes(k)))  return 'Activities'
  return 'Misc'
}

/** Budget vs actual color rule — applies to both trip and category budgets */
export function getBudgetColor(pct: number): string {
  if (pct >= 100) return 'var(--danger)'
  if (pct >= 90)  return '#F97316'   // orange-500 — between warning and danger
  if (pct >= 70)  return 'var(--warning)'
  return 'var(--success)'
}

export function getBudgetBg(pct: number): string {
  if (pct >= 100) return 'var(--danger-muted)'
  if (pct >= 90)  return 'rgba(249, 115, 22, 0.1)'
  if (pct >= 70)  return 'var(--warning-muted)'
  return 'var(--success-muted)'
}
