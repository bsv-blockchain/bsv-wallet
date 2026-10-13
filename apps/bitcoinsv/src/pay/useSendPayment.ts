// Sending money, on the shared core's rails, glued the way the existing app's
// UniversalSend glues them (packages/expo-wallet-toolbox/ui/components/pay/
// UniversalSend.tsx, sendHandle / sendAddress / sendToken / handleSend):
//   - to a person (identity key, from a contact, an @handle or a pay link):
//     sendViaHandle — minted, written to the outbox, delivered to their
//     message box, broadcast. A failure leaves it in the outbox to retry.
//   - to a BSV address: sendToAddress.
//   - a stablecoin: the Mandala runtime's sendToHandle; a refusal is the only
//     outcome allowed to say nothing was sent.
// One payment at a time: a second tap while one is in flight is ignored.
import { useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { isMessageBoxNetworkError, makePeerPayClient, NO_MESSAGE_BOX, sendViaHandle } from '@bsv/expo-wallet-toolbox/core/pay/rails/handle'
import { sendToAddress } from '@bsv/expo-wallet-toolbox/core/pay/rails/address'
import { formatTokenAmountWithUnit, tokenSendCopy, tokenThrowCopy, useMandala, useMessageBoxConfig } from '@bsv/expo-wallet-toolbox/ui'
import type { TokenAssetInfo } from '@bsv/expo-wallet-toolbox/core/mandala/runtime'

export type SendTarget =
  | { kind: 'person'; identityKey: string; messageBoxUrl?: string; name?: string }
  | { kind: 'address'; address: string }

export type SendOutcome =
  /**
   * Gone. `settled`: it's theirs now (BSV, once delivered and broadcast); a
   * stablecoin can be sent and still settling with its issuer, or not yet
   * announced to them, which the screen must say rather than tick.
   */
  | { kind: 'sent'; amountText: string; statusNote: string; settled: boolean }
  | { kind: 'failed'; message: string; refused?: boolean }

export function useSendPayment() {
  const { t } = useTranslation()
  const { managers, adminOriginator, storage } = useWallet()
  const { messageBoxUrl } = useMessageBoxConfig(t)
  const mandala = useMandala()
  const wallet = managers.permissionsManager || null
  const box = messageBoxUrl && messageBoxUrl !== NO_MESSAGE_BOX ? messageBoxUrl : undefined
  const client = useMemo(
    () => (wallet && box ? makePeerPayClient({ wallet: wallet as never, messageBoxUrl: box, originator: adminOriginator }) : null),
    [wallet, box, adminOriginator]
  )
  const sending = useRef(false)

  const send = useCallback(
    async (args: { target: SendTarget; units: number; asset?: TokenAssetInfo | null; note?: string }): Promise<SendOutcome | null> => {
      // a double tap must never reach a rail twice (UniversalSend's XR-061)
      if (sending.current) return null
      sending.current = true
      const note = args.note?.trim() || undefined
      try {
        const units = Math.round(args.units)
        if (!Number.isFinite(units) || units <= 0) return { kind: 'failed', message: t('enter_valid_amount') }

        if (args.asset) {
          const runtime = mandala.runtime
          if (!runtime) return { kind: 'failed', message: t('wallet_not_ready') }
          // a token has no address rail
          if (args.target.kind !== 'person') return { kind: 'failed', message: t('wallet_not_ready') }
          const asset = args.asset
          const issuer = asset.issuerName ?? t('token_issuer_fallback')
          try {
            const result = await runtime.sendToHandle({ assetId: asset.assetId, recipientIdentityKey: args.target.identityKey, baseUnits: units, ...(note ? { note } : {}) })
            if (result.kind !== 'sent') {
              const copy = tokenSendCopy(result, { ticker: asset.ticker, issuer: asset.issuerName, issuerFallback: t('token_issuer_fallback'), reasonFallback: t('token_err_reason_unknown') })
              return { kind: 'failed', message: copyText(copy, t), refused: result.kind === 'refused' }
            }
            mandala.refresh()
            const name = args.target.name
            return {
              kind: 'sent',
              amountText: formatTokenAmountWithUnit(units, asset) ?? t('token_row_amount_pending'),
              settled: result.notified && result.settled,
              statusNote: !result.notified
                ? t('pay_sent_not_notified')
                : result.settled
                  ? t('token_sent_settled', { issuer })
                  : name
                    ? t('token_sent_settling', { issuer, payee: name })
                    : t('token_sent_settling_unnamed', { issuer })
            }
          } catch (error) {
            // not a refusal: the overlay may have taken it and lost the answer
            const copy = tokenThrowCopy(error, { ticker: asset.ticker, issuer: asset.issuerName, issuerFallback: t('token_issuer_fallback') })
            return { kind: 'failed', message: copyText(copy, t) }
          }
        }

        if (!wallet || !storage) return { kind: 'failed', message: t('wallet_not_ready') }
        try {
          if (args.target.kind === 'person') {
            if (!client) return { kind: 'failed', message: t('message_box_off_hint') }
            const { satoshis } = await sendViaHandle({
              wallet: wallet as never,
              adminOriginator,
              client,
              storage,
              recipient: args.target.identityKey,
              recipientHost: args.target.messageBoxUrl,
              satoshis: units,
              messageBoxUrl: box as string,
              note,
              recipientName: args.target.name
            })
            return { kind: 'sent', amountText: bsv(satoshis), statusNote: 'Sent to their wallet. It’s theirs in seconds.', settled: true }
          }
          const { paidSatoshis } = await sendToAddress({ wallet: wallet as never, adminOriginator, address: args.target.address, satoshis: units, note })
          return { kind: 'sent', amountText: bsv(paidSatoshis), statusNote: '', settled: true }
        } catch (error: unknown) {
          const message =
            error instanceof RangeError
              ? t('enter_valid_amount')
              : isMessageBoxNetworkError(error)
                ? t('message_box_unreachable')
                : (error as { message?: string })?.message || t('unknown_error')
          return { kind: 'failed', message }
        }
      } finally {
        sending.current = false
      }
    },
    [t, mandala, wallet, storage, client, adminOriginator, box]
  )

  return { send, ready: !!wallet && !!storage, canReachPeople: !!client }
}

const bsv = (sats: number) => `${(sats / 100_000_000).toFixed(8).replace(/\.?0+$/, '')} BSV`

/** A token send's copy: an i18n key and its values. */
function copyText(copy: { key: string; values: Record<string, string> } | null | undefined, t: (k: string, o?: Record<string, unknown>) => string): string {
  return copy ? t(copy.key, copy.values) : t('unknown_error')
}
