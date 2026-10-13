// Sign in on a new phone (the prototype's components/import-wallet-sheet.tsx),
// on the shared core (decision 5): paste a recovery phrase or a private key
// (64 hex characters), or scan two of your three key slices. The core checks
// it (classifyImportInput, secretFromShares), stores it, builds the wallet and
// replays its Sync history (restoreWallet with restore: true), then the
// history it found is said plainly.
//
// A wallet already on this phone is replaced only after you confirm, and the
// confirmation says what that costs. Not here, unlike the prototype: other
// wallets' phrases and paths, a Sync recovery key and a backup file (their
// specs aren't settled: decisions 2 and 6).
import React, { useEffect, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View, Platform } from 'react-native'
import { TextInput } from '../ui/TextInput'
import Animated, { cubicBezier } from 'react-native-reanimated'
import { CircleAlert, Eye, EyeOff, FileLock2, KeyRound, Puzzle } from 'lucide-react-native'
import { useLocalStorage, useRecoveryDeps, useWallet } from '@bsv/expo-wallet-toolbox'
import { DISPLAY_NAME_KV_KEY, HANDLE_KV_KEY } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/profileKeys'
import { QRScanner } from '@bsv/expo-wallet-toolbox/ui'
import { showToast } from '../ui/Toast'
import { classifyImportInput, secretFromShares, type WalletSecret } from '@bsv/expo-wallet-toolbox/core/recovery/secret'
import { restoreWallet, type RestoreOutcome } from '@bsv/expo-wallet-toolbox/core/recovery/restoreWallet'
import {
  collectShare,
  emptyShareCollection,
  type ShareCollection
} from '@bsv/expo-wallet-toolbox/core/recovery/shareCollector'
import { SlicePuzzle } from '../art/SlicePuzzle'
import { setPref, usePrefs } from '../state/prefs'
import { font, radii, usePalette } from '../theme'
import { Avatar, type AvatarBg, type Portrait } from '../ui/Avatar'
import { BottomSheet } from '../ui/BottomSheet'
import { ConfettiBurst } from '../ui/Confetti'
import { GlassButton } from '../ui/GlassButton'
import { PressScale } from '../ui/PressScale'
import { enter, useReducedMotion } from '../ui/motion'
import { BalancedText } from '../ui/BalancedText'
import { TransferTimeline } from './TransferTimeline'

type Step = 'enter' | 'replace' | 'scan' | 'file' | 'restoring' | 'done'

/** What the pasted text looks like, before the core checks it properly. */
function looksLike(text: string): string | null {
  const t = text.trim()
  if (!t) return null
  if (/^[0-9a-fA-F]{64}$/.test(t)) return 'A private key'
  const words = t.split(/\s+/)
  if (words.length >= 12 && words.every(w => /^[a-zA-Z]+$/.test(w))) return `A ${words.length}-word phrase`
  return null
}

/** Tailwind's default transition curve. */
const EASE = cubicBezier(0.4, 0, 0.2, 1)

/**
 * What can come in (the prototype's KINDS), as far as the core takes it:
 * a phrase, a private key, or key slices (scanned). No backup file or Sync
 * key yet (decisions 2 and 6), and no other wallets' phrases.
 */
type Kind = 'w12' | 'w24' | 'key' | 'slices'
const KINDS: { id: Kind; label: string }[] = [
  { id: 'w12', label: '12-word phrase' },
  { id: 'w24', label: '24-word phrase' },
  { id: 'key', label: 'Private key' },
  { id: 'slices', label: 'Key slices' }
]

/**
 * What the empty field cycles through: what it takes, and an example of it,
 * in the same order as KINDS. Made up: they're only ever shown, never put
 * in the field, so one can't be imported by mistake.
 */
const WATERMARKS: { what: string; eg: string; by: 'word' | 'char' }[] = [
  { what: 'Paste your 12 words…', eg: 'canyon blossom arctic affair calm banner city birth august amateur bounce atom', by: 'word' },
  {
    what: '…or your 24 words…',
    eg: 'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across action actor actress actual adapt',
    by: 'word'
  },
  { what: '…or a private key…', eg: '4f3c9a1be27d8065c3f1a9e4b7d20c6e8a5f13b9d7e2c4a6f08b1d3e5c7a9f2b', by: 'char' },
  { what: '…or scan two key slices', eg: 'any two of your three QR codes', by: 'word' }
]

const unitsOf = (i: number) => (WATERMARKS[i].by === 'word' ? WATERMARKS[i].eg.split(' ') : [...WATERMARKS[i].eg])

/**
 * The prototype's useExampleCycle: each example typed in (word by word, or
 * character by character), held, erased the same way, then the next one.
 * `show` jumps to one, typed out in full.
 */
function useExampleCycle(active: boolean) {
  const [i, setI] = useState(0)
  const [shown, setShown] = useState(0)
  const [phase, setPhase] = useState<'type' | 'hold' | 'erase'>('type')
  const ex = WATERMARKS[i]
  const units = unitsOf(i)
  useEffect(() => {
    if (!active) return
    const t = setTimeout(
      () => {
        if (phase === 'type') {
          if (shown < units.length) setShown(shown + 1)
          else setPhase('hold')
        } else if (phase === 'hold') setPhase('erase')
        else if (shown > 0) setShown(shown - 1)
        else {
          setI((i + 1) % WATERMARKS.length)
          setPhase('type')
        }
      },
      phase === 'hold' ? 2600 : phase === 'type' ? (ex.by === 'word' ? 170 : 55) : shown === 0 ? 500 : ex.by === 'word' ? 60 : 18
    )
    return () => clearTimeout(t)
  }, [active, i, shown, phase, units.length, ex.by])
  const show = (n: number) => {
    setI(n)
    setShown(unitsOf(n).length)
    setPhase('hold')
  }
  return { i, what: ex.what, typed: units.slice(0, shown).join(ex.by === 'word' ? ' ' : ''), show }
}

/** Which kind the pasted text looks like, to light its icon. */
/**
 * On its way to being a private key: hex, no spaces, long past any word. It
 * goes masked from here (the prototype's key field), so a key being typed or
 * pasted isn't left on screen.
 */
const keyish = (text: string) => /^[0-9a-fA-F]{16,}$/.test(text.trim())

function kindOf(text: string): Kind | null {
  const t = text.trim()
  if (/^[0-9a-fA-F]{64}$/.test(t)) return 'key'
  const n = t.split(/\s+/).length
  if (looksLike(t)) return n === 12 ? 'w12' : 'w24'
  return null
}

export function ImportWalletSheet({
  open,
  onOpenChange,
  onDone
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onDone: () => void
}) {
  const palette = usePalette()
  const deps = useRecoveryDeps()
  const { hasStoredIdentity } = useLocalStorage()
  const { backupRestore, storage } = useWallet()
  const prefs = usePrefs()
  const still = useReducedMotion()
  const [step, setStep] = useState<Step>('enter')
  const [text, setText] = useState('')
  const [secret, setSecret] = useState<{ secret: WalletSecret; medium: 'phrase' | 'shares' } | null>(null)
  const [shares, setShares] = useState<ShareCollection>(emptyShareCollection)
  const [result, setResult] = useState<RestoreOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  // the restored wallet's handle and name, for "<name> is back"
  const [who, setWho] = useState<{ handle: string | null; name: string | null }>({ handle: null, name: null })
  // the confetti, a moment after the done screen is up
  const [burst, setBurst] = useState(false)

  useEffect(() => {
    if (!open) return
    setStep('enter')
    setText('')
    setSecret(null)
    setShares(emptyShareCollection)
    setResult(null)
    setError(null)
    setWho({ handle: null, name: null })
  }, [open])

  const hint = useMemo(() => looksLike(text), [text])
  const asKey = keyish(text)
  // a key shows as dots unless asked
  const [reveal, setReveal] = useState(false)
  const detected = useMemo(() => kindOf(text), [text])
  // one cycle drives the watermark and the wireframes; it stops once something's typed
  const example = useExampleCycle(open && step === 'enter' && text === '')

  useEffect(() => {
    if (step !== 'done') return
    const t = setTimeout(() => setBurst(true), 250)
    let alive = true
    void Promise.all([storage?.getKeyValue(HANDLE_KV_KEY).catch(() => undefined), storage?.getKeyValue(DISPLAY_NAME_KV_KEY).catch(() => undefined)]).then(
      ([handle, name]) => alive && setWho({ handle: handle ? handle.split('@')[0] : null, name: name ?? null })
    )
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [step, storage])

  /** A kind's icon or wireframe: slices open the scanner; the rest show their example. */
  const tryKind = (k: Kind) => {
    if (k === 'slices') {
      setStep('scan')
      return
    }
    // shown in the watermark only: a made-up example is never put in the field
    // (and what you've typed stays)
    if (!text) example.show(KINDS.findIndex(x => x.id === k))
  }

  const run = async (s: { secret: WalletSecret; medium: 'phrase' | 'shares' }) => {
    setResult(null)
    setBurst(false)
    setStep('restoring')
    const outcome = await restoreWallet(deps, s.secret, { restore: true, medium: s.medium })
    setResult(outcome)
    // a wallet back: the timeline finishes, then the done screen
    if (outcome.kind !== 'ok' && outcome.kind !== 'restore-failed') {
      setStep('enter')
      setError(
        outcome.kind === 'biometric-refused'
          ? 'Your phone didn’t allow the wallet to be saved. Try again and confirm it’s you.'
          : 'The wallet couldn’t be imported. Check what you entered and try again.'
      )
    }
  }

  // a wallet already here is only replaced once you say so
  const begin = async (s: { secret: WalletSecret; medium: 'phrase' | 'shares' }) => {
    setSecret(s)
    setError(null)
    const existing = await hasStoredIdentity().catch(() => true)
    if (existing) setStep('replace')
    else void run(s)
  }

  const fromText = () => {
    const s = classifyImportInput(text)
    if (!s) {
      setError(
        'That isn’t a recovery phrase or private key Bitcoin SV Wallet recognises. Check the words and their order.'
      )
      return
    }
    void begin({ secret: s, medium: 'phrase' })
  }

  const onScan = (raw: string) => {
    const { collection, event } = collectShare(shares, raw)
    setShares(collection)
    if (event.kind === 'invalid') showToast('That isn’t a key slice.', { type: 'error' })
    else if (event.kind === 'incompatible')
      showToast(
        event.issue === 'duplicate'
          ? 'You’ve scanned that slice already. Scan another one.'
          : 'That slice is from a different wallet.',
        {
          type: 'error'
        }
      )
    else if (event.kind === 'complete') {
      try {
        const { secret: s } = secretFromShares(event.shareStrings)
        void begin({ secret: s, medium: 'shares' })
      } catch {
        setStep('enter')
        setShares(emptyShareCollection)
        setError('Those slices don’t make a wallet together. Check they’re from the same set.')
      }
    }
  }

  if (open && step === 'scan') {
    const scanned = Array.from({ length: shares.shares.length }, (_, i) => i + 1)
    return (
      <QRScanner
        multiScan
        onScan={onScan}
        onClose={() => {
          setShares(emptyShareCollection)
          setStep('enter')
        }}
        hintText={
          shares.threshold
            ? `Slice ${shares.shares.length} of ${shares.threshold} scanned. Scan another.`
            : 'Scan the QR code on one of your key slices'
        }
        renderBottom={() => (
          <View style={styles.scanPuzzle}>
            <SlicePuzzle scanned={scanned} width={240} caption={false} />
          </View>
        )}
      />
    )
  }

  const history =
    result?.kind === 'ok'
      ? result.history === 'restored'
        ? result.verified
          ? 'Your payments and contacts came back from Sync.'
          : 'Your history came back from Sync, though its newest part couldn’t be checked. It will catch up.'
        : result.history === 'no-backup'
          ? 'There was no Sync history for this wallet, so it starts fresh. Your money is all there.'
          : 'Your money is all there. Its history will catch up.'
      : result?.kind === 'restore-failed'
        ? 'Your wallet is back, but its Sync history couldn’t be brought back right now. Your money is all there.'
        : ''

  return (
    <BottomSheet
      open={open}
      onOpenChange={o => step !== 'restoring' && onOpenChange(o)}
      title={step === 'done' ? 'Wallet imported' : 'Import wallet'}
      onBack={step === 'replace' || step === 'file' ? () => setStep('enter') : undefined}
      fullScreen
    >
      {step === 'enter' && (
        <>
          <View style={styles.head}>
            <Text style={[font(700), styles.h2, { color: palette.foreground }]}>Bring your wallet back</Text>
            <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
              Paste your recovery phrase or private key, or scan two of your three key slices.
            </BalancedText>
          </View>
          {/* the kinds, as icons: what you paste lights its own; the one the example shows stands out */}
          <View style={styles.kinds}>
            <Text style={[font(600), styles.xs, { color: palette.mutedForeground }]}>What do you have?</Text>
            <View accessibilityRole="radiogroup" accessibilityLabel="Kind of backup" style={styles.kindRow}>
              {KINDS.map((k, n) => {
                const on = detected === k.id
                const showing = !detected && text === '' && example.i === n
                return (
                  <Pressable
                    key={k.id}
                    onPress={() => tryKind(k.id)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={k.label}
                  >
                    <Animated.View
                      style={[
                        styles.kind,
                        {
                          backgroundColor: on ? palette.ink : palette.card,
                          boxShadow: on
                            ? `0 0 0 1px ${palette.ink}`
                            : showing
                              ? `0 0 0 1.5px ${palette.foreground}99`
                              : `0 0 0 1px ${palette.border}`
                        },
                        // transition-[color,background-color,box-shadow] duration-500
                        { transitionProperty: ['backgroundColor', 'boxShadow'], transitionDuration: 500, transitionTimingFunction: EASE }
                      ]}
                    >
                      {k.id === 'w12' || k.id === 'w24' ? (
                        <Animated.Text
                          style={[
                            font(800),
                            styles.kindText,
                            { color: on ? palette.inkForeground : palette.foreground },
                            { transitionProperty: 'color', transitionDuration: 500, transitionTimingFunction: EASE }
                          ]}
                        >
                          {k.id === 'w12' ? '12' : '24'}
                        </Animated.Text>
                      ) : k.id === 'key' ? (
                        <KeyRound size={18} color={on ? palette.inkForeground : palette.foreground} />
                      ) : (
                        <Puzzle size={18} color={palette.foreground} />
                      )}
                    </Animated.View>
                  </Pressable>
                )
              })}
            </View>
          </View>
          <View>
            {/* the outline is on a wrapper: Android draws no box shadow on a text field */}
            <View
              style={[styles.fieldBox, { backgroundColor: palette.card, boxShadow: `0 0 0 1px ${palette.border}` }]}
            >
              <TextInput
                value={text}
                onChangeText={t => {
                  setText(t)
                  setError(null)
                }}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                autoComplete="off"
                // no suggestions bar holding the key
                keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
                textContentType="none"
                // while empty, what it takes and an example, typed in and out
                placeholder={`${example.what}\n\nE.g. ${example.typed}`}
                placeholderTextColor={palette.mutedForeground}
                accessibilityLabel="Recovery phrase or private key"
                // a key: its characters drawn as dots over the field (one field
                // throughout: swapping to a masked one mid-typing loses keys)
                style={[font(400), styles.field, { color: asKey && !reveal ? 'transparent' : palette.foreground }]}
              />
              {asKey && !reveal && (
                <View pointerEvents="none" style={styles.dots}>
                  <Text style={[font(700), styles.dotsText, { color: palette.foreground }]} numberOfLines={3}>
                    {'•'.repeat(text.trim().length)}
                  </Text>
                </View>
              )}
              {asKey && (
                <Pressable
                  onPress={() => setReveal(r => !r)}
                  accessibilityRole="button"
                  accessibilityLabel={reveal ? 'Hide the key' : 'Show the key'}
                  hitSlop={8}
                  style={styles.eye}
                >
                  {reveal ? <EyeOff size={18} color={palette.mutedForeground} /> : <Eye size={18} color={palette.mutedForeground} />}
                </Pressable>
              )}
            </View>
            {hint ? (
              <Text style={[font(600), styles.xs, styles.hint, { color: palette.positive }]}>{hint}</Text>
            ) : (
              asKey && (
                <Text style={[font(500), styles.xs, styles.hint, { color: palette.mutedForeground }]}>Keep going… a private key is 64 characters</Text>
              )
            )}
          </View>
          {text === '' && <FieldLoop i={example.i} still={still} onTry={tryKind} />}
          {error && (
            <View style={[styles.error, { backgroundColor: palette.destructive + '14' }]}>
              <CircleAlert size={16} color={palette.destructive} />
              <Text style={[font(400), styles.small, styles.flex, { color: palette.foreground }]}>{error}</Text>
            </View>
          )}
          <View style={styles.footer}>
            {/* only once it's something the app can bring back */}
            <GlassButton size="lg" label="Continue" disabled={!hint} onPress={fromText} />
            <Pressable
              onPress={() => setStep('scan')}
              accessibilityRole="button"
              style={[styles.plain, { backgroundColor: palette.card, boxShadow: `0 0 0 1px ${palette.border}` }]}
            >
              <Puzzle size={16} color={palette.foreground} />
              <Text style={[font(600), styles.body15, { color: palette.foreground }]}>Scan key slices</Text>
            </Pressable>
            <Pressable onPress={() => setStep('file')} accessibilityRole="button" style={styles.link}>
              <Text style={[font(600), styles.small, { color: palette.mutedForeground }]}>I have a backup file</Text>
            </Pressable>
          </View>
        </>
      )}

      {/* decision 2: the backup file's restore is a placeholder until its format has a spec */}
      {step === 'file' && (
        <>
          <View style={styles.head}>
            <View style={[styles.emblem, { backgroundColor: palette.secondary }]}>
              <FileLock2 size={28} color={palette.foreground} />
            </View>
            <Text style={[font(700), styles.h2, { color: palette.foreground }]}>Backup files come later</Text>
            <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
              Bringing a wallet back from an encrypted backup file comes in a later update. Your recovery phrase or two of your key slices bring it
              back today, and Sync brings back its history.
            </BalancedText>
          </View>
          <View style={styles.footer}>
            <GlassButton size="lg" label="Use my phrase or slices" onPress={() => setStep('enter')} />
          </View>
        </>
      )}

      {step === 'replace' && secret && (
        <>
          <View style={styles.head}>
            <View style={[styles.emblem, { backgroundColor: palette.destructive + '1f' }]}>
              <CircleAlert size={28} color={palette.destructive} />
            </View>
            <BalancedText style={[font(700), styles.h2, { color: palette.foreground }]}>Replace the wallet on this phone?</BalancedText>
            <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
              This phone already has a wallet. Importing puts this one in its place. The wallet that’s here now can only
              come back with its own recovery phrase or slices, so make sure you have them before you go on.
            </BalancedText>
          </View>
          <View style={styles.footer}>
            <Pressable
              onPress={() => {
                // the wallets here go: so do their looks and any handle still to claim
                setPref('looks', {})
                setPref('stagedLook', null)
                setPref('pendingHandle', null)
                setPref('pendingDisplayName', null)
                setPref('pendingHandleProfile', 0)
                void run(secret)
              }}
              accessibilityRole="button"
              style={[styles.plain, { backgroundColor: palette.destructive }]}
            >
              <Text style={[font(600), styles.body15, { color: '#ffffff' }]}>Replace it</Text>
            </Pressable>
            <GlassButton
              size="lg"
              variant="outline"
              label="Keep the wallet that’s here"
              onPress={() => onOpenChange(false)}
            />
          </View>
        </>
      )}

      {step === 'restoring' && (
        <View style={styles.restoring}>
          <Text style={[font(700), styles.h2, { color: palette.foreground }]}>Restoring your wallet</Text>
          <TransferTimeline
            steps={[
              secret?.medium === 'shares'
                ? 'Joining your key slices'
                : secret?.secret.kind === 'mnemonic'
                  ? `Checking your ${secret.secret.mnemonic.trim().split(/\s+/).length} words`
                  : 'Checking your private key',
              'Finding your wallet',
              'Restoring balance and history',
              'Wallet ready'
            ]}
            // what's really done: the wallet is found once its history is looked for
            reached={
              result
                ? 4
                : backupRestore?.phase === 'checking' || backupRestore?.phase === 'restoring'
                  ? 2
                  : 1
            }
            onSettled={() => setStep('done')}
          />
          {backupRestore?.phase === 'restoring' && !!backupRestore.total && (
            <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
              {`History ${backupRestore.chunks ?? 0} of ${backupRestore.total}`}
            </Text>
          )}
        </View>
      )}

      {step === 'done' && (
        <>
          <View style={styles.restoring}>
            <View>
              {/* the wallet that's back, ringed in the background colour */}
              <View style={[styles.avatarRing, { boxShadow: `0 0 0 4px ${palette.background}` }]}>
                <Avatar
                  bg={(prefs.avatarBg as AvatarBg) ?? 'mint'}
                  portrait={(prefs.avatarPortrait as Portrait) ?? 'dragon'}
                  uri={prefs.avatarUri}
                  size={96}
                />
              </View>
              {burst && (
                <View pointerEvents="none" style={styles.burst}>
                  <ConfettiBurst />
                </View>
              )}
            </View>
            <View style={styles.doneCopy}>
              <BalancedText style={[font(700), styles.h2, { color: palette.foreground }]}>
                {`${who.name ?? (who.handle ? `@${who.handle}` : 'Your wallet')} is back`}
              </BalancedText>
              {who.handle && <Text style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>@{who.handle}</Text>}
              <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>{history}</BalancedText>
            </View>
          </View>
          <View style={styles.footer}>
            <GlassButton
              size="lg"
              label="Done"
              onPress={() => {
                onOpenChange(false)
                onDone()
              }}
            />
          </View>
        </>
      )}
    </BottomSheet>
  )
}

/** The wireframes' grid, w-64 with gap-1.5. */
const LOOP_W = 256
const cell = (cols: number) => (LOOP_W - 6 * (cols - 1)) / cols

/**
 * Under the empty field (the prototype's FieldLoop): a wireframe of each
 * kind it takes, one after another with the example above. Tapping one
 * shows its example in full (or, for slices, opens the scanner).
 */
function FieldLoop({ i, still, onTry }: { i: number; still: boolean; onTry: (k: Kind) => void }) {
  const palette = usePalette()
  const k = KINDS[i]
  const bar = { borderRadius: 999, backgroundColor: palette.mutedForeground + '33' }
  const bars = (count: number, cols: number, height: number) => (
    <View style={styles.loopGrid}>
      {Array.from({ length: count }, (_, n) => (
        <Animated.View key={n} style={[bar, { width: cell(cols), height }, still ? null : enter({ opacity: 0, delay: n * 30 })]} />
      ))}
    </View>
  )
  return (
    <View style={styles.loop}>
      <Text style={[font(600), styles.xs, { color: palette.mutedForeground }]}>{k.label} · tap to try</Text>
      <View style={styles.pills}>
        {KINDS.map((x, n) => (
          <Animated.View
            key={x.id}
            style={[
              styles.pill,
              { width: n === i ? 16 : 6, backgroundColor: n === i ? palette.foreground : palette.foreground + '40' },
              { transitionProperty: ['width', 'backgroundColor'], transitionDuration: 150, transitionTimingFunction: EASE }
            ]}
          />
        ))}
      </View>
      {/* animate-in fade-in zoom-in-95 duration-500, again for each kind */}
      <Animated.View key={k.id} style={still ? null : enter({ opacity: 0, scale: 0.95, duration: 500 })}>
        <PressScale
          scale={0.98}
          onPress={() => onTry(k.id)}
          accessibilityRole="button"
          accessibilityLabel={k.id === 'slices' ? 'Scan your key slices' : `Show an example ${k.label.toLowerCase()}`}
          style={styles.loopBox}
        >
          {k.id === 'w12' && bars(12, 3, 16)}
          {k.id === 'w24' && bars(24, 4, 12)}
          {k.id === 'key' && (
            <View style={[styles.loopKey, { boxShadow: `0 0 0 1px ${palette.border}` }]}>
              <KeyRound size={16} color={palette.mutedForeground} />
              <View style={[bar, styles.flex, { height: 12 }]} />
              <View style={styles.loopDots}>
                {[0, 1, 2, 3].map(d => (
                  <View key={d} style={[styles.loopDot, { backgroundColor: palette.mutedForeground + '66' }]} />
                ))}
              </View>
            </View>
          )}
          {k.id === 'slices' && (
            <View style={styles.loopSlices}>
              {[0, 1].map(r => (
                <View key={r} style={[styles.loopSlice, { boxShadow: `0 0 0 1px ${palette.border}` }]}>
                  {[0, 1, 2, 3, 4].map(g => (
                    <View key={g} style={[bar, { width: 32, height: 12 }]} />
                  ))}
                </View>
              ))}
            </View>
          )}
        </PressScale>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { alignItems: 'center', gap: 8, paddingTop: 8 },
  emblem: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  kinds: { alignItems: 'center', gap: 8 },
  kindRow: { flexDirection: 'row', gap: 8 },
  kind: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  kindText: { fontSize: 13, lineHeight: 16 },
  loop: { alignItems: 'center', gap: 12, paddingTop: 8 },
  pills: { flexDirection: 'row', gap: 6 },
  pill: { height: 6, borderRadius: 3 },
  loopBox: { width: LOOP_W, height: 128, borderRadius: radii['2xl'], alignItems: 'center', justifyContent: 'center' },
  loopGrid: { width: LOOP_W, flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  loopKey: { width: LOOP_W, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: radii['2xl'], paddingHorizontal: 12, paddingVertical: 12 },
  loopDots: { flexDirection: 'row', gap: 2 },
  loopDot: { width: 6, height: 6, borderRadius: 3 },
  loopSlices: { width: LOOP_W, gap: 8 },
  loopSlice: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: radii['2xl'], paddingVertical: 10 },
  avatarRing: { borderRadius: 999 },
  doneCopy: { alignSelf: 'stretch', alignItems: 'center', gap: 4 },
  h2: { alignSelf: 'stretch', textAlign: 'center', fontSize: 22, lineHeight: 30, letterSpacing: -0.5 },
  small: { fontSize: 14, lineHeight: 22 },
  xs: { fontSize: 12, lineHeight: 16 },
  body15: { fontSize: 15, lineHeight: 20 },
  center: { textAlign: 'center', alignSelf: 'stretch' },
  fieldBox: { borderRadius: 16 },
  field: { minHeight: 132, padding: 16, fontSize: 15, lineHeight: 22, textAlignVertical: 'top', textAlign: 'center' },
  hint: { paddingTop: 8, textAlign: 'center' },
  // the key's dots, where its characters would be; the eye in the corner
  dots: { ...StyleSheet.absoluteFill, padding: 16, paddingHorizontal: 44, alignItems: 'center' },
  dotsText: { fontSize: 15, lineHeight: 22, letterSpacing: 2, textAlign: 'center' },
  eye: { position: 'absolute', right: 6, bottom: 6, width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  error: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: 16, padding: 14 },
  footer: { marginTop: 'auto', paddingTop: 16, gap: 8 },
  plain: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 999
  },
  restoring: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24, paddingHorizontal: 8 },
  burst: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  scanPuzzle: { paddingTop: 16, alignItems: 'center' },
  link: { alignSelf: 'center', padding: 8 }
})
