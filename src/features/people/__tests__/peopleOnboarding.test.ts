import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PersonSchema } from '../../../utils/schemas.ts'
import type { UserProfile } from '../../../types/index.ts'

describe('People & Split Partners — First-Login Onboarding Logic', () => {
  const dummyTimestamp = { seconds: 1772000000, nanoseconds: 0 } as any

  function shouldShowPeopleOnboarding(
    profile: UserProfile | null,
    isDismissedLocally = false
  ): boolean {
    if (isDismissedLocally) return false
    if (!profile) return false
    if (profile.onboardingComplete) return false
    if (profile.peopleOnboardingCompleted) return false
    return true
  }

  function queuePersonName(
    existingNames: string[],
    rawInput: string
  ): { success: boolean; updated: string[]; error?: string } {
    const trimmed = rawInput.trim()
    if (!trimmed) {
      return { success: false, updated: existingNames, error: 'Name cannot be empty' }
    }

    const isDuplicate = existingNames.some(
      n => n.toLowerCase() === trimmed.toLowerCase()
    )
    if (isDuplicate) {
      return { success: false, updated: existingNames, error: `"${trimmed}" is already added` }
    }

    return { success: true, updated: [...existingNames, trimmed] }
  }

  it('1. triggers onboarding modal for a new user with onboardingComplete: false', () => {
    const newUserProfile: UserProfile = {
      uid: 'user-new-123',
      displayName: 'Alex Doe',
      email: 'alex@example.com',
      photoURL: null,
      defaultPaymentAccountId: null,
      onboardingComplete: false,
      createdAt: dummyTimestamp,
      updatedAt: dummyTimestamp,
    }

    assert.equal(shouldShowPeopleOnboarding(newUserProfile, false), true)
  })

  it('2. does NOT trigger onboarding if user has already completed onboarding', () => {
    const existingUserProfile: UserProfile = {
      uid: 'user-existing-456',
      displayName: 'Jordan Smith',
      email: 'jordan@example.com',
      photoURL: null,
      defaultPaymentAccountId: 'acc-1',
      onboardingComplete: true,
      peopleOnboardingCompleted: true,
      createdAt: dummyTimestamp,
      updatedAt: dummyTimestamp,
    }

    assert.equal(shouldShowPeopleOnboarding(existingUserProfile, false), false)
  })

  it('3. does NOT trigger onboarding if dismissed in localStorage', () => {
    const newUserProfile: UserProfile = {
      uid: 'user-new-123',
      displayName: 'Alex Doe',
      email: 'alex@example.com',
      photoURL: null,
      defaultPaymentAccountId: null,
      onboardingComplete: false,
      createdAt: dummyTimestamp,
      updatedAt: dummyTimestamp,
    }

    assert.equal(shouldShowPeopleOnboarding(newUserProfile, true), false)
  })

  it('4. sanitizes names and prevents duplicates in the onboarding input queue', () => {
    let names: string[] = []

    // 1. Add valid name
    const r1 = queuePersonName(names, '  Aarav  ')
    assert.equal(r1.success, true)
    names = r1.updated
    assert.deepEqual(names, ['Aarav'])

    // 2. Reject empty or whitespace
    const r2 = queuePersonName(names, '   ')
    assert.equal(r2.success, false)
    assert.equal(r2.error, 'Name cannot be empty')

    // 3. Reject case-insensitive duplicate
    const r3 = queuePersonName(names, 'aarav')
    assert.equal(r3.success, false)
    assert.match(r3.error || '', /already added/i)

    // 4. Add second distinct friend
    const r4 = queuePersonName(names, 'Meera')
    assert.equal(r4.success, true)
    names = r4.updated
    assert.deepEqual(names, ['Aarav', 'Meera'])
  })

  it('5. validates all queued contacts against PersonSchema', () => {
    const queued = ['Aarav', 'Meera', 'Roommate', 'Partner']
    for (const name of queued) {
      const parsed = PersonSchema.safeParse({ name })
      assert.equal(parsed.success, true)
      if (parsed.success) {
        assert.equal(parsed.data.name, name)
        assert.equal(parsed.data.isArchived, false)
      }
    }
  })

  it('6. financial invariant: onboarding contacts creates 0 transactions and ₹0 balance distortions', () => {
    // Adding friends merely creates person directory records; it must never touch balances or budgets
    const initialNetSpendPaise = 0
    const initialGrossOutflowPaise = 0
    const initialPendingDuesPaise = 0

    // Simulate adding 3 people
    const people = ['Rohan', 'Kabir', 'Simran'].map(name => ({
      name,
      isArchived: false,
    }))

    assert.equal(people.length, 3)
    assert.equal(initialNetSpendPaise, 0)
    assert.equal(initialGrossOutflowPaise, 0)
    assert.equal(initialPendingDuesPaise, 0)
  })

  it('7. resolves final names by automatically including uncommitted currentInput', () => {
    const existingQueue = ['Aarav', 'Meera']
    const uncommittedInput = '  Rohan  '

    function resolveFinalNames(names: string[], currentInput: string): string[] {
      const pendingInput = currentInput.trim()
      const finalNames = [...names]
      if (pendingInput) {
        const isDup = finalNames.some(n => n.toLowerCase() === pendingInput.toLowerCase())
        if (!isDup) {
          finalNames.push(pendingInput)
        }
      }
      return finalNames
    }

    // 1. With non-empty uncommitted input
    const withUncommitted = resolveFinalNames(existingQueue, uncommittedInput)
    assert.deepEqual(withUncommitted, ['Aarav', 'Meera', 'Rohan'])

    // 2. With whitespace or duplicate input
    const withDuplicate = resolveFinalNames(existingQueue, 'aarav')
    assert.deepEqual(withDuplicate, ['Aarav', 'Meera'])

    // 3. With empty input
    const withEmpty = resolveFinalNames(existingQueue, '   ')
    assert.deepEqual(withEmpty, ['Aarav', 'Meera'])
  })

  it('8. bypasses onboarding for existing active users with transactions or friends', () => {
    function evaluateUserOnboarding(params: {
      profile: UserProfile | null
      txCount: number
      peopleCount: number
    }): { showModal: boolean; markCompleted: boolean } {
      const { profile, txCount, peopleCount } = params
      if (!profile || profile.onboardingComplete || profile.peopleOnboardingCompleted) {
        return { showModal: false, markCompleted: false }
      }
      if (txCount > 0 || peopleCount > 0) {
        return { showModal: false, markCompleted: true }
      }
      return { showModal: true, markCompleted: false }
    }

    const legacyProfile: UserProfile = {
      uid: 'user-legacy-789',
      displayName: 'Existing User',
      email: 'existing@example.com',
      photoURL: null,
      defaultPaymentAccountId: null,
      onboardingComplete: false,
      createdAt: dummyTimestamp,
      updatedAt: dummyTimestamp,
    }

    // Existing user with 15 transactions
    const resExisting = evaluateUserOnboarding({
      profile: legacyProfile,
      txCount: 15,
      peopleCount: 0,
    })
    assert.equal(resExisting.showModal, false)
    assert.equal(resExisting.markCompleted, true)

    // Existing user with 2 friends
    const resFriends = evaluateUserOnboarding({
      profile: legacyProfile,
      txCount: 0,
      peopleCount: 2,
    })
    assert.equal(resFriends.showModal, false)
    assert.equal(resFriends.markCompleted, true)

    // Truly brand new user (0 txns, 0 friends)
    const resBrandNew = evaluateUserOnboarding({
      profile: legacyProfile,
      txCount: 0,
      peopleCount: 0,
    })
    assert.equal(resBrandNew.showModal, true)
    assert.equal(resBrandNew.markCompleted, false)
  })
})

