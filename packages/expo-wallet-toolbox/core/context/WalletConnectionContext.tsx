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
  MAX_IN_FLIGHT_RPC_BYTES,
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

/**
 * XR-018: WalletContext.tsx's logout() is a REACT ANCESTOR of
 * WalletConnectionProvider (app/_layout.tsx nests the connection provider
 * INSIDE WalletContextProvider), so it cannot call useWalletConnection()
 * itself — there is no ancestor WalletConnectionContext.Provider at that
 * point in the tree. Exactly one WalletConnectionProvider is ever mounted
 * (app/_layout.tsx), matching this package's other module-level
 * single-wallet-session state (e.g. WalletContext.tsx's
 * autoApproveThresholdSnapshot), so a plain module-level handle is enough to
 * let logout revoke any live paired session without becoming a consumer of
 * this context.
 */
let activeDisconnect: (() => void) | null = null

/** Tear down any live paired RPC socket. No-op if no WalletConnectionProvider
 * is mounted or no session is currently connected. */
export function disconnectActivePairedSession(): void {
  activeDisconnect?.()
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
  // XR-018: bumped every time an existing socket is torn down (disconnect(),
  // or connect()/reconnect() superseding a prior live session). wireSocket
  // captures the value at wiring time as "myGeneration" and every one of its
  // callbacks re-checks it before doing anything — closing/detaching a
  // socket's handlers cannot cancel an onmessage invocation that is already
  // mid-flight (awaiting decrypt or the durable sequence write) when the
  // teardown happens, so without this check that in-flight message could
  // still reach handleRpc and dispatch privileged RPC after the app has
  // already moved on to a different (or no) session.
  const connectionGenerationRef = useRef(0)
  // Snapshot of sessionMeta for use inside async WS callbacks
  const sessionMetaRef   = useRef<SessionMeta | null>(null)
  useEffect(() => { sessionMetaRef.current = sessionMeta }, [sessionMeta])

  // ── Disconnect ─────────────────────────────────────────────────────────────

  /** Fully detach `ws`'s handlers and close it, so it can never fire
   * onopen/onmessage/onerror/onclose for this provider again, and bump the
   * connection generation so any invocation of those handlers already
   * in-flight for it is dropped too (see connectionGenerationRef). No-op for
   * a null socket. */
  const closeAndDetachSocket = useCallback((ws: WebSocket | null) => {
    connectionGenerationRef.current++
    if (wsRef.current === ws) wsRef.current = null
    if (!ws) return
    ws.onopen    = null
    ws.onmessage = null
    ws.onerror   = null
    ws.onclose   = null
    try { ws.close() } catch { /* already closing/closed */ }
  }, [])

  /** XR-018: this provider models exactly one live paired session at a time
   * (a single wsRef/sessionMeta) — connect() and reconnect() call this
   * BEFORE wiring a new socket so a previously-live socket for a DIFFERENT
   * session is fully torn down first, instead of being silently orphaned
   * with full RPC authority intact while wsRef moves on to the new one.
   * Deliberately leaves status/sessionMeta React state alone: the caller
   * sets its own right after via setSessionMeta(meta), and flipping to
   * 'idle' here first would flash the UI back out of "connecting" for no
   * reason. */
  const supersedeExistingSocket = useCallback(() => {
    const topic = sessionMetaRef.current?.topic
    if (topic) {
      void SecureStore.setItemAsync(lastSeqKey(topic), String(lastSeqRef.current))
      connectionStore.setStatus(topic, 'disconnected')
    }
    closeAndDetachSocket(wsRef.current)
    if (navTimerRef.current)      { clearTimeout(navTimerRef.current);      navTimerRef.current      = null }
    if (appStateTimerRef.current) { clearTimeout(appStateTimerRef.current); appStateTimerRef.current = null }
  }, [closeAndDetachSocket])

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true
    supersedeExistingSocket()
    setSessionMeta(null)
    setStatus('idle')
  }, [supersedeExistingSocket])

  // Keep the module-level handle current so logout (a react ancestor of this
  // provider) can reach the LATEST disconnect closure. Clearing it on
  // unmount stops a stale/unmounted provider's disconnect from being called.
  useEffect(() => {
    activeDisconnect = disconnect
    return () => { if (activeDisconnect === disconnect) activeDisconnect = null }
  }, [disconnect])

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
    // XR-018: this socket's own identity for the generation check below —
    // the caller (connect()/reconnect()) allocates it right after
    // supersedeExistingSocket() and before opening `ws`, and reuses the same
    // value to guard its own onopen handler, so a stale in-flight onopen
    // from a socket superseded in the meantime is guarded exactly like
    // onmessage/onerror/onclose below.
    myGeneration: number,
    onFirstMessage: () => void,
  ) {
    wsRef.current      = ws
    lastSeqRef.current = initialSeq
    let firstMessageFired = false
    let inFlightRpc = 0
    let inFlightBytes = 0
    // XR-021 review follow-up: MAX_IN_FLIGHT_RPC lets several messages
    // decrypt concurrently, so the sequence check-then-durable-write-then-
    // advance below is chained through this promise — each message's commit
    // only runs once the previous one has fully resolved (write landed, ref
    // advanced), and re-checks the watermark at that point. Without this,
    // two concurrent messages can both pass the check against the same stale
    // watermark and have their durable writes resolve out of order,
    // regressing the watermark and letting an already-executed higher-
    // sequence ciphertext be replayed immediately (no crash needed).
    let seqCommitChain: Promise<boolean> = Promise.resolve(true)

    ws.onmessage = async event => {
      // XR-018: this socket may have already been superseded (a concurrent
      // disconnect()/connect()/reconnect() closed and detached it) between
      // the relay delivering this event and this handler running — closing
      // a socket cannot cancel an event already queued for it. Drop it
      // before touching any in-flight counters.
      if (connectionGenerationRef.current !== myGeneration) return
      if (inFlightRpc >= MAX_IN_FLIGHT_RPC) {
        console.warn('[WalletConnection] dropping message: too many requests in flight')
        return
      }
      inFlightRpc++
      let reservedBytes = 0
      try {
        const envelope = parseBoundedWireEnvelope(event.data, meta.topic)

        // XR-026: gate on the AGGREGATE estimated plaintext size of every
        // message currently decrypting/dispatching, not just the count.
        // MAX_IN_FLIGHT_RPC alone lets up to 4 near-ceiling messages decrypt
        // at once; base64-decoded length is a tight estimate of the eventual
        // plaintext (authenticated encryption only adds a small fixed
        // overhead), and this must be checked BEFORE decryptPayload is even
        // attempted — decoding the ciphertext into a number[] alone already
        // allocates memory proportional to its size, before the wallet can
        // authenticate it.
        const estimatedBytes = Math.floor(envelope.ciphertext.length * 3 / 4)
        if (inFlightBytes + estimatedBytes > MAX_IN_FLIGHT_RPC_BYTES) {
          console.warn('[WalletConnection] dropping message: too many in-flight bytes')
          return
        }
        reservedBytes = estimatedBytes
        inFlightBytes += reservedBytes

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
        // XR-021: commit the accepted sequence durably BEFORE dispatching the
        // wallet's side-effecting call below (createAction, signAction, ...),
        // and before advancing the in-memory watermark. Previously the
        // watermark only advanced in memory, and the only durable write was
        // fire-and-forget in disconnect()/onclose — a crash/kill between the
        // wallet call completing and that write landing left SecureStore
        // behind what actually ran, so a captured ciphertext replayed after
        // reconnect re-executed the identical mutating call. Fail closed: if
        // the durable write itself fails, drop the message rather than
        // dispatching with no durable record of having accepted it.
        //
        // Chained through seqCommitChain (review follow-up): re-checks the
        // watermark once it's this message's turn, so a concurrent message
        // that already committed a higher sequence in the meantime causes
        // this one to be dropped instead of regressing the watermark.
        const accepted = await (seqCommitChain = seqCommitChain.then(async () => {
          if (sequence <= lastSeqRef.current) return false
          try {
            await SecureStore.setItemAsync(lastSeqKey(meta.topic), String(sequence))
          } catch (err) {
            console.warn('[WalletConnection] dropping message: failed to persist sequence', err)
            return false
          }
          lastSeqRef.current = sequence
          return true
        }))
        if (!accepted) {
          console.warn('[WalletConnection] dropping message: seq', sequence, 'superseded before durable commit')
          return
        }

        // XR-018: re-check immediately before any dispatch/side-effect runs.
        // The decrypt + durable sequence commit above can take long enough
        // that a concurrent disconnect()/connect()/reconnect() supersedes
        // this socket while this invocation was still awaiting them —
        // detaching handlers at that point cannot cancel this already-
        // running invocation, so the dispatch itself must also check.
        if (connectionGenerationRef.current !== myGeneration) {
          console.warn('[WalletConnection] dropping message: connection superseded before dispatch')
          return
        }

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
        inFlightBytes -= reservedBytes
      }
    }

    ws.onerror = () => {
      if (connectionGenerationRef.current !== myGeneration) return
      setErrorMsg('WebSocket connection failed')
      setStatus('error')
    }

    ws.onclose = () => {
      // XR-018: a superseded socket's close event must never touch state for
      // whatever session/socket has replaced it (or the idle state left by
      // disconnect()) — closeAndDetachSocket already nulls this handler
      // before calling close() for every controlled teardown path, so this
      // is defense in depth for anything that still holds a reference to
      // this closure directly.
      if (connectionGenerationRef.current !== myGeneration) return
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

    // XR-018: tear down any live socket for a DIFFERENT prior session before
    // wiring this one — see supersedeExistingSocket for why. myGeneration is
    // allocated right after, so this connection's onopen AND wireSocket's
    // handlers all guard against the same supersede event.
    supersedeExistingSocket()
    const myGeneration = ++connectionGenerationRef.current

    const meta: SessionMeta = {
      topic: validated.params.topic, origin: validated.external.origin, relay,
      backendIdentityKey: validated.params.backendIdentityKey, mobileIdentityKey,
      protocolID,
    }
    setSessionMeta(meta)

    const ws = new WebSocket(buildRelayWebSocketUrl(relay, validated.params.topic))

    ws.onopen = async () => {
      // XR-018: this connection attempt may already have been superseded by
      // a later connect()/reconnect()/disconnect() while relay/verify above
      // were in flight — a stale send here must not touch the new session's
      // state, and must not fire on an already-detached socket.
      if (connectionGenerationRef.current !== myGeneration) return
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
        if (connectionGenerationRef.current !== myGeneration) return
        ws.send(JSON.stringify({ topic: validated.params.topic, mobileIdentityKey, ciphertext } satisfies WireEnvelope))
      } catch {
        if (connectionGenerationRef.current !== myGeneration) return
        setErrorMsg('Failed to send pairing message')
        setStatus('error')
      }
    }

    wireSocket(ws, wallet, meta, 0, myGeneration, () => {
      connectionStore.add({
        sessionId: validated.params.topic, origin: validated.external.origin, relay,
        backendIdentityKey: validated.params.backendIdentityKey, mobileIdentityKey,
        protocolID: validated.params.protocolID,
        connectedAt: Date.now(), status: 'active',
      })
      setStatus('connected')
    })
  }, [walletName, supersedeExistingSocket]) // eslint-disable-line react-hooks/exhaustive-deps

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

    // XR-018: tear down any live socket for a DIFFERENT prior session before
    // wiring this one — see supersedeExistingSocket for why. myGeneration is
    // allocated right after, so this connection's onopen AND wireSocket's
    // handlers all guard against the same supersede event.
    supersedeExistingSocket()
    const myGeneration = ++connectionGenerationRef.current

    const meta: SessionMeta = {
      topic: validated.topic, origin: validated.external.origin, relay,
      backendIdentityKey: validated.backendIdentityKey,
      mobileIdentityKey:  validated.mobileIdentityKey,
      protocolID,
    }
    setSessionMeta(meta)

    const ws = new WebSocket(buildRelayWebSocketUrl(relay, validated.topic))

    ws.onopen = async () => {
      // XR-018: see the identical guard in connect()'s onopen.
      if (connectionGenerationRef.current !== myGeneration) return
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
        if (connectionGenerationRef.current !== myGeneration) return
        ws.send(JSON.stringify({
          topic: validated.topic,
          mobileIdentityKey: validated.mobileIdentityKey,
          ciphertext,
        } satisfies WireEnvelope))
      } catch {
        if (connectionGenerationRef.current !== myGeneration) return
        setErrorMsg('Failed to send reconnect message')
        setStatus('error')
      }
    }

    wireSocket(ws, wallet, meta, initialSeq, myGeneration, () => {
      connectionStore.setStatus(validated.topic, 'active')
      setStatus('connected')
    })
  }, [walletName, supersedeExistingSocket]) // eslint-disable-line react-hooks/exhaustive-deps

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
