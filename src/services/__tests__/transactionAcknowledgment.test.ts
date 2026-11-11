import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as edit from '../../utils/expenseEdit.ts'
import * as deletion from '../../utils/expenseDeletion.ts'

function harness() {
  let resolve!: () => void, reject!: (error: Error) => void
  const write = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const events: { type: string; detail: any }[] = []
  let writes = 0
  const exports = {} as { addTransaction: (uid: string, data: unknown) => Promise<{ status: string; id: string }> }
  runInNewContext(ts.transpileModule(readFileSync(new URL('../transactions.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText, { exports, setTimeout, clearTimeout, console,
    window: { dispatchEvent: (event: any) => events.push(event) },
    CustomEvent: class { type: string; detail: any; constructor(type: string, options: any) { this.type = type; this.detail = options.detail } },
    require: (name: string) => {
      if (name === 'firebase/firestore') return { collection: () => ({}), doc: () => ({ id: 'stable-id' }),
        serverTimestamp: () => null, setDoc: () => { writes++; return write } }
      if (name === '@/firebase/config') return { db: {} }
      if (name === '@/services/insights') return { invalidateInsightsCache: async () => true }
      if (name === '@/utils/expenseEdit') return edit
      if (name === '@/utils/expenseDeletion') return deletion
      throw new Error(name)
    },
  })
  return { run: () => exports.addTransaction('owner', { description: 'Dinner' }), resolve, reject, events, writes: () => writes }
}
it('confirms creation only after server acknowledgment', async () => {
  const h = harness(), pending = h.run()
  h.resolve()
  assert.equal((await pending).status, 'confirmed')
  assert.equal(h.writes(), 1)
})
it('reports a slow/offline write as pending, surfaces late rejection and never retries it automatically', async () => {
  const h = harness()
  assert.equal((await h.run()).status, 'pending')
  h.reject(new Error('permission-denied'))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(h.events.filter(e => e.type === 'spenza_write_rejected').length, 1)
  assert.match(h.events.find(e => e.type === 'spenza_write_rejected')!.detail.message, /not saved/)
  assert.equal(h.writes(), 1)
})
it('rejects an immediately denied creation without reporting success', async () => {
  const h = harness(), pending = h.run()
  h.reject(new Error('permission-denied'))
  await assert.rejects(pending, /permission-denied/)
  assert.equal(h.events.length, 0)
})
it('late acknowledgment refreshes financial views without creating a duplicate', async () => {
  const h = harness()
  assert.equal((await h.run()).status, 'pending')
  h.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(h.events.some(e => e.detail.type === 'transaction_updated'))
  assert.equal(h.writes(), 1)
})
