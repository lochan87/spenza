import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/hooks/useAuth'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { AppLayout } from '@/components/layout/AppLayout'
import { LoginPage } from '@/pages/LoginPage'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { TransactionsPage } from '@/features/transactions/TransactionsPage'
import { CategoriesPage } from '@/features/transactions/CategoriesPage'
import { TripsPage } from '@/features/trips/TripsPage'
import { TripDetailPage } from '@/features/trips/TripDetailPage'
import { RecurringPage } from '@/features/recurring/RecurringPage'
import { BudgetPage } from '@/features/budgets/BudgetPage'
import { InsightsPage } from '@/features/insights/InsightsPage'
import { ImportPage } from '@/features/import/ImportPage'
import { PeoplePage } from '@/features/people/PeoplePage'
import { PeopleOnboardingModal } from '@/features/people/components/PeopleOnboardingModal'
import { SettingsPage } from '@/features/settings/SettingsPage'
import { RecurringDuePrompt } from '@/features/recurring/RecurringDuePrompt'
import { useRecurringCheck } from '@/features/recurring/useRecurringCheck'
import { useEffect, useState } from 'react'
import { runOnboardingSeeds, shouldPromptPeopleOnboarding } from '@/services/seed'
import { getCategories } from '@/services/transactions'
import type { Category } from '@/types'

/**
 * Inner component: runs seeds on login, manages overdue recurring prompt, mounts routes.
 */
function AppRoutes() {
  const { user } = useAuth()
  const [categories, setCategories] = useState<Category[]>([])
  const [showPeopleOnboarding, setShowPeopleOnboarding] = useState(false)

  useEffect(() => {
    if (user) {
      runOnboardingSeeds(user.uid, user.displayName, user.email, user.photoURL)
        .then(async () => {
          getCategories(user.uid).then(setCategories).catch(console.error)
          try {
            const isEmulator = import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true'
            const dismissedLocally =
              localStorage.getItem(`spenza_people_onboarding_${user.uid}`) === 'true' ||
              (isEmulator && localStorage.getItem('spenza_people_onboarding_test') === 'true')
            if (!dismissedLocally) {
              const shouldPrompt = await shouldPromptPeopleOnboarding(user.uid)
              if (shouldPrompt) {
                setShowPeopleOnboarding(true)
              }
            }
          } catch (e) {
            console.error('[Spenza] Onboarding check error:', e)
          }
        })
        .catch(err => console.error('[Spenza] Seed error:', err))

      getCategories(user.uid).then(setCategories).catch(console.error)
    }
  }, [user])

  const { overdueItems, dismiss, confirm, dismissAll } = useRecurringCheck()

  const wrap = (element: React.ReactNode) => (
    <ProtectedRoute>
      <AppLayout>
        {element}
      </AppLayout>
    </ProtectedRoute>
  )

  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />

        {/* Protected app routes */}
        <Route path="/app"                 element={wrap(<DashboardPage />)} />
        <Route path="/app/transactions"    element={wrap(<TransactionsPage />)} />
        <Route path="/app/categories"      element={wrap(<CategoriesPage />)} />
        <Route path="/app/people"          element={wrap(<PeoplePage />)} />
        <Route path="/app/trips"           element={wrap(<TripsPage />)} />
        <Route path="/app/trips/:tripId"   element={wrap(<TripDetailPage />)} />
        <Route path="/app/recurring"       element={wrap(<RecurringPage />)} />
        <Route path="/app/budgets"         element={wrap(<BudgetPage />)} />
        <Route path="/app/insights"        element={wrap(<InsightsPage />)} />
        <Route path="/app/import"          element={wrap(<ImportPage />)} />
        <Route path="/app/settings"        element={wrap(<SettingsPage />)} />

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>

      {/* Floating recurring due prompt — visible on all app screens */}
      {user && overdueItems.length > 0 && (
        <RecurringDuePrompt
          items={overdueItems}
          categories={categories}
          onConfirm={confirm}
          onDismiss={dismiss}
          onDismissAll={dismissAll}
        />
      )}

      {/* First-login people split partners onboarding prompt */}
      {showPeopleOnboarding && user && (
        <PeopleOnboardingModal
          uid={user.uid}
          onComplete={() => setShowPeopleOnboarding(false)}
        />
      )}


    </>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
