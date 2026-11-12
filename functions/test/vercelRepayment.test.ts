import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { handleVercelRepayment } from '../src/vercelRepayment.ts'
import { Timestamp } from 'firebase-admin/firestore'

// In-memory Firestore simulation for reproducible, isolated unit testing
function createInMemoryDb() {
  const docs = new Map<string, Record<string, any>>()

  const getDoc = (path: string) => {
    const data = docs.get(path)
    return {
      exists: Boolean(data),
      id: path.split('/').pop()!,
      data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
    }
  }

  const doc = (path: string) => ({
    id: path.split('/').pop()!,
    path,
  })

  let txLock = Promise.resolve()

  const runTransaction = async (fn: (txn: any) => Promise<any>) => {
    const prevLock = txLock
    let releaseLock: () => void
    txLock = new Promise<void>(resolve => {
      releaseLock = resolve
    })
    await prevLock

    try {
      const txn = {
        get: async (ref: { path: string }) => getDoc(ref.path),
        set: (ref: { path: string }, data: any) => {
          docs.set(ref.path, JSON.parse(JSON.stringify(data)))
        },
        update: (ref: { path: string }, data: any) => {
          const existing = docs.get(ref.path) || {}
          docs.set(ref.path, { ...existing, ...JSON.parse(JSON.stringify(data)) })
        },
        delete: (ref: { path: string }) => {
          docs.delete(ref.path)
        },
      }
      return await fn(txn)
    } finally {
      releaseLock!()
    }
  }

  return {
    doc,
    runTransaction,
    _rawDocs: docs,
  }
}

describe('Vercel Repayment Adapter — HTTP, Security, and Invariants', () => {
  let mockUsers: Map<string, string> // token -> uid
  let mockDb: ReturnType<typeof createInMemoryDb>
  let authVerifier: (token: string) => Promise<any>

  before(() => {
    mockUsers = new Map()
    mockUsers.set('valid-owner-token', 'user-owner')
    mockUsers.set('valid-stranger-token', 'user-stranger')

    authVerifier = async (token: string) => {
      if (token === 'expired-token') {
        const err = new Error('Token expired')
        ;(err as any).code = 'auth/id-token-expired'
        throw err
      }
      if (token === 'invalid-token') {
        const err = new Error('Invalid token')
        ;(err as any).code = 'auth/argument-error'
        throw err
      }
      const uid = mockUsers.get(token)
      if (!uid) {
        const err = new Error('Unauthorized')
        ;(err as any).code = 'auth/invalid-token'
        throw err
      }
      return { uid, aud: 'spenza-90037', iss: 'https://securetoken.google.com/spenza-90037' }
    }

    mockDb = createInMemoryDb()
  })

  // In-process mock HTTP caller (no network port binding)
  async function invokeHandler(options: {
    method?: string
    headers?: Record<string, string>
    body?: string | Record<string, any>
  }) {
    const rawHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(options.headers || {})) {
      rawHeaders[k.toLowerCase()] = v
    }

    const bodyBuf = typeof options.body === 'string'
      ? Buffer.from(options.body, 'utf8')
      : undefined

    const stream = bodyBuf ? Readable.from([bodyBuf]) : Readable.from([])

    const req = Object.assign(stream, {
      method: options.method || 'POST',
      headers: rawHeaders,
      body: typeof options.body === 'object' && options.body !== null ? options.body : undefined,
    }) as any

    let resStatusCode = 200
    const resHeaders = new Map<string, string>()
    let resBody = ''
    let finished = false

    const res = {
      get statusCode() {
        return resStatusCode
      },
      set statusCode(code: number) {
        resStatusCode = code
      },
      setHeader: (name: string, value: string) => {
        resHeaders.set(name.toLowerCase(), value)
      },
      getHeader: (name: string) => resHeaders.get(name.toLowerCase()),
      end: (chunk?: string | Buffer) => {
        if (chunk) resBody += chunk.toString()
        finished = true
      },
      get writableEnded() {
        return finished
      },
    } as any

    await handleVercelRepayment(req, res, {
      authVerifier,
      db: mockDb as any,
    })

    return {
      status: resStatusCode,
      headers: {
        get: (h: string) => resHeaders.get(h.toLowerCase()) || null,
      },
      json: async () => JSON.parse(resBody || '{}'),
      text: async () => resBody,
    }
  }

  it('1. OPTIONS preflight returns 204 with CORS headers', async () => {
    const res = await invokeHandler({
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173')
    assert.match(res.headers.get('Access-Control-Allow-Methods')!, /POST/)
  })

  it('2. Disallowed CORS origin returns 403 Forbidden', async () => {
    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Origin': 'https://malicious-site.example.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 403)
    const data = await res.json()
    assert.equal(data.error.code, 'FORBIDDEN')
  })

  it('3. Non-POST HTTP methods return 405 Method Not Allowed', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const res = await invokeHandler({ method })
      assert.equal(res.status, 405)
      assert.equal(res.headers.get('Allow'), 'POST, OPTIONS')
      const data = await res.json()
      assert.equal(data.error.code, 'METHOD_NOT_ALLOWED')
    }
  })

  it('4. Oversized payload (>64KB) is rejected with 413 Payload Too Large', async () => {
    const hugeBody = JSON.stringify({
      transactionId: 't1',
      junk: 'x'.repeat(70000),
    })
    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-owner-token',
      },
      body: hugeBody,
    })
    assert.equal(res.status, 413)
    const data = await res.json()
    assert.equal(data.error.code, 'PAYLOAD_TOO_LARGE')
  })

  it('5. Missing Authorization header returns 401 Unauthorized', async () => {
    const res = await invokeHandler({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 401)
    const data = await res.json()
    assert.equal(data.error.code, 'UNAUTHENTICATED')
  })

  it('6. Invalid or expired token returns 401 Unauthorized', async () => {
    for (const token of ['invalid-token', 'expired-token', 'non-existent-token']) {
      const res = await invokeHandler({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      })
      assert.equal(res.status, 401)
      const data = await res.json()
      assert.equal(data.error.code, 'UNAUTHENTICATED')
    }
  })

  it('7. Client-supplied UID tampering (IDOR) returns 403 Forbidden', async () => {
    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-owner-token',
      },
      body: {
        uid: 'user-stranger', // Attempting to spoof another user
        transactionId: 'tx-1',
        personId: 'alice',
        repaymentPaise: 500,
        idempotencyKey: 'key-1',
      },
    })
    assert.equal(res.status, 403)
    const data = await res.json()
    assert.equal(data.error.code, 'PERMISSION_DENIED')
  })

  it('8. Accessing another user financial data returns 404 without leakage', async () => {
    // Seed transaction under user-owner
    const ownerTxId = 'tx-owner-private'
    mockDb._rawDocs.set(`users/user-owner/transactions/${ownerTxId}`, {
      id: ownerTxId,
      amountPaise: 10000,
      description: 'Private dinner',
      categoryId: 'food',
      type: 'everyday',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 4000,
      reimbursementStatus: 'pending',
      splits: [{ personId: 'bob', personName: 'Bob', amountPaise: 4000, repaidPaise: 0, settledAt: null }],
    })

    // Stranger tries to repay owner's transaction
    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-stranger-token',
      },
      body: {
        transactionId: ownerTxId,
        personId: 'bob',
        repaymentPaise: 1000,
        idempotencyKey: 'key-stranger-attempt',
      },
    })
    assert.equal(res.status, 404)
    const data = await res.json()
    assert.equal(data.error.code, 'NOT-FOUND')
  })

  it('9. Valid repayment produces exact ledger updates, atomic receipts and insights cache invalidation', async () => {
    const txId = 'tx-valid-repay'
    const ownerPath = 'users/user-owner'
    mockDb._rawDocs.set(`${ownerPath}/transactions/${txId}`, {
      id: txId,
      amountPaise: 10000,
      description: 'Team outing',
      categoryId: 'food',
      type: 'everyday',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 5000,
      reimbursementStatus: 'pending',
      splits: [
        { personId: 'alice', personName: 'Alice', amountPaise: 3000, repaidPaise: 0, settledAt: null },
        { personId: 'bob', personName: 'Bob', amountPaise: 2000, repaidPaise: 0, settledAt: null },
      ],
    })

    // Seed insights cache to verify deletion
    mockDb._rawDocs.set(`${ownerPath}/insights/summary`, { cachedData: 12345 })

    const idempotencyKey = 'key-alice-repayment-1'
    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-owner-token',
      },
      body: {
        transactionId: txId,
        personId: 'alice',
        repaymentPaise: 1500,
        idempotencyKey,
      },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.result.appliedPaise, 1500)
    assert.equal(body.result.replayed, false)

    // Verify transaction in DB was updated correctly
    const updatedTx = mockDb._rawDocs.get(`${ownerPath}/transactions/${txId}`)!
    const aliceSplit = updatedTx.splits.find((s: any) => s.personId === 'alice')
    assert.equal(aliceSplit.repaidPaise, 1500)
    assert.equal(aliceSplit.settledAt, null) // Partially repaid, not settled
    assert.equal(updatedTx.recoverablePaise, 5000) // Original recoverable principal is preserved
    assert.equal(updatedTx.reimbursementStatus, 'partial')

    // Verify receipt was created
    const receipt = mockDb._rawDocs.get(`${ownerPath}/repaymentReceipts/${idempotencyKey}`)!
    assert.ok(receipt)
    assert.equal(receipt.appliedPaise, 1500)
    assert.equal(receipt.personId, 'alice')

    // Verify insights cache was atomically deleted
    assert.equal(mockDb._rawDocs.has(`${ownerPath}/insights/summary`), false)
  })

  it('10. Duplicate repayment request is idempotent (replays without double charging)', async () => {
    const txId = 'tx-valid-repay'
    const ownerPath = 'users/user-owner'
    const idempotencyKey = 'key-alice-repayment-1'

    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-owner-token',
      },
      body: {
        transactionId: txId,
        personId: 'alice',
        repaymentPaise: 1500,
        idempotencyKey,
      },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.result.replayed, true)
    assert.equal(body.result.appliedPaise, 1500)

    // Recoverable balance is STILL 5000 (not reduced again)
    const tx = mockDb._rawDocs.get(`${ownerPath}/transactions/${txId}`)!
    assert.equal(tx.recoverablePaise, 5000)
    const aliceSplit = tx.splits.find((s: any) => s.personId === 'alice')
    assert.equal(aliceSplit.repaidPaise, 1500)
  })

  it('11. Idempotency key reuse with different parameters returns 409 Conflict', async () => {
    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-owner-token',
      },
      body: {
        transactionId: 'tx-valid-repay',
        personId: 'alice',
        repaymentPaise: 9999, // Mismatched amount
        idempotencyKey: 'key-alice-repayment-1',
      },
    })

    assert.equal(res.status, 409)
    const data = await res.json()
    assert.equal(data.error.code, 'ALREADY-EXISTS')
  })

  it('12. Invalid split repayment amounts are rejected with 400 Bad Request', async () => {
    const testCases = [
      { repaymentPaise: 0, desc: 'zero amount' },
      { repaymentPaise: -500, desc: 'negative amount' },
      { repaymentPaise: 12.5, desc: 'floating point amount' },
      { repaymentPaise: 100000, desc: 'exceeds outstanding balance' },
    ]

    for (const tc of testCases) {
      const res = await invokeHandler({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer valid-owner-token',
        },
        body: {
          transactionId: 'tx-valid-repay',
          personId: 'alice',
          repaymentPaise: tc.repaymentPaise,
          idempotencyKey: `key-invalid-${tc.desc}`,
        },
      })

      assert.equal(res.status, 400, `Expected 400 for ${tc.desc}, got ${res.status}`)
      const data = await res.json()
      assert.equal(data.ok, false)
    }
  })

  it('13. Concurrent repayment requests serialize safely via transactions', async () => {
    const txId = 'tx-concurrent-vercel'
    const ownerPath = 'users/user-owner'
    mockDb._rawDocs.set(`${ownerPath}/transactions/${txId}`, {
      id: txId,
      amountPaise: 10000,
      description: 'Trip groceries',
      categoryId: 'food',
      type: 'trip',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 6000,
      reimbursementStatus: 'pending',
      splits: [
        { personId: 'charlie', personName: 'Charlie', amountPaise: 3000, repaidPaise: 0, settledAt: null },
        { personId: 'dave', personName: 'Dave', amountPaise: 3000, repaidPaise: 0, settledAt: null },
      ],
    })

    const [resCharlie, resDave] = await Promise.all([
      invokeHandler({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer valid-owner-token' },
        body: {
          transactionId: txId,
          personId: 'charlie',
          repaymentPaise: 1000,
          idempotencyKey: 'key-concurrent-charlie',
        },
      }),
      invokeHandler({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer valid-owner-token' },
        body: {
          transactionId: txId,
          personId: 'dave',
          repaymentPaise: 2000,
          idempotencyKey: 'key-concurrent-dave',
        },
      }),
    ])

    assert.equal(resCharlie.status, 200)
    assert.equal(resDave.status, 200)

    const finalTx = mockDb._rawDocs.get(`${ownerPath}/transactions/${txId}`)!
    const charlieSplit = finalTx.splits.find((s: any) => s.personId === 'charlie')
    const daveSplit = finalTx.splits.find((s: any) => s.personId === 'dave')

    assert.equal(charlieSplit.repaidPaise, 1000)
    assert.equal(daveSplit.repaidPaise, 2000)
    assert.equal(finalTx.recoverablePaise, 6000) // Original recoverable principal preserved
    assert.equal(charlieSplit.repaidPaise + daveSplit.repaidPaise, 3000) // Total repaid
  })
})
