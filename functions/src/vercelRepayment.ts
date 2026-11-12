/**
 * Vercel Serverless Function adapter for Spenza repayment execution.
 *
 * Requirements & Invariants:
 * 1. Reuses existing `executeTrustedRepayment` from `./repaymentExecutor.ts` directly.
 * 2. Authenticates requests using Firebase ID tokens verified via Firebase Admin SDK.
 * 3. Derives user UID exclusively from the verified token claim; client-supplied UID cannot override it.
 * 4. Enforces HTTP POST method and request size limits (< 64KB).
 * 5. Applies CORS restrictions based on configured ALLOWED_ORIGINS.
 * 6. Maps HttpsError to appropriate HTTP status codes (400, 401, 403, 404, 409, 412, 500).
 * 7. Preserves transactional atomicity, repayment receipts, and insights invalidation.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { getApps, initializeApp, deleteApp, cert, type App } from 'firebase-admin/app'
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import { executeTrustedRepayment, type RepaymentExecutionResult } from './repaymentExecutor.ts'

export class RequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'RequestError'
    this.status = status
    this.code = code
  }
}

let adminApp: App | undefined

/**
 * Initializes and returns a singleton Firebase Admin App.
 *
 * In emulator mode: uses projectId without service account credentials.
 * In production on Vercel: uses FIREBASE_SERVICE_ACCOUNT_KEY secret or Google ADC.
 */
export function getAdminApp(): App {
  if (getApps().length > 0) {
    return getApps()[0]!
  }

  // 1. Emulator mode for local development and integration tests
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    const projectId =
      process.env.GCLOUD_PROJECT ||
      process.env.FIREBASE_PROJECT_ID ||
      process.env.VITE_FIREBASE_PROJECT_ID ||
      'spenza-90037'
    adminApp = initializeApp({ projectId }, 'spenza-vercel-backend')
    return adminApp
  }

  // 2. Production Vercel environment with service account secret
  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    try {
      const credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
      adminApp = initializeApp(
        {
          credential: cert(credentials),
          projectId: credentials.project_id || process.env.FIREBASE_PROJECT_ID || 'spenza-90037',
        },
        'spenza-vercel-backend'
      )
      return adminApp
    } catch (e: any) {
      console.error('[Spenza Vercel Backend] Invalid FIREBASE_SERVICE_ACCOUNT_KEY format:', e.message)
      throw new Error('Server configuration error: invalid Firebase credentials format.')
    }
  }

  // 3. Fallback: Google Application Default Credentials
  adminApp = initializeApp()
  return adminApp
}

/**
 * Reset Admin app singleton (for test isolation).
 */
export async function resetAdminApp(): Promise<void> {
  const apps = getApps()
  for (const app of apps) {
    try {
      await deleteApp(app)
    } catch {
      // ignore
    }
  }
  adminApp = undefined
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  if (res.writableEnded) return
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

export function applyCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin
  const rawAllowed =
    process.env.ALLOWED_ORIGINS ||
    'http://localhost:5173,http://localhost:4173,https://spenza-90037.web.app,https://spenza-90037.firebaseapp.com'
  const allowedOrigins = rawAllowed.split(',').map(s => s.trim().toLowerCase())

  if (origin) {
    const lowerOrigin = origin.toLowerCase()
    const isAllowed = allowedOrigins.includes('*') || allowedOrigins.includes(lowerOrigin)

    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    } else {
      // Origin not permitted by CORS policy
      return false
    }
  } else if (allowedOrigins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }

  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
  return true
}

export async function parseRequestBody(req: IncomingMessage, maxBytes = 65536): Promise<unknown> {
  // If pre-parsed by Vercel runtime or test harness
  const anyReq = req as any
  if (anyReq.body !== undefined && anyReq.body !== null) {
    if (typeof anyReq.body === 'string') {
      try {
        return JSON.parse(anyReq.body)
      } catch {
        throw new RequestError(400, 'INVALID_ARGUMENT', 'Malformed JSON in request body')
      }
    }
    return anyReq.body
  }

  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []

    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        req.destroy()
        reject(
          new RequestError(
            413,
            'PAYLOAD_TOO_LARGE',
            `Request payload exceeds limit of ${maxBytes} bytes`
          )
        )
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.trim() ? JSON.parse(text) : {})
      } catch {
        reject(new RequestError(400, 'INVALID_ARGUMENT', 'Malformed JSON in request body'))
      }
    })

    req.on('error', err => reject(err))
  })
}

export function mapHttpsErrorToHttpStatus(code: string): number {
  switch (code) {
    case 'invalid-argument':
      return 400
    case 'unauthenticated':
      return 401
    case 'permission-denied':
      return 403
    case 'not-found':
      return 404
    case 'already-exists':
      return 409
    case 'failed-precondition':
      return 412
    case 'resource-exhausted':
      return 429
    case 'cancelled':
      return 499
    case 'deadline-exceeded':
      return 504
    case 'unavailable':
      return 503
    default:
      return 500
  }
}

export interface RepaymentHandlerOptions {
  authVerifier?: (token: string) => Promise<DecodedIdToken>
  db?: any
}

/**
 * Main request handler for Vercel Node.js Serverless Function.
 */
export async function handleVercelRepayment(
  req: IncomingMessage,
  res: ServerResponse,
  options: RepaymentHandlerOptions = {}
): Promise<void> {
  // 1. Apply CORS
  const corsAllowed = applyCors(req, res)
  if (!corsAllowed) {
    sendJson(res, 403, {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Origin not allowed by CORS policy',
      },
    })
    return
  }

  // 2. Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  // 3. Enforce POST method
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS')
    sendJson(res, 405, {
      ok: false,
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: `HTTP method ${req.method || 'UNKNOWN'} is not supported. Use POST.`,
      },
    })
    return
  }

  // 4. Authenticate via Firebase ID token
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendJson(res, 401, {
      ok: false,
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Missing or malformed Authorization header with Bearer token.',
      },
    })
    return
  }

  const idToken = authHeader.slice(7).trim()
  if (!idToken) {
    sendJson(res, 401, {
      ok: false,
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Bearer token cannot be empty.',
      },
    })
    return
  }

  let decodedToken: DecodedIdToken
  try {
    if (options.authVerifier) {
      decodedToken = await options.authVerifier(idToken)
    } else {
      const app = getAdminApp()
      decodedToken = await getAuth(app).verifyIdToken(idToken)
    }
  } catch (err: any) {
    sendJson(res, 401, {
      ok: false,
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Invalid, malformed, or expired Firebase ID token.',
      },
    })
    return
  }

  // 5. Derive UID strictly from verified token
  const verifiedUid = decodedToken.uid
  if (!verifiedUid || typeof verifiedUid !== 'string' || !verifiedUid.trim()) {
    sendJson(res, 401, {
      ok: false,
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Token does not contain a valid user identity (UID).',
      },
    })
    return
  }

  // 6. Parse and validate request body
  let body: any
  try {
    body = await parseRequestBody(req)
  } catch (err) {
    if (err instanceof RequestError) {
      sendJson(res, err.status, {
        ok: false,
        error: {
          code: err.code,
          message: err.message,
        },
      })
      return
    }
    sendJson(res, 400, {
      ok: false,
      error: {
        code: 'INVALID_ARGUMENT',
        message: 'Could not read request body.',
      },
    })
    return
  }

  // 7. Prevent client-supplied UID tampering (IDOR guard)
  if (body && typeof body === 'object' && 'uid' in body && body.uid && body.uid !== verifiedUid) {
    sendJson(res, 403, {
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: 'Client-supplied UID does not match authenticated token UID.',
      },
    })
    return
  }

  // 8. Execute trusted repayment using existing pure executor
  try {
    let db: any
    if (options.db) {
      db = options.db
    } else {
      const app = getAdminApp()
      db = getFirestore(app)
    }
    const result: RepaymentExecutionResult = await executeTrustedRepayment(db, verifiedUid, body)

    sendJson(res, 200, {
      ok: true,
      result: {
        tx: result.tx,
        appliedPaise: result.appliedPaise,
        replayed: result.replayed,
      },
    })
  } catch (err: any) {
    if (err instanceof HttpsError) {
      const status = mapHttpsErrorToHttpStatus(err.code)
      sendJson(res, status, {
        ok: false,
        error: {
          code: err.code.toUpperCase(),
          message: err.message,
        },
      })
      return
    }

    console.error('[Spenza Vercel Backend] Unexpected repayment error:', err)
    sendJson(res, 500, {
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'Repayment could not be completed.',
      },
    })
  }
}
