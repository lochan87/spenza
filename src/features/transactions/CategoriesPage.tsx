import { useState, useEffect, useCallback } from 'react'
import { Plus, Archive, ArchiveRestore, Pencil, Check, X } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { getCategories, addCategory, updateCategory } from '@/services/transactions'
import { invalidateInsightsCache } from '@/services/insights'
import { getCategoryMeta, DEFAULT_CATEGORY_ORDER } from '@/utils/categoryColors'
import type { Category } from '@/types'

// ─── Category row ─────────────────────────────────────────────────────────────

function CategoryRow({
  cat,
  onEdit,
  onArchive,
}: {
  cat: Category
  onEdit: (cat: Category) => void
  onArchive: (cat: Category) => void
}) {
  const meta = getCategoryMeta(cat.name)
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 transition-all hover:border-[var(--border-strong)]">
      {/* Icon */}
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg"
        style={{ backgroundColor: (cat.color || meta.color) + '20' }}
      >
        {cat.icon || meta.emoji}
      </div>
      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${cat.isArchived ? 'text-[var(--text-subtle)] line-through' : 'text-[var(--text-primary)]'}`}>
          {cat.name}
        </p>
        {cat.isArchived && (
          <p className="text-xs text-[var(--text-subtle)]">Archived — hidden in picker</p>
        )}
      </div>
      {/* Actions */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => onEdit(cat)}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--primary)] transition-colors"
          aria-label="Edit"
        >
          <Pencil className="h-4 w-4" />
        </button>
        <button
          onClick={() => onArchive(cat)}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--warning)] transition-colors"
          aria-label={cat.isArchived ? 'Unarchive' : 'Archive'}
        >
          {cat.isArchived
            ? <ArchiveRestore className="h-4 w-4" />
            : <Archive className="h-4 w-4" />
          }
        </button>
      </div>
    </div>
  )
}

// ─── Inline edit form ─────────────────────────────────────────────────────────

function InlineEditField({
  label,
  value,
  onSave,
  onCancel,
}: {
  label: string
  value: string
  onSave: (v: string) => void
  onCancel: () => void
}) {
  const [v, setV] = useState(value)
  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        value={v}
        onChange={e => setV(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onSave(v); if (e.key === 'Escape') onCancel() }}
        placeholder={label}
        className="flex-1 rounded-lg border border-[var(--primary)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none"
      />
      <button
        onClick={() => onSave(v)}
        className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--primary)] text-white"
      >
        <Check className="h-4 w-4" />
      </button>
      <button
        onClick={onCancel}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function CategoriesPage() {
  const { user } = useAuth()
  const [categories, setCategories] = useState<Category[]>([])
  const [editingCat, setEditingCat] = useState<string | null>(null)
  const [addingCat, setAddingCat] = useState(false)
  const [newCatName, setNewCatName] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const reload = useCallback(async () => {
    if (!user) return
    const cats = await getCategories(user.uid)
    setCategories(cats)
  }, [user])

  useEffect(() => { reload() }, [reload])

  // Sort by default order, then archived at bottom
  const sortedCats = [...categories].sort((a, b) => {
    if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1
    const ai = DEFAULT_CATEGORY_ORDER.indexOf(a.name)
    const bi = DEFAULT_CATEGORY_ORDER.indexOf(b.name)
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
  })

  const visibleCats = showArchived ? sortedCats : sortedCats.filter(c => !c.isArchived)
  const activeCatCount = sortedCats.filter(c => !c.isArchived).length
  const archivedCatCount = sortedCats.filter(c => c.isArchived).length

  return (
    <div className="pb-20 md:pb-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)]">Categories</h1>
          <p className="text-sm text-[var(--text-muted)]">
            Organize how your expenses are grouped and tracked
          </p>
        </div>
        <span className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-xs font-medium text-[var(--text-muted)]">
          {activeCatCount} active
        </span>
      </div>

      <div className="flex flex-col gap-3">
        {/* Add category form */}
        {addingCat ? (
          <div className="rounded-xl border border-[var(--primary)] bg-[var(--surface)] p-4">
            <p className="mb-3 text-sm font-medium text-[var(--text-primary)]">New Category</p>
            <div className="flex items-center gap-2">
              <input
                autoFocus
                value={newCatName}
                onChange={e => setNewCatName(e.target.value)}
                onKeyDown={async e => {
                  if (e.key === 'Enter' && newCatName.trim()) {
                    const meta = getCategoryMeta(newCatName)
                    await addCategory(user!.uid, {
                      name: newCatName.trim(),
                      icon: meta.emoji,
                      color: meta.color,
                      isArchived: false,
                    })
                    setNewCatName('')
                    setAddingCat(false)
                    reload()
                  }
                  if (e.key === 'Escape') setAddingCat(false)
                }}
                placeholder="Category name"
                className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm outline-none"
              />
              <button
                onClick={async () => {
                  if (!newCatName.trim() || !user) return
                  const meta = getCategoryMeta(newCatName)
                  await addCategory(user.uid, {
                    name: newCatName.trim(),
                    icon: meta.emoji,
                    color: meta.color,
                    isArchived: false,
                  })
                  setNewCatName('')
                  setAddingCat(false)
                  reload()
                }}
                className="rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-white"
              >
                Add
              </button>
              <button
                onClick={() => setAddingCat(false)}
                className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-muted)]"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            id="add-category-btn"
            onClick={() => setAddingCat(true)}
            className="flex items-center gap-2 rounded-xl border border-dashed border-[var(--border)] px-4 py-3 text-sm text-[var(--text-muted)] transition-all hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            <Plus className="h-4 w-4" />
            Add custom category
          </button>
        )}

        {/* Category list */}
        <div className="flex flex-col gap-2">
          {visibleCats.map(cat =>
            editingCat === cat.id ? (
              <div key={cat.id} className="rounded-xl border border-[var(--primary)] bg-[var(--surface)] p-3">
                <InlineEditField
                  label="Category name"
                  value={cat.name}
                  onSave={async name => {
                    if (!name.trim()) return
                    await updateCategory(user!.uid, cat.id, { name: name.trim() })
                    await invalidateInsightsCache(user!.uid)
                    setEditingCat(null)
                    reload()
                  }}
                  onCancel={() => setEditingCat(null)}
                />
              </div>
            ) : (
              <CategoryRow
                key={cat.id}
                cat={cat}
                onEdit={c => setEditingCat(c.id)}
                onArchive={async c => {
                  await updateCategory(user!.uid, c.id, { isArchived: !c.isArchived })
                  await invalidateInsightsCache(user!.uid)
                  reload()
                }}
              />
            )
          )}
        </div>

        {/* Show archived toggle */}
        {archivedCatCount > 0 && (
          <button
            onClick={() => setShowArchived(v => !v)}
            className="text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            {showArchived ? `Hide ${archivedCatCount} archived` : `Show ${archivedCatCount} archived`}
          </button>
        )}
      </div>
    </div>
  )
}
