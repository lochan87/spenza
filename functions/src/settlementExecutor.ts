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

export async function executeTrustedSettlePersonAllDues(
  db: Firestore,
  uid: string,
  input: z.infer<typeof settlePersonAllDuesSchema>
): Promise<SettlePersonAllDuesResult> {
  const { personId, idempotencyKey, maxTransactions } = input
  const receiptRef = db.doc(`users/${uid}/repaymentReceipts/${idempotencyKey}`)
  const receiptSnap = await receiptRef.get()

  if (receiptSnap.exists) {
    const r = receiptSnap.data()
    if (r?.mode !== 'personAllDues' || r?.personId !== personId) {
      throw new HttpsError('already-exists', 'Idempotency key was already used for a different settlement request.')
    }
    return {
      settledCount: r.settledCount ?? 0,
      totalSettledPaise: r.totalSettledPaise ?? 0,
      updatedTxns: r.updatedTxns ?? [],
      complete: r.complete ?? true,
      replayed: true,
      failedTransactionId: r.failedTransactionId ?? null,
      error: r.error ?? null,
    }
  }

  const txColl = db.collection(`users/${uid}/transactions`)
  const snap = await txColl.get()

  const matchingDocs = snap.docs.filter(d => {
    const data = d.data() as Transaction
    const splits = getNormalizedSplits(data)
    const share = splits.find(
      s =>
        s.personId === personId ||
        (s.personId === UNASSIGNED_PERSON_ID && s.personName.toLowerCase() === personId.toLowerCase())
    )
    return share && share.amountPaise > share.repaidPaise
  })

  if (matchingDocs.length === 0) {
    const emptyResult: SettlePersonAllDuesResult = {
      settledCount: 0,
      totalSettledPaise: 0,
      updatedTxns: [],
      complete: true,
      replayed: false,
    }
    await receiptRef.set({
      idempotencyKey,
      mode: 'personAllDues',
      personId,
      settledCount: 0,
      totalSettledPaise: 0,
      updatedTxns: [],
      complete: true,
      createdAt: FieldValue.serverTimestamp(),
    })
    return emptyResult
  }

  const limit = Math.min(maxTransactions ?? 50, 100)
  const toProcess = matchingDocs.slice(0, limit)
  const hasRemainingAfterLimit = matchingDocs.length > limit

  let totalSettled = 0
  const updatedTxns: Transaction[] = []
  let failedTxId: string | null = null
  let failureError: string | null = null

  for (const docSnap of toProcess) {
    try {
      const res = await db.runTransaction(async txn => {
        const txRef = docSnap.ref
        const currentSnap = await txn.get(txRef)
        if (!currentSnap.exists) {
          throw new Error(`Transaction "${docSnap.id}" not found`)
        }
        const currentTx = { id: currentSnap.id, ...currentSnap.data() } as Transaction
        const update = applyFullSettlement(currentTx, personId, Timestamp.now())
        const newRecoverable = getRecoverablePaise({ ...currentTx, splits: update.splits })

        if (update.settledPaise > 0) {
          txn.update(txRef, {
            recoverablePaise: newRecoverable,
            splits: update.splits,
            reimbursementStatus: update.reimbursementStatus,
            updatedAt: FieldValue.serverTimestamp(),
          })
          txn.delete(db.doc(`users/${uid}/insights/summary`))
        }

        return {
          tx: {
            ...currentTx,
            recoverablePaise: newRecoverable,
            splits: update.splits,
            reimbursementStatus: update.reimbursementStatus,
          },
          settledPaise: update.settledPaise,
        }
      })

      if (res.settledPaise > 0) {
        totalSettled += res.settledPaise
        updatedTxns.push(res.tx)
      }
    } catch (err: any) {
      failedTxId = docSnap.id
      failureError = err?.message || 'Settlement failed for transaction'
      break
    }
  }

  const isComplete = !hasRemainingAfterLimit && !failedTxId

  await receiptRef.set({
    idempotencyKey,
    mode: 'personAllDues',
    personId,
    settledCount: updatedTxns.length,
    totalSettledPaise: totalSettled,
    updatedTxns,
    complete: isComplete,
    failedTransactionId: failedTxId,
    error: failureError,
    createdAt: FieldValue.serverTimestamp(),
  })

  if (failedTxId && updatedTxns.length === 0) {
    throw new HttpsError('failed-precondition', failureError!, {
      settledCount: 0,
      totalSettledPaise: 0,
      updatedTxns: [],
      failedTransactionId: failedTxId,
    })
  }

  return {
    settledCount: updatedTxns.length,
    totalSettledPaise: totalSettled,
    updatedTxns,
    complete: isComplete,
    replayed: false,
    failedTransactionId: failedTxId,
    error: failureError,
  }
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
