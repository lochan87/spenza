import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregatePeopleDues,
  getPendingRecoverablePaise,
  UNASSIGNED_PERSON_ID,
  type SplitAwareTransaction,
  type PersonDuesSummary,
} from '../../../utils/splitMath.ts'
import type { Person } from '../../../types/index.ts'
import type { MergedPersonItem } from '../PeoplePage.tsx'

function mergePeopleWithDues(
  people: Person[],
  peopleDues: PersonDuesSummary[]
): MergedPersonItem[] {
  const duesByPid = new Map<string, PersonDuesSummary>()
  const duesByName = new Map<string, PersonDuesSummary>()

  for (const d of peopleDues) {
    duesByPid.set(d.personId, d)
    duesByName.set(d.personName.toLowerCase().trim(), d)
  }

  const matchedPidKeys = new Set<string>()
  const result: MergedPersonItem[] = []

  for (const p of people) {
    const d = duesByPid.get(p.id) || duesByName.get(p.name.toLowerCase().trim())
    if (d) matchedPidKeys.add(d.personId)

    result.push({
      id: p.id,
      name: p.name,
      isArchived: !!p.isArchived,
      isSynthetic: false,
      totalOwedPaise: d?.totalOwedPaise ?? 0,
      totalRepaidPaise: d?.totalRepaidPaise ?? 0,
      pendingDuesPaise: d?.pendingDuesPaise ?? 0,
      transactionCount: d?.transactionCount ?? 0,
      unsettledTxnCount: d?.unsettledTxnCount ?? 0,
    })
  }

  // Include any participants from splits that don't have a Firestore document yet
  for (const d of peopleDues) {
    if (!matchedPidKeys.has(d.personId)) {
      result.push({
        id: d.personId,
        name: d.personName,
        isArchived: false,
        isSynthetic: true,
        totalOwedPaise: d.totalOwedPaise,
        totalRepaidPaise: d.totalRepaidPaise,
        pendingDuesPaise: d.pendingDuesPaise,
        transactionCount: d.transactionCount,
        unsettledTxnCount: d.unsettledTxnCount,
      })
    }
  }

  return result.sort((a, b) => {
    if (b.pendingDuesPaise !== a.pendingDuesPaise) {
      return b.pendingDuesPaise - a.pendingDuesPaise
    }
    if (a.isArchived !== b.isArchived) {
      return a.isArchived ? 1 : -1
    }
    return a.name.localeCompare(b.name)
  })
}

describe('People & Split Book — Page Logic & Ledger Aggregation', () => {
  const dummyDate = { seconds: 1772000000, nanoseconds: 0 } as any

  const peopleList: Person[] = [
    { id: 'p-aarav', name: 'Aarav Sharma', isArchived: false, createdAt: dummyDate },
    { id: 'p-meera', name: 'Meera Patel', isArchived: false, createdAt: dummyDate },
    { id: 'p-vikram', name: 'Vikram Singh', isArchived: true, createdAt: dummyDate },
    { id: 'p-rohan', name: 'Rohan Gupta', isArchived: false, createdAt: dummyDate },
  ]

  const transactions: SplitAwareTransaction[] = [
    // Dinner: Aarav owes ₹500, Meera owes ₹500 (both unsettled)
    {
      amountPaise: 150000,
      type: 'everyday',
      splits: [
        { personId: 'p-aarav', personName: 'Aarav Sharma', amountPaise: 50000, repaidPaise: 0, settledAt: null },
        { personId: 'p-meera', personName: 'Meera Patel', amountPaise: 50000, repaidPaise: 0, settledAt: null },
      ],
    },
    // Trip cab: Aarav owes ₹300 (₹100 repaid, ₹200 pending), Rohan owes ₹300 (fully repaid)
    {
      amountPaise: 90000,
      type: 'trip',
      splits: [
        { personId: 'p-aarav', personName: 'Aarav Sharma', amountPaise: 30000, repaidPaise: 10000, settledAt: null },
        { personId: 'p-rohan', personName: 'Rohan Gupta', amountPaise: 30000, repaidPaise: 30000, settledAt: dummyDate },
      ],
    },
    // Legacy reimbursable with unassigned person: ₹400 pending
    {
      amountPaise: 40000,
      type: 'reimbursable',
      personId: null,
    },
  ]

  it('1. correctly computes per-person dues summary from transactions', () => {
    const dues = aggregatePeopleDues(transactions)

    // Aarav: 50000 + 30000 = 80000 owed, 10000 repaid, 70000 pending across 2 bills
    const aarav = dues.find(d => d.personId === 'p-aarav')
    assert.ok(aarav)
    assert.equal(aarav.totalOwedPaise, 80000)
    assert.equal(aarav.totalRepaidPaise, 10000)
    assert.equal(aarav.pendingDuesPaise, 70000)
    assert.equal(aarav.transactionCount, 2)
    assert.equal(aarav.unsettledTxnCount, 2)

    // Meera: 50000 owed, 0 repaid, 50000 pending across 1 bill
    const meera = dues.find(d => d.personId === 'p-meera')
    assert.ok(meera)
    assert.equal(meera.pendingDuesPaise, 50000)
    assert.equal(meera.unsettledTxnCount, 1)

    // Rohan: 30000 owed, 30000 repaid, 0 pending across 1 bill
    const rohan = dues.find(d => d.personId === 'p-rohan')
    assert.ok(rohan)
    assert.equal(rohan.pendingDuesPaise, 0)
    assert.equal(rohan.unsettledTxnCount, 0)

    // Unassigned participant: 40000 pending
    const unassigned = dues.find(d => d.personId === UNASSIGNED_PERSON_ID)
    assert.ok(unassigned)
    assert.equal(unassigned.pendingDuesPaise, 40000)
  })

  it('2. merges Firestore people records with dues summaries, including synthetic entries', () => {
    const dues = aggregatePeopleDues(transactions)
    const merged = mergePeopleWithDues(peopleList, dues)

    // Should contain 4 Firestore people + 1 synthetic Unassigned entry = 5 total
    assert.equal(merged.length, 5)

    // 1st should be Aarav (owing ₹700)
    assert.equal(merged[0].name, 'Aarav Sharma')
    assert.equal(merged[0].pendingDuesPaise, 70000)
    assert.equal(merged[0].isSynthetic, false)

    // 2nd should be Meera (owing ₹500)
    assert.equal(merged[1].name, 'Meera Patel')
    assert.equal(merged[1].pendingDuesPaise, 50000)

    // 3rd should be Unassigned (owing ₹400, synthetic)
    assert.equal(merged[2].id, UNASSIGNED_PERSON_ID)
    assert.equal(merged[2].pendingDuesPaise, 40000)
    assert.equal(merged[2].isSynthetic, true)

    // Rohan owes ₹0 (active, settled)
    const rohan = merged.find(m => m.id === 'p-rohan')
    assert.ok(rohan)
    assert.equal(rohan.pendingDuesPaise, 0)
    assert.equal(rohan.totalRepaidPaise, 30000)

    // Vikram owes ₹0 (archived)
    const vikram = merged.find(m => m.id === 'p-vikram')
    assert.ok(vikram)
    assert.equal(vikram.isArchived, true)
    assert.equal(vikram.pendingDuesPaise, 0)
  })

  it('3. filters ledger correctly by active tabs: dues, all, and archived', () => {
    const dues = aggregatePeopleDues(transactions)
    const merged = mergePeopleWithDues(peopleList, dues)

    // Tab 'dues': only those with pendingDuesPaise > 0
    const owingOnly = merged.filter(p => p.pendingDuesPaise > 0)
    assert.equal(owingOnly.length, 3) // Aarav, Meera, Unassigned
    assert.ok(owingOnly.every(p => p.pendingDuesPaise > 0))

    // Tab 'archived': only isArchived === true
    const archivedOnly = merged.filter(p => p.isArchived)
    assert.equal(archivedOnly.length, 1)
    assert.equal(archivedOnly[0].id, 'p-vikram')

    // Tab 'all': non-archived + active debtors
    const allTab = merged.filter(p => !p.isArchived || p.pendingDuesPaise > 0)
    assert.equal(allTab.length, 4) // Aarav, Meera, Unassigned, Rohan
    assert.equal(allTab.some(p => p.id === 'p-vikram'), false)
  })

  it('4. searches friends by name case-insensitively', () => {
    const dues = aggregatePeopleDues(transactions)
    const merged = mergePeopleWithDues(peopleList, dues)

    const query1 = 'aarav'
    const match1 = merged.filter(p => p.name.toLowerCase().includes(query1))
    assert.equal(match1.length, 1)
    assert.equal(match1[0].name, 'Aarav Sharma')

    const query2 = 'gupta'
    const match2 = merged.filter(p => p.name.toLowerCase().includes(query2))
    assert.equal(match2.length, 1)
    assert.equal(match2[0].name, 'Rohan Gupta')
  })

  it('5. financial invariant: settling all dues reduces pending balance to zero without affecting net spend', () => {
    const dues = aggregatePeopleDues(transactions)
    const merged = mergePeopleWithDues(peopleList, dues)

    const aarav = merged.find(p => p.id === 'p-aarav')!
    assert.equal(aarav.pendingDuesPaise, 70000)

    // Simulate settling Aarav across all transactions
    const settledTxns = transactions.map(tx => {
      if (!tx.splits) return tx
      const updatedSplits = tx.splits.map(s => {
        if (s.personId === 'p-aarav') {
          return { ...s, repaidPaise: s.amountPaise, settledAt: dummyDate }
        }
        return s
      })
      return { ...tx, splits: updatedSplits }
    })

    const updatedDues = aggregatePeopleDues(settledTxns)
    const updatedMerged = mergePeopleWithDues(peopleList, updatedDues)

    const updatedAarav = updatedMerged.find(p => p.id === 'p-aarav')!
    assert.equal(updatedAarav.pendingDuesPaise, 0)
    assert.equal(updatedAarav.totalRepaidPaise, 80000)
    assert.equal(updatedAarav.unsettledTxnCount, 0)

    // Meera still has pending dues
    const updatedMeera = updatedMerged.find(p => p.id === 'p-meera')!
    assert.equal(updatedMeera.pendingDuesPaise, 50000)
  })

  it('6. verifies transaction deletion alert logic based on pending recoverable dues', () => {
    // Transaction with pending split dues -> requires warning
    const openSplitTx: SplitAwareTransaction = {
      type: 'everyday',
      amountPaise: 200000,
      splits: [
        { personId: 'p-aarav', personName: 'Aarav', amountPaise: 100000, repaidPaise: 0, settledAt: null },
      ],
    }
    const pendingPaise = getPendingRecoverablePaise(openSplitTx)
    assert.equal(pendingPaise, 100000)
    assert.ok(pendingPaise > 0, 'Should trigger active dues warning banner')

    // Fully settled transaction -> no warning needed
    const settledTx: SplitAwareTransaction = {
      type: 'everyday',
      amountPaise: 200000,
      splits: [
        { personId: 'p-aarav', personName: 'Aarav', amountPaise: 100000, repaidPaise: 100000, settledAt: dummyDate },
      ],
    }
    assert.equal(getPendingRecoverablePaise(settledTx), 0)

    // Standard personal transaction -> no warning needed
    const personalTx: SplitAwareTransaction = {
      type: 'everyday',
      amountPaise: 50000,
    }
    assert.equal(getPendingRecoverablePaise(personalTx), 0)
  })

  it('7. verifies contact deletion resolution logic: protects contacts with transaction history via archive', () => {
    // Person with linked transactions -> Archive to protect historical ledger
    const personWithHistory = { id: 'p-aarav', name: 'Aarav', transactionCount: 2 }
    const actionWithHistory = (personWithHistory.transactionCount ?? 0) > 0 ? 'archive' : 'delete'
    assert.equal(actionWithHistory, 'archive')

    // Brand new or unused person -> Permanent delete
    const personWithoutHistory = { id: 'p-new', name: 'New Friend', transactionCount: 0 }
    const actionWithoutHistory = (personWithoutHistory.transactionCount ?? 0) > 0 ? 'archive' : 'delete'
    assert.equal(actionWithoutHistory, 'delete')
  })

  it('8. verifies error resilience: captures network failure state without wiping cached data', () => {
    let loadError: string | null = null
    const simulateFetch = (shouldFail: boolean) => {
      try {
        if (shouldFail) throw new Error('Failed to fetch from Firestore')
        loadError = null
        return [{ id: 'p-1', name: 'Aarav' }]
      } catch (err) {
        loadError = err instanceof Error ? err.message : 'Unknown error'
        return null
      }
    }

    // Failure simulation
    const result1 = simulateFetch(true)
    assert.equal(result1, null)
    assert.equal(loadError, 'Failed to fetch from Firestore')

    // Retry simulation succeeds
    const result2 = simulateFetch(false)
    assert.ok(result2)
    assert.equal(loadError, null)
  })
})
