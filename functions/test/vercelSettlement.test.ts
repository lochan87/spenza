import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { handleVercelSettlement } from '../src/vercelSettlement.ts'
import { Timestamp } from 'firebase-admin/firestore'

function createInMemoryDb() {
  const docs = new Map<string, Record<string, any>>()

  const getDoc = (path: string) => {
    const data = docs.get(path)
    return {
      exists: Boolean(data),
      id: path.split('/').pop()!,
      ref: doc(path),
      data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
    }
  }

  const doc = (path: string) => ({
    id: path.split('/').pop()!,
    path,
    get: async () => getDoc(path),
    set: async (data: any) => docs.set(path, JSON.parse(JSON.stringify(data))),
    delete: async () => docs.delete(path),
  })

  const collection = (colPath: string) => ({
    path: colPath,
    where: (field: string, op: string, value: any) => ({
      get: async () => {
        const results: any[] = []
        for (const [p, d] of docs.entries()) {
          if (p.startsWith(colPath + '/') && p.slice(colPath.length + 1).indexOf('/') < 0) {
            let match = false
            if (op === '==') match = d[field] === value
            if (op === 'in' && Array.isArray(value)) match = value.includes(d[field])
            if (match) {
              results.push({
                id: p.split('/').pop()!,
                ref: doc(p),
                data: () => JSON.parse(JSON.stringify(d)),
              })
            }
          }
        }
        return { docs: results, size: results.length, empty: results.length === 0 }
      },
    }),
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
    collection,
    runTransaction,
    _rawDocs: docs,
  }
}

describe('Vercel Settlement Adapter — HTTP, Security, and Invariants', () => {
  let mockUsers: Map<string, string>
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

    await handleVercelSettlement(req, res, {
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
        'Origin': 'https://evil-cors-origin.com',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 403)
    const data = await res.json()
    assert.equal(data.error.code, 'FORBIDDEN')
  })

  it('3. Non-POST HTTP methods return 405 Method Not Allowed', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await invokeHandler({ method })
      assert.equal(res.status, 405)
      assert.equal(res.headers.get('Allow'), 'POST, OPTIONS')
      const data = await res.json()
      assert.equal(data.error.code, 'METHOD_NOT_ALLOWED')
    }
  })

  it('4. Oversized payload (>64KB) is rejected with 413 Payload Too Large', async () => {
    const hugeBody = JSON.stringify({
      mode: 'splitShare',
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

  it('5. Missing or invalid Authorization header returns 401 Unauthorized', async () => {
    const resNoAuth = await invokeHandler({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(resNoAuth.status, 401)

    const resExpired = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer expired-token',
      },
      body: JSON.stringify({}),
    })
    assert.equal(resExpired.status, 401)
  })

  it('6. Client-supplied UID tampering (IDOR) returns 403 Forbidden', async () => {
    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-owner-token',
      },
      body: {
        uid: 'user-stranger',
        mode: 'splitShare',
        transactionId: 'tx-1',
        personId: 'alice',
        idempotencyKey: 'key-settle-1',
      },
    })
    assert.equal(res.status, 403)
    const data = await res.json()
    assert.equal(data.error.code, 'PERMISSION_DENIED')
  })

  it('7. Accessing another user transaction returns 404 Not Found', async () => {
    const ownerTxId = 'tx-owner-settlement-target'
    mockDb._rawDocs.set(`users/user-owner/transactions/${ownerTxId}`, {
      id: ownerTxId,
      amountPaise: 5000,
      description: 'Owner Dinner',
      categoryId: 'food',
      type: 'everyday',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 2500,
      reimbursementStatus: 'pending',
      splits: [{ personId: 'alice', personName: 'Alice', amountPaise: 2500, repaidPaise: 0, settledAt: null }],
    })

    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-stranger-token',
      },
      body: {
        mode: 'splitShare',
        transactionId: ownerTxId,
        personId: 'alice',
        idempotencyKey: 'key-stranger-settle',
      },
    })
    assert.equal(res.status, 404)
    const data = await res.json()
    assert.equal(data.error.code, 'NOT_FOUND')
  })

  it('8. Mode splitShare: settles specific split, writes receipt, and deletes insights cache', async () => {
    const txId = 'tx-settle-share-1'
    const ownerPath = 'users/user-owner'
    mockDb._rawDocs.set(`${ownerPath}/transactions/${txId}`, {
      id: txId,
      amountPaise: 8000,
      description: 'Road trip snacks',
      categoryId: 'food',
      type: 'trip',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 4000,
      reimbursementStatus: 'pending',
      splits: [
        { personId: 'alice', personName: 'Alice', amountPaise: 2000, repaidPaise: 500, settledAt: null },
        { personId: 'bob', personName: 'Bob', amountPaise: 2000, repaidPaise: 0, settledAt: null },
      ],
    })

    // Seed insights cache
    mockDb._rawDocs.set(`${ownerPath}/insights/summary`, { cachedData: 999 })

    const idempotencyKey = 'key-settle-alice-share'
    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-owner-token',
      },
      body: {
        mode: 'splitShare',
        transactionId: txId,
        personId: 'alice',
        idempotencyKey,
      },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.result.settledPaise, 1500) // 2000 - 500
    assert.equal(body.result.replayed, false)

    // Verify split was marked settled and repaid
    const updatedTx = mockDb._rawDocs.get(`${ownerPath}/transactions/${txId}`)!
    const aliceSplit = updatedTx.splits.find((s: any) => s.personId === 'alice')
    assert.equal(aliceSplit.repaidPaise, 2000)
    assert.ok(aliceSplit.settledAt)
    assert.equal(updatedTx.recoverablePaise, 4000) // Original recoverable preserved
    assert.equal(updatedTx.reimbursementStatus, 'partial') // Bob is still unpaid

    // Insights cache deleted
    assert.equal(mockDb._rawDocs.has(`${ownerPath}/insights/summary`), false)

    // Replay idempotency test
    const replayRes = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-owner-token',
      },
      body: {
        mode: 'splitShare',
        transactionId: txId,
        personId: 'alice',
        idempotencyKey,
      },
    })
    assert.equal(replayRes.status, 200)
    const replayBody = await replayRes.json()
    assert.equal(replayBody.result.replayed, true)
    assert.equal(replayBody.result.settledPaise, 1500)
  })

  it('9. Mode transactionSplits: settles all remaining splits across a single transaction', async () => {
    const txId = 'tx-settle-all-splits'
    const ownerPath = 'users/user-owner'
    mockDb._rawDocs.set(`${ownerPath}/transactions/${txId}`, {
      id: txId,
      amountPaise: 6000,
      description: 'Group cab',
      categoryId: 'travel',
      type: 'everyday',
      date: Timestamp.now(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 4000,
      reimbursementStatus: 'pending',
      splits: [
        { personId: 'charlie', personName: 'Charlie', amountPaise: 2000, repaidPaise: 0, settledAt: null },
        { personId: 'dave', personName: 'Dave', amountPaise: 2000, repaidPaise: 0, settledAt: null },
      ],
    })

    const idempotencyKey = 'key-settle-all-splits-1'
    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-owner-token',
      },
      body: {
        mode: 'transactionSplits',
        transactionId: txId,
        idempotencyKey,
      },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.result.settledPaise, 4000)

    const updatedTx = mockDb._rawDocs.get(`${ownerPath}/transactions/${txId}`)!
    assert.equal(updatedTx.reimbursementStatus, 'settled')
    assert.ok(updatedTx.splits.every((s: any) => s.repaidPaise === s.amountPaise && s.settledAt != null))
  })

  it('10. Idempotency key reuse with different parameters returns 409 Conflict', async () => {
    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-owner-token',
      },
      body: {
        mode: 'splitShare',
        transactionId: 'tx-settle-share-1',
        personId: 'bob', // Alice was settled with this key in test 8
        idempotencyKey: 'key-settle-alice-share',
      },
    })
    assert.equal(res.status, 409)
    const data = await res.json()
    assert.equal(data.error.code, 'ALREADY_EXISTS')
  })
})
