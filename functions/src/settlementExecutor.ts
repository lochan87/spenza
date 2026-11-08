import { z } from 'zod'
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import {
  applyFullSettlement,
  getRecoverablePaise,
  getNormalizedSplits,
  UNASSIGNED_PERSON_ID,
} from '../../src/utils/splitMath.ts'
import type { Transaction } from '../../src/types/index.ts'

export const settleSplitShareSchema = z
  .object({
    mode: z.literal('splitShare'),
    transactionId: z.string().trim().min(1, 'Transaction ID cannot be empty').max(200),
    personId: z.string().trim().min(1, 'Person ID cannot be empty').max(200),
    idempotencyKey: z.string().trim().min(1, 'Idempotency key cannot be empty').max(200),
  })
  .strict()

export const settleAllTransactionSplitsSchema = z
  .object({
    mode: z.literal('transactionSplits'),
    transactionId: z.string().trim().min(1, 'Transaction ID cannot be empty').max(200),
    idempotencyKey: z.string().trim().min(1, 'Idempotency key cannot be empty').max(200),
  })
  .strict()

export const settlePersonAllDuesSchema = z
  .object({
    mode: z.literal('personAllDues'),
    personId: z.string().trim().min(1, 'Person ID cannot be empty').max(200),
    idempotencyKey: z.string().trim().min(1, 'Idempotency key cannot be empty').max(200),
    maxTransactions: z.number().int().positive().max(100).optional(),
  })
  .strict()

export const settlementRequestSchema = z.discriminatedUnion('mode', [
  settleSplitShareSchema,
  settleAllTransactionSplitsSchema,
  settlePersonAllDuesSchema,
])

export type SettlementRequest = z.infer<typeof settlementRequestSchema>

export interface SettleSplitShareResult {
  tx: Transaction
  settledPaise: number
  replayed: boolean
}

export interface SettleAllTransactionSplitsResult {
  tx: Transaction
  settledPaise: number
  replayed: boolean
}

export interface SettlePersonAllDuesResult {
  settledCount: number
  totalSettledPaise: number
  updatedTxns: Transaction[]
  complete: boolean
  replayed: boolean
  failedTransactionId?: string | null
  error?: string | null
}

export async function executeTrustedSettleSplitShare(
  db: Firestore,
  uid: string,
  input: z.infer<typeof settleSplitShareSchema>
): Promise<SettleSplitShareResult> {
  const { transactionId, personId, idempotencyKey } = input
  const receiptRef = db.doc(`users/${uid}/repaymentReceipts/${idempotencyKey}`)
  const txRef = db.doc(`users/${uid}/transactions/${transactionId}`)
  const insightsRef = db.doc(`users/${uid}/insights/summary`)

  return await db.runTransaction(async txn => {
    const receiptSnap = await txn.get(receiptRef)
    const txSnap = await txn.get(txRef)

    if (receiptSnap.exists) {
      const receiptData = receiptSnap.data()
      if (
        receiptData?.mode !== 'splitShare' ||
        receiptData?.transactionId !== transactionId ||
        receiptData?.personId !== personId
      ) {
        throw new HttpsError('already-exists', 'Idempotency key was already used for a different settlement request.')
      }

      if (txSnap.exists) {
        return {
          tx: { id: txSnap.id, ...txSnap.data() } as Transaction,
          settledPaise: receiptData.settledPaise ?? 0,
          replayed: true,
        }
      }

      return {
        tx: receiptData.tx as Transaction,
        settledPaise: receiptData.settledPaise ?? 0,
        replayed: true,
      }
    }

    if (!txSnap.exists) {
      throw new HttpsError('not-found', `Transaction "${transactionId}" not found.`)
    }

    const currentTx = { id: txSnap.id, ...txSnap.data() } as Transaction

    let update: ReturnType<typeof applyFullSettlement>
    try {
      update = applyFullSettlement(currentTx, personId, Timestamp.now())
    } catch (err: any) {
      const msg = err?.message || 'Failed to settle split share'
      if (msg.includes('No split share found')) {
        throw new HttpsError('not-found', msg)
      }
      throw new HttpsError('invalid-argument', msg)
    }

    const newRecoverable = getRecoverablePaise({ ...currentTx, splits: update.splits })
    const updatedTxData: Transaction = {
      ...currentTx,
      recoverablePaise: newRecoverable,
      splits: update.splits,
      reimbursementStatus: update.reimbursementStatus,
    }

    if (update.settledPaise > 0) {
      txn.update(txRef, {
        recoverablePaise: newRecoverable,
        splits: update.splits,
        reimbursementStatus: update.reimbursementStatus,
        updatedAt: FieldValue.serverTimestamp(),
      })
      txn.delete(insightsRef)
    }

    txn.set(receiptRef, {
      idempotencyKey,
      mode: 'splitShare',
      transactionId,
      personId,
      settledPaise: update.settledPaise,
      reimbursementStatus: update.reimbursementStatus,
      recoverablePaise: newRecoverable,
      createdAt: FieldValue.serverTimestamp(),
      tx: updatedTxData,
    })

    return {
      tx: updatedTxData,
      settledPaise: update.settledPaise,
      replayed: false,
    }
  })
}

export async function executeTrustedSettleAllTransactionSplits(
  db: Firestore,
  uid: string,
  input: z.infer<typeof settleAllTransactionSplitsSchema>
): Promise<SettleAllTransactionSplitsResult> {
  const { transactionId, idempotencyKey } = input
  const receiptRef = db.doc(`users/${uid}/repaymentReceipts/${idempotencyKey}`)
  const txRef = db.doc(`users/${uid}/transactions/${transactionId}`)
  const insightsRef = db.doc(`users/${uid}/insights/summary`)

  return await db.runTransaction(async txn => {
    const receiptSnap = await txn.get(receiptRef)
    const txSnap = await txn.get(txRef)

    if (receiptSnap.exists) {
      const receiptData = receiptSnap.data()
      if (
        receiptData?.mode !== 'transactionSplits' ||
        receiptData?.transactionId !== transactionId
      ) {
        throw new HttpsError('already-exists', 'Idempotency key was already used for a different settlement request.')
      }

      if (txSnap.exists) {
        return {
          tx: { id: txSnap.id, ...txSnap.data() } as Transaction,
          settledPaise: receiptData.settledPaise ?? 0,
          replayed: true,
        }
      }

      return {
        tx: receiptData.tx as Transaction,
        settledPaise: receiptData.settledPaise ?? 0,
        replayed: true,
      }
    }

    if (!txSnap.exists) {
      throw new HttpsError('not-found', `Transaction "${transactionId}" not found.`)
    }

    const currentTx = { id: txSnap.id, ...txSnap.data() } as Transaction
    const update = applyFullSettlement(currentTx, undefined, Timestamp.now())
    const newRecoverable = getRecoverablePaise({ ...currentTx, splits: update.splits })
    const updatedTxData: Transaction = {
      ...currentTx,
      recoverablePaise: newRecoverable,
      splits: update.splits,
      reimbursementStatus: update.reimbursementStatus,
    }

    if (update.settledPaise > 0) {
      txn.update(txRef, {
        recoverablePaise: newRecoverable,
        splits: update.splits,
        reimbursementStatus: update.reimbursementStatus,
        updatedAt: FieldValue.serverTimestamp(),
      })
      txn.delete(insightsRef)
    }

    txn.set(receiptRef, {
      idempotencyKey,
      mode: 'transactionSplits',
      transactionId,
      settledPaise: update.settledPaise,
      reimbursementStatus: update.reimbursementStatus,
      recoverablePaise: newRecoverable,
      createdAt: FieldValue.serverTimestamp(),
      tx: updatedTxData,
    })

    return {
      tx: updatedTxData,
      settledPaise: update.settledPaise,
      replayed: false,
    }
  })
}

export interface SettlePersonAllDuesOptions {
  leaseDurationMs?: number
  pollTimeoutMs?: number
  pollIntervalMs?: number
}

export async function executeTrustedSettlePersonAllDues(
  db: Firestore,
  uid: string,
  input: z.infer<typeof settlePersonAllDuesSchema>,
  options?: SettlePersonAllDuesOptions
): Promise<SettlePersonAllDuesResult> {
  const { personId, idempotencyKey, maxTransactions } = input
  const receiptRef = db.doc(`users/${uid}/repaymentReceipts/${idempotencyKey}`)

  const leaseDurationMs = options?.leaseDurationMs ?? 60_000
  const pollTimeoutMs = options?.pollTimeoutMs ?? 15_000
  const pollIntervalMs = options?.pollIntervalMs ?? 150

  const startTime = Date.now()
  let assignedFencingToken = 1

  // 1. Upfront Atomic Reservation & Fencing
  while (true) {
    const reservation = await db.runTransaction(async txn => {
      const snap = await txn.get(receiptRef)
      if (!snap.exists) {
        txn.set(receiptRef, {
          idempotencyKey,
          mode: 'personAllDues',
          personId,
          status: 'in_progress',
          fencingToken: 1,
          leaseExpiresAt: Timestamp.fromMillis(Date.now() + leaseDurationMs),
          settledCount: 0,
          totalSettledPaise: 0,
          updatedTxns: [],
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        })
        return { type: 'acquired' as const, fencingToken: 1 }
      }

      const r = snap.data()!
      if (r.mode !== 'personAllDues' || r.personId !== personId) {
        throw new HttpsError('already-exists', 'Idempotency key was already used for a different settlement request.')
      }

      // Check if already completed (supports modern status: 'completed' and legacy receipts)
      if (r.status === 'completed' || (r.status !== 'in_progress' && r.settledCount !== undefined)) {
        return {
          type: 'replayed' as const,
          result: {
            settledCount: r.settledCount ?? 0,
            totalSettledPaise: r.totalSettledPaise ?? 0,
            updatedTxns: r.updatedTxns ?? [],
            complete: r.complete ?? true,
            replayed: true,
            failedTransactionId: r.failedTransactionId ?? null,
            error: r.error ?? null,
          },
        }
      }

      // Reservation is currently in_progress. Check if lease has expired.
      const expiresMillis =
        r.leaseExpiresAt instanceof Timestamp
          ? r.leaseExpiresAt.toMillis()
          : typeof r.leaseExpiresAt?.toMillis === 'function'
            ? r.leaseExpiresAt.toMillis()
            : typeof r.leaseExpiresAt === 'number'
              ? r.leaseExpiresAt
              : 0

      const now = Date.now()
      if (now >= expiresMillis) {
        // Lease expired! Previous runner timed out or crashed.
        // Bump fencing token to safely supersede any timed-out or zombie runner.
        const nextToken = (typeof r.fencingToken === 'number' ? r.fencingToken : 1) + 1
        txn.update(receiptRef, {
          status: 'in_progress',
          fencingToken: nextToken,
          leaseExpiresAt: Timestamp.fromMillis(now + leaseDurationMs),
          updatedAt: FieldValue.serverTimestamp(),
        })
        return { type: 'acquired' as const, fencingToken: nextToken }
      }

      // Lease is actively held by another runner
      return { type: 'wait' as const }
    })

    if (reservation.type === 'replayed') {
      return reservation.result
    }

    if (reservation.type === 'acquired') {
      assignedFencingToken = reservation.fencingToken
      break
    }

    // Reservation is actively held by another runner. Wait and poll.
    if (Date.now() - startTime >= pollTimeoutMs) {
      throw new HttpsError(
        'failed-precondition',
        'Settlement is currently in progress for this request. Please wait or retry shortly.'
      )
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }

  // 2. Query Candidate Dues
  const txColl = db.collection(`users/${uid}/transactions`)
  const candidateDocs = new Map<string, FirebaseFirestore.QueryDocumentSnapshot>()
  const queries = [
    txColl.where('reimbursementStatus', 'in', ['pending', 'partial']),
    txColl.where('type', '==', 'reimbursable'),
    txColl.where('personId', '==', personId),
  ]

  const snapshots = await Promise.all(queries.map(q => q.get()))
  for (const snap of snapshots) {
    for (const d of snap.docs) {
      candidateDocs.set(d.id, d)
    }
  }

  const matchingDocs = Array.from(candidateDocs.values()).filter(d => {
    const data = d.data() as Transaction
    const splits = getNormalizedSplits(data)
    const share = splits.find(
      s =>
        s.personId === personId ||
        (s.personId === UNASSIGNED_PERSON_ID && s.personName.toLowerCase() === personId.toLowerCase())
    )
    return share && share.amountPaise > share.repaidPaise
  })

  // Deterministic order: oldest transactions first (chronological settlement priority)
  matchingDocs.sort((a, b) => {
    const aData = a.data() as Transaction
    const bData = b.data() as Transaction
    const aSec = aData.date?.seconds ?? 0
    const bSec = bData.date?.seconds ?? 0
    if (aSec !== bSec) return aSec - bSec
    return a.id.localeCompare(b.id)
  })

  // 3. Handle Empty Dues
  if (matchingDocs.length === 0) {
    return await db.runTransaction(async txn => {
      const snap = await txn.get(receiptRef)
      if (!snap.exists) {
        throw new HttpsError('aborted', 'Settlement reservation receipt was missing.')
      }
      const existing = snap.data()!
      if (existing.mode !== 'personAllDues' || existing.personId !== personId) {
        throw new HttpsError('already-exists', 'Idempotency key was already used for a different settlement request.')
      }
      if (existing.fencingToken !== assignedFencingToken || existing.status !== 'in_progress') {
        throw new HttpsError('aborted', 'Settlement runner was fenced out by newer settlement runner.')
      }

      const settledCount = existing.settledCount ?? 0
      const totalSettledPaise = existing.totalSettledPaise ?? 0
      const updatedTxns = existing.updatedTxns ?? []

      txn.update(receiptRef, {
        status: 'completed',
        complete: true,
        settledCount,
        totalSettledPaise,
        updatedTxns,
        failedTransactionId: null,
        error: null,
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })

      return {
        settledCount,
        totalSettledPaise,
        updatedTxns,
        complete: true,
        replayed: false,
      }
    })
  }

  // 4. Process Candidate Dues with Fencing Guards
  const limit = Math.min(maxTransactions ?? 50, 100)
  const toProcess = matchingDocs.slice(0, limit)
  const hasRemainingAfterLimit = matchingDocs.length > limit

  let failedTxId: string | null = null
  let failureError: string | null = null

  for (const docSnap of toProcess) {
    try {
      await db.runTransaction(async txn => {
        const rSnap = await txn.get(receiptRef)
        if (!rSnap.exists) {
          throw new Error('Settlement reservation receipt was missing.')
        }
        const rData = rSnap.data()!
        if (rData.status !== 'in_progress' || rData.fencingToken !== assignedFencingToken) {
          throw new Error('Settlement runner was fenced out by newer settlement runner.')
        }

        const txRef = docSnap.ref
        const currentSnap = await txn.get(txRef)
        if (!currentSnap.exists) {
          throw new Error(`Transaction "${docSnap.id}" not found`)
        }
        const currentTx = { id: currentSnap.id, ...currentSnap.data() } as Transaction
        const update = applyFullSettlement(currentTx, personId, Timestamp.now())
        const newRecoverable = getRecoverablePaise({ ...currentTx, splits: update.splits })

        const updatedTx: Transaction = {
          ...currentTx,
          recoverablePaise: newRecoverable,
          splits: update.splits,
          reimbursementStatus: update.reimbursementStatus,
        }

        if (update.settledPaise > 0) {
          txn.update(txRef, {
            recoverablePaise: newRecoverable,
            splits: update.splits,
            reimbursementStatus: update.reimbursementStatus,
            updatedAt: FieldValue.serverTimestamp(),
          })
          txn.delete(db.doc(`users/${uid}/insights/summary`))

          const nextCount = (rData.settledCount ?? 0) + 1
          const nextTotal = (rData.totalSettledPaise ?? 0) + update.settledPaise
          const nextTxns = [...(rData.updatedTxns ?? []), updatedTx]

          txn.update(receiptRef, {
            settledCount: nextCount,
            totalSettledPaise: nextTotal,
            updatedTxns: nextTxns,
            updatedAt: FieldValue.serverTimestamp(),
          })
        }
      })
    } catch (err: any) {
      if (err?.message?.includes('fenced out')) {
        throw new HttpsError('aborted', 'Settlement execution was superseded by a newer request.')
      }
      failedTxId = docSnap.id
      failureError = err?.message || 'Settlement failed for transaction'
      break
    }
  }

  // 5. Atomic Finalization
  const isComplete = !hasRemainingAfterLimit && !failedTxId

  const finalResult = await db.runTransaction(async txn => {
    const snap = await txn.get(receiptRef)
    if (!snap.exists) {
      throw new HttpsError('aborted', 'Settlement reservation receipt was missing.')
    }
    const existing = snap.data()!
    if (existing.mode !== 'personAllDues' || existing.personId !== personId) {
      throw new HttpsError('already-exists', 'Idempotency key was already used for a different settlement request.')
    }
    if (existing.fencingToken !== assignedFencingToken || existing.status !== 'in_progress') {
      throw new HttpsError('aborted', 'Settlement runner was fenced out by newer settlement runner.')
    }

    const settledCount = existing.settledCount ?? 0
    const totalSettledPaise = existing.totalSettledPaise ?? 0
    const updatedTxns = existing.updatedTxns ?? []

    txn.update(receiptRef, {
      status: 'completed',
      complete: isComplete,
      failedTransactionId: failedTxId,
      error: failureError,
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

    return {
      settledCount,
      totalSettledPaise,
      updatedTxns,
      complete: isComplete,
      replayed: false,
      failedTransactionId: failedTxId,
      error: failureError,
    }
  })

  if (finalResult.failedTransactionId && finalResult.settledCount === 0) {
    throw new HttpsError('failed-precondition', finalResult.error || 'Settlement failed for transaction', {
      settledCount: 0,
      totalSettledPaise: 0,
      updatedTxns: [],
      failedTransactionId: finalResult.failedTransactionId,
    })
  }

  return finalResult
}

export async function executeTrustedSettlement(
  db: Firestore,
  uid: string,
  input: unknown
): Promise<SettleSplitShareResult | SettleAllTransactionSplitsResult | SettlePersonAllDuesResult> {
  if (!uid || typeof uid !== 'string' || uid.trim() === '') {
    throw new HttpsError('unauthenticated', 'Sign in before settling dues.')
  }

  const parsed = settlementRequestSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const message = issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid request payload.'
    throw new HttpsError('invalid-argument', message)
  }

  switch (parsed.data.mode) {
    case 'splitShare':
      return await executeTrustedSettleSplitShare(db, uid, parsed.data)
    case 'transactionSplits':
      return await executeTrustedSettleAllTransactionSplits(db, uid, parsed.data)
    case 'personAllDues':
      return await executeTrustedSettlePersonAllDues(db, uid, parsed.data)
  }
}
