#!/usr/bin/env node
/**
 * Reusable Local Release-Check Quality Gate (Phase 9.2.2)
 *
 * Runs the complete pre-release verification pipeline for a specified target (prod or staging):
 * 1. Frontend unit tests (Node test runner with experimental strip types)
 * 2. Cloud Functions unit tests (functions/test/*.test.ts)
 * 3. TypeScript checks (tsconfig.app.json, tsconfig.node.json, functions/tsconfig.json)
 * 4. Lint (oxlint)
 * 5. Cloud Functions build (functions tsc build)
 * 6. Target-specific frontend build (build:prod or build:staging with fail-closed env validation)
 *
 * Fails immediately if any required step fails.
 */

import { spawnSync } from 'node:child_process'
import { globSync } from 'node:fs'

const rawTarget = process.argv[2] || 'prod'
const target = rawTarget.toLowerCase().trim()

if (target !== 'prod' && target !== 'production' && target !== 'staging') {
  console.error(`\n[RELEASE-CHECK ERROR] Invalid target: "${rawTarget}". Allowed targets: "prod" or "staging".`)
  process.exit(1)
}

const normalizedTarget = (target === 'production' || target === 'prod') ? 'prod' : 'staging'
const frontendBuildScript = normalizedTarget === 'prod' ? 'build:prod' : 'build:staging'

console.log(`\n================================================================`)
console.log(`  SPENZA RELEASE CHECK — TARGET: ${normalizedTarget.toUpperCase()}`)
console.log(`================================================================\n`)

function runStep(name, commandString) {
  console.log(`--> [STEP] ${name}`)
  console.log(`    Command: ${commandString}`)
  const startTime = Date.now()
  const result = spawnSync(commandString, {
    stdio: 'inherit',
    shell: true,
  })
  const duration = ((Date.now() - startTime) / 1000).toFixed(2)
  if (result.status !== 0) {
    console.error(`\n[RELEASE-CHECK FAILED] Step failed: "${name}" (exit code: ${result.status ?? 'signal'}, elapsed: ${duration}s)`)
    console.error(`Aborting remaining release checks immediately.\n`)
    process.exit(result.status ?? 1)
  }
  console.log(`    ✓ Passed in ${duration}s\n`)
}

// 1. Frontend Unit Tests
const frontendTestFiles = globSync('src/**/*.test.ts').sort()
if (frontendTestFiles.length === 0) {
  console.error('[RELEASE-CHECK FAILED] No frontend unit tests found matching src/**/*.test.ts')
  process.exit(1)
}
runStep('Frontend Unit Tests', `node --experimental-strip-types --test ${frontendTestFiles.join(' ')}`)

// 2. Cloud Functions Unit Tests
runStep('Cloud Functions Unit Tests', 'npm test --prefix functions')

// 3. TypeScript Checks (App, Vite config, Functions)
runStep(
  'TypeScript Check: Frontend Application (tsconfig.app.json)',
  'node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit --incremental false'
)

runStep(
  'TypeScript Check: Node / Vite Tooling (tsconfig.node.json)',
  'node node_modules/typescript/bin/tsc -p tsconfig.node.json --noEmit --incremental false'
)

runStep('TypeScript Check: Cloud Functions (functions/tsconfig.json)', 'npm --prefix functions run typecheck')

// 4. Lint Check
runStep('Lint (oxlint)', 'npm run lint')

// 5. Cloud Functions Build
runStep('Cloud Functions Build', 'npm --prefix functions run build')

// 6. Target-Specific Frontend Build (enforces fail-closed environment validation)
runStep(`Frontend Build: ${normalizedTarget.toUpperCase()} (${frontendBuildScript})`, `npm run ${frontendBuildScript}`)

console.log(`================================================================`)
console.log(`  ✓ ALL QUALITY GATES PASSED FOR RELEASE TARGET: ${normalizedTarget.toUpperCase()}`)
console.log(`================================================================\n`)
