import type { ReimbursementStatus, SplitShare, Transaction } from '../../types/index.ts'
import {
  allocateCustomMyShareSplitPaise,
  allocateEqualSplitPaise,
  getNormalizedSplits,
  getReimbursementStatus,
  UNASSIGNED_PERSON_ID,
  UNASSIGNED_PERSON_NAME,
} from '../../utils/splitMath.ts'

export type SharingMode = 'none' | 'fully_recoverable' | 'shared'
export type SplitPreset = 'equal_2' | 'equal_3' | 'equal_4' | 'equal_all' | 'custom_my_share'

export interface ParticipantInput {
  id: string
  name: string
}

export interface FormSplitCalculation {
  totalPaise: number
  mySharePaise: number
  recoverablePaise: number
  splits: SplitShare[]
  reimbursementStatus: ReimbursementStatus
  error: string | null
}

export interface RepaymentSafetyCheck {
  canSave: boolean
  conflicts: string[]
}

/**
 * Auto-selects the recommended split preset based on selected friends count.
 */
export function getRecommendedPreset(participantCount: number): SplitPreset {
  if (participantCount <= 1) return 'equal_2'
  if (participantCount === 2) return 'equal_3'
  if (participantCount === 3) return 'equal_4'
  return 'equal_all'
}

/**
 * Determine the initial sharing mode, participants, and preset when loading an expense.
 */
export function getInitialSharingState(tx: Transaction | null | undefined): {
  sharingMode: SharingMode
  initialParticipants: ParticipantInput[]
  splitPreset: SplitPreset
  customMySharePaise: number
} {
  if (!tx) {
    return {
      sharingMode: 'none',
      initialParticipants: [],
      splitPreset: 'equal_2',
      customMySharePaise: 0,
    }
  }

  const normalizedSplits = getNormalizedSplits(tx)
  if (normalizedSplits.length === 0) {
    if (tx.type === 'reimbursable') {
      const pid = tx.personId?.trim() || UNASSIGNED_PERSON_ID
      const pname = tx.personId?.trim() || UNASSIGNED_PERSON_NAME
      return {
        sharingMode: 'fully_recoverable',
        initialParticipants: [{ id: pid, name: pname }],
        splitPreset: 'equal_2',
        customMySharePaise: 0,
      }
    }
    return {
      sharingMode: 'none',
      initialParticipants: [],
      splitPreset: 'equal_2',
      customMySharePaise: 0,
    }
  }

  const initialParticipants = normalizedSplits.map(s => ({
    id: s.personId,
    name: s.personName,
  }))

  const gross = tx.amountPaise
  const recoverable = normalizedSplits.reduce((acc, s) => acc + s.amountPaise, 0)
  const myShare = gross - recoverable

  if (myShare === 0 || tx.type === 'reimbursable') {
    return {
      sharingMode: 'fully_recoverable',
      initialParticipants,
      splitPreset: 'equal_2',
      customMySharePaise: 0,
    }
  }

  const k = initialParticipants.length
  let preset: SplitPreset = 'equal_all'
  if (k === 1) preset = 'equal_2'
  else if (k === 2) preset = 'equal_3'
  else if (k === 3) preset = 'equal_4'

  const equalTest = allocateEqualSplitPaise(gross, initialParticipants.map(p => ({ personId: p.id, personName: p.name })), true)
  const isExactEqual =
    equalTest.mySharePaise === myShare &&
    equalTest.splits.length === normalizedSplits.length &&
    equalTest.splits.every((s, idx) => s.amountPaise === normalizedSplits[idx]?.amountPaise)

  if (!isExactEqual) {
    preset = 'custom_my_share'
  }

  return {
    sharingMode: 'shared',
    initialParticipants,
    splitPreset: preset,
    customMySharePaise: myShare,
  }
}

/**
 * Computes the split allocation and derived reimbursement status for the form.
 * Preserves existing repayment amounts and settled timestamps.
 */
export function computeFormSplits(params: {
  amountPaise: number
  sharingMode: SharingMode
  splitPreset: SplitPreset
  customMySharePaise: number
  participants: ParticipantInput[]
  existingRepaidMap?: ReadonlyMap<string, number>
  existingSettledAtMap?: ReadonlyMap<string, any>
}): FormSplitCalculation {
  const {
    amountPaise,
    sharingMode,
    splitPreset,
    customMySharePaise,
    participants,
    existingRepaidMap,
    existingSettledAtMap,
  } = params

  const gross = Math.max(0, Math.round(amountPaise || 0))

  if (sharingMode === 'none') {
    return {
      totalPaise: gross,
      mySharePaise: gross,
      recoverablePaise: 0,
      splits: [],
      reimbursementStatus: 'none',
      error: null,
    }
  }

  if (participants.length === 0) {
    return {
      totalPaise: gross,
      mySharePaise: sharingMode === 'fully_recoverable' ? 0 : gross,
      recoverablePaise: 0,
      splits: [],
      reimbursementStatus: 'none',
      error:
        sharingMode === 'fully_recoverable'
          ? 'Please select at least one person who owes this amount.'
          : 'Please select at least one person to split this bill with.',
    }
  }

  const participantInputs = participants.map(p => ({
    personId: p.id,
    personName: p.name,
  }))

  if (sharingMode === 'fully_recoverable') {
    const res = allocateEqualSplitPaise(gross, participantInputs, false, existingRepaidMap)
    const splitsWithSettled = res.splits.map(s => ({
      ...s,
      settledAt:
        s.repaidPaise === s.amountPaise && s.amountPaise > 0
          ? existingSettledAtMap?.get(s.personId) ?? null
          : null,
    }))

    const status = getReimbursementStatus({
      amountPaise: gross,
      type: 'everyday',
      splits: splitsWithSettled,
      recoverablePaise: res.recoverablePaise,
    })

    return {
      totalPaise: gross,
      mySharePaise: 0,
      recoverablePaise: res.recoverablePaise,
      splits: splitsWithSettled,
      reimbursementStatus: status,
      error: null,
    }
  }

  // Shared mode presets
  let presetError: string | null = null
  if (splitPreset === 'equal_2' && participants.length !== 1) {
    presetError = `Preset ÷2 requires 1 friend selected (2 people total including you). You currently have ${participants.length} selected.`
  } else if (splitPreset === 'equal_3' && participants.length !== 2) {
    presetError = `Preset ÷3 requires 2 friends selected (3 people total including you). You currently have ${participants.length} selected.`
  } else if (splitPreset === 'equal_4' && participants.length !== 3) {
    presetError = `Preset ÷4 requires 3 friends selected (4 people total including you). You currently have ${participants.length} selected.`
  }

  let res: ReturnType<typeof allocateEqualSplitPaise>
  if (splitPreset === 'custom_my_share') {
    if (customMySharePaise > gross) {
      return {
        totalPaise: gross,
        mySharePaise: gross,
        recoverablePaise: 0,
        splits: [],
        reimbursementStatus: 'none',
        error: 'Your personal share cannot exceed the total bill amount.',
      }
    }
    res = allocateCustomMyShareSplitPaise(gross, customMySharePaise, participantInputs, existingRepaidMap)
  } else {
    res = allocateEqualSplitPaise(gross, participantInputs, true, existingRepaidMap)
  }

  const splitsWithSettled = res.splits.map(s => ({
    ...s,
    settledAt:
      s.repaidPaise === s.amountPaise && s.amountPaise > 0
        ? existingSettledAtMap?.get(s.personId) ?? null
        : null,
  }))

  const status = getReimbursementStatus({
    amountPaise: gross,
    type: 'everyday',
    splits: splitsWithSettled,
    recoverablePaise: res.recoverablePaise,
  })

  return {
    totalPaise: gross,
    mySharePaise: res.mySharePaise,
    recoverablePaise: res.recoverablePaise,
    splits: splitsWithSettled,
    reimbursementStatus: status,
    error: presetError,
  }
}

/**
 * Validates repayment safety rules when editing a transaction with existing splits.
 * Prevents reducing a share below the amount already repaid, removing a repaid participant,
 * or silently converting a partially/fully repaid transaction to Personal.
 */
export function validateRepaymentSafety(
  originalTx: Transaction | null | undefined,
  sharingMode: SharingMode,
  selectedParticipantIds: ReadonlySet<string>,
  computedSplits: SplitShare[]
): RepaymentSafetyCheck {
  if (!originalTx) return { canSave: true, conflicts: [] }

  const initialSplits = getNormalizedSplits(originalTx)
  if (initialSplits.length === 0) return { canSave: true, conflicts: [] }

  const conflicts: string[] = []

  // 1. If switching to personal, check if any participant has repayment history
  if (sharingMode === 'none') {
    const totalRepaid = initialSplits.reduce((sum, s) => sum + s.repaidPaise, 0)
    if (totalRepaid > 0) {
      conflicts.push(
        `Cannot convert to Personal expense: ₹${(totalRepaid / 100).toFixed(2)} has already been repaid by participants. Recorded repayments must be cleared first.`
      )
    }
    return { canSave: conflicts.length === 0, conflicts }
  }

  // 2. Check if any participant who has repayments was removed
  for (const init of initialSplits) {
    if (init.repaidPaise > 0) {
      if (!selectedParticipantIds.has(init.personId)) {
        conflicts.push(
          `Cannot remove "${init.personName}": ₹${(init.repaidPaise / 100).toFixed(2)} has already been repaid on their share.`
        )
      }
    }
  }

  // 3. Check if any newly computed share is less than what was already repaid
  for (const share of computedSplits) {
    const orig = initialSplits.find(s => s.personId === share.personId)
    if (orig && orig.repaidPaise > share.amountPaise) {
      conflicts.push(
        `Share for "${share.personName}" (₹${(share.amountPaise / 100).toFixed(2)}) cannot be less than their already repaid amount of ₹${(orig.repaidPaise / 100).toFixed(2)}.`
      )
    }
  }

  return { canSave: conflicts.length === 0, conflicts }
}
