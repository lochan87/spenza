import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/hooks/useAuth'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { AppLayout } from '@/components/layout/AppLayout'
import { LoginPage } from '@/pages/LoginPage'
import { DashboardPage } from '@/features/dashboard/DashboardPage'
import { TransactionsPage } from '@/features/transactions/TransactionsPage'
import { CategoriesPage } from '@/features/transactions/CategoriesPage'
import { useEffect } from 'react'
import { runOnboardingSeeds } from '@/services/seed'

/**
 * Inner component: runs seeds on login, mounts routes.
 */
function AppRoutes() {
  const { user } = useAuth()

  useEffect(() => {
    if (user) {
      runOnboardingSeeds(user.uid, user.displayName, user.email, user.photoURL).catch(
        err => console.error('[Spenza] Seed error:', err)
      )
    }
  }, [user])

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      {/* Protected app routes */}
      <Route
        path="/app"
        element={
          <ProtectedRoute>
            <AppLayout>
              <DashboardPage />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/app/transactions"
        element={
          <ProtectedRoute>
            <AppLayout>
              <TransactionsPage />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/app/categories"
        element={
          <ProtectedRoute>
            <AppLayout>
              <CategoriesPage />
            </AppLayout>
          </ProtectedRoute>
        }
      />

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
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
