/**
 * Recipient state for the universal send form.
 *
 * Typed text goes through classifyRecipientInput; a scanned code goes through
 * classifyScan. Both are pure and live in core/pay/rails. This hook only holds
 * the resulting state and the identity search that free text turns into.
 *
 * Unrecognised junk in front of the camera is ignored and the scanner keeps
 * looking; a malformed `peerpay:` code is different — it closes the scanner and
 * reports the validator's message in the banner, as pasting the same string does.
 *
 * Grew out of useIdentitySearch (handle-only). The search machinery is the
 * same; what is new is that an address is a first-class outcome and a nearby
 * session is handed up to whoever mounted the form.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Keyboard } from 'react-native'
import { IdentityClient } from '@bsv/sdk'
import type { DisplayableIdentity } from '@bsv/sdk'
import { searchIdentities } from '../../resolveIdentity'
import {
  classifyRecipientInput,
  classifyScan,
  peerPayValidationMessage,
  validatePeerPayURI,
  type PayTarget,
  type Session
} from '@bsv/expo-wallet-toolbox'

export { peerPayValidationMessage }

/** Any throw from the overlay lookup is an outage, not “no such person”. */
export function classifyIdentitySearchError(_e: unknown): boolean {
  return true
}

export type RecipientTarget = Extract<PayTarget, { kind: 'handle' | 'address' }>
export type RecipientInlineError = 'invalid_bsv_address'

export interface UseRecipientInputOptions {
  wallet: unknown
  adminOriginator: string | undefined
  /**
   * A recipient known before the form opened (deep link, scan on the way in).
   * Compared by content; a new object with the same fields does not re-adopt.
   */
  initialTarget?: RecipientTarget
  /** A link or code named an amount too. */
  onPeerPayAmount?: (sats: number) => void
  /** A peerpay link that did not validate; the message is the validator's. */
  onPeerPayError?: (message: string) => void
  /** A nearby-session code was scanned: this form is the wrong surface for it. */
  onNearbySession?: (session: Session) => void
}

const SEARCH_DEBOUNCE_MS = 400

function textFor(target: RecipientTarget): string {
  return target.kind === 'handle' ? target.identityKey : target.address
}

export function useRecipientInput({
  wallet,
  adminOriginator,
  initialTarget,
  onPeerPayAmount,
  onPeerPayError,
  onNearbySession
}: UseRecipientInputOptions) {
  const identityClientRef = useRef<IdentityClient | null>(null)
  useEffect(() => {
    if (!wallet) return
    try {
      identityClientRef.current = new IdentityClient(wallet as never, undefined, adminOriginator)
    } catch {
      // Identity search is decorative; a client that will not build leaves the form usable.
    }
  }, [wallet, adminOriginator])

  const [inputText, setInputText] = useState(initialTarget ? textFor(initialTarget) : '')
  const [target, setTarget] = useState<RecipientTarget | null>(initialTarget ?? null)
  const [inlineError, setInlineError] = useState<RecipientInlineError | null>(null)
  const [selectedIdentity, setSelectedIdentity] = useState<DisplayableIdentity | null>(null)
  const [searchResults, setSearchResults] = useState<DisplayableIdentity[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [scannerVisible, setScannerVisible] = useState(false)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stopSearch = useCallback(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = null
    setSearchResults([])
    setIsSearching(false)
  }, [])

  const setDirectTarget = useCallback(
    (next: RecipientTarget) => {
      stopSearch()
      setInputText(textFor(next))
      setTarget(next)
      setSelectedIdentity(null)
      setSearchError(false)
      setInlineError(null)
    },
    [stopSearch]
  )

  // Compared by content, not reference: a caller may rebuild this object every
  // render, and a re-render must never clobber what the user has typed. The ref
  // carries the latest object so the effect can adopt it without depending on it.
  const initialTargetKey = initialTarget
    ? `${initialTarget.kind}:${textFor(initialTarget)}:${initialTarget.kind === 'handle' ? (initialTarget.messageBoxUrl ?? '') : ''}`
    : ''
  const initialTargetRef = useRef(initialTarget)
  initialTargetRef.current = initialTarget
  useEffect(() => {
    const next = initialTargetRef.current
    if (next) setDirectTarget(next)
  }, [initialTargetKey, setDirectTarget])

  const onChangeText = useCallback(
    (text: string) => {
      setInputText(text)
      setSelectedIdentity(null)
      setTarget(null)
      setInlineError(null)
      setSearchError(false)
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)

      const input = classifyRecipientInput(text)
      switch (input.kind) {
        case 'empty':
          stopSearch()
          return
        case 'address':
          stopSearch()
          setTarget({ kind: 'address', address: input.address })
          return
        case 'invalid_address':
          stopSearch()
          setInlineError('invalid_bsv_address')
          return
        case 'handle':
          stopSearch()
          setTarget({
            kind: 'handle',
            identityKey: input.identityKey,
            ...(input.messageBoxUrl ? { messageBoxUrl: input.messageBoxUrl } : {})
          })
          if (input.sats !== undefined) onPeerPayAmount?.(input.sats)
          return
        case 'invalid_link':
          stopSearch()
          onPeerPayError?.(input.message)
          return
        case 'search':
          setSearchResults([])
          setIsSearching(true)
          searchTimerRef.current = setTimeout(async () => {
            const client = identityClientRef.current
            if (!client) {
              setIsSearching(false)
              return
            }
            try {
              setSearchResults(await searchIdentities(client, input.query))
              setSearchError(false)
            } catch (error) {
              console.error('Identity search error:', error)
              if (classifyIdentitySearchError(error)) setSearchError(true)
              setSearchResults([])
            } finally {
              setIsSearching(false)
            }
          }, SEARCH_DEBOUNCE_MS)
          return
      }
    },
    [onPeerPayAmount, onPeerPayError, stopSearch]
  )

  const selectIdentity = useCallback(
    (identity: DisplayableIdentity) => {
      stopSearch()
      setSelectedIdentity(identity)
      setTarget({ kind: 'handle', identityKey: identity.identityKey })
      setInputText(identity.name || identity.abbreviatedKey)
      setSearchError(false)
      setInlineError(null)
      Keyboard.dismiss()
    },
    [stopSearch]
  )

  const clearRecipient = useCallback(() => {
    stopSearch()
    setSelectedIdentity(null)
    setTarget(null)
    setInputText('')
    setSearchError(false)
    setInlineError(null)
  }, [stopSearch])

  const clearSearchError = useCallback(() => setSearchError(false), [])
  const openScanner = useCallback(() => setScannerVisible(true), [])

  const onScan = useCallback(
    (data: string) => {
      const scanned = classifyScan(data)
      if (!scanned) {
        // A code that names the peerpay scheme was recognised and rejected: silence in front of
        // a live camera is a dead end, so say why and get out of the way. Anything else is
        // unclassifiable junk — QRScanner is in multiScan mode and keeps looking.
        const text = data.trim()
        if (text.toLowerCase().startsWith('peerpay:')) {
          const message = peerPayValidationMessage(validatePeerPayURI(text))
          if (message) {
            setScannerVisible(false)
            onPeerPayError?.(message)
          }
        }
        return
      }
      setScannerVisible(false)
      if (scanned.kind === 'nearby') {
        onNearbySession?.(scanned.session)
        return
      }
      if (scanned.kind === 'handle') {
        setDirectTarget({
          kind: 'handle',
          identityKey: scanned.identityKey,
          ...(scanned.messageBoxUrl ? { messageBoxUrl: scanned.messageBoxUrl } : {})
        })
        if (scanned.sats !== undefined) onPeerPayAmount?.(scanned.sats)
        return
      }
      setDirectTarget({ kind: 'address', address: scanned.address })
    },
    [onNearbySession, onPeerPayAmount, onPeerPayError, setDirectTarget]
  )

  return {
    inputText,
    target,
    inlineError,
    selectedIdentity,
    searchResults,
    isSearching,
    searchError,
    clearSearchError,
    onChangeText,
    selectIdentity,
    clearRecipient,
    scannerVisible,
    setScannerVisible,
    openScanner,
    onScan
  }
}
