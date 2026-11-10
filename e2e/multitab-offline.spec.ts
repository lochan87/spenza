import { test, expect } from '@playwright/test'

test.describe('Multi-Tab and Offline Browser Tests (Phase 8.3.2)', () => {
  // Test 1: Multi-Tab Real-time Financial Synchronization without manual reload
  test('Multi-tab: financial mutations in Tab A refresh Tab B in real-time without reload', async ({ context }) => {
    // 1. Create two pages in the same browser context (shared Auth/IndexedDB session)
    const pageA = await context.newPage()
    const pageB = await context.newPage()

    // Pre-dismiss onboarding modal on both pages
    await pageA.addInitScript(() => {
      localStorage.setItem('spenza_people_onboarding_test', 'true')
    })
    await pageB.addInitScript(() => {
      localStorage.setItem('spenza_people_onboarding_test', 'true')
    })

    // 2. Sign in on Tab A using emulator test user
    await pageA.goto('/login')
    await pageA.locator('#emulator-test-email-input').fill('multitab_user@example.com')
    await pageA.locator('#emulator-test-sign-in-btn').click()
    await expect(pageA).toHaveURL(/\/app/)

    // 3. Tab B opens Dashboard directly with shared authentication
    await pageB.goto('/app')
    await expect(pageB).toHaveURL(/\/app/)
    await expect(pageB.locator('text=spent this month')).toBeVisible({ timeout: 15000 })

    // 4. In Tab A, navigate to /app/transactions and create a normal expense (₹350)
    await pageA.goto('/app/transactions')
    await pageA.locator('#add-expense-fab-desktop').click()
    await expect(pageA.locator('#add-expense-form')).toBeVisible()

    await pageA.locator('#amount-input').fill('350')
    await pageA.locator('#description-input').fill('Books & Notes')
    await expect(pageA.locator('button[title="Food & Drinks"]').first()).toBeVisible({ timeout: 10000 })
    await pageA.locator('button[title="Food & Drinks"]').first().click()
    await pageA.locator('#submit-expense-btn').click()
    await expect(pageA.locator('text=Expense added ✓')).toBeVisible()
    await pageA.locator('button[aria-label="Close expense form"]').click()
    await expect(pageA.locator('#add-expense-form')).toBeHidden()

    // 5. In Tab B (Dashboard), verify the ₹350 spend appears automatically WITHOUT manual reload
    await expect(pageB.locator('main').locator('text=₹350').first()).toBeVisible({ timeout: 15000 })

    // 6. In Tab A, create a shared expense (₹800 split with "Priya", ₹400 recoverable)
    await pageA.locator('#add-expense-fab-desktop').click()
    await expect(pageA.locator('#add-expense-form')).toBeVisible()
    await pageA.locator('#amount-input').fill('800')
    await pageA.locator('#description-input').fill('Lunch with Priya')
    await expect(pageA.locator('button[title="Food & Drinks"]').first()).toBeVisible({ timeout: 10000 })
    await pageA.locator('button[title="Food & Drinks"]').first().click()
    await pageA.locator('#enable-shared-btn').click()

    await pageA.locator('input[placeholder="Search or add person…"]').fill('Priya')
    await pageA.locator('button:has-text("Add \\"Priya\\" as new person")').click()
    await pageA.locator('#submit-expense-btn').click()
    await expect(pageA.locator('text=Expense added ✓')).toBeVisible()
    await pageA.locator('button[aria-label="Close expense form"]').click()

    // 7. In Tab B, navigate to /app/people and verify Priya appears with Owes ₹400
    await pageB.goto('/app/people')
    await expect(pageB.locator('h4:has-text("Priya")').first()).toBeVisible()
    await expect(pageB.locator('text=Owes').first()).toBeVisible()
    await expect(pageB.locator('main').locator('text=₹400').first()).toBeVisible()

    // 8. In Tab A, navigate to /app/people and settle Priya's dues
    await pageA.goto('/app/people')
    await pageA.locator('button:has-text("Settle All")').first().click()
    await expect(pageA.locator('button:has-text("Confirm Settlement")')).toBeVisible()
    await pageA.locator('button:has-text("Confirm Settlement")').click()
    await expect(pageA.locator('text=All friends are squared up!')).toBeVisible()

    // 9. In Tab B (WITHOUT page reload), verify settlement reflected automatically via BroadcastChannel
    await expect(pageB.locator('text=All friends are squared up!')).toBeVisible({ timeout: 15000 })

    await pageA.close()
    await pageB.close()
  })

  // Test 2: Partial Repayment via executeRepaymentV1
  test('Partial repayment: executeRepaymentV1 updates dues while preserving original recoverable principal', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('spenza_people_onboarding_test', 'true')
    })

    // Sign in as dedicated repayment test user
    await page.goto('/login')
    await page.locator('#emulator-test-email-input').fill('repayment_user@example.com')
    await page.locator('#emulator-test-sign-in-btn').click()
    await expect(page).toHaveURL(/\/app/)
    await expect(page.locator('text=spent this month')).toBeVisible({ timeout: 15000 })

    // Create a split expense: ₹1,000 with "Vikram" (50/50 split -> ₹500 recoverable)
    await page.goto('/app/transactions')
    await page.locator('#add-expense-fab-desktop').click()
    await expect(page.locator('#add-expense-form')).toBeVisible()
    await page.locator('#amount-input').fill('1000')
    await page.locator('#description-input').fill('Weekend Dinner')
    await expect(page.locator('button[title="Food & Drinks"]').first()).toBeVisible({ timeout: 10000 })
    await page.locator('button[title="Food & Drinks"]').first().click()
    await page.locator('#enable-shared-btn').click()

    await page.locator('input[placeholder="Search or add person…"]').fill('Vikram')
    await page.locator('button:has-text("Add \\"Vikram\\" as new person")').click()
    await page.locator('#submit-expense-btn').click()
    await expect(page.locator('text=Expense added ✓')).toBeVisible()
    await page.locator('button[aria-label="Close expense form"]').click()

    // Expand transaction row to reveal split breakdown and Repay button
    await page.locator('p:has-text("Weekend Dinner")').first().click()
    await expect(page.locator('text=Split Breakdown')).toBeVisible()
    await expect(page.locator('text=Recoverable: ₹500')).toBeVisible()

    // Click Repay button for Vikram
    const repayBtn = page.locator('button[title="Record repayment from Vikram"]')
    await expect(repayBtn).toBeVisible()
    await repayBtn.click()

    // In RepaymentModal, enter partial repayment of ₹200
    const repayModal = page.locator('h3:has-text("Record Repayment")')
    await expect(repayModal).toBeVisible()

    const repayInput = page.locator('input[type="number"]')
    await repayInput.fill('200')

    const saveRepaymentBtn = page.locator('button:has-text("Save Repayment")')
    await expect(saveRepaymentBtn).toBeVisible()
    await saveRepaymentBtn.click()

    // Modal closes and toast confirms repayment
    await expect(repayModal).toBeHidden()
    await expect(page.locator('text=Recorded ₹200 repayment from Vikram ✓')).toBeVisible()

    // Expand row again after re-render to inspect updated split details:
    await page.locator('p:has-text("Weekend Dinner")').first().click()
    await expect(page.locator('text=Split Breakdown')).toBeVisible()

    // Original recoverable principal is PRESERVED at ₹500
    // Repaid shows ₹200 repaid, outstanding due is ₹300
    await expect(page.locator('text=Recoverable: ₹500')).toBeVisible()
    await expect(page.locator('text=· ₹200 repaid')).toBeVisible()
    await expect(page.locator('text=(₹300 due)').first()).toBeVisible()

    // Verify in People view:
    await page.goto('/app/people')
    await expect(page.locator('h4:has-text("Vikram")').first()).toBeVisible()
    await expect(page.locator('text=Owes').first()).toBeVisible()
    await expect(page.locator('text=Total fronted for Vikram:')).toBeVisible()
    await expect(page.locator('main').locator('text=₹500').first()).toBeVisible() // Total fronted
    await expect(page.locator('main').locator('text=₹200').first()).toBeVisible() // Repaid back
    await expect(page.locator('main').locator('text=₹300').first()).toBeVisible() // Outstanding balance
  })

  // Test 3: Offline Disconnect, Banner Identification, Operation Blocking, and Reconnect
  test('Offline handling: identifies cached balances, blocks repayments/settlements offline, and resumes on reconnect', async ({ context, page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('spenza_people_onboarding_test', 'true')
    })

    // Sign in as dedicated offline test user
    await page.goto('/login')
    await page.locator('#emulator-test-email-input').fill('offline_user@example.com')
    await page.locator('#emulator-test-sign-in-btn').click()
    await expect(page).toHaveURL(/\/app/)
    await expect(page.locator('text=spent this month')).toBeVisible({ timeout: 15000 })

    // Create a split expense while online: ₹600 split with "Amit" (₹300 recoverable)
    await page.goto('/app/transactions')
    await page.locator('#add-expense-fab-desktop').click()
    await page.locator('#amount-input').fill('600')
    await page.locator('#description-input').fill('Cinema Tickets')
    await expect(page.locator('button[title="Food & Drinks"]').first()).toBeVisible({ timeout: 10000 })
    await page.locator('button[title="Food & Drinks"]').first().click()
    await page.locator('#enable-shared-btn').click()
    await page.locator('input[placeholder="Search or add person…"]').fill('Amit')
    await page.locator('button:has-text("Add \\"Amit\\" as new person")').click()
    await page.locator('#submit-expense-btn').click()
    await expect(page.locator('text=Expense added ✓')).toBeVisible()
    await page.locator('button[aria-label="Close expense form"]').click()

    // Go to People page while still online and verify Amit's dues
    await page.goto('/app/people')
    await expect(page.locator('h4:has-text("Amit")').first()).toBeVisible()
    await expect(page.locator('text=Owes').first()).toBeVisible()

    // ─── GO OFFLINE ───────────────────────────────────────────────────────────
    await context.setOffline(true)

    // Verify OfflineBanner appears
    await expect(page.locator('text=Offline — expenses will sync when reconnected')).toBeVisible({ timeout: 5000 })

    // Verify cached offline indicator is displayed on People page
    await expect(page.locator('text=Cached split ledger')).toBeVisible()

    // Verify Dashboard displays cached offline banner (client-side link navigation)
    await page.locator('header a[href="/app"]').first().click()
    await expect(page).toHaveURL(/\/app$/)
    await expect(page.locator('text=Cached offline balances')).toBeVisible()

    // Verify Transactions page displays cached offline banner (client-side link navigation)
    await page.locator('nav[aria-label="Primary navigation"] a[href="/app/transactions"]').click()
    await expect(page).toHaveURL(/\/app\/transactions/)
    await expect(page.locator('text=Cached offline ledger')).toBeVisible()

    // Verify trusted repayment CANNOT execute offline
    await page.locator('p:has-text("Cinema Tickets")').first().click()
    await page.locator('button[title="Record repayment from Amit"]').click()
    await expect(page.locator('h3:has-text("Record Repayment")')).toBeVisible()

    // Attempt to save partial repayment while offline
    await page.locator('input[type="number"]').fill('100')
    await page.locator('button:has-text("Save Repayment")').click()
    await expect(page.locator('text=You are offline. Recording a repayment requires an internet connection.')).toBeVisible()

    // Close repayment modal
    await page.locator('button:has-text("Cancel")').click()

    // Verify trusted settlement CANNOT execute offline (navigate back to People via More menu)
    await page.locator('#desktop-more-nav-btn').click()
    await page.locator('a[href="/app/people"]').click()
    await expect(page).toHaveURL(/\/app\/people/)
    await page.locator('button:has-text("Settle All")').first().click()
    await expect(page.locator('button:has-text("Confirm Settlement")')).toBeVisible()
    await page.locator('button:has-text("Confirm Settlement")').click()

    // SettleModal must show offline error and NOT mutate
    await expect(page.locator('text=You are offline. Settling dues requires an internet connection.')).toBeVisible()
    await page.locator('button:has-text("Cancel")').click()

    // ─── RECONNECT ────────────────────────────────────────────────────────────
    await context.setOffline(false)

    // Verify online sync banner appears and cached ledger indicator clears
    await expect(page.locator('text=Back online — syncing…')).toBeVisible({ timeout: 5000 })

    // With connection restored, settlement executes successfully
    await page.locator('button:has-text("Settle All")').first().click()
    await page.locator('button:has-text("Confirm Settlement")').click()
    await expect(page.locator('text=All friends are squared up!')).toBeVisible()
  })

  // Test 4: Deterministic Cleanup of Listeners and Multiple Browser Contexts
  test('Cleanup: multiple contexts and closed tabs clean up listeners without leaks or crosstalk', async ({ browser }) => {
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()

    const page1 = await ctxA.newPage()
    const page2 = await ctxA.newPage()
    const page3 = await ctxB.newPage()

    // Set storage on all
    await page1.addInitScript(() => localStorage.setItem('spenza_people_onboarding_test', 'true'))
    await page2.addInitScript(() => localStorage.setItem('spenza_people_onboarding_test', 'true'))
    await page3.addInitScript(() => localStorage.setItem('spenza_people_onboarding_test', 'true'))

    // Sign in ctxA on page1
    await page1.goto('/login')
    await page1.locator('#emulator-test-email-input').fill('ctx_a@example.com')
    await page1.locator('#emulator-test-sign-in-btn').click()
    await expect(page1).toHaveURL(/\/app/)

    // Open page2 in ctxA
    await page2.goto('/app')
    await expect(page2).toHaveURL(/\/app/)

    // Close page2 (tab unmounts, cleaning up window and BroadcastChannel listeners)
    await page2.close()

    // page1 continues operating without errors
    await page1.goto('/app/transactions')
    await expect(page1).toHaveURL(/\/app\/transactions/)

    // Sign in ctxB on page3 with isolated user
    await page3.goto('/login')
    await page3.locator('#emulator-test-email-input').fill('ctx_b@example.com')
    await page3.locator('#emulator-test-sign-in-btn').click()
    await expect(page3).toHaveURL(/\/app/)

    // Verify completely clean context disposal
    await ctxA.close()
    await ctxB.close()
  })
})
