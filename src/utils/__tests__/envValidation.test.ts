import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PRODUCTION_FIREBASE_PROJECT_ID,
  REQUIRED_FIREBASE_ENV_VARS,
  isPlaceholderValue,
  isValidFirebaseProjectId,
  isAuthDomainConsistentWithProjectId,
  isStorageBucketConsistentWithProjectId,
  detectMixedEnvironment,
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

describe('Multi-Environment Configuration Validation (Phase 9.2.1 & 9.2.2)', () => {
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

    it('validates Auth domain consistency with project ID', () => {
      // Valid formats
      assert.equal(isAuthDomainConsistentWithProjectId('spenza-90037.firebaseapp.com', 'spenza-90037'), true)
      assert.equal(isAuthDomainConsistentWithProjectId('spenza-90037.web.app', 'spenza-90037'), true)
      assert.equal(isAuthDomainConsistentWithProjectId('spenza-staging.firebaseapp.com', 'spenza-staging'), true)
      assert.equal(isAuthDomainConsistentWithProjectId('spenza-staging.web.app', 'spenza-staging'), true)
      assert.equal(isAuthDomainConsistentWithProjectId('auth.spenza.com', 'spenza-90037'), true) // Custom domain

      // Inconsistent / mismatched
      assert.equal(isAuthDomainConsistentWithProjectId('spenza-90037.firebaseapp.com', 'spenza-staging'), false)
      assert.equal(isAuthDomainConsistentWithProjectId('other-project.firebaseapp.com', 'spenza-staging'), false)
      assert.equal(isAuthDomainConsistentWithProjectId('other-project.web.app', 'spenza-90037'), false)
      assert.equal(isAuthDomainConsistentWithProjectId('', 'spenza-90037'), false)
    })

    it('validates Storage bucket consistency with project ID', () => {
      // Valid formats
      assert.equal(isStorageBucketConsistentWithProjectId('spenza-90037.firebasestorage.app', 'spenza-90037'), true)
      assert.equal(isStorageBucketConsistentWithProjectId('spenza-90037.appspot.com', 'spenza-90037'), true)
      assert.equal(isStorageBucketConsistentWithProjectId('spenza-90037', 'spenza-90037'), true)
      assert.equal(isStorageBucketConsistentWithProjectId('spenza-staging.firebasestorage.app', 'spenza-staging'), true)
      assert.equal(isStorageBucketConsistentWithProjectId('spenza-staging.appspot.com', 'spenza-staging'), true)
      assert.equal(isStorageBucketConsistentWithProjectId('spenza-staging-regional.firebasestorage.app', 'spenza-staging'), true)

      // Inconsistent / mismatched
      assert.equal(isStorageBucketConsistentWithProjectId('spenza-90037.firebasestorage.app', 'spenza-staging'), false)
      assert.equal(isStorageBucketConsistentWithProjectId('other-project.appspot.com', 'spenza-staging'), false)
      assert.equal(isStorageBucketConsistentWithProjectId('other-project.firebasestorage.app', 'spenza-90037'), false)
      assert.equal(isStorageBucketConsistentWithProjectId('', 'spenza-90037'), false)
    })

    it('detects mixed environment configuration across variables', () => {
      // Clean prod
      assert.deepEqual(detectMixedEnvironment('production', createValidProdEnv()), { mixed: false })
      // Clean staging
      assert.deepEqual(detectMixedEnvironment('staging', createValidStagingEnv()), { mixed: false })

      // Staging with prod leak
      const stagingWithProd = {
        ...createValidStagingEnv(),
        VITE_FIREBASE_STORAGE_BUCKET: 'spenza-90037.firebasestorage.app',
      }
      const mixedStaging = detectMixedEnvironment('staging', stagingWithProd)
      assert.equal(mixedStaging.mixed, true)
      if (mixedStaging.mixed) {
        assert.equal(mixedStaging.key, 'VITE_FIREBASE_STORAGE_BUCKET')
      }

      // Prod with staging leak
      const prodWithStaging = {
        ...createValidProdEnv(),
        VITE_FIREBASE_AUTH_DOMAIN: 'spenza-staging.firebaseapp.com',
      }
      const mixedProd = detectMixedEnvironment('production', prodWithStaging)
      assert.equal(mixedProd.mixed, true)
      if (mixedProd.mixed) {
        assert.equal(mixedProd.key, 'VITE_FIREBASE_AUTH_DOMAIN')
      }
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

    it('accepts valid production configuration with appspot.com storage bucket', () => {
      const env = {
        ...createValidProdEnv(),
        VITE_FIREBASE_STORAGE_BUCKET: 'spenza-90037.appspot.com',
      }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, true)
    })

    it('accepts valid production configuration with web.app auth domain', () => {
      const env = {
        ...createValidProdEnv(),
        VITE_FIREBASE_AUTH_DOMAIN: 'spenza-90037.web.app',
      }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, true)
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
      const env = {
        ...createValidProdEnv(),
        VITE_FIREBASE_PROJECT_ID: 'wrong-project-id',
        VITE_FIREBASE_AUTH_DOMAIN: 'wrong-project-id.firebaseapp.com',
        VITE_FIREBASE_STORAGE_BUCKET: 'wrong-project-id.firebasestorage.app',
      }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Production builds must target project 'spenza-90037'/)
      }
    })

    it('rejects production build with inconsistent authDomain', () => {
      const env = { ...createValidProdEnv(), VITE_FIREBASE_AUTH_DOMAIN: 'other-app.firebaseapp.com' }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Firebase Auth domain 'other-app\.firebaseapp\.com' is inconsistent/)
      }
    })

    it('rejects production build with inconsistent storageBucket', () => {
      const env = { ...createValidProdEnv(), VITE_FIREBASE_STORAGE_BUCKET: 'other-app.firebasestorage.app' }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Firebase storage bucket 'other-app\.firebasestorage\.app' is inconsistent/)
      }
    })

    it('rejects production build with mixed staging configuration', () => {
      const env = { ...createValidProdEnv(), VITE_FIREBASE_AUTH_DOMAIN: 'spenza-staging.firebaseapp.com' }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Mixed environment configuration detected/)
      }
    })

    it('rejects production build targeting demo project ID', () => {
      const env = { ...createValidProdEnv(), VITE_FIREBASE_PROJECT_ID: 'demo-spenza-test' }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /cannot target demo project/)
      }
    })

    it('rejects production build with missing environment variables', () => {
      const env = { ...createValidProdEnv() }
      delete (env as Record<string, string | undefined>).VITE_FIREBASE_API_KEY
      delete (env as Record<string, string | undefined>).VITE_FIREBASE_AUTH_DOMAIN
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Missing required Firebase environment variables/)
        assert.equal(result.missingKeys?.includes('VITE_FIREBASE_API_KEY'), true)
        assert.equal(result.missingKeys?.includes('VITE_FIREBASE_AUTH_DOMAIN'), true)
      }
    })

    it('rejects production build with template placeholders from .env.example', () => {
      const env = {
        VITE_FIREBASE_API_KEY: 'your_api_key_here',
        VITE_FIREBASE_AUTH_DOMAIN: 'your_project_id.firebaseapp.com',
        VITE_FIREBASE_PROJECT_ID: 'your_project_id_here',
        VITE_FIREBASE_STORAGE_BUCKET: 'your_project_id.firebasestorage.app',
        VITE_FIREBASE_MESSAGING_SENDER_ID: 'your_messaging_sender_id_here',
        VITE_FIREBASE_APP_ID: 'your_app_id_here',
      }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Unconfigured placeholder values detected/)
        assert.equal(result.placeholderKeys!.length, 6)
      }
    })

    it('rejects production build pointing to local loopback', () => {
      const env = { ...createValidProdEnv(), VITE_FIREBASE_AUTH_DOMAIN: '127.0.0.1:9099' }
      const result = validateBuildEnv('production', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /cannot target local loopback/)
      }
    })
  })

  describe('Staging Build Validation', () => {
    it('accepts valid staging configuration with distinct non-production project', () => {
      const env = createValidStagingEnv()
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, true)
      if (result.valid) {
        assert.equal(result.projectId, 'spenza-staging')
        assert.equal(result.mode, 'staging')
      }
    })

    it('accepts valid staging configuration with appspot.com storage bucket', () => {
      const env = {
        ...createValidStagingEnv(),
        VITE_FIREBASE_STORAGE_BUCKET: 'spenza-staging.appspot.com',
      }
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, true)
    })

    it('accepts valid staging configuration with web.app auth domain', () => {
      const env = {
        ...createValidStagingEnv(),
        VITE_FIREBASE_AUTH_DOMAIN: 'spenza-staging.web.app',
      }
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, true)
    })

    it('rejects staging build if VITE_USE_FIREBASE_EMULATOR is enabled', () => {
      const env = { ...createValidStagingEnv(), VITE_USE_FIREBASE_EMULATOR: 'true' }
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Emulator mode \(VITE_USE_FIREBASE_EMULATOR=true\) cannot be enabled in deployable build/)
      }
    })

    it('rejects staging build targeting production project spenza-90037', () => {
      const env = { ...createValidStagingEnv(), VITE_FIREBASE_PROJECT_ID: PRODUCTION_FIREBASE_PROJECT_ID }
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Staging builds must not target production project 'spenza-90037'/)
      }
    })

    it('rejects staging build with inconsistent authDomain', () => {
      const env = {
        ...createValidStagingEnv(),
        VITE_FIREBASE_AUTH_DOMAIN: 'other-staging.firebaseapp.com',
      }
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Firebase Auth domain 'other-staging\.firebaseapp\.com' is inconsistent/)
      }
    })

    it('rejects staging build with inconsistent storageBucket', () => {
      const env = {
        ...createValidStagingEnv(),
        VITE_FIREBASE_STORAGE_BUCKET: 'other-staging.firebasestorage.app',
      }
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Firebase storage bucket 'other-staging\.firebasestorage\.app' is inconsistent/)
      }
    })

    it('rejects staging build with mixed production configuration leak', () => {
      const env = {
        ...createValidStagingEnv(),
        VITE_FIREBASE_STORAGE_BUCKET: 'spenza-90037.firebasestorage.app',
      }
      const result = validateBuildEnv('staging', env)
      assert.equal(result.valid, false)
      if (!result.valid) {
        assert.match(result.error, /Mixed environment configuration detected/)
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
      const env = {
        ...createValidStagingEnv(),
        VITE_FIREBASE_PROJECT_ID: 'Invalid_Project!',
        VITE_FIREBASE_AUTH_DOMAIN: 'Invalid_Project!.firebaseapp.com',
        VITE_FIREBASE_STORAGE_BUCKET: 'Invalid_Project!.firebasestorage.app',
      }
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
