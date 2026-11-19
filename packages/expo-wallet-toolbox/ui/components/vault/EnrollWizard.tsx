/**
 * Vault enrollment wizard — spec §3.3.
 *
 *   enroll mode:  intro → key (× k; sub-states pin · confirm · puk · tap · save · error) → more → done
 *   add-key mode: key → done
 *
 * Public, non-authoritative recovery handles are persisted in wallet-scoped
 * SecureStore as soon as a slot key exists. Ready handles are restored into
 * this wizard after a crash; protected handles repeat only a live possession
 * challenge. PINs and PUKs are never stored. Every credential prompt is
 * gathered BEFORE the tap, because
 * the iOS NFC sheet covers the app for the whole card session. The PIN lives
 * in input state only while its key step is open: it is kept across an
 * error → Try again (a re-tap needs it) and cleared the moment the step is
 * left, the card is swapped, or the PIN turns out to be wrong.
 *
 * A key is named on the user's behalf — Key 1, Key 2, … — and never asked
 * about here: the name is cosmetic, it is renamed from the vault screen at any
 * time, and a text field between a finished card and a saved key is one more
 * thing to get wrong mid-ceremony.
 *
 * The host screen points its own back chevron at `onBackChange` while this is
 * mounted (there is no Back button on the pages, which the keyboard would
 * cover). Back is one page inside a key where there is one, and otherwise
 * `leave()` — the leave-confirm alert when at least one key is unsaved — which
 * Android's hardware back button gets too. On the `done` step back completes
 * the wizard (`onDone`) instead, and while a card session is open it is
 * swallowed: the tap's outcome must land somewhere.
 *
 * Whatever meta is stored is loaded in BOTH modes and its serials are always
 * passed to `enrollKey` as `pendingSerials` (spec §3.3 step 2). The service
 * probes the slot and refuses any occupied token; enrollment never overwrites
 * an existing PIV key. In enroll mode a stored meta is a host-state anomaly — its keys are
 * refused (loud, safe) but never counted toward the ordinal or the cap, since
 * Finish replaces whatever is stored.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  ActivityIndicator,
  BackHandler,
  Platform
} from 'react-native'
import {
  CircleAlert,
  CircleCheck,
  CloudUpload,
  KeyRound,
  MapPin,
  Square,
  SquareCheckBig,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react-native'
import PressableScale from '../ui/PressableScale'
import { showAlert } from '../ui/AlertCard'
import { showToast } from '../ui/Toast'
import { vaultErrorCopy } from './vaultErrorCopy'
import { vaultKeyLabel } from './KeyChooser'
import {
  useTheme,
  useWallet,
  spacing,
  radii,
  typography,
  enrollKey,
  resumeEnrollmentDraft,
  finalizeEnrollment,
  addVaultKey,
  resetPivApplication,
  vaultStore,
  VAULT_MIN_KEYS,
  VAULT_MAX_KEYS,
  VaultError,
  VaultEnrollmentPartialError,
  haptics,
  randomBytes,
  i18n,
  type VaultKeyRecord,
  type VaultEnrollmentDraftEntry,
  type VaultEnrollmentQuarantine,
  type VaultScopeToken,
  type VaultErrorCode,
  type EnrollPhase,
  type VaultCardFunds,
  type VaultResetClearance,
  type VaultWalletAuthority,
  VAULT_RESET_CLEARANCE_MS
} from '@bsv/expo-wallet-toolbox'
import { BalancedText } from '../ui/BalancedText'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string

/**
 * lucide, the family this app draws every other glyph from (its settings rows,
 * its headers, its sheets). Imported at module scope, unlike
 * @expo/vector-icons: lucide-react-native ships a CJS entry for `require`, so
 * it needs no transform and reaches no native module at import time, which is
 * what this package's lazy icon loads exist to avoid.
 */

type Step = 'intro' | 'key' | 'more' | 'done'
type KeySub = 'pin' | 'confirm' | 'puk' | 'tap' | 'save' | 'reset' | 'error'

/** Pages a single key's setup walks through, for the progress indicator. The
 * count is per key, not per wizard: the number of keys is chosen during the
 * run (2 to 5), so a whole-wizard bar would move at a rate nobody can predict.
 * `save` is not one of them: it is a write, not a page the user works through.
 * The PIN is chosen and confirmed on two of them: one field per page is what
 * keeps Continue clear of the number pad (see KeyboardPage). */
const KEY_STEPS: readonly KeySub[] = ['pin', 'confirm', 'puk', 'tap']

/** The PIV factory codes. The intro's whole-PIV acknowledgement asserts a
 * factory-reset (or Vault-dedicated) PIV application, so these are supplied to
 * the service below the UI rather than typed. */
const DEFAULT_PIV_PIN = '123456'
const DEFAULT_PIV_PUK = '12345678'
const PIN_MAX = 8
const pivCodeOk = (p: string) => /^[0-9]{6,8}$/.test(p)

const PUK_LENGTH = 8

/**
 * A fresh recovery code (PIV PUK) for one key.
 *
 * Rejection sampling, not `byte % 10`: a modulo over 256 would make the digits
 * 0-5 measurably likelier than 6-9. Bytes of 250 or more are discarded.
 *
 * The service refuses a PUK equal to the PIN (validatePukChange), so a
 * collision is redrawn rather than surfaced as a validation error.
 */
function generateRecoveryCode(pin: string): string {
  for (;;) {
    let code = ''
    while (code.length < PUK_LENGTH) {
      for (const byte of randomBytes(PUK_LENGTH)) {
        if (byte >= 250) continue
        code += String(byte % 10)
        if (code.length === PUK_LENGTH) break
      }
    }
    if (code !== DEFAULT_PIV_PUK && code !== pin) return code
  }
}

interface KeyStepError {
  code: VaultErrorCode | undefined
  copy: string
  /** Generation may have completed, so retrying on this token must not reach
   * another enrollment attempt. The service will also refuse its occupied
   * slot; the UI sends the user straight to a fresh token. */
  mustUseDifferent?: boolean
  /**
   * The card THIS failure may offer to erase, or absent for no offer.
   *
   * Deliberately a field of the error and not separate state. A reset offer
   * bound to the wrong card is the worst outcome in this feature, and separate
   * state survives whatever the code forgets to clear: every exit from the
   * error page would have to remember, and nothing enforces that. Living here,
   * the binding is replaced wholesale every time a failure is recorded and
   * disappears with `setKeyError(null)` — a stale serial cannot outlive the
   * failure that produced it.
   */
  resetSerial?: string
}

/**
 * The duplicate's serial from a key-already-enrolled rejection. The services
 * attach it as `details.serial` (VaultKeyService.enrollKey, vaultStore.addKey);
 * the message is never parsed for it.
 */
function duplicateSerial(err: VaultError | undefined): string | undefined {
  const s = err?.details?.serial
  return typeof s === 'string' ? s : undefined
}

/**
 * Codes a PIV reset can actually fix — a card that has been used before and
 * whose PIV application is therefore not the factory one enrollment needs.
 */
const RESETTABLE: ReadonlySet<VaultErrorCode> = new Set<VaultErrorCode>([
  'mgmt-key-custom',
  'slot-occupied',
  'pin-invalid',
  'puk-invalid',
  'pin-locked',
  'puk-locked',
  'enrollment-partial'
])

/**
 * Never offered a reset, whatever RESETTABLE comes to say.
 *
 * `key-already-enrolled` is a LIVE vault signer: erasing it removes one of the
 * k-of-n keys and can make vault funds permanently unspendable. pivReset
 * refuses it below the UI too, and that refusal is not overridable — but the
 * UI must never invite the attempt in the first place.
 *
 * `attestation-invalid` means the factory F9 chain did not verify, i.e. the
 * token is counterfeit or tampered with. A reset changes nothing about that,
 * so offering one would tell the user a lie about what would fix their key.
 */
const NEVER_RESETTABLE: ReadonlySet<VaultErrorCode> = new Set<VaultErrorCode>([
  'key-already-enrolled',
  'attestation-invalid'
])

/**
 * Codes whose retry can never succeed, so the error page must send the token
 * away instead of offering a Try again that is a dead button.
 *
 * `pin-invalid` (Task 8): the app supplies the factory PIN, so this means the
 * PIV application is not the factory one — presenting 123456 again can only
 * fail, three times over into `pin-locked`.
 *
 * `mgmt-key-custom`: the management key is not the factory one either, and
 * nothing about a re-tap changes that.
 *
 * `attestation-invalid`: the factory F9 chain did not verify. The token is
 * counterfeit or tampered with, and `vault_err_attestation_invalid` already
 * tells the user to fetch a genuine key — a Retry button underneath it
 * contradicts the very copy above it.
 *
 * `pin-locked`: raised from `info.pinRetries === 0`, read off the card before
 * anything is presented to it. A re-tap re-reads the same zero — only the PUK
 * or a factory reset moves that counter — so a Retry here is the same dead
 * button as the three above, and a worse one, because [Reset this key] renders
 * directly over it.
 *
 * A reset offer, where one is allowed at all, renders ABOVE this branch: a
 * card with a known serial gets [Reset this key] + [Use a different YubiKey],
 * which is the right pair. A counterfeit gets only the latter, because
 * `attestation-invalid` is in NEVER_RESETTABLE.
 */
const MUST_USE_DIFFERENT: ReadonlySet<VaultErrorCode> = new Set<VaultErrorCode>([
  'pin-invalid',
  'mgmt-key-custom',
  'attestation-invalid',
  'pin-locked'
])

/**
 * Rejections from `resetPivApplication` that are provably raised BEFORE the
 * RESET APDU, so their own copy is truthful about the card being untouched.
 *
 * Everything else has to warn instead of reassure: a scope change or an NFC
 * lift after the erase rejects on a card that is already at factory state
 * (`scope-changed`, `key-removed-mid-op`, `nfc-lost`, and `template-invalid`
 * from the post-reset draft/quarantine cleanup), and no code distinguishes
 * that from a refusal before contact.
 *
 * `driver-unavailable` is deliberately NOT a member, even though pivReset does
 * raise it before contact when no driver is installed. It is also
 * `vaultErrorFromNative`'s fallback for ANY native rejection that is not a
 * `VAULT_ERR:` string (types.ts), so a bridge or serialization failure AFTER
 * the RESET APDU landed arrives under this same code. It is the one candidate
 * that can hedge in the unsafe direction — telling the user nothing was erased
 * when the key is already blank — so it takes the warning copy instead.
 */
const RESET_BEFORE_ERASE: ReadonlySet<VaultErrorCode> = new Set<VaultErrorCode>([
  'key-already-enrolled',
  'slot-occupied',
  'serial-mismatch',
  'user-cancelled',
  // the chain-check clearance ran out (it lasts ten minutes) before the reset: nothing was erased
  'chain-check-required'
])

/**
 * A hardware-key illustration supplied by the host app, drawn at the moments
 * this flow asks the user to touch their key. The package has no artwork of
 * its own, and the host's is the one the rest of its vault pages already show,
 * so it is taken as a prop rather than duplicated here. Given none, these
 * screens fall back to what they drew before: a spinner, or the phase glyph.
 *
 * `waiting` is the blink: the drawing is expected to draw attention to the
 * key's touch contact while it is true.
 */
export type HardwareKeyArtComponent = React.ComponentType<{ waiting?: boolean; size?: number }>

export interface EnrollWizardProps {
  mode: 'enroll' | 'add-key'
  onDone: () => void
  onCancel: () => void
  keyArt?: HardwareKeyArtComponent
  /**
   * Drops the intro step's own title. The wizard names itself because the
   * package's Vault screen opens it under a header that only says "Vault";
   * a host that mounts it under a header already reading "Set up your vault"
   * would otherwise print that line twice, one above the other. Only the
   * intro is affected -- the later steps' titles say which key and which
   * step, which no page header can.
   */
  hideIntroTitle?: boolean
  /**
   * The host's own back control, told what back means on the page showing now.
   *
   * Called with a new function whenever that changes. A host that wires its
   * header chevron to it gets the step-back inside a key and the leave-confirm
   * everywhere else, which is the point: a chevron of the host's own is a
   * second, quieter way out of a wizard holding unsaved keys, and the one that
   * skips the question about them.
   */
  onBackChange?: (back: () => void) => void
  /**
   * The chain check that runs before a card is reset or its Vault slot replaced (audit: reset-new-phone).
   * `check` is checkVaultCardFunds for this card; `args` turns its answer (and the person's affirmation) into the
   * arguments resetPivApplication takes, or null while the reset must not go ahead. Without it the wizard cannot
   * tell whether the card opens a vault: it treats that as "unknown" and a reset needs the affirmation.
   */
  cardGate?: {
    check: (serial: string) => Promise<VaultCardFunds>
    args: (
      result: VaultCardFunds | null,
      affirmed: boolean
    ) => { fundsClearance: VaultResetClearance } | { acknowledgeFundsLoss: true } | null
  }
  /** The key on the card opens a vault: leave the wizard and restore it (adopt the key on the card). */
  onRestoreVault?: (serial: string) => void
}

export const EnrollWizard: React.FC<EnrollWizardProps> = ({
  mode,
  onDone,
  onCancel,
  keyArt: KeyArt,
  hideIntroTitle = false,
  onBackChange,
  cardGate,
  onRestoreVault
}) => {
  const { colors } = useTheme()
  // Every public record collected in this wizard belongs to the wallet/chain
  // scope that opened it. Holding one token for the whole lifetime prevents a
  // late enrollment result from being persisted after logout or a network
  // switch has mounted a different vault.
  const scopeTokenRef = useRef<VaultScopeToken | null>(null)
  if (!scopeTokenRef.current) scopeTokenRef.current = vaultStore.captureScopeToken()
  const scopeToken = scopeTokenRef.current

  // XR-001: the admin-scoped wallet capability every draft/meta authority tag
  // in this wizard is computed and verified with (metaAuthority.ts). The
  // wizard is only ever reached once a wallet is built (VaultScreen gates
  // every door into it), so a missing permissions manager here is treated as
  // the same programmer error `pm as unknown as VaultWallet` casts elsewhere
  // in the vault UI already assume, not a recoverable runtime state.
  const { managers, adminOriginator } = useWallet()
  const authority: VaultWalletAuthority | null = managers?.permissionsManager
    ? { wallet: managers.permissionsManager as unknown as VaultWalletAuthority['wallet'], adminOriginator }
    : null
  const requireAuthority = useCallback((): VaultWalletAuthority => {
    if (!authority) {
      throw new VaultError('driver-unavailable', 'Wallet is not ready for a vault enrollment operation')
    }
    return authority
  }, [authority])

  const [step, setStep] = useState<Step>(mode === 'enroll' ? 'intro' : 'key')
  const [sub, setSub] = useState<KeySub>('pin')
  const [ack, setAck] = useState(false)
  /** Whole-PIV acknowledgement. Enrollment rotates global PIV credentials,
   * so this starts false even when the recovery-risk acknowledgement is set. */
  const [pivAck, setPivAck] = useState(false)
  /** Keys already in the stored meta, loaded in both modes. Their serials are
   * always refused; they count toward the ordinal and the cap in add-key mode
   * only (see the file comment). */
  const [metaKeys, setMetaKeys] = useState<VaultKeyRecord[]>([])
  /** Keys set up in this run and not yet persisted. Public data only. */
  const [pending, setPending] = useState<VaultKeyRecord[]>([])
  const [recoverableDrafts, setRecoverableDrafts] = useState<VaultEnrollmentDraftEntry[]>([])
  const [blockedDrafts, setBlockedDrafts] = useState<(VaultEnrollmentDraftEntry | VaultEnrollmentQuarantine)[]>([])
  /** The PIN the user chose for this key. The factory PIN is supplied to the
   * service below the UI, never typed. */
  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  /** The generated recovery code for this key. Created when the PUK page is
   * first shown and cleared with the rest of the key's inputs. */
  const [newPuk, setNewPuk] = useState('')
  const [pukAck, setPukAck] = useState(false)
  const [pinError, setPinError] = useState<string | null>(null)
  const [phase, setPhase] = useState<EnrollPhase | null>(null)
  /** The record the card produced, while its write to the vault is in flight
   * or has failed and can be retried. */
  const [fresh, setFresh] = useState<VaultKeyRecord | null>(null)
  const [keyError, setKeyError] = useState<KeyStepError | null>(null)
  /** "This erases everything on this key" — the whole-token consequence. */
  const [resetAck, setResetAck] = useState(false)
  /** The card answered that its Vault slot holds a key no vault on this device
   * claims. Set only by pivReset's own refusal, never guessed from the
   * enrollment error: it is the card, not the app, that knows. */
  const [resetUnknownSlot, setResetUnknownSlot] = useState(false)
  /** The separate consent that unknown key may be destroyed. */
  const [resetUnknownAck, setResetUnknownAck] = useState(false)
  const [resetting, setResetting] = useState(false)
  /** The chain check for the card on the reset page or the slot-occupied page. null while it runs. */
  const [cardCheck, setCardCheck] = useState<VaultCardFunds | null>(null)
  const [checkRound, setCheckRound] = useState(0)
  /** "Any funds in a vault that uses this key are lost for good if you reset it." */
  const [lossAck, setLossAck] = useState(false)
  /** A write (finalizeEnrollment / addVaultKey) is in flight. */
  const [busy, setBusy] = useState(false)
  const [stepError, setStepError] = useState<string | null>(null)
  const [addedNickname, setAddedNickname] = useState('')
  /** One card session at a time: a double-tapped Continue must not open two. */
  const tapInFlight = useRef(false)
  /** One leave-confirm at a time. */
  const leaving = useRef(false)
  /** The PIN fields, each focused on a delay below instead of via `autoFocus`. */
  const pinInputRef = useRef<TextInput>(null)
  const confirmInputRef = useRef<TextInput>(null)

  /** Stored keys that count toward the ordinal and the 5-key cap: all of them
   * when adding to a vault, none while enrolling one (Finish overwrites). */
  const enrolledCount = mode === 'add-key' ? metaKeys.length : 0
  const total = enrolledCount + pending.length
  /** Ordinal of the next key on screen. Existing/occupied tokens are never overwritten. */
  const k = total + 1
  const pinChosen = pivCodeOk(newPin) && newPin !== DEFAULT_PIV_PIN
  const pinOk = pinChosen && confirmPin === newPin
  /** Keys that would be lost by leaving: pending ones plus a just-generated, not-yet-named one. */
  const unsaved = pending.length + (fresh ? 1 : 0)

  /**
   * The ticks the reset page gathered. Consent is destructive and specific: it
   * is never carried from one card to the next, nor from one attempt to the
   * next. (The card it is consent ABOUT lives on `keyError.resetSerial`, which
   * cannot go stale — see KeyStepError.)
   */
  const clearResetConsent = () => {
    setLossAck(false)
    setResetAck(false)
    setResetUnknownSlot(false)
    setResetUnknownAck(false)
  }

  /** Everything the key step gathered: the chosen PIN, its confirmation, the
   * generated recovery code and its acknowledgement, and the fresh record. */
  const clearKeyInputs = () => {
    setNewPin('')
    setConfirmPin('')
    setNewPuk('')
    setPukAck(false)
    setPinError(null)
    setFresh(null)
    clearResetConsent()
  }

  // ── the chain check before a reset or a replace (audit: reset-new-phone) ─────────────────────────────────
  // A card that already opens a vault must not be wiped on this phone's say-so: this phone may know nothing
  // of it. The check runs when the reset page or the slot-occupied page shows. Plain path: a complete scan
  // found nothing. Otherwise the person restores the vault, or affirms that earlier funds are lost for good.
  const gateSerial =
    sub === 'reset' || (sub === 'error' && keyError?.code === 'slot-occupied') ? keyError?.resetSerial : undefined
  useEffect(() => {
    setCardCheck(null)
    // a new check starts: the sentence ticked for an earlier result is not carried over to this one
    setLossAck(false)
    if (!gateSerial) return
    let live = true
    const unknown = (reason: string): VaultCardFunds => ({ kind: 'unknown', serial: gateSerial, reason, problems: 0 })
    if (!cardGate) {
      setCardCheck(unknown('no-check'))
      return
    }
    cardGate.check(gateSerial).then(
      result => live && setCardCheck(result),
      () => live && setCardCheck(unknown('check-failed'))
    )
    return () => {
      live = false
    }
  }, [gateSerial, cardGate, checkRound])
  /** What resetPivApplication takes, or null while the card may not be reset or replaced. */
  const gateArgs: { fundsClearance: VaultResetClearance } | { acknowledgeFundsLoss: true } | null = cardGate
    ? cardGate.args(cardCheck, lossAck)
    : cardCheck && lossAck
      ? { acknowledgeFundsLoss: true }
      : null
  const bsvAmount = (sats: number) => `${Number((sats / 100_000_000).toFixed(8))} BSV`

  // ── saving a finished key ───────────────────────────────────────────
  /**
   * Persist the key a card just produced, under the default name for its
   * ordinal when the record carries none.
   *
   * The user is never asked for a name: a key is Key 1, Key 2, … and is
   * renamed from the vault screen whenever they care to. In enroll mode this
   * is a push into `pending` (nothing is written until Finish); in add-key
   * mode it is the vault write, which can fail — hence the `save` page, whose
   * only job is that failure and its retry.
   */
  const saveKey = useCallback(
    async (produced: VaultKeyRecord) => {
      const record: VaultKeyRecord = {
        ...produced,
        nickname: produced.nickname.trim() || t('vault_name_default', { k })
      }
      if (mode !== 'add-key') {
        setPending(prev => [...prev, record])
        clearKeyInputs()
        setStep('more')
        return
      }
      setFresh(record)
      setSub('save')
      setBusy(true)
      setStepError(null)
      try {
        await addVaultKey(record, scopeToken, requireAuthority())
        clearKeyInputs()
        haptics.success()
        showToast(t('vault_key_added_toast'), { type: 'success' })
        setAddedNickname(record.nickname)
        setStep('done')
      } catch (e) {
        haptics.error()
        const err = e instanceof VaultError ? e : undefined
        if (err?.code === 'scope-changed') {
          clearKeyInputs()
          showToast(vaultErrorCopy('scope-changed'), { type: 'error' })
          onCancel()
          return
        }
        // `fresh` is also a scoped ready draft. Keep it and stay on the save
        // page so a transient SecureStore write failure can be retried without
        // touching or regenerating the now-occupied token.
        setStepError(vaultErrorCopy(err?.code))
      } finally {
        setBusy(false)
      }
    },
    [k, mode, onCancel, scopeToken, requireAuthority]
  )

  /**
   * Always the current `saveKey`, for the restore below to call.
   *
   * Depending on `saveKey` directly would re-run that effect whenever the
   * ordinal it names keys after moves — and that ordinal comes from the very
   * state the effect sets, so a restored draft could be written twice.
   */
  const saveKeyRef = useRef(saveKey)
  useEffect(() => {
    saveKeyRef.current = saveKey
  }, [saveKey])

  useEffect(() => {
    let alive = true
    Promise.all([
      vaultStore.getMeta(scopeToken),
      vaultStore.getEnrollmentDrafts(scopeToken),
      vaultStore.getEnrollmentQuarantines(scopeToken)
    ])
      .then(([m, drafts, quarantines]) => {
        if (!alive) return
        const enrolledSerials = new Set(m?.keys.map(key => key.serial) ?? [])
        const unused = drafts.filter(entry => !enrolledSerials.has(entry.record.serial))
        const ready = unused.filter(entry => entry.assurance === 'ready')
        const challenge = unused.filter(entry => entry.assurance === 'challenge-required')
        const blocked = unused.filter(entry => entry.assurance === 'management-uncertain')
        if (m) setMetaKeys(m.keys)
        setRecoverableDrafts(challenge)
        setBlockedDrafts([...blocked, ...quarantines])
        if (mode === 'enroll') {
          setPending(current => {
            const serials = new Set(current.map(key => key.serial))
            return [...current, ...ready.map(entry => entry.record).filter(record => !serials.has(record.serial))]
          })
        } else if (ready[0]) {
          // A ready draft is a persisted claim, not proof: nothing here
          // re-verifies it against the card, so a draft never tapped in this
          // run (crash-resumed, or — XR-001 — written straight to storage by
          // something other than a live enrollment challenge) must not gain
          // vault spend authority in an already-funded vault with zero user
          // action. Name it and require an explicit choice before writing it.
          const entry = ready[0]
          void showAlert({
            title: t('vault_resume_draft_confirm_title'),
            message: t('vault_resume_draft_confirm_body', {
              nickname: entry.record.nickname,
              tail: entry.record.serial.slice(-4)
            }),
            buttons: [
              { text: t('vault_resume_draft_confirm_use'), key: 'use' },
              { text: t('vault_resume_draft_confirm_discard'), key: 'discard', style: 'destructive' }
            ]
          }).then(choice => {
            if (!alive) return
            if (choice === 'use') {
              void saveKeyRef.current(entry.record)
            } else {
              void vaultStore.discardEnrollmentDraft(entry.record.serial, scopeToken).catch(() => {})
            }
          })
        }
      })
      .catch(e => {
        if (alive && e instanceof VaultError && e.code === 'scope-changed') onCancel()
      })
    return () => {
      alive = false
    }
  }, [mode, onCancel, scopeToken])

  // ── leaving ─────────────────────────────────────────────────────────
  const leave = useCallback(async () => {
    // Everything is saved on `done`: back means the same as the Done button —
    // hand off to the host (the re-lock prompt in add-key mode), never a
    // "won't be saved yet" alert over a persisted vault.
    if (step === 'done') {
      onDone()
      return
    }
    // A card session is open: its result must land in state, so back is
    // swallowed (the BackHandler handler still returns true) until it settles.
    if (tapInFlight.current) return
    if (busy || leaving.current) return
    leaving.current = true
    try {
      if (unsaved > 0) {
        const choice = await showAlert({
          title: t('vault_leave_title'),
          message: t('vault_leave_body', { count: unsaved }),
          buttons: [
            { text: t('vault_leave_confirm'), key: 'leave', style: 'destructive' },
            { text: t('vault_leave_stay'), key: 'stay', style: 'cancel' }
          ]
        })
        if (choice !== 'leave') return
      }
      onCancel()
    } finally {
      leaving.current = false
    }
  }, [step, busy, unsaved, onCancel, onDone])

  /**
   * Back, on the page showing now: one page back inside a key where there is
   * one, the leave-confirm everywhere else. The pages the keyboard covers have
   * no Back button of their own, so this is the only step-back there is —
   * which is also why it is the same function the hardware button gets.
   */
  const back = useCallback(() => {
    if (step === 'key' && sub === 'confirm') return setSub('pin')
    if (step === 'key' && sub === 'puk') return setSub('confirm')
    void leave()
  }, [step, sub, leave])

  /**
   * The host is handed one function, once, which asks for the current one when
   * it is pressed.
   *
   * A fresh closure on every page would re-render any host that keeps it in
   * state, and a host whose `onDone`/`onCancel` is an inline arrow — both of
   * ours — re-renders this, which rebuilds the closure, which hands over
   * again: a loop React only stops by throwing "Maximum update depth
   * exceeded". The indirection makes the handover happen once, at mount.
   */
  const backNow = useRef(back)
  useEffect(() => {
    backNow.current = back
  }, [back])
  const handOverBack = useCallback(() => backNow.current(), [])
  useEffect(() => {
    onBackChange?.(handOverBack)
  }, [onBackChange, handOverBack])

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      back()
      return true
    })
    return () => subscription.remove()
  }, [back])

  // Focus the PIN field on a delay rather than via `autoFocus`, which grabs
  // focus before this step's mount/layout settles and drops the first
  // keystroke (see the matching fix + comment in VaultCeremonySheet).
  useEffect(() => {
    if (step !== 'key') return
    const field = sub === 'pin' ? pinInputRef : sub === 'confirm' ? confirmInputRef : null
    if (!field) return
    const timer = setTimeout(() => field.current?.focus(), 150)
    return () => clearTimeout(timer)
  }, [step, sub])

  // ── intro → key 1 ───────────────────────────────────────────────────
  const begin = useCallback(() => {
    if (!ack || !pivAck || busy) return
    vaultStore.assertScopeToken(scopeToken)
    setStep(pending.length > 0 ? 'more' : 'key')
    if (pending.length === 0) setSub('pin')
  }, [ack, pivAck, busy, pending.length, scopeToken])

  /**
   * Re-read the scoped draft and quarantine LISTS, and only those.
   *
   * The mount effect also folds ready drafts into `pending` (or into `fresh`
   * plus a jump to the name page in add-key mode); doing that again mid-run
   * would move the page out from under the user. What has to stay current is
   * what the wizard believes this device still holds a record of: a partial
   * enrollment writes a new draft or quarantine during the run, and a reset
   * deletes one (pivReset's discardEnrollmentDraft / ...Quarantine). Both
   * change what the user must be told before erasing a card, and a stale list
   * also leaves a Resume button pointing at a key that no longer exists.
   */
  const reloadDraftLists = useCallback(async () => {
    try {
      const [meta, drafts, quarantines] = await Promise.all([
        vaultStore.getMeta(scopeToken),
        vaultStore.getEnrollmentDrafts(scopeToken),
        vaultStore.getEnrollmentQuarantines(scopeToken)
      ])
      const enrolledSerials = new Set(meta?.keys.map(key => key.serial) ?? [])
      const unused = drafts.filter(entry => !enrolledSerials.has(entry.record.serial))
      setRecoverableDrafts(unused.filter(entry => entry.assurance === 'challenge-required'))
      setBlockedDrafts([...unused.filter(entry => entry.assurance === 'management-uncertain'), ...quarantines])
    } catch {
      // Advisory only. These lists drive what the user is TOLD; every action
      // taken on them (resume, reset) re-reads the store below the UI, so a
      // failed refresh degrades to the previous lists rather than to a wrong
      // decision.
    }
  }, [scopeToken])

  // ── the card session ────────────────────────────────────────────────
  const runTap = useCallback(
    async (replaceOccupiedVaultSlot = false) => {
      if (tapInFlight.current || !pivAck) return
      // replacing the Vault slot destroys the key in it: the same chain check as a reset
      if (replaceOccupiedVaultSlot && gateArgs === null) return
      // the toolbox checks the clearance for a replace too, but only after the card is presented: the ten minutes are
      // kept here so an older 'clear' is checked again before the slot is opened
      if (
        replaceOccupiedVaultSlot &&
        gateArgs &&
        'fundsClearance' in gateArgs &&
        Date.now() - gateArgs.fundsClearance.issuedAt > VAULT_RESET_CLEARANCE_MS
      ) {
        setCheckRound(round => round + 1)
        return
      }
      tapInFlight.current = true
      setSub('tap')
      setPhase(null)
      setKeyError(null)
      setStepError(null)
      clearResetConsent()
      // Stored ∪ pending, in every mode: the service refuses these BEFORE it
      // spends the PIN or regenerates the slot (spec §3.3 step 2).
      const known = [...metaKeys.map(r => r.serial), ...pending.map(r => r.serial)]
      try {
        const record = await enrollKey({
          ...requireAuthority(),
          scopeToken,
          acknowledgeDedicatedPivApplication: true,
          pendingSerials: known,
          nickname: t('vault_name_default', { k }),
          onPhase: p => {
            setPhase(p)
          },
          // The intro's whole-PIV acknowledgement already asserts a
          // factory-reset, dedicated PIV application, and preflight
          // authenticates the factory management key before any mutation. So
          // the factory PIN and PUK are ours to supply; making the user type
          // '123456' was ceremony, not security.
          getPin: async () => DEFAULT_PIV_PIN,
          requestPinChange: async () => ({ oldPin: DEFAULT_PIV_PIN, newPin }),
          requestPukChange: async () => ({ oldPuk: DEFAULT_PIV_PUK, newPuk }),
          // Localised iOS NFC sheet text for this tap (enrollKey forwards it to
          // withKeySession → driver.start). Omitting it would fall back to the
          // native default wording.
          nfcMessage: t('vault_nfc_enroll_message'),
          replaceOccupiedVaultSlot,
          // Replace destroys the key in the slot: the toolbox wants the same gate as a reset
          ...(replaceOccupiedVaultSlot && gateArgs ? gateArgs : {})
        })
        haptics.success()
        await saveKey(record)
      } catch (e) {
        haptics.error()
        try {
          vaultStore.assertScopeToken(scopeToken)
        } catch {
          clearKeyInputs()
          showToast(vaultErrorCopy('scope-changed'), { type: 'error' })
          onCancel()
          return
        }
        const err = e instanceof VaultError ? e : undefined
        // The user dismissed the system NFC sheet: not an error to explain.
        // Everything gathered stays, and the page that starts the tap is the
        // recovery-code one, so Continue can simply be pressed again.
        if (err?.code === 'user-cancelled') {
          setSub('puk')
          return
        }
        if (replaceOccupiedVaultSlot && err?.code === 'chain-check-required') {
          // the toolbox refused the replace before it changed the card (the clearance ran out, or another key was
          // tapped): nothing was erased. Back to the Replace page, with a new chain check for the card that was tapped.
          setKeyError({
            code: 'slot-occupied',
            copy: vaultErrorCopy('slot-occupied'),
            mustUseDifferent: false,
            resetSerial: duplicateSerial(err) ?? gateSerial
          })
          setCheckRound(round => round + 1)
          setSub('error')
          return
        }
        // Every partial personalization result is represented by a durable
        // scoped draft or quarantine. Never guess which global PIV credential
        // is current and never re-enter generic enrollment on the same token;
        // a challenge-required draft is resumed through the explicit path
        // loaded above after reconnect/reopen.
        const tapped = duplicateSerial(err)
        const dupPending = tapped ? pending.find(p => p.serial === tapped) : undefined
        const dupEnrolled = tapped ? metaKeys.find(p => p.serial === tapped) : undefined
        let copy: string
        if (err?.code === 'key-already-enrolled') {
          // Name the duplicate; with no record to name, the serial tail still
          // identifies the card. Without even a serial the copy degrades to the
          // generic line inside vaultErrorCopy.
          copy = vaultErrorCopy(err.code, {
            nickname: dupPending?.nickname ?? dupEnrolled?.nickname ?? (tapped ? `…${tapped.slice(-4)}` : undefined)
          })
        } else if (err?.code === 'pin-locked') {
          // Enrolment-specific: there is no "use another of your vault keys"
          // yet, so the remedy is the PUK or a different card.
          copy = t('vault_err_pin_locked_enroll')
        } else if (err?.code === 'pin-invalid') {
          // The factory PIN is supplied below the UI, so this is never "you
          // mistyped": the card's PIV PIN is not 123456, i.e. the application
          // is not the factory-reset one the acknowledgement claimed. Retrying
          // would present 123456 again — it can only fail, and three of them
          // reach pin-locked on a PIV application that may hold unrelated
          // credentials. So this token is sent away rather than retried, and
          // the retry count is dropped: it means nothing when the app, not the
          // user, picks the PIN. The reset copy is literally true here, and is
          // where the reset offer attaches.
          copy = t('vault_enrollment_reset_required')
        } else if (err instanceof VaultEnrollmentPartialError) {
          // Deliberately the hedged copy, not the reset-required one. enrollKey
          // throws this carrying any stage, including `pin-change-uncertain` —
          // which VaultKeyService records BEFORE calling changePin, so a process
          // death in that window leaves a card that may still be at factory
          // state. Claiming it is not would be a lie in that case. The remedy
          // is the same either way, so the copy states the uncertainty instead
          // of guessing past it.
          copy = t('vault_enrollment_state_uncertain')
        } else {
          copy = vaultErrorCopy(err?.code)
        }
        setKeyError({
          code: err?.code,
          copy,
          mustUseDifferent: err instanceof VaultEnrollmentPartialError || (!!err && MUST_USE_DIFFERENT.has(err.code)),
          // A reset can only be bound to a specific card, and only offered for
          // failures a factory reset actually fixes. Without a serial there is
          // nothing to bind to — the reset tap has no other way to learn which
          // card failed — so no offer is made at all.
          resetSerial: tapped && err && RESETTABLE.has(err.code) && !NEVER_RESETTABLE.has(err.code) ? tapped : undefined
        })
        setSub('error')
        if (err instanceof VaultEnrollmentPartialError) {
          // A partial has just written a draft or a quarantine for this exact
          // serial. The reset page has to know that before it can describe
          // what erasing the card would destroy.
          void reloadDraftLists()
        }
      } finally {
        tapInFlight.current = false
      }
    },
    [
      k,
      metaKeys,
      pending,
      newPin,
      newPuk,
      onCancel,
      pivAck,
      saveKey,
      scopeToken,
      reloadDraftLists,
      requireAuthority,
      gateArgs,
      gateSerial
    ]
  )

  /** Resume only the non-mutating possession challenge for a protected draft.
   * The service re-reads the scoped draft and exact serial/pubkey before it
   * opens the YubiKey session. */
  const resumeDraft = useCallback(
    async (entry: VaultEnrollmentDraftEntry) => {
      if (tapInFlight.current || !pivAck || !pinOk) return
      tapInFlight.current = true
      setSub('tap')
      setPhase(null)
      setKeyError(null)
      setStepError(null)
      clearResetConsent()
      try {
        const record = await resumeEnrollmentDraft({
          ...requireAuthority(),
          entry,
          scopeToken,
          onPhase: setPhase,
          // A protected draft's card already carries the PIN chosen in this run.
          getPin: async () => newPin,
          nfcMessage: t('vault_nfc_enroll_message')
        })
        vaultStore.assertScopeToken(scopeToken)
        setRecoverableDrafts(current => current.filter(draft => draft.record.serial !== record.serial))
        haptics.success()
        await saveKey(record)
      } catch (e) {
        haptics.error()
        try {
          vaultStore.assertScopeToken(scopeToken)
        } catch {
          clearKeyInputs()
          showToast(vaultErrorCopy('scope-changed'), { type: 'error' })
          onCancel()
          return
        }
        const err = e instanceof VaultError ? e : undefined
        if (err?.code === 'pin-invalid') {
          setNewPin('')
          setConfirmPin('')
          setPinError(vaultErrorCopy('pin-invalid', { count: err.retriesLeft }))
          setSub('pin')
          return
        }
        setKeyError({
          code: err?.code,
          // resumeEnrollmentDraft only ever throws `key-generated` or
          // `key-protected`, so the card here is certainly mutated and the
          // reset-required copy would be literally true. The hedged copy is
          // used anyway: it is also true (the management-key state is exactly
          // what is unknown), no reset is offered from this path, and one rule
          // — proven state gets the definite copy, recorded uncertainty gets
          // the hedged one — is easier to keep right than a per-site judgement.
          copy:
            err instanceof VaultEnrollmentPartialError
              ? t('vault_enrollment_state_uncertain')
              : vaultErrorCopy(err?.code),
          // Same dead-button argument as the enrollment tap: `pin-invalid` is
          // already handled above, and the rest of the set cannot be retried
          // into success from here either.
          mustUseDifferent: err instanceof VaultEnrollmentPartialError || (!!err && MUST_USE_DIFFERENT.has(err.code))
          // No `resetSerial`: no reset is offered from the resume path, and
          // because the binding lives on this object there is no earlier
          // serial that could follow the user here.
        })
        setSub('error')
      } finally {
        tapInFlight.current = false
      }
    },
    [onCancel, newPin, pinOk, pivAck, saveKey, scopeToken, requireAuthority]
  )

  // ── finish (enroll mode) ────────────────────────────────────────────
  const finish = useCallback(async () => {
    if (pending.length < VAULT_MIN_KEYS || busy) return
    setBusy(true)
    setStepError(null)
    try {
      await finalizeEnrollment(pending, scopeToken, requireAuthority())
      // No tone here (see useConfirmationSound): vaultDeposit/vaultWithdraw
      // name an actual transfer, and enrolling isn't one.
      haptics.success()
      showToast(t('vault_enrolled_toast'), { type: 'success' })
      setStep('done')
    } catch (e) {
      haptics.error()
      setStepError(vaultErrorCopy(e instanceof VaultError ? e.code : undefined))
    } finally {
      setBusy(false)
    }
  }, [pending, busy, scopeToken, requireAuthority])

  const addAnother = useCallback(() => {
    setStepError(null)
    // A destructive tick must never survive into the next key's step.
    clearResetConsent()
    setStep('key')
    setSub('pin')
  }, [])

  /** A different card has a different PIN: start the step over. */
  const chooseDifferentKey = () => {
    setKeyError(null)
    clearKeyInputs()
    setSub('pin')
  }

  /**
   * Erase this card's whole PIV application so a previously used YubiKey can
   * be enrolled.
   *
   * TWO consents, deliberately separate, because they are two different facts.
   * `resetAck` is "this erases everything on this key" — every certificate and
   * key in the PIV application, not only Vault's slot. `resetUnknownAck` is a
   * narrower and worse one: the Vault slot holds a key that no vault this
   * device can see claims, so erasing it destroys a vault key belonging to a
   * vault we cannot inspect. `acknowledgeUnrecognizedVaultKey` is the ONLY
   * guard in pivReset a caller can talk past, so it is never sent on the first
   * attempt: the card decides whether the question needs asking at all, and
   * the user answers that exact question before it is sent.
   */
  const runReset = useCallback(async () => {
    // Read straight off the failure being shown: the serial erased is by
    // construction the one that failed, and the one rendered above the button.
    const resetSerial = keyError?.resetSerial
    if (!resetSerial || !resetAck || resetting || tapInFlight.current) return
    if (resetUnknownSlot && !resetUnknownAck) return
    // the chain check (or the person's affirmation) decides what the reset may pass; nothing yet means no reset
    const gate = gateArgs
    if (!gate) return
    setResetting(true)
    // A card session is open: hardware back is swallowed until its outcome
    // lands, the same invariant the enrollment tap holds — more so here,
    // because the outcome may be an erased key.
    tapInFlight.current = true
    setStepError(null)
    let wiped = false
    try {
      // Read the cross-chain enrolled set HERE rather than leaving it to
      // pivReset alone. Corrupt metadata on any chain — including one this
      // wallet never used — makes that read throw, and from the service's
      // rejection there is no way to tell that apart from a failure after the
      // card was already erased. Asked here it is provably before any card
      // contact, so the copy can say what actually happened: nothing.
      let acrossChains: readonly string[] = []
      try {
        acrossChains = await vaultStore.enrolledSerialsAcrossChains(scopeToken)
      } catch (e) {
        haptics.error()
        if (e instanceof VaultError && e.code === 'scope-changed') {
          // Still before any card contact, so the ordinary line is truthful
          // here — unlike the same code raised around the reset itself.
          clearKeyInputs()
          showToast(vaultErrorCopy('scope-changed'), { type: 'error' })
          onCancel()
          return
        }
        setStepError(t('vault_err_reset_unreadable'))
        return
      }
      await resetPivApplication({
        serial: resetSerial,
        // Stored ∪ pending ∪ every chain: pivReset refuses all of these below
        // the UI too, but the wizard holds pending records the store has not
        // seen yet, and dropping them would silently remove half of that
        // refusal for exactly the keys set up in this run.
        refuseSerials: [...acrossChains, ...metaKeys.map(r => r.serial), ...pending.map(r => r.serial)],
        acknowledgeDestroysAllCredentials: true,
        ...(resetUnknownAck ? { acknowledgeUnrecognizedVaultKey: true as const } : {}),
        ...gate,
        scopeToken,
        nfcMessage: t('vault_nfc_enroll_message')
      })
      wiped = true
    } catch (e) {
      haptics.error()
      const err = e instanceof VaultError ? e : undefined
      if (err?.code === 'scope-changed') {
        clearKeyInputs()
        // Not the usual scope-changed line. This assertion also runs AFTER the
        // reset APDU, and what the user needs to know about a destructive
        // command is the state of the card, not why the wizard closed.
        showToast(t('vault_reset_uncertain'), { type: 'error' })
        onCancel()
        return
      }
      if (err?.code === 'slot-occupied') {
        // The card's own answer (pivReset guard 3, pivReset.ts:109-116), which
        // runs BEFORE driver.resetPivApplication. This is the one rejection
        // where "nothing was erased" is provable, and the user has just
        // pressed a destructive button and watched a card session open and
        // close — so it is reported, not merely implied by a new checkbox
        // appearing. A checkbox states a consequence; it does not report an
        // outcome.
        setResetUnknownSlot(true)
        setStepError(t('vault_reset_nothing_erased'))
        return
      }
      if (err?.code === 'chain-check-required') {
        // the clearance ran out, or was never given: nothing was erased, so check the chain again
        setCheckRound(round => round + 1)
      }
      setStepError(
        err?.code === 'key-already-enrolled'
          ? t('vault_err_reset_enrolled')
          : err && RESET_BEFORE_ERASE.has(err.code)
            ? vaultErrorCopy(err.code)
            : t('vault_reset_uncertain')
      )
      return
    } finally {
      tapInFlight.current = false
      setResetting(false)
    }
    if (!wiped) return
    haptics.success()
    showToast(t('vault_reset_done'), { type: 'success' })
    clearResetConsent()
    setKeyError(null)
    // pivReset deletes this serial's draft and quarantine as part of the reset.
    // Without this the PIN page keeps offering "Resume · …xxxx" for a key that
    // no longer exists — a dead-end button of exactly the kind this plan spent
    // its last two tasks removing.
    await reloadDraftLists()
    // Back to the recovery-code page, whose Continue starts the next tap — NOT
    // straight into runTap(). CoreNFC refuses a new reader session until the
    // previous one has finished invalidating, and the reset's session closed
    // milliseconds ago, so an immediate re-tap hangs on a sheet that never
    // connects. Requiring the user's press is both the spacing that makes it
    // work and what the toast already tells them to do.
    //
    // The PIN and recovery code chosen for this key are still valid: the card is
    // back at factory state and neither was ever written to it, so this does not
    // ask for them again.
    setSub('puk')
  }, [
    keyError,
    resetAck,
    resetUnknownSlot,
    resetUnknownAck,
    resetting,
    metaKeys,
    pending,
    scopeToken,
    onCancel,
    runTap,
    reloadDraftLists,
    gateArgs
  ])

  /** Under the reset page and the slot-occupied page: what the chain check found, and what the person may do. */
  const cardGateBlock = (
    <>
      {cardCheck === null && (
        <BalancedText style={[styles.p, { color: colors.textSecondary }]}>{t('vault_card_checking')}</BalancedText>
      )}
      {cardCheck?.kind === 'funds' && (
        <>
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_card_funds_title')}</Text>
          <BalancedText style={[styles.p, { color: colors.textSecondary }]}>
            {t('vault_card_funds_body', { count: cardCheck.deposits, amount: bsvAmount(cardCheck.satoshis) })}
          </BalancedText>
          {onRestoreVault && (
            <ActionButton label={t('vault_card_restore')} onPress={() => onRestoreVault(cardCheck.serial)} />
          )}
        </>
      )}
      {cardCheck?.kind === 'unknown' && (
        <>
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_card_unknown_title')}</Text>
          <BalancedText style={[styles.p, { color: colors.textSecondary }]}>{t('vault_card_unknown_body')}</BalancedText>
          {cardGate && (
            <ActionButton
              label={t('vault_card_retry')}
              variant="outline"
              onPress={() => setCheckRound(round => round + 1)}
            />
          )}
        </>
      )}
      {cardCheck && cardCheck.kind !== 'clear' && (
        <PressableScale
          accessibilityRole="checkbox"
          accessibilityState={{ checked: lossAck }}
          haptic="tap"
          onPress={() => setLossAck(value => !value)}
          style={[styles.ackRow, { borderColor: lossAck ? colors.error : colors.separator }]}
        >
          {lossAck ? (
            <SquareCheckBig size={20} color={colors.error} />
          ) : (
            <Square size={20} color={colors.textTertiary} />
          )}
          <Text style={[styles.ackText, { color: colors.textPrimary }]}>{t('vault_card_loss_ack')}</Text>
        </PressableScale>
      )}
    </>
  )

  const leaveLink = (
    <PressableScale onPress={() => void leave()} style={styles.secondary}>
      <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>
        {unsaved > 0 ? t('vault_leave_setup') : t('vault_cancel')}
      </Text>
    </PressableScale>
  )

  const pivAcknowledgement = (
    <PressableScale
      accessibilityRole="checkbox"
      accessibilityState={{ checked: pivAck }}
      haptic="tap"
      onPress={() => setPivAck(value => !value)}
      style={[styles.ackRow, { borderColor: pivAck ? colors.accent : colors.separator }]}
    >
      {pivAck ? <SquareCheckBig size={20} color={colors.accent} /> : <Square size={20} color={colors.textTertiary} />}
      <Text style={[styles.ackText, { color: colors.textPrimary }]}>{t('vault_intro_piv_ack')}</Text>
    </PressableScale>
  )

  // ── intro ───────────────────────────────────────────────────────────
  if (step === 'intro') {
    return (
      <ScrollView contentContainerStyle={styles.body}>
        {!hideIntroTitle && <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_intro_title')}</Text>}
        <BalancedText style={[styles.p, { color: colors.textSecondary }]}>{t('vault_intro_what')}</BalancedText>
        <View style={[styles.bullets, { borderColor: colors.separator }]}>
          <Bullet icon={KeyRound} text={t('vault_intro_two_keys')} />
          <Bullet icon={MapPin} text={t('vault_intro_apart')} />
          <Bullet icon={CloudUpload} text={t('vault_intro_backup')} />
        </View>
        <PressableScale
          accessibilityRole="checkbox"
          accessibilityState={{ checked: ack }}
          haptic="tap"
          onPress={() => setAck(a => !a)}
          style={[styles.ackRow, { borderColor: ack ? colors.accent : colors.separator }]}
        >
          {ack ? <SquareCheckBig size={20} color={colors.accent} /> : <Square size={20} color={colors.textTertiary} />}
          <Text style={[styles.ackText, { color: colors.textPrimary }]}>{t('vault_intro_ack')}</Text>
        </PressableScale>
        {pivAcknowledgement}
        {/* `blockedDrafts` mixes management-uncertain drafts (certainly mutated)
            with quarantines, and the earliest quarantine stage is recorded
            before the card is touched — so this banner cannot claim the key is
            non-factory. It also names no key, because none is in hand here. */}
        {blockedDrafts.length > 0 && (
          <BalancedText style={[styles.warn, { color: colors.warning }]}>
            {t('vault_enrollment_state_uncertain')}
          </BalancedText>
        )}
        <ActionButton label={t('vault_intro_begin')} enabled={ack && pivAck} busy={busy} onPress={() => void begin()} />
        <PressableScale onPress={onCancel} style={styles.secondary}>
          <Text style={[styles.secondaryLabel, { color: colors.textSecondary }]}>{t('vault_cancel')}</Text>
        </PressableScale>
      </ScrollView>
    )
  }

  // ── key k ───────────────────────────────────────────────────────────
  if (step === 'key') {
    if (sub === 'pin') {
      const advance = () => {
        if (!pivAck || busy || !pinChosen) return
        setPinError(null)
        setSub('confirm')
      }
      // The one refusal a disabled Continue cannot account for by itself: six
      // well-formed digits, refused anyway. Said while it is typed, because
      // there is no longer a press for it to be said on.
      const problem = pinError ?? (newPin === DEFAULT_PIV_PIN ? t('vault_pin_not_default') : null)
      return (
        <KeyboardPage>
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_key_step_title', { k })}</Text>
          <StepProgress sub={sub} />
          <BalancedText style={[styles.p, { color: colors.textSecondary }]}>{t('vault_key_step_replace')}</BalancedText>
          {mode === 'add-key' && pivAcknowledgement}

          <Text style={[styles.label, { color: colors.textPrimary }]}>{t('vault_pin_choose_title')}</Text>
          <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('vault_pin_choose_sub')}</Text>
          <TextInput
            ref={pinInputRef}
            accessibilityLabel={t('vault_pin_choose_title')}
            style={[styles.pin, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
            value={newPin}
            onChangeText={text => {
              setPinError(null)
              setNewPin(text)
              // The confirmation is only ever a copy of this; a kept one would
              // make an edited PIN look confirmed on the next page.
              setConfirmPin('')
            }}
            placeholder="••••••"
            placeholderTextColor={colors.textTertiary}
            keyboardType="number-pad"
            // Always secure: toggling this prop on based on length forces the
            // native field to remount on the first keystroke and drops it.
            secureTextEntry
            maxLength={PIN_MAX}
          />
          {problem && <BalancedText style={[styles.err, { color: colors.error }]}>{problem}</BalancedText>}
          {stepError && <BalancedText style={[styles.err, { color: colors.error }]}>{stepError}</BalancedText>}
          {/* This page says "Choose a PIN", but resuming sends what is typed
              here to a card that already carries the PIN an earlier run set.
              A fresh choice is a guess, and three guesses lock a card holding
              a real, partially enrolled vault key — so say which PIN is wanted
              whenever a resume is actually on offer. */}
          {recoverableDrafts.length > 0 && (
            <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('vault_enrollment_resume_pin_hint')}</Text>
          )}
          {/* Same hedge as the intro banner, and for the same reason. */}
          {blockedDrafts.length > 0 && (
            <BalancedText style={[styles.warn, { color: colors.warning }]}>
              {t('vault_enrollment_state_uncertain')}
            </BalancedText>
          )}
          <ActionButton label={t('vault_continue')} enabled={pivAck && pinChosen && !busy} onPress={advance} />
          {leaveLink}
        </KeyboardPage>
      )
    }

    if (sub === 'confirm') {
      const advance = () => {
        if (!pivAck || busy || !pinOk) return
        setPinError(null)
        // Generated once per visit to the PUK page, so going back and forward
        // does not silently hand the user a different code to write down. The
        // one exception is a PIN that now equals the code: the service refuses
        // that pair (validatePukChange) before the session opens, and the error
        // page offers only a Retry that would fail identically forever.
        if (!newPuk || newPuk === newPin) setNewPuk(generateRecoveryCode(newPin))
        setSub('puk')
      }
      // Typed far enough to be a whole PIN and still a different one. The
      // button is dead until these agree, so the page says why rather than
      // letting that read as a button that does nothing.
      const problem =
        pinError ?? (confirmPin.length >= newPin.length && confirmPin !== newPin ? t('vault_pin_mismatch') : null)
      return (
        <KeyboardPage>
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_key_step_title', { k })}</Text>
          <StepProgress sub={sub} />
          <Text style={[styles.label, { color: colors.textPrimary }]}>{t('vault_pin_confirm_label')}</Text>
          <TextInput
            ref={confirmInputRef}
            accessibilityLabel={t('vault_pin_confirm_label')}
            style={[styles.pin, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
            value={confirmPin}
            onChangeText={text => {
              setPinError(null)
              setConfirmPin(text)
            }}
            placeholder="••••••"
            placeholderTextColor={colors.textTertiary}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={PIN_MAX}
          />
          {problem && <BalancedText style={[styles.err, { color: colors.error }]}>{problem}</BalancedText>}
          {stepError && <BalancedText style={[styles.err, { color: colors.error }]}>{stepError}</BalancedText>}
          {/* The hint about which PIN a resume wants is on the page that asks
              for it; the buttons are here because a resume spends that PIN on
              a card that locks after three wrong tries, and only a PIN typed
              twice the same is known to be the one meant. */}
          {recoverableDrafts.map(entry => (
            <ActionButton
              key={entry.record.serial}
              label={`${t('vault_enrollment_resume')} · …${entry.record.serial.slice(-4)}`}
              variant="outline"
              enabled={pivAck && pinOk && !busy}
              onPress={() => void resumeDraft(entry)}
            />
          ))}
          <ActionButton label={t('vault_continue')} enabled={pivAck && pinOk && !busy} onPress={advance} />
          {leaveLink}
        </KeyboardPage>
      )
    }

    if (sub === 'puk') {
      return (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_key_step_title', { k })}</Text>
          <StepProgress sub={sub} />
          <Text style={[styles.label, { color: colors.textPrimary }]}>{t('vault_puk_title')}</Text>
          {/* Shown once and never stored, exactly like the PIN. The
              acknowledgement is a tick rather than a plain button because
              losing this code silently is the failure this page exists to
              prevent. */}
          {/* Spaced digits, not the heading: an accessibilityLabel REPLACES the
              content, so labelling this with the title announced "Your recovery
              code" twice and never read the digits — on the one page whose
              whole job is getting eight digits into the user's head. Spacing
              them makes VoiceOver/TalkBack read them one at a time instead of
              as a single eight-digit number. */}
          <Text
            testID="vault-recovery-code"
            accessibilityLabel={newPuk.split('').join(' ')}
            selectable
            style={[styles.code, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
          >
            {newPuk}
          </Text>
          <BalancedText style={[styles.p, { color: colors.textSecondary }]}>{t('vault_puk_body')}</BalancedText>
          <PressableScale
            accessibilityRole="checkbox"
            accessibilityState={{ checked: pukAck }}
            haptic="tap"
            onPress={() => setPukAck(value => !value)}
            style={[styles.ackRow, { borderColor: pukAck ? colors.accent : colors.separator }]}
          >
            {pukAck ? (
              <SquareCheckBig size={20} color={colors.accent} />
            ) : (
              <Square size={20} color={colors.textTertiary} />
            )}
            <Text style={[styles.ackText, { color: colors.textPrimary }]}>{t('vault_puk_ack')}</Text>
          </PressableScale>
          {stepError && <BalancedText style={[styles.err, { color: colors.error }]}>{stepError}</BalancedText>}
          {/* NFC only: a brand-new YubiKey ships in restricted NFC mode (Yubico's
              anti-scan-in-transit policy) and stays that way until it is plugged
              into USB-C for a few seconds — a one-time, per-key step done outside
              this app. Shown on every key here since we cannot tell a fresh card
              from a already-activated one before the tap. This is the last page
              before it, and the only one of the three the keyboard leaves room
              on. */}
          {Platform.OS === 'ios' && (
            <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('vault_nfc_activation_hint')}</Text>
          )}
          <ActionButton label={t('vault_continue')} enabled={pukAck && pinOk && !busy} onPress={() => void runTap()} />
          {leaveLink}
        </ScrollView>
      )
    }

    if (sub === 'tap') {
      return (
        <View style={styles.body}>
          {KeyArt ? (
            <View style={styles.keyArt}>
              <KeyArt waiting size={176} />
            </View>
          ) : (
            <ActivityIndicator color={colors.textPrimary} size="large" style={styles.hero} />
          )}
          <StepProgress sub={sub} />
          <Text style={[styles.h1, { color: colors.textPrimary }]}>
            {phase ? t(`vault_enroll_phase_${phase.replace(/-/g, '_')}`) : t('vault_reading_key')}
          </Text>
          <BalancedText style={[styles.p, { color: colors.textSecondary }]}>
            {t('vault_touch_when_blinks')}
          </BalancedText>
        </View>
      )
    }

    if (sub === 'save') {
      // add-key mode only — enroll mode's save is a synchronous push into
      // `pending`. Nothing is asked here, so there is nothing to show but the
      // write itself, and the retry if it fails. The card is done either way:
      // the retry saves the record again, it never taps anything.
      return (
        <View style={styles.body}>
          {stepError ? (
            <>
              <CircleAlert size={48} color={colors.error} style={styles.hero} />
              <Text style={[styles.h1, { color: colors.textPrimary }]}>{stepError}</Text>
              <ActionButton
                label={t('vault_retry')}
                busy={busy}
                onPress={() => {
                  if (fresh) void saveKey(fresh)
                }}
              />
              {leaveLink}
            </>
          ) : (
            <ActivityIndicator color={colors.textPrimary} size="large" style={styles.hero} />
          )}
        </View>
      )
    }

    if (sub === 'reset') {
      // The same field `runReset` reads, so the serial shown above the button
      // is the serial erased, with no second copy that could disagree.
      const resetSerial = keyError?.resetSerial
      // Is the key in this card's Vault slot one THIS device has a record of —
      // a draft or a quarantine from an earlier attempt, possibly this very
      // run's? If so, "a vault key that no vault on this device claims" is
      // simply false, and telling the user that trains them to tick the only
      // guard in pivReset a caller can override. They would then meet the case
      // it exists for — another identity's live vault key — with the habit
      // already formed.
      const knownDraft =
        resetSerial !== undefined &&
        (recoverableDrafts.some(entry => entry.record.serial === resetSerial) ||
          blockedDrafts.some(item => ('record' in item ? item.record.serial : item.serial) === resetSerial))
      const resumableDraft = recoverableDrafts.find(entry => entry.record.serial === resetSerial)
      return (
        <ScrollView contentContainerStyle={styles.body}>
          <TriangleAlert size={48} color={colors.warning} style={styles.hero} />
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_reset_title')}</Text>
          <BalancedText style={[styles.p, { color: colors.textSecondary }]}>
            {resetSerial ? `…${resetSerial.slice(-4)}` : ''}
          </BalancedText>
          <BalancedText style={[styles.p, { color: colors.textSecondary }]}>{t('vault_reset_body')}</BalancedText>
          <PressableScale
            accessibilityRole="checkbox"
            accessibilityState={{ checked: resetAck }}
            haptic="tap"
            onPress={() => setResetAck(value => !value)}
            style={[styles.ackRow, { borderColor: resetAck ? colors.error : colors.separator }]}
          >
            {resetAck ? (
              <SquareCheckBig size={20} color={colors.error} />
            ) : (
              <Square size={20} color={colors.textTertiary} />
            )}
            <Text style={[styles.ackText, { color: colors.textPrimary }]}>{t('vault_reset_ack')}</Text>
          </PressableScale>
          {cardGateBlock}
          {/* Directly above the question it explains. On `slot-occupied` this
              is the pre-erase line: the user pressed a destructive button and
              watched a card session open and close, and needs to be told the
              erase did not happen before being asked anything else. */}
          {stepError && <BalancedText style={[styles.err, { color: colors.error }]}>{stepError}</BalancedText>}
          {/* Shown only once the card itself has reported an occupied Vault
              slot. A separate question, because it is a separate loss — and
              which loss it is depends on whether this device knows the key in
              that slot. */}
          {resetUnknownSlot && (
            <PressableScale
              accessibilityRole="checkbox"
              accessibilityState={{ checked: resetUnknownAck }}
              haptic="tap"
              onPress={() => setResetUnknownAck(value => !value)}
              style={[styles.ackRow, { borderColor: resetUnknownAck ? colors.error : colors.separator }]}
            >
              {resetUnknownAck ? (
                <SquareCheckBig size={20} color={colors.error} />
              ) : (
                <Square size={20} color={colors.textTertiary} />
              )}
              <Text style={[styles.ackText, { color: colors.textPrimary }]}>
                {knownDraft ? t('vault_reset_own_draft_ack') : t('vault_reset_unknown_ack')}
              </Text>
            </PressableScale>
          )}
          {/* The non-destructive way out of the case above: this device holds a
              resumable record for the very key the reset would erase. Carries
              the same PIN warning as the PIN page, because resuming sends the
              PIN in state and only an earlier run's PIN will open that card. */}
          {resetUnknownSlot && resumableDraft && (
            <>
              <Text style={[styles.hint, { color: colors.textSecondary }]}>
                {t('vault_enrollment_resume_pin_hint')}
              </Text>
              <ActionButton
                label={`${t('vault_enrollment_resume')} · …${resumableDraft.record.serial.slice(-4)}`}
                variant="outline"
                enabled={pinOk && !resetting}
                onPress={() => void resumeDraft(resumableDraft)}
              />
            </>
          )}
          <ActionButton
            label={resetting ? t('vault_resetting') : t('vault_reset_confirm')}
            enabled={resetAck && (!resetUnknownSlot || resetUnknownAck) && !resetting && gateArgs !== null}
            onPress={() => void runReset()}
          />
          <ActionButton
            label={t('vault_key_use_different')}
            variant="outline"
            enabled={!resetting}
            onPress={() => {
              setStepError(null)
              chooseDifferentKey()
            }}
          />
        </ScrollView>
      )
    }

    // sub === 'error'
    const code = keyError?.code
    return (
      <View style={styles.body}>
        <CircleAlert size={48} color={colors.error} style={styles.hero} />
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{keyError?.copy ?? t('vault_err_generic')}</Text>
        {/* Set only for a card whose failure a factory reset can actually fix
            (RESETTABLE minus NEVER_RESETTABLE), and only when the failure named
            the card. It is a field of THIS failure, so it cannot be a leftover
            from an earlier one. */}
        {keyError?.resetSerial ? (
          <ActionButton
            label={t('vault_reset_offer')}
            variant="outline"
            onPress={() => {
              setStepError(null)
              setSub('reset')
            }}
          />
        ) : null}
        {code === 'slot-occupied' ? (
          <>
            <BalancedText style={[styles.p, { color: colors.textSecondary }]}>
              {t('vault_replace_key_warning')}
            </BalancedText>
            {cardGateBlock}
            <ActionButton
              label={t('vault_replace_key_confirm')}
              enabled={gateArgs !== null}
              onPress={() => void runTap(true)}
            />
            <ActionButton label={t('vault_key_use_different')} variant="outline" onPress={chooseDifferentKey} />
          </>
        ) : code === 'key-already-enrolled' || code === 'puk-locked' || keyError?.mustUseDifferent ? (
          <ActionButton label={t('vault_key_use_different')} onPress={chooseDifferentKey} />
        ) : code === 'enrollment-partial' ? (
          // The one exit from the error page that does not go through
          // clearKeyInputs, so the destructive ticks are dropped explicitly:
          // the next thing reached from the PIN page may be a resume of a
          // DIFFERENT card, and consent must not be waiting for it.
          <ActionButton
            label={t('vault_retry')}
            onPress={() => {
              clearResetConsent()
              setSub('pin')
            }}
          />
        ) : (
          <ActionButton label={t('vault_retry')} onPress={() => void runTap()} />
        )}
        {leaveLink}
      </View>
    )
  }

  // ── more ────────────────────────────────────────────────────────────
  if (step === 'more') {
    const canAdd = total < VAULT_MAX_KEYS
    const canFinish = pending.length >= VAULT_MIN_KEYS
    return (
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_more_title')}</Text>
        <BalancedText style={[styles.p, { color: colors.textSecondary }]}>{t('vault_more_body')}</BalancedText>
        <View style={[styles.list, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}>
          {pending.map((p, i) => (
            <View
              key={p.serial}
              style={[
                styles.listRow,
                i < pending.length - 1 && {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors.separator
                }
              ]}
            >
              <KeyRound size={16} color={colors.success} />
              <Text style={[styles.listLabel, { color: colors.textPrimary }]} numberOfLines={1}>
                {vaultKeyLabel(p)}
              </Text>
            </View>
          ))}
        </View>
        {!canFinish && (
          <BalancedText style={[styles.warn, { color: colors.warning }]}>{t('vault_more_need_two')}</BalancedText>
        )}
        {stepError && <BalancedText style={[styles.err, { color: colors.error }]}>{stepError}</BalancedText>}
        {/* The filled button is whichever moves the user forward: Add while a
            second key is still required, Finish once there are enough. */}
        {canAdd && (
          <ActionButton
            label={t('vault_more_add')}
            variant={canFinish ? 'outline' : 'primary'}
            enabled={!busy}
            onPress={addAnother}
          />
        )}
        <ActionButton label={t('vault_more_finish')} enabled={canFinish} busy={busy} onPress={() => void finish()} />
        {leaveLink}
      </ScrollView>
    )
  }

  // ── done ────────────────────────────────────────────────────────────
  // A sixth key is one more than a lock holds: the next step is removing the
  // key it replaces, not a re-lock (which would be refused).
  const overLockLimit = mode === 'add-key' && enrolledCount + 1 > VAULT_MAX_KEYS
  return (
    <View style={[styles.body, styles.doneBody]}>
      <CircleCheck size={56} color={colors.success} style={styles.hero} />
      <Text style={[styles.h1, { color: colors.textPrimary }]}>
        {mode === 'enroll' ? t('vault_enrolled_toast') : t('vault_key_added_toast')}
      </Text>
      <BalancedText style={[styles.p, { color: colors.textSecondary }]}>
        {mode === 'enroll'
          ? t('vault_done_body', { count: pending.length })
          : t(overLockLimit ? 'vault_add_key_done_over_limit' : 'vault_add_key_done', { nickname: addedNickname })}
      </BalancedText>
      <ActionButton
        label={mode === 'enroll' || overLockLimit ? t('vault_done_cta') : t('vault_relock_now')}
        onPress={onDone}
      />
    </View>
  )
}

/**
 * A page whose Continue sits under a field the keyboard covers.
 *
 * The number pad takes about two-fifths of the screen, so the PIN is asked for
 * one field at a time and the scrolling area is lifted clear of the keyboard
 * rather than left behind it: `padding` shrinks this view by the keyboard's
 * height, which is what gives the page inside it a bottom the user can reach.
 * Android resizes the window itself (adjustResize) and would otherwise be
 * padded twice over.
 */
const KeyboardPage: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView style={styles.flex} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  </KeyboardAvoidingView>
)

/**
 * Where this key's setup has got to. Per key, four steps: choose a PIN,
 * confirm it, note the recovery code, tap.
 */
const StepProgress: React.FC<{ sub: KeySub }> = ({ sub }) => {
  const { colors } = useTheme()
  const index = KEY_STEPS.indexOf(sub)
  if (index < 0) return null
  const n = index + 1
  const total = KEY_STEPS.length
  return (
    <View style={styles.progress} accessibilityRole="progressbar" accessibilityValue={{ min: 1, max: total, now: n }}>
      <View style={[styles.progressTrack, { backgroundColor: colors.backgroundSecondary }]}>
        <View style={[styles.progressFill, { backgroundColor: colors.accent, width: `${(n / total) * 100}%` }]} />
      </View>
      <Text style={[styles.progressLabel, { color: colors.textSecondary }]}>{t('vault_setup_step', { n, total })}</Text>
    </View>
  )
}

/** One intro bullet: glyph + line. */
const Bullet: React.FC<{ icon: LucideIcon; text: string }> = ({ icon: Icon, text }) => {
  const { colors } = useTheme()
  return (
    <View style={styles.bulletRow}>
      <Icon size={16} color={colors.info} />
      <Text style={[styles.bulletText, { color: colors.textPrimary }]}>{text}</Text>
    </View>
  )
}

/**
 * The wizard's button. Filled accent when primary and enabled; outlined when
 * disabled or `variant="outline"` — filled with the secondary background it was
 * indistinguishable from the page in dark mode.
 */
const ActionButton: React.FC<{
  label: string
  enabled?: boolean
  busy?: boolean
  variant?: 'primary' | 'outline'
  onPress: () => void
}> = ({ label, enabled = true, busy = false, variant = 'primary', onPress }) => {
  const { colors } = useTheme()
  const active = enabled && !busy
  const filled = active && variant === 'primary'
  return (
    <PressableScale
      haptic="confirm"
      // `disabled` (not only a dropped handler) so the responder itself
      // refuses the press: a11y reports it, and nothing above it in the tree
      // can pick the press up.
      disabled={!active}
      onPress={active ? onPress : undefined}
      accessibilityState={{ disabled: !active }}
      style={[
        styles.primary,
        filled
          ? { backgroundColor: colors.accent }
          : { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separator }
      ]}
    >
      {busy ? (
        <ActivityIndicator color={filled ? colors.textOnAccent : colors.textPrimary} />
      ) : (
        <Text
          style={[
            styles.primaryLabel,
            { color: filled ? colors.textOnAccent : active ? colors.textPrimary : colors.textTertiary }
          ]}
        >
          {label}
        </Text>
      )}
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { padding: spacing.xl, gap: spacing.lg },
  doneBody: { flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
  hero: { marginTop: spacing.lg, alignSelf: 'center' },
  keyArt: { alignSelf: 'center', marginTop: spacing.sm, marginBottom: spacing.sm },
  h1: { ...typography.title2, textAlign: 'center' },
  p: { ...typography.subhead, textAlign: 'center' },
  label: { ...typography.headline },
  hint: { ...typography.footnote },
  warn: { ...typography.footnote, textAlign: 'center' },
  err: { ...typography.footnote, textAlign: 'center' },
  progress: { gap: spacing.xs },
  progressTrack: { height: 4, borderRadius: radii.sm, overflow: 'hidden' },
  progressFill: { height: 4, borderRadius: radii.sm },
  progressLabel: { ...typography.footnote, textAlign: 'center' },
  bullets: {
    gap: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg
  },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  bulletText: { ...typography.subhead, flex: 1 },
  ackRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg
  },
  ackText: { ...typography.subhead, flex: 1 },
  pin: {
    width: '70%',
    alignSelf: 'center',
    textAlign: 'center',
    ...typography.title2,
    letterSpacing: 8,
    borderRadius: radii.md,
    paddingVertical: spacing.md
  },
  code: {
    width: '80%',
    alignSelf: 'center',
    textAlign: 'center',
    ...typography.title2,
    letterSpacing: 6,
    borderRadius: radii.md,
    paddingVertical: spacing.lg
  },
  list: { borderRadius: radii.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 44,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg
  },
  listLabel: { ...typography.body, flex: 1 },
  primary: { width: '100%', borderRadius: radii.md, paddingVertical: spacing.lg, alignItems: 'center' },
  primaryLabel: { ...typography.headline },
  secondary: { paddingVertical: spacing.md, alignItems: 'center' },
  secondaryLabel: { ...typography.body }
})
