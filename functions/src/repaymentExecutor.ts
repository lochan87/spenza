import { z } from 'zod'
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import { applyRepayment, getRecoverablePaise } from '../../src/utils/splitMath.ts'
import type { Transaction } from '../../src/types/index.ts'

export const repaymentRequestSchema = z
  .object({
    transactionId: z
      .string()
      .trim()
      .min(1, 'Transaction ID cannot be empty')
      .max(200, 'Transaction ID is too long'),
    personId: z
      .string()
      .trim()
      .min(1, 'Person ID cannot be empty')
      .max(200, 'Person ID is too long'),
    repaymentPaise: z
      .number()
      .int('Repayment amount must be an integer')
      .positive('Repayment amount must be greater than zero'),
    idempotencyKey: z
      .string()
      .trim()
      .min(1, 'Idempotency key cannot be empty')
      .max(200, 'Idempotency key is too long'),
  })
  .strict()

export type RepaymentRequest = z.infer<typeof repaymentRequestSchema>

export interface RepaymentExecutionResult {
  tx: Transaction
  appliedPaise: number
  replayed: boolean
}

/**
 * Executes a trusted split repayment within an Admin SDK transaction.
 *
 * Invariants enforced:
 * 1. Owner isolation: Caller UID is verified and all operations run under users/{uid}/.
 * 2. Idempotency: Duplicate calls with the same key replay the previous result without double counting.
 * 3. Key conflict: Reusing the same key with different payload details is rejected.
 * 4. Exact accounting: Integer-paise invariants are preserved; cannot exceed outstanding dues.
 * 5. Multi-action atomicity: Expense update, receipt creation, and insights cache invalidation commit together.
 */
export async function executeTrustedRepayment(
  db: Firestore,
  uid: string,
  input: unknown
): Promise<RepaymentExecutionResult> {
  if (!uid || typeof uid !== 'string' || uid.trim() === '') {
    throw new HttpsError('unauthenticated', 'Sign in before recording repayments.')
  }

  const parsed = repaymentRequestSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const message = issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid request payload.'
    throw new HttpsError('invalid-argument', message)
  }

  const { transactionId, personId, repaymentPaise, idempotencyKey } = parsed.data
  const receiptRef = db.doc(`users/${uid}/repaymentReceipts/${idempotencyKey}`)
  const txRef = db.doc(`users/${uid}/transactions/${transactionId}`)
  const insightsRef = db.doc(`users/${uid}/insights/summary`)

  return await db.runTransaction(async txn => {
    const receiptSnap = await txn.get(receiptRef)
    const txSnap = await txn.get(txRef)

    if (receiptSnap.exists) {
      const receiptData = receiptSnap.data()
      if (
        receiptData?.transactionId !== transactionId ||
        receiptData?.personId !== personId ||
        receiptData?.repaymentPaise !== repaymentPaise
      ) {
        throw new HttpsError('already-exists', 'Idempotency key was already used for a different repayment request.')
      }

      if (txSnap.exists) {
        return {
          tx: { id: txSnap.id, ...txSnap.data() } as Transaction,
          appliedPaise: receiptData.appliedPaise ?? repaymentPaise,
          replayed: true,
        }
      }

      return {
        tx: receiptData.tx as Transaction,
        appliedPaise: receiptData.appliedPaise ?? repaymentPaise,
        replayed: true,
      }
    }

    if (!txSnap.exists) {
      throw new HttpsError('not-found', `Transaction "${transactionId}" not found.`)
    }

    const currentTx = { id: txSnap.id, ...txSnap.data() } as Transaction

    let update: ReturnType<typeof applyRepayment>
    try {
      update = applyRepayment(currentTx, personId, repaymentPaise, Timestamp.now())
    } catch (err: any) {
      const msg = err?.message || 'Failed to apply repayment'
      if (msg.includes('already fully repaid')) {
        throw new HttpsError('failed-precondition', msg)
      }
      if (msg.includes('exceeds outstanding balance')) {
        throw new HttpsError('invalid-argument', msg)
      }
      if (msg.includes('No split share found')) {
        throw new HttpsError('not-found', msg)
      }
      if (msg.includes('no recoverable split shares')) {
        throw new HttpsError('failed-precondition', msg)
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

    txn.update(txRef, {
      recoverablePaise: newRecoverable,
      splits: update.splits,
      reimbursementStatus: update.reimbursementStatus,
      updatedAt: FieldValue.serverTimestamp(),
    })

    txn.set(receiptRef, {
      idempotencyKey,
      transactionId,
      personId,
      repaymentPaise,
      appliedPaise: update.appliedPaise,
      reimbursementStatus: update.reimbursementStatus,
      recoverablePaise: newRecoverable,
      createdAt: FieldValue.serverTimestamp(),
      tx: updatedTxData,
    })

    txn.delete(insightsRef)

    return {
      tx: updatedTxData,
      appliedPaise: update.appliedPaise,
      replayed: false,
    }
  })
}
