/**
 * Shared Backend API Client (Vercel HTTP & Firebase Callable Dispatcher)
 *
 * Dispatches financial operations to either:
 * 1. The Vercel HTTP backend (/api/repayment, /api/settlement, /api/import) when configured,
 *    authenticating requests via the signed-in user's Firebase ID token.
 * 2. The Firebase Cloud Functions callable emulator when running in local development/test
 *    with emulator mode enabled.
 *
 * Guarantees:
 * - Server-side authentication: Obtains Firebase ID token from Auth SDK and sends 'Authorization: Bearer <token>'
 * - Strict multi-tenant security: Never leaks credentials or trusts unverified client UIDs
 * - Production safety: Rejects emulator usage and undefined backend URLs in production/staging builds
 * - Callable compatibility: Translates HTTP errors and status codes into Firebase-compatible error codes
 * - Zero fallback to insecure direct writes: Never performs unauthorized client-side ledger writes on failure
 */

import type { Auth } from 'firebase/auth'
import type { Functions } from 'firebase/functions'

export class BackendCallableError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'BackendCallableError'
    this.code = code
    this.details = details
  }
}

export type BackendStrategy =
  | { type: 'http'; baseUrl: string }
  | { type: 'callable' }

export function mapStatusToCallableCode(status: number): string {
  switch (status) {
    case 400:
      return 'functions/invalid-argument'
    case 401:
      return 'functions/unauthenticated'
    case 403:
      return 'functions/permission-denied'
    case 404:
      return 'functions/not-found'
    case 409:
      return 'functions/already-exists'
    case 412:
      return 'functions/failed-precondition'
    case 413:
    case 429:
      return 'functions/resource-exhausted'
    default:
      if (status >= 500 && status < 600) {
        return 'functions/unavailable'
      }
      return 'functions/internal'
  }
}

export function normalizeToCallableCode(rawCode: string | undefined, status: number): string {
  if (!rawCode) {
    return mapStatusToCallableCode(status)
  }
  const clean = rawCode.trim()
  if (clean.startsWith('functions/')) {
    return clean
  }
  // Convert UPPER_SNAKE_CASE or hyphenated to functions/kebab-case
  const kebab = clean.toLowerCase().replace(/_/g, '-')
  return `functions/${kebab}`
}

export function resolveBackendStrategy(
  env: Record<string, any> = import.meta.env
): BackendStrategy {
  const mode = (env.MODE || 'production').toLowerCase().trim()
  const isDeployable = mode === 'production' || mode === 'staging'
  const isEmulator = env.VITE_USE_FIREBASE_EMULATOR === 'true'
  const rawUrl = (env.VITE_BACKEND_API_URL || '').trim()

  if (isDeployable) {
    if (isEmulator) {
      throw new BackendCallableError(
        'functions/failed-precondition',
        'Production/staging build cannot target Firebase emulator.'
      )
    }
    if (!rawUrl) {
      throw new BackendCallableError(
        'functions/unavailable',
        'Backend API URL is undefined. VITE_BACKEND_API_URL must be configured in production/staging.'
      )
    }
    if (rawUrl.includes('localhost') || rawUrl.includes('127.0.0.1')) {
      throw new BackendCallableError(
        'functions/failed-precondition',
        'Production/staging build cannot target local loopback for VITE_BACKEND_API_URL.'
      )
    }
    if (!rawUrl.startsWith('https://')) {
      throw new BackendCallableError(
        'functions/failed-precondition',
        'VITE_BACKEND_API_URL must use HTTPS in production/staging.'
      )
    }
    return { type: 'http', baseUrl: rawUrl.replace(/\/+$/, '') }
  }

  // Development / Test modes
  if (rawUrl) {
    return { type: 'http', baseUrl: rawUrl.replace(/\/+$/, '') }
  }

  if (isEmulator) {
    return { type: 'callable' }
  }

  throw new BackendCallableError(
    'functions/unavailable',
    'Neither VITE_BACKEND_API_URL nor Firebase Emulator is configured.'
  )
}

let firebaseInstances: { auth: Auth; functions: Functions } | null = null

async function getFirebaseInstances() {
  if (!firebaseInstances) {
    const config = await import('../firebase/config.ts')
    firebaseInstances = { auth: config.auth, functions: config.functions }
  }
  return firebaseInstances
}

export interface BackendCallOptions<TReq> {
  endpoint: string // e.g. '/api/repayment'
  callableName: string // e.g. 'executeRepaymentV1'
  payload: TReq
  timeoutMs?: number
  // Test injection hooks
  getIdToken?: () => Promise<string>
  fetchImpl?: typeof fetch
  env?: Record<string, any>
}

export async function callBackend<TReq, TRes>(
  options: BackendCallOptions<TReq>
): Promise<{ data: TRes }> {
  const strategy = resolveBackendStrategy(options.env)

  if (strategy.type === 'callable') {
    const { functions } = await getFirebaseInstances()
    const { httpsCallable } = await import('firebase/functions')
    const callable = httpsCallable<TReq, TRes>(
      functions,
      options.callableName,
      options.timeoutMs ? { timeout: options.timeoutMs } : undefined
    )
    return callable(options.payload)
  }

  // HTTP Strategy
  let idToken: string
  try {
    if (options.getIdToken) {
      idToken = await options.getIdToken()
    } else {
      const { auth } = await getFirebaseInstances()
      const user = auth.currentUser
      if (!user) {
        throw new BackendCallableError(
          'functions/unauthenticated',
          'User must be authenticated to perform this operation.'
        )
      }
      idToken = await user.getIdToken()
    }
  } catch (tokenErr: any) {
    if (tokenErr instanceof BackendCallableError) {
      throw tokenErr
    }
    throw new BackendCallableError(
      'functions/unauthenticated',
      tokenErr?.message || 'Failed to retrieve authentication token.'
    )
  }

  const url = `${strategy.baseUrl}${options.endpoint}`
  const fetchFn = options.fetchImpl || fetch

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timeoutId =
    controller && options.timeoutMs
      ? setTimeout(() => controller.abort(), options.timeoutMs)
      : null

  let response: Response
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(options.payload),
      signal: controller ? controller.signal : undefined,
    })
  } catch (netErr: any) {
    if (netErr?.name === 'AbortError') {
      throw new BackendCallableError(
        'functions/deadline-exceeded',
        `Request to ${options.endpoint} timed out after ${options.timeoutMs}ms.`
      )
    }
    throw new BackendCallableError(
      'functions/unavailable',
      netErr?.message || 'The backend is unavailable. Check your network connection.'
    )
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }

  let body: any
  try {
    body = await response.json()
  } catch {
    const code = mapStatusToCallableCode(response.status)
    throw new BackendCallableError(
      code,
      `Backend returned HTTP ${response.status}: ${response.statusText || 'Non-JSON response'}`
    )
  }

  if (!response.ok || body.ok === false) {
    const errPayload = body.error || {}
    const code = normalizeToCallableCode(errPayload.code, response.status)
    const message = errPayload.message || `Request failed with status ${response.status}`
    throw new BackendCallableError(code, message, errPayload.details)
  }

  return { data: body.data }
}
