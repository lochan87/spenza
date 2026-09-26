import { initializeApp } from 'firebase/app'
import { getAuth } from 'firebase/auth'
import { getFirestore, enableIndexedDbPersistence } from 'firebase/firestore'
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
export const db = getFirestore(app)
export const storage = getStorage(app)

// Enable Firestore offline persistence — allows logging expenses without signal.
// Writes are queued in IndexedDB and synced when connectivity returns.
// FAILED_PRECONDITION = already enabled (multi-tab); UNIMPLEMENTED = browser doesn't support it.
enableIndexedDbPersistence(db).catch(err => {
  if (err.code === 'failed-precondition') {
    console.info('[Spenza] Firestore offline: multiple tabs open — persistence enabled in first tab only.')
  } else if (err.code === 'unimplemented') {
    console.warn('[Spenza] Firestore offline: browser does not support IndexedDB persistence.')
  } else {
    console.error('[Spenza] Firestore offline persistence error:', err)
  }
})
