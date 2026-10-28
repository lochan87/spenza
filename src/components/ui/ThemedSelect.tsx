import { useState, useRef, useEffect } from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface ThemedSelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  size?: 'xs' | 'sm' | 'md' | 'lg'
  align?: 'start' | 'center' | 'end'
  disabled?: boolean
  className?: string
  contentClassName?: string
  id?: string
  'aria-label'?: string
}

export function ThemedSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  size = 'sm',
  align = 'start',
  disabled = false,
  className,
  contentClassName,
  id,
  'aria-label': ariaLabel,
}: ThemedSelectProps) {
  const [open, setOpen] = useState(false)
  const activeItemRef = useRef<HTMLButtonElement | null>(null)

  const selectedOption = options.find(o => o.value === value)
  const displayLabel = selectedOption ? selectedOption.label : placeholder

  useEffect(() => {
    if (open) {
      const t = setTimeout(() => {
        activeItemRef.current?.scrollIntoView({ block: 'nearest' })
      }, 10)
      return () => clearTimeout(t)
    }
  }, [open])

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          className={cn(
            'inline-flex items-center justify-between gap-2 border border-[var(--border)] bg-[var(--surface-2)] text-left font-medium text-[var(--text-primary)] outline-none transition-all',
            'hover:border-[var(--border-strong)] focus:border-[var(--primary)] focus:ring-2 focus:ring-[var(--primary-muted)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            size === 'xs' && 'rounded-lg px-2 py-1 text-xs',
            size === 'sm' && 'rounded-xl px-2.5 py-1.5 text-xs',
            size === 'md' && 'rounded-xl px-3 py-2 text-xs sm:text-sm',
            size === 'lg' && 'rounded-xl px-4 py-3 text-sm',
            className
          )}
        >
          <span
            className={cn(
              'truncate',
              selectedOption ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'
            )}
          >
            {displayLabel}
          </span>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-[var(--text-muted)] transition-transform duration-150',
              open && 'rotate-180 text-[var(--primary)]'
            )}
          />
        </button>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align={align}
          sideOffset={5}
          collisionPadding={12}
          style={{ minWidth: 'var(--radix-popover-trigger-width)' }}
          className={cn(
            'z-[120] max-h-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1 text-[var(--text-primary)] shadow-[var(--shadow-lg)] outline-none scrollbar-thin',
            contentClassName
          )}
        >
          {options.map(opt => {
            const isSelected = opt.value === value
            return (
              <button
                key={opt.value}
                ref={isSelected ? activeItemRef : null}
                type="button"
                disabled={opt.disabled}
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs font-medium transition-colors outline-none',
                  isSelected
                    ? 'bg-[var(--primary-muted)] text-[var(--primary)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
                  opt.disabled && 'pointer-events-none opacity-40'
                )}
              >
                <span className="truncate">{opt.label}</span>
                {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]" />}
              </button>
            )
          })}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}
