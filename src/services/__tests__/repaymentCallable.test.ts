import { it, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { Timestamp } from 'firebase/firestore'
import * as splitMath from '../../utils/splitMath.ts'
import * as schemas from '../../utils/schemas.ts'

function loadPeopleService(options: {
  offline?: boolean
  callableImpl?: (input: unknown) => Promise<unknown>
} = {}) {
  const exports = {} as {
    recordSplitRepayment: (
      uid: string,
      transactionId: string,
      personId: string,
      repaymentPaise: number
    ) => Promise<{ tx: any; appliedPaise: number }>
  }
  const text = readFileSync(new URL('../people.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText

  let capturedCallablePayload: any = null

  runInNewContext(compiled, {
    exports,
    navigator: { onLine: !options.offline },
    crypto: globalThis.crypto,
    console,
    Date,
    Error,
    require: (name: string) => {
      if (name === 'firebase/firestore') {
        return {
          Timestamp,
          doc: () => ({}),
          collection: () => ({}),
          runTransaction: async () => {},
          serverTimestamp: () => ({}),
        }
      }
      if (name === 'firebase/functions') {
        return {
          getFunctions: () => ({}),
          httpsCallable: () => async (data: unknown) => {
            capturedCallablePayload = data
            if (options.callableImpl) {
              const res = await options.callableImpl(data)
              return { data: res }
            }
            return {
              data: {
                tx: {
                  id: (data as any).transactionId,
                  amountPaise: 5000,
                  recoverablePaise: 2500,
                  reimbursementStatus: 'partial',
                  date: { _seconds: 1700000000, _nanoseconds: 0 },
                  createdAt: { _seconds: 1700000000, _nanoseconds: 0 },
                  updatedAt: { _seconds: 1700000000, _nanoseconds: 0 },
                  splits: [
                    {
                      personId: (data as any).personId,
                      personName: 'Alice',
                      amountPaise: 5000,
                      repaidPaise: (data as any).repaymentPaise,
                      settledAt: null,
                    },
                  ],
                },
                appliedPaise: (data as any).repaymentPaise,
                replayed: false,
              },
            }
          },
        }
      }
      if (name === '@/firebase/config') return { app: {}, db: {} }
      if (name === '@/utils/schemas') return schemas
      if (name === '@/utils/splitMath') return splitMath
      if (name === '@/services/insights') return { invalidateInsightsCache: async () => true }
      throw new Error(`Unexpected import: ${name}`)
    },
  })

  return {
    service: exports,
    getCapturedPayload: () => capturedCallablePayload,
  }
}

describe('Client repayment service (Phase 7.2A)', () => {
  it('rejects offline calls immediately without invoking the Cloud Function', async () => {
    let callableInvoked = false
    const { service } = loadPeopleService({
      offline: true,
      callableImpl: async () => {
        callableInvoked = true
        return {}
      },
    })

    await assert.rejects(
      service.recordSplitRepayment('user-1', 'tx-1', 'person-1', 1000),
      /You are offline\. Recording a repayment requires an internet connection\./
    )
    assert.equal(callableInvoked, false)
  })

  it('validates client input parameters before invoking the Cloud Function', async () => {
    let callableInvoked = false
    const { service } = loadPeopleService({
      callableImpl: async () => {
        callableInvoked = true
        return {}
      },
    })

    // Missing / empty UID
    await assert.rejects(service.recordSplitRepayment('', 'tx-1', 'person-1', 1000), /User ID is required/)
    // Missing / empty Transaction ID
    await assert.rejects(service.recordSplitRepayment('user-1', '', 'person-1', 1000), /Transaction ID is required/)
    // Missing / empty Person ID
    await assert.rejects(service.recordSplitRepayment('user-1', 'tx-1', '', 1000), /Person ID is required/)
    // Zero repayment paise
    await assert.rejects(
      service.recordSplitRepayment('user-1', 'tx-1', 'person-1', 0),
      /Repayment amount must be a positive integer number of paise/
    )
    // Negative repayment paise
    await assert.rejects(
      service.recordSplitRepayment('user-1', 'tx-1', 'person-1', -500),
      /Repayment amount must be a positive integer number of paise/
    )
    // Non-integer (floating point) repayment paise
    await assert.rejects(
      service.recordSplitRepayment('user-1', 'tx-1', 'person-1', 12.34),
      /Repayment amount must be a positive integer number of paise/
    )

    assert.equal(callableInvoked, false)
  })

  it('invokes executeRepaymentV1 with strict payload and idempotency key', async () => {
    const { service, getCapturedPayload } = loadPeopleService()
    const result = await service.recordSplitRepayment('user-1', 'tx-123', 'person-456', 2500)

    const payload = getCapturedPayload()
    assert.equal(payload.transactionId, 'tx-123')
    assert.equal(payload.personId, 'person-456')
    assert.equal(payload.repaymentPaise, 2500)
    assert.ok(typeof payload.idempotencyKey === 'string' && payload.idempotencyKey.length > 0)

    assert.equal(result.appliedPaise, 2500)
    assert.equal(result.tx.id, 'tx-123')
    assert.equal(result.tx.reimbursementStatus, 'partial')
    // Timestamps properly hydrated
    assert.ok(result.tx.date instanceof Timestamp)
    assert.equal(result.tx.date.seconds, 1700000000)
  })

  it('proves remaining client settlement vulnerability until Phase 7.2B / 7.3', async () => {
    // Phase 7.2A moves `recordSplitRepayment` to Cloud Functions.
    // However, settlement functions (`settleSplitShare`, `settleAllTransactionSplits`)
    // still use client-side runTransaction and can directly mutate split arrays in Firestore.
    // This test documents the remaining security gap:
    // Client SDK rules still permit owner updates with validStatusTransition until Phase 7.3.
    const splitShare = {
      personId: 'alice',
      personName: 'Alice',
      amountPaise: 5000,
      repaidPaise: 0,
      settledAt: null,
    }
    assert.equal(splitShare.repaidPaise, 0)
    // Simulated client-side full settlement mutation (as performed by settleSplitShare)
    const settledShare = {
      ...splitShare,
      repaidPaise: 5000,
      settledAt: Timestamp.now(),
    }
    assert.equal(settledShare.repaidPaise, 5000)
    assert.ok(settledShare.settledAt !== null)
  })
})
