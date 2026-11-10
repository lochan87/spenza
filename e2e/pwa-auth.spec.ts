import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

test.describe('PWA and Authentication Reliability (Phase 8.3.3)', () => {
  // ─── Test 1: Authentication Session Persistence ────────────────────────────
  test('Auth session persistence: user remains authenticated after reload and tab reopen', async ({ context }) => {
    const page = await context.newPage()

    await page.addInitScript(() => {
      localStorage.setItem('spenza_people_onboarding_test', 'true')
    })

    // 1. Sign in using emulator test user
    await page.goto('/login')
    await page.locator('#emulator-test-email-input').fill('persistence_user@example.com')
    await page.locator('#emulator-test-sign-in-btn').click()
    await expect(page).toHaveURL(/\/app/)
    await expect(page.locator('text=spent this month')).toBeVisible({ timeout: 15000 })

    // 2. Reload the page (F5 / Refresh)
    await page.reload()

    // User must remain on /app without being bounced to /login
    await expect(page).toHaveURL(/\/app/)
    await expect(page.locator('text=spent this month')).toBeVisible({ timeout: 15000 })
    await expect(page.locator('#sign-out-btn')).toBeVisible()

    // 3. Close the page and open a new page in the same authenticated context
    await page.close()
    const page2 = await context.newPage()
    await page2.addInitScript(() => {
      localStorage.setItem('spenza_people_onboarding_test', 'true')
    })

    await page2.goto('/app')
    await expect(page2).toHaveURL(/\/app/)
    await expect(page2.locator('text=spent this month')).toBeVisible({ timeout: 15000 })

    // Verify access to inner protected sub-route
    await page2.goto('/app/transactions')
    await expect(page2).toHaveURL(/\/app\/transactions/)
    await expect(page2.locator('h1:has-text("Transactions")')).toBeVisible()

    await page2.close()
  })

  // ─── Test 2: Cross-Tab Logout & Protected Financial Route Enforcement ───────
  test('Cross-tab logout: signing out in Tab A forces Tab B to /login and rejects protected routes', async ({ context }) => {
    const tabA = await context.newPage()
    const tabB = await context.newPage()

    await tabA.addInitScript(() => localStorage.setItem('spenza_people_onboarding_test', 'true'))
    await tabB.addInitScript(() => localStorage.setItem('spenza_people_onboarding_test', 'true'))

    // 1. Sign in on Tab A
    await tabA.goto('/login')
    await tabA.locator('#emulator-test-email-input').fill('crosstab_logout_user@example.com')
    await tabA.locator('#emulator-test-sign-in-btn').click()
    await expect(tabA).toHaveURL(/\/app/)

    // 2. Tab B navigates to /app/transactions
    await tabB.goto('/app/transactions')
    await expect(tabB).toHaveURL(/\/app\/transactions/)
    await expect(tabB.locator('h1:has-text("Transactions")')).toBeVisible()

    // 3. In Tab A, initiate Sign Out
    const signOutBtn = tabA.locator('#sign-out-btn')
    await expect(signOutBtn).toBeVisible()
    await signOutBtn.click()

    // Tab A redirects to /login
    await expect(tabA).toHaveURL(/\/login/)

    // 4. Tab B's onAuthStateChanged observer detects session termination and redirects to /login automatically
    await expect(tabB).toHaveURL(/\/login/, { timeout: 15000 })

    // 5. In Tab B, attempt direct navigation to protected financial routes
    await tabB.goto('/app/transactions')
    await expect(tabB).toHaveURL(/\/login/)

    await tabB.goto('/app/people')
    await expect(tabB).toHaveURL(/\/login/)

    await tabB.goto('/app/budgets')
    await expect(tabB).toHaveURL(/\/login/)

    await tabB.goto('/app/insights')
    await expect(tabB).toHaveURL(/\/login/)

    await tabA.close()
    await tabB.close()
  })

  // ─── Test 3: Popup Sign-In Fallback & Redirect Resolution Safety ────────────
  test('Popup sign-in fallback and redirect resolution safety', async ({ page }) => {
    // Navigate to login
    await page.goto('/login')

    // Verify Google Sign-In button is present and ready
    const googleBtn = page.locator('#google-sign-in-btn')
    await expect(googleBtn).toBeVisible()

    // Verify that LoginPage initializes redirect result check without unhandled errors
    // (handleRedirectResult runs on mount and resolves gracefully when no redirect occurred)
    await expect(page.locator('text=Sign-in redirect failed')).toBeHidden()
    await expect(page.locator('text=Sign in failed')).toBeHidden()
  })

  // ─── Test 4: Production Build Security: Leakage Verification ────────────────
  test('Production build security: emulator test credentials and bypasses are pruned from distribution bundle', async () => {
    const distPath = path.resolve(process.cwd(), 'dist')
    expect(fs.existsSync(distPath)).toBe(true)

    const assetsPath = path.join(distPath, 'assets')
    expect(fs.existsSync(assetsPath)).toBe(true)

    const files = fs.readdirSync(assetsPath)
    const jsBundles = files.filter(f => f.endsWith('.js'))
    expect(jsBundles.length).toBeGreaterThan(0)

    let combinedJs = ''
    for (const bundle of jsBundles) {
      combinedJs += fs.readFileSync(path.join(assetsPath, bundle), 'utf-8')
    }

    // 1. Emulator-only test button ID must not be present in compiled JS
    expect(combinedJs.includes('emulator-test-sign-in-btn')).toBe(false)
    expect(combinedJs.includes('emulator-test-email-input')).toBe(false)

    // 2. Test user sign-in credential function must not leak into production bundle
    expect(combinedJs.includes('signInAsTestUser')).toBe(false)

    // 3. Onboarding test bypass flag must be guarded by VITE_USE_FIREBASE_EMULATOR
    // In production build without emulator flag, the test bypass condition is dead-code eliminated
    expect(combinedJs.includes('spenza_people_onboarding_test')).toBe(false)
  })

  // ─── Test 5: PWA Manifest Prerequisites & Installability ───────────────────
  test('PWA installability and manifest prerequisites in production build', async () => {
    const manifestPath = path.resolve(process.cwd(), 'dist', 'manifest.webmanifest')
    expect(fs.existsSync(manifestPath)).toBe(true)

    const rawManifest = fs.readFileSync(manifestPath, 'utf-8')
    const manifest = JSON.parse(rawManifest)

    // Verify required PWA installability fields
    expect(manifest.name).toBe('Spenza')
    expect(manifest.short_name).toBe('Spenza')
    expect(manifest.start_url).toBe('/app')
    expect(manifest.display).toBe('standalone')
    expect(manifest.theme_color).toBe('#14B8A6')
    expect(manifest.background_color).toBe('#0F172A')

    // Verify icon declarations
    expect(Array.isArray(manifest.icons)).toBe(true)
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2)

    const has192 = manifest.icons.some((i: any) => i.sizes === '192x192')
    const has512 = manifest.icons.some((i: any) => i.sizes === '512x512')
    const hasMaskable = manifest.icons.some((i: any) => i.purpose?.includes('maskable'))

    expect(has192).toBe(true)
    expect(has512).toBe(true)
    expect(hasMaskable).toBe(true)

    // Verify icons exist on disk
    for (const icon of manifest.icons) {
      const cleanSrc = icon.src.replace(/^\//, '')
      const iconPath = path.resolve(process.cwd(), 'public', cleanSrc)
      const altIconPath = path.resolve(process.cwd(), 'dist', cleanSrc)
      const exists = fs.existsSync(iconPath) || fs.existsSync(altIconPath)
      expect(exists).toBe(true)
    }

    // Verify index.html links to manifest and registers service worker
    const htmlPath = path.resolve(process.cwd(), 'dist', 'index.html')
    const htmlContent = fs.readFileSync(htmlPath, 'utf-8')
    expect(htmlContent.includes('rel="manifest"')).toBe(true)
    expect(htmlContent.includes('manifest.webmanifest')).toBe(true)
    expect(htmlContent.includes('registerSW.js')).toBe(true)
  })

  // ─── Test 6: Service Worker Registration, Precaching & Form Safety ─────────
  test('Service worker registration, asset precaching, and active form update safety', async () => {
    // 1. Verify dist/sw.js exists and precaches essential assets
    const swPath = path.resolve(process.cwd(), 'dist', 'sw.js')
    expect(fs.existsSync(swPath)).toBe(true)

    const swContent = fs.readFileSync(swPath, 'utf-8')
    // Must contain precache manifest injection from Workbox
    expect(swContent.includes('precacheAndRoute')).toBe(true)

    // 2. Verify registerSW.js registers SW safely
    const regSwPath = path.resolve(process.cwd(), 'dist', 'registerSW.js')
    expect(fs.existsSync(regSwPath)).toBe(true)

    const regSwContent = fs.readFileSync(regSwPath, 'utf-8')
    expect(regSwContent.includes('serviceWorker.register')).toBe(true)

    // CRITICAL: Must NOT contain forced window.location.reload() which would wipe active form state
    expect(regSwContent.includes('window.location.reload')).toBe(false)
    expect(regSwContent.includes('location.reload()')).toBe(false)
  })
})

