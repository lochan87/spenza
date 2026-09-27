# Spenza 💸

> Fast, insight-driven personal expense tracker — built for one person, designed for clarity.

Spenza is a **PWA** (installable on desktop & mobile) that answers *"where is my money actually going?"* at a glance. It supports manual expense entry, recurring subscriptions, trip budgets, monthly budgets, AI-style insights, and bulk import from Excel/CSV — all backed by Firebase with offline support.

---

## Features

| Area | What it does |
|------|-------------|
| **Dashboard** | Monthly summary, 6-month trend chart, category breakdown, biggest expenses, micro-spend stats, payment-mode donut, upcoming recurring reminders |
| **Transactions** | Add/edit/delete expenses with category, payment mode, bank account, trip tag; infinite-scroll list grouped by date |
| **Categories** | Full CRUD — rename, reorder, archive; pre-seeded with 10 categories |
| **Payment Accounts** | Manage your banks, UPI apps, cards; seeded on first login |
| **Trips** | First-class trip tracking — attach expenses to a trip, view per-trip totals, day-by-day breakdown, payment breakdown |
| **Recurring** | Track subscriptions/EMIs; due-today prompt appears across the app; log or skip each occurrence |
| **Budgets** | Set a monthly total + per-category budget; copy from previous month; live progress bars |
| **Insights** | 8 computed metrics, year-over-year comparison bar chart, auto-generated plain-English insight; 7-day Firestore cache |
| **Import** | Bulk import from `.xlsx` or `.csv`; auto-detect month/trip sheets; category bulk-review; duplicate detection; clear-imports safety button |
| **PWA** | Installable, offline-capable (Workbox + IndexedDB persistence); offline banner |
| **Export** | One-click CSV export of all transactions |
| **Auth** | Google Sign-In; all data isolated per UID under `users/{uid}/` |

---

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/lochan87/spenza.git
cd spenza
npm install
```

### 2. Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/) → **Add project**
2. Enable **Authentication** → Sign-in method → **Google**
3. Enable **Cloud Firestore** → Start in **production mode**
4. Enable **Firebase Storage**
5. Get your config: Project Settings → Your apps → SDK setup → **Config**

### 3. Configure Environment Variables

```bash
cp .env.example .env.local
```

Edit `.env.local` with your real values:

| Variable | Description |
|----------|-------------|
| `VITE_FIREBASE_API_KEY` | Firebase Web API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | e.g. `my-project.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | e.g. `spenza-90037` |
| `VITE_FIREBASE_STORAGE_BUCKET` | e.g. `spenza-90037.firebasestorage.app` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | FCM sender ID |
| `VITE_FIREBASE_APP_ID` | Web app ID |

> ⚠️ **Never commit `.env.local`** — it's in `.gitignore`

### 4. Deploy Firestore Rules

```bash
npm install -g firebase-tools
firebase login
firebase use --add          # select your project, give it an alias e.g. "prod"
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only storage
```

### 5. Run Locally

```bash
npm run dev
```

Open `http://localhost:5173`, sign in with Google, and you're ready.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + Vite 6 + TypeScript 6 |
| Styling | Vanilla CSS with custom design tokens (no Tailwind) |
| Routing | React Router v7 |
| Backend | Firebase — Auth, Firestore, Storage |
| Charts | Recharts |
| Icons | Lucide React |
| Date handling | date-fns |
| Excel/CSV parsing | SheetJS (xlsx) |
| PWA | vite-plugin-pwa + Workbox |
| Validation | Zod + React Hook Form |

---

## Project Structure

```
src/
├── assets/
│   └── logos/               ← Spenza SVG logos (mark + full wordmark)
├── components/
│   ├── ui/                  ← shadcn button (kept for future dialogs)
│   └── layout/              ← AppLayout, Drawer, ProtectedRoute
├── features/
│   ├── auth/                ← LoginPage
│   ├── dashboard/           ← DashboardPage + 10 section components
│   ├── transactions/        ← TransactionsPage, AddExpenseForm
│   ├── categories/          ← CategoriesPage
│   ├── trips/               ← TripsPage, TripDetailPage, NewTripForm
│   ├── recurring/           ← RecurringPage, RecurringDuePrompt
│   ├── budgets/             ← BudgetPage
│   ├── insights/            ← InsightsPage
│   └── import/              ← ImportPage (Excel + CSV bulk import)
├── firebase/
│   └── config.ts            ← Firebase init with offline persistence
├── hooks/
│   ├── useAuth.tsx          ← Auth context
│   └── useRecurringCheck.ts ← Due-today detection
├── services/
│   ├── transactions.ts
│   ├── trips.ts
│   ├── recurring.ts
│   ├── budgets.ts
│   ├── insights.ts
│   ├── importExcel.ts       ← Parse, classify, deduplicate, batch-write
│   └── seed.ts              ← Idempotent first-login seed
├── types/
│   └── index.ts             ← All TypeScript interfaces
├── utils/
│   ├── categoryColors.ts    ← Category → colour mapping
│   ├── paymentColors.ts     ← Payment mode → colour mapping
│   ├── tripBuckets.ts       ← Trip spend bucket helpers
│   ├── format.ts            ← formatINR, formatINRCompact, getGreeting
│   ├── categoryKeywords.ts  ← Auto-suggest category from description
│   └── schemas.ts           ← Zod validation schemas
├── App.tsx                  ← Router + AuthProvider
└── main.tsx                 ← Entry point
```

---

## Firestore Schema

All data lives under `users/{uid}/` — security rules ensure users can only access their own data.

```
users/{uid}/
  ├── profile/data
  ├── transactions/{id}
  ├── categories/{id}
  ├── paymentAccounts/{id}
  ├── budgets/{YYYY-MM}
  ├── trips/{id}
  ├── recurring/{id}
  └── people/{id}
```

### Key rules

- Amounts are **always stored as paise** (₹1 = 100 paise). Never floats.
- `paymentMode` = `Cash` or `Other` → `paymentAccountId` must be `null`
- `paymentMode` = `UPI` / `Card` / `Bank Transfer` → `paymentAccountId` must reference a `paymentAccounts` document
- All soft-deletes use `isArchived: true` — historical references remain valid

---

## Import (Excel / CSV)

### Excel (`.xlsx`)
- Multi-sheet workbooks supported
- Sheets are auto-classified as **Monthly** or **Trip** by name (e.g. "August 2026", "Goa Trip")
- Dates: supports `DD/MM/YY`, `DD/MM/YYYY`, `DD-MM-YYYY`, `YYYY-MM-DD`
- Duplicate detection between monthly and trip sheets
- Category bulk-review step before final write

### CSV (`.csv`)
- Single-sheet; filename used for classification (e.g. `September 2026.csv`)
- Same date format support as Excel
- Columns auto-detected from headers (`date`, `amount`/`cost`, `description`/`expense`)

To clear a bad import, go to **Import → "Clear all imported transactions"** — only `isImported: true` records are deleted.

---

## Deployment

```bash
# Build
npm run build

# Deploy hosting + rules
firebase deploy --only hosting
firebase deploy --only firestore:rules,firestore:indexes
firebase deploy --only storage
```

The `.firebaserc` is committed so `firebase use prod` works on any machine without re-running `--add`.

---

## Development Notes

- **TypeScript** strict mode: `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly` (TS 6)
- **No Tailwind** — design uses CSS custom properties (`--bg`, `--surface`, `--primary`, etc.) defined in `src/index.css`
- **Colour system**: all feature components consume `categoryColors.ts` and `paymentColors.ts` — no hardcoded colours in JSX
- **Offline**: Firestore persistence via `initializeFirestore` + `persistentLocalCache`; service worker via Workbox
