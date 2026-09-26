import { useState } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { TransactionSchema } from '@/utils/schemas'
import {
  collection,
  doc,
  setDoc,
  getDocs,
  serverTimestamp,
  getDoc,
} from 'firebase/firestore'
import { db } from '@/firebase/config'
import { CheckCircle, XCircle, Play, ChevronDown, ChevronUp } from 'lucide-react'

interface TestResult {
  name: string
  status: 'pass' | 'fail' | 'pending'
  message: string
  data?: Record<string, unknown>
}

/**
 * Debug panel that:
 * 1. Validates the Zod schemas (Cash → null account; UPI → required account)
 * 2. Writes a UPI transaction + a Cash transaction to Firestore
 * 3. Reads them back and logs them
 *
 * Only visible in the Phase 1 app shell. Remove in Phase 2+ or gate behind a dev flag.
 */
export function SchemaTestPanel() {
  const { user } = useAuth()
  const [results, setResults] = useState<TestResult[]>([])
  const [running, setRunning] = useState(false)
  const [expanded, setExpanded] = useState(true)

  async function runTests() {
    if (!user) return
    setRunning(true)
    setResults([])

    const uid = user.uid
    const newResults: TestResult[] = []

    // ── Test 1: Schema rejects UPI with null accountId ────────────────────
    const upiNoAccount = TransactionSchema.safeParse({
      amountPaise: 15000,
      description: 'Test UPI — should fail validation',
      categoryId: 'test-cat',
      type: 'everyday',
      date: new Date().toISOString(),
      paymentMode: 'UPI',
      paymentAccountId: null,   // ← should be rejected
    })

    newResults.push({
      name: 'Schema: UPI + null accountId → REJECT',
      status: upiNoAccount.success ? 'fail' : 'pass',
      message: upiNoAccount.success
        ? '❌ Schema allowed UPI with null account — BUG!'
        : `✅ Correctly rejected: ${upiNoAccount.error.issues[0]?.message}`,
    })

    // ── Test 2: Schema rejects Cash with non-null accountId ───────────────
    const cashWithAccount = TransactionSchema.safeParse({
      amountPaise: 5000,
      description: 'Test Cash — should fail validation',
      categoryId: 'test-cat',
      type: 'everyday',
      date: new Date().toISOString(),
      paymentMode: 'Cash',
      paymentAccountId: 'some-account-id',  // ← should be rejected
    })

    newResults.push({
      name: 'Schema: Cash + non-null accountId → REJECT',
      status: cashWithAccount.success ? 'fail' : 'pass',
      message: cashWithAccount.success
        ? '❌ Schema allowed Cash with non-null account — BUG!'
        : `✅ Correctly rejected: ${cashWithAccount.error.issues[0]?.message}`,
    })

    // ── Test 3: Schema accepts Cash with null accountId ───────────────────
    const cashValid = TransactionSchema.safeParse({
      amountPaise: 5000,
      description: 'Chai from street stall',
      categoryId: 'test-cat',
      type: 'everyday',
      date: new Date().toISOString(),
      paymentMode: 'Cash',
      paymentAccountId: null,   // ← correct
    })

    newResults.push({
      name: 'Schema: Cash + null accountId → ACCEPT',
      status: cashValid.success ? 'pass' : 'fail',
      message: cashValid.success
        ? '✅ Cash transaction validated correctly'
        : `❌ Unexpected rejection: ${cashValid.error.issues[0]?.message}`,
    })

    // ── Test 4: Write a UPI transaction to Firestore ──────────────────────
    try {
      // First: get or create a placeholder UPI account
      const accountsRef = collection(db, 'users', uid, 'paymentAccounts')
      const accountsSnap = await getDocs(accountsRef)
      let upiAccountId: string

      const existingUpi = accountsSnap.docs.find(d => d.data().type === 'UPI')
      if (existingUpi) {
        upiAccountId = existingUpi.id
      } else {
        // Create a placeholder UPI account
        const newAccRef = doc(accountsRef)
        await setDoc(newAccRef, {
          id: newAccRef.id,
          name: 'My UPI (test)',
          type: 'UPI',
          isDefault: false,
          isArchived: false,
          createdAt: serverTimestamp(),
        })
        upiAccountId = newAccRef.id
      }

      // Write UPI transaction
      const txRef = collection(db, 'users', uid, 'transactions')
      const upiTxRef = doc(txRef)
      const upiTxData = {
        id: upiTxRef.id,
        amountPaise: 34900,                     // ₹349
        description: 'Swiggy order — dinner',
        categoryId: 'food-test',
        type: 'everyday' as const,
        date: serverTimestamp(),
        paymentMode: 'UPI' as const,
        paymentAccountId: upiAccountId,         // ← linked account
        tripId: null,
        personId: null,
        tags: ['food', 'delivery'],
        notes: 'Test UPI transaction',
        receiptUrl: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }
      await setDoc(upiTxRef, upiTxData)

      // Read it back
      const upiReadBack = await getDoc(upiTxRef)
      const upiReadData = upiReadBack.data()

      newResults.push({
        name: 'Firestore: Write + Read UPI transaction',
        status: upiReadData?.paymentAccountId === upiAccountId ? 'pass' : 'fail',
        message: upiReadData?.paymentAccountId === upiAccountId
          ? `✅ UPI tx written & read back. paymentAccountId: "${upiAccountId}". Amount: ₹${(upiReadData?.amountPaise as number) / 100}`
          : '❌ paymentAccountId mismatch on read-back',
        data: {
          id: upiReadBack.id,
          amountPaise: upiReadData?.amountPaise,
          paymentMode: upiReadData?.paymentMode,
          paymentAccountId: upiReadData?.paymentAccountId,
        },
      })

      console.log('[Spenza Test] UPI Transaction read-back:', upiReadData)

    } catch (err) {
      newResults.push({
        name: 'Firestore: Write + Read UPI transaction',
        status: 'fail',
        message: `❌ Firestore error: ${String(err)}`,
      })
    }

    // ── Test 5: Write a Cash transaction to Firestore ─────────────────────
    try {
      const txRef = collection(db, 'users', uid, 'transactions')
      const cashTxRef = doc(txRef)
      const cashTxData = {
        id: cashTxRef.id,
        amountPaise: 2000,                       // ₹20
        description: 'Chai — auto stand',
        categoryId: 'food-test',
        type: 'everyday' as const,
        date: serverTimestamp(),
        paymentMode: 'Cash' as const,
        paymentAccountId: null,                  // ← correctly null for Cash
        tripId: null,
        personId: null,
        tags: ['chai', 'cash'],
        notes: 'Test Cash transaction',
        receiptUrl: null,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }
      await setDoc(cashTxRef, cashTxData)

      // Read it back
      const cashReadBack = await getDoc(cashTxRef)
      const cashReadData = cashReadBack.data()

      newResults.push({
        name: 'Firestore: Write + Read Cash transaction',
        status: cashReadData?.paymentAccountId === null ? 'pass' : 'fail',
        message: cashReadData?.paymentAccountId === null
          ? `✅ Cash tx written & read back. paymentAccountId is null ✓. Amount: ₹${(cashReadData?.amountPaise as number) / 100}`
          : `❌ Expected null paymentAccountId, got: ${cashReadData?.paymentAccountId}`,
        data: {
          id: cashReadBack.id,
          amountPaise: cashReadData?.amountPaise,
          paymentMode: cashReadData?.paymentMode,
          paymentAccountId: cashReadData?.paymentAccountId,
        },
      })

      console.log('[Spenza Test] Cash Transaction read-back:', cashReadData)

    } catch (err) {
      newResults.push({
        name: 'Firestore: Write + Read Cash transaction',
        status: 'fail',
        message: `❌ Firestore error: ${String(err)}`,
      })
    }

    setResults(newResults)
    setRunning(false)
  }

  const passed = results.filter(r => r.status === 'pass').length
  const failed = results.filter(r => r.status === 'fail').length

  return (
    <div className="glass-card overflow-hidden">
      {/* Header */}
      <div
        className="flex cursor-pointer items-center justify-between p-5 hover:bg-white/[0.02]"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
            Schema &amp; Firestore Tests
          </h2>
          {results.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <span className="rounded-full bg-[var(--color-success)]/20 px-2 py-0.5 text-[var(--color-success)]">
                {passed} passed
              </span>
              {failed > 0 && (
                <span className="rounded-full bg-[var(--color-danger)]/20 px-2 py-0.5 text-[var(--color-danger)]">
                  {failed} failed
                </span>
              )}
            </div>
          )}
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-[var(--color-text-muted)]" />
        ) : (
          <ChevronDown className="h-4 w-4 text-[var(--color-text-muted)]" />
        )}
      </div>

      {expanded && (
        <div className="border-t border-[var(--color-border)] p-5">
          <p className="mb-4 text-sm text-[var(--color-text-muted)]">
            Runs 5 automated checks: Zod schema validation (2 reject + 1 accept) and
            Firestore write/read (1 UPI with linked account + 1 Cash with null account).
            Check the browser console for full Firestore documents.
          </p>

          <button
            id="run-schema-tests-btn"
            onClick={runTests}
            disabled={running}
            className="mb-6 flex items-center gap-2 rounded-xl bg-[var(--color-primary)] px-5 py-2.5 text-sm font-medium text-white transition-all hover:bg-[var(--color-primary-hover)] active:scale-[0.98] disabled:opacity-60"
          >
            <Play className={`h-4 w-4 ${running ? 'animate-pulse' : ''}`} />
            {running ? 'Running tests…' : 'Run All Tests'}
          </button>

          {/* Results */}
          {results.length > 0 && (
            <div className="flex flex-col gap-3">
              {results.map((result, i) => (
                <div
                  key={i}
                  className={`rounded-xl border p-4 ${
                    result.status === 'pass'
                      ? 'border-[var(--color-success)]/30 bg-[var(--color-success)]/5'
                      : 'border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {result.status === 'pass' ? (
                      <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-success)]" />
                    ) : (
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-danger)]" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-[var(--color-text)]">{result.name}</p>
                      <p className="mt-1 text-xs text-[var(--color-text-muted)]">{result.message}</p>
                      {result.data && (
                        <pre className="mt-2 overflow-x-auto rounded-lg bg-black/30 p-3 text-xs text-[var(--color-accent)]">
                          {JSON.stringify(result.data, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
