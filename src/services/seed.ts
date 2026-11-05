import {
  doc,
  setDoc,
  getDoc,
  collection,
  getDocs,
  serverTimestamp,
  query,
  limit,
} from 'firebase/firestore'
import { db } from '@/firebase/config'
import type { Category, PaymentAccount, UserProfile } from '@/types'

// ─── Default Categories ───────────────────────────────────────────────────────

const DEFAULT_CATEGORIES: Omit<Category, 'id'>[] = [
  { name: 'Food & Drinks',       icon: '🍔',  color: '#F59E0B', isArchived: false },
  { name: 'Transport & Vehicle', icon: '🚗',  color: '#3B82F6', isArchived: false },
  { name: 'Shopping',            icon: '🛍️',  color: '#8B5CF6', isArchived: false },
  { name: 'Gifts & Events',      icon: '🎁',  color: '#EC4899', isArchived: false },
  { name: 'Health & Medical',    icon: '🏥',  color: '#EF4444', isArchived: false },
  { name: 'Education & Career',  icon: '🎓',  color: '#6366F1', isArchived: false },
  { name: 'Travel',              icon: '✈️',  color: '#06B6D4', isArchived: false },
  { name: 'Outings & Social',    icon: '🥂',  color: '#10B981', isArchived: false },
  { name: 'Bills & Recharge',    icon: '📱',  color: '#14B8A6', isArchived: false },
  { name: 'Entertainment',       icon: '🎮',  color: '#F43F5E', isArchived: false },
  { name: 'Personal/Household',  icon: '🏠',  color: '#A855F7', isArchived: false },
  { name: 'Other',               icon: '📌',  color: '#64748B', isArchived: false },
]

// ─── Default Payment Accounts ─────────────────────────────────────────────────

const DEFAULT_PAYMENT_ACCOUNTS: Omit<PaymentAccount, 'id' | 'createdAt'>[] = [
  {
    name: 'Cash',
    type: 'Wallet',
    isDefault: true,   // Cash is default for Cash-mode transactions
    isArchived: false,
  },
  {
    name: 'My Bank',
    type: 'Bank',
    isDefault: false,
    isArchived: false,
  },
  {
    name: 'My UPI',
    type: 'UPI',
    isDefault: false,
    isArchived: false,
  },
  {
    name: 'My Card',
    type: 'Card',
    isDefault: false,
    isArchived: false,
  },
]

// ─── Seed Functions ───────────────────────────────────────────────────────────

/**
 * Seeds default categories for a new user.
 * Only seeds if the collection is empty (idempotent).
 * Returns the list of created category IDs.
 */
export async function seedCategories(uid: string): Promise<string[]> {
  const categoriesRef = collection(db, 'users', uid, 'categories')
  const existing = await getDocs(categoriesRef)

  if (!existing.empty) {
    console.log('[Spenza Seed] Categories already seeded — skipping.')
    return existing.docs.map(d => d.id)
  }

  const ids: string[] = []
  for (const cat of DEFAULT_CATEGORIES) {
    const newRef = doc(categoriesRef)
    await setDoc(newRef, {
      ...cat,
      id: newRef.id,
    })
    ids.push(newRef.id)
  }

  console.log('[Spenza Seed] ✅ Seeded', ids.length, 'categories')
  return ids
}

/**
 * Seeds default payment accounts for a new user.
 * Only seeds if the collection is empty (idempotent).
 * Returns the list of created account IDs.
 */
export async function seedPaymentAccounts(uid: string): Promise<string[]> {
  const accountsRef = collection(db, 'users', uid, 'paymentAccounts')
  const existing = await getDocs(accountsRef)

  if (!existing.empty) {
    console.log('[Spenza Seed] Payment accounts already seeded — skipping.')
    return existing.docs.map(d => d.id)
  }

  const ids: string[] = []
  for (const account of DEFAULT_PAYMENT_ACCOUNTS) {
    const newRef = doc(accountsRef)
    await setDoc(newRef, {
      ...account,
      id: newRef.id,
      createdAt: serverTimestamp(),
    })
    ids.push(newRef.id)
  }

  console.log('[Spenza Seed] ✅ Seeded', ids.length, 'payment accounts')
  return ids
}

/**
 * Creates the user profile document if it doesn't exist.
 */
export async function seedUserProfile(uid: string, displayName: string | null, email: string | null, photoURL: string | null): Promise<void> {
  const profileRef = doc(db, 'users', uid, 'profile', 'data')
  const existing = await getDoc(profileRef)

  if (existing.exists()) {
    console.log('[Spenza Seed] Profile already exists — skipping.')
    return
  }

  await setDoc(profileRef, {
    uid,
    displayName,
    email,
    photoURL,
    defaultPaymentAccountId: null,
    onboardingComplete: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })

  console.log('[Spenza Seed] ✅ User profile created')
}

/**
 * Fetch the user's profile document.
 */
export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const profileRef = doc(db, 'users', uid, 'profile', 'data')
  const snap = await getDoc(profileRef)
  if (!snap.exists()) return null
  return snap.data() as UserProfile
}

/**
 * Mark onboarding and first-login split partner onboarding as complete.
 */
export async function completeUserOnboarding(uid: string): Promise<void> {
  const profileRef = doc(db, 'users', uid, 'profile', 'data')
  await setDoc(
    profileRef,
    {
      onboardingComplete: true,
      peopleOnboardingCompleted: true,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  )
}

/**
 * Determines whether a user should be prompted with the first-login split partner onboarding modal.
 * If the user has already completed onboarding, returns false.
 * If the user is an existing account with historical transactions or people, automatically marks
 * onboarding as complete and returns false, preventing false prompts for existing users.
 */
export async function shouldPromptPeopleOnboarding(uid: string): Promise<boolean> {
  const profile = await getUserProfile(uid)
  if (!profile || profile.onboardingComplete || profile.peopleOnboardingCompleted) {
    return false
  }

  // Check if this is an existing active user with transactions or contacts
  const txRef = collection(db, 'users', uid, 'transactions')
  const peopleRef = collection(db, 'users', uid, 'people')

  try {
    const [txSnap, peopleSnap] = await Promise.all([
      getDocs(query(txRef, limit(1))),
      getDocs(query(peopleRef, limit(1))),
    ])
    if (!txSnap.empty || !peopleSnap.empty) {
      // Existing user: mark complete so they never see the onboarding modal
      await completeUserOnboarding(uid).catch(() => {})
      return false
    }
  } catch (err) {
    console.warn('[Spenza Seed] Could not check existing user history:', err)
  }

  return true
}

/**
 * Run all seeds for a new user. Call this on first login.
 */
export async function runOnboardingSeeds(
  uid: string,
  displayName: string | null,
  email: string | null,
  photoURL: string | null,
): Promise<void> {
  console.log('[Spenza Seed] Running onboarding seeds for uid:', uid)
  await Promise.all([
    seedUserProfile(uid, displayName, email, photoURL),
    seedCategories(uid),
    seedPaymentAccounts(uid),
  ])
  console.log('[Spenza Seed] ✅ All onboarding seeds complete')
}
