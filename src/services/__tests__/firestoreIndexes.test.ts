import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { Timestamp } from 'firebase/firestore'
import * as recurringDates from '../../utils/recurringDates.ts'
import * as transactionSchemas from '../../utils/schemas.ts'
import * as recurringMath from '../../utils/recurringMath.ts'

// Index configuration is deployment-critical: a missing composite index makes
// Firestore reject the query at runtime, and an index that lists the same field
// twice cannot be created. These tests keep the declaration and the two real
// recurring query paths in agreement. They never initialize a Firebase app.

const indexPath = new URL('../../../firestore.indexes.json', import.meta.url)

interface IndexField {
  fieldPath: string
  order?: string
  arrayConfig?: string
}

interface IndexDefinition {
  collectionGroup: string
  queryScope: string
  fields: IndexField[]
}

interface IndexConfig {
  indexes: IndexDefinition[]
  fieldOverrides: unknown[]
}

function loadIndexes(): IndexConfig {
  return JSON.parse(readFileSync(indexPath, 'utf8')) as IndexConfig
}

function comparable(index: IndexDefinition) {
  return {
    collectionGroup: index.collectionGroup,
    queryScope: index.queryScope,
    fields: index.fields.map(field => ({ fieldPath: field.fieldPath, order: field.order })),
  }
}

describe('firestore.indexes.json — structural validity', () => {
  it('1. declares well-formed index definitions and one index mode per field', () => {
    const config = loadIndexes()
    assert.ok(Array.isArray(config.indexes), 'indexes must be an array')
    assert.ok(Array.isArray(config.fieldOverrides), 'fieldOverrides must be an array')

    for (const index of config.indexes) {
      assert.equal(typeof index.collectionGroup, 'string')
      assert.ok(index.collectionGroup.length > 0, 'collectionGroup must not be empty')
      assert.ok(
        ['COLLECTION', 'COLLECTION_GROUP'].includes(index.queryScope),
        `unsupported queryScope: ${index.queryScope}`
      )
      assert.ok(Array.isArray(index.fields) && index.fields.length > 0, 'fields must be non-empty')

      for (const field of index.fields) {
        assert.equal(typeof field.fieldPath, 'string')
        assert.ok(field.fieldPath.length > 0, 'fieldPath must not be empty')
        const modes = [field.order, field.arrayConfig].filter(value => value !== undefined)
        assert.equal(
          modes.length,
          1,
          `${index.collectionGroup}.${field.fieldPath} must declare exactly one index mode`
        )
        if (field.order !== undefined) {
          assert.ok(
            ['ASCENDING', 'DESCENDING'].includes(field.order),
            `unsupported order: ${field.order}`
          )
        }
        if (field.arrayConfig !== undefined) {
          assert.equal(field.arrayConfig, 'CONTAINS')
        }
      }
    }
  })

  it('2. never repeats a field inside one composite index', () => {
    for (const index of loadIndexes().indexes) {
      const seen = new Set<string>()
      for (const field of index.fields) {
        assert.ok(
          !seen.has(field.fieldPath),
          `${index.collectionGroup} repeats field ${field.fieldPath}`
        )
        seen.add(field.fieldPath)
      }
    }
  })

  it('3. declares exactly the composite indexes the application needs', () => {
    // Single-field indexes are created automatically by Firestore, including the
    // implicit __name__ tiebreaker, so declaring them only adds deploy noise.
    // The only equality-plus-range query in the app is the recurring one.
    assert.deepEqual(loadIndexes().indexes.map(comparable), [
      {
        collectionGroup: 'recurring',
        queryScope: 'COLLECTION',
        fields: [
          { fieldPath: 'isActive', order: 'ASCENDING' },
          { fieldPath: 'nextDueDate', order: 'ASCENDING' },
        ],
      },
    ])
  })
})

// ─── Real service against a query double ─────────────────────────────────────

type QueryConstraint =
  | { kind: 'where'; field: string; op: string; value: unknown }
  | { kind: 'orderBy'; field: string; direction: 'asc' | 'desc' }

interface StoredDoc {
  id: string
  data: Record<string, any>
}

interface CapturedQuery {
  path: string
  constraints: QueryConstraint[]
}

const BASE_PATH = 'users/test-user/recurring'
const DAY_MS = 24 * 60 * 60 * 1000

function valueOf(value: unknown): number | string | boolean | null {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    return (value as { toMillis: () => number }).toMillis()
  }
  return value as number | string | boolean | null
}

function matches(doc: StoredDoc, constraint: Extract<QueryConstraint, { kind: 'where' }>): boolean {
  const actual = valueOf(doc.data[constraint.field])
  const expected = valueOf(constraint.value)
  switch (constraint.op) {
    case '==':
      return actual === expected
    case '<=':
      return (actual as number) <= (expected as number)
    case '>=':
      return (actual as number) >= (expected as number)
    default:
      throw new Error(`Unsupported operator: ${constraint.op}`)
  }
}

function createHarness(items: StoredDoc[]) {
  const captured: CapturedQuery[] = []
  const stored = new Map<string, StoredDoc>(items.map(item => [item.id, item]))

  const sdk = {
    Timestamp,
    collection: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
    doc: (_db: unknown, ...segments: string[]) => segments.join('/'),
    query: (target: { path: string }, ...constraints: QueryConstraint[]) => ({
      path: target.path,
      constraints,
    }),
    where: (field: string, op: string, value: unknown): QueryConstraint => ({
      kind: 'where',
      field,
      op,
      value,
    }),
    orderBy: (field: string, direction: 'asc' | 'desc' = 'asc'): QueryConstraint => ({
      kind: 'orderBy',
      field,
      direction,
    }),
    getDocs: async (q: { path: string; constraints: QueryConstraint[] }) => {
      captured.push({ path: q.path, constraints: q.constraints })
      const wheres = q.constraints.filter(
        (c): c is Extract<QueryConstraint, { kind: 'where' }> => c.kind === 'where'
      )
      const range = wheres.find(c => c.op !== '==')
      const rows = [...stored.values()]
        .filter(item => wheres.every(constraint => matches(item, constraint)))
        .sort((a, b) =>
          range
            ? (valueOf(a.data[range.field]) as number) - (valueOf(b.data[range.field]) as number)
            : 0
        )
      return { docs: rows.map(item => ({ id: item.id, data: () => ({ ...item.data }) })) }
    },
    setDoc: async () => undefined,
    deleteDoc: async () => undefined,
    serverTimestamp: () => Timestamp.now(),
    runTransaction: async () => {
      throw new Error('Not used by these tests')
    },
  }

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
      if (name === '@/firebase/config') return { db: {} }
      if (name === '@/utils/schemas') return transactionSchemas
      if (name === '@/utils/recurringMath') return recurringMath
      if (name === '@/utils/recurringDates') return recurringDates
      throw new Error(`Unexpected import: ${name}`)
    },
  })

  return { service: serviceExports, captured }
}

function recurringDoc(
  id: string,
  nextDueDateMs: number,
  isActive = true
): StoredDoc {
  return {
    id,
    data: {
      id,
      description: id,
      amountPaise: 10000,
      categoryId: 'cat-subs',
      frequency: 'monthly',
      dayOfMonth: 1,
      dayOfWeek: null,
      monthDay: null,
      nextDueDate: Timestamp.fromMillis(nextDueDateMs),
      lastGeneratedDate: null,
      paymentMode: 'Cash',
      paymentAccountId: null,
      isActive,
      createdAt: Timestamp.fromMillis(nextDueDateMs),
      updatedAt: Timestamp.fromMillis(nextDueDateMs),
    },
  }
}

/**
 * The composite index Firestore needs for these constraints: equality fields
 * first, then one range field, then any explicit orderBy. A query touching a
 * single field is served by the automatic single-field index.
 */
function requiredComposite(
  constraints: QueryConstraint[]
): { fields: IndexField[]; equalityCount: number } | null {
  const equality = constraints.filter(
    (c): c is Extract<QueryConstraint, { kind: 'where' }> => c.kind === 'where' && c.op === '=='
  )
  const range = constraints.filter(
    (c): c is Extract<QueryConstraint, { kind: 'where' }> => c.kind === 'where' && c.op !== '=='
  )
  const orders = constraints.filter(
    (c): c is Extract<QueryConstraint, { kind: 'orderBy' }> => c.kind === 'orderBy'
  )
  if (equality.length + range.length + orders.length <= 1) return null
  if (range.length > 1) throw new Error('Only one range field is index-compatible')

  const fields: IndexField[] = equality.map(c => ({ fieldPath: c.field, order: 'ASCENDING' }))
  if (range.length === 1) fields.push({ fieldPath: range[0].field, order: 'ASCENDING' })
  for (const order of orders) {
    fields.push({
      fieldPath: order.field,
      order: order.direction === 'desc' ? 'DESCENDING' : 'ASCENDING',
    })
  }
  return { fields, equalityCount: equality.length }
}

function declaredIndexServes(
  config: IndexConfig,
  collectionGroup: string,
  collectionScope: boolean,
  requirement: { fields: IndexField[]; equalityCount: number }
): boolean {
  return config.indexes.some(index => {
    if (index.collectionGroup !== collectionGroup) return false
    if (collectionScope && index.queryScope !== 'COLLECTION') return false
    const fields = index.fields.map(field => ({ fieldPath: field.fieldPath, order: field.order }))
    if (fields.length !== requirement.fields.length) return false

    const { equalityCount } = requirement
    const declaredEquality = fields.slice(0, equalityCount)
    if (declaredEquality.some(field => field.order !== 'ASCENDING')) return false
    const declaredNames = declaredEquality.map(field => field.fieldPath).sort().join('|')
    const requiredNames = requirement.fields
      .slice(0, equalityCount)
      .map(field => field.fieldPath)
      .sort()
      .join('|')
    if (declaredNames !== requiredNames) return false

    return fields
      .slice(equalityCount)
      .every(
        (field, offset) =>
          field.fieldPath === requirement.fields[equalityCount + offset].fieldPath &&
          field.order === requirement.fields[equalityCount + offset].order
      )
  })
}

describe('Recurring queries — index-compatible constraints and results', () => {
  const now = Date.now()
  const items = [
    recurringDoc('rec-overdue', now - 2 * DAY_MS),
    recurringDoc('rec-soon', now + 3 * DAY_MS),
    recurringDoc('rec-far', now + 30 * DAY_MS),
    recurringDoc('rec-inactive-overdue', now - 2 * DAY_MS, false),
  ]

  it('4. both query paths use isActive equality + nextDueDate range with no orderBy', async () => {
    const { service, captured } = createHarness(items)
    await service.getOverdueRecurring('test-user')
    await service.getUpcomingRecurring('test-user', 7)

    assert.equal(captured.length, 2)
    for (const query of captured) {
      assert.equal(query.path, BASE_PATH, 'recurring queries must stay in the user collection')
      const wheres = query.constraints.filter(c => c.kind === 'where')
      assert.deepEqual(
        wheres.map(c => [c.field, c.op]),
        [
          ['isActive', '=='],
          ['nextDueDate', '<='],
        ]
      )
      const orders = query.constraints.filter(c => c.kind === 'orderBy')
      assert.deepEqual(orders, [], 'an orderBy on another field would need a different index')
    }

    // Both paths must be satisfied by the declared index.
    const config = loadIndexes()
    for (const query of captured) {
      const requirement = requiredComposite(query.constraints)
      assert.ok(requirement, 'these queries need a composite index')
      assert.ok(
        declaredIndexServes(config, 'recurring', true, requirement),
        `firestore.indexes.json does not serve: ${JSON.stringify(query.constraints)}`
      )
    }
  })

  it('5. overdue query returns only active items due now or earlier', async () => {
    const { service } = createHarness(items)
    const overdue = await service.getOverdueRecurring('test-user')
    assert.deepEqual(overdue.map((item: { id: string }) => item.id), ['rec-overdue'])
  })

  it('6. upcoming query returns only active items inside the window, excluding overdue and far-future', async () => {
    const { service } = createHarness(items)
    const upcoming = await service.getUpcomingRecurring('test-user', 7)
    assert.deepEqual(upcoming.map((item: { id: string }) => item.id), ['rec-soon'])
  })

  it('7. an empty collection produces no results instead of throwing', async () => {
    const { service } = createHarness([])
    assert.deepEqual(await service.getOverdueRecurring('test-user'), [])
    assert.deepEqual(await service.getUpcomingRecurring('test-user', 7), [])
  })
})
