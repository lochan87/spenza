import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { handleVercelImport } from '../src/vercelImport.ts'
import { chunkSchema, importRecordId, sha256 } from '../../src/utils/importPlan.ts'

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
    collection: (sub: string) => collection(`${path}/${sub}`),
  })

  const collection = (colPath: string) => ({
    path: colPath,
    doc: (id: string) => doc(`${colPath}/${id}`),
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
        getAll: async (...refs: any[]) => Promise.all(refs.map((r: any) => getDoc(r.path))),
        set: (ref: { path: string }, data: any) => {
          docs.set(ref.path, JSON.parse(JSON.stringify(data)))
        },
        create: (ref: { path: string }, data: any) => {
          if (docs.has(ref.path)) throw new Error('Document already exists')
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

describe('Vercel Import Adapter — HTTP, Security, and Invariants', () => {
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

    await handleVercelImport(req, res, {
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
        'Origin': 'https://unauthorized-domain.com',
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
      operationId: 'op1',
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
      body: JSON.stringify({ operationId: 'test' }),
    })
    assert.equal(resNoAuth.status, 401)

    const resInvalid = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer invalid-token',
      },
      body: JSON.stringify({ operationId: 'test' }),
    })
    assert.equal(resInvalid.status, 401)
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
        operationId: 'd'.repeat(64),
      },
    })
    assert.equal(res.status, 403)
    const data = await res.json()
    assert.equal(data.error.code, 'PERMISSION_DENIED')
  })

  it('7. Malformed request body without operationId returns 400 Bad Request', async () => {
    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-owner-token',
      },
      body: { invalidField: 123 },
    })
    assert.equal(res.status, 400)
    const data = await res.json()
    assert.equal(data.error.code, 'INVALID_ARGUMENT')
  })

  it('8. Non-existent import operation returns 404 Not Found', async () => {
    const nonExistentId = 'a'.repeat(64)
    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-owner-token',
      },
      body: { operationId: nonExistentId },
    })
    assert.equal(res.status, 404)
    const data = await res.json()
    assert.equal(data.error.code, 'NOT_FOUND')
  })

  it('9. Unready import operation returns 412 Precondition Failed', async () => {
    const opId = 'b'.repeat(64)
    mockDb._rawDocs.set(`users/user-owner/importOperations/${opId}`, {
      version: 2,
      ownerUid: 'user-owner',
      operationId: opId,
      fingerprint: 'b'.repeat(64),
      fileName: 'unready.csv',
      hashes: ['f'.repeat(64)],
      total: 10,
      skipped: 0,
      ready: false, // Not ready
    })

    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-owner-token',
      },
      body: { operationId: opId },
    })
    assert.equal(res.status, 412)
    const data = await res.json()
    assert.equal(data.error.code, 'FAILED_PRECONDITION')
  })

  it('10. Valid import execution commits transactions and trusted receipts', async () => {
    const fingerprint = 'c'.repeat(64)
    const opId = `${fingerprint}-11111111-2222-3333-4444-555555555555`
    const path = `users/user-owner/importOperations/${opId}`

    const rows = [
      {
        sourceRowId: 'Sheet::1',
        transactionId: await importRecordId(opId, 'row', 'Sheet::1'),
        description: 'Office stationery',
        amountPaise: 500,
        categoryId: 'supplies',
        dateMillis: 1700000000000,
        tripId: null,
        newTrip: null,
        paymentMode: 'Other',
        paymentAccountId: null,
      },
    ]

    const chunk = chunkSchema.parse({
      version: 2,
      operationId: opId,
      fingerprint,
      index: 0,
      rows,
    })

    const hash = await sha256(JSON.stringify(chunk))

    // Set up category reference
    mockDb._rawDocs.set(`users/user-owner/categories/supplies`, { name: 'Supplies' })

    // Set up import header and chunk in DB
    mockDb._rawDocs.set(path, {
      version: 2,
      ownerUid: 'user-owner',
      operationId: opId,
      fingerprint,
      fileName: 'test.xlsx',
      hashes: [hash],
      total: 1,
      skipped: 0,
      ready: true,
    })

    mockDb._rawDocs.set(`${path}/chunks/0`, {
      index: 0,
      hash,
      payload: JSON.stringify(chunk),
    })

    // Seed insights cache to verify deletion
    mockDb._rawDocs.set(`users/user-owner/insights/summary`, { cached: true })

    const res = await invokeHandler({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-owner-token',
      },
      body: { operationId: opId },
    })

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.result.imported, 1)
    assert.equal(body.result.complete, true)

    // Verify transaction exists in DB
    assert.ok(mockDb._rawDocs.has(`users/user-owner/transactions/${rows[0].transactionId}`))

    // Verify trusted receipt exists
    assert.ok(mockDb._rawDocs.has(`${path}/trustedV2Receipts/0`))

    // Verify insights cache was deleted
    assert.equal(mockDb._rawDocs.has(`users/user-owner/insights/summary`), false)
  })
})
