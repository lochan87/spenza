#!/usr/bin/env node
/**
 * Firebase Deployment Guard Hook (Phase 9.2.2)
 *
 * Enforces safe, project-targeted execution when Firebase CLI runs predeploy hooks:
 * 1. Prohibits silent default project deployments.
 * 2. Rejects any deployment if .firebaserc contains a 'default' alias.
 * 3. Requires an explicit, recognized target project (prod: spenza-90037, or valid staging).
 * 4. Triggers the target-appropriate frontend build (build:prod vs build:staging)
 *    so the correct fail-closed environment validation runs for that specific project.
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

// 2. Identify active Firebase project from environment variables set by Firebase CLI
const activeProject =
  process.env.GCP_PROJECT ||
  process.env.FIREBASE_PROJECT ||
  process.env.PROJECT_ID ||
  ''

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

// 3. Run target-specific build hook for hosting
if (scope === 'hosting') {
  const targetScript = isProd ? 'build:prod' : 'build:staging'
  console.log(`[DEPLOY GUARD] Verified target project: ${activeProject}`)
  console.log(`[DEPLOY GUARD] Executing target-specific frontend build: npm run ${targetScript}`)

  const result = spawnSync(`npm run ${targetScript}`, {
    stdio: 'inherit',
    shell: true,
  })

  if (result.status !== 0) {
    console.error(`[DEPLOY GUARD BLOCKED] Frontend build failed for target: ${targetScript}`)
    process.exit(result.status ?? 1)
  }
}
