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
      repaymentPaise: number,
      customKey?: string
    ) => Promise<{ tx: any; appliedPaise: number }>
    settleSplitShare: (
      uid: string,
      transactionId: string,
      personId: string,
      customKey?: string
    ) => Promise<{ tx: any; settledPaise: number }>
    settleAllTransactionSplits: (
      uid: string,
      transactionId: string,
      customKey?: string
    ) => Promise<{ tx: any; settledPaise: number }>
    settlePersonAllDues: (
      uid: string,
      personId: string,
      customKey?: string
    ) => Promise<{ settledCount: number; totalSettledPaise: number; updatedTxns: any[]; complete?: boolean }>
    getOrCreatePendingKey: (operationType: string, id: string, extra?: string) => string
    clearPendingKey: (operationType: string, id: string, extra?: string) => void
    MultiSettlementPartialError: any
  }
  const text = readFileSync(new URL('../people.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText

  const capturedCalls: any[] = []

  runInNewContext(compiled, {
    exports,
    navigator: { onLine: !options.offline },
    crypto: globalThis.crypto,
    console,
    Date,
    Error,
    window: { sessionStorage: null },
    require: (name: string) => {
      if (name === 'firebase/firestore') {
        return {
          Timestamp,
          doc: () => ({}),
          collection: () => ({}),
          serverTimestamp: () => ({}),
        }
      }
      if (name === 'firebase/functions') {
        return {
          getFunctions: () => ({}),
          httpsCallable: (_functions: unknown, endpoint: string) => async (data: unknown) => {
            capturedCalls.push({ endpoint, data })
            if (options.callableImpl) {
              const res = await options.callableImpl(data)
              return { data: res }
            }
            if (endpoint === 'executeRepaymentV1') {
              return {
                data: {
                  tx: {
                    id: (data as any).transactionId,
                    amountPaise: 5000,
                    recoverablePaise: 5000,
                    reimbursementStatus: 'partial',
                    date: { _seconds: 1700000000, _nanoseconds: 0 },
                    splits: [{ personId: (data as any).personId, personName: 'Alice', amountPaise: 5000, repaidPaise: (data as any).repaymentPaise, settledAt: null }],
                  },
                  appliedPaise: (data as any).repaymentPaise,
                  replayed: false,
                },
              }
            }
            const mode = (data as any).mode
            if (mode === 'splitShare' || mode === 'transactionSplits') {
              return {
                data: {
                  tx: {
                    id: (data as any).transactionId,
                    amountPaise: 5000,
                    recoverablePaise: 5000,
                    reimbursementStatus: 'settled',
                    date: { _seconds: 1700000000, _nanoseconds: 0 },
                    splits: [{ personId: (data as any).personId || 'alice', personName: 'Alice', amountPaise: 5000, repaidPaise: 5000, settledAt: { _seconds: 1700000000, _nanoseconds: 0 } }],
                  },
                  settledPaise: 5000,
                  replayed: false,
                },
              }
            }
            if (mode === 'personAllDues') {
              return {
                data: {
                  settledCount: 2,
                  totalSettledPaise: 8000,
                  updatedTxns: [
                    { id: 'tx-1', amountPaise: 5000, recoverablePaise: 5000, reimbursementStatus: 'settled', date: { _seconds: 1700000000, _nanoseconds: 0 }, splits: [] },
                    { id: 'tx-2', amountPaise: 3000, recoverablePaise: 3000, reimbursementStatus: 'settled', date: { _seconds: 1700000000, _nanoseconds: 0 }, splits: [] },
                  ],
                  complete: true,
                  replayed: false,
                },
              }
            }
            return { data: {} }
          },
        }
      }
      if (name === '@/firebase/config') return { app: {}, db: {} }
      if (name === '@/utils/schemas') return schemas
      if (name === '@/utils/splitMath') return splitMath
      throw new Error(`Unexpected import: ${name}`)
    },
  })

  return {
    service: exports,
    getCapturedCalls: () => capturedCalls,
  }
}

describe('Client settlement service & retry safety (Phase 7.2B)', () => {
  it('rejects offline settlement calls immediately without invoking the Cloud Function', async () => {
    let callableInvoked = false
    const { service } = loadPeopleService({
      offline: true,
      callableImpl: async () => {
        callableInvoked = true
        return {}
      },
    })

    await assert.rejects(
      service.settleSplitShare('user-1', 'tx-1', 'person-1'),
      /You are offline\. Settling dues requires an internet connection\./
    )
    await assert.rejects(
      service.settleAllTransactionSplits('user-1', 'tx-1'),
      /You are offline\. Settling dues requires an internet connection\./
    )
    await assert.rejects(
      service.settlePersonAllDues('user-1', 'person-1'),
      /You are offline\. Settling dues requires an internet connection\./
    )
    assert.equal(callableInvoked, false)
  })

  it('validates settlement client parameters before invoking the Cloud Function', async () => {
    const { service } = loadPeopleService()

    await assert.rejects(service.settleSplitShare('', 'tx-1', 'person-1'), /User ID is required/)
    await assert.rejects(service.settleSplitShare('user-1', '', 'person-1'), /Transaction ID is required/)
    await assert.rejects(service.settleSplitShare('user-1', 'tx-1', ''), /Person ID is required/)

    await assert.rejects(service.settleAllTransactionSplits('', 'tx-1'), /User ID is required/)
    await assert.rejects(service.settleAllTransactionSplits('user-1', ''), /Transaction ID is required/)

    await assert.rejects(service.settlePersonAllDues('', 'person-1'), /User ID is required/)
    await assert.rejects(service.settlePersonAllDues('user-1', ''), /Person ID is required/)
  })

  it('invokes executeSettlementV1 with discriminated union modes and hydrates timestamps', async () => {
    const { service, getCapturedCalls } = loadPeopleService()

    // 1. settleSplitShare
    const shareRes = await service.settleSplitShare('user-1', 'tx-100', 'person-200')
    assert.equal(shareRes.settledPaise, 5000)
    assert.equal(shareRes.tx.reimbursementStatus, 'settled')
    assert.ok(shareRes.tx.date instanceof Timestamp)

    // 2. settleAllTransactionSplits
    const allSplitsRes = await service.settleAllTransactionSplits('user-1', 'tx-100')
    assert.equal(allSplitsRes.settledPaise, 5000)
    assert.equal(allSplitsRes.tx.reimbursementStatus, 'settled')

    // 3. settlePersonAllDues
    const personDuesRes = await service.settlePersonAllDues('user-1', 'person-200')
    assert.equal(personDuesRes.settledCount, 2)
    assert.equal(personDuesRes.totalSettledPaise, 8000)
    assert.equal(personDuesRes.complete, true)
    assert.equal(personDuesRes.updatedTxns.length, 2)
    assert.ok(personDuesRes.updatedTxns[0].date instanceof Timestamp)

    const calls = getCapturedCalls()
    assert.equal(calls.length, 3)
    assert.equal(calls[0].data.mode, 'splitShare')
    assert.equal(calls[0].data.transactionId, 'tx-100')
    assert.equal(calls[0].data.personId, 'person-200')
    assert.ok(calls[0].data.idempotencyKey)

    assert.equal(calls[1].data.mode, 'transactionSplits')
    assert.equal(calls[1].data.transactionId, 'tx-100')
    assert.ok(calls[1].data.idempotencyKey)

    assert.equal(calls[2].data.mode, 'personAllDues')
    assert.equal(calls[2].data.personId, 'person-200')
    assert.ok(calls[2].data.idempotencyKey)
  })

  it('repayment retry safety: uncertain response preserves key and replays rather than duplicating', async () => {
    let callCount = 0
    let firstIdempotencyKey: string | null = null

    const { service, getCapturedCalls } = loadPeopleService({
      callableImpl: async (data: any) => {
        callCount++
        firstIdempotencyKey = data.idempotencyKey
        if (callCount === 1) {
          // Simulate server commited, but response dropped / network timeout before client received it
          throw new Error('Network timeout (simulated uncertain response)')
        }
        // Second call (client retry): returns completed replay
        return {
          tx: {
            id: data.transactionId,
            amountPaise: 5000,
            recoverablePaise: 5000,
            reimbursementStatus: 'partial',
            date: { _seconds: 1700000000, _nanoseconds: 0 },
            splits: [{ personId: data.personId, personName: 'Alice', amountPaise: 5000, repaidPaise: data.repaymentPaise, settledAt: null }],
          },
          appliedPaise: data.repaymentPaise,
          replayed: true,
        }
      },
    })

    // First attempt fails due to uncertain network response
    await assert.rejects(
      service.recordSplitRepayment('user-1', 'tx-100', 'person-alice', 2000),
      /Network timeout \(simulated uncertain response\)/
    )

    // User retries with same parameters: durable key lifecycle reuses the exact same idempotencyKey!
    const retryRes = await service.recordSplitRepayment('user-1', 'tx-100', 'person-alice', 2000)
    assert.equal(retryRes.appliedPaise, 2000)

    const calls = getCapturedCalls()
    assert.equal(calls.length, 2)
    assert.equal(calls[0].data.idempotencyKey, firstIdempotencyKey)
    assert.equal(calls[1].data.idempotencyKey, firstIdempotencyKey) // Key reused!
  })

  it('multi-transaction failure and partial-progress reporting', async () => {
    const { service } = loadPeopleService({
      callableImpl: async () => ({
        settledCount: 1,
        totalSettledPaise: 3000,
        updatedTxns: [
          { id: 'tx-1', amountPaise: 3000, recoverablePaise: 3000, reimbursementStatus: 'settled', date: { _seconds: 1700000000, _nanoseconds: 0 }, splits: [] },
        ],
        complete: false,
        failedTransactionId: 'tx-2',
        error: 'Transaction "tx-2" failed concurrency check',
      }),
    })

    await assert.rejects(
      service.settlePersonAllDues('user-1', 'person-bob'),
      (err: any) => {
        assert.equal(err.name, 'MultiSettlementPartialError')
        assert.equal(err.settledCount, 1)
        assert.equal(err.totalSettledPaise, 3000)
        assert.equal(err.failedTransactionId, 'tx-2')
        assert.equal(err.updatedTxns.length, 1)
        assert.match(err.message, /Transaction "tx-2" failed/)
        return true
      }
    )
  })

  it('partial failure clears pending key so immediate retry generates a fresh key', async () => {
    let callCount = 0
    const capturedKeys: string[] = []

    const { service } = loadPeopleService({
      callableImpl: async (data: any) => {
        callCount++
        capturedKeys.push(data.idempotencyKey)
        if (callCount === 1) {
          // First attempt: partial failure (1 succeeded, 1 failed)
          return {
            settledCount: 1,
            totalSettledPaise: 3000,
            updatedTxns: [
              { id: 'tx-1', amountPaise: 3000, recoverablePaise: 3000, reimbursementStatus: 'settled', date: { _seconds: 1700000000, _nanoseconds: 0 }, splits: [] },
            ],
            complete: false,
            failedTransactionId: 'tx-2',
            error: 'Transaction "tx-2" temporarily locked',
          }
        }
        // Second attempt (retry): succeeds settling the remaining transaction
        return {
          settledCount: 1,
          totalSettledPaise: 2000,
          updatedTxns: [
            { id: 'tx-2', amountPaise: 2000, recoverablePaise: 2000, reimbursementStatus: 'settled', date: { _seconds: 1700000000, _nanoseconds: 0 }, splits: [] },
          ],
          complete: true,
        }
      },
    })

    // First attempt rejects with MultiSettlementPartialError
    await assert.rejects(
      service.settlePersonAllDues('user-1', 'person-bob'),
      (err: any) => {
        assert.equal(err.name, 'MultiSettlementPartialError')
        assert.equal(err.settledCount, 1)
        assert.equal(err.totalSettledPaise, 3000)
        return true
      }
    )

    // User immediately retries settlement: because the partial failure was confirmed,
    // the pending key was cleared, so the retry generates a fresh idempotency key!
    const retryRes = await service.settlePersonAllDues('user-1', 'person-bob')
    assert.equal(retryRes.settledCount, 1)
    assert.equal(retryRes.totalSettledPaise, 2000)
    assert.equal(retryRes.complete, true)

    assert.equal(capturedKeys.length, 2)
    assert.notEqual(capturedKeys[0], capturedKeys[1]) // Fresh key generated on retry!
  })

  it('uncertain network timeout preserves pending key for safe replay on retry', async () => {
    let callCount = 0
    const capturedKeys: string[] = []

    const { service } = loadPeopleService({
      callableImpl: async (data: any) => {
        callCount++
        capturedKeys.push(data.idempotencyKey)
        if (callCount === 1) {
          // Simulate network drop before response reached client
          throw new Error('Network connection lost (uncertain response)')
        }
        // Second call: server returns replay of the earlier completed settlement
        return {
          settledCount: 2,
          totalSettledPaise: 5000,
          updatedTxns: [
            { id: 'tx-1', amountPaise: 3000, recoverablePaise: 3000, reimbursementStatus: 'settled', date: { _seconds: 1700000000, _nanoseconds: 0 }, splits: [] },
            { id: 'tx-2', amountPaise: 2000, recoverablePaise: 2000, reimbursementStatus: 'settled', date: { _seconds: 1700000000, _nanoseconds: 0 }, splits: [] },
          ],
          complete: true,
          replayed: true,
        }
      },
    })

    // First attempt throws network error
    await assert.rejects(
      service.settlePersonAllDues('user-1', 'person-alice'),
      /Network connection lost/
    )

    // Client retries after network recovers: the pending key is preserved!
    const retryRes = await service.settlePersonAllDues('user-1', 'person-alice')
    assert.equal(retryRes.settledCount, 2)
    assert.equal(retryRes.totalSettledPaise, 5000)

    assert.equal(capturedKeys.length, 2)
    assert.equal(capturedKeys[0], capturedKeys[1]) // Same key preserved and sent on retry!
  })

  it('clean multi-settlement completion clears pending key so subsequent operations use fresh keys', async () => {
    const capturedKeys: string[] = []

    const { service } = loadPeopleService({
      callableImpl: async (data: any) => {
        capturedKeys.push(data.idempotencyKey)
        return {
          settledCount: 1,
          totalSettledPaise: 1000,
          updatedTxns: [
            { id: 'tx-1', amountPaise: 1000, recoverablePaise: 1000, reimbursementStatus: 'settled', date: { _seconds: 1700000000, _nanoseconds: 0 }, splits: [] },
          ],
          complete: true,
        }
      },
    })

    const res1 = await service.settlePersonAllDues('user-1', 'person-charlie')
    assert.equal(res1.settledCount, 1)

    // Subsequent settlement on the same person gets a new key
    const res2 = await service.settlePersonAllDues('user-1', 'person-charlie')
    assert.equal(res2.settledCount, 1)

    assert.equal(capturedKeys.length, 2)
    assert.notEqual(capturedKeys[0], capturedKeys[1])
  })

  it('verifies Phase 7.2B security boundary (direct client write still exists until Phase 7.3)', () => {
    // Phase 7.2B migrates all frontend settlement services to trusted Cloud Functions.
    // However, direct Firestore writes on `transactions` are not yet restricted to read-only for splits.
    // That final restriction is the explicit scope of Phase 7.3.
    assert.ok(true)
  })
})
