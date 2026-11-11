import { test, expect } from '@playwright/test'

test.describe('Offline Data Safety & Recovery (Phase 10.1)', () => {
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

    // 3. Navigate to transactions while still online
    await page.goto('/app/transactions')
    await expect(page).toHaveURL(/\/app\/transactions/)

    // 4. Disconnect network
    await context.setOffline(true)

    // Verify initial offline banner
    await expect(page.locator('text=Offline — expenses will sync when reconnected')).toBeVisible({ timeout: 5000 })

    // 5. Create an expense while offline: ₹550 for "Offline First Aid"
    await page.locator('#add-expense-fab-desktop').click()
    await expect(page.locator('#add-expense-form')).toBeVisible()

    await page.locator('#amount-input').fill('550')
    await page.locator('#description-input').fill('Offline First Aid')
    await expect(page.locator('button[title="Health & Medical"]').first()).toBeVisible({ timeout: 10000 })
    await page.locator('button[title="Health & Medical"]').first().click()
    await page.locator('#submit-expense-btn').click()

    await expect(page.locator('text=Expense added ✓')).toBeVisible()
    await page.locator('button[aria-label="Close expense form"]').click()

    // 6. Verify expense appears locally in the list immediately with offline indicator
    await expect(page.locator('p:has-text("Offline First Aid")').first()).toBeVisible()
    await expect(page.locator('main').locator('text=₹550').first()).toBeVisible()

    // Verify OfflineBanner reflects unsaved changes pending sync
    await expect(page.locator('text=Offline — unsaved changes will sync when reconnected')).toBeVisible({ timeout: 5000 })

    // 7. User attempts to sign out while offline and has pending writes
    await page.locator('#sign-out-btn').click()

    // Verify warning modal appears preventing accidental loss
    const warningModal = page.locator('div[role="dialog"][aria-modal="true"]')
    await expect(warningModal).toBeVisible()
    await expect(page.locator('#sign-out-warning-title')).toHaveText('Unsaved Offline Changes')
    await expect(
      page.locator('text=You have offline transactions or changes that have not synced to the server yet')
    ).toBeVisible()

    // 8. User chooses "Wait for Sync" (Cancel)
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

  test('Settings sign-out warning and data clear protection when offline', async ({ context, page }) => {
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

    // Go offline
    await context.setOffline(true)

    // Test sign out in Settings account section
    await page.locator('#settings-sign-out-btn').click()

    // Modal appears with "You're Offline" warning
    const warningModal = page.locator('div[role="dialog"][aria-modal="true"]')
    await expect(warningModal).toBeVisible()
    await expect(page.locator('#sign-out-warning-title')).toHaveText("You're Offline")

    // Stay signed in
    await page.locator('#cancel-sign-out-btn').click()
    await expect(warningModal).toBeHidden()
    await expect(page).toHaveURL(/\/app\/settings/)

    // Reconnect network
    await context.setOffline(false)
  })
})
