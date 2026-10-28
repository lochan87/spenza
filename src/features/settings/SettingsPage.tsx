import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  Plus,
  Archive,
  ArchiveRestore,
  Pencil,
  Check,
  X,
  CreditCard,
  Download,
  Upload,
  Trash2,
  Loader2,
  Sun,
  Moon,
  LogOut,
  Star,
  Database,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  User as UserIcon,
} from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useTheme } from '@/hooks/useTheme'
import { signOut } from '@/firebase/auth'
import {
  getCategories,
  getPaymentAccounts,
  addPaymentAccount,
  updatePaymentAccount,
} from '@/services/transactions'
import {
  clearImportedTransactions,
  clearAllTransactions,
  getImportedTransactionsCount,
} from '@/services/importExcel'
import { exportTransactionsCSV } from '@/services/exportCsv'
import {
  getLiveTransactionCount,
  invalidateInsightsCache,
} from '@/services/insights'
import {
  previewCategoryMigration,
  runCategoryMigration,
  type CategoryMigrationPreview,
  type CategoryMigrationResult,
} from '@/services/categoryMigration'
import { getAccountTypeMeta } from '@/utils/paymentColors'
import type { Category, PaymentAccount } from '@/types'

// ─── Account row ──────────────────────────────────────────────────────────────

function AccountRow({
  account,
  onEdit,
  onArchive,
  onSetDefault,
}: {
  account: PaymentAccount
  onEdit: (a: PaymentAccount) => void
  onArchive: (a: PaymentAccount) => void
  onSetDefault: (a: PaymentAccount) => void
}) {
  const meta = getAccountTypeMeta(account.type)
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 transition-all hover:border-[var(--border-strong)]">
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-xs font-bold"
        style={{ backgroundColor: meta.bgColor, color: meta.color }}
      >
        {account.type.slice(0, 2)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p
            className={`truncate text-sm font-medium ${
              account.isArchived
                ? 'text-[var(--text-subtle)] line-through'
                : 'text-[var(--text-primary)]'
            }`}
          >
            {account.name}
          </p>
          {account.isDefault && (
            <span className="rounded-full bg-[var(--primary-muted)] px-2 py-0.5 text-[10px] font-semibold text-[var(--primary)]">
              Default
            </span>
          )}
        </div>
        <p className="text-xs text-[var(--text-muted)]">{account.type}</p>
      </div>
      <div className="flex items-center gap-1">
        {!account.isArchived && !account.isDefault && (
          <button
            type="button"
            onClick={() => onSetDefault(account)}
            title="Set as default account"
            aria-label="Set as default account"
            className="flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--primary)] transition-colors"
          >
            <Star className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Set default</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => onEdit(account)}
          aria-label="Edit account"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--primary)] transition-colors"
        >
          <Pencil className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onArchive(account)}
          aria-label={account.isArchived ? 'Unarchive account' : 'Archive account'}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--warning)] transition-colors"
        >
          {account.isArchived ? (
            <ArchiveRestore className="h-4 w-4" />
          ) : (
            <Archive className="h-4 w-4" />
          )}
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
        onKeyDown={e => {
          if (e.key === 'Enter') onSave(v)
          if (e.key === 'Escape') onCancel()
        }}
        placeholder={label}
        className="flex-1 rounded-lg border border-[var(--primary)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none"
      />
      <button
        type="button"
        onClick={() => onSave(v)}
        className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--primary)] text-white"
      >
        <Check className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

// ─── Main Settings Page ───────────────────────────────────────────────────────

export function SettingsPage() {
  const { user } = useAuth()
  const { isDark, setTheme } = useTheme()

  // Profile avatar fallback
  const [imgError, setImgError] = useState(false)
  useEffect(() => {
    setImgError(false)
  }, [user?.photoURL])

  // Payment accounts & categories (categories needed for CSV export)
  const [accounts, setAccounts] = useState<PaymentAccount[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [editingAcc, setEditingAcc] = useState<string | null>(null)
  const [addingAcc, setAddingAcc] = useState(false)
  const [newAccName, setNewAccName] = useState('')
  const [newAccType, setNewAccType] = useState<'Bank' | 'UPI' | 'Card' | 'Wallet'>('Bank')
  const [showArchived, setShowArchived] = useState(false)

  // Data management counts & states
  const [totalTxCount, setTotalTxCount] = useState<number | null>(null)
  const [importedTxCount, setImportedTxCount] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)
  const [resettingCache, setResettingCache] = useState(false)
  const [migrationPreview, setMigrationPreview] =
    useState<CategoryMigrationPreview | null>(null)
  const [migrationResult, setMigrationResult] =
    useState<CategoryMigrationResult | null>(null)
  const [runningMigration, setRunningMigration] = useState(false)
  const [showMigrationDetails, setShowMigrationDetails] = useState(false)
  const [confirmClearImports, setConfirmClearImports] = useState(false)
  const [clearingImports, setClearingImports] = useState(false)
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  const [clearingAll, setClearingAll] = useState(false)
  const [statusBanner, setStatusBanner] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  const reloadData = useCallback(async () => {
    if (!user) return
    const [accs, cats, totalCount, importedCount, catPreview] = await Promise.all([
      getPaymentAccounts(user.uid),
      getCategories(user.uid),
      getLiveTransactionCount(user.uid),
      getImportedTransactionsCount(user.uid),
      previewCategoryMigration(user.uid),
    ])
    setAccounts(accs)
    setCategories(cats)
    setTotalTxCount(totalCount)
    setImportedTxCount(importedCount)
    setMigrationPreview(catPreview)
  }, [user])

  useEffect(() => {
    reloadData()
  }, [reloadData])

  const sortedAccs = [...accounts].sort((a, b) => {
    if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const visibleAccs = showArchived
    ? sortedAccs
    : sortedAccs.filter(a => !a.isArchived)
  const archivedAccCount = sortedAccs.filter(a => a.isArchived).length

  const handleSetDefaultAccount = async (target: PaymentAccount) => {
    if (!user) return
    await Promise.all(
      accounts
        .filter(a => a.isDefault || a.id === target.id)
        .map(a =>
          updatePaymentAccount(user.uid, a.id, {
            isDefault: a.id === target.id,
          })
        )
    )
    reloadData()
  }

  const handleExportCSV = async () => {
    if (!user) return
    setExporting(true)
    setStatusBanner(null)
    try {
      await exportTransactionsCSV(user.uid, categories, accounts)
      setStatusBanner({
        type: 'success',
        message: `Exported ${totalTxCount ?? 0} transactions to CSV.`,
      })
    } catch (err) {
      console.error('[Spenza Settings] Export error:', err)
      setStatusBanner({
        type: 'error',
        message: 'Failed to export CSV. Please try again.',
      })
    } finally {
      setExporting(false)
    }
  }

  const handleResetInsightsCache = async () => {
    if (!user) return
    setResettingCache(true)
    setStatusBanner(null)
    try {
      const ok = await invalidateInsightsCache(user.uid)
      if (ok) {
        setStatusBanner({
          type: 'success',
          message: 'Insights cache cleared — Insights will recompute fresh on your next visit.',
        })
      } else {
        setStatusBanner({
          type: 'error',
          message: 'Failed to clear insights cache. Please check your connection and try again.',
        })
      }
    } catch (err) {
      console.error('[Spenza Settings] Cache reset error:', err)
      setStatusBanner({
        type: 'error',
        message: 'Failed to clear insights cache.',
      })
    } finally {
      setResettingCache(false)
    }
  }

  const handleRunCategoryMigration = async () => {
    if (!user) return
    setRunningMigration(true)
    setStatusBanner(null)
    try {
      const res = await runCategoryMigration(user.uid)
      setMigrationResult(res)
      setShowMigrationDetails(true)
      await reloadData()
      setStatusBanner({
        type: 'success',
        message: `Category migration complete: renamed ${res.renamedCount} category document${
          res.renamedCount === 1 ? '' : 's'
        } in-place (0 orphaned transactions), created ${res.addedCount} new category document${
          res.addedCount === 1 ? '' : 's'
        }, and invalidated Insights cache.`,
      })
    } catch (err) {
      console.error('[Spenza Settings] Category migration error:', err)
      setStatusBanner({
        type: 'error',
        message: 'Failed to run category migration. Check console for details.',
      })
    } finally {
      setRunningMigration(false)
    }
  }

  const handleClearImported = async () => {
    if (!user) return
    setClearingImports(true)
    setStatusBanner(null)
    try {
      const { deleted, cacheInvalidated } = await clearImportedTransactions(user.uid)
      setConfirmClearImports(false)
      await reloadData()
      if (!cacheInvalidated) {
        setStatusBanner({
          type: 'error',
          message: `Deleted ${deleted.toLocaleString()} imported transaction${
            deleted !== 1 ? 's' : ''
          }, but failed to invalidate the Insights cache. Please click Reset Cache manually.`,
        })
      } else {
        setStatusBanner({
          type: 'success',
          message: `Deleted ${deleted.toLocaleString()} imported transaction${
            deleted !== 1 ? 's' : ''
          } and invalidated the Insights cache.`,
        })
      }
    } catch (err) {
      console.error('[Spenza Settings] Clear imports error:', err)
      setStatusBanner({
        type: 'error',
        message: 'Failed to clear imported transactions. Check console for details.',
      })
    } finally {
      setClearingImports(false)
    }
  }

  const handleClearAll = async () => {
    if (!user) return
    setClearingAll(true)
    setStatusBanner(null)
    try {
      const { deleted, cacheInvalidated } = await clearAllTransactions(user.uid)
      setConfirmClearAll(false)
      await reloadData()
      if (!cacheInvalidated) {
        setStatusBanner({
          type: 'error',
          message: `Deleted all ${deleted.toLocaleString()} transaction${
            deleted !== 1 ? 's' : ''
          }, but failed to clear the Insights cache. Please click Reset Cache manually.`,
        })
      } else {
        setStatusBanner({
          type: 'success',
          message: `Deleted all ${deleted.toLocaleString()} transaction${
            deleted !== 1 ? 's' : ''
          } and cleared the Insights cache.`,
        })
      }
    } catch (err) {
      console.error('[Spenza Settings] Clear all error:', err)
      setStatusBanner({
        type: 'error',
        message: 'Failed to clear transactions. Check console for details.',
      })
    } finally {
      setClearingAll(false)
    }
  }

  const userInitial = (
    user?.displayName?.trim()?.[0] ||
    user?.email?.trim()?.[0] ||
    'U'
  ).toUpperCase()

  const manualTxCount =
    totalTxCount !== null && importedTxCount !== null
      ? Math.max(0, totalTxCount - importedTxCount)
      : null

  return (
    <div className="flex flex-col gap-8 pb-20 md:pb-8">
      {/* Page Header */}
      <div>
        <h1 className="text-xl font-bold text-[var(--text-primary)]">Settings</h1>
        <p className="text-sm text-[var(--text-muted)]">
          Manage your payment accounts, appearance, and expense data
        </p>
      </div>

      {/* Status feedback banner */}
      {statusBanner && (
        <div
          className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ${
            statusBanner.type === 'success'
              ? 'border-[var(--success)]/30 bg-[var(--success-muted)] text-[var(--success)]'
              : 'border-[var(--danger)]/30 bg-[var(--danger-muted)] text-[var(--danger)]'
          }`}
        >
          <div className="flex items-center gap-2">
            {statusBanner.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0" />
            )}
            <span className="font-medium">{statusBanner.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setStatusBanner(null)}
            className="text-xs opacity-75 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── SECTION 1: PAYMENT ACCOUNTS ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-[var(--primary)]" />
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              Payment Accounts
            </h2>
          </div>
          <span className="text-xs text-[var(--text-muted)]">
            {sortedAccs.filter(a => !a.isArchived).length} active
          </span>
        </div>
        <p className="text-xs text-[var(--text-muted)] -mt-1">
          Add or rename the banks, UPI handles, cards, and wallets you use to pay for expenses.
        </p>

        {/* Add account form */}
        {addingAcc ? (
          <div className="rounded-xl border border-[var(--primary)] bg-[var(--surface)] p-4">
            <p className="mb-3 text-sm font-medium text-[var(--text-primary)]">
              New Payment Account
            </p>
            <div className="flex flex-col gap-3">
              <input
                autoFocus
                value={newAccName}
                onChange={e => setNewAccName(e.target.value)}
                placeholder="Account name (e.g. HDFC Bank, Google Pay)"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none"
              />
              <div className="flex flex-wrap gap-2">
                {(['Bank', 'UPI', 'Card', 'Wallet'] as const).map(type => {
                  const meta = getAccountTypeMeta(type)
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setNewAccType(type)}
                      className="rounded-full border px-3 py-1.5 text-xs font-medium transition-all"
                      style={
                        newAccType === type
                          ? {
                              backgroundColor: meta.bgColor,
                              borderColor: meta.color + '80',
                              color: meta.color,
                            }
                          : {
                              borderColor: 'var(--border)',
                              color: 'var(--text-muted)',
                            }
                      }
                    >
                      {type}
                    </button>
                  )
                })}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    if (!newAccName.trim() || !user) return
                    await addPaymentAccount(user.uid, {
                      name: newAccName.trim(),
                      type: newAccType,
                      isDefault: false,
                      isArchived: false,
                    })
                    setNewAccName('')
                    setAddingAcc(false)
                    reloadData()
                  }}
                  className="rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-white"
                >
                  Add Account
                </button>
                <button
                  type="button"
                  onClick={() => setAddingAcc(false)}
                  className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--text-muted)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            id="add-account-btn"
            type="button"
            onClick={() => setAddingAcc(true)}
            className="flex items-center gap-2 rounded-xl border border-dashed border-[var(--border)] px-4 py-3 text-sm text-[var(--text-muted)] transition-all hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
          >
            <Plus className="h-4 w-4" />
            Add bank / UPI / card
          </button>
        )}

        {/* Account list */}
        <div className="flex flex-col gap-2">
          {visibleAccs.map(acc =>
            editingAcc === acc.id ? (
              <div
                key={acc.id}
                className="rounded-xl border border-[var(--primary)] bg-[var(--surface)] p-3"
              >
                <InlineEditField
                  label="Account name"
                  value={acc.name}
                  onSave={async name => {
                    if (!name.trim()) return
                    await updatePaymentAccount(user!.uid, acc.id, { name: name.trim() })
                    setEditingAcc(null)
                    reloadData()
                  }}
                  onCancel={() => setEditingAcc(null)}
                />
              </div>
            ) : (
              <AccountRow
                key={acc.id}
                account={acc}
                onEdit={a => setEditingAcc(a.id)}
                onSetDefault={handleSetDefaultAccount}
                onArchive={async a => {
                  await updatePaymentAccount(user!.uid, a.id, {
                    isArchived: !a.isArchived,
                  })
                  reloadData()
                }}
              />
            )
          )}
        </div>

        {archivedAccCount > 0 && (
          <button
            type="button"
            onClick={() => setShowArchived(v => !v)}
            className="self-start text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            {showArchived
              ? `Hide ${archivedAccCount} archived`
              : `Show ${archivedAccCount} archived`}
          </button>
        )}
      </section>

      {/* ── SECTION 2: DATA MANAGEMENT ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-[var(--primary)]" />
            <h2 className="text-base font-semibold text-[var(--text-primary)]">
              Data Management
            </h2>
          </div>
          {totalTxCount !== null && (
            <span className="rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-xs font-medium text-[var(--text-muted)]">
              {totalTxCount.toLocaleString()} total · {(importedTxCount ?? 0).toLocaleString()} imported · {(manualTxCount ?? 0).toLocaleString()} manual
            </span>
          )}
        </div>

        {/* Export & Import row */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div>
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                Export All Data (CSV)
              </p>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Download your complete transaction history ({totalTxCount ?? '…'} rows) with categories, payment modes, and accounts.
              </p>
            </div>
            <button
              id="settings-export-csv-btn"
              type="button"
              onClick={handleExportCSV}
              disabled={exporting || totalTxCount === 0}
              className="flex items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-2 text-xs font-semibold text-[var(--text-primary)] transition-colors hover:border-[var(--border-strong)] disabled:opacity-50"
            >
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {exporting ? 'Exporting…' : 'Export Transactions CSV'}
            </button>
          </div>

          <div className="flex flex-col justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <div>
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                Import from Excel / CSV
              </p>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Bulk upload historical monthly sheets or trip sheets with automatic category & duplicate detection.
              </p>
            </div>
            <Link
              to="/app/import"
              className="flex items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-4 py-2 text-xs font-semibold text-[var(--text-primary)] transition-colors hover:border-[var(--border-strong)]"
            >
              <Upload className="h-3.5 w-3.5" />
              Open Import Tool
            </Link>
          </div>
        </div>

        {/* Category Taxonomy Migration (One-Time In-Place Rename + Outings & Social) */}
        <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-[var(--text-primary)]">
                  Category Taxonomy Migration
                </p>
                {migrationPreview && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      migrationPreview.alreadyUpToDate
                        ? 'bg-[var(--success-muted)] text-[var(--success)]'
                        : 'bg-[var(--warning-muted)] text-[var(--warning)]'
                    }`}
                  >
                    {migrationPreview.alreadyUpToDate
                      ? 'Up to Date'
                      : `${migrationPreview.plannedRenames.length} rename(s) · ${migrationPreview.plannedAdditions.length} new`}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Renames <strong>Transport → Transport &amp; Vehicle</strong>,{' '}
                <strong>Health → Health &amp; Medical</strong>, and{' '}
                <strong>Education → Education &amp; Career</strong> in-place on their existing Firestore documents (preserving IDs so 0 transactions lose their category link), and creates{' '}
                <strong>Outings &amp; Social</strong>.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setShowMigrationDetails(v => !v)}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs font-semibold text-[var(--text-primary)] transition-colors hover:border-[var(--border-strong)]"
              >
                {showMigrationDetails ? 'Hide Preview' : 'Inspect Categories'}
              </button>
              {migrationPreview && !migrationPreview.alreadyUpToDate && (
                <button
                  id="run-category-migration-btn"
                  type="button"
                  onClick={handleRunCategoryMigration}
                  disabled={runningMigration}
                  className="flex items-center gap-1.5 rounded-xl bg-[var(--primary)] px-3.5 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {runningMigration && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {runningMigration ? 'Migrating…' : 'Confirm & Run Migration'}
                </button>
              )}
            </div>
          </div>

          {showMigrationDetails && migrationPreview && (
            <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5 text-xs">
              {/* Planned In-Place Renames */}
              <div>
                <p className="font-semibold text-[var(--text-primary)]">
                  1. Planned In-Place Document Renames (Firestore IDs preserved):
                </p>
                {migrationPreview.plannedRenames.length === 0 ? (
                  <p className="mt-1 text-[var(--text-muted)]">
                    None — all legacy category names have already been migrated.
                  </p>
                ) : (
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {migrationPreview.plannedRenames.map(r => (
                      <li
                        key={r.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--surface)] px-2.5 py-1.5"
                      >
                        <span>
                          <strong>{r.fromName}</strong> →{' '}
                          <strong className="text-[var(--primary)]">
                            {r.icon} {r.toName}
                          </strong>{' '}
                          <span className="font-mono text-[10px] text-[var(--text-muted)]">
                            (doc id: {r.id})
                          </span>
                        </span>
                        <span
                          className={`text-[10px] font-semibold ${
                            r.targetAlreadyExists
                              ? 'text-[var(--danger)]'
                              : 'text-[var(--success)]'
                          }`}
                        >
                          {r.targetAlreadyExists
                            ? 'Conflict: target name already exists (will skip)'
                            : 'No duplicate target exists'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Planned Additions */}
              <div>
                <p className="font-semibold text-[var(--text-primary)]">
                  2. New Categories to Create:
                </p>
                {migrationPreview.plannedAdditions.length === 0 ? (
                  <p className="mt-1 text-[var(--text-muted)]">
                    None — Outings &amp; Social already exists.
                  </p>
                ) : (
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {migrationPreview.plannedAdditions.map(add => (
                      <li
                        key={add.name}
                        className="flex items-center justify-between rounded-lg bg-[var(--surface)] px-2.5 py-1.5"
                      >
                        <span>
                          <strong className="text-[var(--primary)]">
                            {add.icon} {add.name}
                          </strong>{' '}
                          <span className="font-mono text-[10px] text-[var(--text-muted)]">
                            ({add.color})
                          </span>
                        </span>
                        <span className="text-[10px] font-semibold text-[var(--success)]">
                          Will create 1 new doc
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Before vs After or Current Category Inventory */}
              {migrationResult ? (
                <div className="grid grid-cols-1 gap-3 pt-1 sm:grid-cols-2">
                  <div className="rounded-lg bg-[var(--surface)] p-2.5">
                    <p className="mb-1.5 font-semibold text-[var(--text-muted)]">
                      Before Migration ({migrationResult.before.length} docs)
                    </p>
                    <ul className="flex flex-col gap-1">
                      {migrationResult.before.map(c => (
                        <li
                          key={c.id}
                          className="flex items-center justify-between text-[11px]"
                        >
                          <span>
                            {c.icon} {c.name}
                          </span>
                          <span className="font-mono text-[10px] text-[var(--text-subtle)]">
                            {c.id.slice(0, 8)}…
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="rounded-lg bg-[var(--surface)] p-2.5">
                    <p className="mb-1.5 font-semibold text-[var(--success)]">
                      After Migration ({migrationResult.after.length} docs)
                    </p>
                    <ul className="flex flex-col gap-1">
                      {migrationResult.after.map(c => (
                        <li
                          key={c.id}
                          className="flex items-center justify-between text-[11px]"
                        >
                          <span className="font-medium text-[var(--text-primary)]">
                            {c.icon} {c.name}
                          </span>
                          <span className="font-mono text-[10px] text-[var(--text-subtle)]">
                            {c.id.slice(0, 8)}…
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg bg-[var(--surface)] p-2.5">
                  <p className="mb-1.5 font-semibold text-[var(--text-muted)]">
                    Current Firestore Category Documents ({migrationPreview.existingCategories.length})
                  </p>
                  <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                    {migrationPreview.existingCategories.map(c => (
                      <div
                        key={c.id}
                        className="flex items-center justify-between rounded px-1.5 py-0.5 text-[11px]"
                      >
                        <span>
                          {c.icon} {c.name}
                        </span>
                        <span className="font-mono text-[10px] text-[var(--text-subtle)]">
                          id: {c.id.slice(0, 8)}…
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Insights Cache Reset */}
        <div className="flex flex-col justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-semibold text-[var(--text-primary)]">
              Insights Analytics Cache
            </p>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              Insights caches computed summaries for 7 days. Resetting forces a fresh full-history scan on your next visit.
            </p>
          </div>
          <button
            type="button"
            onClick={handleResetInsightsCache}
            disabled={resettingCache}
            className="flex shrink-0 items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-2 text-xs font-semibold text-[var(--text-primary)] transition-colors hover:border-[var(--border-strong)] disabled:opacity-50"
          >
            {resettingCache ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Reset Cache
          </button>
        </div>

        {/* Clear Imported Transactions (Moved from ImportPage) */}
        <div className="rounded-2xl border border-[var(--danger)]/30 bg-[var(--surface)] p-4">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                Clear Imported Transactions
              </p>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Deletes only transactions created via Excel/CSV import (
                <strong>{importedTxCount ?? '…'} imported</strong>). Your{' '}
                <strong>{manualTxCount ?? '…'} manually added</strong> transactions are not affected.
              </p>
            </div>

            {!confirmClearImports && (
              <button
                id="clear-imports-btn"
                type="button"
                disabled={clearingImports || !importedTxCount}
                onClick={() => {
                  setConfirmClearAll(false)
                  setConfirmClearImports(true)
                }}
                className="flex shrink-0 items-center justify-center gap-2 rounded-xl border border-[var(--danger)] px-4 py-2 text-xs font-semibold text-[var(--danger)] transition-colors hover:bg-[var(--danger)] hover:text-white disabled:opacity-40 disabled:pointer-events-none"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {importedTxCount
                  ? `Clear ${importedTxCount.toLocaleString()} imported`
                  : 'No imported transactions'}
              </button>
            )}
          </div>

          {confirmClearImports && (
            <div className="mt-3 flex flex-col gap-3 rounded-xl border border-[var(--danger)]/40 bg-[var(--danger-muted)] p-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--danger)]" />
                <p className="text-xs font-medium text-[var(--text-primary)]">
                  This will permanently delete{' '}
                  <strong>
                    {importedTxCount?.toLocaleString() ?? 0} imported transaction
                    {importedTxCount === 1 ? '' : 's'}
                  </strong>{' '}
                  and invalidate your cached Insights summary. This cannot be undone.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  disabled={clearingImports}
                  onClick={handleClearImported}
                  className="flex items-center gap-1.5 rounded-lg bg-[var(--danger)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {clearingImports && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {clearingImports
                    ? 'Deleting…'
                    : `Delete ${importedTxCount?.toLocaleString() ?? 0} imported`}
                </button>
                <button
                  type="button"
                  disabled={clearingImports}
                  onClick={() => setConfirmClearImports(false)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--text-muted)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Clear ALL Transactions (Full Reset safety action) */}
        <div className="rounded-2xl border border-[var(--danger)]/30 bg-[var(--surface)] p-4">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div>
              <p className="text-sm font-semibold text-[var(--text-primary)]">
                Clear All Transactions
              </p>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                Permanently deletes all <strong>{totalTxCount ?? '…'} transactions</strong> (both imported and manual) while keeping your categories and payment accounts intact.
              </p>
            </div>

            {!confirmClearAll && (
              <button
                id="clear-all-txns-btn"
                type="button"
                disabled={clearingAll || !totalTxCount}
                onClick={() => {
                  setConfirmClearImports(false)
                  setConfirmClearAll(true)
                }}
                className="flex shrink-0 items-center justify-center gap-2 rounded-xl border border-[var(--danger)] px-4 py-2 text-xs font-semibold text-[var(--danger)] transition-colors hover:bg-[var(--danger)] hover:text-white disabled:opacity-40 disabled:pointer-events-none"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {totalTxCount
                  ? `Delete all ${totalTxCount.toLocaleString()}`
                  : 'No transactions'}
              </button>
            )}
          </div>

          {confirmClearAll && (
            <div className="mt-3 flex flex-col gap-3 rounded-xl border border-[var(--danger)]/40 bg-[var(--danger-muted)] p-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--danger)]" />
                <p className="text-xs font-medium text-[var(--text-primary)]">
                  Are you sure? This will permanently delete all{' '}
                  <strong>
                    {totalTxCount?.toLocaleString() ?? 0} transaction
                    {totalTxCount === 1 ? '' : 's'}
                  </strong>{' '}
                  and reset your Insights summary.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  disabled={clearingAll}
                  onClick={handleClearAll}
                  className="flex items-center gap-1.5 rounded-lg bg-[var(--danger)] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                >
                  {clearingAll && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {clearingAll
                    ? 'Deleting…'
                    : `Yes, delete all ${totalTxCount?.toLocaleString() ?? 0}`}
                </button>
                <button
                  type="button"
                  disabled={clearingAll}
                  onClick={() => setConfirmClearAll(false)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--text-muted)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── SECTION 3: APPEARANCE & ACCOUNT ── */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {/* Theme Preference */}
        <div className="flex flex-col justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center gap-2">
            {isDark ? (
              <Moon className="h-4 w-4 text-[var(--primary)]" />
            ) : (
              <Sun className="h-4 w-4 text-[var(--primary)]" />
            )}
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Appearance
            </h2>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setTheme('light')}
              className={`flex items-center justify-center gap-2 rounded-xl border py-2.5 text-xs font-semibold transition-all ${
                !isDark
                  ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)]'
                  : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Sun className="h-3.5 w-3.5" />
              Sync Light
            </button>
            <button
              type="button"
              onClick={() => setTheme('dark')}
              className={`flex items-center justify-center gap-2 rounded-xl border py-2.5 text-xs font-semibold transition-all ${
                isDark
                  ? 'border-[var(--primary)] bg-[var(--primary-muted)] text-[var(--primary)]'
                  : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Moon className="h-3.5 w-3.5" />
              Sync Dark
            </button>
          </div>
        </div>

        {/* Signed-in Account */}
        <div className="flex flex-col justify-between gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center gap-2">
            <UserIcon className="h-4 w-4 text-[var(--primary)]" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Account
            </h2>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {user?.photoURL && !imgError ? (
                <img
                  src={user.photoURL}
                  alt={user.displayName ?? 'User'}
                  referrerPolicy="no-referrer"
                  onError={() => setImgError(true)}
                  className="h-9 w-9 shrink-0 rounded-full object-cover ring-2 ring-[var(--primary-muted)]"
                />
              ) : (
                <div className="flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-full bg-[var(--primary)] text-sm font-semibold text-white ring-2 ring-[var(--primary-muted)]">
                  {userInitial}
                </div>
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-[var(--text-primary)]">
                  {user?.displayName ?? 'Spenza User'}
                </p>
                <p className="truncate text-xs text-[var(--text-muted)]">
                  {user?.email ?? ''}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={signOut}
              className="flex shrink-0 items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--danger)] hover:bg-[var(--danger-muted)] hover:text-[var(--danger)]"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

