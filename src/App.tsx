import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/hooks/useAuth'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { LoginPage } from '@/pages/LoginPage'
import { AppPage } from '@/pages/AppPage'
import { useEffect } from 'react'
import { runOnboardingSeeds } from '@/services/seed'

/**
 * Inner component so it can use useAuth (which needs AuthProvider ancestor).
 * Triggers onboarding seed on first login.
 */
function AppRoutes() {
  const { user } = useAuth()

  useEffect(() => {
    if (user) {
      // Run idempotent seeds — safe to call on every login
      runOnboardingSeeds(user.uid, user.displayName, user.email, user.photoURL).catch(
        err => console.error('[Spenza] Seed error:', err)
      )
    }
  }, [user])

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/app"
        element={
          <ProtectedRoute>
            <AppPage />
          </ProtectedRoute>
        }
      />
      {/* Catch-all → redirect to /app (ProtectedRoute handles unauthenticated) */}
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
