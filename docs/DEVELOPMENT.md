# Spenza — Developer Guide & Local Setup

This guide details everything required to clone, configure, run, test, and build Spenza locally.

---

## 1. Prerequisites

Ensure your development environment meets the following requirements:

1. **Node.js**: **Node.js 22 LTS** is required.
   - Verified with `node -v` (should be `v22.x.x`).
   - The backend and test runner use Node 22 native features (including `--experimental-strip-types`).
2. **npm**: **npm 10+** (bundled with Node 22).
3. **Firebase CLI**: Install globally via `npm install -g firebase-tools`.
   - Verified with `firebase --version`.
4. **Java Runtime (Optional / Required for Emulators)**: **Java 11+ (JRE/JDK)** is required only if you intend to start the Firebase Local Emulator Suite (`firebase emulators:start`).

---

## 2. Installation & Workspace Setup

Clone the repository and install dependencies for both the root workspace and the functions package:

```bash
# 1. Install root dependencies (React, Vite, Tailwind v4, client SDKs)
npm install

# 2. Install functions dependencies (Firebase Admin, Functions SDK, backend testing)
npm --prefix functions install
```

---

## 3. Environment Variable Configuration

Spenza uses Vite environment variables prefixed with `VITE_`.

### Setting up `.env.local`

Create a local environment configuration file:

```bash
cp .env.example .env.local
```

Populate `.env.local` with your development or staging Firebase project keys:

```env
# Firebase Client SDK Configuration
VITE_FIREBASE_API_KEY=your_api_key_here
VITE_FIREBASE_AUTH_DOMAIN=your_project_id.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id_here
VITE_FIREBASE_STORAGE_BUCKET=your_project_id.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id_here
VITE_FIREBASE_APP_ID=your_app_id_here

# Backend API Configuration (Vercel Serverless Function URL or local dev tunnel)
VITE_BACKEND_API_URL=https://your-vercel-backend.vercel.app
```

> ⚠️ **Important Build-Time Inlining**: Vite statically inlines `VITE_*` environment variables during production builds (`npm run build:prod`). If you change your backend URL or Firebase configuration, you must re-run the build.

---

## 4. Local Development

### 1. Starting the Frontend Dev Server

```bash
npm run dev
```

This starts the Vite development server (typically at `http://localhost:5173`) with Hot Module Replacement (HMR).

### 2. Previewing the Production Build

```bash
npm run preview
```

Serves the contents of `dist/` locally to verify production chunking and service worker registration before deployment.

---

## 5. Working with Firebase Local Emulators

For completely isolated offline development without connecting to live cloud databases:

### 1. Start the Emulator Suite

```bash
firebase emulators:start --only auth,firestore,functions --project demo-spenza-test
```

Default Emulator Ports (defined in `firebase.json`):
- **Auth**: `http://127.0.0.1:9099`
- **Firestore**: `http://127.0.0.1:8080`
- **Functions**: `http://127.0.0.1:5001`
- **Emulator UI**: `http://127.0.0.1:4000`

### 2. Configure Frontend to Target Emulators

In your `.env.local`, enable emulator mode:

```env
VITE_USE_FIREBASE_EMULATOR=true
VITE_FIREBASE_EMULATOR_HOST=127.0.0.1
```

When `VITE_USE_FIREBASE_EMULATOR=true` is set:
- Firebase Auth and Firestore automatically connect to localhost ports.
- `src/services/backendApi.ts` automatically routes repayment, settlement, and import operations to the local Cloud Functions callable emulator, bypassing external HTTP endpoints.

---

## 6. Running Tests

### 1. Frontend Unit & Invariant Tests
Runs all unit tests in `src/` using Node's native test runner:

```powershell
# PowerShell
$testPaths = @(Get-ChildItem -Recurse -Path src -Filter '*.test.ts' | Select-Object -ExpandProperty FullName)
node --experimental-strip-types --test $testPaths
```

```bash
# Bash
testPaths=$(find src -name '*.test.ts')
node --experimental-strip-types --test $testPaths
```

### 2. Backend Executor & Adapter Tests
Runs all pure financial executor and Vercel adapter tests in `functions/`:

```bash
npm --prefix functions test
```

### 3. Emulator Integration Tests
Specialized tests verify callable function security, atomic transactions, and composite indexes against active emulators:

```bash
# Set emulator environment flags
export SPENZA_FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
export SPENZA_CALLABLE_EMULATORS="1"

# Run emulator test suites
node --experimental-strip-types --test functions/test/callable.emulator.test.ts
node --experimental-strip-types --test functions/test/importExecutor.emulator.test.ts
node --experimental-strip-types --test src/services/__tests__/importRules.emulator.test.ts
node --experimental-strip-types --test src/services/__tests__/recurringIndex.emulator.test.ts
```

### 4. End-to-End Browser Tests (Playwright)

```bash
npm run test:e2e
```

Executes browser-level test suites under `e2e/`, testing navigation, PWA offline behavior, multi-tab invalidation, and authentication flows.

---

## 7. Typechecking & Code Quality

Spenza enforces strict TypeScript compilation across four distinct project configurations:

```bash
# 1. Frontend Application
node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit --incremental false

# 2. Vite & Node Tooling
node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit --incremental false

# 3. Vercel Serverless API Routes
node node_modules/typescript/bin/tsc -p api/tsconfig.json --noEmit

# 4. Backend Cloud Functions & Adapters
npm --prefix functions run typecheck

# 5. Fast Rust Linter (oxlint)
npm run lint
```

---

## 8. Automated Release Check Pipeline

Before staging a release or deploying, run the unified release verification script:

```bash
npm run check:release:prod
```

This runs the complete pre-release quality gate defined in `scripts/releaseCheck.mjs`:
1. Executes all frontend unit tests.
2. Executes all backend unit tests.
3. Checks all TypeScript projects.
4. Runs `oxlint`.
5. Compiles backend functions (`functions/lib/`).
6. Executes a full production frontend build (`npm run build:prod`) with fail-closed environment variable validation.
