import { it, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as edit from '../../utils/expenseEdit.ts'
import * as deletion from '../../utils/expenseDeletion.ts'

function createCacheHarness(options?: {
  onLine?: boolean
  failWrites?: boolean
  getNow?: () => number
}) {
  let categoryGetDocsCount = 0
  let accountGetDocsCount = 0
  let pastDescGetDocsCount = 0
  let _categorySetDocCount = 0
  let _accountSetDocCount = 0
  let _transactionSetDocCount = 0

  const mockCategories = [
    { id: 'cat-1', name: 'Food & Dining', color: '#10b981', isArchived: false },
    { id: 'cat-2', name: 'Shopping', color: '#6366f1', isArchived: false },
  ]

  const mockAccounts = [
    { id: 'acc-1', name: 'Main HDFC', type: 'Bank', isDefault: true, isArchived: false },
  ]

  const mockTransactions = [
    { id: 'tx-1', description: 'Grocery Market', date: { seconds: 1000 }, amountPaise: 5000 },
    { id: 'tx-2', description: 'Coffee Shop', date: { seconds: 900 }, amountPaise: 250 },
  ]

  const eventListeners: Record<string, ((e: any) => void)[]> = {}
  const dispatchedEvents: any[] = []
  const syncSubscribers: ((e: any) => void)[] = []

  const mockWindow = {
    addEventListener: (type: string, cb: any) => {
      if (!eventListeners[type]) eventListeners[type] = []
      eventListeners[type].push(cb)
    },
    removeEventListener: (type: string, cb: any) => {
      if (!eventListeners[type]) return
      eventListeners[type] = eventListeners[type].filter(fn => fn !== cb)
    },
    dispatchEvent: (event: any) => {
      dispatchedEvents.push(event)
      if (eventListeners[event.type]) {
        for (const cb of eventListeners[event.type]) {
          cb(event)
        }
      }
    },
  }

  const exports = {} as {
    getCategories: (uid: string, forceRefresh?: boolean) => Promise<any[]>
    addCategory: (uid: string, data: any) => Promise<string>
    updateCategory: (uid: string, id: string, data: any) => Promise<void>
    getPaymentAccounts: (uid: string, forceRefresh?: boolean) => Promise<any[]>
    addPaymentAccount: (uid: string, data: any) => Promise<string>
    updatePaymentAccount: (uid: string, id: string, data: any) => Promise<void>
    getPastDescriptions: (uid: string, forceRefresh?: boolean) => Promise<string[]>
    addTransaction: (uid: string, data: any) => Promise<{ status: string; id: string }>
    deleteTransaction: (uid: string, id: string) => Promise<void>
    clearCategoryCache: (uid?: string) => void
    clearAccountCache: (uid?: string) => void
    clearPastDescriptionsCache: (uid?: string) => void
    clearMetadataCache: (uid?: string) => void
    METADATA_CACHE_TTL_MS: number
  }

  const customDate = class extends Date {
    static override now() {
      return options?.getNow ? options.getNow() : Date.now()
    }
  }

  runInNewContext(
    ts.transpileModule(readFileSync(new URL('../transactions.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
    }).outputText,
    {
      exports,
      setTimeout,
      clearTimeout,
      console,
      Date: customDate,
      window: mockWindow,
      navigator: { onLine: options?.onLine ?? true },
      CustomEvent: class {
        type: string
        detail: any
        constructor(type: string, options: any) {
          this.type = type
          this.detail = options?.detail
        }
      },
      require: (name: string) => {
        if (name === 'firebase/firestore') {
          return {
            collection: (_db: any, ...pathSegments: string[]) => {
              const collName = pathSegments[pathSegments.length - 1]
              return { _collName: collName }
            },
            doc: (_db: any, ...pathSegments: string[]) => {
              return { id: 'doc-' + Math.random().toString(36).slice(2, 7), path: pathSegments }
            },
            query: (coll: any) => coll,
            orderBy: () => ({}),
            limit: () => ({}),
            serverTimestamp: () => null,
            getDocs: async (target: any) => {
              if (target?._collName === 'categories') {
                categoryGetDocsCount++
                return { docs: mockCategories.map(c => ({ id: c.id, data: () => c })) }
              }
              if (target?._collName === 'paymentAccounts') {
                accountGetDocsCount++
                return { docs: mockAccounts.map(a => ({ id: a.id, data: () => a })) }
              }
              if (target?._collName === 'transactions') {
                pastDescGetDocsCount++
                return { docs: mockTransactions.map(t => ({ id: t.id, data: () => t })) }
              }
              return { docs: [] }
            },
            setDoc: async (ref: any, _data: any) => {
              if (options?.failWrites) {
                throw new Error('Firestore permission-denied')
              }
              if (ref?.path?.includes?.('categories') || ref?.id?.startsWith('cat')) {
                _categorySetDocCount++
              } else if (ref?.path?.includes?.('paymentAccounts') || ref?.id?.startsWith('acc')) {
                _accountSetDocCount++
              } else {
                _transactionSetDocCount++
              }
              return Promise.resolve()
            },
            runTransaction: async (_db: any, updateFn: any) => {
              if (options?.failWrites) {
                throw new Error('Firestore write-failed')
              }
              return updateFn({
                get: async () => ({
                  exists: () => true,
                  id: 'tx-1',
                  data: () => ({ id: 'tx-1', amountPaise: 5000, description: 'Test' }),
                }),
                delete: () => {},
                update: () => {},
              })
            },
          }
        }
        if (name === '@/firebase/config') return { db: {} }
        if (name === '@/services/insights') return { invalidateInsightsCache: async () => true }
        if (name === '@/utils/expenseEdit') return edit
        if (name === '@/utils/expenseDeletion') return deletion
        throw new Error(name)
      },
    }
  )

  return {
    service: exports,
    mockWindow,
    syncSubscribers,
    counts: {
      get categoryReads() { return categoryGetDocsCount },
      get accountReads() { return accountGetDocsCount },
      get pastDescReads() { return pastDescGetDocsCount },
    },
    mockCategories,
    mockAccounts,
    mockTransactions,
    dispatchedEvents,
  }
}

describe('Metadata & Description In-Memory Cache (Free-Tier Optimization)', () => {
  it('1. getCategories caches results and deduplicates concurrent in-flight requests', async () => {
    const { service, counts } = createCacheHarness()

    // Concurrent calls should be deduplicated into a single query
    const [c1, c2, c3] = await Promise.all([
      service.getCategories('user-1'),
      service.getCategories('user-1'),
      service.getCategories('user-1'),
    ])

    assert.equal(counts.categoryReads, 1, 'Only 1 Firestore query should be made for concurrent requests')
    assert.equal(c1.length, 2)
    assert.deepEqual(c1, c2)
    assert.deepEqual(c2, c3)

    // Subsequent call returns immediately from cache
    const cached = await service.getCategories('user-1')
    assert.equal(counts.categoryReads, 1, 'Subsequent call should return from cache without querying Firestore')
    assert.equal(cached.length, 2)

    // forceRefresh bypasses cache
    await service.getCategories('user-1', true)
    assert.equal(counts.categoryReads, 2, 'forceRefresh=true must query Firestore')
  })

  it('2. Category mutations immediately invalidate the category cache', async () => {
    const { service, counts } = createCacheHarness()

    await service.getCategories('user-1')
    assert.equal(counts.categoryReads, 1)

    // Adding a category clears cache
    await service.addCategory('user-1', { name: 'Health', color: '#ef4444' })

    // Next getCategories queries fresh
    await service.getCategories('user-1')
    assert.equal(counts.categoryReads, 2, 'Cache should be invalidated after addCategory')

    // Updating a category clears cache
    await service.updateCategory('user-1', 'cat-1', { name: 'Food & Drinks' })
    await service.getCategories('user-1')
    assert.equal(counts.categoryReads, 3, 'Cache should be invalidated after updateCategory')
  })

  it('3. getPaymentAccounts caches results and invalidates on account mutations', async () => {
    const { service, counts } = createCacheHarness()

    const [a1, a2] = await Promise.all([
      service.getPaymentAccounts('user-1'),
      service.getPaymentAccounts('user-1'),
    ])

    assert.equal(counts.accountReads, 1, 'Concurrent requests should deduplicate into 1 query')
    assert.equal(a1.length, 1)
    assert.deepEqual(a1, a2)

    // Cache hit
    await service.getPaymentAccounts('user-1')
    assert.equal(counts.accountReads, 1, 'Subsequent call should hit cache')

    // Adding payment account invalidates
    await service.addPaymentAccount('user-1', { name: 'SBI Card', type: 'Card', isDefault: false, isArchived: false })
    await service.getPaymentAccounts('user-1')
    assert.equal(counts.accountReads, 2, 'Cache should be invalidated after addPaymentAccount')
  })

  it('4. getPastDescriptions caches autocomplete list and invalidates on transaction changes', async () => {
    const { service, counts } = createCacheHarness()

    // Multiple opens of AddExpenseForm should not re-query 100 transactions each time
    const [d1, d2] = await Promise.all([
      service.getPastDescriptions('user-1'),
      service.getPastDescriptions('user-1'),
    ])

    assert.equal(counts.pastDescReads, 1, 'Concurrent requests should deduplicate into 1 query')
    assert.equal(d1.length, 2)
    assert.deepEqual(d1, d2)

    // Repeated open of Add Expense Form
    await service.getPastDescriptions('user-1')
    await service.getPastDescriptions('user-1')
    assert.equal(counts.pastDescReads, 1, 'Repeated drawer opens must hit memory cache (0 Firestore reads)')

    // Adding a transaction invalidates past descriptions
    await service.addTransaction('user-1', {
      amountPaise: 45000,
      description: 'New Electronics',
      categoryId: 'cat-2',
      date: new Date(),
      paymentMode: 'Cash',
      type: 'everyday',
    })

    // Next drawer open queries fresh
    await service.getPastDescriptions('user-1')
    assert.equal(counts.pastDescReads, 2, 'Cache should refresh after transaction mutation')
  })

  it('5. Global and cross-tab financial mutations correctly purge caches', async () => {
    const { service, counts, mockWindow } = createCacheHarness()

    await service.getCategories('user-1')
    await service.getPaymentAccounts('user-1')
    await service.getPastDescriptions('user-1')
    assert.equal(counts.categoryReads, 1)
    assert.equal(counts.accountReads, 1)
    assert.equal(counts.pastDescReads, 1)

    // Simulate cross-tab sync event
    mockWindow.dispatchEvent(new (class {
      type = 'spenza_financial_mutation'
      detail = { type: 'category_changed', uid: 'user-1' }
    })())

    // Category cache should be cleared, but accounts and descriptions remain cached
    await service.getCategories('user-1')
    await service.getPaymentAccounts('user-1')
    await service.getPastDescriptions('user-1')

    assert.equal(counts.categoryReads, 2, 'Category cache should have been invalidated by event')
    assert.equal(counts.accountReads, 1, 'Account cache should remain cached')
    assert.equal(counts.pastDescReads, 1, 'Past descriptions cache should remain cached')
  })

  it('6. Cache is strictly isolated by authenticated UID', async () => {
    const { service, counts } = createCacheHarness()

    // Read for user-A
    await service.getCategories('user-A')
    await service.getPaymentAccounts('user-A')
    await service.getPastDescriptions('user-A')

    assert.equal(counts.categoryReads, 1)
    assert.equal(counts.accountReads, 1)
    assert.equal(counts.pastDescReads, 1)

    // User-B queries must NOT hit User-A's cache
    await service.getCategories('user-B')
    await service.getPaymentAccounts('user-B')
    await service.getPastDescriptions('user-B')

    assert.equal(counts.categoryReads, 2, 'User-B must trigger its own category query')
    assert.equal(counts.accountReads, 2, 'User-B must trigger its own account query')
    assert.equal(counts.pastDescReads, 2, 'User-B must trigger its own past descriptions query')

    // Invalidating User-A must not clear User-B's cache
    service.clearCategoryCache('user-A')
    await service.getCategories('user-B')
    assert.equal(counts.categoryReads, 2, 'User-B category cache must survive User-A clearing')

    await service.getCategories('user-A')
    assert.equal(counts.categoryReads, 3, 'User-A must re-query after being cleared')
  })

  it('7. In-memory cache entries expire after METADATA_CACHE_TTL_MS to prevent multi-device staleness', async () => {
    let virtualTime = 1_000_000
    const { service, counts } = createCacheHarness({ getNow: () => virtualTime })

    await service.getCategories('user-1')
    await service.getPaymentAccounts('user-1')
    await service.getPastDescriptions('user-1')
    assert.equal(counts.categoryReads, 1)
    assert.equal(counts.accountReads, 1)
    assert.equal(counts.pastDescReads, 1)

    // Within TTL (e.g. +2 minutes)
    virtualTime += 2 * 60 * 1000
    await service.getCategories('user-1')
    await service.getPaymentAccounts('user-1')
    await service.getPastDescriptions('user-1')
    assert.equal(counts.categoryReads, 1, 'Within TTL must hit cache')
    assert.equal(counts.accountReads, 1, 'Within TTL must hit cache')
    assert.equal(counts.pastDescReads, 1, 'Within TTL must hit cache')

    // Advance beyond 5-minute TTL (e.g. +4 minutes more, total +6 minutes)
    virtualTime += 4 * 60 * 1000
    await service.getCategories('user-1')
    await service.getPaymentAccounts('user-1')
    await service.getPastDescriptions('user-1')
    assert.equal(counts.categoryReads, 2, 'Expired category cache must query fresh')
    assert.equal(counts.accountReads, 2, 'Expired account cache must query fresh')
    assert.equal(counts.pastDescReads, 2, 'Expired description cache must query fresh')
  })

  it('8. Sign-out / clearMetadataCache purges all cached metadata across all UIDs', async () => {
    const { service, counts } = createCacheHarness()

    await service.getCategories('user-1')
    await service.getCategories('user-2')
    await service.getPaymentAccounts('user-1')
    await service.getPastDescriptions('user-1')
    assert.equal(counts.categoryReads, 2)
    assert.equal(counts.accountReads, 1)
    assert.equal(counts.pastDescReads, 1)

    // Calling clearMetadataCache() without args (sign-out behavior)
    service.clearMetadataCache()

    // All caches should be empty
    await service.getCategories('user-1')
    await service.getCategories('user-2')
    await service.getPaymentAccounts('user-1')
    await service.getPastDescriptions('user-1')
    assert.equal(counts.categoryReads, 4, 'All categories must re-query after global clear')
    assert.equal(counts.accountReads, 2, 'All accounts must re-query after global clear')
    assert.equal(counts.pastDescReads, 2, 'All past descriptions must re-query after global clear')
  })

  it('9. Failed Firestore writes do not mutate or populate in-memory metadata cache', async () => {
    const { service, counts } = createCacheHarness({ failWrites: true })

    // Populate initial cache
    await service.getCategories('user-1')
    assert.equal(counts.categoryReads, 1)

    // Attempting a failing category write must reject
    await assert.rejects(
      () => service.addCategory('user-1', { name: 'Invalid Cat', color: '#000000' }),
      /Firestore permission-denied/
    )

    // Cache must remain untouched and not wiped or corrupted with phantom entity
    const cats = await service.getCategories('user-1')
    assert.equal(counts.categoryReads, 1, 'Failed write should not clear valid cache')
    assert.equal(cats.some((c: any) => c.name === 'Invalid Cat'), false)
  })

  it('10. Offline expense creation returns pending status immediately without artificial 2s delay', async () => {
    const { service } = createCacheHarness({ onLine: false })

    const startTime = Date.now()
    const result = await service.addTransaction('user-1', {
      amountPaise: 2500,
      description: 'Quick Offline Chai',
      categoryId: 'cat-1',
      date: new Date(),
      paymentMode: 'Cash',
      type: 'everyday',
    })
    const elapsed = Date.now() - startTime

    assert.equal(result.status, 'pending')
    assert.ok(elapsed < 1000, `Offline transaction returned in ${elapsed}ms, expected < 1000ms`)
  })

  it('11. Cross-tab BroadcastChannel remote events purge cache in receiving tabs', async () => {
    const { service, counts, mockWindow } = createCacheHarness()

    await service.getCategories('user-1')
    await service.getPaymentAccounts('user-1')
    await service.getPastDescriptions('user-1')
    assert.equal(counts.categoryReads, 1)
    assert.equal(counts.accountReads, 1)
    assert.equal(counts.pastDescReads, 1)

    // Deliver broadcast from another tab via remote window event
    mockWindow.dispatchEvent(new (class {
      type = 'spenza_financial_mutation'
      detail = { type: 'account_changed', uid: 'user-1', _remote: true }
    })())
    mockWindow.dispatchEvent(new (class {
      type = 'spenza_financial_mutation'
      detail = { type: 'transaction_created', uid: 'user-1', _remote: true }
    })())

    // Accounts and past descriptions must now re-query, categories stay cached
    await service.getCategories('user-1')
    await service.getPaymentAccounts('user-1')
    await service.getPastDescriptions('user-1')

    assert.equal(counts.categoryReads, 1, 'Category cache stayed valid')
    assert.equal(counts.accountReads, 2, 'Account cache invalidated by BroadcastChannel event')
    assert.equal(counts.pastDescReads, 2, 'Past descriptions invalidated by BroadcastChannel event')
  })
})
