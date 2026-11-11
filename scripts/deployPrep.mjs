#!/usr/bin/env node
/**
 * Safe Deployment Preparation Gate (Phase 9.2.2)
 *
 * Prepares and validates a release for deployment without executing any deployment.
 * Enforces:
 * 1. Explicit target selection ('prod' or 'staging'). Rejects silent default deployment.
 * 2. Checks .firebaserc: forbids 'default' alias; ensures explicit mapping.
 * 3. Runs full release quality check pipeline (releaseCheck.mjs).
 * 4. Verifies presence and integrity of generated build artifacts.
 * 5. Prints explicit manual deploy instructions with strict --project flag.
 *
 * DOES NOT execute 'firebase deploy' or access production Firebase.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const rawTarget = process.argv[2]
if (!rawTarget) {
  console.error(`\n[DEPLOY-PREP ERROR] Missing deployment target.`)
  console.error(`Usage: node scripts/deployPrep.mjs <prod|staging>`)
  console.error(`Silent default project deployments are strictly prohibited.\n`)
  process.exit(1)
}

const target = rawTarget.toLowerCase().trim()
if (target !== 'prod' && target !== 'production' && target !== 'staging') {
  console.error(`\n[DEPLOY-PREP ERROR] Invalid deployment target: "${rawTarget}". Allowed targets: "prod" or "staging".`)
  process.exit(1)
}

const normalizedTarget = (target === 'production' || target === 'prod') ? 'prod' : 'staging'

console.log(`\n================================================================`)
console.log(`  SPENZA DEPLOY PREPARATION — TARGET: ${normalizedTarget.toUpperCase()}`)
console.log(`================================================================\n`)

// 1. Inspect .firebaserc and prevent silent default project usage
const firebasercPath = resolve(process.cwd(), '.firebaserc')
if (!existsSync(firebasercPath)) {
  console.error(`[DEPLOY-PREP FAILED] .firebaserc not found at ${firebasercPath}`)
  process.exit(1)
}

let firebaserc
try {
  firebaserc = JSON.parse(readFileSync(firebasercPath, 'utf8'))
} catch (e) {
  console.error(`[DEPLOY-PREP FAILED] Unable to parse .firebaserc:`, e.message)
  process.exit(1)
}

const projects = firebaserc.projects || {}

if ('default' in projects) {
  console.error(
    `[DEPLOY-PREP BLOCKED] .firebaserc defines a 'default' project alias ('${projects.default}').\n` +
    `Silent default project deployment is prohibited. Remove 'default' from .firebaserc and use explicit aliases (e.g. 'prod', 'staging').`
  )
  process.exit(1)
}

let targetProjectId = ''
if (normalizedTarget === 'prod') {
  targetProjectId = projects.prod
  if (!targetProjectId || targetProjectId !== 'spenza-90037') {
    console.error(
      `[DEPLOY-PREP FAILED] Production target in .firebaserc must map 'prod' to 'spenza-90037', but found: '${targetProjectId}'.`
    )
    process.exit(1)
  }
} else if (normalizedTarget === 'staging') {
  targetProjectId = projects.staging
  if (!targetProjectId) {
    console.error(
      `[DEPLOY-PREP FAILED] Staging project alias is not defined in .firebaserc.\n` +
      `Pending requirement: Once a staging Firebase project is provisioned, register it in .firebaserc under 'staging'.\n` +
      `Example: { "projects": { "prod": "spenza-90037", "staging": "<staging-project-id>" } }`
    )
    process.exit(1)
  }
  if (targetProjectId === 'spenza-90037') {
    console.error(
      `[DEPLOY-PREP FAILED] Staging target in .firebaserc must NOT map to production project 'spenza-90037'.`
    )
    process.exit(1)
  }
}

console.log(`[CONFIG VERIFIED] Target project: ${targetProjectId} (alias: ${normalizedTarget})`)
console.log(`[CONFIG VERIFIED] Default project alias: ABSENT (silent default deployments blocked)\n`)

// 2. Execute release check pipeline
console.log(`--> Executing release quality checks for ${normalizedTarget}...`)
const checkResult = spawnSync(`node scripts/releaseCheck.mjs ${normalizedTarget}`, {
  stdio: 'inherit',
  shell: true,
})

if (checkResult.status !== 0) {
  console.error(`\n[DEPLOY-PREP FAILED] Release quality check failed for target: ${normalizedTarget}`)
  process.exit(checkResult.status ?? 1)
}

// 3. Verify presence of required build artifacts
console.log(`--> Verifying output deployment artifacts...`)
const requiredArtifacts = [
  'dist/index.html',
  'dist/manifest.webmanifest',
  'dist/sw.js',
  'functions/lib/functions/src/index.js',
  'firestore.rules',
  'firestore.indexes.json',
  'storage.rules',
]

const missingArtifacts = requiredArtifacts.filter(file => !existsSync(resolve(process.cwd(), file)))
if (missingArtifacts.length > 0) {
  console.error(`[DEPLOY-PREP FAILED] Missing expected deployment artifacts:\n  - ${missingArtifacts.join('\n  - ')}`)
  process.exit(1)
}

console.log(`    ✓ All ${requiredArtifacts.length} required deployment artifacts verified on disk.\n`)

console.log(`================================================================`)
console.log(`  ✓ DEPLOY PREPARATION SUCCEEDED FOR: ${normalizedTarget.toUpperCase()}`)
console.log(`================================================================`)
console.log(`Target:             ${normalizedTarget}`)
console.log(`Firebase Project:   ${targetProjectId}`)
console.log(`Status:             Verified & Ready for Deployment`)
console.log(``)
console.log(`[SAFETY NOTICE] No deployment was executed. Automatic/silent deployment is disabled.`)
console.log(`To deploy this verified release, explicitly pass the project flag:`)
console.log(`  npx firebase deploy --project ${targetProjectId}`)
console.log(`================================================================\n`)
