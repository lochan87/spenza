import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { executeTrustedImport } from './importExecutor.ts'
import { ImportSizeError } from '../../src/utils/importPlan.ts'

initializeApp()
export const executeImportV2 = onCall({ region: 'us-central1', timeoutSeconds: 120, memory: '512MiB', maxInstances: 10, concurrency: 1 }, async request => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in before importing.')
  try {
    return await executeTrustedImport(getFirestore(), request.auth.uid, request.data)
  } catch (error) {
    if (error instanceof ImportSizeError) throw new HttpsError('invalid-argument', error.message, { reason: error.code, retryable: false })
    if (error instanceof HttpsError) throw error
    throw new HttpsError('failed-precondition', 'Import could not be verified. Resume the same operation; do not start a new import to retry.')
  }
})
