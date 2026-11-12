/**
 * Vercel Serverless Function adapter for Spenza settlement execution.
 *
 * Requirements & Invariants:
 * 1. Reuses existing `executeTrustedSettlement` from `./settlementExecutor.ts` directly.
 * 2. Authenticates requests using Firebase ID tokens verified via Firebase Admin SDK.
 * 3. Derives user UID exclusively from the verified token claim; client-supplied UID cannot override it.
 * 4. Enforces HTTP POST method and request size limits (< 64KB).
 * 5. Applies CORS restrictions based on configured ALLOWED_ORIGINS.
 * 6. Preserves leasing, fencing, continuation, and multi-mode settlements (splitShare, transactionSplits, personAllDues).
 * 7. Maps HttpsError to appropriate standard HTTP status codes.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'
import {
  applyCors,
  authenticateRequest,
  assertCallerUidMatch,
  getAdminApp,
  mapHttpsErrorToHttpStatus,
  parseRequestBody,
  sendJson,
  RequestError,
  type AuthOptions,
} from './vercelCommon.ts'
import {
  executeTrustedSettlement,
  type SettleSplitShareResult,
  type SettleAllTransactionSplitsResult,
  type SettlePersonAllDuesResult,
} from './settlementExecutor.ts'

export interface SettlementHandlerOptions extends AuthOptions {
  db?: any
}

/**
 * Main request handler for Vercel Settlement API (/api/settlement).
 */
export async function handleVercelSettlement(
  req: IncomingMessage,
  res: ServerResponse,
  options: SettlementHandlerOptions = {}
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

  // 4. Authenticate via Firebase ID token and derive UID
  let verifiedUid: string
  try {
    verifiedUid = await authenticateRequest(req, options)
  } catch (err: any) {
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
    sendJson(res, 401, {
      ok: false,
      error: {
        code: 'UNAUTHENTICATED',
        message: 'Authentication failed.',
      },
    })
    return
  }

  // 5. Parse and validate request body
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

  // 6. Prevent client-supplied UID tampering (IDOR guard)
  try {
    assertCallerUidMatch(verifiedUid, body)
  } catch (err: any) {
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
  }

  // 7. Execute trusted settlement using existing pure executor
  try {
    let db: any
    if (options.db) {
      db = options.db
    } else {
      const app = getAdminApp()
      db = getFirestore(app)
    }

    const result:
      | SettleSplitShareResult
      | SettleAllTransactionSplitsResult
      | SettlePersonAllDuesResult = await executeTrustedSettlement(db, verifiedUid, body)

    sendJson(res, 200, {
      ok: true,
      result,
    })
  } catch (err: any) {
    if (err instanceof HttpsError) {
      const status = mapHttpsErrorToHttpStatus(err.code)
      sendJson(res, status, {
        ok: false,
        error: {
          code: err.code.toUpperCase().replace(/-/g, '_'),
          message: err.message,
          details: err.details,
        },
      })
      return
    }

    console.error('[Spenza Vercel Backend] Unexpected settlement error:', err)
    sendJson(res, 500, {
      ok: false,
      error: {
        code: 'INTERNAL',
        message: 'Settlement could not be completed.',
      },
    })
  }
}
