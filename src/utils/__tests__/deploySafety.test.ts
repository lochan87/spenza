import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

describe('Deployment Safety Gates & Guard Verification (Phase 9.2.2)', () => {
  const rootDir = process.cwd()

  it('.firebaserc contains NO default project alias', () => {
    const firebasercPath = resolve(rootDir, '.firebaserc')
    assert.equal(existsSync(firebasercPath), true, '.firebaserc must exist')

    const firebaserc = JSON.parse(readFileSync(firebasercPath, 'utf8'))
    assert.equal('default' in (firebaserc.projects || {}), false, '.firebaserc must not contain a default project alias')
    assert.equal(firebaserc.projects.prod, 'spenza-90037', 'prod alias must strictly target spenza-90037')
  })

  it('firebase.json hosting predeploy uses guardDeploy hook instead of untargeted build', () => {
    const firebaseJsonPath = resolve(rootDir, 'firebase.json')
    assert.equal(existsSync(firebaseJsonPath), true, 'firebase.json must exist')

    const firebaseJson = JSON.parse(readFileSync(firebaseJsonPath, 'utf8'))
    assert.deepEqual(
      firebaseJson.hosting.predeploy,
      ['node scripts/guardDeploy.mjs hosting'],
      'hosting predeploy must use guardDeploy hook to prevent silent default deploys'
    )
  })

  it('scripts/guardDeploy.mjs blocks execution when no project is passed (silent default prevention)', () => {
    const guardScript = resolve(rootDir, 'scripts/guardDeploy.mjs')
    const result = spawnSync('node', [guardScript, 'hosting'], {
      env: {
        ...process.env,
        GCP_PROJECT: '',
        FIREBASE_PROJECT: '',
        PROJECT_ID: '',
      },
    })
    assert.equal(result.status, 1, 'guardDeploy must exit with code 1 when no project is specified')
    const stderr = result.stderr.toString()
    assert.match(stderr, /Silent default project deployment is prohibited/, 'must explain default deployment block')
  })

  it('scripts/guardDeploy.mjs blocks execution when target project is unrecognized', () => {
    const guardScript = resolve(rootDir, 'scripts/guardDeploy.mjs')
    const result = spawnSync('node', [guardScript, 'hosting'], {
      env: {
        ...process.env,
        GCP_PROJECT: 'random-unauthorized-project',
      },
    })
    assert.equal(result.status, 1)
    const stderr = result.stderr.toString()
    assert.match(stderr, /Unrecognized target project 'random-unauthorized-project'/)
  })

  it('scripts/deployPrep.mjs fails closed if no target is specified', () => {
    const deployPrepScript = resolve(rootDir, 'scripts/deployPrep.mjs')
    const result = spawnSync('node', [deployPrepScript], {})
    assert.equal(result.status, 1)
    const stderr = result.stderr.toString()
    assert.match(stderr, /Missing deployment target/)
    assert.match(stderr, /Silent default project deployments are strictly prohibited/)
  })

  it('scripts/deployPrep.mjs fails closed if target is invalid', () => {
    const deployPrepScript = resolve(rootDir, 'scripts/deployPrep.mjs')
    const result = spawnSync('node', [deployPrepScript, 'invalid-target'], {})
    assert.equal(result.status, 1)
    const stderr = result.stderr.toString()
    assert.match(stderr, /Invalid deployment target: "invalid-target"/)
  })

  it('scripts/deployPrep.mjs fails closed for staging when staging is not in .firebaserc', () => {
    const deployPrepScript = resolve(rootDir, 'scripts/deployPrep.mjs')
    const result = spawnSync('node', [deployPrepScript, 'staging'], {})
    assert.equal(result.status, 1)
    const stderr = result.stderr.toString()
    assert.match(stderr, /Staging project alias is not defined in \.firebaserc/)
  })

  it('scripts/releaseCheck.mjs fails closed if target is invalid', () => {
    const releaseCheckScript = resolve(rootDir, 'scripts/releaseCheck.mjs')
    const result = spawnSync('node', [releaseCheckScript, 'bad-target'], {})
    assert.equal(result.status, 1)
    const stderr = result.stderr.toString()
    assert.match(stderr, /Invalid target: "bad-target"/)
  })
})
