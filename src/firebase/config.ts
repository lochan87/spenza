import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore'
import { getStorage } from 'firebase/storage'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

// Validate that all required env vars are set
const requiredVars = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const

for (const varName of requiredVars) {
  if (!import.meta.env[varName]) {
    throw new Error(
      `Missing required environment variable: ${varName}\n` +
      `Copy .env.example to .env.local and fill in your Firebase project credentials.`
    )
  }
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)

/**
 * Firestore with persistent offline cache.
 * Uses the modern persistentLocalCache API (replaces deprecated enableIndexedDbPersistence).
 * - Allows logging expenses offline; writes queue in IndexedDB and sync on reconnect.
 * - persistentMultipleTabManager: safe to have multiple tabs open (vs single-tab-only).
 */
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
})

export const storage = getStorage(app)
