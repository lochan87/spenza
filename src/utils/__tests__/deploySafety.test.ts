import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

describe('Deployment Safety Gates & Guard Verification (Phase 9.2.2 & 9.2.3)', () => {
  const rootDir = process.cwd()

  it('.firebaserc contains NO default project alias and prod strictly binds to spenza-90037', () => {
    const firebasercPath = resolve(rootDir, '.firebaserc')
    assert.equal(existsSync(firebasercPath), true, '.firebaserc must exist')

    const firebaserc = JSON.parse(readFileSync(firebasercPath, 'utf8'))
    assert.equal('default' in (firebaserc.projects || {}), false, '.firebaserc must not contain a default project alias')
    assert.equal(firebaserc.projects.prod, 'spenza-90037', 'prod alias must strictly target spenza-90037')
  })

  it('firebase.json protects all deployable resources with predeploy guard hooks', () => {
    const firebaseJsonPath = resolve(rootDir, 'firebase.json')
    assert.equal(existsSync(firebaseJsonPath), true, 'firebase.json must exist')

    const firebaseJson = JSON.parse(readFileSync(firebaseJsonPath, 'utf8'))

    // Hosting predeploy
    assert.deepEqual(
      firebaseJson.hosting.predeploy,
      ['node scripts/guardDeploy.mjs hosting'],
      'hosting predeploy must use guardDeploy hook'
    )

    // Functions predeploy
    assert.deepEqual(
      firebaseJson.functions[0].predeploy,
      ['node scripts/guardDeploy.mjs functions'],
      'functions predeploy must use guardDeploy hook'
    )

    // Firestore predeploy
    assert.deepEqual(
      firebaseJson.firestore.predeploy,
      ['node scripts/guardDeploy.mjs firestore'],
      'firestore predeploy must use guardDeploy hook'
    )

    // Storage predeploy
    assert.deepEqual(
      firebaseJson.storage.predeploy,
      ['node scripts/guardDeploy.mjs storage'],
      'storage predeploy must use guardDeploy hook'
    )
  })

  describe('scripts/guardDeploy.mjs (Predeploy Hook Gate)', () => {
    const guardScript = resolve(rootDir, 'scripts/guardDeploy.mjs')

    it('blocks execution when no project environment variable is present (silent default prevention)', () => {
      const result = spawnSync('node', [guardScript, 'hosting'], {
        env: {
          ...process.env,
          GCLOUD_PROJECT: '',
          GCP_PROJECT: '',
          FIREBASE_PROJECT: '',
          PROJECT_ID: '',
        },
      })
      assert.equal(result.status, 1, 'guardDeploy must exit with code 1 when no project is specified')
      const stderr = result.stderr.toString()
      assert.match(stderr, /Silent default project deployment is prohibited/, 'must explain default deployment block')
    })

    it('blocks execution when GCLOUD_PROJECT is explicitly set to "default"', () => {
      const result = spawnSync('node', [guardScript, 'hosting'], {
        env: {
          ...process.env,
          GCLOUD_PROJECT: 'default',
        },
      })
      assert.equal(result.status, 1)
      const stderr = result.stderr.toString()
      assert.match(stderr, /Silent default project deployment is prohibited/)
    })

    it('blocks execution when GCLOUD_PROJECT targets an unauthorized project ID', () => {
      const result = spawnSync('node', [guardScript, 'hosting'], {
        env: {
          ...process.env,
          GCLOUD_PROJECT: 'random-unauthorized-project',
        },
      })
      assert.equal(result.status, 1)
      const stderr = result.stderr.toString()
      assert.match(stderr, /Unrecognized target project 'random-unauthorized-project'/)
    })

    it('validates firestore scope and verifies rules and indexes exist when authorized', () => {
      const result = spawnSync('node', [guardScript, 'firestore'], {
        env: {
          ...process.env,
          GCLOUD_PROJECT: 'spenza-90037',
        },
      })
      assert.equal(result.status, 0)
      const stdout = result.stdout.toString()
      assert.match(stdout, /Firestore security rules and indexes verified/)
    })

    it('validates storage scope and verifies storage rules exist when authorized', () => {
      const result = spawnSync('node', [guardScript, 'storage'], {
        env: {
          ...process.env,
          GCLOUD_PROJECT: 'spenza-90037',
        },
      })
      assert.equal(result.status, 0)
      const stdout = result.stdout.toString()
      assert.match(stdout, /Storage security rules verified/)
    })

    it('rejects invalid or unknown scope name', () => {
      const result = spawnSync('node', [guardScript, 'unknown-scope'], {
        env: {
          ...process.env,
          GCLOUD_PROJECT: 'spenza-90037',
        },
      })
      assert.equal(result.status, 1)
      const stderr = result.stderr.toString()
      assert.match(stderr, /Unknown resource scope: 'unknown-scope'/)
    })
  })

  describe('scripts/deploySafe.mjs (Project-Pinned Deployment Wrapper)', () => {
    const deploySafeScript = resolve(rootDir, 'scripts/deploySafe.mjs')

    it('fails closed when no target is specified', () => {
      const result = spawnSync('node', [deploySafeScript], {})
      assert.equal(result.status, 1)
      const stderr = result.stderr.toString()
      assert.match(stderr, /Missing deployment target/)
      assert.match(stderr, /Silent default project deployments are strictly prohibited/)
    })

    it('fails closed when target is invalid', () => {
      const result = spawnSync('node', [deploySafeScript, 'invalid-target'], {})
      assert.equal(result.status, 1)
      const stderr = result.stderr.toString()
      assert.match(stderr, /Invalid deployment target: "invalid-target"/)
    })

    it('fails closed for staging when staging is not registered in .firebaserc', () => {
      const result = spawnSync('node', [deploySafeScript, 'staging'], {})
      assert.equal(result.status, 1)
      const stderr = result.stderr.toString()
      assert.match(stderr, /Staging project alias is not defined in \.firebaserc/)
    })
  })

  describe('scripts/deployPrep.mjs (Strictly Non-Deploying Preparation Gate)', () => {
    const deployPrepScript = resolve(rootDir, 'scripts/deployPrep.mjs')

    it('fails closed if no target is specified', () => {
      const result = spawnSync('node', [deployPrepScript], {})
      assert.equal(result.status, 1)
      const stderr = result.stderr.toString()
      assert.match(stderr, /Missing deployment target/)
      assert.match(stderr, /Silent default project deployments are strictly prohibited/)
    })

    it('fails closed if target is invalid', () => {
      const result = spawnSync('node', [deployPrepScript, 'invalid-target'], {})
      assert.equal(result.status, 1)
      const stderr = result.stderr.toString()
      assert.match(stderr, /Invalid deployment target: "invalid-target"/)
    })

    it('fails closed for staging when staging is not in .firebaserc', () => {
      const result = spawnSync('node', [deployPrepScript, 'staging'], {})
      assert.equal(result.status, 1)
      const stderr = result.stderr.toString()
      assert.match(stderr, /Staging project alias is not defined in \.firebaserc/)
    })
  })

  describe('scripts/releaseCheck.mjs (Quality Gate Runner)', () => {
    const releaseCheckScript = resolve(rootDir, 'scripts/releaseCheck.mjs')

    it('fails closed if target is invalid', () => {
      const result = spawnSync('node', [releaseCheckScript, 'bad-target'], {})
      assert.equal(result.status, 1)
      const stderr = result.stderr.toString()
      assert.match(stderr, /Invalid target: "bad-target"/)
    })
  })
})
