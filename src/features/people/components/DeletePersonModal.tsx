import { useState } from 'react'
import { Archive, Trash2, Loader2 } from 'lucide-react'

export interface DeletePersonTarget {
  id: string
  name: string
  transactionCount?: number
}

interface DeletePersonModalProps {
  person: DeletePersonTarget
  onClose: () => void
  onConfirm: () => Promise<void> | void
}

export function DeletePersonModal({ person, onClose, onConfirm }: DeletePersonModalProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasHistory = (person.transactionCount ?? 0) > 0

  async function handleConfirm() {
    setLoading(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (err: unknown) {
      console.error('[Spenza] Error removing friend:', err)
      setError(err instanceof Error ? err.message : 'Failed to remove contact. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in-50 duration-150">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={loading ? undefined : onClose}
      />
      <div className="relative z-10 w-full max-w-sm rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-xl)]">
        <div className="mb-3 flex items-center gap-2.5">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-xl ${
              hasHistory
                ? 'bg-[var(--warning-muted)] text-[var(--warning)]'
                : 'bg-[var(--danger-muted)] text-[var(--danger)]'
            }`}
          >
            {hasHistory ? <Archive className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
          </div>
          <div>
            <h3 className="text-base font-bold text-[var(--text-primary)]">
              {hasHistory ? 'Archive Friend?' : 'Delete Friend?'}
            </h3>
            <p className="text-xs text-[var(--text-muted)]">
              {hasHistory
                ? `${person.transactionCount} linked transaction${person.transactionCount === 1 ? '' : 's'}`
                : 'Friend profile'}
            </p>
          </div>
        </div>

        <p className="mb-4 text-xs leading-relaxed text-[var(--text-secondary)]">
          {hasHistory ? (
            <>
              <strong>{person.name}</strong> has {person.transactionCount} linked transaction
              {person.transactionCount === 1 ? '' : 's'}. They will be <strong>archived</strong> instead of permanently
              deleted to preserve your financial records and Split Book ledger.
            </>
          ) : (
            <>
              Remove <strong>{person.name}</strong> from your friends list? If they have existing transaction history, they
              will be archived instead.
            </>
          )}
        </p>

        {error && <p className="mb-3 text-xs font-medium text-[var(--danger)]">{error}</p>}

        <div className="flex gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex-1 rounded-xl border border-[var(--border)] py-2.5 text-xs font-medium text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-semibold text-white shadow-xs transition-opacity hover:opacity-90 disabled:opacity-50 ${
              hasHistory ? 'bg-[var(--warning)]' : 'bg-[var(--danger)]'
            }`}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : hasHistory ? (
              <Archive className="h-3.5 w-3.5" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            <span>{hasHistory ? 'Archive Friend' : 'Delete Friend'}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
