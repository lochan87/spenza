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
export function getNormalizedSplits(tx: SplitAwareTransaction): SplitShare[] {
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
        existing.amountPaise += shareAmount
        existing.repaidPaise = Math.min(
          existing.amountPaise,
          existing.repaidPaise + repaidAmount
        )
        existing.settledAt = raw.settledAt ?? existing.settledAt ?? null
      } else {
        byPerson.set(personId, {
          personId,
          personName,
          amountPaise: shareAmount,
          repaidPaise: repaidAmount,
          settledAt: raw.settledAt ?? null,
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
export function getRecoverablePaise(tx: SplitAwareTransaction): number {
  return getNormalizedSplits(tx).reduce((sum, s) => sum + s.amountPaise, 0)
}

/**
 * Net personal spending in integer paise (`amountPaise - recoverablePaise`).
 * Repayments do not alter `getNetSpendPaise(tx)`.
 * Always satisfies: `getNetSpendPaise(tx) + getRecoverablePaise(tx) === toNonNegativeIntPaise(tx.amountPaise)`.
 */
export function getNetSpendPaise(tx: SplitAwareTransaction): number {
  const gross = toNonNegativeIntPaise(tx.amountPaise)
  return gross - getRecoverablePaise(tx)
}

/**
 * Total integer paise repaid so far across all split shares.
 * Always satisfies: `0 <= getRepaidPaise(tx) <= getRecoverablePaise(tx)`.
 */
export function getRepaidPaise(tx: SplitAwareTransaction): number {
  return getNormalizedSplits(tx).reduce((sum, s) => sum + s.repaidPaise, 0)
}

/**
 * Outstanding integer paise still owed to the user on this transaction.
 * Always satisfies: `getRepaidPaise(tx) + getPendingRecoverablePaise(tx) === getRecoverablePaise(tx)`.
 */
export function getPendingRecoverablePaise(tx: SplitAwareTransaction): number {
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
export function getReimbursementStatus(tx: SplitAwareTransaction): ReimbursementStatus {
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
  existingRepaidByPerson?: ReadonlyMap<string, number>
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
    return allocateCustomMyShareSplitPaise(gross, 0, validParticipants, existingRepaidByPerson)
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

    return {
      personId,
      personName,
      amountPaise: perFriendPaise,
      repaidPaise,
      settledAt: null,
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
  existingRepaidByPerson?: ReadonlyMap<string, number>
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

    splits.push({
      personId,
      personName,
      amountPaise: shareAmount,
      repaidPaise,
      settledAt: null,
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

