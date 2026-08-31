/**
 * Map a wallet/engine error onto a user-facing i18n key.
 *
 * `WERR_REVIEW_ACTIONS` means a stuck reservation or invalid-change record —
 * Check Wallet is the repair, not retrying the send.
 */
export function userFacingPayError(e: unknown): { key: string; offerWalletCheck: boolean } {
  const message =
    e instanceof Error
      ? e.message
      : typeof e === 'string'
        ? e
        : String((e as { message?: unknown } | undefined)?.message ?? e ?? '')
  if (/WERR_REVIEW_ACTIONS|review actions/i.test(message)) {
    return { key: 'error_review_actions', offerWalletCheck: true }
  }
  return { key: 'unknown_error', offerWalletCheck: false }
}
