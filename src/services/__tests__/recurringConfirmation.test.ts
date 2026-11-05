import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { Timestamp } from 'firebase/firestore'
import * as dateFns from 'date-fns'
import * as transactionSchemas from '../../utils/schemas.ts'
import * as recurringMath from '../../utils/recurringMath.ts'
import type { RecurringItem } from '../../types/index.ts'

// Runs the real recurring service against a transaction double with optimistic
// concurrency checks. No Firebase app is initialized and no production data is
// touched. This verifies service wiring and retry behaviour, not the actual
// Firestore SDK/server implementation.

const basePath = 'users/test-user'

type StoredDoc = Record<string, any>

interface Write {
  type: 'set' | 'update' | 'delete'
  ref: string
  data?: StoredDoc
}

interface ConfirmResult {
  created: boolean
  transactionId: string
  recurringItem: RecurringItem | null
}

interface RecurringService {
  confirmRecurringOccurrence: (uid: string, item: RecurringItem, amountPaise: number) => Promise<ConfirmResult>
  recurringOccurrenceId: (item: Pick<RecurringItem, 'id' | 'nextDueDate'>) => string
  recurringConfirmationErrorMessage: (error: unknown) => string
  recurringSaveErrorMessage: (error: unknown) => string
  updateRecurringItem: (
    uid: string,
    id: string,
    data: Partial<Omit<RecurringItem, 'id' | 'createdAt'>>,
    original?: RecurringItem
  ) => Promise<void>
  computeNextDueDate: (
    current: Date,
    frequency: RecurringItem['frequency'],
    dayOfMonth: number | null,
    dayOfWeek: number | null
  ) => Date
  RecurringConfirmationError: new (message: string) => Error
}

interface HarnessOptions {
  docs?: Record<string, StoredDoc>
  online?: boolean
  failCommit?: boolean
  failOnPath?: string
  loseResponseAfterCommit?: boolean
}

function createHarness(options: HarnessOptions = {}) {
  const docs = new Map<string, StoredDoc>()
  for (const [path, data] of Object.entries(options.docs ?? {})) docs.set(path, { ...data })
  const versions = new Map<string, number>()
  const nav = { onLine: options.online ?? true }
  let attempts = 0
  let appliedWrites = 0
  let loseResponse = options.loseResponseAfterCommit ?? false
  let commitQueue: Promise<void> = Promise.resolve()

  const bump = (path: string) => versions.set(path, (versions.get(path) ?? 0) + 1)

  const applyWrite = (write: Write) => {
    if (options.failOnPath === write.ref) throw new Error(`Simulated ${write.type} failure`)
    if (write.type === 'delete') {
      docs.delete(write.ref)
      bump(write.ref)
      appliedWrites++
      return
    }
    if (write.type === 'update') {
      const existing = docs.get(write.ref)
      if (!existing) {
        const error = new Error('Simulated document not found') as Error & { code: string }
        error.code = 'not-found'
        throw error
      }
      docs.set(write.ref, { ...existing, ...write.data })
      bump(write.ref)
      appliedWrites++
      return
    }
    docs.set(write.ref, { ...write.data })
    bump(write.ref)
    appliedWrites++
  }

  const setDoc = async (ref: string, data: StoredDoc, opts?: { merge?: boolean }) => {
    if (options.failOnPath === ref) throw new Error('Simulated document write failure')
    const existing = docs.get(ref)
    docs.set(ref, opts?.merge && existing ? { ...existing, ...data } : { ...data })
    bump(ref)
    appliedWrites++
  }

  const sdk = {
    Timestamp,
    doc: (_db: unknown, ...segments: string[]) => segments.join('/'),
    collection: (_db: unknown, ...segments: string[]) => segmentList(segments),
    query: (target: unknown) => target,
    orderBy: () => undefined,
    where: () => undefined,
    getDocs: async () => ({ docs: [] }),
    deleteDoc: async (ref: string) => {
      if (options.failOnPath === ref) throw new Error('Simulated document delete failure')
      docs.delete(ref)
      bump(ref)
      appliedWrites++
    },
    setDoc,
    serverTimestamp: () => Timestamp.now(),
    runTransaction: async (_db: unknown, callback: (txn: any) => Promise<unknown>) => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        attempts++
        const readVersions = new Map<string, number>()
        const writes: Write[] = []
        let wrote = false
        const txn = {
          get: async (ref: string) => {
            if (wrote) throw new Error('Firestore transactions must complete all reads before writing')
            readVersions.set(ref, versions.get(ref) ?? 0)
            const data = docs.get(ref)
            return {
              exists: () => data !== undefined,
              id: ref.split('/').pop(),
              data: () => (data === undefined ? undefined : { ...data }),
            }
          },
          set: (ref: string, data: StoredDoc) => {
            wrote = true
            writes.push({ type: 'set', ref, data })
          },
          update: (ref: string, data: StoredDoc) => {
            wrote = true
            writes.push({ type: 'update', ref, data })
          },
          delete: (ref: string) => {
            wrote = true
            writes.push({ type: 'delete', ref })
          },
        }
        const result = await callback(txn)

        // Serialize commits like the Firestore backend and reject the commit if
        // any document read by this attempt changed in the meantime.
        const previous = commitQueue
        let release!: () => void
        commitQueue = new Promise<void>(resolve => { release = resolve })
        await previous
        let conflict = false
        try {
          for (const [path, version] of readVersions) {
            if ((versions.get(path) ?? 0) !== version) {
              conflict = true
              break
            }
          }
          if (!conflict) {
            if (options.failCommit) throw new Error('Simulated commit failure')
            const backup = new Map(docs)
            try {
              for (const write of writes) applyWrite(write)
            } catch (error) {
              // A failed transaction commit is atomic: no writes survive.
              docs.clear()
              for (const [path, data] of backup) docs.set(path, data)
              throw error
            }
          }
        } finally {
          release()
        }
        if (conflict) continue
        if (loseResponse) {
          loseResponse = false
          throw new Error('Simulated lost response after commit')
        }
        return result
      }
      throw new Error('Simulated transaction retry limit')
    },
  }

  const source = readFileSync(new URL('../recurring.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText
  const serviceExports: Partial<RecurringService> = {}
  runInNewContext(compiled, {
    exports: serviceExports,
    navigator: nav,
    console,
    require: (name: string) => {
      if (name === 'firebase/firestore') return sdk
      if (name === '@/firebase/config') return { db: {} }
      if (name === '@/utils/schemas') return transactionSchemas
      if (name === '@/utils/recurringMath') return recurringMath
      if (name === 'date-fns') return dateFns
      throw new Error(`Unexpected import: ${name}`)
    },
  })

  return {
    service: serviceExports as RecurringService,
    nav,
    docs,
    setOnline: (value: boolean) => { nav.onLine = value },
    attempts: () => attempts,
    appliedWrites: () => appliedWrites,
    read: (path: string) => docs.get(path),
    directWrite: (path: string, data: StoredDoc) => {
      docs.set(path, { ...data })
      bump(path)
    },
    transactionPath: (id: string) => `${basePath}/transactions/${id}`,
    recurringPath: (id: string) => `${basePath}/recurring/${id}`,
    insightsPath: `${basePath}/insights/summary`,
  }
}

function segmentList(segments: string[]) {
  return { path: segments.join('/') }
}

function atLocal(year: number, month: number, day: number, hours = 12): Timestamp {
  return Timestamp.fromDate(new Date(year, month, day, hours, 0, 0, 0))
}

function overdueDate(daysAgo = 1): Timestamp {
  return Timestamp.fromDate(new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000))
}

function recurringItem(overrides: Partial<RecurringItem> = {}): RecurringItem {
  return {
    id: 'rec-1',
    description: 'Netflix',
    amountPaise: 64900,
    categoryId: 'cat-subs',
    frequency: 'monthly',
    dayOfMonth: 15,
    dayOfWeek: null,
    monthDay: null,
    nextDueDate: overdueDate(),
    lastGeneratedDate: null,
    paymentMode: 'Card',
    paymentAccountId: 'acc-card',
    isActive: true,
    createdAt: Timestamp.fromMillis(1_700_000_000_000),
    updatedAt: Timestamp.fromMillis(1_700_000_000_000),
    ...overrides,
  }
}

function seedFor(item: RecurringItem, summary = true): Record<string, StoredDoc> {
  const seeds: Record<string, StoredDoc> = {
    [`${basePath}/recurring/${item.id}`]: { ...item },
  }
  if (summary) seeds[`${basePath}/insights/summary`] = { schemaVersion: 8, computedAt: Timestamp.now() }
  return seeds
}

describe('Recurring confirmation — atomic, idempotent and concurrency-safe', () => {
  it('1. confirms a due occurrence and commits the expense with the schedule advancement', async () => {
    const item = recurringItem()
    const h = createHarness({ docs: seedFor(item) })
    const result = await h.service.confirmRecurringOccurrence('test-user', item, 70000)

    assert.equal(result.created, true)
    const expense = h.read(h.transactionPath(result.transactionId))!
    assert.ok(expense, 'expense must exist after commit')
    assert.equal(expense.id, result.transactionId)
    assert.equal(expense.amountPaise, 70000)
    assert.equal(expense.description, 'Netflix')
    assert.equal(expense.type, 'recurring')
    assert.equal(expense.paymentMode, 'Card')
    assert.equal(expense.paymentAccountId, 'acc-card')
    assert.equal(expense.recurringItemId, item.id)
    assert.equal(expense.recurringOccurrenceDate.toMillis(), item.nextDueDate.toMillis())
    assert.equal(expense.date.toMillis(), item.nextDueDate.toMillis())
    assert.equal(expense.recoverablePaise, 0)
    assert.deepEqual(expense.splits, [])

    const schedule = h.read(h.recurringPath(item.id))!
    assert.equal(
      schedule.nextDueDate.toMillis(),
      h.service.computeNextDueDate(item.nextDueDate.toDate(), 'monthly', 15, null).getTime()
    )
    assert.ok(schedule.lastGeneratedDate, 'lastGeneratedDate must be recorded')
    assert.equal(h.read(h.insightsPath), undefined, 'insights cache must be invalidated atomically')
    assert.equal(h.appliedWrites(), 3)
  })

  it('2. fails atomically without creating an expense, advancing the schedule or clearing insights', async () => {
    const item = recurringItem()
    const h = createHarness({ docs: seedFor(item), failCommit: true })

    await assert.rejects(h.service.confirmRecurringOccurrence('test-user', item, 64900), /Simulated commit failure/)

    assert.equal(h.read(h.transactionPath(h.service.recurringOccurrenceId(item))), undefined)
    const schedule = h.read(h.recurringPath(item.id))!
    assert.equal(schedule.nextDueDate.toMillis(), item.nextDueDate.toMillis())
    assert.equal(schedule.lastGeneratedDate, null)
    assert.ok(h.read(h.insightsPath), 'insights cache must remain when nothing committed')
  })

  it('3. does not create a duplicate expense when the same occurrence is confirmed twice', async () => {
    const item = recurringItem()
    const h = createHarness({ docs: seedFor(item) })

    const first = await h.service.confirmRecurringOccurrence('test-user', item, 64900)
    const writesAfterFirst = h.appliedWrites()
    const second = await h.service.confirmRecurringOccurrence('test-user', item, 64900)

    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(second.transactionId, first.transactionId)
    assert.equal(h.appliedWrites(), writesAfterFirst, 'a duplicate confirmation must not write again')
    assert.ok(h.read(h.transactionPath(first.transactionId)))
    const schedule = h.read(h.recurringPath(item.id))!
    assert.equal(
      schedule.nextDueDate.toMillis(),
      h.service.computeNextDueDate(item.nextDueDate.toDate(), 'monthly', 15, null).getTime()
    )
    assert.equal(h.attempts(), 2)
  })

  it('4. resolves two concurrent confirmations from separate tabs to exactly one expense', async () => {
    const item = recurringItem()
    const h = createHarness({ docs: seedFor(item) })

    const [a, b] = await Promise.all([
      h.service.confirmRecurringOccurrence('test-user', item, 64900),
      h.service.confirmRecurringOccurrence('test-user', item, 64900),
    ])

    assert.equal([a.created, b.created].filter(Boolean).length, 1)
    assert.equal(a.transactionId, b.transactionId)
    assert.ok(h.read(h.transactionPath(a.transactionId)))
    const schedule = h.read(h.recurringPath(item.id))!
    assert.equal(
      schedule.nextDueDate.toMillis(),
      h.service.computeNextDueDate(item.nextDueDate.toDate(), 'monthly', 15, null).getTime(),
      'the schedule must advance exactly one cycle even when both tabs race'
    )
    assert.equal(h.read(h.insightsPath), undefined)
  })

  it('5. recognises an already-committed occurrence after a lost response and retries safely', async () => {
    const item = recurringItem()
    const h = createHarness({ docs: seedFor(item), loseResponseAfterCommit: true })

    await assert.rejects(h.service.confirmRecurringOccurrence('test-user', item, 64900), /lost response/)
    const id = h.service.recurringOccurrenceId(item)
    assert.ok(h.read(h.transactionPath(id)), 'the transaction committed before the response was lost')

    const retry = await h.service.confirmRecurringOccurrence('test-user', item, 64900)
    assert.equal(retry.created, false)
    assert.equal(retry.transactionId, id)
    assert.equal(h.read(h.transactionPath(id))!.amountPaise, 64900)
    assert.equal(h.appliedWrites(), 3, 'the retry must not repeat the committed writes')
  })

  it('6. never overwrites an unrelated transaction that occupies the deterministic id', async () => {
    const item = recurringItem()
    const h = createHarness({ docs: seedFor(item) })
    const id = h.service.recurringOccurrenceId(item)
    h.directWrite(h.transactionPath(id), { id, amountPaise: 1, recurringItemId: 'another-item' })

    await assert.rejects(
      h.service.confirmRecurringOccurrence('test-user', item, 64900),
      /conflicts with this occurrence/
    )
    assert.equal(h.read(h.transactionPath(id))!.amountPaise, 1, 'existing financial data must never be overwritten')
    assert.equal(h.read(h.recurringPath(item.id))!.nextDueDate.toMillis(), item.nextDueDate.toMillis())
  })

  it('7. advances weekly occurrences by exactly one week', async () => {
    const due = atLocal(2026, 0, 5, 9) // Monday 5 Jan 2026, local time
    const h = createHarness()
    const next = h.service.computeNextDueDate(due.toDate(), 'weekly', null, 1)
    assert.equal(next.getFullYear(), 2026)
    assert.equal(next.getMonth(), 0)
    assert.equal(next.getDate(), 12)
    assert.equal(next.getHours(), 9)

    const item = recurringItem({ frequency: 'weekly', dayOfMonth: null, dayOfWeek: 1, nextDueDate: due })
    const wek = createHarness({ docs: seedFor(item) })
    const result = await wek.service.confirmRecurringOccurrence('test-user', item, item.amountPaise)
    assert.equal(wek.read(wek.recurringPath(item.id))!.nextDueDate.toMillis(), next.getTime())
    assert.ok(result.created)
  })

  it('8. advances monthly occurrences across month boundaries and leap years', () => {
    const h = createHarness()
    const jan31 = atLocal(2026, 0, 31)
    assert.equal(h.service.computeNextDueDate(jan31.toDate(), 'monthly', null, null).getDate(), 28)
    assert.equal(h.service.computeNextDueDate(jan31.toDate(), 'monthly', null, null).getMonth(), 1)

    const aug31 = atLocal(2026, 7, 31)
    const sep = h.service.computeNextDueDate(aug31.toDate(), 'monthly', null, null)
    assert.equal(sep.getMonth(), 8)
    assert.equal(sep.getDate(), 30)

    const jan31Leap = atLocal(2028, 0, 31)
    const febLeap = h.service.computeNextDueDate(jan31Leap.toDate(), 'monthly', null, null)
    assert.equal(febLeap.getMonth(), 1)
    assert.equal(febLeap.getDate(), 29)

    const jan15 = atLocal(2026, 0, 15)
    const feb15 = h.service.computeNextDueDate(jan15.toDate(), 'monthly', 15, null)
    assert.equal(feb15.getMonth(), 1)
    assert.equal(feb15.getDate(), 15)
  })

  it('9. advances yearly occurrences and clamps leap-day anniversaries', () => {
    const h = createHarness()
    const leapDay = atLocal(2028, 1, 29)
    const next = h.service.computeNextDueDate(leapDay.toDate(), 'yearly', null, null)
    assert.equal(next.getMonth(), 1)
    assert.equal(next.getDate(), 28)
    assert.equal(next.getFullYear(), 2029)

    const march = atLocal(2026, 2, 1)
    const nextMarch = h.service.computeNextDueDate(march.toDate(), 'yearly', null, null)
    assert.equal(nextMarch.getFullYear(), 2027)
    assert.equal(nextMarch.getMonth(), 2)
    assert.equal(nextMarch.getDate(), 1)
  })

  it('10. keeps later overdue occurrences available and confirms them as separate expenses', async () => {
    const item = recurringItem({ frequency: 'weekly', dayOfMonth: null, dayOfWeek: 1, nextDueDate: overdueDate(21) })
    const h = createHarness({ docs: seedFor(item) })

    const first = await h.service.confirmRecurringOccurrence('test-user', item, item.amountPaise)
    assert.equal(first.created, true)
    const next = first.recurringItem!
    assert.ok(next.nextDueDate.toMillis() < Date.now(), 'the next occurrence is still overdue')
    assert.notEqual(h.service.recurringOccurrenceId(next), h.service.recurringOccurrenceId(item))

    const recurringDoc = h.read(h.recurringPath(item.id))!
    const secondItem: RecurringItem = { ...next, ...recurringDoc, id: item.id }
    const second = await h.service.confirmRecurringOccurrence('test-user', secondItem, item.amountPaise)
    assert.equal(second.created, true)
    assert.notEqual(second.transactionId, first.transactionId)
    assert.equal(
      [...h.docs.keys()].filter(path => path.startsWith(`${basePath}/transactions/`)).length,
      2,
      'each overdue cycle is logged separately and only when the user confirms it'
    )
  })

  it('11. confirms legacy recurring documents that omit optional schedule fields', async () => {
    const due = overdueDate()
    const legacyDoc = {
      id: 'legacy-rec',
      description: 'Old internet bill',
      amountPaise: 49900,
      categoryId: 'cat-bills',
      frequency: 'monthly',
      nextDueDate: due,
      paymentMode: 'Cash',
      paymentAccountId: null,
      isActive: true,
      createdAt: Timestamp.fromMillis(1),
      updatedAt: Timestamp.fromMillis(1),
    }
    const legacyItem = { ...legacyDoc } as unknown as RecurringItem
    const h = createHarness({ docs: { [`${basePath}/recurring/legacy-rec`]: legacyDoc } })

    const result = await h.service.confirmRecurringOccurrence('test-user', legacyItem, 49900)
    assert.equal(result.created, true)
    assert.ok(h.read(h.transactionPath(result.transactionId)))
    assert.ok(h.read(h.recurringPath('legacy-rec'))!.nextDueDate.toMillis() > due.toMillis())
  })

  it('12. rejects stale recurring edit forms instead of rewinding an advanced schedule', async () => {
    const original = recurringItem({ nextDueDate: atLocal(2026, 0, 15) })
    const advanced = atLocal(2026, 1, 15)
    const h = createHarness({
      docs: { [`${basePath}/recurring/${original.id}`]: { ...original, nextDueDate: advanced, lastGeneratedDate: advanced } },
    })

    await assert.rejects(
      h.service.updateRecurringItem('test-user', original.id, {
        description: 'Renamed subscription',
        nextDueDate: original.nextDueDate,
        lastGeneratedDate: null,
      }, original),
      /schedule changed/
    )
    const stored = h.read(h.recurringPath(original.id))!
    assert.equal(stored.description, 'Netflix')
    assert.equal(stored.nextDueDate.toMillis(), advanced.toMillis())
    assert.ok(stored.lastGeneratedDate, 'a stale form must not clear lastGeneratedDate')
  })

  it('13. writes a legitimate schedule edit and ignores lastGeneratedDate supplied by the form', async () => {
    const original = recurringItem({ nextDueDate: atLocal(2026, 0, 15) })
    const generated = atLocal(2026, 0, 15, 8)
    const h = createHarness({
      docs: { [`${basePath}/recurring/${original.id}`]: { ...original, lastGeneratedDate: generated } },
    })
    const newDue = atLocal(2026, 1, 20)

    await h.service.updateRecurringItem('test-user', original.id, {
      description: 'Netflix Premium',
      amountPaise: 79900,
      nextDueDate: newDue,
      lastGeneratedDate: null,
    }, { ...original, lastGeneratedDate: generated })

    const stored = h.read(h.recurringPath(original.id))!
    assert.equal(stored.description, 'Netflix Premium')
    assert.equal(stored.amountPaise, 79900)
    assert.equal(stored.nextDueDate.toMillis(), newDue.toMillis())
    assert.equal(stored.lastGeneratedDate.toMillis(), generated.toMillis())
  })

  it('14. updates non-schedule fields without requiring a transaction (offline pause preservation)', async () => {
    const item = recurringItem()
    const h = createHarness({ docs: seedFor(item), online: false })

    await h.service.updateRecurringItem('test-user', item.id, { isActive: false })
    assert.equal(h.read(h.recurringPath(item.id))!.isActive, false)
    assert.equal(h.attempts(), 0)
  })

  it('15. invalidates insights on a real confirmation but not on a duplicate', async () => {
    const item = recurringItem()
    const h = createHarness({ docs: seedFor(item) })

    await h.service.confirmRecurringOccurrence('test-user', item, item.amountPaise)
    assert.equal(h.read(h.insightsPath), undefined)

    // Another user action may recreate the cache; a duplicate must not delete it.
    h.directWrite(h.insightsPath, { schemaVersion: 8, computedAt: Timestamp.now() })
    const duplicate = await h.service.confirmRecurringOccurrence('test-user', item, item.amountPaise)
    assert.equal(duplicate.created, false)
    assert.ok(h.read(h.insightsPath), 'duplicate confirmation must not invalidate the cache again')
  })

  it('16. rolls back the expense when cache invalidation fails inside the commit', async () => {
    const item = recurringItem()
    const h = createHarness({ docs: seedFor(item), failOnPath: `${basePath}/insights/summary` })

    await assert.rejects(
      h.service.confirmRecurringOccurrence('test-user', item, item.amountPaise),
      /Simulated delete failure/
    )
    assert.equal(h.read(h.transactionPath(h.service.recurringOccurrenceId(item))), undefined)
    assert.equal(h.read(h.recurringPath(item.id))!.nextDueDate.toMillis(), item.nextDueDate.toMillis())
    assert.ok(h.read(h.insightsPath), 'the failed cache delete must not remove the summary')
  })

  it('17. rejects offline confirmation before touching data and succeeds when retried online', async () => {
    const item = recurringItem()
    const h = createHarness({ docs: seedFor(item), online: false })

    const error = await h.service.confirmRecurringOccurrence('test-user', item, item.amountPaise)
      .then(() => null, e => e as Error)
    assert.ok(error)
    assert.match(error.message, /offline/i)
    assert.match(h.service.recurringConfirmationErrorMessage(error), /offline/i)
    assert.equal(h.attempts(), 0)
    assert.equal(h.read(h.transactionPath(h.service.recurringOccurrenceId(item))), undefined)

    h.setOnline(true)
    const result = await h.service.confirmRecurringOccurrence('test-user', item, item.amountPaise)
    assert.equal(result.created, true)
    assert.ok(h.read(h.transactionPath(result.transactionId)))
  })

  it('18. enforces payment-account rules and positive integer paise before writing', async () => {
    const upiWithoutAccount = recurringItem({ paymentMode: 'UPI', paymentAccountId: null })
    const h = createHarness({ docs: seedFor(upiWithoutAccount) })
    await assert.rejects(
      h.service.confirmRecurringOccurrence('test-user', upiWithoutAccount, 10000),
      /payment account/i
    )
    assert.equal(h.read(h.transactionPath(h.service.recurringOccurrenceId(upiWithoutAccount))), undefined)

    const cashWithAccount = recurringItem({ id: 'rec-2', paymentMode: 'Cash', paymentAccountId: 'acc-card' })
    const h2 = createHarness({ docs: seedFor(cashWithAccount) })
    await assert.rejects(
      h2.service.confirmRecurringOccurrence('test-user', cashWithAccount, 10000),
      /payment account|Payment account/
    )

    const zeroAmount = recurringItem({ id: 'rec-3', paymentMode: 'Cash', paymentAccountId: null })
    const h3 = createHarness({ docs: seedFor(zeroAmount) })
    await assert.rejects(
      h3.service.confirmRecurringOccurrence('test-user', zeroAmount, 0),
      /amount, category and payment account/
    )
  })

  it('19. derives stable, collision-resistant Firestore document ids', () => {
    const h = createHarness()
    const a = recurringItem({ nextDueDate: atLocal(2026, 0, 15) })
    const later = recurringItem({ nextDueDate: atLocal(2026, 1, 15) })
    const other = recurringItem({ id: 'rec-other', nextDueDate: atLocal(2026, 0, 15) })

    const id = h.service.recurringOccurrenceId(a)
    assert.equal(h.service.recurringOccurrenceId({ ...a }), id)
    assert.notEqual(h.service.recurringOccurrenceId(later), id)
    assert.notEqual(h.service.recurringOccurrenceId(other), id)
    assert.ok(!id.includes('/'), 'Firestore document ids cannot contain slashes')
    assert.ok(id.length <= 1400)
    assert.throws(() => h.service.recurringOccurrenceId({ id: '', nextDueDate: a.nextDueDate }), /Invalid/)
  })

  it('20. rejects a confirmation whose schedule changed or is no longer active', async () => {
    const item = recurringItem()
    const advanced = atLocal(2026, 5, 15)
    const h = createHarness({
      docs: { [`${basePath}/recurring/${item.id}`]: { ...item, nextDueDate: advanced } },
    })
    await assert.rejects(
      h.service.confirmRecurringOccurrence('test-user', item, item.amountPaise),
      /schedule changed or is no longer active/
    )
    assert.equal(h.read(h.transactionPath(h.service.recurringOccurrenceId(item))), undefined)

    const paused = recurringItem({ id: 'paused', isActive: false })
    const h2 = createHarness({ docs: seedFor(paused) })
    await assert.rejects(
      h2.service.confirmRecurringOccurrence('test-user', paused, paused.amountPaise),
      /schedule changed or is no longer active/
    )
  })
})
