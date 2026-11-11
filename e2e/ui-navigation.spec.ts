import { test, expect } from '@playwright/test'

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`Shared themes, Overview creation, notifications and initial Insights at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.addInitScript(() => localStorage.setItem('spenza_people_onboarding_test', 'true'))
    await page.goto('/login')
    await page.locator('#emulator-test-email-input').fill(`ui-${viewport.width}-${Date.now()}@example.com`)
    await page.locator('#emulator-test-sign-in-btn').click()
    await expect(page.locator('#overview-add-btn')).toBeVisible()
    await page.goto('/app/settings')
    const appearance = page
    for (const mode of ['dark', 'light'] as const) {
      await appearance.getByRole('button', { name: mode, exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode)
      await expect(appearance.getByRole('button', { name: mode, exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator(`#theme-toggle-btn .lucide-${mode === 'dark' ? 'moon' : 'sun'}`)).toBeVisible()
      await page.screenshot({ path: `test-results/settings-${viewport.width}-${mode}.png`, fullPage: true })
    }
    await page.locator('#theme-toggle-btn').click()
    await expect(appearance.getByRole('button', { name: 'dark', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await appearance.getByRole('button', { name: 'system', exact: true }).click()
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    await page.goto('/app/insights')
    await expect(page.getByText('Not enough data yet', { exact: true })).toBeVisible()
    await page.goto('/app')
    for (let i = 1; i <= 3; i++) {
      await page.locator('#overview-add-btn').click()
      await page.locator('#amount-input').fill('123')
      await page.locator('#description-input').fill(`Overview purchase ${i}`)
      await page.locator('button[title="Health & Medical"]').first().click()
      await page.locator('#submit-expense-btn').click()
      await expect(page.locator('#add-expense-form')).toBeHidden()
      await expect(page.getByText(`Overview purchase ${i}`, { exact: true }).first()).toBeVisible()
      await expect(page).toHaveURL(/\/app$/)
    }
    await expect(page.getByText('₹369', { exact: true }).first()).toBeVisible()
    const notice = page.getByRole('status').filter({ hasText: /Expense (saved|pending)/ })
    await expect(notice).toBeVisible()
    await expect.poll(() => notice.evaluate(element => {
      const box = element.getBoundingClientRect()
      const header = document.querySelector('header')!.getBoundingClientRect()
      const action = document.querySelector('#overview-add-btn')!.getBoundingClientRect()
      return box.top >= header.bottom && box.bottom <= action.top
    })).toBe(true)
    await page.screenshot({ path: `test-results/overview-${viewport.width}.png`, fullPage: true })

    // Seed the exact legacy cache representation through the isolated emulator.
    const uid = await page.evaluate(async () => {
      // @ts-expect-error Vite resolves browser modules at runtime.
      const { auth } = await import('/src/firebase/config.ts')
      // @ts-expect-error Vite resolves browser modules at runtime.
      const { computeAndCacheInsights } = await import('/src/services/insights.ts')
      await computeAndCacheInsights(auth.currentUser.uid)
      return auth.currentUser.uid as string
    })
    const cacheUrl = `http://127.0.0.1:8080/v1/projects/demo-spenza-test/databases/(default)/documents/users/${uid}/insights/summary`
    await expect.poll(async () => (await page.request.get(cacheUrl, { headers: { Authorization: 'Bearer owner' } })).status()).toBe(200)
    const patched = await page.request.patch(`${cacheUrl}?updateMask.fieldPaths=computedAt`, {
      headers: { Authorization: 'Bearer owner' },
      data: { fields: { computedAt: { mapValue: { fields: {
        seconds: { integerValue: String(Math.floor(Date.now() / 1000)) }, nanoseconds: { integerValue: '0' },
      } } } } },
    })
    expect(patched.ok()).toBeTruthy()
    await page.goto('/app/insights')
    await expect(page.getByText('Failed to load insights. Please try again.')).toHaveCount(0)
    await expect(page.getByText(/Updated /).first()).toBeVisible()
    await page.reload()
    await expect(page.getByText(/Updated /).first()).toBeVisible()
    await page.screenshot({ path: `test-results/insights-${viewport.width}.png`, fullPage: true })
  })
}
