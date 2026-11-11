import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PRODUCTION_FIREBASE_PROJECT_ID,
  REQUIRED_FIREBASE_ENV_VARS,
  isPlaceholderValue,
  isValidFirebaseProjectId,
  validateBuildEnv,
  assertBuildEnv,
} from '../envValidation.ts'

function createValidProdEnv(): Record<string, string> {
  return {
    VITE_FIREBASE_API_KEY: 'AIzaSyAValidProdKeyForSpenzaApp12345',
    VITE_FIREBASE_AUTH_DOMAIN: 'spenza-90037.firebaseapp.com',
    VITE_FIREBASE_PROJECT_ID: 'spenza-90037',
    VITE_FIREBASE_STORAGE_BUCKET: 'spenza-90037.firebasestorage.app',
    VITE_FIREBASE_MESSAGING_SENDER_ID: '987654321098',
    VITE_FIREBASE_APP_ID: '1:987654321098:web:abcdef1234567890',
  }
}

function createValidStagingEnv(): Record<string, string> {
  return {
    VITE_FIREBASE_API_KEY: 'AIzaSyAValidStagingKeyForSpenza1234',
    VITE_FIREBASE_AUTH_DOMAIN: 'spenza-staging.firebaseapp.com',
    VITE_FIREBASE_PROJECT_ID: 'spenza-staging',
    VITE_FIREBASE_STORAGE_BUCKET: 'spenza-staging.firebasestorage.app',
    VITE_FIREBASE_MESSAGING_SENDER_ID: '123456789012',
    VITE_FIREBASE_APP_ID: '1:123456789012:web:staging1234567890',
  }
}

describe('Multi-Environment Configuration Validation (Phase 9.2.1)', () => {
  describe('Helper Functions', () => {
    it('defines exactly the 6 required Firebase environment keys', () => {
      assert.deepEqual(REQUIRED_FIREBASE_ENV_VARS, [
        'VITE_FIREBASE_API_KEY',
        'VITE_FIREBASE_AUTH_DOMAIN',
        'VITE_FIREBASE_PROJECT_ID',
        'VITE_FIREBASE_STORAGE_BUCKET',
        'VITE_FIREBASE_MESSAGING_SENDER_ID',
        'VITE_FIREBASE_APP_ID',
      ])
    })

    it('detects various placeholder values correctly', () => {
      assert.equal(isPlaceholderValue('your_api_key_here'), true)
      assert.equal(isPlaceholderValue('your_project_id_here'), true)
      assert.equal(isPlaceholderValue('your_staging_project_id_here'), true)
      assert.equal(isPlaceholderValue('your_staging_api_key_here'), true)
      assert.equal(isPlaceholderValue('your_project_id.firebaseapp.com'), true)
      assert.equal(isPlaceholderValue('something_here'), true)
      assert.equal(isPlaceholderValue('test@example.com'), true)
      assert.equal(isPlaceholderValue(''), false)
      assert.equal(isPlaceholderValue(undefined), false)
      assert.equal(isPlaceholderValue('spenza-90037'), false)
      assert.equal(isPlaceholderValue('spenza-staging'), false)
    })

    it('validates Firebase project ID format correctly', () => {
      assert.equal(isValidFirebaseProjectId('spenza-staging'), true)
      assert.equal(isValidFirebaseProjectId('spenza-90037'), true)
      assert.equal(isValidFirebaseProjectId('my-app-123'), true)
      // Invalid IDs
      assert.equal(isValidFirebaseProjectId(''), false)
      assert.equal(isValidFirebaseProjectId('sp'), false) // Too short (< 6)
      assert.equal(isValidFirebaseProjectId('123-spenza'), false) // Starts with digit
      assert.equal(isValidFirebaseProjectId('Spenza-Staging'), false) // Uppercase
      assert.equal(isValidFirebaseProjectId('spenza_staging'), false) // Underscore
      assert.equal(isValidFirebaseProjectId('spenza staging'), false) // Space
      assert.equal(isValidFirebaseProjectId('-spenza-staging'), false) // Starts with hyphen
    })
  })

  describe('Production Build Validation', () => {
    it('accepts valid production configuration matching spenza-90037', () => {
      const env = createValidProdEnv()
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, true)
      if (result.valid) {
        assert.equal(result.projectId, PRODUCTION_FIREBASE_PROJECT_ID)
        assert.equal(result.mode, 'production')
      }
    })

    it('rejects production build if VITE_USE_FIREBASE_EMULATOR is enabled', () => {
      const env = { ...createValidProdEnv(), VITE_USE_FIREBASE_EMULATOR: 'true' }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Emulator mode \(VITE_USE_FIREBASE_EMULATOR=true\) cannot be enabled in deployable build/)
      }
    })

    it('rejects production build targeting an incorrect project ID', () => {
      const env = { ...createValidProdEnv(), VITE_FIREBASE_PROJECT_ID: 'wrong-project-id' }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Production builds must target project 'spenza-90037', but received 'wrong-project-id'/)
      }
    })

    it('rejects production build targeting staging project', () => {
      const env = { ...createValidProdEnv(), VITE_FIREBASE_PROJECT_ID: 'spenza-staging' }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Production builds must target project 'spenza-90037', but received 'spenza-staging'/)
      }
    })

    it('rejects production build targeting a demo project ID', () => {
      const env = { ...createValidProdEnv(), VITE_FIREBASE_PROJECT_ID: 'demo-spenza-test' }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /cannot target demo project 'demo-spenza-test'/)
      }
    })

    it('rejects production build with missing required variables', () => {
      const env = createValidProdEnv()
      delete (env as Record<string, string | undefined>).VITE_FIREBASE_API_KEY
      delete (env as Record<string, string | undefined>).VITE_FIREBASE_APP_ID

      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Missing required Firebase environment variables/)
        assert.deepEqual(result.missingKeys, ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_APP_ID'])
      }
    })

    it('rejects production build containing template placeholders', () => {
      const env = {
        ...createValidProdEnv(),
        VITE_FIREBASE_API_KEY: 'your_api_key_here',
      }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Unconfigured placeholder values detected in: VITE_FIREBASE_API_KEY/)
        assert.deepEqual(result.placeholderKeys, ['VITE_FIREBASE_API_KEY'])
      }
    })

    it('rejects production build pointing to localhost loopback', () => {
      const env = {
        ...createValidProdEnv(),
        VITE_FIREBASE_AUTH_DOMAIN: '127.0.0.1:9099',
      }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /cannot target local loopback/)
      }
    })
  })

  describe('Staging Build Validation', () => {
    it('accepts valid staging configuration with distinct project ID', () => {
      const env = createValidStagingEnv()
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, true)
      if (result.valid) {
        assert.equal(result.projectId, 'spenza-staging')
        assert.equal(result.mode, 'staging')
      }
    })

    it('rejects staging build if VITE_USE_FIREBASE_EMULATOR is enabled', () => {
      const env = { ...createValidStagingEnv(), VITE_USE_FIREBASE_EMULATOR: 'true' }
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Emulator mode \(VITE_USE_FIREBASE_EMULATOR=true\) cannot be enabled in deployable build/)
      }
    })

    it('rejects staging build accidentally targeting production project spenza-90037', () => {
      const env = { ...createValidStagingEnv(), VITE_FIREBASE_PROJECT_ID: 'spenza-90037' }
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Staging builds must not target production project 'spenza-90037'/)
      }
    })

    it('rejects staging build with missing required variables', () => {
      const env = {
        VITE_FIREBASE_PROJECT_ID: 'spenza-staging',
      }
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Missing required Firebase environment variables/)
        assert.ok(result.missingKeys!.includes('VITE_FIREBASE_API_KEY'))
      }
    })

    it('rejects staging build with template placeholders from .env.staging.example', () => {
      const env = {
        VITE_FIREBASE_API_KEY: 'your_staging_api_key_here',
        VITE_FIREBASE_AUTH_DOMAIN: 'your_staging_project_id.firebaseapp.com',
        VITE_FIREBASE_PROJECT_ID: 'your_staging_project_id_here',
        VITE_FIREBASE_STORAGE_BUCKET: 'your_staging_project_id.firebasestorage.app',
        VITE_FIREBASE_MESSAGING_SENDER_ID: 'your_staging_messaging_sender_id_here',
        VITE_FIREBASE_APP_ID: 'your_staging_app_id_here',
      }
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Unconfigured placeholder values detected/)
        assert.equal(result.placeholderKeys!.length, 6)
      }
    })

    it('rejects staging build with malformed project ID format', () => {
      const env = { ...createValidStagingEnv(), VITE_FIREBASE_PROJECT_ID: 'Invalid_Project!' }
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /not a valid Firebase project identifier/)
      }
    })

    it('rejects staging build pointing to local loopback', () => {
      const env = { ...createValidStagingEnv(), VITE_FIREBASE_AUTH_DOMAIN: 'localhost:9099' }
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /cannot target local loopback/)
      }
    })
  })

  describe('Test and Development Modes', () => {
    it('permits test mode with demo project and emulator', () => {
      const env = {
        VITE_FIREBASE_PROJECT_ID: 'demo-spenza-test',
        VITE_USE_FIREBASE_EMULATOR: 'true',
      }
      const result = validateBuildEnv('test', env)
      assert.equal(result.valid, true)
      if (result.valid) {
        assert.equal(result.projectId, 'demo-spenza-test')
      }
    })

    it('permits development mode with local emulator enabled', () => {
      const env = {
        VITE_USE_FIREBASE_EMULATOR: 'true',
      }
      const result = validateBuildEnv('development', env)
      assert.equal(result.valid, true)
    })

    it('rejects development mode if not using emulator and missing credentials', () => {
      const env = {
        VITE_USE_FIREBASE_EMULATOR: 'false',
      }
      const result = validateBuildEnv('development', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Development configuration missing required variables/)
      }
    })
  })

  describe('assertBuildEnv Assertion Helper', () => {
    it('does not throw on valid production configuration', () => {
      assert.doesNotThrow(() => {
        assertBuildEnv('production', createValidProdEnv())
      })
    })

    it('does not throw on valid staging configuration', () => {
      assert.doesNotThrow(() => {
        assertBuildEnv('staging', createValidStagingEnv())
      })
    })

    it('throws Error with descriptive message on invalid configuration', () => {
      assert.throws(
        () => {
          assertBuildEnv('production', { ...createValidProdEnv(), VITE_USE_FIREBASE_EMULATOR: 'true' })
        },
        /Emulator mode \(VITE_USE_FIREBASE_EMULATOR=true\) cannot be enabled/
      )
    })
  })
})
