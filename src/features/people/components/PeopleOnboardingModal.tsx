import { useState } from 'react'
import { Users, Plus, X, Check, Loader2, Sparkles } from 'lucide-react'
import { addPerson } from '@/services/people'
import { completeUserOnboarding } from '@/services/seed'

interface PeopleOnboardingModalProps {
  uid: string
  onComplete: () => void
}

const COMMON_SPLIT_ROLES = [
  'Roommate',
  'Partner',
  'Flatmate',
  'Colleague',
  'Best Friend',
]

export function PeopleOnboardingModal({ uid, onComplete }: PeopleOnboardingModalProps) {
  const [names, setNames] = useState<string[]>([])
  const [currentInput, setCurrentInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleAddName(nameToAdd?: string) {
    const raw = (nameToAdd !== undefined ? nameToAdd : currentInput).trim()
    if (!raw) return

    // Case-insensitive duplicate check
    const isDuplicate = names.some(n => n.toLowerCase() === raw.toLowerCase())
    if (isDuplicate) {
      setError(`"${raw}" is already added`)
      return
    }

    setNames(prev => [...prev, raw])
    setCurrentInput('')
    setError(null)
  }

  function handleRemoveName(index: number) {
    setNames(prev => prev.filter((_, i) => i !== index))
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleAddName()
    }
  }

  async function handleFinish(skip = false) {
    setLoading(true)
    setError(null)
    try {
      // Include any name typed in the input field that wasn't explicitly added via "+ Add"
      const pendingInput = currentInput.trim()
      let finalNames = [...names]
      if (!skip && pendingInput) {
        const isDup = finalNames.some(n => n.toLowerCase() === pendingInput.toLowerCase())
        if (!isDup) {
          finalNames.push(pendingInput)
        }
      }

      if (!skip && finalNames.length > 0) {
        // Save each person
        await Promise.all(finalNames.map(name => addPerson(uid, name)))
      }

      // Mark onboarding as complete in Firestore and cache in localStorage
      await completeUserOnboarding(uid)
      try {
        localStorage.setItem(`spenza_people_onboarding_${uid}`, 'true')
      } catch {
        // ignore localStorage errors in private browsing
      }

      onComplete()
    } catch (err: any) {
      console.error('[Spenza] Error in people onboarding:', err)
      setError(err?.message || 'Something went wrong saving split partners')
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal Dialog */}
      <div className="relative z-10 w-full max-w-md rounded-3xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-[var(--shadow-2xl)] sm:p-7">
        {/* Header Icon & Tagline */}
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="relative mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--primary-muted)] text-[var(--primary)] shadow-xs">
            <Users className="h-7 w-7" />
            <div className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--primary)] text-white shadow-xs">
              <Sparkles className="h-3 w-3" />
            </div>
          </div>
          <h2 className="text-xl font-extrabold tracking-tight text-[var(--text-primary)]">
            Who do you split bills with?
          </h2>
          <p className="mt-1.5 text-xs text-[var(--text-muted)] max-w-xs leading-relaxed">
            Add friends, roommates, or family you often share expenses with so splitting bills is fast and one-tap.
          </p>
        </div>

        {/* Suggestion Chips */}
        <div className="mb-4">
          <span className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]">
            Quick suggestions
          </span>
          <div className="flex flex-wrap gap-1.5">
            {COMMON_SPLIT_ROLES.map(role => {
              const isAdded = names.some(n => n.toLowerCase() === role.toLowerCase())
              return (
                <button
                  key={role}
                  type="button"
                  disabled={isAdded || loading}
                  onClick={() => handleAddName(role)}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-all ${
                    isAdded
                      ? 'bg-[var(--surface-3)] text-[var(--text-subtle)] opacity-50 cursor-not-allowed'
                      : 'border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-secondary)] hover:border-[var(--primary)] hover:text-[var(--primary)]'
                  }`}
                >
                  <Plus className="h-3 w-3" />
                  <span>{role}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* Input Form */}
        <div className="mb-3">
          <label className="mb-1.5 block text-xs font-semibold text-[var(--text-secondary)]">
            Add Friend or Contact Name
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              autoFocus
              value={currentInput}
              onChange={e => setCurrentInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. Aarav, Meera, Roommate 1"
              disabled={loading}
              className="flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-subtle)] focus:border-[var(--primary)] focus:outline-none"
            />
            <button
              type="button"
              disabled={loading || !currentInput.trim()}
              onClick={() => handleAddName()}
              className="inline-flex items-center justify-center gap-1 rounded-xl bg-[var(--primary)] px-4 py-2.5 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add</span>
            </button>
          </div>
          {error && <p className="mt-1.5 text-xs font-medium text-[var(--danger)]">{error}</p>}
        </div>

        {/* Current Added Names Chips */}
        {names.length > 0 ? (
          <div className="mb-6 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)]/60 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-[var(--text-muted)]">
                Added Partners ({names.length})
              </span>
              <span className="text-[10px] text-[var(--text-subtle)]">
                Ready to save
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto">
              {names.map((name, i) => (
                <div
                  key={i}
                  className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs font-semibold text-[var(--text-primary)] shadow-xs"
                >
                  <span>{name}</span>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => handleRemoveName(i)}
                    className="rounded-full p-0.5 text-[var(--text-subtle)] hover:bg-[var(--surface-2)] hover:text-[var(--danger)]"
                    aria-label={`Remove ${name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="mb-6 rounded-2xl border border-dashed border-[var(--border)] p-3 text-center text-xs text-[var(--text-subtle)]">
            No one added yet. Type a name above or tap a suggestion.
          </div>
        )}

        {/* Footer Actions */}
        <div className="flex flex-col gap-2 pt-1">
          <button
            type="button"
            disabled={loading}
            onClick={() => handleFinish(false)}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--primary)] py-3 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-[var(--primary-hover)] active:scale-[0.99] disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            <span>
              {names.length > 0
                ? `Save ${names.length} Partner${names.length !== 1 ? 's' : ''} & Continue`
                : 'Continue to App'}
            </span>
          </button>

          <button
            type="button"
            disabled={loading}
            onClick={() => handleFinish(true)}
            className="w-full py-2 text-center text-xs font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            Skip for now (you can add friends anytime in Settings)
          </button>
        </div>
      </div>
    </div>
  )
}

