// Back up this wallet (the prototype's components/backup-sheet.tsx, scope
// "wallet"): confirm the risks, the briefing, the device check, reveal the
// 12 words with a hold, write them down four at a time, then check three of
// them. "Backed up" is recorded only once the check passes.
//
// The words come from the shared core (readBackupMaterial) after the device
// check, live only while this sheet is open, and are cleared when it closes.
// Until the hold reveals them, stand-in words sit blurred under the gate: the
// real ones are never drawn early.
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { css, cubicBezier } from 'react-native-reanimated'
import { BlurTargetView, BlurView } from 'expo-blur'
import * as Clipboard from 'expo-clipboard'
import { Check, CloudUpload, Copy, Printer, QrCode, EyeOff, Info, KeyRound, PenLine, Puzzle, ScanFace } from 'lucide-react-native'
import { useWallet } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../ui/Toast'
import type { BackupMaterial } from '@bsv/expo-wallet-toolbox/core/recovery/backupMaterial'
import { HANDLE_KV_KEY } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/profileKeys'
import { Mnemonic } from '@bsv/sdk'
import { BackupDoneArt } from '../art/BackupDoneArt'
import { SyncArt } from '../art/SyncArt'
import { SlicePuzzle } from '../art/SlicePuzzle'
import { setPref, usePrefs } from '../state/prefs'
import { SyncSheet, syncLine, useSyncStatus } from '../sync/SyncSheet'
import { useBackup, type BackupMedium } from '../state/useBackup'
import { useWalletList } from '../home/useWalletList'
import { DesignSheet, type PrintOptions } from '../print/DesignSheet'
import { noteData, printBackup } from '../print/printBackup'
import type { PrintDesignId } from '../print/document'
import { font, radii, useIsDark, usePalette } from '../theme'
import { Avatar, type AvatarBg, type Portrait } from '../ui/Avatar'
import { BottomSheet } from '../ui/BottomSheet'
import { Coin } from '../ui/Coin'
import { GlassButton } from '../ui/GlassButton'
import { useReducedMotion } from '../ui/motion'
import { BalancedText } from '../ui/BalancedText'
import { BackupExplainer, type WayKey } from './BackupExplainer'
import { EncryptSyncSheet } from './EncryptSync'
import { BriefingCard, RevealGate } from './BriefingCard'
import { BRIEF_LAST, type KeyKind } from './briefing'
import { ChoiceMark, Columns, KeepSafeHints, LargeWords, SpeakButton, Tick, Word, WritingMode, groupsOfFour } from './PhraseParts'
import { quizFor } from './quiz'

type Step =
  | { k: 'ack' }
  /** the briefing before a key is shown, a point per screen */
  | { k: 'brief'; i: number; to: KeyKind }
  | { k: 'reveal' }
  | { k: 'verify' }
  /** the key in three slices, printed as QR codes; any two bring it back */
  | { k: 'slices' }
  /** did all three print? */
  | { k: 'slicesPrinted' }
  | { k: 'done' }

/** What to know before the words appear: what to do, the risk, who can't help. */
const ACKS = [
  'Keep your backup where only you can reach it.',
  'Bitcoin SV Wallet can’t see or recover it for you.',
  'Keep it to yourself: it opens your wallet.'
]

/** Under the words: how to keep them safe while they're on screen. */
const KEEP_SAFE = [
  'Check nobody can see your screen, not even over your shoulder or on a camera behind you.',
  'Never type them into a website or app, or share them.',
  'No one from Bitcoin SV Wallet will ever ask for them.',
  'Don’t take a screenshot. Photos can be accidentally shared.',
  // the copy button stays (it's the existing app's), so say what copying means
  'Copied words sit on your clipboard, where other apps can read them. Paper is safer.'
]

/** A suggested home for each slice, so no one place holds two. */
const SLICE_PLACES = ['Paper, at home', 'A password manager', 'Someone you trust']

/** After the backup: where to keep it, and how to handle it. */
const SLICE_HINTS = [
  'Give one to someone you trust, and tell them what it’s for.',
  'Don’t keep a slice with your phone, or in your wallet or bag.',
  'Plain labels only: nothing that says "crypto" or "wallet".',
  'Check once a year that you can still find at least two.'
]

const STORE_HINTS = [
  'Keep the paper somewhere only you can reach, like a locked drawer or a safe.',
  'Don’t keep it with your phone, or in your wallet or bag.',
  'Write a second copy and keep it somewhere else, in case of fire or flood.',
  'Don’t label it "crypto" or "wallet". Plain paper gets less attention.',
  'Never type it into your phone or computer, not even into notes.',
  'Tell someone you trust where it is, but not what it says.'
]

/** Tailwind's default transition curve, cubic-bezier(0.4, 0, 0.2, 1). */
const EASE_STANDARD = cubicBezier(0.4, 0, 0.2, 1)
/** animate-pulse's curve, cubic-bezier(0.4, 0, 0.6, 1). */
const EASE_PULSE = cubicBezier(0.4, 0, 0.6, 1)

/** @keyframes pulse — Tailwind's animate-pulse. */
const pulse = css.keyframes({
  '0%': { opacity: 1 },
  '50%': { opacity: 0.5 },
  '100%': { opacity: 1 }
})

/** Twelve stand-in words for under the gate, so the real ones aren't drawn until revealed. */
function decoyWords(): string[] {
  const list = new Mnemonic().Wordlist.value
  return Array.from({ length: 12 }, () => list[Math.floor(Math.random() * list.length)])
}

export function BackupSheet({
  open,
  onOpenChange,
  devBrief
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** development builds only: open on this briefing screen */
  devBrief?: number
}) {
  const palette = usePalette()
  const dark = useIsDark()
  const still = useReducedMotion()
  const prefs = usePrefs()
  const { storage } = useWallet()
  const backup = useBackup()

  const [step, setStep] = useState<Step>({ k: 'ack' })
  const [ack, setAck] = useState(false)
  const [unlocking, setUnlocking] = useState(false)
  const [material, setMaterial] = useState<BackupMaterial | null>(null)
  // printing: which backup's design is being picked (src/print/DesignSheet.tsx)
  const [picking, setPicking] = useState<'seed' | 'slice' | null>(null)
  const wallets = useWalletList()
  const [revealed, setRevealed] = useState(false)
  // how far into the briefing someone has read (screens up to here don't make them wait again)
  const [briefSeen, setBriefSeen] = useState(-1)
  const [answers, setAnswers] = useState<Record<number, string>>({})
  const [writing, setWriting] = useState<number | null>(null)
  const [bigWords, setBigWords] = useState(false)
  const [saving, setSaving] = useState(false)
  // how this backup was made: the words, or the printed slices
  const [medium, setMedium] = useState<BackupMedium>('phrase')
  const [printing, setPrinting] = useState(false)
  const [printedAll, setPrintedAll] = useState(false)
  // "When would I use which?", open on one tab
  const [explain, setExplain] = useState<WayKey | null>(null)
  const [syncOpen, setSyncOpen] = useState(false)
  // Encrypt & sync: the prototype's steps, its save a placeholder (decision 2)
  const [encryptOpen, setEncryptOpen] = useState(false)
  const sync = useSyncStatus(open)
  const [handle, setHandle] = useState<string | null>(null)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // the word list, for the blur over it
  const blurTarget = useRef<View>(null)

  const words = useMemo(() => material?.mnemonic?.trim().split(/\s+/) ?? null, [material])
  // a wallet restored from a key has no words: its key, as hex, is what's written down
  const hexKey = material && !material.mnemonic ? material.text : null
  const decoys = useMemo(decoyWords, [material])
  // one quiz per reveal: a new one if they go back and look again
  const quiz = useMemo(() => (words && step.k === 'verify' ? quizFor(words) : []), [words, step.k])

  useEffect(() => {
    if (!open || !storage) return
    let alive = true
    storage
      .getKeyValue(HANDLE_KV_KEY)
      .then(v => alive && setHandle(v ?? null))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open, storage])

  useEffect(() => {
    if (open && resetTimer.current) clearTimeout(resetTimer.current)
  }, [open])

  useEffect(() => {
    if (__DEV__ && open && devBrief !== undefined && devBrief >= 0 && devBrief <= BRIEF_LAST) setStep({ k: 'brief', i: devBrief, to: 'phrase' })
  }, [open, devBrief])

  const reset = () => {
    setStep({ k: 'ack' })
    setAck(false)
    setMaterial(null)
    setRevealed(false)
    setBriefSeen(-1)
    setAnswers({})
    setWriting(null)
    setBigWords(false)
    setMedium('phrase')
    setPrintedAll(false)
  }
  const close = (next: boolean) => {
    onOpenChange(next)
    // after the slide-out; the secret goes with it
    if (!next) resetTimer.current = setTimeout(reset, 500)
  }
  const go = (s: Step) => {
    setRevealed(false)
    setAnswers({})
    setStep(s)
  }


  // the device check, then the words
  const unlock = async (to: KeyKind) => {
    setUnlocking(true)
    const r = await backup.unlock(to)
    setUnlocking(false)
    if (r.kind === 'ok') {
      setMaterial(r.material)
      setMedium(to === 'slices' ? 'shares' : 'phrase')
      go(to === 'slices' ? { k: 'slices' } : { k: 'reveal' })
    } else if (r.kind === 'cancelled') {
      showToast('Couldn’t confirm it’s you. Try again when you’re ready.', { type: 'info' })
    } else {
      showToast('Your wallet’s keys couldn’t be read. Unlock your wallet and try again.', { type: 'error' })
    }
  }

  const confirm = async () => {
    if (saving) return
    setSaving(true)
    const ok = await backup.markBackedUp(medium)
    setSaving(false)
    if (ok) go({ k: 'done' })
    else showToast('Your backup couldn’t be recorded. Check your connection and try again.', { type: 'error' })
  }

  /** The design is picked first; then the pages print. */
  const print = () => setPicking('slice')
  const printIn = async (design: PrintDesignId, { labels }: PrintOptions) => {
    const kind = picking
    if (!material || printing || !kind) return
    setPrinting(true)
    const r = await printBackup({ kind, design, material, labels, wallets: wallets.map(w => ({ index: w.index, name: w.name })) })
    setPrinting(false)
    if (r === 'printed') {
      setPicking(null)
      // Android reports success as soon as its print dialog opens, so the
      // person says whether all three pages actually came out
      if (kind === 'slice') {
        setPrintedAll(false)
        go({ k: 'slicesPrinted' })
      }
    } else if (r === 'cancelled') {
      showToast('Printing was cancelled. Nothing was saved.', { type: 'info' })
    } else if (r === 'unsupported') {
      showToast('This wallet’s 24-word phrase can’t be split into slices. Back it up with the phrase instead.', { type: 'error' })
    } else {
      showToast('Your wallet’s keys couldn’t be read. Unlock your wallet and try again.', { type: 'error' })
    }
  }

  const copy = async () => {
    if (!material) return
    const done = await Clipboard.setStringAsync(material.text).catch(() => false)
    if (done) showToast('Copied', { type: 'success' })
  }

  const back =
    step.k === 'brief'
      ? () => go(step.i === 0 ? { k: 'ack' } : { k: 'brief', i: step.i - 1, to: step.to })
      : step.k === 'reveal'
        ? () => go({ k: 'brief', i: BRIEF_LAST, to: 'phrase' })
        : step.k === 'verify'
          ? () => go({ k: 'reveal' })
          : step.k === 'slices'
            ? () => go({ k: 'brief', i: BRIEF_LAST, to: 'slices' })
            : step.k === 'slicesPrinted'
              ? () => go({ k: 'slices' })
              : undefined

  const title = {
    ack: 'Before you start',
    brief: step.k === 'brief' && step.to === 'slices' ? 'Key slices' : 'Recovery phrase',
    reveal: 'Your recovery phrase',
    verify: 'Check your backup',
    slices: 'Your key slices',
    slicesPrinted: 'Check your slices',
    done: 'Backup'
  }[step.k]

  const plain = [
    styles.plain,
    { backgroundColor: dark ? '#000000' : '#ffffff', boxShadow: `0 1px 2px rgba(0,0,0,0.05), 0 0 0 1px ${palette.border}` }
  ]

  return (
    <BottomSheet open={open} onOpenChange={close} title={title} onBack={unlocking ? undefined : back} fullScreen>
      {/* ── 1: what to know first, and the ways to back up ── */}
      {step.k === 'ack' && (
        <>
          <View style={styles.ackHead}>
            {/* the same extruded token as a transaction's icon */}
            <Coin size={60} icon={<KeyRound size={50} color={palette.foreground} />} />
            <Text style={[font(700), styles.h2, { color: palette.foreground }]}>Four ways to back up</Text>
            <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>Any one brings this wallet back on a new phone.</Text>
            <View style={styles.ways}>
              {(
                [
                  { k: 'sync', icon: CloudUpload, label: 'Encrypt & sync' },
                  { k: 'seed', icon: KeyRound, label: 'Phrase' },
                  { k: 'slices', icon: Puzzle, label: 'Slices' }
                ] as const
              ).map(({ k, icon: Icon, label }) => (
                // small tinted links, not buttons: each opens its explainer tab
                <Pressable
                  key={label}
                  onPress={() => setExplain(k)}
                  accessibilityRole="button"
                  accessibilityLabel={`What is ${label.toLowerCase()}?`}
                  style={({ pressed }) => [styles.way, { backgroundColor: palette.gold + (pressed ? '40' : '26') }]}
                >
                  <Icon size={14} color={palette.goldDeep} />
                  <Text style={[font(600), styles.wayText, { color: palette.goldDeep }]}>{label}</Text>
                  <Info size={12} color={palette.goldDeep} style={{ opacity: 0.6 }} />
                </Pressable>
              ))}
            </View>
          </View>

          {/* read the tips, then confirm: one block */}
          <View style={[styles.ackBlock, { backgroundColor: palette.secondary + '80' }]}>
            <KeepSafeHints label="Before you start" hints={ACKS} />
            <Pressable
              onPress={() => setAck(v => !v)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: ack }}
              style={[styles.ackTick, { borderTopColor: palette.border }]}
            >
              <Tick on={ack} />
              <Text style={[font(600), styles.small, { color: palette.foreground }]}>Got it, I’ll keep my backup safe</Text>
            </Pressable>
          </View>

          <View style={styles.footer}>
            {/* recommended: Bitcoin SV Wallet Sync, which keeps every wallet and its history */}
            <Pressable
              onPress={() => setSyncOpen(true)}
              accessibilityRole="button"
              style={[styles.syncCard, { backgroundColor: palette.gold + '26', boxShadow: `0 0 0 1px ${palette.gold}66` }]}
            >
              <SyncArt size={44} />
              <View style={styles.flex}>
                <View style={styles.syncTitle}>
                  <Text style={[font(600), styles.body15, { color: palette.foreground }]}>Bitcoin SV Wallet Sync</Text>
                  <View style={[styles.recommended, { backgroundColor: palette.ink }]}>
                    <Text style={[font(700), styles.recommendedText, { color: palette.inkForeground }]}>Recommended</Text>
                  </View>
                </View>
                <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
                  {sync.on ? syncLine(sync.status) : 'Every payment and contact, back with your phrase or slices'}
                </Text>
              </View>
            </Pressable>
            <GlassButton
              size="lg"
              variant="outline"
              label="Encrypt & sync"
              icon={<CloudUpload size={18} color={palette.foreground} />}
              disabled={!ack}
              onPress={() => setEncryptOpen(true)}
            />
            <Pressable onPress={() => go({ k: 'brief', i: 0, to: 'phrase' })} accessibilityRole="button" style={plain}>
              <KeyRound size={16} color={palette.foreground} />
              <Text style={[font(600), styles.body15, { color: palette.foreground }]}>Show my phrase</Text>
            </Pressable>
            <Pressable onPress={() => go({ k: 'brief', i: 0, to: 'slices' })} accessibilityRole="button" style={plain}>
              <Puzzle size={16} color={palette.foreground} />
              <Text style={[font(600), styles.body15, { color: palette.foreground }]}>Show my slices</Text>
            </Pressable>
          </View>
        </>
      )}

      {/* ── 2: the briefing, a point per screen, then the device check ── */}
      {step.k === 'brief' &&
        (unlocking ? (
          <View style={styles.unlocking} accessibilityRole="progressbar" accessibilityLabel="Confirming it’s you">
            <Animated.View
              style={
                still
                  ? null
                  : { animationName: pulse, animationDuration: 2000, animationIterationCount: 'infinite', animationTimingFunction: EASE_PULSE }
              }
            >
              <ScanFace size={48} color={palette.foreground} strokeWidth={1.5} />
            </Animated.View>
            <Text style={[font(400), styles.small, { color: palette.mutedForeground }]}>Confirming it’s you…</Text>
          </View>
        ) : (
          <BriefingCard
            kind={step.to}
            i={step.i}
            // read through once (ever, or this time): no waiting again
            seen={prefs.briefingRead || step.i <= briefSeen}
            onNext={() => {
              setBriefSeen(n => Math.max(n, step.i))
              if (step.i < BRIEF_LAST) go({ k: 'brief', i: step.i + 1, to: step.to })
              else {
                if (!prefs.briefingRead) setPref('briefingRead', true)
                void unlock(step.to)
              }
            }}
          />
        ))}

      {/* ── 3: the words ── */}
      {step.k === 'reveal' && (
        <>
          <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
            {hexKey
              ? 'This wallet was restored from a key, so its key is what you write down. Copy it carefully, four characters at a time.'
              : 'Write them down four at a time. Tap the words to see them large.'}
          </BalancedText>
          <View>
            {/* the whole list is one control: any tap opens all twelve in large type */}
            <Pressable
              disabled={!revealed || !words}
              onPress={() => setBigWords(true)}
              accessibilityRole="button"
              accessibilityLabel="Show all words large"
              accessibilityElementsHidden={!revealed}
              importantForAccessibility={revealed ? 'auto' : 'no-hide-descendants'}
            >
              {({ pressed }) => (
                // what the blur covers (Android blurs a target view, not what's behind)
                <BlurTargetView ref={blurTarget}>
                  {hexKey ? (
                    <HexKey hex={hexKey} hidden={!revealed} />
                  ) : (
                    <View style={styles.groups}>
                      {/* stand-ins until the hold: the real words are swapped in on reveal */}
                      {groupsOfFour(revealed && words ? words : decoys).map((g, gi) => (
                        <Columns
                          key={gi}
                          items={g}
                          gap={12}
                          rowGap={8}
                          render={(w, wi) => (
                            <View
                              style={[
                                styles.wordItem,
                                { borderColor: palette.border },
                                pressed && revealed && { backgroundColor: palette.secondary }
                              ]}
                            >
                              <View style={[styles.wordNum, { backgroundColor: palette.secondary }]}>
                                <Text style={[font(700), styles.wordNumText, { color: palette.mutedForeground }]}>{gi * 4 + wi + 1}</Text>
                              </View>
                              <View style={styles.flex}>
                                <Word w={w} size={15} color={palette.foreground} />
                              </View>
                              <SpeakButton word={w} disabled={!revealed} />
                            </View>
                          )}
                        />
                      ))}
                    </View>
                  )}
                </BlurTargetView>
              )}
            </Pressable>
            {/* blur-md over the whole list (chips, borders, speakers), easing away
                once revealed: transition-[filter] duration-300 */}
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                styles.listBlur,
                { opacity: revealed ? 0 : 1, transitionProperty: 'opacity', transitionDuration: still ? 0 : 300, transitionTimingFunction: EASE_STANDARD }
              ]}
            >
              <BlurView
                intensity={40}
                tint={dark ? 'dark' : 'light'}
                blurTarget={blurTarget}
                blurMethod="dimezisBlurViewSdk31Plus"
                style={StyleSheet.absoluteFill}
              />
            </Animated.View>
            {!revealed && <RevealGate kind="phrase" blurTarget={blurTarget} onReveal={() => setRevealed(true)} />}
          </View>
          {/* Print works hidden or shown: it never puts the words on screen */}
          {(revealed || words) && (
            <View style={styles.revealActions}>
              {revealed && (
                <>
                  <Pressable onPress={() => setRevealed(false)} accessibilityRole="button" style={styles.quiet}>
                    <EyeOff size={16} color={palette.mutedForeground} />
                    <Text style={[font(600), styles.quietText, { color: palette.mutedForeground }]}>Hide again</Text>
                  </Pressable>
                  <Pressable onPress={copy} accessibilityRole="button" accessibilityLabel="Copy recovery phrase" style={styles.quiet}>
                    <Copy size={16} color={palette.mutedForeground} />
                    <Text style={[font(600), styles.quietText, { color: palette.mutedForeground }]}>Copy</Text>
                  </Pressable>
                </>
              )}
              {words && (
                <Pressable onPress={() => setPicking('seed')} accessibilityRole="button" accessibilityLabel="Print recovery phrase" style={styles.quiet}>
                  <Printer size={16} color={palette.mutedForeground} />
                  <Text style={[font(600), styles.quietText, { color: palette.mutedForeground }]}>Print</Text>
                </Pressable>
              )}
            </View>
          )}
          <KeepSafeHints label="Keeping it safe" hints={KEEP_SAFE} />
          <View style={styles.footer}>
            {hexKey ? (
              <GlassButton size="lg" label="I’ve written it down" disabled={!revealed || saving} onPress={confirm} />
            ) : (
              // every word is shown, four at a time, before the check
              <GlassButton
                size="lg"
                label="Write them down, 4 at a time"
                icon={<PenLine size={18} color={palette.goldForeground} />}
                onPress={() => setWriting(0)}
              />
            )}
          </View>
        </>
      )}

      {/* ── 4: three words, to prove the paper is right ── */}
      {step.k === 'verify' && words && (
        <>
          <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
            Pick the right words to prove you securely saved your phrase.
          </BalancedText>
          <View style={styles.quiz}>
            {quiz.map(q => {
              const pick = answers[q.index]
              const wrong = pick !== undefined && pick !== words[q.index]
              return (
                <View key={q.index} style={styles.question}>
                  <Text style={[font(600), styles.small, styles.center, { color: palette.foreground }]}>Word #{q.index + 1}</Text>
                  <View style={styles.options}>
                    {q.options.map(o => {
                      const chosen = pick === o
                      const right = o === words[q.index]
                      return (
                        <Pressable
                          key={o}
                          onPress={() => setAnswers(a => ({ ...a, [q.index]: o }))}
                          // development builds only: lets the end-to-end tests pick the right word
                          testID={__DEV__ ? `quiz-${q.index}-${right ? 'right' : 'wrong'}` : undefined}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: chosen }}
                          style={[
                            styles.option,
                            chosen
                              ? right
                                ? { backgroundColor: palette.ink, boxShadow: `0 0 0 1px ${palette.ink}` }
                                : { backgroundColor: palette.destructive + '1a', boxShadow: `0 0 0 1px ${palette.destructive}` }
                              : { boxShadow: `0 0 0 1px ${palette.border}` }
                          ]}
                        >
                          <ChoiceMark state={!chosen ? 'off' : right ? 'right' : 'wrong'} />
                          <Text
                            numberOfLines={1}
                            adjustsFontSizeToFit
                            style={[
                              font(600),
                              styles.optionText,
                              { color: chosen ? (right ? palette.inkForeground : palette.destructive) : palette.foreground }
                            ]}
                          >
                            {o}
                          </Text>
                        </Pressable>
                      )
                    })}
                  </View>
                  {wrong && (
                    <BalancedText style={[font(400), styles.xs, styles.center, { color: palette.destructive }]}>
                      That’s not word #{q.index + 1}. Check your paper.
                    </BalancedText>
                  )}
                </View>
              )
            })}
          </View>
          <View style={styles.footer}>
            <GlassButton
              size="lg"
              label={saving ? 'Saving…' : 'Confirm backup'}
              disabled={saving || !quiz.length || !quiz.every(q => answers[q.index] === words[q.index])}
              onPress={confirm}
            />
          </View>
        </>
      )}

      {/* ── 3b: the key in three slices, printed; any two bring it back ── */}
      {step.k === 'slices' && (
        <>
          <Text style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
            Your key, split in three. Any two bring this wallet back.{'\n'}Each slice prints as a QR code on its own page.
          </Text>
          <SlicePuzzle scanned={[1, 2, 3]} width={288} caption={false} />
          <View style={styles.sliceList}>
            {SLICE_PLACES.map((place, n) => (
              <View key={place} style={[styles.slice, { borderColor: palette.border }]}>
                <View style={[styles.sliceIcon, { backgroundColor: palette.secondary }]}>
                  <QrCode size={20} color={palette.foreground} />
                </View>
                <View style={styles.flex}>
                  <Text style={[font(600), styles.small, { color: palette.foreground }]}>Slice {n + 1} of 3</Text>
                  <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>Keep this one: {place}</Text>
                </View>
              </View>
            ))}
          </View>
          <KeepSafeHints label="Keeping them safe" hints={SLICE_HINTS} />
          <View style={styles.footer}>
            <GlassButton
              size="lg"
              label="Print my 3 slices"
              icon={<Printer size={18} color={palette.goldForeground} />}
              onPress={print}
            />
          </View>
        </>
      )}

      {/* ── 3c: did all three print? ── */}
      {step.k === 'slicesPrinted' && (
        <>
          <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
            Check the pages before you go on: three slices, each with its QR code. Scanning any two brings this wallet back.
          </BalancedText>
          <SlicePuzzle scanned={[1, 3]} width={288} />
          <Pressable
            onPress={() => setPrintedAll(v => !v)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: printedAll }}
            style={[styles.printedTick, { backgroundColor: palette.secondary + '80' }]}
          >
            <Tick on={printedAll} />
            <Text style={[font(600), styles.small, styles.flex, { color: palette.foreground }]}>
              All 3 slices printed. I’ll keep them in different places.
            </Text>
          </Pressable>
          <View style={styles.footer}>
            <GlassButton size="lg" label={saving ? 'Saving…' : 'Confirm backup'} disabled={!printedAll || saving} onPress={confirm} />
            <Pressable onPress={print} disabled={printing} accessibilityRole="button" style={plain}>
              <Printer size={16} color={palette.foreground} />
              <Text style={[font(600), styles.body15, { color: palette.foreground }]}>Print again</Text>
            </Pressable>
          </View>
        </>
      )}

      {/* ── 5: backed up ── */}
      {step.k === 'done' && (
        <>
          <View style={styles.done}>
            <BackupDoneArt
              wallets={[
                {
                  key: 'me',
                  portrait: (prefs.avatarPortrait as Portrait) ?? 'dragon',
                  bg: (prefs.avatarBg as AvatarBg) ?? 'mint',
                  uri: prefs.avatarUri
                }
              ]}
            />
            <View style={styles.doneCopy}>
              <Text style={[font(700), styles.h2, { color: palette.foreground }]}>Wallet backed up</Text>
              <BalancedText style={[font(400), styles.small, styles.center, styles.narrow, { color: palette.mutedForeground }]}>
                {medium === 'shares'
                  ? 'Keep each slice in a different place. Any two bring the wallet back.'
                  : 'Keep your paper somewhere safe. You can see the words again here any time.'}
              </BalancedText>
            </View>
            <View style={styles.doneRow}>
              <Avatar
                portrait={(prefs.avatarPortrait as Portrait) ?? 'dragon'}
                bg={(prefs.avatarBg as AvatarBg) ?? 'mint'}
                uri={prefs.avatarUri}
                size={32}
              />
              <Text numberOfLines={1} style={[font(500), styles.small, styles.flex, { color: palette.foreground }]}>
                {handle ?? (prefs.pendingHandle ? `@${prefs.pendingHandle}` : 'This wallet')}
              </Text>
              <CheckMark />
            </View>
            <KeepSafeHints key={medium} label="Where to keep it" hints={medium === 'shares' ? SLICE_HINTS : STORE_HINTS} />
          </View>
          <View style={styles.footer}>
            <GlassButton size="lg" label="Done" onPress={() => close(false)} />
          </View>
        </>
      )}

      {/* inside the sheet, so they sit over it */}
      <DesignSheet
        open={picking !== null}
        onOpenChange={o => !o && setPicking(null)}
        kind={picking ?? 'slice'}
        printing={printing}
        onPrint={printIn}
        makeLabelData={async labels => {
          if (!material || !picking) return null
          const made = await noteData(picking, material, wallets.map(w => ({ index: w.index, name: w.name })))
          if (made === 'unsupported') {
            showToast('This wallet’s 24-word phrase can’t be split into slices. Back it up with the phrase instead.', { type: 'error' })
            return null
          }
          return made ? { ...made.data, labels: labels?.some(l => l.trim()) ? labels : undefined } : null
        }}
      />
      <BackupExplainer tab={explain} onClose={() => setExplain(null)} />
      <SyncSheet open={syncOpen} onOpenChange={setSyncOpen} />
      <EncryptSyncSheet open={encryptOpen} onOpenChange={setEncryptOpen} />
      {bigWords && words && revealed && <LargeWords words={words} onClose={() => setBigWords(false)} />}
      {writing !== null && words && step.k === 'reveal' && (
        <WritingMode
          words={words}
          group={writing}
          onGroup={setWriting}
          onClose={() => setWriting(null)}
          // all twelve written: straight on to checking them
          onDone={() => {
            setWriting(null)
            go({ k: 'verify' })
          }}
        />
      )}
    </BottomSheet>
  )
}

/**
 * blur-md over a word: a soft smudge its length. Drawn as a halo, not as
 * blurred text, so it looks the same on both platforms (Android can't blur
 * text) and nothing legible is ever under the gate.
 */
function BlurredWord({ length }: { length: number }) {
  const palette = usePalette()
  return (
    <View
      style={[
        styles.blurred,
        { width: length * 8.5, backgroundColor: palette.foreground + '1f', boxShadow: `0 0 8px 4px ${palette.foreground}1f` }
      ]}
    />
  )
}

function CheckMark() {
  const palette = usePalette()
  return <Check size={16} color={palette.positive} />
}

/** A restored key, 64 hex characters, in sixteen numbered groups of four. */
function HexKey({ hex, hidden }: { hex: string; hidden: boolean }) {
  const palette = usePalette()
  const groups = hex.match(/.{1,4}/g) ?? []
  return (
    <View style={styles.hex}>
      {groups.map((g, i) => (
        <View key={i} style={[styles.hexItem, { borderColor: palette.border }]}>
          <Text style={[font(700), styles.wordNumText, { color: palette.mutedForeground }]}>{i + 1}</Text>
          {hidden ? (
            <BlurredWord length={4} />
          ) : (
            <Text style={[font(800), styles.hexText, { color: palette.foreground }]}>{g}</Text>
          )}
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  center: { textAlign: 'center' },
  narrow: { maxWidth: 320, alignSelf: 'center' },
  h2: { paddingTop: 4, textAlign: 'center', fontSize: 20, lineHeight: 28, letterSpacing: -0.5 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  body15: { fontSize: 15, lineHeight: 20 },
  footer: { marginTop: 'auto', paddingTop: 16, gap: 8 },
  ackHead: { alignItems: 'center', gap: 8, paddingTop: 8 },
  ways: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 6, paddingTop: 8 },
  way: { height: 28, flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 12 },
  wayText: { fontSize: 13, lineHeight: 18 },
  ackBlock: { borderRadius: radii['2xl'], paddingHorizontal: 12, paddingTop: 16 },
  ackTick: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 14
  },
  syncCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii['2xl'], padding: 12 },
  syncTitle: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  recommended: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  recommendedText: { fontSize: 10, lineHeight: 14 },
  plain: { height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 999 },
  unlocking: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  groups: { gap: 20 },
  listBlur: { borderRadius: 12, overflow: 'hidden' },
  wordItem: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, paddingVertical: 8, paddingLeft: 8, paddingRight: 4 },
  wordNum: { height: 20, width: 24, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  wordNumText: { fontSize: 11, lineHeight: 14, fontVariant: ['tabular-nums'] },
  blurred: { height: 12, marginVertical: 4, borderRadius: 6 },
  revealActions: { marginTop: -8, flexDirection: 'row', justifyContent: 'center', gap: 4 },
  quiet: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  quietText: { fontSize: 13, lineHeight: 18 },
  quiz: { gap: 20 },
  sliceList: { gap: 8 },
  slice: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: radii['2xl'], paddingHorizontal: 16, paddingVertical: 12 },
  sliceIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  printedTick: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: radii['2xl'], padding: 16 },
  question: { gap: 8 },
  options: { flexDirection: 'row', gap: 8 },
  option: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 999,
    paddingVertical: 10,
    paddingLeft: 8,
    paddingRight: 12
  },
  optionText: { flexShrink: 1, fontSize: 14, lineHeight: 20 },
  done: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  doneCopy: { alignItems: 'center' },
  doneRow: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 8, paddingVertical: 8 },
  hex: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hexItem: { width: '22.5%', flexGrow: 1, alignItems: 'center', gap: 2, borderWidth: 1, borderRadius: 12, paddingVertical: 8 },
  hexText: { fontSize: 17, lineHeight: 22, letterSpacing: 1 }
})
