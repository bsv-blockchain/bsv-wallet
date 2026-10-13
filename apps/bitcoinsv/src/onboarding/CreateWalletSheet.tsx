// The prototype's CreateWalletSheet (components/wallet-switcher.tsx), used
// here to create this installation's first wallet: a free generated handle
// (<adjective><animal><2 digits>, rerollable twice) or your own, paid monthly
// by length; an image; Create wallet. Clearing the field goes back to the
// generated handle. The registry is asked whether a handle is free.
import React, { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { Check, Dices } from 'lucide-react-native'
import { font, radii, usePalette } from '../theme'
import { BottomSheet } from '../ui/BottomSheet'
import { GlassButton } from '../ui/GlassButton'
import { Spinner } from '../ui/Spinner'
import { useFocusRing } from '../ui/focusRing'
import { enter, useReducedMotion } from '../ui/motion'
import { randomAvatarBg, type Portrait } from '../ui/Avatar'
import { generateHandle, generatedName, type GeneratedHandle } from '../handles/generator'
import { checkHandle, cleanHandleInput, formatPrice, suggestFor } from '../handles/rules'
import { AvatarPicker, type AvatarChoice } from './AvatarPicker'

const REROLLS = 2

/** A portrait for a generated animal, when we have one. */
const PORTRAITS: Portrait[] = ['dragon', 'phoenix', 'whale', 'swan', 'frog', 'unicorn', 'gorilla', 'beaver', 'bull']
const portraitFor = (animal: string): Portrait | null => (PORTRAITS as string[]).includes(animal) ? (animal as Portrait) : null

type Availability = 'idle' | 'checking' | 'available' | 'taken' | 'failed'

const UNAVAILABLE: Record<string, string> = {
  taken: 'Already taken',
  too_similar: 'Too close to a handle someone has',
  reserved: 'That handle is reserved',
  invalid: "That handle isn't allowed",
  cooldown: 'Recently released; try again later'
}

export function CreateWalletSheet({
  open,
  onOpenChange,
  domain,
  checkAvailability,
  onCreate,
  onCustom,
  busy
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** the registry's domain, shown after the handle */
  domain: string | null
  checkAvailability: (handle: string) => Promise<{ kind: string; reason?: string } | null>
  /** a free handle: create the wallet now */
  onCreate: (choice: { handle: string; displayName: string; avatar: AvatarChoice; generated: GeneratedHandle }) => void
  /** your own handle: on to paying for it */
  onCustom: (choice: { handle: string; monthly: number; yearly: number; avatar: AvatarChoice; generated: GeneratedHandle }) => void
  busy: boolean
}) {
  const palette = usePalette()
  const still = useReducedMotion()
  const [gen, setGen] = useState<GeneratedHandle>(() => generateHandle())
  const [rollsLeft, setRollsLeft] = useState(REROLLS)
  const [text, setText] = useState(gen.handle)
  const [avatar, setAvatar] = useState<AvatarChoice>(() => ({ portrait: portraitFor(gen.animal) ?? 'dragon', bg: randomAvatarBg(), uri: null }))
  // an avatar you picked yourself stays put when you reroll
  const [avatarPicked, setAvatarPicked] = useState(false)
  const [availability, setAvailability] = useState<{ handle: string; state: Availability; reason?: string; suggestion?: string }>({
    handle: '',
    state: 'idle'
  })
  // focus-within:border-ring ring-3 ring-ring/50, over the field's own 1px border
  const focusRing = useFocusRing(palette)

  // an empty field means the generated handle
  const handle = text.trim() || gen.handle
  const check = checkHandle(handle, { generated: gen.handle })

  // ask the registry, after a short pause in typing
  const asked = useRef(0)
  useEffect(() => {
    if (!check.ok) return
    const n = ++asked.current
    setAvailability({ handle, state: 'checking' })
    const t = setTimeout(async () => {
      const r: { kind: string; reason?: string } | null = await checkAvailability(handle).catch(() => ({ kind: 'failed' }))
      if (n !== asked.current) return
      if (r == null) setAvailability({ handle, state: 'available' })
      else if (r.kind === 'available') setAvailability({ handle, state: 'available' })
      else if (r.kind === 'unavailable')
        setAvailability({
          handle,
          state: 'taken',
          reason: UNAVAILABLE[r.reason ?? ''] ?? 'Not available',
          // a nearby name for a taken one; it's checked like any other once tapped
          suggestion: r.reason === 'taken' ? suggestFor(handle, { generated: gen.handle }) : undefined
        })
      else setAvailability({ handle, state: 'failed' })
    }, 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, check.ok])

  const reroll = () => {
    if (rollsLeft === 0) return
    const next = generateHandle([gen.handle])
    setGen(next)
    setRollsLeft(r => r - 1)
    setText(next.handle)
    const p = portraitFor(next.animal)
    if (p && !avatarPicked) setAvatar(a => ({ ...a, portrait: p, bg: randomAvatarBg() }))
  }

  const free = availability.handle === handle && availability.state !== 'taken'
  const ready = check.ok && free && availability.state !== 'checking'
  const create = () => {
    if (!ready || busy) return
    if (check.ok && check.kind === 'generated') onCreate({ handle, displayName: generatedName(gen), avatar, generated: gen })
    else if (check.ok && check.kind === 'custom') onCustom({ handle, monthly: check.monthly, yearly: check.yearly, avatar, generated: gen })
  }

  const status = (() => {
    if (!check.ok) return <Text style={[styles.note, { color: palette.destructive }]}>{check.error}</Text>
    if (availability.handle === handle && availability.state === 'taken') {
      const suggestion = availability.suggestion
      return (
        <Text style={[styles.note, { color: palette.destructive }]}>
          {availability.reason}
          {suggestion && (
            <>
              {' · '}
              <Text
                onPress={() => setText(suggestion)}
                accessibilityRole="button"
                style={[font(600), { textDecorationLine: 'underline' }]}
              >
                Try @{suggestion}
              </Text>
            </>
          )}
        </Text>
      )
    }
    if (availability.handle === handle && availability.state === 'checking')
      return <Text style={[styles.note, { color: palette.mutedForeground }]}>Checking…</Text>
    if (check.kind === 'generated')
      return (
        <View style={styles.noteRow}>
          <Check size={14} color={palette.positive} strokeWidth={3} />
          <Text style={[styles.note, { color: palette.mutedForeground }]}>
            Free handle · or type your own{rollsLeft === 0 ? ' · no more rerolls' : ''}
          </Text>
        </View>
      )
    return (
      <Text style={[styles.note, { color: palette.mutedForeground }]}>
        <Text style={[font(600), { color: palette.foreground }]}>{formatPrice(check.monthly)}/month</Text> · or {formatPrice(check.yearly)}/year, 2 months free
      </Text>
    )
  })()

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="New wallet" description="Its own handle, balance and history. It starts empty.">
      <View style={styles.field}>
        <Text style={[font(600), styles.label, { color: palette.mutedForeground }]}>HANDLE</Text>
        <Animated.View style={[styles.input, { backgroundColor: palette.card }, focusRing.style]}>
          <Text style={[font(400), styles.at, { color: palette.mutedForeground }]}>@</Text>
          <TextInput
            value={text}
            onChangeText={v => setText(cleanHandleInput(v))}
            // cleared and left: back to the generated handle
            onFocus={focusRing.handlers.onFocus}
            onBlur={() => {
              focusRing.handlers.onBlur()
              if (!text.trim()) setText(gen.handle)
            }}
            onSubmitEditing={create}
            placeholder={gen.handle}
            placeholderTextColor={palette.mutedForeground + '99'}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            autoComplete="off"
            returnKeyType="done"
            accessibilityLabel="Handle"
            style={[font(700), styles.handle, { color: palette.foreground }]}
          />
          {domain && (
            <Text numberOfLines={1} style={[font(400), styles.suffix, { color: palette.mutedForeground }]}>
              @{domain}
            </Text>
          )}
          {/* a new free handle; twice at most */}
          <Pressable
            onPress={reroll}
            disabled={rollsLeft === 0}
            accessibilityRole="button"
            accessibilityLabel={rollsLeft ? `New free handle (${rollsLeft} left)` : 'No more rerolls'}
            style={[styles.dice, rollsLeft === 0 && { opacity: 0.35 }]}
          >
            {/* animate-in spin-in-90 duration-300, again on every reroll */}
            <Animated.View key={rollsLeft} style={still ? null : enter({ opacity: 1, rotate: 90, duration: 300 })}>
              <Dices size={20} color={palette.foreground} />
            </Animated.View>
            {rollsLeft > 0 && (
              <View style={[styles.badge, { backgroundColor: palette.ink }]}>
                <Text style={[font(700), styles.badgeText, { color: palette.inkForeground }]}>{rollsLeft}</Text>
              </View>
            )}
          </Pressable>
        </Animated.View>
        {/* free, the price, or what's wrong */}
        <View style={styles.status}>{status}</View>
      </View>

      <View>
        <Text style={[font(600), styles.label, { color: palette.mutedForeground, paddingBottom: 8 }]}>IMAGE</Text>
        <AvatarPicker
          value={avatar}
          onChange={next => {
            setAvatar(next)
            setAvatarPicked(true)
          }}
        />
      </View>

      {busy ? (
        <View style={[styles.busy, { backgroundColor: palette.gold }]}>
          <Spinner size={16} strokeWidth={2.5} color={palette.goldForeground} />
          <Text style={[font(700), { fontSize: 17, color: palette.goldForeground }]}>Creating…</Text>
        </View>
      ) : (
        <View style={!ready ? { opacity: 0.55 } : null} pointerEvents={ready ? 'auto' : 'none'}>
          <GlassButton
            size="lg"
            label={check.ok && check.kind === 'custom' ? `Continue · ${formatPrice(check.monthly)}/month` : 'Create wallet'}
            onPress={create}
          />
        </View>
      )}
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { fontSize: 12, lineHeight: 16, letterSpacing: 1.2 },
  input: { height: 48, flexDirection: 'row', alignItems: 'center', borderRadius: radii['2xl'], paddingLeft: 16, paddingRight: 6 },
  at: { fontSize: 14 },
  handle: { fontSize: 14, paddingVertical: 0, minWidth: 40, flexShrink: 1 },
  suffix: { flex: 1, fontSize: 14 },
  dice: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', right: -2, top: -2, width: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: 10, lineHeight: 12 },
  status: { minHeight: 20, paddingLeft: 4 },
  noteRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  note: { fontSize: 12, lineHeight: 16 },
  busy: { height: 52, borderRadius: 999, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' }
})
