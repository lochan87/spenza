import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithCredential,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { auth } from './config'

const googleProvider = new GoogleAuthProvider()
googleProvider.setCustomParameters({ prompt: 'select_account' })

/**
 * Sign in with Google popup, falling back to redirect if popup is blocked by the browser.
 */
export async function signInWithGoogle(): Promise<User | null> {
  try {
    const result = await signInWithPopup(auth, googleProvider)
    return result.user
  } catch (err: any) {
    if (err?.code === 'auth/popup-blocked') {
      console.warn('[Spenza Auth] Popup was blocked by browser. Falling back to redirect sign-in...')
      await signInWithRedirect(auth, googleProvider)
      return null
    }
    throw err
  }
}

/**
 * Resolves redirect sign-in result if the user was redirected back to the app.
 */
export async function handleRedirectResult(): Promise<User | null> {
  try {
    const result = await getRedirectResult(auth)
    return result?.user ?? null
  } catch (err) {
    console.error('[Spenza Auth] Redirect resolution error:', err)
    throw err
  }
}

/**
 * Sign in as a test user directly against the Firebase Auth emulator.
 * Uses a mock Google OAuth credential without any popup or network access.
 * Strictly forbidden and gated in non-emulator environments.
 */
export async function signInAsTestUser(
  email = 'testuser@example.com',
  displayName = 'Test User'
): Promise<User> {
  if (import.meta.env.VITE_USE_FIREBASE_EMULATOR !== 'true') {
    throw new Error('signInAsTestUser is only permitted when running against the Firebase Auth emulator.')
  }
  const credential = GoogleAuthProvider.credential(
    JSON.stringify({
      sub: 'test-user-' + email.replace(/[^a-zA-Z0-9]/g, '_'),
      email,
      name: displayName,
      email_verified: true,
    })
  )
  const result = await signInWithCredential(auth, credential)
  return result.user
}

/**
 * Sign out the current user.
 */
export async function signOut(): Promise<void> {
  await firebaseSignOut(auth)
}

export { auth }
