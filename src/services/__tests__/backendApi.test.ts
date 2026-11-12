import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BackendCallableError,
  resolveBackendStrategy,
  mapStatusToCallableCode,
  normalizeToCallableCode,
  callBackend,
} from '../backendApi.ts'

describe('Shared Backend API Client (Phase 10.4)', () => {
  describe('Strategy Resolution & Safety Gates', () => {
    it('throws in production when VITE_BACKEND_API_URL is undefined', () => {
      assert.throws(
        () => resolveBackendStrategy({ MODE: 'production', VITE_BACKEND_API_URL: '' }),
        (err: any) => {
          assert.equal(err instanceof BackendCallableError, true)
          assert.equal(err.code, 'functions/unavailable')
          assert.match(err.message, /VITE_BACKEND_API_URL must be configured/)
          return true
        }
      )
    })

    it('throws in production when VITE_USE_FIREBASE_EMULATOR is true', () => {
      assert.throws(
        () =>
          resolveBackendStrategy({
            MODE: 'production',
            VITE_BACKEND_API_URL: 'https://api.spenza.com',
            VITE_USE_FIREBASE_EMULATOR: 'true',
          }),
        (err: any) => {
          assert.equal(err.code, 'functions/failed-precondition')
          assert.match(err.message, /cannot target Firebase emulator/)
          return true
        }
      )
    })

    it('throws in staging when VITE_USE_FIREBASE_EMULATOR is true', () => {
      assert.throws(
        () =>
          resolveBackendStrategy({
            MODE: 'staging',
            VITE_BACKEND_API_URL: 'https://staging.spenza.com',
            VITE_USE_FIREBASE_EMULATOR: 'true',
          }),
        (err: any) => {
          assert.equal(err.code, 'functions/failed-precondition')
          assert.match(err.message, /cannot target Firebase emulator/)
          return true
        }
      )
    })

    it('throws in production when VITE_BACKEND_API_URL targets local loopback', () => {
      const loopbacks = [
        'http://localhost:3000',
        'http://127.0.0.1:5001',
        'https://localhost:8080',
      ]
      for (const url of loopbacks) {
        assert.throws(
          () => resolveBackendStrategy({ MODE: 'production', VITE_BACKEND_API_URL: url }),
          (err: any) => {
            assert.equal(err.code, 'functions/failed-precondition')
            assert.match(err.message, /cannot target local loopback/)
            return true
          }
        )
      }
    })

    it('throws in production when VITE_BACKEND_API_URL does not use HTTPS', () => {
      assert.throws(
        () =>
          resolveBackendStrategy({
            MODE: 'production',
            VITE_BACKEND_API_URL: 'http://insecure-api.spenza.com',
          }),
        (err: any) => {
          assert.equal(err.code, 'functions/failed-precondition')
          assert.match(err.message, /must use HTTPS/)
          return true
        }
      )
    })

    it('resolves HTTPS Vercel URL in production and trims trailing slashes', () => {
      const strategy = resolveBackendStrategy({
        MODE: 'production',
        VITE_BACKEND_API_URL: 'https://spenza-backend.vercel.app///',
      })
      assert.deepEqual(strategy, {
        type: 'http',
        baseUrl: 'https://spenza-backend.vercel.app',
      })
    })

    it('resolves HTTP strategy in development mode when URL is configured', () => {
      const strategy = resolveBackendStrategy({
        MODE: 'development',
        VITE_BACKEND_API_URL: 'http://localhost:3000',
      })
      assert.deepEqual(strategy, {
        type: 'http',
        baseUrl: 'http://localhost:3000',
      })
    })

    it('resolves callable strategy in development mode when emulator is enabled without URL', () => {
      const strategy = resolveBackendStrategy({
        MODE: 'development',
        VITE_USE_FIREBASE_EMULATOR: 'true',
      })
      assert.deepEqual(strategy, {
        type: 'callable',
      })
    })

    it('throws in development when neither backend URL nor emulator is configured', () => {
      assert.throws(
        () => resolveBackendStrategy({ MODE: 'development' }),
        (err: any) => {
          assert.equal(err.code, 'functions/unavailable')
          return true
        }
      )
    })
  })

  describe('Callable Error Code Mapping & Normalization', () => {
    it('normalizes uppercase snake_case server codes to functions/kebab-case', () => {
      assert.equal(normalizeToCallableCode('UNAUTHENTICATED', 401), 'functions/unauthenticated')
      assert.equal(normalizeToCallableCode('NOT_FOUND', 404), 'functions/not-found')
      assert.equal(normalizeToCallableCode('ALREADY_EXISTS', 409), 'functions/already-exists')
      assert.equal(normalizeToCallableCode('INVALID_ARGUMENT', 400), 'functions/invalid-argument')
      assert.equal(normalizeToCallableCode('FAILED_PRECONDITION', 412), 'functions/failed-precondition')
      assert.equal(normalizeToCallableCode('PERMISSION_DENIED', 403), 'functions/permission-denied')
      assert.equal(normalizeToCallableCode('RESOURCE_EXHAUSTED', 429), 'functions/resource-exhausted')
      assert.equal(normalizeToCallableCode('INTERNAL', 500), 'functions/internal')
    })

    it('preserves existing functions/ prefixed codes', () => {
      assert.equal(
        normalizeToCallableCode('functions/unauthenticated', 401),
        'functions/unauthenticated'
      )
      assert.equal(
        normalizeToCallableCode('functions/permission-denied', 403),
        'functions/permission-denied'
      )
    })

    it('maps HTTP status codes to canonical callable codes when raw code is absent', () => {
      assert.equal(mapStatusToCallableCode(400), 'functions/invalid-argument')
      assert.equal(mapStatusToCallableCode(401), 'functions/unauthenticated')
      assert.equal(mapStatusToCallableCode(403), 'functions/permission-denied')
      assert.equal(mapStatusToCallableCode(404), 'functions/not-found')
      assert.equal(mapStatusToCallableCode(409), 'functions/already-exists')
      assert.equal(mapStatusToCallableCode(412), 'functions/failed-precondition')
      assert.equal(mapStatusToCallableCode(413), 'functions/resource-exhausted')
      assert.equal(mapStatusToCallableCode(429), 'functions/resource-exhausted')
      assert.equal(mapStatusToCallableCode(500), 'functions/unavailable')
      assert.equal(mapStatusToCallableCode(502), 'functions/unavailable')
      assert.equal(mapStatusToCallableCode(503), 'functions/unavailable')
    })
  })

  describe('HTTP Client Execution & Error Handling', () => {
    it('throws functions/unauthenticated if getIdToken fails', async () => {
      await assert.rejects(
        () =>
          callBackend({
            endpoint: '/api/repayment',
            callableName: 'executeRepaymentV1',
            payload: { test: true },
            env: { MODE: 'development', VITE_BACKEND_API_URL: 'http://localhost:3000' },
            getIdToken: async () => {
              throw new Error('Token expired')
            },
          }),
        (err: any) => {
          assert.equal(err.code, 'functions/unauthenticated')
          assert.match(err.message, /Token expired/)
          return true
        }
      )
    })

    it('sends correct method, headers, auth bearer token, and serialized body', async () => {
      let capturedUrl = ''
      let capturedInit: RequestInit | undefined

      const mockFetch: typeof fetch = async (input, init) => {
        capturedUrl = String(input)
        capturedInit = init
        return new Response(
          JSON.stringify({
            ok: true,
            data: { appliedPaise: 1500, tx: { id: 'tx-1' } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      const res = await callBackend({
        endpoint: '/api/repayment',
        callableName: 'executeRepaymentV1',
        payload: {
          transactionId: 'tx-1',
          personId: 'alice',
          repaymentPaise: 1500,
          idempotencyKey: 'key-123',
        },
        env: { MODE: 'development', VITE_BACKEND_API_URL: 'https://backend.example.com' },
        getIdToken: async () => 'mock-jwt-token-xyz',
        fetchImpl: mockFetch,
      })

      assert.equal(capturedUrl, 'https://backend.example.com/api/repayment')
      assert.equal(capturedInit?.method, 'POST')
      const headers = capturedInit?.headers as Record<string, string>
      assert.equal(headers['Content-Type'], 'application/json')
      assert.equal(headers['Authorization'], 'Bearer mock-jwt-token-xyz')
      assert.deepEqual(JSON.parse(capturedInit?.body as string), {
        transactionId: 'tx-1',
        personId: 'alice',
        repaymentPaise: 1500,
        idempotencyKey: 'key-123',
      })
      assert.deepEqual(res.data, {
        appliedPaise: 1500,
        tx: { id: 'tx-1' },
      })
    })

    it('translates backend error responses into BackendCallableError with details', async () => {
      const mockFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: 'ALREADY_EXISTS',
              message: 'Idempotency key reuse with differing parameters',
              details: { conflict: true },
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } }
        )

      await assert.rejects(
        () =>
          callBackend({
            endpoint: '/api/settlement',
            callableName: 'executeSettlementV1',
            payload: { mode: 'splitShare' },
            env: { MODE: 'development', VITE_BACKEND_API_URL: 'https://backend.example.com' },
            getIdToken: async () => 'mock-token',
            fetchImpl: mockFetch,
          }),
        (err: any) => {
          assert.equal(err instanceof BackendCallableError, true)
          assert.equal(err.code, 'functions/already-exists')
          assert.match(err.message, /Idempotency key reuse/)
          assert.deepEqual(err.details, { conflict: true })
          return true
        }
      )
    })

    it('translates import-size-limit error details correctly', async () => {
      const mockFetch: typeof fetch = async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: 'INVALID_ARGUMENT',
              message: 'Payload exceeded plan limits',
              details: { reason: 'import-size-limit' },
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )

      await assert.rejects(
        () =>
          callBackend({
            endpoint: '/api/import',
            callableName: 'executeImportV2',
            payload: { operationId: 'op-123' },
            env: { MODE: 'development', VITE_BACKEND_API_URL: 'https://backend.example.com' },
            getIdToken: async () => 'mock-token',
            fetchImpl: mockFetch,
          }),
        (err: any) => {
          assert.equal(err.code, 'functions/invalid-argument')
          assert.equal(err.details?.reason, 'import-size-limit')
          return true
        }
      )
    })

    it('handles network failure (fetch throws) as functions/unavailable', async () => {
      const mockFetch: typeof fetch = async () => {
        throw new TypeError('Failed to fetch')
      }

      await assert.rejects(
        () =>
          callBackend({
            endpoint: '/api/repayment',
            callableName: 'executeRepaymentV1',
            payload: {},
            env: { MODE: 'development', VITE_BACKEND_API_URL: 'https://backend.example.com' },
            getIdToken: async () => 'mock-token',
            fetchImpl: mockFetch,
          }),
        (err: any) => {
          assert.equal(err.code, 'functions/unavailable')
          assert.match(err.message, /Failed to fetch/)
          return true
        }
      )
    })

    it('handles non-JSON gateway error response as functions/unavailable', async () => {
      const mockFetch: typeof fetch = async () =>
        new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        })

      await assert.rejects(
        () =>
          callBackend({
            endpoint: '/api/repayment',
            callableName: 'executeRepaymentV1',
            payload: {},
            env: { MODE: 'development', VITE_BACKEND_API_URL: 'https://backend.example.com' },
            getIdToken: async () => 'mock-token',
            fetchImpl: mockFetch,
          }),
        (err: any) => {
          assert.equal(err.code, 'functions/unavailable')
          assert.match(err.message, /502/)
          return true
        }
      )
    })
  })
})
