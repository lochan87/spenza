# Spenza

Spenza is a personal finance Progressive Web Application (PWA) designed for single-user clarity, financial precision, and zero-cost cloud hosting. It provides complete expense tracking, split bill settlements, trip budgets, subscription management, and spreadsheet ingestion.

The application operates without monthly infrastructure fees by deploying the frontend to **Firebase Hosting (Spark tier)** and delegating sensitive financial mutations to **Vercel (Hobby tier)** Node.js Serverless Functions.

---

## Key Features

- **Dashboard & Analytics**: Net personal spending vs. gross outflow, 6-month trends, payment mode breakdown, micro-spending analysis, and daily burn-rate pacing.
- **Transactions Ledger**: Date-grouped expense list, multi-dimensional filters (category, payment mode, type, friend, trip), search, and collapsible trip bundles.
- **Split Bills & Friends Book**: Person-centric dues ledger (`/app/people`), equal and custom split calculations, participant onboarding, and repayment tracking.
- **Atomic Bulk Settlement**: Serverless settlement workflows with lease-based concurrency fencing and idempotency receipts.
- **Trip Tracking**: Dedicated vacation expense management with 5 spending buckets, Day-N charts, and budget progress.
- **Recurring Commitments**: Weekly, monthly, quarterly, and yearly subscription tracking with UTC date normalization and app-wide overdue prompts.
- **Monthly Budgets**: Total and category-level spending limits with previous-month cloning.
- **Spreadsheet Import**: Multi-sheet Excel (`.xlsx`, `.xls`) and CSV parsing, auto-column mapping, date correction, and chunked server execution.
- **Offline PWA Support**: Installable app shell, Workbox runtime caching, and IndexedDB persistence via Cloud Firestore.
- **Data Export & Backup**: CSV transaction export with split metadata and full JSON database backups with integrity interlocks.

*Detailed feature catalog and workflows: [docs/FEATURES.md](docs/FEATURES.md)*

---

## Technology Stack

| Layer | Technology | Details |
| :--- | :--- | :--- |
| **Frontend Framework** | React 19 + TypeScript | React 19, TypeScript 6 |
| **Build Tooling** | Vite 8 | `@tailwindcss/vite`, ES module bundling |
| **Styling & Design** | Tailwind CSS v4 | Custom CSS design tokens in `src/index.css`, Dark/Light themes |
| **Routing** | React Router 7 | Client-side routing with `ProtectedRoute` navigation guards |
| **Client Database & Auth** | Firebase Web SDK 12 | Authentication (Google Sign-In), Cloud Firestore, Cloud Storage |
| **Backend Runtime** | Vercel Serverless Functions | Node.js 22 serverless routes under `api/` (`/api/repayment`, `/api/settlement`, `/api/import`) |
| **Admin SDK** | Firebase Admin SDK 13 | Privileged server-side transactions and ID token verification |
| **Spreadsheet Parsing** | SheetJS (`xlsx`) | Multi-sheet workbook parsing and CSV normalization |
| **Charts** | Recharts 3 | Responsive SVG and Canvas financial data visualization |
| **Icons & UI Primitives** | Lucide React + Radix UI | Accessible popovers, dialogs, and navigation primitives |
| **Static Analysis** | oxlint | Fast Rust-based linter |

---

## High-Level Architecture

```
[ Browser / Mobile PWA ]
   │
   ├── Reads & Client Writes ──────► [ Cloud Firestore (Security Rules Guarded) ]
   ├── Authentication ─────────────► [ Firebase Authentication (Google Sign-In) ]
   └── Sensitive Financial Ops ────► [ Vercel Serverless Backend (api/*.ts) ]
                                            │
                                            └──► [ Firebase Admin SDK (Privileged Atomic Commits) ]
```

1. **Client**: The React PWA communicates directly with Cloud Firestore for standard reads and everyday expense entries, taking advantage of Firestore's IndexedDB local cache for offline availability.
2. **Backend**: Operations requiring multi-document atomicity (split settlements, repayments, and chunked imports) are dispatched via HTTPS to Vercel Serverless Functions.
3. **Security**: The backend verifies the user's Firebase ID token, derives the authenticated UID authoritatively, and commits updates via atomic Firestore transactions.

*Full architectural documentation: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)*

---

## Repository Structure

```
spenza/
├── api/                       # Vercel Serverless Function entry points
│   ├── repayment.ts           # POST /api/repayment
│   ├── settlement.ts          # POST /api/settlement
│   ├── import.ts              # POST /api/import
│   └── tsconfig.json          # Serverless TypeScript configuration
├── docs/                      # Comprehensive technical documentation
│   ├── ARCHITECTURE.md        # System architecture and data flow
│   ├── DATABASE.md            # Firestore schema, indexes, and invariants
│   ├── FEATURES.md            # Implemented capabilities and workflows
│   ├── SECURITY.md            # Authentication, rules, and threat models
│   ├── DEVELOPMENT.md         # Local setup, emulators, and scripts
│   ├── DEPLOYMENT.md          # Firebase Spark + Vercel deployment guide
│   ├── TESTING.md             # Testing strategy and invariant verification
│   └── PROJECT_STATUS.md      # Current implementation readiness
├── functions/                 # Backend business logic and emulator tests
│   ├── src/                   # Pure financial executors and Vercel adapters
│   └── test/                  # Backend unit, emulator, and adapter tests
├── public/                    # Static assets, PWA icons, and manifest
├── scripts/                   # Quality gates, release checks, and deploy guards
├── src/                       # React 19 frontend application
│   ├── components/            # Layout and shared UI primitives
│   ├── features/              # Feature modules (dashboard, transactions, etc.)
│   ├── firebase/              # Firebase Client SDK initialization
│   ├── hooks/                 # Shared React hooks (auth, theme, sync)
│   ├── services/              # Client services, queries, and API client
│   ├── types/                 # Shared TypeScript models and interfaces
│   └── utils/                 # Pure financial calculations and Zod schemas
├── firestore.rules            # Cloud Firestore security rules
├── firestore.indexes.json     # Composite query index definitions
├── storage.rules              # Cloud Storage security rules
└── vite.config.ts             # Vite build and PWA configuration
```

---

## Prerequisites

- **Node.js**: **Node.js 22 LTS** (`node -v` $\ge$ `v22.0.0`).
- **npm**: **npm 10+** (bundled with Node 22).
- **Firebase CLI**: Install globally via `npm install -g firebase-tools`.
- **Java 11+ (Optional)**: Required only if running the Firebase Local Emulator Suite.

---

## Local Installation & Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/lochan87/spenza.git
   cd spenza
   ```

2. **Install dependencies**:
   ```bash
   npm install
   npm --prefix functions install
   ```

3. **Configure local environment**:
   ```bash
   cp .env.example .env.local
   ```
   Configure `.env.local` with your Firebase project keys.

*Setup details: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)*

---

## Development & Testing Commands

### Running Locally

```bash
# Start Vite development server
npm run dev

# Preview production build locally
npm run preview
```

### Typechecking & Linting

```bash
# Check all TypeScript projects
node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit --incremental false
node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit --incremental false
node node_modules/typescript/bin/tsc -p api/tsconfig.json --noEmit
npm --prefix functions run typecheck

# Run linter
npm run lint
```

### Running Automated Tests

```bash
# Frontend unit & invariant tests (PowerShell)
$testPaths = @(Get-ChildItem -Recurse -Path src -Filter '*.test.ts' | Select-Object -ExpandProperty FullName)
node --experimental-strip-types --test $testPaths

# Backend executor & Vercel adapter tests
npm --prefix functions test

# Playwright E2E browser tests
npm run test:e2e
```

### Full Release Verification Gate

```bash
npm run check:release:prod
```

Executes the end-to-end verification pipeline: unit tests, functions tests, TypeScript compilation across all configs, linter, and production build with fail-closed environment validation.

*Testing guide: [docs/TESTING.md](docs/TESTING.md)*

---

## Deployment Architecture

Spenza is designed to be hosted for free using a split deployment:

1. **Vercel Hobby**:
   - Hosts the three API routes under `api/`.
   - Requires server-side environment variables: `FIREBASE_ADMIN_CREDENTIALS` (or individual service account fields) and `ALLOWED_ORIGIN`.
2. **Firebase Hosting (Spark Plan)**:
   - Hosts the compiled client PWA bundle (`dist/`).
   - Requires building with `VITE_BACKEND_API_URL` pointing to the deployed Vercel HTTPS domain.
   - **Important**: Deploy with `npx firebase deploy --project <project-id> --only hosting,firestore,storage` to avoid billing errors associated with Cloud Functions on the Spark tier.

*Deployment guide: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)*

---

## Security & Data Integrity Highlights

- **Integer-Paise Arithmetic**: All financial values are stored and calculated as integer paise ($1\text{ INR} = 100\text{ paise}$). Floating-point currency math is prohibited in the database and ledger logic.
- **Ledger Invariant**: $\text{Gross Outflow} = \text{Net Personal Spending} + \text{Recoverable Principal}$.
- **Repayment Preservation**: Repayments reduce pending dues, never original gross outflows. Editing transactions preserves historical repayments.
- **Server-Side Identity**: The Vercel backend extracts user identity authoritatively from verified Firebase ID tokens; client-supplied UIDs in request bodies are ignored.
- **UID Isolation**: Security rules prevent cross-user document access under `users/{uid}/`.

*Security documentation: [docs/SECURITY.md](docs/SECURITY.md)*  
*Database schema and rules: [docs/DATABASE.md](docs/DATABASE.md)*

---

## Project Status

- **Code Quality**: 505 passing unit/integration tests, 0 TypeScript errors, 0 linter errors, and clean production builds.
- **Deployment Status**: Code is completely verified locally; production deployment to live Firebase Hosting and Vercel remains to be performed.

*Readiness report: [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md)*
