/**
 * DirectPayProvider runs the open wallet's {@link DirectPayManager}, and `useDirectPay` is how a
 * screen reads its state, changes the settings and pays live.
 *
 * Mount it inside `WalletContextProvider`. It does nothing (and `available` is false) unless the
 * host turned direct payments on (`ToolboxConfig.directPay.enabled`) and installed
 * `@bsv/webrtpay` (an optional peer dependency). It starts the manager once the wallet is built,
 * with this wallet's identity key, network and message box, and the device settings: what the
 * user saved, else the host's relay and STUN servers, else the built-in ones. The host's
 * `RTCPeerConnection` (react-native-webrtc's) comes from the same config.
 *
 * Receiving runs only while the app is in the foreground: the provider tells the manager when
 * the app goes to (`background`) and comes back from the background. `inactive` (a Face ID
 * prompt, the control centre) is not leaving: a payment in progress must survive it.
 *
 * Arrivals are announced through `onToast` (as `WalletContextProvider` takes it), once per
 * payment whichever way it came: the inbox credit pass and this manager share the seen store.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore
} from 'react'
import { AppState } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useWallet, useWalletManagers, useWalletStatus } from '../context/WalletContext'
import { getDirectPayConfig } from '../toolboxConfig'
import { getOnline, subscribeOnline } from '../net/online'
import { makeCreditClassifier } from '../pay/creditErrors'
import {
  DEFAULT_MESSAGE_BOX_URL,
  LEGACY_MESSAGE_BOX_URL,
  MESSAGE_BOX_URL_KEY,
  NO_MESSAGE_BOX,
  makePeerPayClient
} from '../pay/rails/handle'
import { sendViaDirect, type DirectSendResult } from '../pay/rails/direct'
import { profileScopedKey } from '../profiles/profileStore'
import { deviceKVStorage } from './deviceStore'
import { DirectPayManager, type DirectPaySnapshot, type DirectPayToast } from './DirectPayManager'
import { NotSentError } from './payFlow'
import { loadDirectPaySettings, saveDirectPaySettings, type DirectPayHostDefaults } from './settings'
import { liveStatus } from './status'
import type { DirectPaySettings, LiveStatus } from './types'
import { loadWebRTPay, type MessageBoxLike, type WebRTPayModule, type WebRTPayWallet } from './webrtpay'

export interface DirectPaySendArgs {
  recipient: string
  satoshis: number
  note?: string
  recipientName?: string
  /** The recipient's message-box host from a BRC-125 `url` extension. */
  recipientHost?: string
  /** Cancels the dial, and stops the payment before it is made. */
  signal?: AbortSignal
}

export interface DirectPayContextValue {
  /** This build offers direct payments and `@bsv/webrtpay` is installed. */
  available: boolean
  snapshot: DirectPaySnapshot
  /** The Receive card for the snapshot (i18n keys). */
  live: LiveStatus
  /** The device settings in effect; null until read. */
  settings: DirectPaySettings | null
  /** Saves the settings (see `saveDirectPaySettings`) and applies them; throws `DirectPaySettingsError`. */
  saveSettings: (input: Partial<DirectPaySettings>) => Promise<DirectPaySettings>
  /** Reads the settings and the message box address again, and applies them. */
  reload: () => Promise<void>
  /** Whether {@link sendDirect} can run now: a client is up and this wallet has a message box to finish through. */
  canSendDirect: boolean
  /**
   * Pays `recipient` live (`sendViaDirect`). Pass it as `payIdentity`'s `direct` route. Throws
   * `NotSentError` when it stopped before the payment was made.
   */
  sendDirect: (args: DirectPaySendArgs) => Promise<DirectSendResult>
}

const OFF_SNAPSHOT: DirectPaySnapshot = {
  client: null,
  status: 'off',
  via: null,
  relayUnreachable: false,
  error: '',
  notice: '',
  received: 0,
  background: false
}

const unavailable = async (): Promise<never> => {
  throw new NotSentError('Direct payments are not available', 'not configured')
}

const DirectPayContext = createContext<DirectPayContextValue>({
  available: false,
  snapshot: OFF_SNAPSHOT,
  live: liveStatus(OFF_SNAPSHOT),
  settings: null,
  saveSettings: unavailable,
  reload: async () => {},
  canSendDirect: false,
  sendDirect: unavailable
})

export const useDirectPay = (): DirectPayContextValue => useContext(DirectPayContext)

/** The message box this profile uses, or undefined when the user turned it off (as WalletContext reads it). */
async function readMessageBoxHost(): Promise<string | undefined> {
  const saved = await AsyncStorage.getItem(profileScopedKey(MESSAGE_BOX_URL_KEY))
  if (saved === NO_MESSAGE_BOX) return undefined
  return !saved || saved === LEGACY_MESSAGE_BOX_URL ? DEFAULT_MESSAGE_BOX_URL : saved
}

/** The device settings (user's, else the host's, else built-in) and this profile's message box. */
async function readInputs(
  hostDefaults: DirectPayHostDefaults
): Promise<{ settings: DirectPaySettings; messageBoxUrl: string | undefined }> {
  const [settings, messageBoxUrl] = await Promise.all([
    loadDirectPaySettings(deviceKVStorage, hostDefaults),
    readMessageBoxHost().catch(() => undefined)
  ])
  return { settings, messageBoxUrl }
}

const subscribeNothing = () => () => {}
const offSnapshot = () => OFF_SNAPSHOT

export const DirectPayProvider: React.FC<{ children: React.ReactNode; onToast?: DirectPayToast }> = ({
  children,
  onToast
}) => {
  const config = getDirectPayConfig()
  const enabled = config?.enabled === true
  const hostDefaults = useMemo<DirectPayHostDefaults>(
    () => ({ relayUrl: config?.relayUrl, stunUrls: config?.stunUrls }),
    [config?.relayUrl, config?.stunUrls]
  )
  const webrtpay = useMemo<WebRTPayModule | null>(() => (enabled ? loadWebRTPay() : null), [enabled])

  const { managers, adminOriginator, storage } = useWalletManagers()
  const { walletBuilt, selectedNetwork } = useWalletStatus()
  const { peekLastMissHeight } = useWallet()

  const manager = useMemo(
    () =>
      webrtpay
        ? new DirectPayManager({
            webrtpay,
            storage: deviceKVStorage,
            subscribeOnline,
            getOnline,
            foreground: AppState.currentState !== 'background'
          })
        : null,
    [webrtpay]
  )

  // The toast and the classifier's chain-tracker context follow the latest render.
  useEffect(() => {
    manager?.setCallbacks({
      onToast,
      classifier: () => makeCreditClassifier({ getOnline, peekLastMissHeight })
    })
  }, [manager, onToast, peekLastMissHeight])

  const snapshot = useSyncExternalStore(
    manager ? manager.subscribe : subscribeNothing,
    manager ? manager.getSnapshot : offSnapshot
  )

  const [settings, setSettings] = useState<DirectPaySettings | null>(null)
  const [messageBoxUrl, setMessageBoxUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!manager) return
    let current = true
    void readInputs(hostDefaults).then(inputs => {
      if (!current) return
      setSettings(inputs.settings)
      setMessageBoxUrl(inputs.messageBoxUrl)
    })
    return () => {
      current = false
    }
  }, [manager, hostDefaults])

  const reload = useCallback(async () => {
    if (!manager) return
    const inputs = await readInputs(hostDefaults)
    setSettings(inputs.settings)
    setMessageBoxUrl(inputs.messageBoxUrl)
  }, [manager, hostDefaults])

  const wallet = managers.permissionsManager as unknown as WebRTPayWallet | undefined
  // The identity key of the wallet it was read from, so a rebuilt wallet never runs on the last one's.
  const [identityOf, setIdentityOf] = useState<{ wallet: WebRTPayWallet; key: string } | undefined>(undefined)
  const identity = wallet && identityOf?.wallet === wallet ? identityOf.key : undefined
  useEffect(() => {
    if (!manager || !walletBuilt || !wallet) return
    let current = true
    wallet
      .getPublicKey({ identityKey: true }, adminOriginator)
      .then(({ publicKey }) => {
        if (current) setIdentityOf({ wallet, key: publicKey })
      })
      .catch(e => console.warn('[DirectPayProvider] No identity key:', e instanceof Error ? e.message : String(e)))
    return () => {
      current = false
    }
  }, [manager, walletBuilt, wallet, adminOriginator])

  const peerPayClient = useMemo<MessageBoxLike | null>(
    () =>
      wallet && messageBoxUrl
        ? (makePeerPayClient({
            wallet: wallet as never,
            messageBoxUrl,
            originator: adminOriginator
          }) as MessageBoxLike | null)
        : null,
    [wallet, messageBoxUrl, adminOriginator]
  )

  // Start with the wallet, follow its inputs, stop when it goes.
  useEffect(() => {
    if (!manager) return
    if (!walletBuilt || !wallet || !identity || !settings) {
      void manager.stop()
      return
    }
    void manager.start({
      wallet,
      originator: adminOriginator,
      identity,
      chain: selectedNetwork,
      peerPayClient,
      messageBoxUrl,
      settings,
      RTCPeerConnection: config?.RTCPeerConnection
    })
  }, [
    manager,
    walletBuilt,
    wallet,
    identity,
    settings,
    adminOriginator,
    selectedNetwork,
    peerPayClient,
    messageBoxUrl,
    config?.RTCPeerConnection
  ])

  useEffect(() => {
    if (!manager) return
    return () => {
      void manager.stop()
    }
  }, [manager])

  // Receive only in the foreground; read the message box address again on return (Settings may have changed it).
  useEffect(() => {
    if (!manager) return
    const subscription = AppState.addEventListener('change', next => {
      const foreground = next !== 'background'
      manager.setForeground(foreground)
      if (foreground && next === 'active') void reload()
    })
    return () => subscription.remove()
  }, [manager, reload])

  const saveSettings = useCallback(
    async (input: Partial<DirectPaySettings>) => {
      const saved = await saveDirectPaySettings(deviceKVStorage, input, hostDefaults)
      setSettings(saved)
      return saved
    },
    [hostDefaults]
  )

  const canSendDirect = !!snapshot.client && !!storage && !!wallet && !!messageBoxUrl
  const sendDirect = useCallback(
    async (args: DirectPaySendArgs): Promise<DirectSendResult> => {
      const client = manager?.getSnapshot().client
      if (!webrtpay || !manager || !client || !storage || !wallet) {
        throw new NotSentError('Direct payments are not available', 'no client')
      }
      return await sendViaDirect({
        wallet: wallet as never,
        adminOriginator,
        client,
        webrtpay,
        storage,
        messageBoxUrl: messageBoxUrl ?? '',
        signalingDown: manager.signalingDown,
        ...args
      })
    },
    [manager, webrtpay, storage, wallet, adminOriginator, messageBoxUrl]
  )

  const value = useMemo<DirectPayContextValue>(
    () => ({
      available: !!manager,
      snapshot,
      live: liveStatus(snapshot),
      settings,
      saveSettings,
      reload,
      canSendDirect,
      sendDirect
    }),
    [manager, snapshot, settings, saveSettings, reload, canSendDirect, sendDirect]
  )

  return <DirectPayContext.Provider value={value}>{children}</DirectPayContext.Provider>
}
