import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import * as SecureStore from 'expo-secure-store'
import { WalletClient, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import type { WalletProtocol } from '@bsv/sdk'
import connectionStore from '../stores/ConnectionStore'
import type { Connection } from '../stores/ConnectionStore'
import {
  buildPairingSignatureMessage,
  buildRelayWebSocketUrl,
  MAX_IN_FLIGHT_RPC,
  MAX_RELAY_RESPONSE_BYTES,
  parseBoundedWireEnvelope,
  parseRelayResponse,
  requireBoundedPlaintext,
  validateCanonicalExternalOrigin,
  validateConnectParams,
  validateBackendIdentityKey,
  validatePairingTopic,
  validateStoredConnectionSequence,
  validateStoredConnectionFields,
  type ConnectParams
} from '../services/walletConnectionValidation'

export type { ConnectParams } from '../services/walletConnectionValidation'

// ── Constants ─────────────────────────────────────────────────────────────────

export const IMPLEMENTED_METHODS = new Set([
  'getPublicKey', 'listOutputs', 'listCertificates', 'createAction', 'signAction',
  'listActions', 'internalizeAction', 'acquireCertificate',
  'relinquishCertificate', 'revealCounterpartyKeyLinkage', 'createHmac', 'verifyHmac',
  'encrypt', 'decrypt', 'createSignature', 'verifySignature',
])

const NAV_TIMEOUT_MS      = 5  * 60 * 1000  // 5 min  — navigated away from pair screen
const APP_STATE_TIMEOUT_MS = 12 * 60 * 1000  // 12 min — app backgrounded

export const lastSeqKey = (topic: string) => `wallet_pairing_lastseq_${topic}`

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'

type RpcRequest  = { id: string; seq: number; method: string; params: unknown }
type RpcResponse = { id: string; seq: number; result?: unknown; error?: { code: number; message: string } }
type WireEnvelope = { topic: string; ciphertext: string; mobileIdentityKey?: string }

export interface SessionMeta {
  topic:              string
  origin:             string
  relay:              string
  backendIdentityKey: string
  mobileIdentityKey:  string
  protocolID:         WalletProtocol
}

interface WalletConnectionContextValue {
  status:             ConnectionStatus
  sessionMeta:        SessionMeta | null
  errorMsg:           string | null
  connect:            (params: ConnectParams, wallet: WalletClient) => Promise<void>
  reconnect:          (connection: Connection, wallet: WalletClient) => Promise<void>
  disconnect:         () => void
  startNavTimer:      () => void
  cancelNavTimer:     () => void
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function encryptPayload(
  wallet: WalletClient,
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  payload: string,
): Promise<string> {
  const plaintext = Array.from(new TextEncoder().encode(payload))
  const { ciphertext } = await wallet.encrypt({ protocolID, keyID, counterparty, plaintext })
  return Buffer.from(ciphertext).toString('base64url')
}

async function decryptPayload(
  wallet: WalletClient,
  protocolID: WalletProtocol,
  keyID: string,
  counterparty: string,
  ciphertextB64: string,
): Promise<string> {
  const ciphertext = Array.from(Buffer.from(ciphertextB64, 'base64url'))
  const { plaintext } = await wallet.decrypt({ protocolID, keyID, counterparty, ciphertext })
  return new TextDecoder().decode(new Uint8Array(requireBoundedPlaintext(plaintext)))
}

async function verifyQrSignature(params: Required<ConnectParams>): Promise<void> {
  if (!params.sig) throw new Error('QR code is not signed — do not connect')
  const anyoneWallet = new ProtoWallet(new PrivateKey(1))
  const payload = Array.from(new TextEncoder().encode(buildPairingSignatureMessage(params)))
  const signature = Utils.toArray(params.sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64') as number[]
  const { valid } = await anyoneWallet.verifySignature({
    data:         payload,
    signature,
    protocolID:   [0, 'qr pairing'],
    keyID:        params.topic,
    counterparty: params.backendIdentityKey,
  })
  if (!valid) throw new Error('QR code signature is invalid — do not connect')
}

async function readBoundedRelayResponse(res: Response): Promise<string> {
  const declared = res.headers.get('content-length')
  if (declared !== null) {
    if (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_RELAY_RESPONSE_BYTES) {
      throw new Error('Origin server relay response is too large')
    }
  }

  // Modern React Native exposes a WHATWG response stream. Bound it while it is
  // consumed; the fallback still validates before JSON.parse on runtimes whose
  // fetch implementation exposes only text().
  const reader = res.body?.getReader?.()
  if (reader) {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RELAY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error('Origin server relay response is too large')
      }
      chunks.push(value)
    }
    const joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      joined.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(joined)
  }

  const text = await res.text()
  if (text.length > MAX_RELAY_RESPONSE_BYTES || new TextEncoder().encode(text).length > MAX_RELAY_RESPONSE_BYTES) {
    throw new Error('Origin server relay response is too large')
  }
  return text
}

export async function fetchRelay(origin: string, topic: string): Promise<string> {
  const validatedTopic = validatePairingTopic(topic)
  const external = validateCanonicalExternalOrigin(origin)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(`${external.origin}/api/session/${encodeURIComponent(validatedTopic)}`, {
      signal: controller.signal,
      redirect: 'error'
    })
    if (!res.ok) throw new Error(`Could not fetch session from origin: HTTP ${res.status}`)
    const raw = await readBoundedRelayResponse(res)
    return parseRelayResponse(raw)
  } finally {
    clearTimeout(timer)
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

const WalletConnectionContext = createContext<WalletConnectionContextValue | null>(null)

export function useWalletConnection() {
  const ctx = useContext(WalletConnectionContext)
  if (!ctx) throw new Error('useWalletConnection must be used within WalletConnectionProvider')
  return ctx
}

interface WalletConnectionProviderProps {
  children: React.ReactNode
  /** Sent to the desktop session as `walletMeta.name` during pairing. Host
   * apps should pass their own display name (see UserContext's `appName`
   * for the equivalent pattern) — defaults to a generic value so this
   * package makes no assumption about which app is embedding it. */
  walletName?: string
}

export function WalletConnectionProvider({ children, walletName = 'App' }: WalletConnectionProviderProps) {
  const [status,        setStatus]        = useState<ConnectionStatus>('idle')
  const [sessionMeta,   setSessionMeta]   = useState<SessionMeta | null>(null)
  const [errorMsg,      setErrorMsg]      = useState<string | null>(null)

  // Internal refs — changes here don't trigger re-renders
  const wsRef              = useRef<WebSocket | null>(null)
  const lastSeqRef         = useRef(0)
  const navTimerRef        = useRef<ReturnType<typeof setTimeout> | null>(null)
  const appStateTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const intentionalCloseRef = useRef(false)
  // Snapshot of sessionMeta for use inside async WS callbacks
  const sessionMetaRef   = useRef<SessionMeta | null>(null)
  useEffect(() => { sessionMetaRef.current = sessionMeta }, [sessionMeta])

  // ── Disconnect ─────────────────────────────────────────────────────────────

  const disconnect = useCallback(() => {
    const topic = sessionMetaRef.current?.topic
    if (topic) {
      void SecureStore.setItemAsync(lastSeqKey(topic), String(lastSeqRef.current))
      connectionStore.setStatus(topic, 'disconnected')
    }
    intentionalCloseRef.current = true
    const ws = wsRef.current
    wsRef.current = null
    ws?.close()
    if (navTimerRef.current)      { clearTimeout(navTimerRef.current);      navTimerRef.current      = null }
    if (appStateTimerRef.current) { clearTimeout(appStateTimerRef.current); appStateTimerRef.current = null }
    setSessionMeta(null)
    setStatus('idle')
  }, [])

  // ── Nav timer (pair screen lifecycle) ─────────────────────────────────────

  const startNavTimer = useCallback(() => {
    if (navTimerRef.current) clearTimeout(navTimerRef.current)
    navTimerRef.current = setTimeout(() => {
      navTimerRef.current = null
      if (wsRef.current) disconnect()
    }, NAV_TIMEOUT_MS)
  }, [disconnect])

  const cancelNavTimer = useCallback(() => {
    if (navTimerRef.current) { clearTimeout(navTimerRef.current); navTimerRef.current = null }
  }, [])

  // ── AppState timer (app backgrounded) ────────────────────────────────────

  useEffect(() => {
    const sub = AppState.addEventListener('change', nextState => {
      if (nextState === 'background' || nextState === 'inactive') {
        if (appStateTimerRef.current) clearTimeout(appStateTimerRef.current)
        appStateTimerRef.current = setTimeout(() => {
          appStateTimerRef.current = null
          if (wsRef.current) disconnect()
        }, APP_STATE_TIMEOUT_MS)
      } else if (nextState === 'active') {
        if (appStateTimerRef.current) { clearTimeout(appStateTimerRef.current); appStateTimerRef.current = null }
      }
    })
    return () => sub.remove()
  }, [disconnect])

  // ── RPC dispatch ──────────────────────────────────────────────────────────

  async function handleRpc(
    request: RpcRequest,
    meta: SessionMeta,
    ws: WebSocket,
    wallet: WalletClient,
  ): Promise<void> {
    const sendResponse = async (response: RpcResponse) => {
      try {
        const ciphertext = await encryptPayload(
          wallet, meta.protocolID, meta.topic, meta.backendIdentityKey, JSON.stringify(response),
        )
        ws.send(JSON.stringify({ topic: meta.topic, ciphertext } satisfies WireEnvelope))
      } catch (err) {
        console.warn('[WalletConnection] sendResponse failed:', err)
      }
    }

    if (!IMPLEMENTED_METHODS.has(request.method)) {
      await sendResponse({ id: request.id, seq: request.seq,
        error: { code: 501, message: `Method "${request.method}" is not implemented` } })
      return
    }

    // Call wallet method directly — WalletPermissionsManager handles all
    // permission prompts (spending, protocol, basket, certificate) via its
    // own callbacks and the existing wallet permission modals.
    let result: unknown
    let error: { code: number; message: string } | undefined
    try {
      type WFn = (p: unknown) => Promise<unknown>
      result = await (wallet as unknown as Record<string, WFn>)[request.method](request.params)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Wallet error'
      // WalletPermissionsManager throws when user denies — surface as rejection
      const code = message.includes('denied') || message.includes('rejected') ? 4001 : 500
      error = { code, message }
    }

    await sendResponse(error
      ? { id: request.id, seq: request.seq, error }
      : { id: request.id, seq: request.seq, result },
    )
  }

  // ── Shared WS message / event wiring ─────────────────────────────────────

  function wireSocket(
    ws: WebSocket,
    wallet: WalletClient,
    meta: SessionMeta,
    initialSeq: number,
    onFirstMessage: () => void,
  ) {
    wsRef.current      = ws
    lastSeqRef.current = initialSeq
    let firstMessageFired = false
    let inFlightRpc = 0

    ws.onmessage = async event => {
      if (inFlightRpc >= MAX_IN_FLIGHT_RPC) {
        console.warn('[WalletConnection] dropping message: too many requests in flight')
        return
      }
      inFlightRpc++
      try {
        const envelope = parseBoundedWireEnvelope(event.data, meta.topic)

        let plaintext: string
        try {
          plaintext = await decryptPayload(
            wallet, meta.protocolID, meta.topic, meta.backendIdentityKey, envelope.ciphertext,
          )
        } catch (err) {
          console.warn('[WalletConnection] decryptPayload failed:', err)
          return
        }

        const msg = JSON.parse(plaintext) as RpcRequest | RpcResponse
        const sequence = msg !== null && typeof msg === 'object' && !Array.isArray(msg)
          ? (msg as { seq?: unknown }).seq
          : undefined
        if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence <= lastSeqRef.current) {
          console.warn('[WalletConnection] dropping message: seq', sequence, '<= lastSeq', lastSeqRef.current)
          return
        }
        lastSeqRef.current = sequence

        if (!firstMessageFired) {
          firstMessageFired = true
          onFirstMessage()
        }

        if ('method' in msg && msg.method === 'pairing_ack') return
        if ('method' in msg && typeof msg.method === 'string' &&
            typeof msg.id === 'string' && msg.id.length > 0 && msg.id.length <= 128) {
          await handleRpc(msg as RpcRequest, meta, ws, wallet)
        }
      } catch {
        // malformed outer envelope — drop silently
      } finally {
        inFlightRpc--
      }
    }

    ws.onerror = () => {
      setErrorMsg('WebSocket connection failed')
      setStatus('error')
    }

    ws.onclose = () => {
      const wasIntentional = intentionalCloseRef.current
      intentionalCloseRef.current = false

      // Don't change the state if this is not the current ws
      if (!wasIntentional && wsRef.current !== null && wsRef.current !== ws) {
        return
      }

      if (!wasIntentional) {
        const topic = sessionMetaRef.current?.topic
        if (topic) {
          void SecureStore.setItemAsync(lastSeqKey(topic), String(lastSeqRef.current))
          connectionStore.setStatus(topic, 'disconnected')
        }
      }
      wsRef.current = null
      lastSeqRef.current = 0
      if (navTimerRef.current)      { clearTimeout(navTimerRef.current);      navTimerRef.current      = null }
      if (appStateTimerRef.current) { clearTimeout(appStateTimerRef.current); appStateTimerRef.current = null }
      setSessionMeta(null)
      // Don't override the 'idle' status that disconnect() already set
      if (!wasIntentional) {
        if (firstMessageFired) {
          setErrorMsg('Connection closed — the desktop session ended')
          setStatus('disconnected')
        } else {
          setErrorMsg('Could not reach the desktop — check that the browser tab is still open')
          setStatus('error')
        }
      }
    }
  }

  // ── connect (fresh pairing) ───────────────────────────────────────────────

  const connect = useCallback(async (params: ConnectParams, wallet: WalletClient) => {
    setStatus('connecting')
    setErrorMsg(null)

    let relay: string
    let validated: ReturnType<typeof validateConnectParams>
    try {
      // This provider is a public embedding boundary. Validate every field here
      // even when a host screen already parsed the QR.
      validated = validateConnectParams(params)
      // Verify QR signature before trusting the origin or opening any connection
      await verifyQrSignature(validated.params)

      // Fetch relay URL from origin over HTTPS — TLS cert is the trust anchor
      relay = await fetchRelay(validated.external.origin, validated.params.topic)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Connection failed')
      setStatus('error')
      throw err
    }

    const protocolID = validated.protocolID
    const identityResult = await wallet.getPublicKey({ identityKey: true })
    const mobileIdentityKey = validateBackendIdentityKey(identityResult.publicKey)

    const meta: SessionMeta = {
      topic: validated.params.topic, origin: validated.external.origin, relay,
      backendIdentityKey: validated.params.backendIdentityKey, mobileIdentityKey,
      protocolID,
    }
    setSessionMeta(meta)

    const ws = new WebSocket(buildRelayWebSocketUrl(relay, validated.params.topic))

    ws.onopen = async () => {
      try {
        const payload = JSON.stringify({
          id: crypto.randomUUID(), seq: 1, method: 'pairing_approved',
          params: {
            mobileIdentityKey,
            protocolID: validated.params.protocolID,
            walletMeta: { name: walletName, platform: 'mobile' },
            permissions: Array.from(IMPLEMENTED_METHODS),
          },
        })
        const ciphertext = await encryptPayload(
          wallet, protocolID, validated.params.topic, validated.params.backendIdentityKey, payload
        )
        ws.send(JSON.stringify({ topic: validated.params.topic, mobileIdentityKey, ciphertext } satisfies WireEnvelope))
      } catch {
        setErrorMsg('Failed to send pairing message')
        setStatus('error')
      }
    }

    wireSocket(ws, wallet, meta, 0, () => {
      connectionStore.add({
        sessionId: validated.params.topic, origin: validated.external.origin, relay,
        backendIdentityKey: validated.params.backendIdentityKey, mobileIdentityKey,
        protocolID: validated.params.protocolID,
        connectedAt: Date.now(), status: 'active',
      })
      setStatus('connected')
    })
  }, [walletName]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── reconnect (resume from stored session) ────────────────────────────────

  const reconnect = useCallback(async (connection: Connection, wallet: WalletClient) => {
    setStatus('connecting')
    setErrorMsg(null)

    // Stored connection data is untrusted after import or database tampering.
    const validated = validateStoredConnectionFields(connection)
    const identityResult = await wallet.getPublicKey({ identityKey: true })
    const currentMobileIdentityKey = validateBackendIdentityKey(identityResult.publicKey)
    if (currentMobileIdentityKey !== validated.mobileIdentityKey) {
      throw new Error('Stored connection belongs to a different wallet identity')
    }
    // Fetch relay URL from origin over HTTPS — relay may have moved since last connection
    const relay = await fetchRelay(validated.external.origin, validated.topic)

    const protocolID = validated.protocolID
    const storedSeq  = await SecureStore.getItemAsync(lastSeqKey(validated.topic))
    const initialSeq = validateStoredConnectionSequence(storedSeq)

    const meta: SessionMeta = {
      topic: validated.topic, origin: validated.external.origin, relay,
      backendIdentityKey: validated.backendIdentityKey,
      mobileIdentityKey:  validated.mobileIdentityKey,
      protocolID,
    }
    setSessionMeta(meta)

    const ws = new WebSocket(buildRelayWebSocketUrl(relay, validated.topic))

    ws.onopen = async () => {
      try {
        const payload = JSON.stringify({
          id: crypto.randomUUID(), seq: initialSeq + 1, method: 'pairing_approved',
          params: {
            mobileIdentityKey: validated.mobileIdentityKey,
            protocolID: validated.protocolIDRaw,
            walletMeta: { name: walletName, platform: 'mobile' },
            permissions: Array.from(IMPLEMENTED_METHODS),
          },
        })
        const ciphertext = await encryptPayload(
          wallet, protocolID, validated.topic, validated.backendIdentityKey, payload,
        )
        ws.send(JSON.stringify({
          topic: validated.topic,
          mobileIdentityKey: validated.mobileIdentityKey,
          ciphertext,
        } satisfies WireEnvelope))
      } catch {
        setErrorMsg('Failed to send reconnect message')
        setStatus('error')
      }
    }

    wireSocket(ws, wallet, meta, initialSeq, () => {
      connectionStore.setStatus(validated.topic, 'active')
      setStatus('connected')
    })
  }, [walletName]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Provider ──────────────────────────────────────────────────────────────

  const value = useMemo<WalletConnectionContextValue>(() => ({
    status, sessionMeta, errorMsg,
    connect, reconnect, disconnect,
    startNavTimer, cancelNavTimer,
  }), [status, sessionMeta, errorMsg, connect, reconnect, disconnect, startNavTimer, cancelNavTimer])

  return (
    <WalletConnectionContext.Provider value={value}>
      {children}
    </WalletConnectionContext.Provider>
  )
}
