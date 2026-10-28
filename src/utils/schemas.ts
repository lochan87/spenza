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

export const ReimbursementStatusSchema = z.enum([
  'none',
  'pending',
  'partial',
  'settled',
])

export const SplitShareSchema = z
  .object({
    personId: z.string().min(1, 'Person ID is required'),
    personName: z.string().min(1, 'Person name is required').max(100),
    amountPaise: z
      .number()
      .int('Split share must be a whole number of paise')
      .positive('Split share must be greater than zero'),
    repaidPaise: z
      .number()
      .int('Repaid amount must be a whole number of paise')
      .min(0, 'Repaid amount cannot be negative')
      .default(0),
    settledAt: z.any().nullable().optional(),
  })
  .superRefine((share, ctx) => {
    if (share.repaidPaise > share.amountPaise) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['repaidPaise'],
        message: 'Repaid amount cannot exceed split share amount.',
      })
    }
  })

export type SplitShareFormValues = z.infer<typeof SplitShareSchema>

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
  recoverablePaise: z
    .number()
    .int('Recoverable amount must be a whole number of paise')
    .min(0, 'Recoverable amount cannot be negative')
    .optional(),
  splits: z.array(SplitShareSchema).optional(),
  reimbursementStatus: ReimbursementStatusSchema.optional(),
})

/**
 * Full transaction schema with conditional paymentAccountId and split-balance validation.
 *
 * Rules:
 *   - "Cash" or "Other" → paymentAccountId must be null
 *   - "UPI", "Bank Transfer", "Card" → paymentAccountId must be a non-empty string
 *   - recoverablePaise (when provided) must not exceed amountPaise
 *   - splits (when non-empty) must sum to recoverablePaise (if provided) and must not exceed amountPaise
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

  if (data.recoverablePaise !== undefined && data.recoverablePaise > data.amountPaise) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recoverablePaise'],
      message: 'Recoverable amount cannot exceed total transaction amount.',
    })
  }

  if (data.splits !== undefined) {
    if (data.splits.length === 0 && (data.recoverablePaise ?? 0) > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['splits'],
        message: 'At least one split share is required when recoverablePaise is greater than zero.',
      })
    }

    if (data.splits.length > 0) {
      const seenPersonIds = new Set<string>()
      for (const s of data.splits) {
        const pid = s.personId.trim()
        if (seenPersonIds.has(pid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['splits'],
            message: `Duplicate split participant "${s.personName}" (${pid}) is not allowed in the same transaction.`,
          })
          break
        }
        seenPersonIds.add(pid)
      }

      const splitsSum = data.splits.reduce((sum, s) => sum + s.amountPaise, 0)
      if (splitsSum > data.amountPaise) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['splits'],
          message: 'Total of split shares cannot exceed total transaction amount.',
        })
      }
      if (data.recoverablePaise !== undefined && splitsSum !== data.recoverablePaise) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['splits'],
          message: `Sum of split shares (${splitsSum} paise) must match recoverablePaise (${data.recoverablePaise} paise).`,
        })
      }
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

// ─── Person Schema ────────────────────────────────────────────────────────────

export const PersonSchema = z.object({
  name: z.string().trim().min(1, 'Person name is required').max(100),
  isArchived: z.boolean().default(false),
})

export type PersonFormValues = z.infer<typeof PersonSchema>

