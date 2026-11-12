# Spenza — Current Project Status & Readiness

**Current Commit**: `0eeec7369898792dcc79d4f04c8f923b4900c71c` (`0eeec73`)  
**Branch**: `main` (Ahead of `origin/main` by 96 commits)  
**Working Tree**: Clean (Documentation update pending)  
**Readiness Verdict**: **Ready to Push to GitHub; Deployment Prerequisites Pending**

---

## 1. Verified Working Capabilities

Spenza is fully implemented across its core personal finance domains. All features are verified locally by automated unit, invariant, and integration test suites:

- **Financial Ledger & Math**: Complete integer-paise calculations, remainder distribution, and recoverable debt accounting.
- **Transactions & Navigation**: Date-grouped ledger, multi-filter queries, collapsible trip bundles, and quick-add drawer.
- **Split Bills & Settlements**: Friends ledger (`/app/people`), contact onboarding, atomic Vercel settlements, and repayment preservation.
- **Trips Management**: Dedicated trip budgets, day-by-day spend logs, and 5 spending buckets.
- **Recurring Commitments**: Weekly/monthly/yearly schedule management, UTC calendar normalization, and app-wide overdue prompts.
- **Monthly Budgets**: Total and category-level monthly allocations with previous-month cloning.
- **Insights & Analytics**: 12-month spending curves, pacing projections, and 7-day Firestore summary cache.
- **Spreadsheet Ingestion**: Multi-sheet Excel & CSV parsing, column auto-detection, date correction, and chunked server execution.
- **Vercel Serverless Backend**: Serverless API routes (`/api/repayment`, `/api/settlement`, `/api/import`) backed by pure trusted executors and server-side Firebase Admin ID token verification.
- **PWA & Offline Resilience**: Installable app shell, Workbox runtime caching, and IndexedDB multi-tab persistence.

---

## 2. Code Quality & Test Metrics

- **Frontend Unit Tests**: 425 passing (4 skipped emulator suites).
- **Backend Executor & Adapter Tests**: 80 passing (5 skipped emulator suites).
- **Total Passing Automated Tests**: **505 passed, 0 failed**.
- **TypeScript Compilation**: 0 errors across 4 projects (`tsconfig.app.json`, `tsconfig.node.json`, `api/tsconfig.json`, `functions/tsconfig.json`).
- **Static Analysis (`oxlint`)**: 0 errors, 25 warnings (non-blocking React Compiler effect/watch notices).
- **Production Bundle**: Clean production build (`npm run check:release:prod`) with fail-closed environment validation.
- **Security Hygiene**: 0 committed private keys, service account credentials, or production secrets.

---

## 3. Pending Deployment Prerequisites

While the code is thoroughly verified locally, **Spenza is not yet deployed to production**. The following operational steps must be executed manually:

1. **Deploy Vercel Backend**:
   - Connect the repository to Vercel.
   - Configure server-side environment variables: `FIREBASE_SERVICE_ACCOUNT_KEY` (and optionally `ALLOWED_ORIGINS`).
   - Verify deployment of the three endpoints (`/api/repayment`, `/api/settlement`, `/api/import`).
2. **Deploy Firestore Rules & Indexes**:
   - Run `npx firebase deploy --project spenza-90037 --only firestore,storage`.
   - Wait for the composite index on `recurring` (`isActive ASC, nextDueDate ASC`) to finish building in the Firebase Console.
3. **Configure Google Authentication**:
   - In the Firebase Console, add the production hosting domain (`spenza-90037.web.app`) to **Authorized Domains**.
4. **Deploy Static Frontend**:
   - Set `VITE_BACKEND_API_URL` to the live Vercel URL in your production environment.
   - Build and deploy Hosting:
     ```bash
     npm run build:prod
     npx firebase deploy --project spenza-90037 --only hosting
     ```
   *(Reminder: Never run `firebase deploy` without `--only hosting` on the Spark plan).*

---

## 4. Unimplemented / Future Roadmap

- **Receipt Photo Attachment**: Cloud Storage security rules and storage services are in place, but the file picker UI is not yet bound to `AddExpenseForm.tsx`.
- **Multi-Currency Support**: Exclusively handles Indian Rupee (integer paise); no multi-currency or exchange rate support.
- **Real-Time Collaboration**: Strictly single-user tenancy per Google account.
