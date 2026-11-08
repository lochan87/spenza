import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Timestamp } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import { executeTrustedSettlePersonAllDues } from '../src/settlementExecutor.ts'

type StoredDoc = Record<string, any>

interface MockTransaction {
  get: (ref: { path: string }) => Promise<{ exists: boolean; id: string; data: () => StoredDoc | undefined }>
  set: (ref: { path: string }, data: StoredDoc) => void
  update: (ref: { path: string }, data: StoredDoc) => void
  delete: (ref: { path: string }) => void
}

function createInMemoryDb(options: { failOnTxId?: string } = {}) {
  const docs = new Map<string, StoredDoc>()
  const versions = new Map<string, number>()
  let commitQueue: Promise<void> = Promise.resolve()

  const bump = (path: string) => versions.set(path, (versions.get(path) ?? 0) + 1)

  const doc = (path: string) => ({
    id: path.split('/').pop()!,
    path,
  })

  const collection = (colPath: string) => {
    return {
      path: colPath,
      where: (field: string, op: string, value: any) => {
        return {
          get: async () => {
            const results: any[] = []
            for (const [p, d] of docs.entries()) {
              if (p.startsWith(colPath + '/') && p.slice(colPath.length + 1).indexOf('/') < 0) {
                let match = false
                if (op === '==') {
                  match = d[field] === value
                } else if (op === 'in' && Array.isArray(value)) {
                  match = value.includes(d[field])
                }
                if (match) {
                  results.push({
                    id: p.split('/').pop()!,
                    ref: doc(p),
                    data: () => ({ ...d }),
                  })
                }
              }
            }
            return { docs: results }
          },
        }
      },
    }
  }

  const runTransaction = async <T>(cb: (txn: MockTransaction) => Promise<T>): Promise<T> => {
    const maxRetries = 10
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const readVersions = new Map<string, number>()
      const stagedWrites: { type: 'set' | 'update' | 'delete'; path: string; data?: StoredDoc }[] = []

      const txn: MockTransaction = {
        get: async (ref: { path: string }) => {
          readVersions.set(ref.path, versions.get(ref.path) ?? 0)
          const data = docs.get(ref.path)
          return {
            exists: data !== undefined,
            id: ref.path.split('/').pop()!,
            data: () => (data ? { ...data } : undefined),
          }
        },
        set: (ref: { path: string }, data: StoredDoc) => {
          stagedWrites.push({ type: 'set', path: ref.path, data: { ...data } })
        },
        update: (ref: { path: string }, data: StoredDoc) => {
          stagedWrites.push({ type: 'update', path: ref.path, data: { ...data } })
        },
        delete: (ref: { path: string }) => {
          stagedWrites.push({ type: 'delete', path: ref.path })
        },
      }

      const res: T = await cb(txn)

      // Serialize commit checks
      const previousCommit = commitQueue
      let releaseCommit!: () => void
      commitQueue = new Promise<void>(resolve => {
        releaseCommit = resolve
      })
      await previousCommit

      let conflict = false
      try {
        for (const [path, v] of readVersions) {
          if ((versions.get(path) ?? 0) !== v) {
            conflict = true
            break
          }
        }

        if (!conflict) {
          for (const w of stagedWrites) {
            if (options.failOnTxId && w.path.includes(options.failOnTxId)) {
              throw new Error(`Simulated transaction failure for ${options.failOnTxId}`)
            }
            if (w.type === 'delete') {
              docs.delete(w.path)
            } else if (w.type === 'update') {
              const cur = docs.get(w.path) ?? {}
              docs.set(w.path, { ...cur, ...w.data })
            } else {
              docs.set(w.path, { ...w.data })
            }
            bump(w.path)
          }
          return res
        }
      } finally {
        releaseCommit()
      }

      if (conflict && attempt === maxRetries) {
        throw new Error('Transaction contention limit reached in mock double')
      }
    }
    throw new Error('Transaction failed')
  }

  return {
    doc,
    collection,
    runTransaction,
    _docs: docs,
  } as any
}

describe('executeTrustedSettlePersonAllDues — Concurrency, Fencing and Safety (Phase 7.4C.1.1)', () => {
  const uid = 'user-concurrent-123'

  it('1. Concurrent requests with the same key serialize safely and only one runner settles dues', async () => {
    const db = createInMemoryDb()
    const personId = 'person-alice'
    const key = 'idem-concur-1'

    // Seed transaction with pending dues
    db._docs.set(`users/${uid}/transactions/tx1`, {
      id: 'tx1',
      amountPaise: 10000,
      recoverablePaise: 5000,
      reimbursementStatus: 'pending',
      date: Timestamp.now(),
      type: 'everyday',
      splits: [
        {
          personId,
          personName: 'Alice',
          amountPaise: 5000,
          repaidPaise: 0,
          settledAt: null,
        },
      ],
    })

    // Execute two concurrent requests simultaneously with identical idempotencyKey
    const [res1, res2] = await Promise.all([
      executeTrustedSettlePersonAllDues(
        db,
        uid,
        { mode: 'personAllDues', personId, idempotencyKey: key },
        { pollIntervalMs: 20, pollTimeoutMs: 2000 }
      ),
      executeTrustedSettlePersonAllDues(
        db,
        uid,
        { mode: 'personAllDues', personId, idempotencyKey: key },
        { pollIntervalMs: 20, pollTimeoutMs: 2000 }
      ),
    ])

    // Both requests must succeed and report the exact same settled dues
    assert.equal(res1.settledCount, 1)
    assert.equal(res1.totalSettledPaise, 5000)
    assert.equal(res2.settledCount, 1)
    assert.equal(res2.totalSettledPaise, 5000)

    // One of them was executed fresh, the other replayed the completed receipt
    assert.equal(res1.replayed || res2.replayed, true)
    assert.equal(res1.replayed && res2.replayed, false)

    // Receipt must be completed with fencingToken: 1
    const receipt = db._docs.get(`users/${uid}/repaymentReceipts/${key}`)
    assert.ok(receipt)
    assert.equal(receipt.status, 'completed')
    assert.equal(receipt.fencingToken, 1)
    assert.equal(receipt.settledCount, 1)
    assert.equal(receipt.totalSettledPaise, 5000)

    // Transaction was settled exactly once
    const tx = db._docs.get(`users/${uid}/transactions/tx1`)
    assert.equal(tx.splits[0].repaidPaise, 5000)
    assert.equal(tx.reimbursementStatus, 'settled')
  })

  it('2. Different parameters reusing a key throws already-exists error', async () => {
    const db = createInMemoryDb()
    const key = 'idem-reuse-params'

    // Existing completed receipt for person-bob
    db._docs.set(`users/${uid}/repaymentReceipts/${key}`, {
      idempotencyKey: key,
      mode: 'personAllDues',
      personId: 'person-bob',
      status: 'completed',
      settledCount: 1,
      totalSettledPaise: 2000,
      complete: true,
    })

    // Calling with same key but person-charlie must fail
    await assert.rejects(
      async () => {
        await executeTrustedSettlePersonAllDues(db, uid, {
          mode: 'personAllDues',
          personId: 'person-charlie',
          idempotencyKey: key,
        })
      },
      (err: any) => {
        assert.ok(err instanceof HttpsError)
        assert.equal(err.code, 'already-exists')
        return true
      }
    )
  })

  it('3. Completed receipt replay returns existing result immediately without writes', async () => {
    const db = createInMemoryDb()
    const key = 'idem-replay-1'
    const personId = 'person-diana'

    db._docs.set(`users/${uid}/repaymentReceipts/${key}`, {
      idempotencyKey: key,
      mode: 'personAllDues',
      personId,
      status: 'completed',
      settledCount: 2,
      totalSettledPaise: 7500,
      updatedTxns: [{ id: 'tx-old-1' }, { id: 'tx-old-2' }],
      complete: true,
      failedTransactionId: null,
      error: null,
    })

    const result = await executeTrustedSettlePersonAllDues(db, uid, {
      mode: 'personAllDues',
      personId,
      idempotencyKey: key,
    })

    assert.equal(result.replayed, true)
    assert.equal(result.settledCount, 2)
    assert.equal(result.totalSettledPaise, 7500)
    assert.equal(result.updatedTxns.length, 2)
  })

  it('4. Interrupted execution and safe recovery: expired lease increments fencing token and supersedes zombie runner', async () => {
    const db = createInMemoryDb()
    const personId = 'person-evan'
    const key = 'idem-interrupted-recovery'

    // Seed transaction
    db._docs.set(`users/${uid}/transactions/tx-evan-1`, {
      id: 'tx-evan-1',
      amountPaise: 8000,
      recoverablePaise: 8000,
      reimbursementStatus: 'pending',
      date: Timestamp.now(),
      type: 'reimbursable',
      personId,
      splits: [
        {
          personId,
          personName: 'Evan',
          amountPaise: 8000,
          repaidPaise: 0,
          settledAt: null,
        },
      ],
    })

    // Simulate an interrupted runner 1 whose lease has expired
    const expiredTimestamp = Timestamp.fromMillis(Date.now() - 5000)
    db._docs.set(`users/${uid}/repaymentReceipts/${key}`, {
      idempotencyKey: key,
      mode: 'personAllDues',
      personId,
      status: 'in_progress',
      fencingToken: 1,
      leaseExpiresAt: expiredTimestamp,
      settledCount: 0,
      totalSettledPaise: 0,
      updatedTxns: [],
    })

    // Runner 2 arrives and recovers the reservation
    const res2 = await executeTrustedSettlePersonAllDues(
      db,
      uid,
      { mode: 'personAllDues', personId, idempotencyKey: key },
      { leaseDurationMs: 30000 }
    )

    assert.equal(res2.settledCount, 1)
    assert.equal(res2.totalSettledPaise, 8000)
    assert.equal(res2.complete, true)

    // The receipt fencing token was bumped to 2 and completed
    const finalReceipt = db._docs.get(`users/${uid}/repaymentReceipts/${key}`)
    assert.equal(finalReceipt.status, 'completed')
    assert.equal(finalReceipt.fencingToken, 2)

    // Now verify that if zombie runner 1 tries to commit a mutation with its old fencing token (1):
    // Its transaction will detect fencingToken !== 1 and abort!
    await assert.rejects(
      async () => {
        await db.runTransaction(async (txn: MockTransaction) => {
          const rSnap = await txn.get({ path: `users/${uid}/repaymentReceipts/${key}` })
          const rData = rSnap.data()!
          if (rData.status !== 'in_progress' || rData.fencingToken !== 1) {
            throw new Error('Settlement runner was fenced out by newer settlement runner.')
          }
          txn.update({ path: `users/${uid}/transactions/tx-evan-1` }, { corrupted: true })
        })
      },
      (err: any) => {
        assert.match(err.message, /fenced out/)
        return true
      }
    )

    // Corrupted field was NOT written to the transaction
    const tx = db._docs.get(`users/${uid}/transactions/tx-evan-1`)
    assert.equal(tx.corrupted, undefined)
  })

  it('5. Partial settlement failure records partial progress and subsequent retry succeeds', async () => {
    const personId = 'person-fiona'
    const key = 'idem-partial-fail'

    // Create DB that will fail specifically when writing tx-fail-2
    const db = createInMemoryDb({ failOnTxId: 'tx-fail-2' })

    // Seed two transactions
    db._docs.set(`users/${uid}/transactions/tx-fiona-1`, {
      id: 'tx-fiona-1',
      amountPaise: 3000,
      recoverablePaise: 3000,
      reimbursementStatus: 'pending',
      date: Timestamp.fromMillis(100000),
      type: 'reimbursable',
      personId,
      splits: [
        { personId, personName: 'Fiona', amountPaise: 3000, repaidPaise: 0, settledAt: null },
      ],
    })

    db._docs.set(`users/${uid}/transactions/tx-fail-2`, {
      id: 'tx-fail-2',
      amountPaise: 4000,
      recoverablePaise: 4000,
      reimbursementStatus: 'pending',
      date: Timestamp.fromMillis(200000),
      type: 'reimbursable',
      personId,
      splits: [
        { personId, personName: 'Fiona', amountPaise: 4000, repaidPaise: 0, settledAt: null },
      ],
    })

    // First attempt: tx-fiona-1 settles, tx-fail-2 fails
    const partialRes = await executeTrustedSettlePersonAllDues(db, uid, {
      mode: 'personAllDues',
      personId,
      idempotencyKey: key,
    })

    assert.equal(partialRes.settledCount, 1)
    assert.equal(partialRes.totalSettledPaise, 3000)
    assert.equal(partialRes.complete, false)
    assert.equal(partialRes.failedTransactionId, 'tx-fail-2')
    assert.ok(partialRes.error)

    // Replay with SAME key returns the partial result
    const replayedRes = await executeTrustedSettlePersonAllDues(db, uid, {
      mode: 'personAllDues',
      personId,
      idempotencyKey: key,
    })
    assert.equal(replayedRes.replayed, true)
    assert.equal(replayedRes.settledCount, 1)
    assert.equal(replayedRes.failedTransactionId, 'tx-fail-2')

    // Retry with FRESH key (e.g. after error resolved):
    // Remove failure condition from DB
    delete (db as any).options?.failOnTxId
    // Actually, create clean db sharing the same documents without failure:
    const cleanDb = createInMemoryDb()
    for (const [k, v] of db._docs.entries()) {
      cleanDb._docs.set(k, { ...v })
    }

    const retryRes = await executeTrustedSettlePersonAllDues(cleanDb, uid, {
      mode: 'personAllDues',
      personId,
      idempotencyKey: 'idem-fresh-retry-key',
    })

    // Second transaction is settled!
    assert.equal(retryRes.settledCount, 1)
    assert.equal(retryRes.totalSettledPaise, 4000)
    assert.equal(retryRes.complete, true)

    // Both transactions are now fully settled in DB
    const tx1 = cleanDb._docs.get(`users/${uid}/transactions/tx-fiona-1`)
    const tx2 = cleanDb._docs.get(`users/${uid}/transactions/tx-fail-2`)
    assert.equal(tx1.reimbursementStatus, 'settled')
    assert.equal(tx2.reimbursementStatus, 'settled')
  })
})

