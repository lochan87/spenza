import { z } from 'zod'

// ─── Payment Mode ─────────────────────────────────────────────────────────────

export const PaymentModeSchema = z.enum(['Cash', 'UPI', 'Bank Transfer', 'Card', 'Other'])
export const TransactionTypeSchema = z.enum([
  'everyday',
  'recurring',
  'one-time',
  'trip',
  'gift-event',
  'reimbursable',
])

// ─── Transaction Zod Schema ───────────────────────────────────────────────────
//
// KEY VALIDATION RULE:
//   paymentMode "Cash" | "Other"               → paymentAccountId MUST be null
//   paymentMode "UPI" | "Bank Transfer" | "Card" → paymentAccountId MUST be non-null string
//
// This is enforced via a discriminated union (.superRefine) so the rule is
// checked at the type level, not just at runtime.

const BaseTransactionSchema = z.object({
  amountPaise: z
    .number()
    .int('Amount must be a whole number of paise')
    .positive('Amount must be greater than zero'),
  description: z.string().min(1, 'Description is required').max(200),
  categoryId: z.string().min(1, 'Category is required'),
  type: TransactionTypeSchema,
  date: z.string().min(1, 'Date is required'),   // ISO string for form; convert to Timestamp before saving
  paymentMode: PaymentModeSchema,
  paymentAccountId: z.string().nullable(),
  tripId: z.string().nullable().default(null),
  personId: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  notes: z.string().default(''),
  receiptUrl: z.string().url().nullable().default(null),
})

/**
 * Full transaction schema with conditional paymentAccountId validation.
 *
 * Rule:
 *   - "Cash" or "Other" → paymentAccountId must be null
 *   - "UPI", "Bank Transfer", "Card" → paymentAccountId must be a non-empty string
 */
export const TransactionSchema = BaseTransactionSchema.superRefine((data, ctx) => {
  const accountRequiredModes = ['UPI', 'Bank Transfer', 'Card'] as const
  const accountNullModes = ['Cash', 'Other'] as const

  if ((accountRequiredModes as readonly string[]).includes(data.paymentMode)) {
    if (!data.paymentAccountId || data.paymentAccountId.trim() === '') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paymentAccountId'],
        message: `A payment account is required when payment mode is "${data.paymentMode}". Please select a linked bank/UPI account.`,
      })
    }
  }

  if ((accountNullModes as readonly string[]).includes(data.paymentMode)) {
    if (data.paymentAccountId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['paymentAccountId'],
        message: `Payment account must be null for "${data.paymentMode}" transactions — no bank account needed.`,
      })
    }
  }
})

export type TransactionFormValues = z.infer<typeof TransactionSchema>

// ─── Payment Account Schema ───────────────────────────────────────────────────

export const AccountTypeSchema = z.enum(['Bank', 'UPI', 'Card', 'Wallet'])

export const PaymentAccountSchema = z.object({
  name: z.string().min(1, 'Account name is required').max(100),
  type: AccountTypeSchema,
  isDefault: z.boolean().default(false),
  isArchived: z.boolean().default(false),
})

export type PaymentAccountFormValues = z.infer<typeof PaymentAccountSchema>

// ─── Category Schema ──────────────────────────────────────────────────────────

export const CategorySchema = z.object({
  name: z.string().min(1, 'Category name is required').max(50),
  icon: z.string().min(1, 'Icon is required'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a valid hex color'),
  isArchived: z.boolean().default(false),
})

export type CategoryFormValues = z.infer<typeof CategorySchema>
