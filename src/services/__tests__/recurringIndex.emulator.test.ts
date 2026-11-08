import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as recurringDates from '../../utils/recurringDates.ts'
import * as transactionSchemas from '../../utils/schemas.ts'
import * as recurringMath from '../../utils/recurringMath.ts'

// Explicit opt-in, loopback only, demo project only. Never uses .env or
// production config. Runs the real recurring service against the Firestore
// emulator so the equality + range query is executed by a real Firestore
// implementation rather than a double.
const host = process.env.SPENZA_FIRESTORE_EMULATOR_HOST

it('Firestore emulator: recurring composite-index queries return only active due/upcoming items', { skip: !host }, async () => {
  assert.match(host!, /^(localhost|127\.0\.0\.1):\d+$/)
  const projectId = 'demo-spenza-recurring-index'
  assert.ok(projectId.startsWith('demo-'), 'emulator tests must never target a real project')

  const [hostname, port] = host!.split(':')
  const DAY_MS = 24 * 60 * 60 * 1000
  const now = Date.now()
  const uid = `recurring-index-${Date.now()}`

  const { initializeApp, deleteApp } = await import('firebase/app')
  const sdk = await import('firebase/firestore')
  const app = initializeApp({ projectId, apiKey: 'demo-key', appId: 'demo-app' }, `recurring-${Date.now()}`)

  try {
    // Security rules are not under test here; scope a permissive loopback-only
    // ruleset to this demo emulator so the seed writes are allowed.
    const rulesResponse = await fetch(`http://${host}/emulator/v1/projects/${projectId}:securityRules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rules: {
          files: [{
            name: 'firestore.rules',
            content: 'rules_version = "2";\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} { allow read, write: if true; }\n  }\n}',
          }],
        },
      }),
    })
    assert.ok(rulesResponse.ok, await rulesResponse.text())

    const db = sdk.getFirestore(app)
    sdk.connectFirestoreEmulator(db, hostname, Number(port))

    const seed = async (id: string, nextDueDateMs: number, isActive: boolean) => {
      await sdk.setDoc(sdk.doc(db, 'users', uid, 'recurring', id), {
        id,
        description: id,
        amountPaise: 10000,
        categoryId: 'cat-subs',
        frequency: 'monthly',
        dayOfMonth: 1,
        dayOfWeek: null,
        monthDay: null,
        nextDueDate: sdk.Timestamp.fromMillis(nextDueDateMs),
        lastGeneratedDate: null,
        paymentMode: 'Cash',
        paymentAccountId: null,
        isActive,
        createdAt: sdk.Timestamp.fromMillis(nextDueDateMs),
        updatedAt: sdk.Timestamp.fromMillis(nextDueDateMs),
      })
    }

    await seed('rec-overdue', now - 2 * DAY_MS, true)
    await seed('rec-soon', now + 3 * DAY_MS, true)
    await seed('rec-far', now + 30 * DAY_MS, true)
    await seed('rec-inactive-overdue', now - 2 * DAY_MS, false)

    const source = readFileSync(new URL('../recurring.ts', import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
    }).outputText

    const serviceExports: Record<string, any> = {}
    runInNewContext(compiled, {
      exports: serviceExports,
      navigator: { onLine: true },
      console,
      require: (name: string) => {
        if (name === 'firebase/firestore') return sdk
        if (name === '@/firebase/config') return { db }
        if (name === '@/utils/schemas') return transactionSchemas
        if (name === '@/utils/recurringMath') return recurringMath
        if (name === '@/utils/recurringDates') return recurringDates
        throw new Error(`Unexpected import: ${name}`)
      },
    })

    const overdue = await serviceExports.getOverdueRecurring(uid)
    assert.deepEqual(overdue.map((item: { id: string }) => item.id), ['rec-overdue'])

    const upcoming = await serviceExports.getUpcomingRecurring(uid, 7)
    assert.deepEqual(upcoming.map((item: { id: string }) => item.id), ['rec-soon'])
  } finally {
    await deleteApp(app)
  }
})
