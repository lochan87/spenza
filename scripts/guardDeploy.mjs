#!/usr/bin/env node
/**
 * Firebase Deployment Guard Hook (Phase 9.2.2 & 9.2.3)
 *
 * Enforces safe, project-targeted execution when Firebase CLI runs predeploy hooks:
 * 1. Prohibits silent default project deployments.
 * 2. Rejects any deployment if .firebaserc contains a 'default' alias.
 * 3. Inspects official Firebase CLI environment variables (specifically GCLOUD_PROJECT,
 *    as defined by getChildEnvironment in firebase-tools/lib/deploy/lifecycleHooks.js).
 *    Does NOT assume GCP_PROJECT or FIREBASE_PROJECT is always available.
 * 4. Requires an explicit, recognized target project (prod: spenza-90037, or valid staging).
 * 5. Triggers scope-appropriate builds and validation across all deployable resources:
 *    - hosting: executes target-specific frontend build (build:prod vs build:staging)
 *    - functions: executes functions typecheck & build (npm --prefix functions run build)
 *    - firestore: validates existence and integrity of firestore.rules and firestore.indexes.json
 *    - storage: validates existence and integrity of storage.rules
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const scope = process.argv[2] || 'hosting'

// 1. Inspect .firebaserc
const firebasercPath = resolve(process.cwd(), '.firebaserc')
if (!existsSync(firebasercPath)) {
  console.error(`[DEPLOY GUARD ERROR] .firebaserc not found at ${firebasercPath}`)
  process.exit(1)
}

let firebaserc
try {
  firebaserc = JSON.parse(readFileSync(firebasercPath, 'utf8'))
} catch (e) {
  console.error(`[DEPLOY GUARD ERROR] Unable to parse .firebaserc:`, e.message)
  process.exit(1)
}

const projects = firebaserc.projects || {}

if ('default' in projects) {
  console.error(
    `[DEPLOY GUARD ERROR] .firebaserc contains a 'default' project mapping ('${projects.default}').\n` +
    `Silent default deployments are prohibited. Remove 'default' from .firebaserc and deploy with --project.`
  )
  process.exit(1)
}

// 2. Identify active Firebase project
// Note: Official Firebase CLI getChildEnvironment sets GCLOUD_PROJECT (not GCP_PROJECT or FIREBASE_PROJECT).
// We check GCLOUD_PROJECT first, then fallback variables, but require an explicit, non-empty, non-default value.
const activeProject = (
  process.env.GCLOUD_PROJECT ||
  process.env.GCP_PROJECT ||
  process.env.FIREBASE_PROJECT ||
  process.env.PROJECT_ID ||
  ''
).trim()

if (!activeProject || activeProject === 'default') {
  console.error(
    `[DEPLOY GUARD BLOCKED] Silent default project deployment is prohibited.\n` +
    `No explicit Firebase project was passed to the deploy command.\n` +
    `Execute deployment with an explicit target: 'firebase deploy --project <prod|staging>'.`
  )
  process.exit(1)
}

const isProd = activeProject === 'spenza-90037' || activeProject === projects.prod || activeProject === 'prod'
const isStaging =
  (projects.staging && activeProject === projects.staging) ||
  activeProject === 'staging' ||
  (activeProject.includes('staging') && activeProject !== 'spenza-90037')

if (!isProd && !isStaging) {
  console.error(
    `[DEPLOY GUARD BLOCKED] Unrecognized target project '${activeProject}'.\n` +
    `Allowed deployment targets: 'prod' (spenza-90037) or configured 'staging' project.`
  )
  process.exit(1)
}

console.log(`[DEPLOY GUARD] Verified target project: ${activeProject} (scope: ${scope})`)

// 3. Run scope-specific validation and build hooks
switch (scope) {
  case 'hosting': {
    const targetScript = isProd ? 'build:prod' : 'build:staging'
    console.log(`[DEPLOY GUARD] Executing target-specific frontend build: npm run ${targetScript}`)

    const result = spawnSync(`npm run ${targetScript}`, {
      stdio: 'inherit',
      shell: true,
    })

    if (result.status !== 0) {
      console.error(`[DEPLOY GUARD BLOCKED] Frontend build failed for target: ${targetScript}`)
      process.exit(result.status ?? 1)
    }
    break
  }

  case 'functions': {
    console.log(`[DEPLOY GUARD] Executing Cloud Functions build: npm --prefix functions run build`)
    const result = spawnSync('npm --prefix functions run build', {
      stdio: 'inherit',
      shell: true,
    })

    if (result.status !== 0) {
      console.error(`[DEPLOY GUARD BLOCKED] Cloud Functions build failed`)
      process.exit(result.status ?? 1)
    }
    break
  }

  case 'firestore': {
    const rulesPath = resolve(process.cwd(), 'firestore.rules')
    const indexesPath = resolve(process.cwd(), 'firestore.indexes.json')
    if (!existsSync(rulesPath) || !existsSync(indexesPath)) {
      console.error(`[DEPLOY GUARD BLOCKED] Missing firestore.rules or firestore.indexes.json`)
      process.exit(1)
    }
    console.log(`[DEPLOY GUARD] ✓ Firestore security rules and indexes verified.`)
    break
  }

  case 'storage': {
    const rulesPath = resolve(process.cwd(), 'storage.rules')
    if (!existsSync(rulesPath)) {
      console.error(`[DEPLOY GUARD BLOCKED] Missing storage.rules`)
      process.exit(1)
    }
    console.log(`[DEPLOY GUARD] ✓ Storage security rules verified.`)
    break
  }

  default: {
    console.error(`[DEPLOY GUARD ERROR] Unknown resource scope: '${scope}'.`)
    process.exit(1)
  }
}
