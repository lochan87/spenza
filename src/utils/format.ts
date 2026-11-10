/**
 * Indian number formatting utilities.
 * All amounts are stored in paise (integer). Display is always ₹ rupees.
 */

/**
 * Format paise as Indian rupees with Indian grouping:
 * 124500 paise → "₹1,24,500"
 * 1000 paise   → "₹10"
 */
export function formatINR(paise: number): string {
  const rupees = Math.round(paise) / 100
  return '₹' + rupees.toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

/**
 * Compact format for tight UI spaces:
 * ≥ 10,00,000 → ₹10.0L
 * ≥ 1,000     → ₹1.2K
 * else        → ₹950
 */
export function formatINRCompact(paise: number): string {
  const rupees = Math.round(paise) / 100
  if (rupees >= 1_00_000) {
    return '₹' + (rupees / 1_00_000).toFixed(1).replace(/\.0$/, '') + 'L'
  }
  if (rupees >= 1_000) {
    return '₹' + (rupees / 1_000).toFixed(1).replace(/\.0$/, '') + 'K'
  }
  return '₹' + rupees.toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

/**
 * Format paise as a concise string with 2 decimal places (for charts / tooltips).
 */
export function formatINRExact(paise: number): string {
  const rupees = paise / 100
  return '₹' + rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Format transaction amount: exact 2 decimals if paise has fractional rupees (e.g. ₹451.97), else clean integer INR
 */
export function formatTxAmount(paise: number): string {
  return Math.round(paise) % 100 === 0 ? formatINR(paise) : formatINRExact(paise)
}

/**
 * Format a % change with sign.
 * Returns e.g. "+12.4%" or "−8.1%"
 */
export function formatPct(value: number): string {
  const sign = value >= 0 ? '+' : '−'
  return sign + Math.abs(value).toFixed(1) + '%'
}

/**
 * Time-of-day greeting.
 */
export function getGreeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  if (h < 21) return 'Good evening'
  return 'Good night'
}

/**
 * Safely parse any date representation into a valid Date object.
 * Handles:
 * - Firestore Timestamp instances ({ toDate: () => Date })
 * - Firestore timestamp POJOs ({ seconds: number, nanoseconds?: number })
 * - JavaScript Date instances
 * - ISO date strings, date-only strings, and millisecond timestamp numbers
 * Returns null if the value is missing, null, undefined, or unparseable.
 */
export function parseTransactionDate(value: unknown): Date | null {
  if (value == null) return null
  try {
    if (typeof value === 'object' && 'toDate' in value && typeof (value as any).toDate === 'function') {
      const d = (value as any).toDate()
      return d instanceof Date && Number.isFinite(d.getTime()) ? d : null
    }
    if (typeof value === 'object' && 'seconds' in value && typeof (value as any).seconds === 'number') {
      const d = new Date((value as any).seconds * 1000)
      return d instanceof Date && Number.isFinite(d.getTime()) ? d : null
    }
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value : null
    }
    if (typeof value === 'string' || typeof value === 'number') {
      const d = new Date(value)
      return d instanceof Date && Number.isFinite(d.getTime()) ? d : null
    }
    return null
  } catch {
    return null
  }
}
