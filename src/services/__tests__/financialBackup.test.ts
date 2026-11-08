import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertExpenseCanBeDeleted, ExpenseDeletionError, repaymentDeletionMessage } from '../../utils/expenseDeletion.ts'
import { exportCompleteFinancialData } from '../financialBackup.ts'
import type { Transaction } from '../../types/index.ts'

describe('financialBackup & Destructive Operation Safeguards (Phase 8.1)', () => {
  it('1. exportCompleteFinancialData rejects missing or invalid UID', async () => {
    await assert.rejects(
      async () => {
        await exportCompleteFinancialData('')
      },
      /User UID is required/
    )

    await assert.rejects(
      async () => {
        await exportCompleteFinancialData('   ')
      },
      /User UID is required/
    )
  })

  it('2. destructive safeguard: assertExpenseCanBeDeleted blocks deletion of partially repaid expenses', () => {
    const tx: Transaction = {
      id: 'tx-part-repaid',
      amountPaise: 5000,
      type: 'everyday',
      description: 'Dinner',
      categoryId: 'food',
      date: new Date(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 2500,
      reimbursementStatus: 'partial',
      splits: [
        {
          personId: 'p-1',
          personName: 'Alice',
          amountPaise: 5000,
          repaidPaise: 2500,
          settledAt: null,
        },
      ],
    } as any

    assert.throws(
      () => {
        assertExpenseCanBeDeleted(tx)
      },
      (err: any) => {
        assert.ok(err instanceof ExpenseDeletionError)
        assert.equal(err.message, repaymentDeletionMessage)
        return true
      }
    )
  })

  it('3. destructive safeguard: assertExpenseCanBeDeleted blocks deletion of fully settled expenses', () => {
    const tx: Transaction = {
      id: 'tx-settled',
      amountPaise: 5000,
      type: 'everyday',
      description: 'Movie ticket',
      categoryId: 'entertainment',
      date: new Date(),
      paymentMode: 'UPI',
      paymentAccountId: 'acc-1',
      recoverablePaise: 0,
      reimbursementStatus: 'settled',
      splits: [
        {
          personId: 'p-1',
          personName: 'Alice',
          amountPaise: 5000,
          repaidPaise: 5000,
          settledAt: new Date(),
        },
      ],
    } as any

    assert.throws(
      () => {
        assertExpenseCanBeDeleted(tx)
      },
      (err: any) => {
        assert.ok(err instanceof ExpenseDeletionError)
        assert.equal(err.message, repaymentDeletionMessage)
        return true
      }
    )
  })

  it('4. destructive safeguard: blocks deletion when split item has repaidPaise > 0 even if status is not partial/settled', () => {
    const tx: Transaction = {
      id: 'tx-status-none-but-repaid',
      amountPaise: 5000,
      type: 'everyday',
      description: 'Cab fare',
      categoryId: 'travel',
      date: new Date(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 5000,
      reimbursementStatus: 'none',
      splits: [
        {
          personId: 'p-1',
          personName: 'Bob',
          amountPaise: 5000,
          repaidPaise: 1000,
          settledAt: null,
        },
      ],
    } as any

    assert.throws(
      () => {
        assertExpenseCanBeDeleted(tx)
      },
      (err: any) => {
        assert.ok(err instanceof ExpenseDeletionError)
        assert.equal(err.message, repaymentDeletionMessage)
        return true
      }
    )
  })

  it('5. destructive safeguard: allows deletion of clean unpaid expenses and personal expenses', () => {
    // Unpaid split expense
    const unpaidSplit: Transaction = {
      id: 'tx-unpaid-split',
      amountPaise: 4000,
      type: 'everyday',
      description: 'Unpaid coffee',
      categoryId: 'food',
      date: new Date(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 4000,
      reimbursementStatus: 'pending',
      splits: [
        {
          personId: 'p-1',
          personName: 'Charlie',
          amountPaise: 4000,
          repaidPaise: 0,
          settledAt: null,
        },
      ],
    } as any

    // Should not throw
    assert.doesNotThrow(() => {
      assertExpenseCanBeDeleted(unpaidSplit)
    })

    // Unsplit personal expense
    const personal: Transaction = {
      id: 'tx-personal',
      amountPaise: 1500,
      type: 'everyday',
      description: 'Personal lunch',
      categoryId: 'food',
      date: new Date(),
      paymentMode: 'Cash',
      paymentAccountId: null,
      recoverablePaise: 0,
      reimbursementStatus: 'none',
      splits: [],
    } as any

    // Should not throw
    assert.doesNotThrow(() => {
      assertExpenseCanBeDeleted(personal)
    })
  })
})

