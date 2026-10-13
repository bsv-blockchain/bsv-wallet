// Encrypt & sync (the prototype's components/backup-sheet.tsx, its syncChoose,
// syncProvider, password and syncConnect steps): a password manager or cloud
// storage, which one, a password to lock the backup, then connecting.
//
// Decision 2 keeps this UI while its format has no spec: the last step goes
// through saveEncryptedBackup below, which says it isn't available yet. So
// nothing is encrypted, uploaded or recorded as backed up, and the sheet says
// so plainly rather than pretending.
import React, { useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { TextInput } from '../ui/TextInput'
import Animated, { css, cubicBezier } from 'react-native-reanimated'
import { Check, ChevronRight, CloudUpload, Eye, EyeOff, Info } from 'lucide-react-native'
import { font, radii, useIsDark, usePalette } from '../theme'
import { BottomSheet } from '../ui/BottomSheet'
import { BsvMark } from '../ui/BsvMark'
import { Coin } from '../ui/Coin'
import { GlassButton } from '../ui/GlassButton'
import { BalancedText } from '../ui/BalancedText'
import { useReducedMotion } from '../ui/motion'
import { ServiceLogo } from './BackupExplainer'
import { servicesOf, type ServiceKind, type SyncService } from './syncServices'

/** @keyframes pulse — Tailwind's animate-pulse, on its own curve. */
const pulse = css.keyframes({
  '0%': { opacity: 1 },
  '50%': { opacity: 0.5 },
  '100%': { opacity: 1 }
})
const EASE_PULSE = cubicBezier(0.4, 0, 0.6, 1)

/** The placeholder save: no format or service integration exists yet (decision 2). */
export async function saveEncryptedBackup(_service: SyncService, _password: string): Promise<{ kind: 'unavailable' }> {
  return { kind: 'unavailable' }
}

/** The prototype's lib/recovery.ts passwordStrength: 0 empty, 1 too short … 4 strong. */
export function passwordStrength(pw: string): number {
  if (pw.length < 8) return pw.length ? 1 : 0
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length
  return Math.min(4, (pw.length >= 12 ? 2 : 1) + Math.max(0, kinds - 1))
}

const KIND_INFO: Record<ServiceKind, { title: string; description: string; parts: { h: string; p: string }[] }> = {
  pm: {
    title: 'What is a password manager?',
    description: 'A safe for all your passwords.',
    parts: [
      { h: 'One app, all your passwords', p: 'It remembers every password for you and fills them in, so you only need to remember one: the password that opens it.' },
      { h: 'Locked tight', p: 'Everything inside is locked before it leaves your phone. Even the company that makes it can’t look inside.' },
      { h: 'Why it’s good for your backup', p: 'Your backup sits next to your passwords, on every device you use. Get a new phone, sign in, and it’s there.' }
    ]
  },
  cloud: {
    title: 'What is cloud storage?',
    description: 'Your files, kept online.',
    parts: [
      { h: 'Files that follow you', p: 'It keeps your files on the internet instead of only on your phone, so they’re still there if your phone is lost or broken.' },
      { h: 'You probably have it already', p: 'iPhones come with iCloud Drive and Android phones with Google Drive. Dropbox works on both.' },
      { h: 'Why it’s good for your backup', p: 'We lock your backup with your password first, so the file in your drive is useless to anyone else. Only you can open it.' }
    ]
  }
}

type Step = { k: 'choose' } | { k: 'provider'; kind: ServiceKind } | { k: 'password' } | { k: 'connect' }

export function EncryptSyncSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const palette = usePalette()
  const dark = useIsDark()
  const still = useReducedMotion()
  const [step, setStep] = useState<Step>({ k: 'choose' })
  const [service, setService] = useState<SyncService | null>(null)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [kindInfo, setKindInfo] = useState<ServiceKind | null>(null)
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'unavailable'>('idle')
  useEffect(() => {
    if (!open) return
    setStep({ k: 'choose' })
    setService(null)
    setPw('')
    setPw2('')
    setShowPw(false)
    setPhase('idle')
  }, [open])

  const back =
    step.k === 'provider'
      ? () => setStep({ k: 'choose' })
      : step.k === 'password'
        ? () => setStep({ k: 'provider', kind: service?.kind ?? 'pm' })
        : step.k === 'connect' && phase !== 'connecting'
          ? () => {
              setPhase('idle')
              setStep({ k: 'password' })
            }
          : undefined
  const title =
    step.k === 'choose'
      ? 'Encrypt & sync'
      : step.k === 'provider'
        ? step.kind === 'pm'
          ? 'Password manager'
          : 'Cloud storage'
        : step.k === 'password'
          ? 'Protect the backup'
          : service
            ? `Connect ${service.name}`
            : 'Connect'
  const plainRow = [styles.choice, { backgroundColor: dark ? '#000000' : '#ffffff', boxShadow: `0 1px 2px rgba(0,0,0,0.05), 0 0 0 1px ${palette.border}` }]
  const strength = passwordStrength(pw)
  const ok = pw.length >= 8 && pw === pw2
  const field = [font(400), styles.field, { color: palette.foreground, backgroundColor: palette.card }]

  return (
    <BottomSheet open={open} onOpenChange={o => phase !== 'connecting' && onOpenChange(o)} title={title} onBack={back} fullScreen>
      {step.k === 'choose' && (
        <>
          <View style={styles.head}>
            <Coin size={60} icon={<CloudUpload size={50} color={palette.foreground} />} />
            <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
              We lock your backup with a password, then save it to an app you already use. They can’t read it. Only you can.
            </BalancedText>
          </View>
          <View style={styles.choices}>
            {(
              [
                { kind: 'pm', label: 'Password manager' },
                { kind: 'cloud', label: 'Cloud storage' }
              ] as const
            ).map(o => (
              <Pressable key={o.kind} onPress={() => setStep({ k: 'provider', kind: o.kind })} accessibilityRole="button" style={plainRow}>
                {/* the services it covers, overlapped like a facepile */}
                <View style={styles.pile}>
                  {servicesOf(o.kind).map((s, i) => (
                    <View key={s.id} style={[styles.pileItem, { marginLeft: i ? -10 : 0, boxShadow: `0 0 0 2px ${palette.background}` }]}>
                      <ServiceLogo service={s} size={34} />
                    </View>
                  ))}
                </View>
                <Text style={[font(600), styles.body15, styles.flex, { color: palette.foreground }]}>{o.label}</Text>
                <ChevronRight size={16} color={palette.mutedForeground} />
              </Pressable>
            ))}
          </View>
        </>
      )}

      {step.k === 'provider' && (
        <>
          <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
            {step.kind === 'pm' ? 'Saved as a secure note, next to your passwords.' : 'Saved as a small encrypted file in your drive.'}
          </BalancedText>
          <View style={styles.list}>
            {servicesOf(step.kind).map(s => (
              <Pressable
                key={s.id}
                onPress={() => {
                  setService(s)
                  setStep({ k: 'password' })
                }}
                accessibilityRole="button"
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: palette.secondary + '99' }]}
              >
                <ServiceLogo service={s} size={44} />
                <Text style={[font(600), styles.body15, styles.flex, { color: palette.foreground }]}>{s.name}</Text>
                <ChevronRight size={16} color={palette.mutedForeground} />
              </Pressable>
            ))}
          </View>
          <Pressable onPress={() => setKindInfo(step.kind)} accessibilityRole="button" style={styles.link}>
            <Text style={[font(600), styles.xs13, { color: palette.mutedForeground }]}>
              {step.kind === 'pm' ? 'What is a password manager?' : 'What is cloud storage?'}
            </Text>
          </Pressable>
        </>
      )}

      {step.k === 'password' && (
        <>
          <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
            {`Pick a password to lock your backup, so ${service?.name ?? 'they'} can’t read it. Don’t lose it: we can’t reset it.`}
          </BalancedText>
          <View style={styles.pwBox}>
            <View>
              <TextInput
                value={pw}
                onChangeText={setPw}
                secureTextEntry={!showPw}
                placeholder="Password"
                placeholderTextColor={palette.mutedForeground}
                autoComplete="new-password"
                textContentType="newPassword"
                autoCapitalize="none"
                accessibilityLabel="Password"
                style={[...field, { boxShadow: `0 0 0 1px ${palette.border}`, paddingRight: 48 }]}
              />
              <Pressable
                onPress={() => setShowPw(v => !v)}
                accessibilityRole="button"
                accessibilityLabel={showPw ? 'Hide password' : 'Show password'}
                style={styles.eye}
              >
                {showPw ? <EyeOff size={16} color={palette.mutedForeground} /> : <Eye size={16} color={palette.mutedForeground} />}
              </Pressable>
            </View>
            <View style={styles.meter} accessible={false}>
              {[1, 2, 3, 4].map(n => (
                <View
                  key={n}
                  style={[styles.bar, { backgroundColor: n <= strength ? (strength <= 1 ? palette.destructive : palette.gold) : palette.secondary }]}
                />
              ))}
            </View>
            <Text style={[font(400), styles.xs, styles.pad, { color: palette.mutedForeground }]}>
              {pw.length === 0 ? 'At least 8 characters. Longer is stronger.' : ['', 'Too short', 'Okay', 'Good', 'Strong'][strength]}
            </Text>
            <TextInput
              value={pw2}
              onChangeText={setPw2}
              secureTextEntry={!showPw}
              placeholder="Repeat password"
              placeholderTextColor={palette.mutedForeground}
              autoComplete="new-password"
              textContentType="newPassword"
              autoCapitalize="none"
              accessibilityLabel="Repeat password"
              style={[...field, { boxShadow: `0 0 0 1px ${palette.border}`, marginTop: 8 }]}
            />
            {pw2 !== '' && pw !== pw2 && (
              <Text style={[font(400), styles.xs, styles.pad, { color: palette.destructive }]}>The passwords don’t match.</Text>
            )}
          </View>
          <View style={styles.footer}>
            <GlassButton size="lg" label="Continue" disabled={!ok} onPress={() => setStep({ k: 'connect' })} />
          </View>
        </>
      )}

      {step.k === 'connect' && service && (
        <>
          <View style={styles.connectHead}>
            {/* this wallet, linking to the service */}
            <View style={styles.link3}>
              <View style={[styles.tile, { backgroundColor: palette.gold + '26' }]}>
                <BsvMark size={40} />
              </View>
              <View style={styles.dots}>
                {[0, 1, 2].map(d => (
                  // animate-pulse bg-foreground/70 while connecting, each 150ms after the last
                  <Animated.View
                    key={d}
                    style={[
                      styles.dot,
                      { backgroundColor: palette.foreground + (phase === 'connecting' ? 'b3' : '4d') },
                      phase === 'connecting' &&
                        !still && {
                          animationName: pulse,
                          animationDuration: 2000,
                          animationDelay: d * 150,
                          animationIterationCount: 'infinite',
                          animationTimingFunction: EASE_PULSE
                        }
                    ]}
                  />
                ))}
              </View>
              <View style={styles.tileLogo}>
                <ServiceLogo service={service} size={64} />
              </View>
            </View>
            <Text style={[font(700), styles.h2, { color: palette.foreground }]}>
              {phase === 'connecting' ? `Connecting to ${service.name}…` : phase === 'unavailable' ? 'Not available yet' : `Connect ${service.name}`}
            </Text>
            <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
              {phase === 'unavailable'
                ? `Saving to ${service.name} comes in a later update. Nothing was saved. Your phrase or key slices back this wallet up today.`
                : `You’ll approve access in ${service.name}. It opens in a moment.`}
            </BalancedText>
          </View>
          {phase !== 'unavailable' ? (
            <View style={styles.points}>
              {[`Bitcoin SV Wallet can only add and read its own backup in ${service.name}, nothing else.`, 'Your backup password never leaves this phone.'].map(t => (
                <View key={t} style={styles.point}>
                  <View style={[styles.check, { backgroundColor: palette.positive + '26' }]}>
                    <Check size={14} color={palette.positive} strokeWidth={3} />
                  </View>
                  <Text style={[font(400), styles.small, styles.flex, { color: palette.mutedForeground }]}>{t}</Text>
                </View>
              ))}
            </View>
          ) : (
            <View style={[styles.notice, { backgroundColor: palette.secondary + '80' }]}>
              <Info size={16} color={palette.mutedForeground} />
              <Text style={[font(400), styles.small, styles.flex, { color: palette.foreground }]}>
                Bitcoin SV Wallet Sync already keeps an encrypted copy of your payments and contacts for you.
              </Text>
            </View>
          )}
          <View style={styles.footer}>
            {phase === 'unavailable' ? (
              <GlassButton size="lg" label="Back up another way" onPress={() => onOpenChange(false)} />
            ) : (
              <GlassButton
                size="lg"
                label={phase === 'connecting' ? 'Connecting…' : `Connect ${service.name}`}
                loading={phase === 'connecting'}
                disabled={phase !== 'idle'}
                onPress={async () => {
                  setPhase('connecting')
                  const r = await saveEncryptedBackup(service, pw)
                  setPw('')
                  setPw2('')
                  setPhase(r.kind)
                }}
              />
            )}
          </View>
        </>
      )}

      {/* what each kind of service is, in plain words */}
      <BottomSheet
        open={kindInfo !== null}
        onOpenChange={o => !o && setKindInfo(null)}
        title={kindInfo ? KIND_INFO[kindInfo].title : ''}
        description={kindInfo ? KIND_INFO[kindInfo].description : undefined}
      >
        <View style={styles.infoParts}>
          {kindInfo &&
            KIND_INFO[kindInfo].parts.map(p => (
              <View key={p.h}>
                <Text style={[font(600), styles.small, { color: palette.foreground }]}>{p.h}</Text>
                <Text style={[font(400), styles.small, { color: palette.mutedForeground, paddingTop: 4 }]}>{p.p}</Text>
              </View>
            ))}
        </View>
      </BottomSheet>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', gap: 12, paddingTop: 16 },
  center: { textAlign: 'center', alignSelf: 'center', maxWidth: 320 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  xs13: { fontSize: 13, lineHeight: 18 },
  body15: { fontSize: 15, lineHeight: 20 },
  h2: { fontSize: 20, lineHeight: 28, letterSpacing: -0.5, textAlign: 'center' },
  flex: { flex: 1 },
  choices: { gap: 10 },
  choice: { height: 64, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 999, paddingLeft: 12, paddingRight: 20 },
  pile: { flexDirection: 'row' },
  pileItem: { borderRadius: 999 },
  list: { marginHorizontal: -8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii.xl, paddingHorizontal: 8, paddingVertical: 12 },
  link: { alignSelf: 'center', padding: 4 },
  pwBox: { gap: 8 },
  field: { height: 48, borderRadius: 999, paddingHorizontal: 20, fontSize: 15 },
  eye: { position: 'absolute', right: 8, top: 8, width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  meter: { flexDirection: 'row', gap: 4, paddingHorizontal: 8 },
  bar: { flex: 1, height: 4, borderRadius: 2 },
  pad: { paddingHorizontal: 8 },
  footer: { marginTop: 'auto', paddingTop: 16, gap: 8 },
  connectHead: { alignItems: 'center', gap: 12, paddingTop: 24 },
  link3: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 8 },
  tile: { width: 64, height: 64, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  tileLogo: { borderRadius: 16, overflow: 'hidden' },
  dots: { flexDirection: 'row', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  points: { gap: 12 },
  point: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  check: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: radii['2xl'], padding: 14 },
  infoParts: { gap: 16 }
})
