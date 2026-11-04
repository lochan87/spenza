import type { ReimbursementStatus, SplitShare, Transaction, TransactionType } from '@/types'

export const UNASSIGNED_PERSON_ID = '__unassigned__'
export const UNASSIGNED_PERSON_NAME = 'Unassigned'

/** Minimal transaction shape required for split and net-spend calculations */
export type SplitAwareTransaction = Pick<
  Transaction,
  'amountPaise' | 'type' | 'recoverablePaise' | 'splits'
> & {
  personId?: string | null
  reimbursementStatus?: ReimbursementStatus
}

export interface SplitParticipantInput {
  personId: string
  personName: string
}

export interface SplitAllocationResult {
  totalPaise: number
  mySharePaise: number
  recoverablePaise: number
  splits: SplitShare[]
}

/**
 * Clamp and round any numeric input to a non-negative safe integer number of paise.
 */
export function toNonNegativeIntPaise(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}

function deduplicateParticipants(
  participants: ReadonlyArray<SplitParticipantInput>
): SplitParticipantInput[] {
  const seen = new Set<string>()
  const result: SplitParticipantInput[] = []
  for (const p of participants) {
    if (!p) continue
    const id = p.personId.trim()
    const name = p.personName.trim()
    if (!id && !name) continue
    const key = id || name
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ personId: id || key, personName: name || key })
  }
  return result
}

/**
 * Return the normalized per-person split shares for a transaction.
 *
 * Rules:
 * 1. If `tx.splits` is present and non-empty, sanitizes each share so `amountPaise` and
 *    `repaidPaise` are non-negative integers with `0 <= repaidPaise <= amountPaise`,
 *    merges any duplicate `personId` entries, and guarantees the cumulative `amountPaise`
 *    across shares never exceeds `tx.amountPaise`.
 * 2. If `tx.splits` is absent/empty but the transaction has a positive recoverable amount
 *    (either via `tx.recoverablePaise > 0` or legacy `tx.type === 'reimbursable'`),
 *    synthesizes a single fallback `SplitShare` using `tx.personId` (or "Unassigned").
 */
export function getNormalizedSplits(tx?: SplitAwareTransaction | null): SplitShare[] {
  if (!tx) return []
  const gross = toNonNegativeIntPaise(tx.amountPaise)
  if (gross === 0) return []

  if (Array.isArray(tx.splits) && tx.splits.length > 0) {
    const byPerson = new Map<string, SplitShare>()
    let remainingBudget = gross

    for (const raw of tx.splits) {
      if (!raw || remainingBudget <= 0) continue
      const shareAmount = Math.min(remainingBudget, toNonNegativeIntPaise(raw.amountPaise))
      if (shareAmount <= 0) continue

      const repaidAmount = Math.min(shareAmount, toNonNegativeIntPaise(raw.repaidPaise))
      const personId = raw.personId?.trim() || UNASSIGNED_PERSON_ID
      const personName =
        raw.personName?.trim() ||
        (personId === UNASSIGNED_PERSON_ID ? UNASSIGNED_PERSON_NAME : personId)

      const existing = byPerson.get(personId)
      if (existing) {
        const combinedAmount = existing.amountPaise + shareAmount
        const combinedRepaid = Math.min(
          combinedAmount,
          existing.repaidPaise + repaidAmount
        )
        existing.amountPaise = combinedAmount
        existing.repaidPaise = combinedRepaid
        // Stale timestamp hygiene: settledAt is valid ONLY when share is fully settled
        existing.settledAt =
          combinedRepaid === combinedAmount && combinedAmount > 0
            ? raw.settledAt ?? existing.settledAt ?? null
            : null
      } else {
        byPerson.set(personId, {
          personId,
          personName,
          amountPaise: shareAmount,
          repaidPaise: repaidAmount,
          settledAt:
            repaidAmount === shareAmount && shareAmount > 0 ? raw.settledAt ?? null : null,
        })
      }
      remainingBudget -= shareAmount
    }

    if (byPerson.size > 0) {
      return [...byPerson.values()]
    }
  }

  // Fallback for transactions without an explicit `splits` array
  let fallbackRecoverable = 0
  if (typeof tx.recoverablePaise === 'number' && Number.isFinite(tx.recoverablePaise)) {
    fallbackRecoverable = Math.min(gross, toNonNegativeIntPaise(tx.recoverablePaise))
  } else if (tx.type === 'reimbursable') {
    fallbackRecoverable = gross
  }

  if (fallbackRecoverable <= 0) return []

  const rawPerson = tx.personId?.trim() || ''
  const personId = rawPerson || UNASSIGNED_PERSON_ID
  const personName = rawPerson || UNASSIGNED_PERSON_NAME
  const isSettled = tx.reimbursementStatus === 'settled'

  return [
    {
      personId,
      personName,
      amountPaise: fallbackRecoverable,
      repaidPaise: isSettled ? fallbackRecoverable : 0,
      settledAt: null,
    },
  ]
}

/**
 * Total integer paise of `tx.amountPaise` owed back by other people.
 * Always satisfies: `0 <= getRecoverablePaise(tx) <= tx.amountPaise`
 * and `getRecoverablePaise(tx) === sum(getNormalizedSplits(tx).amountPaise)`.
 */
export function getRecoverablePaise(tx?: SplitAwareTransaction | null): number {
  if (!tx) return 0
  return getNormalizedSplits(tx).reduce((sum, s) => sum + s.amountPaise, 0)
}

/**
 * Net personal spending in integer paise (`amountPaise - recoverablePaise`).
 * Repayments do not alter `getNetSpendPaise(tx)`.
 * Always satisfies: `getNetSpendPaise(tx) + getRecoverablePaise(tx) === toNonNegativeIntPaise(tx.amountPaise)`.
 */
export function getNetSpendPaise(tx?: SplitAwareTransaction | null): number {
  if (!tx) return 0
  const gross = toNonNegativeIntPaise(tx.amountPaise)
  return gross - getRecoverablePaise(tx)
}

/**
 * Total integer paise repaid so far across all split shares.
 * Always satisfies: `0 <= getRepaidPaise(tx) <= getRecoverablePaise(tx)`.
 */
export function getRepaidPaise(tx?: SplitAwareTransaction | null): number {
  if (!tx) return 0
  return getNormalizedSplits(tx).reduce((sum, s) => sum + s.repaidPaise, 0)
}

/**
 * Outstanding integer paise still owed to the user on this transaction.
 * Always satisfies: `getRepaidPaise(tx) + getPendingRecoverablePaise(tx) === getRecoverablePaise(tx)`.
 */
export function getPendingRecoverablePaise(tx?: SplitAwareTransaction | null): number {
  if (!tx) return 0
  return getRecoverablePaise(tx) - getRepaidPaise(tx)
}

/**
 * Deterministically derive the reimbursement status of a transaction from its splits.
 *
 * - `'none'`: `recoverablePaise === 0`
 * - `'pending'`: `recoverablePaise > 0` and `repaidPaise === 0`
 * - `'partial'`: `0 < repaidPaise < recoverablePaise` (at least 1 paise remains unpaid)
 * - `'settled'`: `recoverablePaise > 0` and every split share has `repaidPaise === amountPaise`
 */
export function getReimbursementStatus(tx?: SplitAwareTransaction | null): ReimbursementStatus {
  if (!tx) return 'none'
  const splits = getNormalizedSplits(tx)
  const recoverable = splits.reduce((sum, s) => sum + s.amountPaise, 0)
  if (recoverable <= 0 || splits.length === 0) return 'none'

  const repaid = splits.reduce((sum, s) => sum + s.repaidPaise, 0)
  if (repaid <= 0) return 'pending'

  const allSharesSettled =
    repaid === recoverable && splits.every(s => s.repaidPaise === s.amountPaise)

  return allSharesSettled ? 'settled' : 'partial'
}

/**
 * Allocate `totalPaise` equally across `participants` (and optionally the user).
 *
 * - When `includeSelf = true` (default, for shared bills where the user is 1 of N+1 participants):
 *   Each other participant receives `Math.floor(totalPaise / (K + 1))` paise, and the user's share
 *   (`mySharePaise`) absorbs the remainder `totalPaise % (K + 1)` so that all friends see identical
 *   equal amounts and `mySharePaise + recoverablePaise === totalPaise`.
 *
 * - When `includeSelf = false` (100% recoverable bill fronted entirely for K participants):
 *   `mySharePaise = 0`, `recoverablePaise = totalPaise`, and any remainder `totalPaise % K` is
 *   distributed 1 paise at a time across the first `rem` participants.
 */
export function allocateEqualSplitPaise(
  totalPaise: number,
  participants: ReadonlyArray<SplitParticipantInput>,
  includeSelf = true,
  existingRepaidByPerson?: ReadonlyMap<string, number>,
  existingSettledAtByPerson?: ReadonlyMap<string, any>
): SplitAllocationResult {
  const gross = toNonNegativeIntPaise(totalPaise)
  const validParticipants = deduplicateParticipants(participants)
  const k = validParticipants.length

  if (gross === 0 || k === 0) {
    return {
      totalPaise: gross,
      mySharePaise: gross,
      recoverablePaise: 0,
      splits: [],
    }
  }

  if (!includeSelf) {
    return allocateCustomMyShareSplitPaise(
      gross,
      0,
      validParticipants,
      existingRepaidByPerson,
      existingSettledAtByPerson
    )
  }

  const totalPeopleCount = k + 1
  const perFriendPaise = Math.floor(gross / totalPeopleCount)

  // Edge case: gross > 0 but smaller than totalPeopleCount (e.g. 2 paise split 4 ways)
  if (perFriendPaise === 0) {
    return {
      totalPaise: gross,
      mySharePaise: gross,
      recoverablePaise: 0,
      splits: [],
    }
  }

  const splits: SplitShare[] = validParticipants.map(p => {
    const personId = p.personId.trim() || UNASSIGNED_PERSON_ID
    const personName = p.personName.trim() || UNASSIGNED_PERSON_NAME
    const prevRepaid = existingRepaidByPerson?.get(personId) ?? 0
    const repaidPaise = Math.min(perFriendPaise, toNonNegativeIntPaise(prevRepaid))
    const isSettled = repaidPaise === perFriendPaise && perFriendPaise > 0
    const settledAt = isSettled ? (existingSettledAtByPerson?.get(personId) ?? null) : null

    return {
      personId,
      personName,
      amountPaise: perFriendPaise,
      repaidPaise,
      settledAt,
    }
  })

  const recoverablePaise = perFriendPaise * k
  const mySharePaise = gross - recoverablePaise

  return {
    totalPaise: gross,
    mySharePaise,
    recoverablePaise,
    splits,
  }
}

/**
 * Allocate a bill of `totalPaise` where the user specifies their own exact `mySharePaise`,
 * and the remaining `recoverablePaise = totalPaise - mySharePaise` is divided across `participants`
 * in exact integer paise (distributing any remainder 1 paise at a time to the first `rem` participants).
 *
 * Guarantees:
 * - `mySharePaise + recoverablePaise === totalPaise`
 * - `sum(splits.map(s => s.amountPaise)) === recoverablePaise`
 */
export function allocateCustomMyShareSplitPaise(
  totalPaise: number,
  mySharePaise: number,
  participants: ReadonlyArray<SplitParticipantInput>,
  existingRepaidByPerson?: ReadonlyMap<string, number>,
  existingSettledAtByPerson?: ReadonlyMap<string, any>
): SplitAllocationResult {
  const gross = toNonNegativeIntPaise(totalPaise)
  const clampedMyShare = Math.min(gross, toNonNegativeIntPaise(mySharePaise))
  const validParticipants = deduplicateParticipants(participants)
  const k = validParticipants.length
  const targetRecoverable = gross - clampedMyShare

  if (gross === 0 || k === 0 || targetRecoverable <= 0) {
    return {
      totalPaise: gross,
      mySharePaise: gross,
      recoverablePaise: 0,
      splits: [],
    }
  }

  const baseShare = Math.floor(targetRecoverable / k)
  const remainder = targetRecoverable % k

  const splits: SplitShare[] = []
  for (let i = 0; i < k; i++) {
    const shareAmount = baseShare + (i < remainder ? 1 : 0)
    if (shareAmount <= 0) continue

    const p = validParticipants[i]
    const personId = p.personId.trim() || UNASSIGNED_PERSON_ID
    const personName = p.personName.trim() || UNASSIGNED_PERSON_NAME
    const prevRepaid = existingRepaidByPerson?.get(personId) ?? 0
    const repaidPaise = Math.min(shareAmount, toNonNegativeIntPaise(prevRepaid))
    const isSettled = repaidPaise === shareAmount && shareAmount > 0
    const settledAt = isSettled ? (existingSettledAtByPerson?.get(personId) ?? null) : null

    splits.push({
      personId,
      personName,
      amountPaise: shareAmount,
      repaidPaise,
      settledAt,
    })
  }

  const recoverablePaise = splits.reduce((sum, s) => sum + s.amountPaise, 0)
  const finalMyShare = gross - recoverablePaise

  return {
    totalPaise: gross,
    mySharePaise: finalMyShare,
    recoverablePaise,
    splits,
  }
}

export type TransactionTypeWithSplits = TransactionType

export interface RepaymentResult {
  splits: SplitShare[]
  reimbursementStatus: ReimbursementStatus
  appliedPaise: number
  remainingPersonBalancePaise: number
}

export interface SettlementResult {
  splits: SplitShare[]
  reimbursementStatus: ReimbursementStatus
  settledPaise: number
}

/**
 * Apply a repayment of `repaymentPaise` (integer paise) from `personId` to an existing transaction.
 *
 * Guarantees:
 * - Throws if `repaymentPaise <= 0` or non-integer.
 * - Throws if `personId` is not found among the transaction's split shares.
 * - Throws if `repaymentPaise` exceeds the person's remaining balance (`amountPaise - repaidPaise`).
 * - Updates only the target person's `repaidPaise` and `settledAt`.
 * - Does not mutate the input transaction object.
 * - Leaves all other split shares, gross `amountPaise`, and net personal spend completely unchanged.
 */
export function applyRepayment(
  tx: SplitAwareTransaction,
  personId: string,
  repaymentPaise: number,
  settledAt?: any
): RepaymentResult {
  if (typeof repaymentPaise !== 'number' || !Number.isInteger(repaymentPaise) || repaymentPaise <= 0) {
    throw new Error('Repayment amount must be a positive integer number of paise')
  }

  const pid = personId?.trim()
  if (!pid) {
    throw new Error('Person ID is required for recording a repayment')
  }

  const splits = getNormalizedSplits(tx)
  if (splits.length === 0) {
    throw new Error('Transaction has no recoverable split shares')
  }

  const targetIndex = splits.findIndex(
    s =>
      s.personId === pid ||
      (s.personId === UNASSIGNED_PERSON_ID && s.personName.toLowerCase() === pid.toLowerCase())
  )

  if (targetIndex === -1) {
    throw new Error(`No split share found for person "${pid}" on this transaction`)
  }

  const target = splits[targetIndex]
  const outstanding = target.amountPaise - target.repaidPaise
  if (outstanding <= 0) {
    throw new Error(`Split share for "${target.personName}" is already fully repaid`)
  }

  if (repaymentPaise > outstanding) {
    throw new Error(
      `Repayment of ${repaymentPaise} paise exceeds outstanding balance of ${outstanding} paise for "${target.personName}"`
    )
  }

  const updatedSplits = splits.map((s, idx) => {
    if (idx !== targetIndex) return { ...s }

    const newRepaid = s.repaidPaise + repaymentPaise
    const isNowSettled = newRepaid === s.amountPaise

    return {
      ...s,
      repaidPaise: newRepaid,
      settledAt: isNowSettled ? (settledAt ?? s.settledAt ?? null) : s.settledAt,
    }
  })

  const newStatus = getReimbursementStatus({ ...tx, splits: updatedSplits })

  return {
    splits: updatedSplits,
    reimbursementStatus: newStatus,
    appliedPaise: repaymentPaise,
    remainingPersonBalancePaise: outstanding - repaymentPaise,
  }
}

/**
 * Settle the entire remaining balance for `personId` (or all participants if `personId` is omitted).
 *
 * Guarantees:
 * - If already fully settled, returns 0 settled paise without error.
 * - Does not mutate the input transaction object.
 * - Derives the correct `reimbursementStatus`.
 */
export function applyFullSettlement(
  tx: SplitAwareTransaction,
  personId?: string,
  settledAt?: any
): SettlementResult {
  const pid = personId?.trim()

  if (pid) {
    const splits = getNormalizedSplits(tx)
    const target = splits.find(
      s =>
        s.personId === pid ||
        (s.personId === UNASSIGNED_PERSON_ID && s.personName.toLowerCase() === pid.toLowerCase())
    )

    if (!target) {
      throw new Error(`No split share found for person "${pid}" on this transaction`)
    }

    const outstanding = target.amountPaise - target.repaidPaise
    if (outstanding <= 0) {
      return {
        splits,
        reimbursementStatus: getReimbursementStatus(tx),
        settledPaise: 0,
      }
    }

    const res = applyRepayment(tx, pid, outstanding, settledAt)
    return {
      splits: res.splits,
      reimbursementStatus: res.reimbursementStatus,
      settledPaise: res.appliedPaise,
    }
  }

  // Settle all participants in this transaction
  const splits = getNormalizedSplits(tx)
  if (splits.length === 0) {
    return {
      splits: [],
      reimbursementStatus: 'none',
      settledPaise: 0,
    }
  }

  let totalSettled = 0
  const updatedSplits = splits.map(s => {
    const outstanding = s.amountPaise - s.repaidPaise
    if (outstanding > 0) {
      totalSettled += outstanding
      return {
        ...s,
        repaidPaise: s.amountPaise,
        settledAt: settledAt ?? s.settledAt ?? null,
      }
    }
    return { ...s }
  })

  const newStatus = getReimbursementStatus({ ...tx, splits: updatedSplits })

  return {
    splits: updatedSplits,
    reimbursementStatus: newStatus,
    settledPaise: totalSettled,
  }
}

// ─── Query & Verification Helpers ─────────────────────────────────────────────

/**
 * Check if a transaction has split or recoverable components.
 */
export function isSplitOrRecoverable(tx?: SplitAwareTransaction | null): boolean {
  if (!tx) return false
  return getRecoverablePaise(tx) > 0 || tx.type === 'reimbursable'
}

/**
 * Retrieve the split share belonging to a person on a transaction.
 * Supports ID-based matching and name-based fallback (for unassigned legacy splits).
 */
export function getPersonShare(
  tx?: SplitAwareTransaction | null,
  personId?: string | null
): SplitShare | undefined {
  if (!tx || !personId) return undefined
  const pid = personId.trim()
  if (!pid) return undefined
  const splits = getNormalizedSplits(tx)
  return splits.find(
    s =>
      s.personId === pid ||
      (s.personId === UNASSIGNED_PERSON_ID && s.personName.toLowerCase() === pid.toLowerCase())
  )
}

/**
 * Recoverable amount in integer paise allocated to a specific person on a transaction.
 */
export function getPersonSharePaise(
  tx?: SplitAwareTransaction | null,
  personId?: string | null
): number {
  return getPersonShare(tx, personId)?.amountPaise ?? 0
}

/**
 * Amount in integer paise already repaid by a specific person on a transaction.
 */
export function getPersonRepaidPaise(
  tx?: SplitAwareTransaction | null,
  personId?: string | null
): number {
  return getPersonShare(tx, personId)?.repaidPaise ?? 0
}

/**
 * Outstanding amount in integer paise still owed by a specific person on a transaction.
 */
export function getPersonOutstandingPaise(
  tx?: SplitAwareTransaction | null,
  personId?: string | null
): number {
  const share = getPersonShare(tx, personId)
  if (!share) return 0
  return Math.max(0, share.amountPaise - share.repaidPaise)
}

export interface FinancialInvariantsReport {
  isValid: boolean
  grossPaise: number
  netSpendPaise: number
  recoverablePaise: number
  repaidPaise: number
  outstandingPaise: number
  reimbursementStatus: ReimbursementStatus
  errors: string[]
}

/**
 * Perform a rigorous audit of all mathematical and financial invariants on a transaction.
 *
 * Invariants checked:
 * 1. Gross = Net Spend + Recoverable (`gross === netSpend + recoverable`)
 * 2. Recoverable = Repaid + Outstanding (`recoverable === repaid + outstanding`)
 * 3. Bounded values: `0 <= netSpend <= gross`, `0 <= recoverable <= gross`, `0 <= repaid <= recoverable`, `0 <= outstanding <= recoverable`
 * 4. Split share integrity:
 *    - `sum(splits.map(s => s.amountPaise)) === recoverable`
 *    - `sum(splits.map(s => s.repaidPaise)) === repaid`
 *    - For each split share: `0 <= s.repaidPaise <= s.amountPaise`
 *    - Settled timestamp hygiene: `s.repaidPaise < s.amountPaise => s.settledAt === null`
 * 5. Deterministic status derivation matches `getReimbursementStatus(tx)`
 */
export function validateFinancialInvariants(
  tx?: SplitAwareTransaction | null
): FinancialInvariantsReport {
  const errors: string[] = []
  if (!tx) {
    return {
      isValid: true,
      grossPaise: 0,
      netSpendPaise: 0,
      recoverablePaise: 0,
      repaidPaise: 0,
      outstandingPaise: 0,
      reimbursementStatus: 'none',
      errors: [],
    }
  }

  const gross = toNonNegativeIntPaise(tx.amountPaise)
  const netSpend = getNetSpendPaise(tx)
  const recoverable = getRecoverablePaise(tx)
  const repaid = getRepaidPaise(tx)
  const outstanding = getPendingRecoverablePaise(tx)
  const status = getReimbursementStatus(tx)
  const splits = getNormalizedSplits(tx)

  // 1. Gross = Net Spend + Recoverable
  if (gross !== netSpend + recoverable) {
    errors.push(`Invariant violated: gross (${gross}) !== netSpend (${netSpend}) + recoverable (${recoverable})`)
  }

  // 2. Recoverable = Repaid + Outstanding
  if (recoverable !== repaid + outstanding) {
    errors.push(`Invariant violated: recoverable (${recoverable}) !== repaid (${repaid}) + outstanding (${outstanding})`)
  }

  // 3. Clamping bounds
  if (netSpend < 0 || netSpend > gross) {
    errors.push(`Out of bounds: netSpend (${netSpend}) must be between 0 and gross (${gross})`)
  }
  if (recoverable < 0 || recoverable > gross) {
    errors.push(`Out of bounds: recoverable (${recoverable}) must be between 0 and gross (${gross})`)
  }
  if (repaid < 0 || repaid > recoverable) {
    errors.push(`Out of bounds: repaid (${repaid}) must be between 0 and recoverable (${recoverable})`)
  }
  if (outstanding < 0 || outstanding > recoverable) {
    errors.push(`Out of bounds: outstanding (${outstanding}) must be between 0 and recoverable (${recoverable})`)
  }

  // 4. Split share integrity
  const sumSplitAmount = splits.reduce((s, item) => s + item.amountPaise, 0)
  const sumSplitRepaid = splits.reduce((s, item) => s + item.repaidPaise, 0)

  if (sumSplitAmount !== recoverable) {
    errors.push(`Split sum mismatch: sum(splits.amountPaise) (${sumSplitAmount}) !== recoverable (${recoverable})`)
  }
  if (sumSplitRepaid !== repaid) {
    errors.push(`Split sum mismatch: sum(splits.repaidPaise) (${sumSplitRepaid}) !== repaid (${repaid})`)
  }

  for (const s of splits) {
    if (s.amountPaise < 0 || !Number.isInteger(s.amountPaise)) {
      errors.push(`Participant "${s.personName}" has invalid amountPaise: ${s.amountPaise}`)
    }
    if (s.repaidPaise < 0 || !Number.isInteger(s.repaidPaise)) {
      errors.push(`Participant "${s.personName}" has invalid repaidPaise: ${s.repaidPaise}`)
    }
    if (s.repaidPaise > s.amountPaise) {
      errors.push(`Participant "${s.personName}" is overpaid: repaid ${s.repaidPaise} > amount ${s.amountPaise}`)
    }
    if (s.repaidPaise < s.amountPaise && s.settledAt != null) {
      errors.push(`Participant "${s.personName}" is unsettled (${s.repaidPaise}/${s.amountPaise}) but has settledAt: ${s.settledAt}`)
    }
  }

  return {
    isValid: errors.length === 0,
    grossPaise: gross,
    netSpendPaise: netSpend,
    recoverablePaise: recoverable,
    repaidPaise: repaid,
    outstandingPaise: outstanding,
    reimbursementStatus: status,
    errors,
  }
}



