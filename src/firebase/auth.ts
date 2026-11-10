import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth'
import { auth } from './config'

const googleProvider = new GoogleAuthProvider()
googleProvider.setCustomParameters({ prompt: 'select_account' })

/**
 * Sign in with Google popup. This is the only auth method for Spenza
 * (single-user personal app).
 */
export async function signInWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider)
  return result.user
}

/**
 * Sign in as a test user directly against the Firebase Auth emulator.
 * Uses a mock Google OAuth credential without any popup or network access.
 */
export async function signInAsTestUser(
  email = 'testuser@example.com',
  displayName = 'Test User'
): Promise<User> {
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
