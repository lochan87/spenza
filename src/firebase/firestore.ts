import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  type DocumentData,
  type QueryConstraint,
} from 'firebase/firestore'
import { db } from './config'

// ─── Collection path helpers ────────────────────────────────────────────────

export const userDocRef = (uid: string) => doc(db, 'users', uid)

export const userSubCol = (uid: string, col: string) =>
  collection(db, 'users', uid, col)

export const userSubDocRef = (uid: string, col: string, docId: string) =>
  doc(db, 'users', uid, col, docId)

// ─── Generic CRUD ────────────────────────────────────────────────────────────

export async function getDocument(path: string, id: string): Promise<DocumentData | null> {
  const ref = doc(db, path, id)
  const snap = await getDoc(ref)
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}

export async function queryCollection(
  path: string,
  constraints: QueryConstraint[] = []
): Promise<DocumentData[]> {
  const ref = collection(db, path)
  const q = query(ref, ...constraints)
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

// ─── Re-export commonly used Firestore utilities ─────────────────────────────

export {
  db,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
}
