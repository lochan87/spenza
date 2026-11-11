import { AlertTriangle, WifiOff, LogOut } from 'lucide-react'

interface SignOutWarningModalProps {
  isOpen: boolean
  hasPendingWrites: boolean
  isOnline: boolean
  onClose: () => void
  onConfirmSignOut: () => void
}

export function SignOutWarningModal({
  isOpen,
  hasPendingWrites,
  isOnline,
  onClose,
  onConfirmSignOut,
}: SignOutWarningModalProps) {
  if (!isOpen) return null

  const isPendingWarning = hasPendingWrites
  const subtitle = isPendingWarning
    ? isOnline
      ? 'Changes are currently syncing'
      : 'Unsynced records pending offline'
    : 'No network connection'

  const message = isPendingWarning
    ? isOnline
      ? 'You have changes currently syncing to the server. Signing out now may interrupt synchronization.'
      : 'You have offline transactions or changes that have not synced to the server yet. Signing out now may discard or strand these changes on this device until you sign back in.'
    : 'You are currently offline. If you sign out now, you will need an active internet connection to authenticate and sign back in.'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sign-out-warning-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in-50 duration-150"
    >
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-xl)]">
        <div className="mb-3 flex items-center gap-2.5">
          <div
            className={`flex h-9 w-9 items-center justify-center rounded-xl ${
              isPendingWarning
                ? 'bg-[var(--danger-muted)] text-[var(--danger)]'
                : 'bg-[var(--warning-muted)] text-[var(--warning)]'
            }`}
          >
            {isPendingWarning ? (
              <AlertTriangle className="h-5 w-5" />
            ) : (
              <WifiOff className="h-5 w-5" />
            )}
          </div>
          <div>
            <h3
              id="sign-out-warning-title"
              className="text-base font-bold text-[var(--text-primary)]"
            >
              {isPendingWarning ? 'Unsaved Offline Changes' : "You're Offline"}
            </h3>
            <p className="text-xs text-[var(--text-muted)]">
              {subtitle}
            </p>
          </div>
        </div>

        <p className="mb-5 text-xs leading-relaxed text-[var(--text-muted)]">
          {message}
        </p>

        <div className="flex gap-2">
          <button
            type="button"
            id="cancel-sign-out-btn"
            onClick={onClose}
            className="flex-1 rounded-xl border border-[var(--border)] px-4 py-2.5 text-xs font-semibold text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-2)]"
          >
            {isPendingWarning ? 'Wait for Sync' : 'Stay Signed In'}
          </button>
          <button
            type="button"
            id="confirm-sign-out-btn"
            onClick={onConfirmSignOut}
            className="flex items-center justify-center gap-1.5 rounded-xl bg-[var(--danger)] px-4 py-2.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign Out Anyway
          </button>
        </div>
      </div>
    </div>
  )
}
