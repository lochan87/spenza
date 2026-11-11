import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import type { Notice } from '@/hooks/useNotice'

/** In-flow feedback reserves space instead of covering navigation or controls. */
export function Notification({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  if (!notice) return null
  const color = notice.kind === 'error' ? 'danger' : notice.kind === 'info' ? 'primary' : notice.kind
  const Icon = notice.kind === 'success' ? CheckCircle2 : notice.kind === 'info' ? Info : AlertTriangle
  return <div role={notice.kind === 'error' ? 'alert' : 'status'} className="my-2 flex w-full items-start gap-3 rounded-xl border p-3 text-sm motion-safe:animate-[notice-enter_150ms_ease-out]"
    style={{ color: `var(--${color})`, backgroundColor: `var(--${color}-muted)`, borderColor: `var(--${color})` }}>
    <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
    <span className="min-w-0 flex-1 break-words">{notice.message}</span>
    <button type="button" aria-label="Dismiss notification" onClick={onDismiss} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--surface)]"><X className="h-4 w-4" /></button>
  </div>
}
