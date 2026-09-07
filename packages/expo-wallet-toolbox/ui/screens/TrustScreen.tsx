import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  Modal,
  ActivityIndicator
} from 'react-native'
import type { StyleProp, ViewStyle } from 'react-native'
import { SvgUri } from 'react-native-svg'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
// Same deep path WalletContext uses: the package root does not re-export the
// settings types.
import type { Certifier as WalletCertifier } from '@bsv/wallet-toolbox-mobile/out/src/WalletSettingsManager'
import validateTrust from '../validateTrust'
import { GroupedSection } from '../components/ui/GroupedList'
import { showAlert } from '../components/ui/AlertCard'
import { haptics, useTheme, spacing, radii, typography, useWallet } from '@bsv/expo-wallet-toolbox'

/**
 * @expo/vector-icons' index barrel re-exports every icon set (AntDesign,
 * etc.), one of which reaches expo-font -> expo-asset -- untransformed ESM
 * that Jest cannot parse when eagerly pulled in via the `ui` package barrel.
 * Ionicons is loaded lazily, only when actually rendering, same pattern as
 * this package's other native-module-boundary fixes (expo-router, expo-blur).
 */
type IoniconsComponent = typeof import('@expo/vector-icons').Ionicons
let ioniconsComponent: IoniconsComponent | undefined
function loadIonicons(): IoniconsComponent {
  if (!ioniconsComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ioniconsComponent = require('@expo/vector-icons').Ionicons as IoniconsComponent
  }
  return ioniconsComponent
}

/**
 * expo-image's package entry is raw TypeScript (`main: src/index.ts`), which
 * Jest does not transform under this package's documented config. Requiring
 * it at render time keeps the `ui` barrel importable in consumers' test
 * suites, the same boundary treatment @expo/vector-icons gets above.
 */
type ExpoImageComponent = typeof import('expo-image').Image
let expoImageComponent: ExpoImageComponent | undefined
function loadExpoImage(): ExpoImageComponent {
  if (!expoImageComponent) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoImageComponent = require('expo-image').Image as ExpoImageComponent
  }
  return expoImageComponent
}

/**
 * expo-router is required lazily rather than imported at module scope: this
 * file is barrel-exported from the package's `ui` entry point, and a static
 * top-level `import` of expo-router pulls in its own untransformed JSX
 * source (Navigator.js etc.), which Jest cannot parse for any consumer of the
 * barrel, even one that never navigates. Same pattern as this package's other
 * lazy expo-router loads (WalletHomeScreen.tsx, VaultScreen.tsx, etc.).
 */
type ExpoRouterModule = typeof import('expo-router')
let expoRouterMod: ExpoRouterModule | undefined
function loadExpoRouter(): ExpoRouterModule {
  if (!expoRouterMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoRouterMod = require('expo-router') as ExpoRouterModule
  }
  return expoRouterMod
}

// -------------------- Types --------------------
/**
 * The wallet's own settings type, not a local copy: a local copy is how this
 * screen came to read `icon` while every shipped default (and the library's
 * WalletSettingsManager) stores the URL as `iconUrl`, so the built-in
 * certifiers never showed their icons.
 */
export type Certifier = WalletCertifier

/**
 * Builds before 0.3.0 saved a user-added provider's icon under `icon`. A
 * wallet upgraded in place holds those entries next to `iconUrl` ones, so the
 * screen accepts both on load and writes only the canonical field back.
 * `iconUrl` wins if an entry somehow carries both.
 */
export function normaliseCertifier(c: Certifier & { icon?: string }): Certifier {
  const { icon, ...rest } = c
  if (rest.iconUrl || !icon) return rest
  return { ...rest, iconUrl: icon }
}

/**
 * An icon URL is a promise the certifier's manifest made, not a guarantee: two
 * of the shipped defaults point at .ico favicons the iOS decoder rejects, and
 * any provider can move its file. The initial-letter tile is therefore the
 * fallback for a failed load as well as for a missing URL, so a broken icon
 * never leaves an empty square where the letter used to be.
 */
function CertifierIcon({
  url,
  name,
  style,
  placeholderStyle,
  colors
}: {
  url?: string
  name?: string
  style: React.ComponentProps<ExpoImageComponent>['style']
  placeholderStyle: StyleProp<ViewStyle>
  colors: { accent: string; background: string }
}) {
  const Image = loadExpoImage()
  // Remembers which URL failed rather than a bare flag, so a corrected URL on
  // the same row gets a fresh attempt.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (!url || failedUrl === url) {
    return (
      <View style={[placeholderStyle, { backgroundColor: colors.accent }]}>
        <Text style={{ color: colors.background, fontWeight: '700' }}>{name?.[0] || '?'}</Text>
      </View>
    )
  }
  // expo-image hands an SVG to the platform decoder, which on iOS drops
  // percentage-positioned <text> and similar authoring shortcuts, so a vector
  // mark can come out blank or with its glyph in a corner. react-native-svg's
  // own parser is already in the bundle for the activity sigils and handles
  // those, and its fetch or parse failures surface through onError like a
  // raster load would. The wrapper carries the tile's size and radius.
  if (/\.svg(?:[?#]|$)/i.test(url)) {
    return (
      <View style={[style as StyleProp<ViewStyle>, { overflow: 'hidden' }]}>
        <SvgUri uri={url} width="100%" height="100%" onError={() => setFailedUrl(url)} />
      </View>
    )
  }
  return <Image source={{ uri: url }} style={style} onError={() => setFailedUrl(url)} />
}

// -------------------- Helpers --------------------
const maskKey = (k: string) => (k?.length > 16 ? `${k.slice(0, 8)}...${k.slice(-8)}` : k)

const assignTrust = (certifiers: Certifier[]): Certifier[] =>
  certifiers.map((c, i) => ({ ...c, trust: i < 9 ? 10 - i : 1 }))

const orderChanged = (a: Certifier[], b: Certifier[]): boolean => {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) {
    if (a[i].identityKey !== b[i].identityKey) return true
  }
  return false
}

const fetchWithTimeout = async (url: string, ms: number) => {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return res
  } finally {
    clearTimeout(id)
  }
}

// -------------------- Main Screen --------------------
export function TrustScreen() {
  const { t } = useTranslation()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const { router } = loadExpoRouter()
  const Ionicons = loadIonicons()

  const { settings, updateSettings } = useWallet()

  // Source of truth from Settings — sort by trust descending so position matches priority
  const initialTrusted: Certifier[] = useMemo(
    () =>
      (settings?.trustSettings?.trustedCertifiers || [])
        .map(normaliseCertifier)
        .sort((a, b) => b.trust - a.trust),
    [settings?.trustSettings?.trustedCertifiers]
  )

  // Local working state
  const [trustedEntities, setTrustedEntities] = useState<Certifier[]>(initialTrusted)
  const [query, setQuery] = useState('')
  const [saving, setSaving] = useState(false)
  const [snack, setSnack] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  // Detect unsaved changes — compare identity key arrays in order
  const settingsNeedsUpdate = orderChanged(initialTrusted, trustedEntities)

  // Save to settings
  const handleSave = useCallback(async (): Promise<boolean> => {
    try {
      setSaving(true)
      await updateSettings(
        JSON.parse(
          JSON.stringify({
            ...settings,
            trustSettings: {
              trustLevel: 1,
              trustedCertifiers: assignTrust(trustedEntities)
            }
          })
        )
      )
      setSnack(t('trust_updated'))
      return true
    } catch (e: any) {
      setSnack(e?.message || t('failed_to_save'))
      return false
    } finally {
      setSaving(false)
    }
  }, [updateSettings, settings, trustedEntities, t])

  // Search
  const filtered = useMemo(() => {
    if (!query.trim()) return trustedEntities
    const q = query.toLowerCase()
    return trustedEntities.filter(
      e => e.name.toLowerCase().includes(q) || e.description?.toLowerCase?.().includes(q)
    )
  }, [trustedEntities, query])

  const isSearching = query.trim().length > 0

  const onMoveUp = (identityKey: string) => {
    haptics.tap()
    setTrustedEntities(prev => {
      const idx = prev.findIndex(c => c.identityKey === identityKey)
      if (idx <= 0) return prev
      const next = [...prev]
      ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
      return next
    })
  }

  const onMoveDown = (identityKey: string) => {
    haptics.tap()
    setTrustedEntities(prev => {
      const idx = prev.findIndex(c => c.identityKey === identityKey)
      if (idx < 0 || idx >= prev.length - 1) return prev
      const next = [...prev]
      ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
      return next
    })
  }

  const onRemove = async (identityKey: string) => {
    const choice = await showAlert({
      title: t('confirm_delete'),
      message: t('confirm_delete_body'),
      buttons: [
        { text: t('cancel'), style: 'cancel', key: 'cancel' },
        { text: t('delete'), style: 'destructive', key: 'delete' },
      ],
    })
    if (choice !== 'delete') return
    setTrustedEntities(prev => prev.filter(c => c.identityKey !== identityKey))
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.backgroundSecondary, paddingTop: insets.top }}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.separator }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color={colors.textSecondary} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{t('trust_network')}</Text>
        <View style={styles.backButton} />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: spacing.lg,
          paddingBottom: settingsNeedsUpdate ? 80 : spacing.xxxl
        }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Description */}
        <Text style={[styles.description, { color: colors.textSecondary }]}>
          {t('order_certifiers_hint')}
        </Text>

        {/* ── Certifiers ── */}
        <GroupedSection header={t('certifiers')}>
          {/* Search bar */}
          <View style={[styles.searchRow, { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }]}>
            <Ionicons name="search" size={16} color={colors.textSecondary} style={{ marginRight: spacing.sm }} />
            <TextInput
              style={[styles.searchInput, { color: colors.textPrimary }]}
              placeholder={t('search')}
              placeholderTextColor={colors.textSecondary}
              value={query}
              onChangeText={setQuery}
            />
          </View>

          {filtered.length === 0 ? (
            <View style={styles.emptyBox}>
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{t('no_certifiers')}</Text>
            </View>
          ) : (
            filtered.map((item, idx) => {
              // Find real index in full list for proper up/down logic
              const realIdx = trustedEntities.findIndex(c => c.identityKey === item.identityKey)
              const isFirst = realIdx === 0
              const isLast = realIdx === trustedEntities.length - 1

              return (
                <View
                  key={item.identityKey}
                  style={[
                    styles.certifierCard,
                    idx < filtered.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator }
                  ]}
                >
                  <View style={styles.certifierHeader}>
                    <CertifierIcon
                      url={item.iconUrl}
                      name={item.name}
                      style={styles.certifierIcon}
                      placeholderStyle={styles.certifierIconPlaceholder}
                      colors={colors}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.certifierName, { color: colors.textPrimary }]} numberOfLines={1}>
                        {item.name}
                      </Text>
                      <Text style={[styles.certifierDesc, { color: colors.textSecondary }]} numberOfLines={2}>
                        {item.description}
                      </Text>
                    </View>
                    <View style={styles.actions}>
                      {!isFirst && !isSearching && (
                        <TouchableOpacity onPress={() => onMoveUp(item.identityKey)} style={styles.actionBtn}>
                          <Ionicons name="chevron-up" size={18} color={colors.textSecondary} />
                        </TouchableOpacity>
                      )}
                      {!isLast && !isSearching && (
                        <TouchableOpacity onPress={() => onMoveDown(item.identityKey)} style={styles.actionBtn}>
                          <Ionicons name="chevron-down" size={18} color={colors.textSecondary} />
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity onPress={() => onRemove(item.identityKey)} style={styles.actionBtn}>
                        <Ionicons name="close" size={18} color={colors.error} />
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              )
            })
          )}

          {/* Add Provider button */}
          <TouchableOpacity
            style={[styles.addProviderBtn, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator }]}
            onPress={() => setShowAdd(true)}
          >
            <Ionicons name="add" size={18} color={colors.accent} style={{ marginRight: spacing.sm }} />
            <Text style={[styles.addProviderText, { color: colors.accent }]}>{t('add_provider')}</Text>
          </TouchableOpacity>
        </GroupedSection>
      </ScrollView>

      {/* Save bar */}
      {settingsNeedsUpdate && (
        <View style={[styles.saveBar, { backgroundColor: colors.backgroundElevated, borderTopColor: colors.separator }]}>
          <Text style={[styles.saveBarText, { color: colors.textSecondary }]}>{t('unsaved_changes')}</Text>
          <TouchableOpacity
            onPress={handleSave}
            disabled={saving}
            style={[styles.saveBtn, { backgroundColor: colors.accent, opacity: saving ? 0.6 : 1 }]}
          >
            {saving ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Text style={[styles.saveBtnText, { color: colors.background }]}>{t('save')}</Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      {/* Snackbar */}
      {snack && (
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => setSnack(null)}
          style={[styles.snack, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}
        >
          <Text style={{ color: colors.textPrimary }}>{snack}</Text>
        </TouchableOpacity>
      )}

      {/* Add Provider Modal */}
      <AddProviderModal
        visible={showAdd}
        onClose={() => setShowAdd(false)}
        onAdd={(c) => {
          if (trustedEntities.some(x => x.identityKey === c.identityKey)) {
            setSnack(t('duplicate_key_error'))
            return
          }
          setTrustedEntities(prev => [...prev, { ...c, trust: 1 }])
          setShowAdd(false)
        }}
        colors={colors}
      />
    </View>
  )
}

// -------------------- Add Provider Modal --------------------
function AddProviderModal({
  visible,
  onClose,
  onAdd,
  colors
}: {
  visible: boolean
  onClose: () => void
  onAdd: (c: Omit<Certifier, 'trust'>) => void
  colors: any
}) {
  const { t } = useTranslation()
  const Ionicons = loadIonicons()
  const [advanced, setAdvanced] = useState(false)
  const [domain, setDomain] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState('')
  const [identityKey, setIdentityKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [fieldsValid, setFieldsValid] = useState(false)

  const [domainError, setDomainError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const [iconError, setIconError] = useState<string | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)

  useEffect(() => {
    if (!visible) {
      setAdvanced(false)
      setDomain('')
      setName('')
      setDescription('')
      setIcon('')
      setIdentityKey('')
      setFieldsValid(false)
      setDomainError(null)
      setNameError(null)
      setIconError(null)
      setKeyError(null)
    }
  }, [visible])

  const handleDomainSubmit = async () => {
    try {
      if (!domain) return
      setLoading(true)
      setDomainError(null)
      const url = domain.startsWith('http') ? `${domain}/manifest.json` : `https://${domain}/manifest.json`
      let res: Response
      try {
        res = await fetchWithTimeout(url, 15000)
      } catch (e: any) {
        if (e?.name === 'AbortError') throw new Error('The domain did not respond within 15 seconds')
        throw new Error('Could not fetch the trust data from that domain (it needs to follow the BRC-68 protocol)')
      }
      if (!res.ok) throw new Error('Failed to fetch trust manifest from that domain')
      const json = await res.json()
      const trust = json?.babbage?.trust
      if (!json?.babbage || !trust || typeof trust !== 'object') {
        throw new Error('This domain does not support importing a trust relationship (it needs to follow the BRC-68 protocol)')
      }
      await validateTrust(trust)
      setName(trust.name)
      setDescription(trust.note)
      setIcon(trust.icon)
      setIdentityKey(trust.publicKey)
      setFieldsValid(true)
    } catch (e: any) {
      setFieldsValid(false)
      setDomainError(e?.message || 'Failed to import trust relationship')
    } finally {
      setLoading(false)
    }
  }

  const handleDirectValidate = async () => {
    try {
      setLoading(true)
      setNameError(null)
      setIconError(null)
      setKeyError(null)
      await validateTrust({ name, icon, publicKey: identityKey }, { skipNote: true })
      setDescription(name)
      setFieldsValid(true)
    } catch (e: any) {
      setFieldsValid(false)
      if (e?.field === 'name') setNameError(e.message)
      else if (e?.field === 'icon') setIconError(e.message)
      else setKeyError(e?.message || 'Invalid public key')
    } finally {
      setLoading(false)
    }
  }

  const descriptionInvalid = !description || description.length < 5 || description.length > 50

  const ready = fieldsValid && !descriptionInvalid

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={[styles.modalCard, { backgroundColor: colors.backgroundElevated, borderColor: colors.separator }]}>
          <View style={[styles.modalHeader]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>{t('add_provider')}</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {!advanced ? (
            <>
              <Text style={[styles.modalDesc, { color: colors.textSecondary }]}>Enter the domain name for the provider you&apos;d like to add.</Text>
              <View style={[styles.inputRow, { borderColor: colors.separator, backgroundColor: colors.fillTertiary }]}>
                <Ionicons name="globe-outline" size={16} color={colors.textSecondary} style={{ marginRight: spacing.sm }} />
                <TextInput
                  placeholder="trustedentity.com"
                  placeholderTextColor={colors.textSecondary}
                  value={domain}
                  onChangeText={t => {
                    setDomain(t)
                    setDomainError(null)
                    setFieldsValid(false)
                  }}
                  style={[styles.textInput, { color: colors.textPrimary }]}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              {!!domainError && <Text style={[styles.err, { color: colors.error }]}>{domainError}</Text>}
              {loading ? (
                <ActivityIndicator style={{ marginTop: spacing.md }} />
              ) : (
                <TouchableOpacity onPress={handleDomainSubmit} style={[styles.primaryBtn, { backgroundColor: colors.accent }]}>
                  <Ionicons name="document-text-outline" size={16} color={colors.background} />
                  <Text style={[styles.primaryBtnText, { color: colors.background }]}>{t('get_provider_details')}</Text>
                </TouchableOpacity>
              )}
            </>
          ) : (
            <>
              <Text style={[styles.modalDesc, { color: colors.textSecondary }]}>Directly enter the details for the provider you&apos;d like to add.</Text>

              {/* Name */}
              <View style={[styles.inputRow, { borderColor: colors.separator, backgroundColor: colors.fillTertiary }]}>
                <Ionicons name="person-outline" size={16} color={colors.textSecondary} style={{ marginRight: spacing.sm }} />
                <TextInput
                  placeholder="Entity Name"
                  placeholderTextColor={colors.textSecondary}
                  value={name}
                  onChangeText={t => {
                    setName(t)
                    setNameError(null)
                    setFieldsValid(false)
                  }}
                  style={[styles.textInput, { color: colors.textPrimary }]}
                />
              </View>
              {!!nameError && <Text style={[styles.err, { color: colors.error }]}>{nameError}</Text>}

              {/* Icon */}
              <View style={[styles.inputRow, { borderColor: colors.separator, backgroundColor: colors.fillTertiary }]}>
                <Ionicons name="image-outline" size={16} color={colors.textSecondary} style={{ marginRight: spacing.sm }} />
                <TextInput
                  placeholder="https://trustedentity.com/icon.png"
                  placeholderTextColor={colors.textSecondary}
                  value={icon}
                  onChangeText={t => {
                    setIcon(t)
                    setIconError(null)
                    setFieldsValid(false)
                  }}
                  style={[styles.textInput, { color: colors.textPrimary }]}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              {!!iconError && <Text style={[styles.err, { color: colors.error }]}>{iconError}</Text>}

              {/* Public key */}
              <View style={[styles.inputRow, { borderColor: colors.separator, backgroundColor: colors.fillTertiary }]}>
                <Ionicons name="key-outline" size={16} color={colors.textSecondary} style={{ marginRight: spacing.sm }} />
                <TextInput
                  placeholder="0295bf1c7842d14b..."
                  placeholderTextColor={colors.textSecondary}
                  value={identityKey}
                  onChangeText={t => {
                    setIdentityKey(t)
                    setKeyError(null)
                    setFieldsValid(false)
                  }}
                  style={[styles.textInput, { color: colors.textPrimary }]}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              {!!keyError && <Text style={[styles.err, { color: colors.error }]}>{keyError}</Text>}

              {loading ? (
                <ActivityIndicator style={{ marginTop: spacing.md }} />
              ) : (
                <TouchableOpacity onPress={handleDirectValidate} style={[styles.primaryBtn, { backgroundColor: colors.accent }]}>
                  <Ionicons name="shield-checkmark-outline" size={16} color={colors.background} />
                  <Text style={[styles.primaryBtnText, { color: colors.background }]}>{t('validate_details')}</Text>
                </TouchableOpacity>
              )}
            </>
          )}

          {/* Toggle advanced */}
          <TouchableOpacity onPress={() => setAdvanced(v => !v)} style={styles.advancedBtn}>
            <Ionicons name={advanced ? 'chevron-up-outline' : 'chevron-down-outline'} size={16} color={colors.textPrimary} />
            <Text style={{ marginLeft: spacing.xs, color: colors.textPrimary }}>{advanced ? t('hide_advanced') : t('show_advanced')}</Text>
          </TouchableOpacity>

          {/* Preview + description edit */}
          {fieldsValid && (
            <View style={[styles.previewBox, { borderColor: colors.separator, backgroundColor: colors.fillTertiary }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <CertifierIcon
                  url={icon}
                  name={name}
                  style={styles.previewIcon}
                  placeholderStyle={[styles.previewIcon, { justifyContent: 'center', alignItems: 'center' }]}
                  colors={colors}
                />
                <View style={{ marginLeft: spacing.md, flex: 1 }}>
                  <Text style={{ fontWeight: '700', color: colors.textPrimary }}>{name}</Text>
                  <Text style={[styles.previewKey, { color: colors.textSecondary }]}>{maskKey(identityKey)}</Text>
                </View>
              </View>

              <View style={[styles.inputRow, { marginTop: spacing.md, borderColor: colors.separator, backgroundColor: colors.fillTertiary }]}>
                <Ionicons name="pricetag-outline" size={16} color={colors.textSecondary} style={{ marginRight: spacing.sm }} />
                <TextInput
                  placeholder="Description"
                  placeholderTextColor={colors.textSecondary}
                  value={description}
                  onChangeText={setDescription}
                  style={[styles.textInput, { color: colors.textPrimary }]}
                />
              </View>
              {descriptionInvalid && (
                <Text style={[styles.err, { color: colors.error }]}>{t('description_length_error')}</Text>
              )}
            </View>
          )}

          {/* Footer Actions */}
          <View style={styles.modalActions}>
            <TouchableOpacity onPress={onClose} style={[styles.secondaryBtn, { borderColor: colors.separator }]}>
              <Text style={{ color: colors.textPrimary }}>{t('cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              disabled={!ready}
              onPress={() => onAdd({ name, description, iconUrl: icon, identityKey })}
              style={[styles.saveBtn, { backgroundColor: colors.accent, opacity: ready ? 1 : 0.5, flex: 0 }]}
            >
              <Ionicons name="shield-checkmark-outline" size={16} color={colors.background} />
              <Text style={[styles.saveBtnText, { color: colors.background }]}>Add</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  )
}

// -------------------- Styles --------------------
const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    ...typography.headline,
  },
  description: {
    ...typography.footnote,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.lg,
  },

  // Search
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  searchInput: {
    flex: 1,
    ...typography.body,
    padding: 0,
  },

  // Certifier cards
  certifierCard: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  certifierHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  certifierIcon: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    marginRight: spacing.md,
  },
  certifierIconPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    marginRight: spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  certifierName: {
    ...typography.body,
    fontWeight: '700',
  },
  certifierDesc: {
    ...typography.footnote,
    marginTop: spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: spacing.sm,
  },
  actionBtn: {
    padding: spacing.xs,
  },
  emptyBox: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
  },
  emptyText: {
    ...typography.subhead,
  },

  // Add provider button
  addProviderBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
  },
  addProviderText: {
    ...typography.body,
    fontWeight: '600',
  },

  // Save bar
  saveBar: {
    borderTopWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  saveBarText: {
    ...typography.subhead,
  },
  saveBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  saveBtnText: {
    ...typography.subhead,
    fontWeight: '700',
  },

  // Snackbar
  snack: {
    margin: spacing.lg,
    marginTop: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: 1,
    padding: spacing.md,
    alignItems: 'center',
  },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  modalCard: {
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.lg,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  modalTitle: {
    ...typography.headline,
    fontWeight: '700',
  },
  modalDesc: {
    ...typography.subhead,
    marginBottom: spacing.sm,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    height: 40,
    marginTop: spacing.sm,
  },
  textInput: {
    flex: 1,
    ...typography.subhead,
    padding: 0,
  },
  primaryBtn: {
    marginTop: spacing.md,
    height: 44,
    borderRadius: radii.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtnText: {
    marginLeft: spacing.xs,
    ...typography.subhead,
    fontWeight: '700',
  },
  secondaryBtn: {
    height: 44,
    borderRadius: radii.sm,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  modalActions: {
    marginTop: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
  },
  advancedBtn: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
  },
  previewBox: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderRadius: radii.sm,
    padding: spacing.md,
  },
  previewIcon: {
    width: 48,
    height: 48,
    borderRadius: radii.sm,
  },
  previewKey: {
    ...typography.caption1,
  },
  err: {
    ...typography.footnote,
    marginTop: spacing.xs,
  },
})
