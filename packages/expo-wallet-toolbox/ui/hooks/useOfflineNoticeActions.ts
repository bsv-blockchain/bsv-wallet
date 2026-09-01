import { useCallback, useEffect, useRef } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { PeerPayClient } from '@bsv/message-box-client'
import {
  DEFAULT_MESSAGE_BOX_URL,
  LEGACY_MESSAGE_BOX_URL,
  MESSAGE_BOX_URL_KEY,
  NO_MESSAGE_BOX
} from '@bsv/expo-wallet-toolbox'
import { nackRejectedReceived, sendBouncedOfflineNack } from '../../core/peerpay/offlineNacks'
import { updateOfflineAction, type OfflineActionRow } from '../../core/storage/methods/offlineActions'
import type { StorageExpoSQLite } from '../../core/storage/StorageExpoSQLite'
import { showToast } from '../components/ui/Toast'
import { offlineActionDetails } from '../components/pay/OfflineNotice'

async function readMessageBoxUrl(): Promise<string | undefined> {
  const saved = await AsyncStorage.getItem(MESSAGE_BOX_URL_KEY)
  if (saved === NO_MESSAGE_BOX) return undefined
  if (!saved || saved === LEGACY_MESSAGE_BOX_URL) return DEFAULT_MESSAGE_BOX_URL
  return saved
}

type ClipboardModule = typeof import('@react-native-clipboard/clipboard').default
let clipboardModule: ClipboardModule | undefined
function loadClipboard(): ClipboardModule {
  if (!clipboardModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    clipboardModule = require('@react-native-clipboard/clipboard').default as ClipboardModule
  }
  return clipboardModule
}

type WalletClient = ConstructorParameters<typeof PeerPayClient>[0]['walletClient']

export function useOfflineNoticeActions(args: {
  storage: StorageExpoSQLite | null | undefined
  permissionsManager: unknown
  adminOriginator: string
  online: boolean
  rejected: OfflineActionRow[]
  t: (key: string, options?: Record<string, unknown>) => string
  reload: () => void
  pushPay: (sats?: number) => void
}) {
  const { storage, permissionsManager, adminOriginator, online, rejected, t, reload, pushPay } = args
  const rejectedRef = useRef(rejected)
  rejectedRef.current = rejected

  const makeClient = useCallback(async () => {
    const pm = permissionsManager
    if (!pm) return undefined
    const url = await readMessageBoxUrl()
    if (!url) return undefined
    return new PeerPayClient({
      messageBoxHost: url,
      walletClient: pm as WalletClient,
      originator: adminOriginator
    })
  }, [permissionsManager, adminOriginator])

  useEffect(() => {
    if (!online || !storage || rejected.length === 0) return
    let cancelled = false
    void (async () => {
      const client = await makeClient()
      if (!client || cancelled) return
      await nackRejectedReceived({ client, storage, rows: rejectedRef.current })
    })()
    return () => {
      cancelled = true
    }
  }, [online, storage, makeClient, rejected])

  const onRequestAgain = useCallback(
    async (row: OfflineActionRow) => {
      if (!row.senderIdentityKey || !storage) return
      try {
        const client = await makeClient()
        if (!client) {
          showToast(t('message_box_unreachable'), { type: 'error' })
          return
        }
        await sendBouncedOfflineNack({
          client,
          storage,
          txid: row.txid,
          recipient: row.senderIdentityKey,
          force: true
        })
        showToast(t('payment_bounced_resend'), { type: 'success' })
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : t('unknown_error')
        showToast(message, { type: 'error' })
      }
    },
    [makeClient, storage, t]
  )

  const onCopyDetails = useCallback((row: OfflineActionRow) => {
    loadClipboard().setString(offlineActionDetails(row))
    showToast(t('copied'), { type: 'success' })
  }, [t])

  const onDismiss = useCallback(
    async (row: OfflineActionRow) => {
      const db = storage?.sqliteDb
      if (!db) return
      try {
        await updateOfflineAction(db, row.txid, { status: 'acknowledged' })
        showToast(t('dismiss_rejected_payment'), { type: 'success' })
        reload()
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : t('unknown_error')
        showToast(message, { type: 'error' })
      }
    },
    [storage, t, reload]
  )

  const onSendAgain = useCallback(
    async (row: OfflineActionRow) => {
      let sats: number | undefined
      try {
        const txs = storage ? await storage.findTransactions({ partial: { txid: row.txid }, noRawTx: true }) : []
        const raw = txs[0]?.satoshis
        if (typeof raw === 'number' && Number.isFinite(raw) && raw !== 0) sats = Math.abs(raw)
      } catch {
        // Prefill without an amount rather than blocking Send again.
      }
      pushPay(sats)
    },
    [storage, pushPay]
  )

  return { onRequestAgain, onCopyDetails, onDismiss, onSendAgain }
}
