# Trusted imports (v2)

`executeImportV2` is an authenticated callable in `us-central1`. Its only input is
`{ operationId }`; UID comes exclusively from callable authentication. The server
validates the entire persisted plan, including hashes, schema, deterministic IDs,
safe integer paise, supported Other/null payments and owner-scoped references.
Hashes detect inconsistent plans; they are not authorization or completion proof.

Rules permit creating v2 headers and create-only chunks, then changing only
`ready: false` to `true`. Once ready, no chunk creation or plan mutation is allowed.
The server requires ready and rechecks the header in every financial transaction.
After full schema/hash/identity/timestamp/size/reference validation, the first
successful transaction writes `trustedV2State/execution`: a server-owned versioned
state bound to SHA-256 of the exact normalized header (including all chunk hashes,
owner, operation ID and protocol version). Its cursor/count advance atomically
with financial writes and receipts. Clients cannot write or delete this state.
Deploying the corresponding rules is a prerequisite, not optional.

Each call commits at most 20 expenses, 20 new trips, 20 trusted trip markers, one
trusted chunk receipt and one Insights invalidation (63 writes including the state update). All reads precede
writes. Existing expense IDs cause a collision, never an overwrite. Only Admin
writes `trustedV2Receipts` and `trustedV2Trips`; clients cannot create, update or
delete either proof path or validation state. Legacy receipt paths are also closed. Broad existing owner
permissions for ordinary expenses/trips remain; this does not make the entire
ledger tamper-proof. Trusted proof never depends on editable expense metadata.

Retries inspect trusted proof, preserving edits, repayments and deleted expenses.
A deleted imported trip blocks outstanding chunks instead of being recreated.
Operations are atomic per chunk, not across the file. Timeouts/lost responses are
unknown outcomes: resume the same operation. All v1 execution is blocked for
manual reconciliation; no migration or replay is attempted.

Limits: 10,000 rows, 500 chunks, 90,000 bytes/chunk, 8,000,000 bytes total encoded
JSON payload. Shared TextEncoder-based validation rejects oversized plans before
persistence; the server independently checks stored payloads. Size failures return
`invalid-argument` with `reason: import-size-limit, retryable: false`. No automatic
replacement, truncation or replay occurs.

Only the first successful call validates the whole plan. Later calls read the
header/state and the next chunk, verify its hash, and recheck that chunk's live
references transactionally. Previously validated references may be deleted later;
that safely blocks the affected chunk. Existing pre-cursor v2 receipts are verified
at initialization; the contiguous completed prefix seeds the cursor, preserving
completed imports and deleted expenses. V1 remains blocked. No migration runs.

One chunk per call remains deliberate: bounded transactions and precise recovery
outweigh reducing 50/500 network round trips. Concurrency is explicitly 1 per
instance (maximum 10 instances), limiting simultaneous plan allocations. This may
increase latency/instance demand; it is not a per-user mutex. Transactions on the
same state document serialize concurrent calls across instances. Failed first
commits can repeat validation; successful resumes do not.

The repeatable read-budget test uses production execution with an instrumented
in-memory store, not an emulator. For 1,000 rows with one category/no trips it
measures 1,451 server reads and 50 calls, versus 6,250 calculated for Phase 4.1.
The corresponding 10,000-row estimate is 14,501 versus 512,500 reads and 500 calls.
A normal subsequent full chunk uses 27 reads; completed checks use 4 reads.
Preparation/client reads, retries, additional references and contention are excluded.
Wall time/heap delta are printed, but GC and the fake store make them unsuitable
for production latency or peak-memory predictions. Emulator load testing remains
required. Repeat the measurement from the repository root:

```powershell
node --experimental-strip-types --test --test-name-pattern='read budget' src/services/__tests__/importOperations.test.ts
```

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
npm --prefix functions run build
firebase emulators:start --only auth,firestore,functions --project demo-spenza-import
```

In another terminal at the repository root:

```powershell
$env:SPENZA_FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
$env:SPENZA_CALLABLE_EMULATORS = '1'
node --experimental-strip-types --test src/services/__tests__/importRules.emulator.test.ts
npm --prefix functions run test
Remove-Item Env:SPENZA_FIRESTORE_EMULATOR_HOST, Env:SPENZA_CALLABLE_EMULATORS
```

The rules test installs local rules into the demo emulator. The backend emulator
test exercises real Admin transactions; neither test uses production configuration.
The separate callable test signs into the local Auth emulator, sends bearer tokens
to the actual callable HTTP endpoint, and verifies isolation, UID spoof rejection,
partial failure, concurrent resume, deletion preservation and non-retryable errors.
The shared Functions test entry intentionally reruns the frontend integration suite;
those passing counts are not independent coverage. Browser/offline testing remains
separate. Set opt-in variables only while isolated emulators are running.

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

## Temporary Java setup (user-run if the environment cannot download it)

This uses a ZIP runtime, checks its published SHA-256, and changes PATH only in the
current PowerShell session. No installer, global installation or machine settings:

```powershell
$javaRelease = (Invoke-RestMethod 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jre&os=windows')[0]
$javaFolder = Join-Path $env:TEMP ('spenza-java-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $javaFolder | Out-Null
$javaZip = Join-Path $javaFolder 'runtime.zip'
Invoke-WebRequest $javaRelease.binary.package.link -OutFile $javaZip
if ((Get-FileHash $javaZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne $javaRelease.binary.package.checksum) { throw 'Java checksum mismatch' }
Expand-Archive -LiteralPath $javaZip -DestinationPath $javaFolder
$env:JAVA_HOME = (Get-ChildItem $javaFolder -Directory | Select-Object -First 1).FullName
$env:PATH = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:PATH
java -version
```

Then run the emulator commands above in that session. Closing the terminal restores
the previous environment. Node 22 can similarly be exercised without a global
change using `npm exec --package=node@22 -- node --version` and that cached binary.
