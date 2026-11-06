# Trusted imports (v2)

`executeImportV2` is an authenticated callable in `us-central1`. Its only input is
`{ operationId }`; UID comes exclusively from callable authentication. The server
validates the entire persisted plan, including hashes, schema, deterministic IDs,
safe integer paise, supported Other/null payments and owner-scoped references.
Hashes detect inconsistent plans; they are not authorization or completion proof.

Rules permit creating v2 headers and create-only chunks, then changing only
`ready: false` to `true`. Once ready, no chunk creation or plan mutation is allowed.
The server requires ready and rechecks the header in its financial transaction.
No trusted sealing write is needed because the validated plan is immutable under
these rules. Deploying the corresponding rules is a prerequisite, not optional.

Each call commits at most 20 expenses, 20 new trips, 20 trusted trip markers, one
trusted chunk receipt and one Insights invalidation (62 writes). All reads precede
writes. Existing expense IDs cause a collision, never an overwrite. Only Admin
writes `trustedV2Receipts` and `trustedV2Trips`; clients cannot create, update or
delete either path. Legacy receipt paths are also closed. Broad existing owner
permissions for ordinary expenses/trips remain; this does not make the entire
ledger tamper-proof. Trusted proof never depends on editable expense metadata.

Retries inspect trusted proof, preserving edits, repayments and deleted expenses.
A deleted imported trip blocks outstanding chunks instead of being recreated.
Operations are atomic per chunk, not across the file. Timeouts/lost responses are
unknown outcomes: resume the same operation. All v1 execution is blocked for
manual reconciliation; no migration or replay is attempted.

Limits: 10,000 rows, 500 chunks, 90 KB/chunk, 8 MB total encoded plan. Every call
revalidates the full plan and pending references, so large imports incur repeated
reads and may time out safely. Load/cost testing is required before rollout.

## Local verification

From the repository root (frontend dependencies are also required for integration tests):

```powershell
npm --prefix functions run test
npm --prefix functions run typecheck
npm --prefix functions run build
```

Tests execute production client/server logic with an optimistic transaction double.
They do not establish Firebase rules, actual lock/retry behavior or callable Auth
token verification. Emulator tests are opt-in and reject non-loopback hosts.
With Java and Firebase CLI installed, start an isolated emulator in one terminal:

```powershell
firebase emulators:start --only firestore --project demo-spenza-import
```

In another terminal at the repository root:

```powershell
$env:SPENZA_FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
node --experimental-strip-types --test src/services/__tests__/importRules.emulator.test.ts
npm --prefix functions run test
Remove-Item Env:SPENZA_FIRESTORE_EMULATOR_HOST
```

The rules test installs local rules into the demo emulator. The backend emulator
test exercises real Admin transactions; neither test uses production configuration.
End-to-end callable Auth and browser/offline behavior still need separate testing.

## Release prerequisites (no deployment authorized)

Review and run emulator tests first. Functions targets Node 22; verify with that
runtime before release. A Firebase project configured for Functions and the Blaze
billing plan is required. No credentials belong in frontend code or this package.
The build compiles shared validation into `lib/src/utils`, and the deployed entry
is `lib/functions/src/index.js`; Admin dependencies remain in this package.

An approved rollout must coordinate the restrictive rules, callable and frontend.
Old clients will fail safely when attempting receipt writes under the new rules.
New clients never fall back if the callable is unavailable. Do not publish a new
client while leaving the vulnerable legacy rules active. No deploy, billing change
or legacy reconciliation is performed by this implementation.
