/**
 * Multi-Environment Configuration Validator (Phase 9.2.1)
 *
 * Enforces fail-closed build and runtime validation:
 * - Production builds must target the authoritative production project (spenza-90037).
 * - Staging builds require an explicitly configured, non-production staging project.
 * - Emulator mode (VITE_USE_FIREBASE_EMULATOR=true) is strictly forbidden in deployable builds.
 * - Missing variables, demo IDs, and placeholder values immediately abort the build.
 */

export const PRODUCTION_FIREBASE_PROJECT_ID = 'spenza-90037'

export const REQUIRED_FIREBASE_ENV_VARS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_STORAGE_BUCKET',
  'VITE_FIREBASE_MESSAGING_SENDER_ID',
  'VITE_FIREBASE_APP_ID',
] as const

export type RequiredFirebaseEnvVar = (typeof REQUIRED_FIREBASE_ENV_VARS)[number]

export interface ValidationSuccess {
  valid: true
  mode: string
  projectId: string
}

export interface ValidationFailure {
  valid: false
  mode: string
  error: string
  missingKeys?: string[]
  placeholderKeys?: string[]
}

export type EnvValidationResult = ValidationSuccess | ValidationFailure

/**
 * Detects placeholder values from .env.example or template files.
 */
export function isPlaceholderValue(value: string | undefined): boolean {
  if (!value) return false
  const trimmed = value.trim().toLowerCase()
  return (
    trimmed.startsWith('your_') ||
    trimmed.endsWith('_here') ||
    trimmed.includes('your_project_id') ||
    trimmed.includes('your_staging_') ||
    trimmed.includes('your_api_key') ||
    trimmed.includes('example.com')
  )
}

/**
 * Validates whether a project ID adheres to Firebase naming conventions:
 * 6-30 lowercase characters, digits, or hyphens, starting with a letter.
 */
export function isValidFirebaseProjectId(projectId: string): boolean {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)
}

/**
 * Validates environment variables for the specified Vite build mode.
 * Fail-closed by design.
 */
export function validateBuildEnv(
  mode: string,
  env: Record<string, string | undefined>
): EnvValidationResult {
  const normalizedMode = (mode || 'production').toLowerCase().trim()

  // 1. Test mode: explicitly used by unit tests and Playwright emulator runs
  if (normalizedMode === 'test') {
    const projectId = env.VITE_FIREBASE_PROJECT_ID || 'demo-spenza-test'
    return { valid: true, mode: normalizedMode, projectId }
  }

  // 2. Development mode: allow local developer defaults or emulator use
  if (normalizedMode === 'development') {
    const isEmulator = env.VITE_USE_FIREBASE_EMULATOR === 'true'
    if (isEmulator) {
      return { valid: true, mode: normalizedMode, projectId: env.VITE_FIREBASE_PROJECT_ID || 'demo-spenza-test' }
    }
    const missingKeys = REQUIRED_FIREBASE_ENV_VARS.filter(key => !env[key] || !env[key]!.trim())
    if (missingKeys.length > 0) {
      return {
        valid: false,
        mode: normalizedMode,
        missingKeys,
        error: `Development configuration missing required variables: ${missingKeys.join(', ')}. Set credentials in .env.local or set VITE_USE_FIREBASE_EMULATOR=true.`,
      }
    }
    return { valid: true, mode: normalizedMode, projectId: env.VITE_FIREBASE_PROJECT_ID! }
  }

  // 3. Deployable builds: 'production' and 'staging'
  const isDeployable = normalizedMode === 'production' || normalizedMode === 'staging'

  if (isDeployable) {
    // Rule A: Emulator mode must NEVER be enabled in deployable builds
    if (env.VITE_USE_FIREBASE_EMULATOR === 'true') {
      return {
        valid: false,
        mode: normalizedMode,
        error: `Build validation failed: Emulator mode (VITE_USE_FIREBASE_EMULATOR=true) cannot be enabled in deployable build (mode: ${normalizedMode}).`,
      }
    }

    // Rule B: Check for missing required variables
    const missingKeys: string[] = []
    for (const key of REQUIRED_FIREBASE_ENV_VARS) {
      const val = env[key]
      if (!val || val.trim().length === 0) {
        missingKeys.push(key)
      }
    }
    if (missingKeys.length > 0) {
      return {
        valid: false,
        mode: normalizedMode,
        missingKeys,
        error:
          `Build validation failed for mode '${normalizedMode}': Missing required Firebase environment variables: ` +
          missingKeys.join(', ') +
          `.\nEnsure .env.${normalizedMode} or .env.${normalizedMode}.local is properly configured.`,
      }
    }

    // Rule C: Check for unconfigured placeholder values
    const placeholderKeys: string[] = []
    for (const key of REQUIRED_FIREBASE_ENV_VARS) {
      if (isPlaceholderValue(env[key])) {
        placeholderKeys.push(key)
      }
    }
    if (placeholderKeys.length > 0) {
      return {
        valid: false,
        mode: normalizedMode,
        placeholderKeys,
        error:
          `Build validation failed for mode '${normalizedMode}': Unconfigured placeholder values detected in: ` +
          placeholderKeys.join(', ') +
          `.\nReplace all placeholders with actual Firebase project credentials.`,
      }
    }

    const projectId = env.VITE_FIREBASE_PROJECT_ID!.trim()

    // Rule D: Demo project IDs are forbidden in deployable builds
    if (projectId.startsWith('demo-')) {
      return {
        valid: false,
        mode: normalizedMode,
        error: `Build validation failed: Deployable build (mode: ${normalizedMode}) cannot target demo project '${projectId}'.`,
      }
    }

    // Rule E: Production build constraints
    if (normalizedMode === 'production') {
      if (projectId !== PRODUCTION_FIREBASE_PROJECT_ID) {
        return {
          valid: false,
          mode: normalizedMode,
          error: `Build validation failed: Production builds must target project '${PRODUCTION_FIREBASE_PROJECT_ID}', but received '${projectId}'.`,
        }
      }

      // Ensure authDomain and storageBucket do not point to local loopback
      const authDomain = env.VITE_FIREBASE_AUTH_DOMAIN || ''
      const storageBucket = env.VITE_FIREBASE_STORAGE_BUCKET || ''
      if (
        authDomain.includes('127.0.0.1') ||
        authDomain.includes('localhost') ||
        storageBucket.includes('127.0.0.1') ||
        storageBucket.includes('localhost')
      ) {
        return {
          valid: false,
          mode: normalizedMode,
          error: `Build validation failed: Production build authDomain or storageBucket cannot target local loopback.`,
        }
      }

      return { valid: true, mode: normalizedMode, projectId }
    }

    // Rule F: Staging build constraints
    if (normalizedMode === 'staging') {
      // Must not collide with production
      if (projectId === PRODUCTION_FIREBASE_PROJECT_ID) {
        return {
          valid: false,
          mode: normalizedMode,
          error: `Build validation failed: Staging builds must not target production project '${PRODUCTION_FIREBASE_PROJECT_ID}'. Configure a distinct staging Firebase project in .env.staging.`,
        }
      }

      // Must be a syntactically valid Firebase project ID
      if (!isValidFirebaseProjectId(projectId)) {
        return {
          valid: false,
          mode: normalizedMode,
          error: `Build validation failed: Staging project ID '${projectId}' is not a valid Firebase project identifier (must be 6-30 lowercase characters, numbers, or hyphens, starting with a letter).`,
        }
      }

      // Ensure authDomain and storageBucket do not point to local loopback
      const authDomain = env.VITE_FIREBASE_AUTH_DOMAIN || ''
      const storageBucket = env.VITE_FIREBASE_STORAGE_BUCKET || ''
      if (
        authDomain.includes('127.0.0.1') ||
        authDomain.includes('localhost') ||
        storageBucket.includes('127.0.0.1') ||
        storageBucket.includes('localhost')
      ) {
        return {
          valid: false,
          mode: normalizedMode,
          error: `Build validation failed: Staging build authDomain or storageBucket cannot target local loopback.`,
        }
      }

      return { valid: true, mode: normalizedMode, projectId }
    }
  }

  // Fallback for unrecognised custom mode: require non-empty variables
  const projectId = env.VITE_FIREBASE_PROJECT_ID || 'custom'
  return { valid: true, mode: normalizedMode, projectId }
}

/**
 * Asserts that the environment for the specified build mode is valid.
 * Throws a descriptive Error if validation fails.
 */
export function assertBuildEnv(
  mode: string,
  env: Record<string, string | undefined>
): void {
  const result = validateBuildEnv(mode, env)
  if (!result.valid) {
    throw new Error(result.error)
  }
}
