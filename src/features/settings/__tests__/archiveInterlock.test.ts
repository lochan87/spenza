import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { ExpenseDeletionError } from '../../../utils/expenseDeletion.ts'

const source = readFileSync(new URL('../SettingsPage.tsx', import.meta.url), 'utf8')
function handler(name: string, dependencies: Record<string, unknown>): () => Promise<void> {
  const ast = ts.createSourceFile('SettingsPage.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) expression = node.initializer!.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(expression)
  return runInNewContext(ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText, dependencies)
}

function setup(acknowledged = true) {
  const lock = { current: false }
  const calls: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const noOp = () => {}
  const dependencies = {
    user: { uid: 'owner' }, maintenanceInFlight: lock, ackClearAll: acknowledged, ackClearImports: acknowledged,
    setExportingJSON: noOp, setStatusBanner: noOp, setResettingCache: noOp,
    setClearingAll: noOp, setClearingImports: noOp, setConfirmClearAll: noOp, setConfirmClearImports: noOp,
    setAckClearAll: noOp, setAckClearImports: noOp, reloadData: async () => {}, ExpenseDeletionError,
    console: { error: noOp },
    exportCompleteFinancialData: async () => { calls.push('export'); await gate; return { transactionCount: 0, filename: 'archive.json' } },
    clearAllTransactions: async () => { calls.push('all'); await gate; return { deleted: 0, cacheInvalidated: true } },
    clearImportedTransactions: async () => { calls.push('imported'); await gate; return { deleted: 0, cacheInvalidated: true } },
    invalidateInsightsCache: async () => { calls.push('cache'); return true },
  }
  return { lock, calls, release, dependencies,
    exportJSON: handler('handleExportJSON', dependencies), all: handler('handleClearAll', dependencies),
    imported: handler('handleClearImported', dependencies), reset: handler('handleResetInsightsCache', dependencies) }
}

it('blocks duplicate export, both clears and cache deletion synchronously while export is pending', async () => {
  const h = setup()
  const pending = h.exportJSON()
  await Promise.all([h.exportJSON(), h.all(), h.imported(), h.reset()])
  assert.deepEqual(h.calls, ['export'])
  h.release(); await pending
  assert.equal(h.lock.current, false)
})

it('blocks export while either acknowledged clear is pending and retains mandatory acknowledgments', async () => {
  for (const operation of ['all', 'imported'] as const) {
    const h = setup()
    const pending = h[operation]()
    await h.exportJSON()
    assert.deepEqual(h.calls, [operation])
    h.release(); await pending
    assert.equal(h.lock.current, false)
  }
  const h = setup(false)
  await h.all(); await h.imported()
  assert.deepEqual(h.calls, [])
})

it('releases the interlock after export failure and disables Settings controls without changing deletion services', async () => {
  const h = setup()
  const failed = handler('handleExportJSON', { ...h.dependencies,
    exportCompleteFinancialData: async () => { throw new Error('server unavailable') } })
  await failed()
  assert.equal(h.lock.current, false)
  assert.match(source, /<fieldset disabled=\{exportingJSON\}/)
  assert.match(source, /disabled=\{exportingJSON \|\| clearingAll \|\| !ackClearAll\}/)
  assert.match(source, /disabled=\{exportingJSON \|\| clearingImports \|\| !ackClearImports\}/)
})
