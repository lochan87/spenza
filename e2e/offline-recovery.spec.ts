import { test, expect } from '@playwright/test'

test.describe('Offline Data Safety & Recovery (Phase 10.1)', () => {
  // ─── Test 1: Full Lifecycle: Offline Creation, Warning, Cancel, Reconnect ────
  test('Offline expense creation, pending write warning on sign-out, and reconnect synchronization', async ({
    context,
    page,
  }) => {
    // 1. Pre-dismiss onboarding modal
    await page.addInitScript(() => {
      localStorage.setItem('spenza_people_onboarding_test', 'true')
    })

    // 2. Sign in using emulator test user
    await page.goto('/login')
    await page.locator('#emulator-test-email-input').fill('offline_safety_user@example.com')
    await page.locator('#emulator-test-sign-in-btn').click()
    await expect(page).toHaveURL(/\/app/)
    await expect(page.locator('text=spent this month')).toBeVisible({ timeout: 15000 })

    // 3. Navigate to transactions while still online and wait for category readiness
    await page.goto('/app/transactions')
    await expect(page).toHaveURL(/\/app\/transactions/)
    await expect(page.locator('#add-expense-fab-desktop')).toBeVisible({ timeout: 10000 })

    // Open form once to guarantee default categories/accounts are loaded into component state
    await page.locator('#add-expense-fab-desktop').click()
    await expect(page.locator('#add-expense-form')).toBeVisible()
    await expect(page.locator('button[title="Health & Medical"]').first()).toBeVisible({ timeout: 10000 })
    await page.locator('button[aria-label="Close expense form"]').click()
    await expect(page.locator('#add-expense-form')).toBeHidden()

    // 4. Disconnect network
    await context.setOffline(true)

    // Verify initial offline banner
    await expect(page.locator('text=Offline — expenses will sync when reconnected')).toBeVisible({ timeout: 5000 })

    // 5. Create an expense while offline: ₹550 for "Offline First Aid"
    await page.locator('#add-expense-fab-desktop').click()
    await expect(page.locator('#add-expense-form')).toBeVisible()

    await page.locator('#amount-input').fill('550')
    await page.locator('#description-input').fill('Offline First Aid')
    await page.locator('button[title="Health & Medical"]').first().click()
    await page.locator('#submit-expense-btn').click()

    await expect(page.locator('text=Expense added ✓')).toBeVisible()
    await page.locator('button[aria-label="Close expense form"]').click()

    // 6. Verify expense appears locally in the list immediately with offline indicator
    await expect(page.locator('p:has-text("Offline First Aid")').first()).toBeVisible()
    await expect(page.locator('main').locator('text=₹550').first()).toBeVisible()

    // Verify OfflineBanner reflects unsaved changes pending sync
    await expect(
      page.locator('text=Offline — unsaved changes will sync when reconnected')
    ).toBeVisible({ timeout: 5000 })

    // 7. User attempts to sign out from header while offline and has pending writes
    await page.locator('#sign-out-btn').click()

    // Verify warning modal appears preventing accidental loss
    const warningModal = page.locator('div[role="dialog"][aria-modal="true"]')
    await expect(warningModal).toBeVisible()
    await expect(page.locator('#sign-out-warning-title')).toHaveText('Unsaved Offline Changes')
    await expect(
      page.locator('text=You have offline transactions or changes that have not synced to the server yet')
    ).toBeVisible()

    // 8. User chooses "Wait for Sync" (Cancel action)
    await page.locator('#cancel-sign-out-btn').click()
    await expect(warningModal).toBeHidden()
    await expect(page).toHaveURL(/\/app\/transactions/)
    await expect(page.locator('p:has-text("Offline First Aid")').first()).toBeVisible()

    // 9. Reconnect network
    await context.setOffline(false)

    // Verify banner updates to syncing
    await expect(page.locator('text=Back online — syncing…')).toBeVisible({ timeout: 5000 })

    // 10. Navigate to Dashboard (/app) to verify exact financial totals and no duplication
    await page.locator('nav[aria-label="Primary navigation"] a[href="/app"]').first().click()
    await expect(page).toHaveURL(/\/app$/)
    await expect(page.locator('main').locator('text=₹550').first()).toBeVisible({ timeout: 10000 })

    // Return to transactions and ensure there is only ONE "Offline First Aid" record
    await page.locator('nav[aria-label="Primary navigation"] a[href="/app/transactions"]').click()
    await expect(page).toHaveURL(/\/app\/transactions/)
    const matchingExpenses = page.locator('p:has-text("Offline First Aid")')
    await expect(matchingExpenses).toHaveCount(1)
  })

  // ─── Test 2: Settings Sign-Out, Proceed Action & Offline Destructive Guard ────
  test('Settings sign-out warning, proceed action, and offline destructive-operation guard', async ({
    context,
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('spenza_people_onboarding_test', 'true')
    })

    // Sign in
    await page.goto('/login')
    await page.locator('#emulator-test-email-input').fill('settings_offline_user@example.com')
    await page.locator('#emulator-test-sign-in-btn').click()
    await expect(page).toHaveURL(/\/app/)

    // Go to Settings page
    await page.goto('/app/settings')
    await expect(page).toHaveURL(/\/app\/settings/)
    await expect(page.locator('#reset-cache-btn')).toBeVisible({ timeout: 10000 })

    // Go offline
    await context.setOffline(true)

    // 1. Verify offline destructive operation guard (Insights Cache Reset)
    await page.locator('#reset-cache-btn').click()
    await expect(
      page.locator('text=You are offline. Resetting the Insights cache requires an internet connection.')
    ).toBeVisible({ timeout: 5000 })

    // 2. Test sign out in Settings account section
    await page.locator('#settings-sign-out-btn').click()

    // Modal appears with "You're Offline" warning
    const warningModal = page.locator('div[role="dialog"][aria-modal="true"]')
    await expect(warningModal).toBeVisible()
    await expect(page.locator('#sign-out-warning-title')).toHaveText("You're Offline")

    // Stay signed in test (Cancel action)
    await page.locator('#cancel-sign-out-btn').click()
    await expect(warningModal).toBeHidden()
    await expect(page).toHaveURL(/\/app\/settings/)

    // 3. Test Proceed action ("Sign Out Anyway")
    await page.locator('#settings-sign-out-btn').click()
    await expect(warningModal).toBeVisible()
    await page.locator('#confirm-sign-out-btn').click()

    // User is signed out and redirected to /login
    await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
    await expect(page.locator('#emulator-test-sign-in-btn')).toBeVisible()

    // Reconnect network
    await context.setOffline(false)
  })

  // ─── Test 3: Header Sign-Out Proceed Action with Pending Writes ───────────────
  test('Proceed action on header sign-out safely completes sign-out even with pending writes', async ({
    context,
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('spenza_people_onboarding_test', 'true')
    })

    // Sign in as dedicated user
    await page.goto('/login')
    await page.locator('#emulator-test-email-input').fill('proceed_user@example.com')
    await page.locator('#emulator-test-sign-in-btn').click()
    await expect(page).toHaveURL(/\/app/)

    // Navigate to transactions while online to prime state
    await page.goto('/app/transactions')
    await expect(page.locator('#add-expense-fab-desktop')).toBeVisible({ timeout: 10000 })

    // Disconnect network
    await context.setOffline(true)

    // Attempt sign out from header
    await page.locator('#sign-out-btn').click()

    // Warning dialog appears
    const warningModal = page.locator('div[role="dialog"][aria-modal="true"]')
    await expect(warningModal).toBeVisible()

    // Choose "Sign Out Anyway" (Proceed action)
    await page.locator('#confirm-sign-out-btn').click()

    // Confirms user is redirected to /login
    await expect(page).toHaveURL(/\/login/, { timeout: 10000 })
    await expect(page.locator('#emulator-test-sign-in-btn')).toBeVisible()

    // Reconnect network
    await context.setOffline(false)
  })

  // ─── Test 4: Cached Financial Data vs App-Shell Availability ─────────────────
  test('Cached financial-data availability in running SPA during offline state', async ({
    context,
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('spenza_people_onboarding_test', 'true')
    })

    // 1. Initial online visit: sign in and prime cache
    await page.goto('/login')
    await page.locator('#emulator-test-email-input').fill('cached_ledger_user@example.com')
    await page.locator('#emulator-test-sign-in-btn').click()
    await expect(page).toHaveURL(/\/app/)
    await expect(page.locator('text=spent this month')).toBeVisible({ timeout: 15000 })

    // Visit transactions to populate local IndexedDB cache
    await page.goto('/app/transactions')
    await expect(page.locator('h1:has-text("Transactions")')).toBeVisible()

    // 2. Disconnect network
    await context.setOffline(true)

    // 3. Client-side navigation in running SPA relies on Firestore persistentLocalCache
    // Navigate to Overview via internal link
    await page.locator('nav[aria-label="Primary navigation"] a[href="/app"]').first().click()
    await expect(page).toHaveURL(/\/app$/)
    await expect(page.locator('text=Cached offline balances')).toBeVisible({ timeout: 10000 })

    // Navigate back to Transactions via internal link
    await page.locator('nav[aria-label="Primary navigation"] a[href="/app/transactions"]').click()
    await expect(page).toHaveURL(/\/app\/transactions/)
    await expect(page.locator('text=Cached offline ledger')).toBeVisible({ timeout: 10000 })

    // Reconnect network
    await context.setOffline(false)
  })
})
