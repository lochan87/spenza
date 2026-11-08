import { getDocsFromServer, collection, type Firestore } from 'firebase/firestore'
import { format } from 'date-fns'
import {
  buildFinancialExportDocument,
  validateExportIntegrity,
  type FinancialExportDocument,
  type SourceDocument,
  type ArchiveInput,
  archiveCollections,
  importArchiveCollections,
} from '../utils/financialExport.ts'

export interface FinancialExportResult {
  success: true
  filename: string
  transactionCount: number
  totalGrossPaise: number
  totalRecoverablePaise: number
}

/** Trigger a browser file download of the given text content */
function downloadBlob(content: string, filename: string, mimeType: string) {
  if (typeof document === 'undefined') throw new Error('A browser is required to initiate the archive download.')
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * Compare two passes over the known financial schema. This is change detection,
 * not an atomic database snapshot: reverted changes or later writes can escape it.
 */
export async function exportCompleteFinancialData(uid: string, customDb?: Firestore): Promise<FinancialExportResult> {
  if (!uid || typeof uid !== 'string' || uid.trim() === '') {
    throw new Error('User UID is required to export financial data.')
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new Error('You are offline. Exporting an archive requires server access.')
  }

  const firestore = customDb || (await import('../firebase/config.ts')).db

  const startedAt = new Date().toISOString()
  async function read(path: string): Promise<SourceDocument[]> {
    const snap = await getDocsFromServer(collection(firestore, path))
    if (snap.metadata.fromCache || snap.metadata.hasPendingWrites || snap.docs.some(d => d.metadata.fromCache || d.metadata.hasPendingWrites)) {
      throw new Error('Archive cancelled: cached data or pending local writes were detected. Wait for synchronization and retry.')
    }
    return snap.docs.map(d => ({ id: d.id, path: d.ref.path, data: d.data() })).sort((a, b) => a.path.localeCompare(b.path))
  }
  async function readPass(): Promise<ArchiveInput> {
    const source = { uid, nestedCollections: {} } as ArchiveInput
    await Promise.all(archiveCollections.map(async name => { source[name] = await read(`users/${uid}/${name}`) }))
    const paths = source.importOperations.flatMap(op => importArchiveCollections.map(name => `${op.path}/${name}`)).sort()
    // Bound concurrency for accounts with many import operations.
    for (let offset = 0; offset < paths.length; offset += 10) {
      await Promise.all(paths.slice(offset, offset + 10).map(async path => { source.nestedCollections[path] = await read(path) }))
    }
    return source
  }
  const source = await readPass()
  const verification = await readPass()
  const first = buildFinancialExportDocument(source), second = buildFinancialExportDocument(verification)
  if (JSON.stringify(first.data) !== JSON.stringify(second.data) || JSON.stringify(first.nestedCollections) !== JSON.stringify(second.nestedCollections)) {
    throw new Error('Archive cancelled: financial records changed during export. Pause edits/imports and retry.')
  }
  source.readVerification = { method: 'two-server-passes', startedAt, verifiedAt: new Date().toISOString(), globallyAtomic: false }
  const doc: FinancialExportDocument = buildFinancialExportDocument(source)
  const jsonContent = JSON.stringify(doc, null, 2)

  const integrity = validateExportIntegrity(JSON.parse(jsonContent), source)
  if (!integrity.valid) {
    throw new Error(`Export integrity verification failed: ${integrity.errors.join('; ')}`)
  }

  const dateStr = format(new Date(), 'yyyy-MM-dd')
  const filename = `spenza-financial-archive-${dateStr}.json`

  downloadBlob(jsonContent, filename, 'application/json;charset=utf-8;')

  return {
    success: true,
    filename,
    transactionCount: doc.metadata.counts.transactions,
    totalGrossPaise: doc.metadata.derived.totalGrossPaise,
    totalRecoverablePaise: doc.metadata.derived.totalRecoverablePaise,
  }
}
