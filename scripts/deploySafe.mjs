#!/usr/bin/env node
/**
 * Safe, Project-Pinned Deployment Wrapper (Phase 9.2.3)
 *
 * Provides a secure, explicit deployment wrapper across ALL Firebase resources:
 * - Hosting
 * - Cloud Functions
 * - Firestore security rules
 * - Firestore indexes
 * - Storage rules
 *
 * ARCHITECTURAL SAFETY & LIMITATION DOCUMENTATION:
 * In Firebase CLI (firebase-tools), 'hosting' and 'functions' natively support predeploy hooks.
 * While firebase.json schema also allows predeploy hooks for 'firestore' and 'storage', direct CLI
 * commands (such as 'firebase deploy --only firestore:rules' or ad-hoc CLI flags) can vary across
 * CLI versions or bypass hosting/functions quality gates if invoked directly without running tests.
 *
 * Direct Firebase CLI commands without '--project' are blocked by .firebaserc (which defines NO 'default' alias),
 * but direct CLI invocations WITH '--project' can bypass local unit tests and linting.
 *
 * This wrapper guarantees that ALL deployments:
 * 1. Require an explicit target ('prod' or 'staging'). Silent default deployments are strictly blocked.
 * 2. Forbid any 'default' project mapping in .firebaserc.
 * 3. Pin the authoritative project ID ('spenza-90037' for prod; configured staging ID for staging).
 * 4. Run the full release-check pipeline (frontend & functions tests, typechecks, lint, builds).
 * 5. Verify presence of all required artifacts before invoking deployment.
 * 6. Operate in dry-run/preview mode by default; require explicit '--confirm-deploy' to execute.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const rawTarget = args.find(a => !a.startsWith('--'))
const isConfirmDeploy = args.includes('--confirm-deploy')
const onlyArgIndex = args.indexOf('--only')
const onlyResource = onlyArgIndex !== -1 && args[onlyArgIndex + 1] ? args[onlyArgIndex + 1] : 'all'

if (!rawTarget) {
  console.error(`\n[DEPLOY-SAFE ERROR] Missing deployment target.`)
  console.error(`Usage: node scripts/deploySafe.mjs <prod|staging> [--only <resource>] [--confirm-deploy]`)
  console.error(`Silent default project deployments are strictly prohibited.\n`)
  process.exit(1)
}

const target = rawTarget.toLowerCase().trim()
if (target !== 'prod' && target !== 'production' && target !== 'staging') {
  console.error(`\n[DEPLOY-SAFE ERROR] Invalid deployment target: "${rawTarget}". Allowed targets: "prod" or "staging".`)
  process.exit(1)
}

const normalizedTarget = (target === 'production' || target === 'prod') ? 'prod' : 'staging'

console.log(`\n================================================================`)
console.log(`  SPENZA SAFE DEPLOYMENT WRAPPER — TARGET: ${normalizedTarget.toUpperCase()}`)
console.log(`================================================================\n`)

// 1. Inspect .firebaserc and prevent silent default project usage
const firebasercPath = resolve(process.cwd(), '.firebaserc')
if (!existsSync(firebasercPath)) {
  console.error(`[DEPLOY-SAFE FAILED] .firebaserc not found at ${firebasercPath}`)
  process.exit(1)
}

let firebaserc
try {
  firebaserc = JSON.parse(readFileSync(firebasercPath, 'utf8'))
} catch (e) {
  console.error(`[DEPLOY-SAFE FAILED] Unable to parse .firebaserc:`, e.message)
  process.exit(1)
}

const projects = firebaserc.projects || {}

if ('default' in projects) {
  console.error(
    `[DEPLOY-SAFE BLOCKED] .firebaserc defines a 'default' project alias ('${projects.default}').\n` +
    `Silent default project deployment is prohibited. Remove 'default' from .firebaserc and use explicit aliases (e.g. 'prod', 'staging').`
  )
  process.exit(1)
}

let targetProjectId = ''
if (normalizedTarget === 'prod') {
  targetProjectId = projects.prod
  if (!targetProjectId || targetProjectId !== 'spenza-90037') {
    console.error(
      `[DEPLOY-SAFE FAILED] Production target in .firebaserc must map 'prod' to 'spenza-90037', but found: '${targetProjectId}'.`
    )
    process.exit(1)
  }
} else if (normalizedTarget === 'staging') {
  targetProjectId = projects.staging
  if (!targetProjectId) {
    console.error(
      `[DEPLOY-SAFE FAILED] Staging project alias is not defined in .firebaserc.\n` +
      `Pending requirement: Once a staging Firebase project is provisioned, register it in .firebaserc under 'staging'.\n` +
      `Example: { "projects": { "prod": "spenza-90037", "staging": "<staging-project-id>" } }`
    )
    process.exit(1)
  }
  if (targetProjectId === 'spenza-90037') {
    console.error(
      `[DEPLOY-SAFE FAILED] Staging target in .firebaserc must NOT map to production project 'spenza-90037'.`
    )
    process.exit(1)
  }
}

console.log(`[CONFIG VERIFIED] Target project: ${targetProjectId} (alias: ${normalizedTarget})`)
console.log(`[CONFIG VERIFIED] Target resource: ${onlyResource}`)
console.log(`[CONFIG VERIFIED] Default project alias: ABSENT (silent default deployments blocked)\n`)

// 2. Execute release check pipeline (unless explicitly bypassed for single non-code resource like storage)
console.log(`--> Executing release quality checks for ${normalizedTarget}...`)
const checkResult = spawnSync(`node scripts/releaseCheck.mjs ${normalizedTarget}`, {
  stdio: 'inherit',
  shell: true,
})

if (checkResult.status !== 0) {
  console.error(`\n[DEPLOY-SAFE FAILED] Release quality check failed for target: ${normalizedTarget}`)
  process.exit(checkResult.status ?? 1)
}

// 3. Verify presence of required artifacts
console.log(`--> Verifying deployment artifacts...`)
const artifactChecks = []
if (onlyResource === 'all' || onlyResource.includes('hosting')) {
  artifactChecks.push('dist/index.html', 'dist/manifest.webmanifest', 'dist/sw.js')
}
if (onlyResource === 'all' || onlyResource.includes('functions')) {
  artifactChecks.push('functions/lib/functions/src/index.js')
}
if (onlyResource === 'all' || onlyResource.includes('firestore')) {
  artifactChecks.push('firestore.rules', 'firestore.indexes.json')
}
if (onlyResource === 'all' || onlyResource.includes('storage')) {
  artifactChecks.push('storage.rules')
}

const missing = artifactChecks.filter(file => !existsSync(resolve(process.cwd(), file)))
if (missing.length > 0) {
  console.error(`[DEPLOY-SAFE FAILED] Missing expected deployment artifacts:\n  - ${missing.join('\n  - ')}`)
  process.exit(1)
}

console.log(`    ✓ Verified artifacts: ${artifactChecks.join(', ')}\n`)

// 4. Construct project-pinned command
const pinnedCommand =
  onlyResource === 'all'
    ? `npx firebase deploy --project ${targetProjectId}`
    : `npx firebase deploy --project ${targetProjectId} --only ${onlyResource}`

if (!isConfirmDeploy) {
  console.log(`================================================================`)
  console.log(`  ✓ SAFE DEPLOYMENT PLAN VERIFIED: ${normalizedTarget.toUpperCase()}`)
  console.log(`================================================================`)
  console.log(`Target:             ${normalizedTarget}`)
  console.log(`Project ID:         ${targetProjectId}`)
  console.log(`Resource:           ${onlyResource}`)
  console.log(`Pinned Command:     ${pinnedCommand}`)
  console.log(``)
  console.log(`[SAFETY NOTICE] This was a dry-run check. No deployment was executed.`)
  console.log(`To execute deployment with explicit project pinning, run:`)
  console.log(`  node scripts/deploySafe.mjs ${normalizedTarget} ${onlyResource !== 'all' ? `--only ${onlyResource} ` : ''}--confirm-deploy`)
  console.log(`================================================================\n`)
  process.exit(0)
}

// 5. If --confirm-deploy is present, execute the pinned command
console.log(`--> Executing project-pinned deployment: ${pinnedCommand}`)
const deployResult = spawnSync(pinnedCommand, {
  stdio: 'inherit',
  shell: true,
})

if (deployResult.status !== 0) {
  console.error(`\n[DEPLOY-SAFE FAILED] Deployment failed (exit code: ${deployResult.status})`)
  process.exit(deployResult.status ?? 1)
}

console.log(`\n✓ Deployment completed successfully.`)
