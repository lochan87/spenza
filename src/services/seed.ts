import {
  doc,
  setDoc,
  getDoc,
  collection,
  getDocs,
  serverTimestamp,
} from 'firebase/firestore'
import { db } from '@/firebase/config'
import type { Category, PaymentAccount } from '@/types'

// ─── Default Categories ───────────────────────────────────────────────────────

const DEFAULT_CATEGORIES: Omit<Category, 'id'>[] = [
  { name: 'Food & Drinks',       icon: '🍽️',  color: '#ff6b6b', isArchived: false },
  { name: 'Transport',           icon: '🚗',  color: '#4ecdc4', isArchived: false },
  { name: 'Gifts & Events',      icon: '🎁',  color: '#ff9f43', isArchived: false },
  { name: 'Shopping',            icon: '🛍️',  color: '#a29bfe', isArchived: false },
  { name: 'Health',              icon: '❤️',  color: '#fd79a8', isArchived: false },
  { name: 'Education',           icon: '📚',  color: '#0984e3', isArchived: false },
  { name: 'Bills & Recharge',    icon: '⚡',  color: '#fdcb6e', isArchived: false },
  { name: 'Travel',              icon: '✈️',  color: '#6c63ff', isArchived: false },
  { name: 'Personal/Household',  icon: '🏠',  color: '#00b894', isArchived: false },
  { name: 'Other',               icon: '📌',  color: '#636e72', isArchived: false },
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
