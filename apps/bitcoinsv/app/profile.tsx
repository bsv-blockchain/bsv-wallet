// Your profile (the prototype's app/(wallet)/settings/profile/page.tsx): you as
// people see you. The picture (tap to change it), your @handle, the code that
// pays you, then this wallet's backup and vault (Security), its export (Your
// data), and forgetting it.
// Not here: renaming a handle (the registry owns it; paid handles are decision
// 7's placeholder) and the public /@handle page, which nothing serves yet.
import React, { useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { Copy, FileDown, KeyRound, Pencil, QrCode, Trash2, Vault } from 'lucide-react-native'
import { isVaultEnabled, useWallet } from '@bsv/expo-wallet-toolbox'
import { showToast } from '../src/ui/Toast'
import { DISPLAY_NAME_KV_KEY, HANDLE_KV_KEY } from '@bsv/expo-wallet-toolbox/core/identity/handleRegistry/profileKeys'
import { font, usePalette } from '../src/theme'
import { PageHeader } from '../src/ui/PageHeader'
import { ViewInfo } from '../src/ui/ViewInfo'
import { BottomSheet, afterSheetCloses } from '../src/ui/BottomSheet'
import { Avatar, type AvatarBg, type Portrait } from '../src/ui/Avatar'
import { BalancedText } from '../src/ui/BalancedText'
import { AvatarPicker } from '../src/onboarding/AvatarPicker'
import { Section, SettingsRow } from '../src/settings/Rows'
import { ForgetWalletSheet } from '../src/settings/ForgetWalletSheet'
import { ExportSheet } from '../src/settings/ExportSheet'
import { BackupSheet } from '../src/backup/BackupSheet'
import { setPref, usePrefs } from '../src/state/prefs'
import { useHomeData } from '../src/state/useHomeData'

export default function Profile() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const prefs = usePrefs()
  const data = useHomeData()
  const { storage, switchingProfile } = useWallet()
  const [exportOpen, setExportOpen] = useState(false)
  const [handle, setHandle] = useState<string | null>(null)
  const [name, setName] = useState<string | null>(null)
  const [avatarOpen, setAvatarOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  const [forgetOpen, setForgetOpen] = useState(false)

  useEffect(() => {
    let alive = true
    if (switchingProfile) return
    storage
      ?.getKeyValue(HANDLE_KV_KEY)
      .then(v => alive && setHandle(v ?? null))
      .catch(() => {})
    storage
      ?.getKeyValue(DISPLAY_NAME_KV_KEY)
      .then(v => alive && setName(v ?? null))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [storage, switchingProfile])

  const full = handle ?? prefs.pendingHandle
  const bare = full ? full.split('@')[0] : null
  const avatar = {
    bg: (prefs.avatarBg as AvatarBg) ?? 'mint',
    portrait: (prefs.avatarPortrait as Portrait) ?? 'dragon',
    uri: prefs.avatarUri
  }

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <PageHeader
        title={bare ? `@${bare}` : 'Your profile'}
        onBack={() => router.back()}
        action={<ViewInfo about="Your profile" text="This is you, as your friends see you. Your photo and @handle. Make it lovely." />}
      />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]} showsVerticalScrollIndicator={false}>
        <View style={styles.head}>
          <Pressable onPress={() => setAvatarOpen(true)} accessibilityRole="button" accessibilityLabel="Edit picture" style={styles.avatarWrap}>
            <View style={[styles.avatarRing, { boxShadow: `0 0 0 2px ${palette.ink}99` }]}>
              <Avatar bg={avatar.bg} portrait={avatar.portrait} uri={avatar.uri} size={88} />
            </View>
            <View style={[styles.pencil, { backgroundColor: palette.ink, boxShadow: `0 0 0 2px ${palette.background}` }]}>
              <Pencil size={14} color={palette.inkForeground} />
            </View>
          </Pressable>
          {name ? <Text style={[font(700), styles.name, { color: palette.foreground }]}>{name}</Text> : null}
          {full ? (
            <Pressable
              onPress={async () => {
                await Clipboard.setStringAsync(full)
                showToast(`${full} copied`, { type: 'success' })
              }}
              accessibilityRole="button"
              accessibilityLabel={`Copy ${full}`}
              style={[styles.handle, { backgroundColor: palette.secondary }]}
            >
              <Text style={[font(600), styles.small, { color: palette.foreground }]}>{full}</Text>
              <Copy size={14} color={palette.mutedForeground} />
            </Pressable>
          ) : null}
          {prefs.pendingHandle && !handle ? (
            <BalancedText style={[font(400), styles.xs, { color: palette.mutedForeground }]}>Still being confirmed. It’s tried again when you open the app.</BalancedText>
          ) : null}
        </View>

        <View style={styles.rows}>
          <SettingsRow icon={QrCode} label="Your pay code" value="Get paid" onPress={() => router.push('/receive')} />
        </View>

        {/* security: this wallet's recovery phrase, and its vault */}
        <Section title="Security">
          <SettingsRow
            icon={KeyRound}
            label="Backup phrase"
            value={data.backedUp ? 'Backed up' : 'Not backed up'}
            tone={data.backedUp ? undefined : 'warning'}
            onPress={() => setBackupOpen(true)}
          />
          {isVaultEnabled() && <SettingsRow icon={Vault} label="Vault" onPress={() => router.push('/vault')} />}
        </Section>

        <Section title="Your data">
          <SettingsRow icon={FileDown} label="Export transactions" value="CSV or PDF" onPress={() => setExportOpen(true)} />
        </Section>

        <Pressable
          onPress={() => setForgetOpen(true)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.forget, { backgroundColor: palette.destructive + (pressed ? '26' : '1a') }]}
        >
          <Trash2 size={16} color={palette.destructive} />
          <Text style={[font(600), styles.small, { color: palette.destructive }]}>Forget wallet</Text>
        </Pressable>
      </ScrollView>

      <BottomSheet open={avatarOpen} onOpenChange={setAvatarOpen} title="Profile photo">
        <AvatarPicker
          value={avatar}
          onChange={next => {
            const upload = next.uri !== avatar.uri
            setPref('avatarPortrait', next.portrait)
            setPref('avatarBg', next.bg)
            setPref('avatarUri', next.uri)
            if (upload || next.portrait !== avatar.portrait) showToast(upload ? 'Image updated' : 'Avatar updated', { type: 'success' })
          }}
        />
      </BottomSheet>
      <BackupSheet open={backupOpen} onOpenChange={setBackupOpen} />
      <ExportSheet open={exportOpen} onOpenChange={setExportOpen} />
      <ForgetWalletSheet
        open={forgetOpen}
        onOpenChange={setForgetOpen}
        backedUp={data.backedUp}
        onBackUp={() => {
          setForgetOpen(false)
          afterSheetCloses(() => setBackupOpen(true))
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // gap-5
  content: { paddingHorizontal: 16, gap: 20, paddingTop: 8 },
  head: { alignItems: 'center', gap: 10, paddingTop: 8 },
  avatarWrap: { borderRadius: 48 },
  avatarRing: { borderRadius: 44 },
  pencil: { position: 'absolute', right: 0, bottom: 0, width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 20, lineHeight: 28, letterSpacing: -0.5, paddingTop: 4 },
  handle: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16, textAlign: 'center' },
  rows: { marginHorizontal: -8 },
  forget: { height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 999 }
})
