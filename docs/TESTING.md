# Spenza — Testing Strategy & Verification Guide

Spenza employs a multi-tiered testing strategy designed to verify financial arithmetic, transaction atomicity, security boundaries, and offline resilience.

---

## 1. Automated Test Suite Summary

At HEAD commit `0eeec73`, the repository maintains **505 automated unit and integration tests** passing with 0 errors across two test runners:

| Test Scope | Runner / Tool | Test Files | Total Tests |
| :--- | :--- | :--- | :--- |
| **Frontend Unit & Logic** | Node.js Test Runner (`--test`) | 40 test files in `src/` | **425 passing** (4 skipped emulator suites) |
| **Backend & Vercel Adapters** | Node.js Test Runner (`--test`) | 8 test files in `functions/test/` | **80 passing** (5 skipped emulator suites) |
| **End-to-End Browser Suites** | Playwright (`@playwright/test`) | 5 spec files in `e2e/` | Dynamic browser matrices |

---

## 2. Test Architecture by Area

### 1. Financial Invariants & Split Accounting
- `src/utils/__tests__/splitMath.test.ts`:
  - Verifies integer-paise remainder distribution (e.g. ₹100 split 3 ways yields 3334, 3333, 3333 paise).
  - Asserts that gross outflow always equals net personal spend plus recoverable principal.
  - Verifies that repayments change outstanding dues without altering historical gross spending.
- `src/features/transactions/__tests__/splitExpenseForm.test.ts`:
  - Validates that editing a split expense preserves historical repayments.
  - Enforces that a participant's share cannot be reduced below the amount they have already repaid.
- `src/utils/__tests__/insightsMath.test.ts` & `recurringMath.test.ts`:
  - Confirms that recoverable debts and repayments never create phantom spikes or dips in monthly spend analytics.

### 2. Backend Executors & Concurrency Fencing
- `functions/test/settlementExecutor.test.ts`:
  - Simulates concurrent runners attempting bulk settlement with the same idempotency key.
  - Verifies that expired leases increment the `fencingToken`, allowing clean recovery without orphaned debt states.
- `functions/test/importExecutor.test.ts`:
  - Tests 10,000-row multibyte Excel payload rejection before persistence.
  - Tests atomic chunk ingestion, cursor advancing, and rollback upon simulated network failure.

### 3. Vercel Serverless HTTP Adapters
- `functions/test/vercelRepayment.test.ts`, `vercelSettlement.test.ts`, `vercelImport.test.ts`:
  - Tests HTTP preflight (`OPTIONS`) and CORS header responses.
  - Tests rejection of unauthorized requests (missing or invalid `Authorization: Bearer <token>`).
  - Tests IDOR defenses (tampered client UIDs are rejected with HTTP 403).
  - Tests payload cap enforcement (> 64 KB rejected with HTTP 413).

### 4. Browser End-to-End (Playwright)
- `e2e/foundation.spec.ts`: Core application mounting and navigation.
- `e2e/pwa-auth.spec.ts`: PWA manifest, service worker lifecycle, and login flows.
- `e2e/multitab-offline.spec.ts`: Multi-tab synchronization and cross-tab cache invalidation.
- `e2e/offline-recovery.spec.ts`: Offline expense creation, pending write badges, and sync resumption.

---

## 3. How to Run the Test Suites

### 1. Frontend Tests
```powershell
# PowerShell
$testPaths = @(Get-ChildItem -Recurse -Path src -Filter '*.test.ts' | Select-Object -ExpandProperty FullName)
node --experimental-strip-types --test $testPaths
```

### 2. Backend & Vercel Tests
```bash
npm --prefix functions test
```

### 3. Firebase Emulator Tests
When emulators are offline, emulator-dependent tests skip cleanly. To run the full live emulator integration suite:
```bash
# Terminal 1: Start emulators
firebase emulators:start --only auth,firestore,functions --project demo-spenza-test

# Terminal 2: Run emulator tests
export SPENZA_FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
export SPENZA_CALLABLE_EMULATORS="1"
node --experimental-strip-types --test functions/test/callable.emulator.test.ts
node --experimental-strip-types --test functions/test/importExecutor.emulator.test.ts
node --experimental-strip-types --test src/services/__tests__/importRules.emulator.test.ts
node --experimental-strip-types --test src/services/__tests__/recurringIndex.emulator.test.ts
```

### 4. Playwright E2E Tests
```bash
npm run test:e2e
```

---

## 4. Known Testing Limitations & Gaps

1. **Passing Local Tests $\neq$ Live Cloud Deployment Success**:
   - Unit tests use in-memory mocks and local emulators.
   - Local tests cannot detect production-only issues such as:
     - Cloud Firestore composite index building delays.
     - Live Google OAuth redirect domain misconfiguration.
     - Strict production CORS origin mismatches between Hosting and Vercel.
2. **Third-Party Rate Limits**:
   - Tests do not benchmark live Google Cloud or Vercel edge network latency or rate limiting under heavy concurrency.
3. **Receipt Image Upload Testing**:
   - Image upload workflows are not covered by automated E2E tests because the UI form binding has not yet been built.
