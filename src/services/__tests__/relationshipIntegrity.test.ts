import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as helpers from '../../utils/expenseDeletion.ts'
import * as editHelpers from '../../utils/expenseEdit.ts'
import * as splitMath from '../../utils/splitMath.ts'
import * as schemas from '../../utils/schemas.ts'

// Transpile service sources for VM testing with in-memory stores
const tripsSource = readFileSync(new URL('../trips.ts', import.meta.url), 'utf8')
const tripsCompiled = ts.transpileModule(tripsSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText

const peopleSource = readFileSync(new URL('../people.ts', import.meta.url), 'utf8')
const peopleCompiled = ts.transpileModule(peopleSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText

const txSource = readFileSync(new URL('../transactions.ts', import.meta.url), 'utf8')
const txCompiled = ts.transpileModule(txSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
}).outputText

interface MemoryStore {
  trips: Map<string, any>
  people: Map<string, any>
  transactions: Map<string, any>
  paymentAccounts: Map<string, any>
  categories: Map<string, any>
  recurring: Map<string, any>
  budgets: Map<string, any>
}

function createMemoryStore(): MemoryStore {
  return {
    trips: new Map(),
    people: new Map(),
    transactions: new Map(),
    paymentAccounts: new Map(),
    categories: new Map(),
    recurring: new Map(),
    budgets: new Map(),
  }
}

function createFirestoreMock(store: MemoryStore) {
  const getCollMap = (collName: string): Map<string, any> => {
    if (collName === 'trips') return store.trips
    if (collName === 'people') return store.people
    if (collName === 'transactions') return store.transactions
    if (collName === 'paymentAccounts') return store.paymentAccounts
    if (collName === 'categories') return store.categories
    if (collName === 'recurring') return store.recurring
    if (collName === 'budgets') return store.budgets
    throw new Error(`Unknown collection: ${collName}`)
  }

  return {
    collection: (_db: unknown, ...segments: string[]) => {
      // Expect users/{uid}/{collName}
      const collName = segments[segments.length - 1]
      return { type: 'coll', collName, uid: segments[1] }
    },
    doc: (_dbOrColl: unknown, ...segments: string[]) => {
      if (segments.length === 1 && typeof _dbOrColl === 'object' && (_dbOrColl as any).type === 'coll') {
        const coll = _dbOrColl as any
        const docId = segments[0] || `auto-${Math.random().toString(36).slice(2, 9)}`
        return { type: 'doc', collName: coll.collName, id: docId }
      }
      // users/{uid}/{collName}/{docId}
      const collName = segments[segments.length - 2]
      const docId = segments[segments.length - 1]
      return { type: 'doc', collName, id: docId }
    },
    getDoc: async (ref: any) => {
      const map = getCollMap(ref.collName)
      const data = map.get(ref.id)
      return {
        exists: () => !!data,
        id: ref.id,
        data: () => (data ? structuredClone(data) : undefined),
      }
    },
    getDocs: async (target: any) => {
      const collName = target.collName || target.ref?.collName
      const map = getCollMap(collName)
      let docs = Array.from(map.entries()).map(([id, d]) => ({
        id,
        data: () => structuredClone(d),
      }))

      if (target.type === 'query' && target.clauses) {
        for (const clause of target.clauses) {
          if (clause.op === '==') {
            docs = docs.filter(d => (d.data() as any)[clause.field] === clause.value)
          } else if (clause.op === '!=') {
            docs = docs.filter(d => (d.data() as any)[clause.field] !== clause.value)
          }
        }
      }

      return {
        empty: docs.length === 0,
        size: docs.length,
        docs,
      }
    },
    setDoc: async (ref: any, data: any, options?: { merge?: boolean }) => {
      const map = getCollMap(ref.collName)
      const existing = map.get(ref.id) || {}
      if (options?.merge) {
        map.set(ref.id, { ...existing, ...data })
      } else {
        map.set(ref.id, { ...data, id: ref.id })
      }
    },
    deleteDoc: async (ref: any) => {
      const map = getCollMap(ref.collName)
      map.delete(ref.id)
    },
    query: (collRef: any, ...clauses: any[]) => {
      return {
        type: 'query',
        collName: collRef.collName,
        ref: collRef,
        clauses: clauses.filter(c => c && c.type === 'where'),
      }
    },
    where: (field: string, op: string, value: any) => ({
      type: 'where',
      field,
      op,
      value,
    }),
    orderBy: () => ({ type: 'orderBy' }),
    serverTimestamp: () => ({ _serverTimestamp: true }),
    Timestamp: {
      now: () => ({ toDate: () => new Date() }),
      fromDate: (d: Date) => ({ toDate: () => d }),
    },
  }
}

describe('Financial Relationship Integrity & Safe Archival', () => {
  describe('Trip relationship integrity', () => {
    function loadTripsService(store: MemoryStore, offline = false) {
      const exports = {} as any
      const sdk = createFirestoreMock(store)
      runInNewContext(tripsCompiled, {
        exports,
        navigator: { onLine: !offline },
        window: { dispatchEvent: () => {} },
        CustomEvent: class {},
        Date,
        Error,
        require: (name: string) => {
          if (name === 'firebase/firestore') return sdk
          if (name === '@/firebase/config') return { db: {} }
          throw new Error(`Unexpected import: ${name}`)
        },
      })
      return exports
    }

    it('rejects trip deletion while offline', async () => {
      const store = createMemoryStore()
      store.trips.set('trip-1', { id: 'trip-1', name: 'Goa', isArchived: false })
      const tripsService = loadTripsService(store, true)

      await assert.rejects(
        tripsService.deleteTrip('user-1', 'trip-1'),
        /Cannot delete trip while offline/
      )
      assert.equal(store.trips.has('trip-1'), true)
    })

    it('safely archives trip instead of deleting when transactions reference it', async () => {
      const store = createMemoryStore()
      store.trips.set('trip-1', { id: 'trip-1', name: 'Goa', isArchived: false })
      store.transactions.set('tx-1', {
        id: 'tx-1',
        tripId: 'trip-1',
        amountPaise: 50000,
        description: 'Flight',
      })
      const tripsService = loadTripsService(store, false)

      const result = await tripsService.deleteTrip('user-1', 'trip-1')
      assert.equal(result.deleted, false)
      assert.equal(result.archived, true)

      // Trip doc is preserved in Firestore with isArchived: true
      const trip = store.trips.get('trip-1')
      assert.ok(trip)
      assert.equal(trip.isArchived, true)
      // Transaction still references the trip
      assert.equal(store.transactions.get('tx-1').tripId, 'trip-1')
    })

    it('hard-deletes trip doc when no transactions reference it', async () => {
      const store = createMemoryStore()
      store.trips.set('trip-empty', { id: 'trip-empty', name: 'Empty Trip', isArchived: false })
      const tripsService = loadTripsService(store, false)

      const result = await tripsService.deleteTrip('user-1', 'trip-empty')
      assert.equal(result.deleted, true)
      assert.equal(result.archived, false)
      assert.equal(store.trips.has('trip-empty'), false)
    })
  })

  describe('Person relationship integrity', () => {
    function loadPeopleService(store: MemoryStore, offline = false) {
      const exports = {} as any
      const sdk = createFirestoreMock(store)
      runInNewContext(peopleCompiled, {
        exports,
        navigator: { onLine: !offline },
        window: { dispatchEvent: () => {} },
        CustomEvent: class {},
        Date,
        Error,
        require: (name: string) => {
          if (name === 'firebase/firestore') return sdk
          if (name === '@/firebase/config') return { db: {} }
          if (name === '@/utils/schemas') return schemas
          if (name === '@/utils/splitMath') return splitMath
          if (name === 'firebase/functions') return { getFunctions: () => ({}), httpsCallable: () => () => ({}) }
          throw new Error(`Unexpected import: ${name}`)
        },
      })
      return exports
    }

    it('rejects person deletion while offline', async () => {
      const store = createMemoryStore()
      store.people.set('alice', { id: 'alice', name: 'Alice', isArchived: false })
      const peopleService = loadPeopleService(store, true)

      await assert.rejects(
        peopleService.deletePerson('user-1', 'alice'),
        /Cannot delete person while offline/
      )
      assert.equal(store.people.has('alice'), true)
    })

    it('safely archives person when referenced by transaction personId', async () => {
      const store = createMemoryStore()
      store.people.set('alice', { id: 'alice', name: 'Alice', isArchived: false })
      store.transactions.set('tx-1', {
        id: 'tx-1',
        personId: 'alice',
        amountPaise: 2000,
      })
      const peopleService = loadPeopleService(store, false)

      const res = await peopleService.deletePerson('user-1', 'alice')
      assert.equal(res.deleted, false)
      assert.equal(res.archived, true)
      assert.equal(store.people.get('alice').isArchived, true)
    })

    it('safely archives person when referenced in split participant list', async () => {
      const store = createMemoryStore()
      store.people.set('bob', { id: 'bob', name: 'Bob', isArchived: false })
      store.transactions.set('tx-2', {
        id: 'tx-2',
        amountPaise: 10000,
        splits: [{ personId: 'bob', personName: 'Bob', amountPaise: 5000, repaidPaise: 0 }],
      })
      const peopleService = loadPeopleService(store, false)

      const res = await peopleService.deletePerson('user-1', 'bob')
      assert.equal(res.deleted, false)
      assert.equal(res.archived, true)
      assert.equal(store.people.get('bob').isArchived, true)
    })

    it('safely archives person when referenced in legacy unassigned split by name', async () => {
      const store = createMemoryStore()
      store.people.set('charlie-id', { id: 'charlie-id', name: 'Charlie', isArchived: false })
      store.transactions.set('tx-3', {
        id: 'tx-3',
        amountPaise: 6000,
        splits: [
          { personId: splitMath.UNASSIGNED_PERSON_ID, personName: 'Charlie', amountPaise: 3000, repaidPaise: 0 },
        ],
      })
      const peopleService = loadPeopleService(store, false)

      const res = await peopleService.deletePerson('user-1', 'charlie-id')
      assert.equal(res.deleted, false)
      assert.equal(res.archived, true)
      assert.equal(store.people.get('charlie-id').isArchived, true)
    })

    it('safely archives person when referenced in legacy top-level personName', async () => {
      const store = createMemoryStore()
      store.people.set('dave-id', { id: 'dave-id', name: 'Dave', isArchived: false })
      store.transactions.set('tx-4', {
        id: 'tx-4',
        amountPaise: 4000,
        personName: 'Dave',
      })
      const peopleService = loadPeopleService(store, false)

      const res = await peopleService.deletePerson('user-1', 'dave-id')
      assert.equal(res.deleted, false)
      assert.equal(res.archived, true)
      assert.equal(store.people.get('dave-id').isArchived, true)
    })

    it('hard-deletes person when no references exist', async () => {
      const store = createMemoryStore()
      store.people.set('stranger', { id: 'stranger', name: 'Stranger', isArchived: false })
      const peopleService = loadPeopleService(store, false)

      const res = await peopleService.deletePerson('user-1', 'stranger')
      assert.equal(res.deleted, true)
      assert.equal(res.archived, false)
      assert.equal(store.people.has('stranger'), false)
    })
  })

  describe('Payment account & Category integrity', () => {
    function loadTxService(store: MemoryStore, offline = false) {
      const exports = {} as any
      const sdk = createFirestoreMock(store)
      runInNewContext(txCompiled, {
        exports,
        navigator: { onLine: !offline },
        window: { dispatchEvent: () => {} },
        CustomEvent: class {},
        Date,
        Error,
        require: (name: string) => {
          if (name === 'firebase/firestore') return sdk
          if (name === '@/firebase/config') return { db: {} }
          if (name === '@/utils/expenseDeletion') return helpers
          if (name === '@/utils/expenseEdit') return editHelpers
          if (name === '@/services/insights') return { invalidateInsightsCache: async () => true }
          throw new Error(`Unexpected import: ${name}`)
        },
      })
      return exports
    }

    it('rejects payment account deletion while offline', async () => {
      const store = createMemoryStore()
      store.paymentAccounts.set('acc-1', { id: 'acc-1', name: 'HDFC', isArchived: false })
      const txService = loadTxService(store, true)

      await assert.rejects(
        txService.deletePaymentAccount('user-1', 'acc-1'),
        /Cannot delete payment account while offline/
      )
      assert.equal(store.paymentAccounts.has('acc-1'), true)
    })

    it('safely archives payment account and clears isDefault when referenced by transactions', async () => {
      const store = createMemoryStore()
      store.paymentAccounts.set('acc-1', { id: 'acc-1', name: 'HDFC', isDefault: true, isArchived: false })
      store.transactions.set('tx-1', {
        id: 'tx-1',
        paymentAccountId: 'acc-1',
        paymentMode: 'Bank Transfer',
        amountPaise: 15000,
      })
      const txService = loadTxService(store, false)

      const res = await txService.deletePaymentAccount('user-1', 'acc-1')
      assert.equal(res.deleted, false)
      assert.equal(res.archived, true)

      const acc = store.paymentAccounts.get('acc-1')
      assert.equal(acc.isArchived, true)
      assert.equal(acc.isDefault, false)
    })

    it('safely archives payment account when referenced by recurring items', async () => {
      const store = createMemoryStore()
      store.paymentAccounts.set('acc-2', { id: 'acc-2', name: 'ICICI', isDefault: false, isArchived: false })
      store.recurring.set('rec-1', {
        id: 'rec-1',
        paymentAccountId: 'acc-2',
        amountPaise: 100000,
      })
      const txService = loadTxService(store, false)

      const res = await txService.deletePaymentAccount('user-1', 'acc-2')
      assert.equal(res.deleted, false)
      assert.equal(res.archived, true)
      assert.equal(store.paymentAccounts.get('acc-2').isArchived, true)
    })

    it('hard-deletes unreferenced payment account', async () => {
      const store = createMemoryStore()
      store.paymentAccounts.set('acc-unused', { id: 'acc-unused', name: 'Old Bank', isArchived: false })
      const txService = loadTxService(store, false)

      const res = await txService.deletePaymentAccount('user-1', 'acc-unused')
      assert.equal(res.deleted, true)
      assert.equal(res.archived, false)
      assert.equal(store.paymentAccounts.has('acc-unused'), false)
    })

    it('archivePaymentAccount clears isDefault when archiving', async () => {
      const store = createMemoryStore()
      store.paymentAccounts.set('acc-def', { id: 'acc-def', name: 'Main', isDefault: true, isArchived: false })
      const txService = loadTxService(store, false)

      await txService.archivePaymentAccount('user-1', 'acc-def', true)
      const acc = store.paymentAccounts.get('acc-def')
      assert.equal(acc.isArchived, true)
      assert.equal(acc.isDefault, false)
    })

    it('safely archives category when referenced by transactions', async () => {
      const store = createMemoryStore()
      store.categories.set('cat-food', { id: 'cat-food', name: 'Food', isArchived: false })
      store.transactions.set('tx-1', { id: 'tx-1', categoryId: 'cat-food', amountPaise: 500 })
      const txService = loadTxService(store, false)

      const res = await txService.deleteCategory('user-1', 'cat-food')
      assert.equal(res.deleted, false)
      assert.equal(res.archived, true)
      assert.equal(store.categories.get('cat-food').isArchived, true)
    })

    it('safely archives category when referenced by recurring items', async () => {
      const store = createMemoryStore()
      store.categories.set('cat-sub', { id: 'cat-sub', name: 'Subscriptions', isArchived: false })
      store.recurring.set('rec-1', { id: 'rec-1', categoryId: 'cat-sub', amountPaise: 49900 })
      const txService = loadTxService(store, false)

      const res = await txService.deleteCategory('user-1', 'cat-sub')
      assert.equal(res.deleted, false)
      assert.equal(res.archived, true)
      assert.equal(store.categories.get('cat-sub').isArchived, true)
    })

    it('safely archives category when referenced by monthly budget', async () => {
      const store = createMemoryStore()
      store.categories.set('cat-rent', { id: 'cat-rent', name: 'Rent', isArchived: false })
      store.budgets.set('2026-11', {
        id: '2026-11',
        totalBudgetPaise: 1000000,
        categoryBudgets: { 'cat-rent': 500000 },
      })
      const txService = loadTxService(store, false)

      const res = await txService.deleteCategory('user-1', 'cat-rent')
      assert.equal(res.deleted, false)
      assert.equal(res.archived, true)
      assert.equal(store.categories.get('cat-rent').isArchived, true)
    })

    it('hard-deletes unreferenced category', async () => {
      const store = createMemoryStore()
      store.categories.set('cat-temp', { id: 'cat-temp', name: 'Temp', isArchived: false })
      const txService = loadTxService(store, false)

      const res = await txService.deleteCategory('user-1', 'cat-temp')
      assert.equal(res.deleted, true)
      assert.equal(res.archived, false)
      assert.equal(store.categories.has('cat-temp'), false)
    })
  })
})
