# Spenza — Security Architecture & Invariants

This document outlines the security controls, authentication mechanisms, data protection invariants, and threat models implemented across Spenza.

---

## 1. Authentication & Identity Management

- **Provider**: Google Sign-In via Firebase Authentication (`src/firebase/auth.ts`).
- **Identity Tokens**: Upon signing in, the Firebase Client SDK manages OAuth tokens and issues short-lived JWT ID tokens.
- **Client Route Protection**: The React application uses `ProtectedRoute.tsx` to guard all `/app/*` routes. Unauthenticated visitors are redirected to `/login`.
- **Server Identity Verification**: When the frontend communicates with the Vercel backend (`/api/repayment`, `/api/settlement`, `/api/import`), it attaches the Firebase ID token in the `Authorization: Bearer <token>` header.

---

## 2. Firestore Security Rules (`firestore.rules`)

Cloud Firestore is protected by comprehensive security rules that enforce schema validation, UID isolation, and boundary protection:

### 1. Multi-Tenant Path Isolation
All user collections reside under `users/{uid}/`. Security rules mandate:
```javascript
match /users/{uid}/{document=**} {
  allow read, write: if request.auth != null && request.auth.uid == uid;
}
```
A client can never read or modify another user's documents.

### 2. Guarding Sensitive & Server-Owned Documents
Certain subcollections represent immutable server-generated audit records. Clients are strictly forbidden from writing to these paths directly:
- `users/{uid}/transactions/{id}/settlements/{settlementId}`: Client writes are **DENIED**. Created exclusively by the trusted backend during settlements.
- `users/{uid}/importOperations/{id}/trustedV2Receipts/{receiptId}`: Client writes are **DENIED**. Generated exclusively by the trusted import executor.
- `users/{uid}/importOperations/{id}/trustedV2Trips/{tripId}`: Client writes are **DENIED**.
- `users/{uid}/importOperations/{id}/trustedV2State/execution`: Client writes are **DENIED**.

### 3. Payment Mode & Account Integrity
Rules enforce data integrity across payment modes:
- `Cash` or `Other`: `paymentAccountId` must be `null`.
- `UPI`, `Card`, or `Bank Transfer`: `paymentAccountId` must be a valid non-empty string.

### 4. Split & Ledger Tampering Prevention
Clients cannot modify historical `repaidPaise` balances directly or reduce split shares below amounts already repaid. Any repayment or settlement must pass through the serverless backend.

---

## 3. Server-Side Trusted Execution (Vercel Backend)

Sensitive multi-document financial workflows are executed server-side via Node.js serverless functions running on Vercel:

```
[ Incoming Request ]
         │
         ▼
[ vercelCommon.ts ]
   ├── 1. Enforces HTTP Method (POST only, OPTIONS handled for CORS)
   ├── 2. Enforces CORS Origin (ALLOWED_ORIGIN)
   ├── 3. Enforces Payload Size Limit (Max 64 KB)
   ├── 4. Extracts Authorization: Bearer <ID_TOKEN>
   └── 5. Verifies ID Token via Firebase Admin SDK
         │
         ▼
[ Extract Verified UID ]
   │
   └──► Rejects client-supplied UID tampering (IDOR Defense)
         │
         ▼
[ Execute Trusted Executor ] (Atomic Firestore Transaction)
```

### Key Server Security Guarantees:
1. **Server-Side Credentials**: The Firebase Admin SDK is initialized exclusively in the Vercel Node.js runtime using server-side environment variables (`FIREBASE_ADMIN_CREDENTIALS` or `FIREBASE_PRIVATE_KEY`). Private keys are **never** bundled into the client build.
2. **Authoritative UID Extraction**: The executor ignores any user ID supplied in the request JSON payload. The authenticated user's UID is extracted authoritatively from the cryptographically verified JWT token.
3. **Payload Cap**: Requests larger than 64 KB are rejected immediately with HTTP 413 (`Payload Too Large`), protecting the serverless runtime against payload exhaustion attacks.
4. **CORS Hardening**: Cross-Origin Resource Sharing is locked to `ALLOWED_ORIGIN` (configured to the production Firebase Hosting domain).

---

## 4. Concurrency, Idempotency & Fencing Guarantees

To ensure financial correctness during network retries or concurrent tab execution, backend operations use robust synchronization primitives:

### 1. Repayment Idempotency
- Every repayment request requires a unique `idempotencyKey`.
- Before executing, the transaction inspects `users/{uid}/transactions/{id}/repaymentReceipts/{idempotencyKey}`.
- If a receipt exists with identical parameters, the server replays the existing result immediately without re-applying the balance reduction.
- Reusing the same key with different parameters returns HTTP 409 Conflict.

### 2. Settlement Concurrency & Fencing
- Bulk settlements acquire an atomic execution lease with an incrementing `fencingToken` and TTL expiration.
- If two tabs attempt to settle dues simultaneously with the same key, only one runner acquires the lease; the second runner is serialized or blocked.
- Expired leases from interrupted runners can be safely superseded by new leases with a higher fencing token.

### 3. Chunked Import Validation Cursor
- Spreadsheet imports are submitted in bounded chunks against an immutable, frozen manifest (`importOperations/{operationId}`).
- A server-side state document (`trustedV2State/execution`) maintains an atomic cursor.
- Duplicate chunk submissions, out-of-order execution, or post-validation tampering of the header are rejected.

---

## 5. Secret Management & Environment Isolation

- **Client Environment (`.env.local`)**:
  - Contains only public `VITE_FIREBASE_*` configuration (API Key, Project ID, App ID).
  - Firebase Web API keys are identifiers, not secrets; security is enforced by Firestore security rules, not by keeping the client API key hidden.
- **Server Environment (Vercel)**:
  - Private service account keys (`FIREBASE_ADMIN_CREDENTIALS`) are stored exclusively in Vercel's encrypted environment variables dashboard.
  - Never committed to Git. `.gitignore` strictly excludes `.env.local`, `.env.*.local`, `.env.staging`, and `.env.production`.

---

## 6. Known Security Assumptions & Limitations

1. **Single-User Scope**: All users authenticate via their own Google accounts and manage their own private ledger. There is currently no administrative multi-tenant dashboard or organizational role-based access control (RBAC).
2. **Local Tests vs. Live Cloud Security**: Passing unit and emulator tests demonstrates architectural correctness, but does not substitute for testing live Firebase security rules and CORS configurations against deployed endpoints.
3. **Client Offline Queue**: Standard client-side offline writes queue in browser IndexedDB. While convenient, physical device access allows inspection of uncommitted local IndexedDB data. Users should sign out on shared devices.
