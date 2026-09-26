# Spenza 💸

> Fast, insight-driven personal expense tracker — built for one person, designed for clarity.

**Phase 1 — Foundation: Firebase, Auth, Data Model**

---

## Quick Start

### 1. Clone & Install

```bash
git clone <your-repo>
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

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_FIREBASE_API_KEY` | Firebase Web API key | `AIzaSy...` |
| `VITE_FIREBASE_AUTH_DOMAIN` | Auth domain | `my-project.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | Firestore/Storage project ID | `spenza-prod` |
| `VITE_FIREBASE_STORAGE_BUCKET` | Storage bucket | `spenza-prod.firebasestorage.app` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | FCM sender ID | `123456789` |
| `VITE_FIREBASE_APP_ID` | Web app ID | `1:123...:web:abc...` |

> ⚠️ **Never commit `.env.local`** — it's in `.gitignore`

### 4. Deploy Firestore Security Rules

```bash
npm install -g firebase-tools
firebase login
firebase use --add   # select your project
firebase deploy --only firestore:rules
firebase deploy --only storage
```

### 5. Run Locally

```bash
npm run dev
```

Open `http://localhost:5173`, click **Continue with Google**, and you'll see your UID logged to the browser console.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + Vite 8 + TypeScript 6 |
| Styling | Tailwind CSS v4 + shadcn/ui |
| Routing | React Router v7 |
| Forms | React Hook Form + Zod |
| Backend | Firebase (Auth, Firestore, Storage) |
| Icons | Lucide React |
| Date handling | date-fns |
| Charts *(Phase 2+)* | Recharts |

---

## Firestore Schema

All data lives under `users/{uid}/` — the security rules enforce that only the authenticated user can read/write their own subtree.

### Collections Overview

```
users/{uid}/
  ├── profile/data          ← single document
  ├── transactions/{id}
  ├── categories/{id}
  ├── paymentAccounts/{id}  ← NEW — see Payment Mode section below
  ├── budgets/{YYYY-MM}
  ├── trips/{id}
  ├── recurring/{id}
  └── people/{id}
```

---

### `transactions/{transactionId}`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Document ID |
| `amountPaise` | `number` (integer) | **Always stored as paise** — ₹1 = 100 paise. Never store floats. |
| `description` | `string` | Short label for the expense |
| `categoryId` | `string` | References `categories/{id}` |
| `type` | `string` enum | `everyday` \| `recurring` \| `one-time` \| `trip` \| `gift-event` \| `reimbursable` |
| `date` | `Timestamp` | When the expense occurred |
| `paymentMode` | `string` enum | `Cash` \| `UPI` \| `Bank Transfer` \| `Card` \| `Other` |
| `paymentAccountId` | `string \| null` | See **Payment Mode rules** below |
| `tripId` | `string \| null` | Optional: references `trips/{id}` |
| `personId` | `string \| null` | Optional: references `people/{id}` |
| `tags` | `string[]` | Free-form tags |
| `notes` | `string` | Optional notes |
| `receiptUrl` | `string \| null` | Storage URL (Phase 2+) |
| `createdAt` | `Timestamp` | — |
| `updatedAt` | `Timestamp` | — |

---

### `paymentAccounts/{accountId}`

Maintains your personal list of banks/UPI apps so you never retype "HDFC Bank".

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Document ID |
| `name` | `string` | Display name, e.g. `"HDFC Bank"`, `"Google Pay UPI"` |
| `type` | `string` enum | `Bank` \| `UPI` \| `Card` \| `Wallet` |
| `isDefault` | `boolean` | Shown first in quick-pick UI |
| `isArchived` | `boolean` | Soft-delete — keeps historical references valid |
| `createdAt` | `Timestamp` | — |

**Seeded on first login:** `Cash` (Wallet), `My Bank` (Bank), `My UPI` (UPI), `My Card` (Card)

---

### `categories/{categoryId}`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Document ID |
| `name` | `string` | Category label |
| `icon` | `string` | Emoji or Lucide icon name |
| `color` | `string` | Hex color, e.g. `#ff6b6b` |
| `isArchived` | `boolean` | Soft-delete |

**Seeded on first login:** Food & Drinks, Transport, Gifts & Events, Shopping, Health, Education, Bills & Recharge, Travel, Personal/Household, Other

---

### `budgets/{YYYY-MM}`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Format: `"2026-09"` |
| `totalBudgetPaise` | `number` | Monthly total budget in paise |
| `categoryBudgets` | `Record<string, number>` | Per-category budget in paise |
| `createdAt` / `updatedAt` | `Timestamp` | — |

---

### `trips/{tripId}`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | — |
| `name` | `string` | Trip name, e.g. "Goa 2026" |
| `startDate` / `endDate` | `Timestamp` | — |
| `notes` | `string` | Optional |

---

### `recurring/{recurringId}`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | — |
| `description` | `string` | — |
| `amountPaise` | `number` | — |
| `frequency` | `string` enum | `daily` \| `weekly` \| `monthly` \| `yearly` |
| `nextDueDate` | `Timestamp` | — |
| `paymentMode` | `string` enum | Same as transaction |
| `paymentAccountId` | `string \| null` | Same rules as transaction |

---

## Payment Mode ↔ Payment Account Relationship

This is the **key data integrity rule** in Spenza:

```
paymentMode "Cash" or "Other"
  → paymentAccountId MUST be null
  → No bank/account required

paymentMode "UPI" or "Bank Transfer" or "Card"
  → paymentAccountId MUST be a non-null string
  → References paymentAccounts/{id}
```

### Why?

- **Cash** transactions don't belong to any bank — they're out of your wallet.
- **UPI/Bank/Card** transactions are tied to a specific account so you can analyse spending per bank.

### How it's enforced

1. **Zod schema** (`src/utils/schemas.ts`) — `TransactionSchema` uses `.superRefine()` to validate this rule at form submission time. Violations produce clear error messages.
2. **TypeScript types** (`src/types/index.ts`) — `ACCOUNT_REQUIRED_MODES` and `ACCOUNT_NULL_MODES` constants document the rule in code.
3. **Test panel** — click **Run All Tests** in the app after signing in to see 5 automated checks run against your Firestore (including write/read of a UPI tx with linked account and a Cash tx with null account).

---

## Project Structure

```
src/
├── components/
│   ├── ui/           ← shadcn/ui components
│   ├── charts/       ← Recharts wrappers (Phase 2+)
│   ├── forms/        ← Reusable form components (Phase 2+)
│   ├── layout/       ← ProtectedRoute, navigation shells
│   └── debug/        ← Schema test panel (Phase 1 only)
├── features/
│   ├── dashboard/    ← Phase 2+
│   ├── transactions/ ← Phase 2+
│   ├── trips/        ← Phase 2+
│   ├── budgets/      ← Phase 2+
│   ├── recurring/    ← Phase 2+
│   ├── insights/     ← Phase 2+
│   └── import/       ← Phase 2+
├── firebase/
│   ├── config.ts     ← Firebase init (reads from env vars)
│   ├── auth.ts       ← Google Sign-In
│   ├── firestore.ts  ← Path helpers + generic CRUD
│   └── storage.ts    ← Receipt upload/delete
├── hooks/
│   └── useAuth.tsx   ← Auth context + useAuth hook
├── lib/
│   └── utils.ts      ← shadcn cn() utility
├── pages/
│   ├── LoginPage.tsx ← Google Sign-In button
│   └── AppPage.tsx   ← Phase 1 app shell
├── services/
│   └── seed.ts       ← Idempotent Firestore seed on first login
├── types/
│   └── index.ts      ← All TypeScript interfaces
├── utils/
│   └── schemas.ts    ← Zod validation schemas
├── App.tsx           ← Router + AuthProvider
└── main.tsx          ← Entry point
```

---

## Firebase Hosting Deployment

```bash
npm run build
firebase deploy --only hosting
```

---

## Phase Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| **Phase 1** | ✅ Complete | Foundation: Firebase, Auth, Data Model |
| Phase 2 | Planned | Add Expense form, transaction list |
| Phase 3 | Planned | Dashboard, budget tracking |
| Phase 4 | Planned | Trips, recurring, insights |
| Phase 5 | Planned | Import from CSV/bank statements |
