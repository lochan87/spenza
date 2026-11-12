# Spenza — Database Architecture & Firestore Schema

Spenza uses **Cloud Firestore** as its primary database. The database is organized around strict single-user tenancy, multi-device synchronization via persistent cache, and integer-paise financial accuracy.

---

## 1. Tenancy & UID Isolation

All user documents are partitioned strictly under the top-level path:

```
users/{uid}/
```

Where `{uid}` is the authenticated Google user identifier provided by Firebase Authentication.

### Security Guarantees
- **No Shared Tenant Storage**: Users cannot query, modify, or inspect data belonging to another user.
- **Rule Enforcement**: Firestore security rules (`firestore.rules`) reject any read or write where `request.auth.uid != uid`.
- **Server Verification**: In serverless backend calls (Vercel), `{uid}` is derived directly from the verified Firebase ID token and cannot be overridden by client request bodies.

---

## 2. Collection Hierarchy

```
users/{uid}/
  ├── profile/
  │     └── data                         ← User preferences (theme, currency, onboarding flags)
  ├── transactions/
  │     └── {transactionId}              ← Ledger entries (integer paise, category, splits, trip links)
  ├── categories/
  │     └── {categoryId}                 ← Expense categories (name, icon, color, archived status)
  ├── paymentAccounts/
  │     └── {accountId}                  ← Bank accounts, UPI IDs, credit/debit cards
  ├── budgets/
  │     └── {YYYY-MM}                    ← Monthly budget limits (total and per-category)
  ├── trips/
  │     └── {tripId}                     ← Trip tracking, destination, budget, date boundaries
  ├── recurring/
  │     └── {recurringId}                ← Recurring bills/subscriptions (schedules, active status)
  ├── people/
  │     └── {personId}                   ← Friends and split partners
  ├── insights/
  │     └── summary                      ← Cached 7-day analytics document (versioned schema)
  └── importOperations/
        └── {operationId}                ← Immutable spreadsheet import manifest
              ├── chunks/{chunkIndex}    ← Bounded batch of import rows
              ├── trustedV2Receipts/{i}  ← Server-written transaction generation receipts
              ├── trustedV2Trips/{trip}  ← Server-written trip creation provenance markers
              └── trustedV2State/
                    └── execution        ← Server-owned atomic progress cursor and locks
```

---

## 3. Core Collection Schemas

### `transactions/{transactionId}`
Primary ledger records. Can represent personal, split, or reimbursable expenses.

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `string` | Unique document ID |
| `amountPaise` | `integer` | Gross transaction outflow in integer paise (₹1 = 100 paise) |
| `description` | `string` | Human-readable expense description |
| `categoryId` | `string` | References a document in `categories/{categoryId}` |
| `paymentMode` | `string` | Mode of payment: `'Cash' \| 'UPI' \| 'Card' \| 'Bank Transfer' \| 'Other'` |
| `paymentAccountId` | `string \| null` | Required for UPI/Card/Bank; must be `null` for Cash/Other |
| `date` | `Timestamp` | Date and time the expense occurred |
| `type` | `string` | `'everyday' \| 'trip' \| 'recurring' \| 'reimbursable'` |
| `tripId` | `string \| null` | Optional link to `trips/{tripId}` |
| `personId` | `string \| null` | Legacy single-person reimbursable reference; null for modern splits |
| `recoverablePaise` | `integer` | Total amount fronted for others (0 for personal expenses) |
| `splits` | `array` | List of `SplitShare` objects: `[{ personId, amountPaise, repaidPaise, settledAt }]` |
| `tags` | `array of string` | Optional user tags |
| `notes` | `string \| null` | Optional user notes |
| `receiptUrl` | `string \| null` | Storage path to receipt image |
| `createdAt` | `Timestamp` | Creation timestamp |
| `updatedAt` | `Timestamp` | Last modification timestamp |

### `categories/{categoryId}`
Customizable category taxonomy.

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `string` | Unique category identifier |
| `name` | `string` | Category name (e.g., `'Groceries'`, `'Dining Out'`) |
| `icon` | `string` | Emoji representation |
| `color` | `string` | Hex color code |
| `isArchived` | `boolean` | Soft deletion status (preserves historical reports) |

### `paymentAccounts/{accountId}`
Financial accounts representing bank accounts, wallets, or credit cards.

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `string` | Unique account identifier |
| `name` | `string` | Account label (e.g., `'HDFC Bank'`, `'Personal GPay'`) |
| `type` | `string` | `'Bank Account' \| 'Credit Card' \| 'Debit Card' \| 'UPI' \| 'Wallet'` |
| `isDefault` | `boolean` | Default selection in expense entry forms |
| `isArchived` | `boolean` | Soft deletion status |

### `people/{personId}`
Contacts and split partners used in shared expenses and settlements.

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `string` | Unique person identifier |
| `name` | `string` | Contact name |
| `notes` | `string \| null` | Optional contact details |
| `isArchived` | `boolean` | Protected soft-archive; hard deletion blocked if dues exist |
| `createdAt` | `Timestamp` | Creation timestamp |

### `trips/{tripId}`
Travel groupings with budget tracking and date boundaries.

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `string` | Unique trip identifier |
| `name` | `string` | Trip destination or title |
| `startDate` | `Timestamp` | Trip start date |
| `endDate` | `Timestamp` | Trip end date |
| `budgetPaise` | `integer` | Budget limit in integer paise |
| `coverEmoji` | `string` | Icon displayed on trip card |
| `status` | `string` | `'active' \| 'completed' \| 'cancelled'` |

### `recurring/{recurringId}`
Scheduled subscriptions, bills, or EMIs.

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `string` | Unique subscription identifier |
| `amountPaise` | `integer` | Billing amount in paise |
| `description` | `string` | Subscription label |
| `categoryId` | `string` | Category reference |
| `frequency` | `string` | `'weekly' \| 'monthly' \| 'quarterly' \| 'yearly'` |
| `nextDueDate` | `Timestamp` | Next scheduled occurrence in UTC |
| `isActive` | `boolean` | Active state flag (queried with composite index) |
| `autoLog` | `boolean` | Automatically confirm on due date |

---

## 4. Monetary Representation & Invariants

### 1. Integer-Paise Arithmetic
All monetary balances, transaction outflows, budgets, and dues are stored and calculated as **integer paise** (1 INR = 100 paise):
- ₹150.00 is represented as `15000`.
- ₹0.50 is represented as `50`.
- Floating-point representations (`150.5`) are strictly prohibited in the persistence layer. Conversions to rupee decimals occur only at the UI display and user input boundary.

### 2. Outflow and Recovery Invariant
For every transaction in the database:
$$\text{Gross Outflow} = \text{Net Personal Spend} + \text{Recoverable Principal}$$

- For personal expenses: $\text{Recoverable Principal} = 0$, so $\text{Net Personal Spend} = \text{Gross Outflow}$.
- For shared expenses: $\text{Recoverable Principal} = \sum(\text{Split Amounts})$, and $\text{Net Personal Spend} = \text{Gross Outflow} - \text{Recoverable Principal}$.

### 3. Repayment Invariant
$$\text{Recoverable Principal} = \text{Repaid Amount} + \text{Pending Dues}$$

Repayments:
- Decrease pending dues and increase `repaidPaise`.
- **Never** modify the original `amountPaise` (gross outflow) or net personal spending.
- For each share: $0 \le \text{repaidPaise} \le \text{amountPaise}$.

### 4. Payment Account Constraints
Enforced both client-side via Zod schemas and server-side via Firestore security rules:
- `Cash` or `Other`: `paymentAccountId` must be `null`.
- `UPI`, `Card`, or `Bank Transfer`: `paymentAccountId` must be a non-empty string referencing an existing payment account.

---

## 5. Composite Database Indexes

Firestore requires composite indexes for queries filtering across multiple fields or combining inequality operators with sorting.

Declared in `firestore.indexes.json`:

```json
{
  "indexes": [
    {
      "collectionGroup": "recurring",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "isActive", "order": "ASCENDING" },
        { "fieldPath": "nextDueDate", "order": "ASCENDING" }
      ]
    }
  ]
}
```

### Purpose
Used by `src/features/recurring/useRecurringCheck.ts` and `src/services/recurring.ts` to locate active subscriptions that are due on or before today across the application without loading inactive or future records.

---

## 6. Offline Persistence & Cache Strategy

Client Firestore is initialized in `src/firebase/config.ts` using:
- `persistentLocalCache`: Stores documents in browser IndexedDB.
- `persistentMultipleTabManager`: Synchronizes writes and snapshot listeners across multiple open browser tabs.

### Offline Behavior
1. **Reads**: Serves from local cache instantly when offline.
2. **Standard Writes**: Queued in IndexedDB and committed automatically when connectivity resumes.
3. **Sensitive Operations**: Operations requiring multi-document atomicity (settlement, chunked imports) are dispatched via Vercel HTTPS endpoints and fail cleanly if the network is unreachable, preventing inconsistent split states.
