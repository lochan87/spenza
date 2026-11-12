/**
 * Shared utilities for Spenza Vercel Serverless Function adapters.
 *
 * Implements:
 * - Firebase Admin singleton initialization (emulator-safe, ADC and service-account secret)
 * - Firebase ID Token authentication and verification
 * - Caller UID derivation and IDOR tampering protection
 * - Standardized CORS verification and preflight handling
 * - Request stream buffering with strict payload-size limits
 * - HttpsError status code mapping
 * - Standardized structured JSON responses
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { getApps, initializeApp, deleteApp, cert, type App } from 'firebase-admin/app'
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth'

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

export interface AuthOptions {
  authVerifier?: (token: string) => Promise<DecodedIdToken>
}

/**
 * Authenticates request via Authorization: Bearer <idToken>.
 * Derives user UID strictly from verified token claims.
 */
export async function authenticateRequest(
  req: IncomingMessage,
  options: AuthOptions = {}
): Promise<string> {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new RequestError(
      401,
      'UNAUTHENTICATED',
      'Missing or malformed Authorization header with Bearer token.'
    )
  }

  const idToken = authHeader.slice(7).trim()
  if (!idToken) {
    throw new RequestError(401, 'UNAUTHENTICATED', 'Bearer token cannot be empty.')
  }

  let decodedToken: DecodedIdToken
  try {
    if (options.authVerifier) {
      decodedToken = await options.authVerifier(idToken)
    } else {
      const app = getAdminApp()
      decodedToken = await getAuth(app).verifyIdToken(idToken)
    }
  } catch {
    throw new RequestError(
      401,
      'UNAUTHENTICATED',
      'Invalid, malformed, or expired Firebase ID token.'
    )
  }

  const verifiedUid = decodedToken.uid
  if (!verifiedUid || typeof verifiedUid !== 'string' || !verifiedUid.trim()) {
    throw new RequestError(
      401,
      'UNAUTHENTICATED',
      'Token does not contain a valid user identity (UID).'
    )
  }

  return verifiedUid
}

/**
 * Enforces that a client-supplied UID cannot override or conflict with the token UID (IDOR guard).
 */
export function assertCallerUidMatch(verifiedUid: string, body: unknown): void {
  if (body && typeof body === 'object' && 'uid' in body && body.uid && body.uid !== verifiedUid) {
    throw new RequestError(
      403,
      'PERMISSION_DENIED',
      'Client-supplied UID does not match authenticated token UID.'
    )
  }
}
