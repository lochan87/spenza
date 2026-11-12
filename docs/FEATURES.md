# Spenza — Feature Catalog & Capabilities

This document provides a detailed breakdown of Spenza's implemented features, user workflows, and current capability boundaries.

---

## 1. Feature Status Summary

| Feature Area | Status | Description |
| :--- | :---: | :--- |
| **Authentication & Profile** | **Completed** | Google Sign-In with UID-isolated storage and route guarding. |
| **Dashboard** | **Completed** | 11 analytical cards, 6-month net spending trend, payment mode breakdown, and pace projection. |
| **Transactions Ledger** | **Completed** | Full CRUD, infinite scrolling, date grouping, collapsible trip bundles, multi-criteria filtering, and search. |
| **Split Bills & Friends Book** | **Completed** | Dues ledger (`/app/people`), equal/custom split allocations, participant onboarding, and recoverable tracking. |
| **Repayments & Settlements** | **Completed** | Server-executed atomic settlements, transaction split clearing, idempotency receipts, and concurrency fencing. |
| **Trips Management** | **Completed** | Dedicated travel budgets, day-by-day logs, 5 spending buckets, and member expense tracking. |
| **Recurring Commitments** | **Completed** | UTC calendar scheduling, composite-index overdue queries, and an app-wide floating due prompt. |
| **Monthly Budgets** | **Completed** | Overall monthly total and category-level limits with clone-from-previous-month capability. |
| **Insights & Analytics** | **Completed** | 8 stat cards, 12-month spending curve, category trends, day-of-week averages, and schema v4 cache. |
| **Spreadsheet Import** | **Completed** | Multi-sheet Excel & CSV parsing, auto-column detection, bulk date correction, and chunked server execution. |
| **Export & Archival** | **Completed** | Full CSV export with split metadata and complete JSON backup with integrity interlocks. |
| **PWA & Offline Mode** | **Completed** | Installable manifest, service worker runtime caching, IndexedDB local persistence, and offline banner. |
| **Receipt Image Uploads** | **Partially Implemented** | Cloud Storage rules and service helper exist, but image upload UI is not yet bound to expense forms. |
| **Multi-Currency** | **Unsupported** | Strictly INR (integer paise). Currency conversions are not supported. |
| **Multi-Tenant Sharing** | **Unsupported** | Single-user database architecture. Users cannot share a live database or view each other's live screens. |

---

## 2. Core Implemented Features

### Dashboard (`/app`)
The central cockpit gives an immediate answer to personal financial health:
- **Net Spending Summary**: Displays gross outflow versus net personal spend, clearly excluding recoverable debts.
- **Spending Pace Card**: Predicts end-of-month spend using daily burn rate, automatically adjusted to prevent day 1–2 projection spikes.
- **6-Month Trend Chart**: Visualizes net personal outflow month-over-month.
- **Top Categories & Biggest Expenses**: Highlights dominant expense drivers.
- **Micro-Spend Card**: Aggregates small, repetitive expenses (< ₹250) to reveal cumulative daily leaks.
- **Payment Breakdown Donut**: Visualizes distribution across Cash, UPI, Cards, and Net Banking.
- **Pending Recoverables Card**: Surfaces outstanding amounts owed by friends.

### Transactions Ledger (`/app/transactions`)
- **Add & Edit Drawer**: Clean sliding drawer for rapid entry. Includes category auto-suggestion based on description keywords.
- **Split Bill Calculator**:
  - Automatically calculates equal shares across selected friends.
  - Supports custom "My Share" overrides with remainder distribution.
  - Enforces mathematical integrity: $\sum(\text{Splits}) = \text{Recoverable Principal} \le \text{Gross Outflow}$.
- **Multi-Dimensional Filters**: Filter simultaneously by month, category, payment mode, transaction type (`everyday`, `trip`, `recurring`, `reimbursable`), and friend.
- **Collapsible Trip Bundles**: Consolidates multi-day vacation expenses into single expandable rows to keep the primary ledger clean.

### Friends & Split Book (`/app/people`)
- **Person-Centric Dues Ledger**: Consolidates all outstanding debts, partial repayments, and settled balances per contact.
- **First-Login Onboarding**: Guides new users through creating initial split partners, seamlessly linking contacts into subsequent transactions.
- **Soft Deletion & Protection**: Deleting a person with open dues or transaction history is strictly prevented; contacts are safely archived (`isArchived: true`) to preserve historical integrity.

### Repayments & Bulk Settlement
- **Atomic Execution**: Dispatched to the secure Vercel backend (`/api/repayment` and `/api/settlement`).
- **Flexible Settlement Modes**:
  - Single split share settlement.
  - Transaction-level split settlement.
  - Bulk settlement: Clears all outstanding dues for a selected friend across all historical transactions in one atomic operation.
- **Receipts & Fencing**: Emits immutable settlement receipts with lease expiration and fencing tokens to prevent race conditions during concurrent retries.

### Trips Tracker (`/app/trips`)
- **Trip Lifecycle**: Create trips with designated dates, cover emojis, and total budgets.
- **Spending Buckets**: Categorizes travel spending into 5 standard buckets:
  1. Travel / Transit
  2. Stay / Lodging
  3. Food & Dining
  4. Activities & Sightseeing
  5. Miscellaneous
- **Day-by-Day Aggregation**: Computes daily burn rates across the trip timeline.
- **Budget Tracking**: Live progress bar indicating budget consumption and over-budget warnings.

### Recurring Expenses (`/app/recurring`)
- **Flexible Intervals**: Supports weekly, monthly, quarterly, and yearly subscriptions.
- **UTC Calendar Policy**: Normalizes billing dates in UTC to prevent day-drifting across local browser timezones.
- **App-Wide Overdue Prompt**: A floating prompt surfaces on any screen when a recurring commitment is due today or overdue, allowing one-click confirmation or skipping.

### Spreadsheet Import (`/app/import`)
- **Format Support**: Upload `.xlsx`, `.xls`, or `.csv` files.
- **Multi-Sheet Detection**: Identifies monthly expense sheets and dedicated trip tabs.
- **Smart Column Detection**: Automatic mapping for Date, Amount, Description, Category, Payment Mode, and Notes.
- **Bulk Date Correction**: Flagged rows with invalid or future dates can be corrected in bulk before processing.
- **Durable Chunked Ingestion**: Commits transactions in bounded chunks via `/api/import` with atomic cursors, preventing duplicate creation upon browser refresh or connection interruptions.

### Settings, Export & Data Management (`/app/settings`)
- **Payment Accounts CRUD**: Configure bank accounts, cards, and UPI IDs with default selections.
- **CSV Data Export**: One-click download of all transactions, formatted with split participant columns.
- **JSON Full Backup & Restore**: Comprehensive database snapshot with cryptographic validation interlocks to prevent destructive race conditions during backup.
- **Cache Management**: Instant invalidation of the 7-day Insights summary cache.

---

## 3. Partially Implemented & Future Capabilities

### Receipt Image Uploads (`storage.rules`)
- **Implemented**: Firebase Storage security rules restricting uploads to `users/{uid}/receipts/{id}`. Storage utility helpers in `src/firebase/storage.ts`.
- **Pending**: File picker input on `AddExpenseForm.tsx` and image preview lightbox in the transaction list.

### Unsupported Functionality
- **Multi-Currency**: Spenza is built specifically for Indian financial tracking and operates exclusively in integer paise. It does not perform foreign exchange rate lookups or conversions.
- **Multi-User Collaboration**: Spenza does not provide shared database rooms or real-time multi-user editing. Split expenses are tracked from the perspective of the single authenticated owner.
