/**
 * Payment method color map — single source of truth.
 * Used in transaction list, badges, account pickers.
 * Never hardcode payment colors in components.
 */

export interface PaymentMeta {
  color: string
  bgColor: string  // light alpha background for chips
  label: string
}

/** Map from payment mode → visual metadata */
export const PAYMENT_COLORS: Record<string, PaymentMeta> = {
  'UPI':           { color: '#14B8A6', bgColor: 'rgba(20, 184, 166, 0.12)',  label: 'UPI' },
  'Cash':          { color: '#16A34A', bgColor: 'rgba(22, 163, 74, 0.12)',   label: 'Cash' },
  'Card':          { color: '#6366F1', bgColor: 'rgba(99, 102, 241, 0.12)',  label: 'Card' },
  'Bank Transfer': { color: '#0284C7', bgColor: 'rgba(2, 132, 199, 0.12)',   label: 'Bank Transfer' },
  'Wallet':        { color: '#8B5CF6', bgColor: 'rgba(139, 92, 246, 0.12)', label: 'Wallet' },
  'Other':         { color: '#64748B', bgColor: 'rgba(100, 116, 139, 0.12)', label: 'Other' },
} as const

/** Account type color (for paymentAccounts) */
export const ACCOUNT_TYPE_COLORS: Record<string, PaymentMeta> = {
  'Bank':   { color: '#0284C7', bgColor: 'rgba(2, 132, 199, 0.12)',  label: 'Bank' },
  'UPI':    { color: '#14B8A6', bgColor: 'rgba(20, 184, 166, 0.12)', label: 'UPI' },
  'Card':   { color: '#6366F1', bgColor: 'rgba(99, 102, 241, 0.12)', label: 'Card' },
  'Wallet': { color: '#8B5CF6', bgColor: 'rgba(139, 92, 246, 0.12)', label: 'Wallet' },
}

/** Get color for a payment mode */
export function getPaymentColor(mode: string): string {
  return PAYMENT_COLORS[mode]?.color ?? '#64748B'
}

/** Get bg color for a payment mode chip */
export function getPaymentBg(mode: string): string {
  return PAYMENT_COLORS[mode]?.bgColor ?? 'rgba(100, 116, 139, 0.12)'
}

/** Get full meta for a payment mode */
export function getPaymentMeta(mode: string): PaymentMeta {
  return PAYMENT_COLORS[mode] ?? PAYMENT_COLORS['Other']
}

/** Get full meta for account type */
export function getAccountTypeMeta(type: string): PaymentMeta {
  return ACCOUNT_TYPE_COLORS[type] ?? ACCOUNT_TYPE_COLORS['Bank']
}
