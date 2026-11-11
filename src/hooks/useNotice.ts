import { useCallback, useEffect, useState } from 'react'

export type Notice = { message: string; kind: 'success' | 'error' | 'warning' | 'info' }
export function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null)
  const showNotice = useCallback((message: string, kind: Notice['kind'] = 'success') => {
    setNotice(previous => previous?.message === message && previous.kind === kind ? previous : { message, kind })
  }, [])
  const dismiss = useCallback(() => setNotice(null), [])
  useEffect(() => {
    if (!notice || notice.kind === 'error' || notice.kind === 'warning') return
    const timer = setTimeout(dismiss, Math.max(6000, notice.message.length * 60))
    return () => clearTimeout(timer)
  }, [notice, dismiss])
  return { notice, showNotice, dismiss }
}
