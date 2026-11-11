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

function setup(isOnline: boolean) {
  const lock = { current: false }
  const calls: string[] = []
  const banners: { type: string; message: string }[] = []
  const noOp = () => {}
  const dependencies = {
    user: { uid: 'owner' },
    navigator: { onLine: isOnline },
    maintenanceInFlight: lock,
    ackClearAll: true,
    ackClearImports: true,
    setExportingJSON: noOp,
    setStatusBanner: (b: { type: string; message: string } | null) => { if (b) banners.push(b) },
    setResettingCache: noOp,
    setClearingAll: noOp,
    setClearingImports: noOp,
    setConfirmClearAll: noOp,
    setConfirmClearImports: noOp,
    setAckClearAll: noOp,
    setAckClearImports: noOp,
    reloadData: async () => {},
    ExpenseDeletionError,
    console: { error: noOp },
    clearAllTransactions: async () => { calls.push('all'); return { deleted: 0, cacheInvalidated: true } },
    clearImportedTransactions: async () => { calls.push('imported'); return { deleted: 0, cacheInvalidated: true } },
    invalidateInsightsCache: async () => { calls.push('cache'); return true },
  }
  return {
    lock,
    calls,
    banners,
    all: handler('handleClearAll', dependencies),
    imported: handler('handleClearImported', dependencies),
    reset: handler('handleResetInsightsCache', dependencies),
  }
}

it('blocks Clear All, Clear Imported, and Reset Insights Cache when offline and notifies user', async () => {
  const offline = setup(false)

  await offline.all()
  assert.deepEqual(offline.calls, [], 'clearAllTransactions should not be called when offline')
  assert.ok(offline.banners.some(b => b.type === 'error' && b.message.includes('You are offline')))

  await offline.imported()
  assert.deepEqual(offline.calls, [], 'clearImportedTransactions should not be called when offline')
  assert.ok(offline.banners.some(b => b.type === 'error' && b.message.includes('You are offline')))

  await offline.reset()
  assert.deepEqual(offline.calls, [], 'invalidateInsightsCache should not be called when offline')
  assert.ok(offline.banners.some(b => b.type === 'error' && b.message.includes('You are offline')))
})

it('allows execution of clear operations when online', async () => {
  const online = setup(true)

  await online.all()
  assert.deepEqual(online.calls, ['all'], 'clearAllTransactions should be called when online')

  await online.imported()
  assert.deepEqual(online.calls, ['all', 'imported'], 'clearImportedTransactions should be called when online')

  await online.reset()
  assert.deepEqual(online.calls, ['all', 'imported', 'cache'], 'invalidateInsightsCache should be called when online')
})
