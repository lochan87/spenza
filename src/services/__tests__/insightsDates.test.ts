import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as dateFns from 'date-fns'
import * as math from '../../utils/insightsMath.ts'
import * as splitMath from '../../utils/splitMath.ts'
import type { InsightsSummary } from '../../types/index.ts'

const now = new Date(2026, 10, 15, 12)
const records = [
  { date: new Date(2026, 10, 1), amountPaise: 10001 },
  { date: now, amountPaise: 20003 },
  { date: new Date(2026, 10, 16), amountPaise: 900001 },
  { date: new Date(2026, 9, 31), amountPaise: 70001 },
  { amountPaise: 30001 },
].map((row, i) => ({ id: String(i), type: 'trip', categoryId: 'food', description: 'Meal', paymentMode: 'Cash', ...row }))

function harness(ignoreQuery = false, cacheWrite: () => Promise<void> = async () => {}, metadata = { fromCache: false, hasPendingWrites: false }) {
  type Constraint = { field: string; op: string; value: Date }
  type Ref = { path: string[]; constraints: Constraint[] }
  let reads = 0
  let saved: InsightsSummary | undefined
  const firestore = {
    collection: (_db: unknown, ...path: string[]): Ref => {
      assert.deepEqual(path, ['users', 'owner', 'transactions'])
      return { path, constraints: [] }
    },
    doc: (_db: unknown, ...path: string[]) => {
      assert.deepEqual(path, ['users', 'owner', 'insights', 'summary'])
      return path
    },
    query: (ref: Ref, ...constraints: Constraint[]) => ({ ...ref, constraints }),
    where: (field: string, op: string, value: Date) => ({ field, op, value }),
    Timestamp: { fromDate: (date: Date) => date },
    getDocs: async (ref: Ref) => {
      reads++
      if (ref.constraints.length) {
        assert.equal(ref.constraints[0].value.getTime(), dateFns.startOfMonth(now).getTime())
        assert.equal(ref.constraints[1].value.getTime(), now.getTime())
      }
      const selected = ignoreQuery ? records : records.filter(row => ref.constraints.every(c =>
        row.date && (c.op === '>=' ? row.date >= c.value : row.date <= c.value)))
      return { metadata, docs: selected.map(({ id, ...data }) => ({ id, data: () => data })) }
    },
    setDoc: async (_ref: unknown, summary: InsightsSummary) => { await cacheWrite(); saved = summary },
    deleteDoc: cacheWrite,
  }
  const exports = {} as {
    invalidateInsightsCache: (uid: string) => Promise<boolean>
    getCurrentMonthSpendTotal: (uid: string, now: Date) => Promise<number>
    computeAndCacheInsights: (uid: string, now: Date) => Promise<InsightsSummary>
    isCacheStaleAgainstCount: (summary: InsightsSummary, count: number) => boolean
    isCacheFresh: (summary: InsightsSummary, now: Date) => boolean
  }
  const source = readFileSync(new URL('../insights.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText
  runInNewContext(compiled, { exports, Date, console, setTimeout, clearTimeout, require: (name: string) => {
    if (name === 'firebase/firestore') return firestore
    if (name === 'date-fns') return dateFns
    if (name === '@/firebase/config') return { db: {} }
    if (name === '@/services/transactions') return { getCategories: async () => [] }
    if (name === '@/utils/insightsMath') return math
    if (name === '@/utils/splitMath') return splitMath
    throw new Error(`Unexpected dependency: ${name}`)
  } })
  return { service: exports, reads: () => reads, saved: () => saved }
}

it('bounds the live pace query inclusively and independently validates the returned dates', async () => {
  for (const ignoreQuery of [false, true]) {
    const h = harness(ignoreQuery)
    const total = await h.service.getCurrentMonthSpendTotal('owner', now)
    assert.equal(total, 30004)
    assert.equal(math.calculateSpendingPace(total, now).dailyPacePaise, Math.round(30004 / 15))
    assert.equal(h.reads(), 1)
  }
})

it('replaces old future-inclusive caches, preserves count/TTL/month checks and caches the corrected full-history derivation', async () => {
  const h = harness()
  const summary = await h.service.computeAndCacheInsights('owner', now)
  assert.equal(summary, h.saved())
  assert.equal(h.reads(), 1)
  assert.equal(summary.transactionCount, records.length, 'missing dates remain in the collection count')
  assert.equal(summary.monthComparison!.thisMonthPaise, 30004)
  assert.equal(summary.tripTotalPaise, 1030007, 'all-time spending retains future and missing-date records')
  assert.equal(summary.schemaVersion, math.INSIGHTS_SCHEMA_VERSION)
  assert.equal(h.service.isCacheStaleAgainstCount({ ...summary, schemaVersion: 4 }, records.length), true)
  assert.equal(h.service.isCacheStaleAgainstCount(summary, records.length), false)
  assert.equal(h.service.isCacheStaleAgainstCount(summary, records.length + 5), true)
  assert.equal(h.service.isCacheStaleAgainstCount(summary, 2), true)
  const cached = { ...summary, computedAt: { toDate: () => now } } as InsightsSummary
  assert.equal(h.service.isCacheFresh(cached, now), true)
  assert.equal(h.service.isCacheFresh(cached, new Date(2026, 10, 23, 12)), false)
  assert.equal(h.service.isCacheFresh(cached, new Date(2026, 11, 1)), false)
})

it('accepts legacy cache timestamp maps and treats malformed timestamps as stale', () => {
  const h = harness()
  const summary = { computedAt: { seconds: now.getTime() / 1000, nanoseconds: 0 } } as InsightsSummary
  assert.equal(h.service.isCacheFresh(summary, now), true)
  assert.equal(h.service.isCacheFresh({ ...summary, computedAt: null } as unknown as InsightsSummary, now), false)
})
it('does not block first computation on a stalled cache write or disguise invalidation as acknowledged', async () => {
  const h = harness(false, () => new Promise(() => {}))
  assert.ok(await h.service.computeAndCacheInsights('owner', now))
  assert.equal(await h.service.invalidateInsightsCache('owner'), false)
})
it('returns derived analytics when optional cache persistence is denied, but reports failed invalidation', async () => {
  const h = harness(false, async () => { throw new Error('permission-denied') })
  assert.ok(await h.service.computeAndCacheInsights('owner', now))
  assert.equal(await h.service.invalidateInsightsCache('owner'), false)
})
it('never persists a summary computed from cached or pending transaction snapshots', async () => {
  for (const metadata of [{ fromCache: true, hasPendingWrites: false }, { fromCache: false, hasPendingWrites: true }]) {
    const h = harness(false, async () => {}, metadata)
    await assert.rejects(h.service.computeAndCacheInsights('owner', now), /synchronized server data/)
    assert.equal(h.saved(), undefined)
  }
})
