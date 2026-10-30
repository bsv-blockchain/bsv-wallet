/**
 * Shared types for 1Color token transfers in the wallet.
 *
 * The color permission module holds all token custody and evidence. The
 * wallet keeps exactly one durable host record of its own: the
 * `color_transfers` journal (`transferJournal.ts`), one row per token tx per
 * role. It is the only key the broadcast hold and the abort refusal read
 * (plan 07, W1); neither ever reads the module's internal `color.v1.*` keys.
 *
 * Pure types and constants only — no runtime imports — so every module
 * (journal, guards, runtime, UI) can depend on this file without a cycle.
 */

export type ColorTransferRole = 'sent' | 'received'

export type ColorTransferRail = 'handle' | 'nearby' | 'external'

/**
 * sent: built → (parked ⇄) handed_over → settled | refused; built|parked → cancelled.
 * received: held → settled | refused.
 *
 * Only `settled` releases a tx to the network. Every other state, and a
 * missing row, holds it.
 */
export type ColorTransferState = 'built' | 'parked' | 'handed_over' | 'held' | 'settled' | 'refused' | 'cancelled'

export const COLOR_TRANSFER_ROLES: readonly ColorTransferRole[] = ['sent', 'received']
export const COLOR_TRANSFER_RAILS: readonly ColorTransferRail[] = ['handle', 'nearby', 'external']
export const COLOR_TRANSFER_STATES: readonly ColorTransferState[] = [
  'built',
  'parked',
  'handed_over',
  'held',
  'settled',
  'refused',
  'cancelled'
]

/** States no transition leaves. */
export const TERMINAL_TRANSFER_STATES: readonly ColorTransferState[] = ['settled', 'refused', 'cancelled']

/** A non-terminal row older than this is surfaced as "stuck". */
export const STUCK_AFTER_MS = 3 * 24 * 60 * 60 * 1000

export interface ColorTransferRow {
  txid: string
  role: ColorTransferRole
  /** `<64 lowercase hex>_<vout>` (IC §0). */
  assetId: string
  /** Exact token units of `outputIndex`. Stored as a canonical decimal TEXT, never a number. */
  units: bigint
  /** The output of `txid` this row is about: the payee's output on both sides. */
  outputIndex: number
  counterpartyKey?: string
  /**
   * The `createAction` reference of the action that built `txid`, when this
   * device built it. The abort refusal's lookup key; absent on received rows.
   */
  reference?: string
  rail: ColorTransferRail
  state: ColorTransferState
  /** Handle rail: whether the hand-over is known to have reached the recipient's box. */
  delivered: boolean
  /** The refusal code, on a `refused` row. */
  code?: string
  note?: string
  /** Sent rows: the receipt custody needed to resend (A′ when blinded). */
  derivationPrefix?: string
  derivationSuffix?: string
  senderIdentityKey?: string
  createdAt: string
  updatedAt: string
}

/**
 * The action label every token transfer carries, on every rail. A plain
 * (non-P) label: the home screen recognises a token row by it, so a user who
 * sends their last coin keeps the denomination across their history.
 */
export const MANDALA_ACTION_LABEL = 'mandala'
