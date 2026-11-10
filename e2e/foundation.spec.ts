import { test, expect } from '@playwright/test'

test.describe('Spenza E2E Foundation', () => {
  test.beforeEach(async ({ page }) => {
    // Pre-dismiss people onboarding in localStorage to avoid modal race conditions
    await page.addInitScript(() => {
      localStorage.setItem('spenza_people_onboarding_test', 'true')
    })
    // Navigate to root
    await page.goto('/')
  })

  test('Application startup and navigation redirects unauthenticated users to login', async ({ page }) => {
    // Should redirect to /login
    await expect(page).toHaveURL(/\/login/)

    // Brand and login elements should be visible
    await expect(page.locator('img[alt="Spenza"]')).toBeVisible()
    await expect(page.locator('#google-sign-in-btn')).toBeVisible()
    await expect(page.locator('#emulator-test-sign-in-btn')).toBeVisible()
  })

  test('End-to-end lifecycle: Auth, Expense logging, Split bills, Settlement, and Persistence', async ({ page }) => {
    // 1. Authenticate with emulator test user
    await page.locator('#emulator-test-sign-in-btn').click()

    await expect(page).toHaveURL(/\/app/)

    // Handle onboarding modal if it appears
    const skipOnboarding = page.locator('button:has-text("Skip for now")')
    if (await skipOnboarding.isVisible({ timeout: 3000 }).catch(() => false)) {
      await skipOnboarding.click()
    }

    await expect(page.locator('text=spent this month')).toBeVisible({ timeout: 15000 })

    // 2. Create a normal expense (₹450 on Coffee & Snacks)
    await page.goto('/app/transactions')
    await expect(page).toHaveURL(/\/app\/transactions/)

    // Open Add Expense form
    const addExpenseBtn = page.locator('#add-expense-fab-desktop')
    await addExpenseBtn.click()

    await expect(page.locator('#add-expense-form')).toBeVisible()

    // Fill form
    await page.locator('#amount-input').fill('450')
    await page.locator('#description-input').fill('Coffee & Snacks')

    // Select category 'Food & Drinks'
    await expect(page.locator('button[title="Food & Drinks"]').first()).toBeVisible({ timeout: 10000 })
    await page.locator('button[title="Food & Drinks"]').first().click()

    // Submit expense
    await page.locator('#submit-expense-btn').click()
    await expect(page.locator('text=Expense added ✓')).toBeVisible()

    // Close the drawer
    await page.locator('button[aria-label="Close expense form"]').click()
    await expect(page.locator('#add-expense-form')).toBeHidden()

    // Verify expense listed in Transactions
    await expect(page.locator('text=Coffee & Snacks').first()).toBeVisible()
    await expect(page.locator('text=₹450').first()).toBeVisible()

    // Verify it appears in Dashboard
    await page.goto('/app')
    await expect(page.locator('main').locator('text=₹450').first()).toBeVisible()

    // 3. Create a split expense (₹1,000 Dinner with Rahul, 50/50 split)
    await page.goto('/app/transactions')
    await addExpenseBtn.click()
    await expect(page.locator('#add-expense-form')).toBeVisible()

    await page.locator('#amount-input').fill('1000')
    await page.locator('#description-input').fill('Dinner with Rahul')
    await expect(page.locator('button[title="Food & Drinks"]')).toBeVisible({ timeout: 10000 })
    await page.locator('button[title="Food & Drinks"]').click()

    // Enable sharing
    await page.locator('#enable-shared-btn').click()

    // Add "Rahul" as participant
    const personSearch = page.locator('input[placeholder="Search or add person…"]')
    await personSearch.fill('Rahul')
    const addRahulBtn = page.locator('button:has-text("Add \\"Rahul\\" as new person")')
    await addRahulBtn.click()

    // Submit split expense
    await page.locator('#submit-expense-btn').click()
    await expect(page.locator('text=Expense added ✓')).toBeVisible()

    // Close drawer
    await page.locator('button[aria-label="Close expense form"]').click()
    await expect(page.locator('#add-expense-form')).toBeHidden()

    await expect(page.locator('text=Dinner with Rahul').first()).toBeVisible()

    // 4. Verify People balances
    await page.goto('/app/people')
    await expect(page.locator('h4:has-text("Rahul")').first()).toBeVisible()
    await expect(page.locator('text=Owes').first()).toBeVisible()
    await expect(page.locator('main').locator('text=₹500').first()).toBeVisible()

    // 5. Record repayment / Settle dues
    const settleAllBtn = page.locator('button:has-text("Settle All")').first()
    await settleAllBtn.click()

    // In SettleModal, confirm settlement
    const confirmSettleBtn = page.locator('button:has-text("Confirm Settlement")')
    await expect(confirmSettleBtn).toBeVisible()
    await confirmSettleBtn.click()

    // Verify Pending Dues updates to ₹0 and all friends are squared up
    await expect(page.locator('text=All friends are squared up!')).toBeVisible()
    await expect(page.locator('text=No friends with pending dues!')).toBeVisible()

    // Switch to "All Friends" tab and verify Rahul shows "All Settled"
    await page.locator('button:has-text("All Friends")').click()
    await expect(page.locator('h4:has-text("Rahul")').first()).toBeVisible()
    await expect(page.locator('text=All Settled').first()).toBeVisible()

    // 6. Browser refresh persistence
    await page.reload()
    await page.locator('button:has-text("All Friends")').click()
    await expect(page.locator('h4:has-text("Rahul")').first()).toBeVisible()
    await expect(page.locator('text=All Settled').first()).toBeVisible()

    // Verify transactions persist
    await page.goto('/app/transactions')
    await expect(page.locator('text=Dinner with Rahul').first()).toBeVisible()
    await expect(page.locator('text=Coffee & Snacks').first()).toBeVisible()
    await expect(page.locator('text=Settled').first()).toBeVisible()

    // Verify Dashboard total spent is ₹950 (₹450 personal coffee + ₹500 net personal share of dinner)
    await page.goto('/app')
    await expect(page.locator('main').locator('text=₹950').first()).toBeVisible()
  })
})
