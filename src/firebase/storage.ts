import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { storage } from './config'

export { storage }

/**
 * Upload a receipt image for a transaction.
 * Returns the public download URL.
 */
export async function uploadReceipt(
  uid: string,
  transactionId: string,
  file: File
): Promise<string> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const storageRef = ref(storage, `users/${uid}/receipts/${transactionId}.${ext}`)
  await uploadBytes(storageRef, file)
  return getDownloadURL(storageRef)
}

/**
 * Delete a receipt from storage.
 */
export async function deleteReceipt(receiptUrl: string): Promise<void> {
  const storageRef = ref(storage, receiptUrl)
  await deleteObject(storageRef)
}
