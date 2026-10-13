// Contacts (the prototype's app/(wallet)/contacts/page.tsx): your people,
// Favourites and All, searchable by name or @handle. Each row pays, renames,
// stars, or deletes (asking first, with Undo after: a soft remove, decision
// 10). The pencil picks several to star or delete at once. Add puts someone
// new in by their @handle.
//
// Not here, unlike the prototype: Invite (no invite link service yet).
import React, { useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { TextInput } from '../../src/ui/TextInput'
import Animated, { cubicBezier } from 'react-native-reanimated'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ArrowUpRight, Check, Pencil, Search, Star, Trash2, UserPlus, X } from 'lucide-react-native'
import { showToast } from '../../src/ui/Toast'
import { Handle } from '../../src/ui/Handle'
import { matchesSearch } from '../../src/contacts/handles'
import { getPrefs, setPref, usePrefs } from '../../src/state/prefs'
import { font, radii, useIsDark, usePalette } from '../../src/theme'
import { BottomSheet } from '../../src/ui/BottomSheet'
import { Face } from '../../src/ui/Face'
import { GlassButton } from '../../src/ui/GlassButton'
import { PageHeader } from '../../src/ui/PageHeader'
import { ViewInfo } from '../../src/ui/ViewInfo'
import { showUndo } from '../../src/ui/UndoBar'
import { EASE_PRESS, enter } from '../../src/ui/motion'
import { useFocusRing } from '../../src/ui/focusRing'
import { BalancedText } from '../../src/ui/BalancedText'
import { useContacts, type Contact } from '../../src/contacts/useContacts'

/** transition-colors' curve */
const TEXT_EASE = cubicBezier(0.4, 0, 0.2, 1)
const middle = (s: string) => (s.length > 17 ? `${s.slice(0, 8)}…${s.slice(-8)}` : s)
const first = (c: Contact) => c.name.split(' ')[0]

export default function ContactsScreen() {
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const contacts = useContacts()
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<'favourites' | 'all'>('favourites')
  const [renaming, setRenaming] = useState<Contact | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [confirmBatch, setConfirmBatch] = useState(false)
  const ring = useFocusRing(palette)
  const dark = useIsDark()

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = contacts.list ?? []
    // by name, or handle in any form, with or without its @ (src/contacts/handles.ts)
    return q ? all.filter(c => matchesSearch({ name: c.name, handle: c.cachedHandle }, q)) : all
  }, [contacts.list, query])
  const shown = tab === 'favourites' ? filtered.filter(c => c.favourite) : filtered

  const remove = async (list: Contact[]) => {
    for (const c of list) await contacts.remove(c.identityKey)
    showUndo(list.length === 1 ? `${list[0].name} deleted` : `${list.length} contacts deleted`, () => {
      for (const c of list) void contacts.restore(c.identityKey)
    })
  }
  const endSelecting = () => {
    setSelecting(false)
    setPicked([])
    setConfirmBatch(false)
  }
  const star = async (on: boolean) => {
    const list = (contacts.list ?? []).filter(c => picked.includes(c.identityKey))
    for (const c of list) await contacts.setFavourite(c.identityKey, on)
    showToast(`${list.length} ${list.length === 1 ? 'contact' : 'contacts'} ${on ? 'added to' : 'removed from'} favourites`, { type: 'success' })
    endSelecting()
  }

  return (
    <View style={[styles.root, { backgroundColor: palette.background, paddingTop: insets.top }]}>
      <View style={styles.pad}>
        <PageHeader
          title="Contacts"
          align="left"
          action={
            selecting ? (
              <Pressable
                onPress={endSelecting}
                accessibilityRole="button"
                style={({ pressed }) => [styles.textButton, pressed && { backgroundColor: palette.accent }]}
              >
                <Text style={[font(600), styles.small, { color: palette.foreground }]}>Done</Text>
              </Pressable>
            ) : (
              <View style={styles.headerActions}>
                <Pressable
                  onPress={() => router.push('/contacts/add')}
                  accessibilityRole="button"
                  accessibilityLabel="Add contact"
                  style={[styles.round, { backgroundColor: palette.secondary }]}
                >
                  <UserPlus size={16} color={palette.foreground} />
                </Pressable>
                {/* ghost icon button, size-5 pencil */}
                <Pressable
                  onPress={() => {
                    setSelecting(true)
                    setTab('all')
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Select contacts"
                  style={({ pressed }) => [styles.ghost, pressed && { backgroundColor: palette.accent }]}
                >
                  <Pencil size={20} color={palette.foreground} />
                </Pressable>
                <ViewInfo
                  about="Contacts"
                  text="Your people, in one place. Tap someone to pay them or see your history together. Star your favourites to keep them close."
                />
              </View>
            )
          }
        />
        <Animated.View style={[styles.search, { backgroundColor: palette.card }, ring.style]}>
          <Search size={16} color={palette.mutedForeground} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            {...ring.handlers}
            placeholder="Search contacts or @handles"
            placeholderTextColor={palette.mutedForeground}
            accessibilityLabel="Search contacts"
            style={[font(400), styles.searchInput, { color: palette.foreground }]}
          />
        </Animated.View>
        {/* favourites / all, text tabs */}
        <View style={styles.tabs}>
          {(
            [
              { id: 'favourites', label: 'Favourites' },
              { id: 'all', label: 'All contacts' }
            ] as const
          ).map(t => {
            const on = tab === t.id
            return (
              <Pressable key={t.id} onPress={() => setTab(t.id)} accessibilityRole="tab" accessibilityState={{ selected: on }} style={styles.tab}>
                <Animated.Text
                  style={[
                    font(600),
                    styles.tabText,
                    { color: on ? palette.foreground : palette.mutedForeground },
                    { transitionProperty: 'color', transitionDuration: 150, transitionTimingFunction: TEXT_EASE }
                  ]}
                >
                  {t.label}
                </Animated.Text>
                {/* the underline springs open (ease-[cubic-bezier(0.34,1.56,0.64,1)]); ink in dark mode */}
                <Animated.View
                  style={[
                    styles.tabBar,
                    { backgroundColor: dark ? palette.ink : palette.foreground, transform: [{ scaleX: on ? 1 : 0 }] },
                    { transitionProperty: 'transform', transitionDuration: 300, transitionTimingFunction: EASE_PRESS }
                  ]}
                />
              </Pressable>
            )
          })}
        </View>
      </View>

      <FlatList
        key={`${tab}-${query.trim()}`}
        data={shown}
        keyExtractor={c => c.identityKey}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + (selecting ? 140 : 24) }]}
        ListEmptyComponent={
          contacts.list === null ? null : (
            <View style={styles.empty}>
              <BalancedText style={[font(400), styles.small, styles.center, { color: palette.mutedForeground }]}>
                {query.trim()
                  ? `No contacts match “${query.trim()}”`
                  : tab === 'favourites'
                    ? (contacts.list ?? []).length
                      ? 'No favourites yet. Star a contact to pin them here.'
                      : 'No contacts yet. Add someone by their @handle.'
                    : 'No contacts yet. Add someone by their @handle.'}
              </BalancedText>
              {!query.trim() && !(contacts.list ?? []).length && (
                <GlassButton variant="outline" label="Add a contact" onPress={() => router.push('/contacts/add')} />
              )}
            </View>
          )
        }
        renderItem={({ item, index }) => (
          <Animated.View style={enter({ opacity: 0, translateY: 4, duration: 300, delay: Math.min(index, 12) * 35, easing: 'ease-out' })}>
            <ContactListRow
              contact={item}
              selecting={selecting}
              selected={picked.includes(item.identityKey)}
              onSelect={() => {
                setConfirmBatch(false)
                setPicked(ps => (ps.includes(item.identityKey) ? ps.filter(x => x !== item.identityKey) : [...ps, item.identityKey]))
              }}
              onRename={() => setRenaming(item)}
              onDelete={() => void remove([item])}
            />
          </Animated.View>
        )}
      />

      {/* batch actions, docked to the bottom while selecting */}
      {selecting && (
        <Animated.View
          style={[
            styles.batch,
            // bg-background/90 shadow-lg ring-1 ring-border
            {
              bottom: Math.max(12, insets.bottom + 4),
              backgroundColor: palette.background + 'e6',
              boxShadow: `0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1), 0 0 0 1px ${palette.border}`
            },
            enter({ opacity: 0, translateY: 8, duration: 200 })
          ]}
        >
          <View style={styles.batchHead}>
            <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
              {picked.length === 0 ? 'Tap contacts to select them' : `${picked.length} selected`}
            </Text>
            <Pressable onPress={() => setPicked(picked.length === shown.length ? [] : shown.map(c => c.identityKey))} accessibilityRole="button">
              <Text style={[font(600), styles.xs, { color: palette.foreground }]}>
                {picked.length === shown.length && shown.length > 0 ? 'Select none' : 'Select all'}
              </Text>
            </Pressable>
          </View>
          <View style={styles.batchButtons}>
            {/* on Favourites everyone's starred already, so it unstars; on All contacts it stars */}
            <Pressable
              disabled={!picked.length}
              onPress={() => void star(tab !== 'favourites')}
              accessibilityRole="button"
              style={[styles.batchButton, { backgroundColor: palette.secondary, opacity: picked.length ? 1 : 0.5 }]}
            >
              <View style={tab === 'favourites' && styles.half}>
                <Star size={16} color={palette.foreground} />
              </View>
              <Text style={[font(600), styles.small, { color: palette.foreground }]}>{tab === 'favourites' ? 'Unstar' : 'Favourite'}</Text>
            </Pressable>
            <Pressable
              disabled={!picked.length}
              onPress={() => {
                if (!confirmBatch) return setConfirmBatch(true)
                void remove((contacts.list ?? []).filter(c => picked.includes(c.identityKey)))
                endSelecting()
              }}
              accessibilityRole="button"
              style={[styles.batchButton, { backgroundColor: confirmBatch ? palette.destructive : palette.secondary, opacity: picked.length ? 1 : 0.5 }]}
            >
              <Trash2 size={16} color={confirmBatch ? '#ffffff' : palette.destructive} />
              <Text style={[font(600), styles.small, { color: confirmBatch ? '#ffffff' : palette.destructive }]}>
                {confirmBatch ? `Delete ${picked.length}?` : 'Delete'}
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      )}

      <RenameSheet contact={renaming} onClose={() => setRenaming(null)} onSave={(c, name) => contacts.rename(c.identityKey, name)} />
    </View>
  )
}

function ContactListRow({
  contact,
  selecting,
  selected,
  onSelect,
  onRename,
  onDelete
}: {
  contact: Contact
  selecting: boolean
  selected: boolean
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
}) {
  const palette = usePalette()
  const router = useRouter()
  const contacts = useContacts()
  const [confirming, setConfirming] = useState(false)
  const body = (
    <>
      <Face counterparty={{ kind: 'identityKey', value: contact.identityKey }} avatarUrl={contact.cachedAvatarUrl} size={40} />
      <View style={styles.flex}>
        <Text numberOfLines={1} style={[font(500), styles.small, { color: palette.foreground }]}>
          {contact.name}
        </Text>
        {/* "@rosa", or "@rosa@ [mark] handcash" from another wallet */}
        {contact.cachedHandle ? (
          <Handle handle={contact.cachedHandle} style={[font(400), styles.xs, { color: palette.mutedForeground }]} />
        ) : (
          <Text numberOfLines={1} style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
            Identity key · {middle(contact.identityKey)}
          </Text>
        )}
      </View>
    </>
  )
  if (selecting)
    return (
      <Pressable
        onPress={onSelect}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: selected }}
        style={[styles.row, styles.rowPad, selected && { backgroundColor: palette.secondary + '99' }]}
      >
        {body}
        <View
          style={[
            styles.pick,
            selected ? { backgroundColor: palette.ink, boxShadow: `0 0 0 1px ${palette.ink}` } : { boxShadow: `0 0 0 1px ${palette.border}` }
          ]}
        >
          {selected && <Check size={14} color={palette.inkForeground} strokeWidth={3} />}
        </View>
      </Pressable>
    )
  const toggleFavourite = async () => {
    const next = !contact.favourite
    await contacts.setFavourite(contact.identityKey, next)
    showToast(next ? `${first(contact)} added to favourites` : `${first(contact)} removed from favourites`, { type: 'success' })
  }
  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => router.push({ pathname: '/contacts/[key]', params: { key: contact.identityKey } })}
        accessibilityRole="button"
        style={({ pressed }) => [styles.rowMain, pressed && { backgroundColor: palette.secondary + '99' }]}
      >
        {body}
      </Pressable>
      {confirming ? (
        // are you sure? in place of the actions
        <Animated.View style={[styles.actions, enter({ opacity: 0, scale: 0.95, duration: 150 })]}>
          <Pressable
            onPress={() => {
              setConfirming(false)
              onDelete()
            }}
            accessibilityRole="button"
            style={[styles.deletePill, { backgroundColor: palette.destructive }]}
          >
            <Text style={[font(600), styles.xs, { color: '#ffffff' }]}>Delete</Text>
          </Pressable>
          <IconButton label="Keep contact" onPress={() => setConfirming(false)}>
            <X size={16} color={palette.mutedForeground} />
          </IconButton>
        </Animated.View>
      ) : (
        <View style={styles.actions}>
          <IconButton label={`Pay ${contact.name}`} onPress={() => router.push({ pathname: '/send', params: { to: contact.identityKey } })}>
            <ArrowUpRight size={16} color={palette.mutedForeground} />
          </IconButton>
          <IconButton label={`Rename ${contact.name}`} onPress={onRename}>
            <Pencil size={16} color={palette.mutedForeground} />
          </IconButton>
          <IconButton
            label={contact.favourite ? `Remove ${contact.name} from favourites` : `Add ${contact.name} to favourites`}
            selected={contact.favourite}
            onPress={() => void toggleFavourite()}
          >
            <Star size={16} color={contact.favourite ? palette.gold : palette.mutedForeground} fill={contact.favourite ? palette.gold : 'none'} />
          </IconButton>
          <IconButton label={`Delete ${contact.name}`} onPress={() => setConfirming(true)}>
            <Trash2 size={16} color={palette.mutedForeground} />
          </IconButton>
        </View>
      )}
    </View>
  )
}

function IconButton({ label, onPress, selected, children }: { label: string; onPress: () => void; selected?: boolean; children: React.ReactNode }) {
  const palette = usePalette()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      style={({ pressed }) => [styles.icon, pressed && { backgroundColor: palette.secondary }]}
    >
      {children}
    </Pressable>
  )
}

/** Give a contact your own name for them. Only you see it. */
function RenameSheet({ contact, onClose, onSave }: { contact: Contact | null; onClose: () => void; onSave: (c: Contact, name: string) => Promise<void> }) {
  const palette = usePalette()
  const [name, setName] = useState('')
  const [seeded, setSeeded] = useState<string | null>(null)
  if (contact && seeded !== contact.identityKey) {
    setSeeded(contact.identityKey)
    setName(contact.name)
  }
  // what they were called before you first renamed them (only then is there
  // anything to reset to)
  const originals = usePrefs().contactOriginalNames
  const original = contact ? (originals[contact.identityKey] ?? null) : null
  const remember = (key: string, was: string | null) => {
    const next = { ...getPrefs().contactOriginalNames }
    if (was === null) delete next[key]
    else next[key] = was
    setPref('contactOriginalNames', next)
  }
  const save = async () => {
    const next = name.trim()
    if (!contact || !next) return
    await onSave(contact, next)
    // the first rename keeps the name it had; renamed back to it, nothing's left to reset
    if (next === original) remember(contact.identityKey, null)
    else if (original === null && next !== contact.name) remember(contact.identityKey, contact.name)
    showToast('Contact renamed', { type: 'success', description: `Now shown as ${next}.` })
    onClose()
  }
  const reset = async () => {
    if (!contact || !original) return
    await onSave(contact, original)
    remember(contact.identityKey, null)
    showToast(`Name reset to ${original}`, { type: 'success' })
    setSeeded(null)
    onClose()
  }
  return (
    <BottomSheet
      open={contact !== null}
      onOpenChange={o => {
        if (!o) {
          setSeeded(null)
          onClose()
        }
      }}
      title="Rename contact"
      description="Only you see this name."
    >
      <TextInput
        value={name}
        onChangeText={setName}
        onSubmitEditing={() => void save()}
        autoFocus
        accessibilityLabel="Name"
        style={[font(400), styles.input, { color: palette.foreground, backgroundColor: palette.card, boxShadow: `0 0 0 1px ${palette.border}` }]}
      />
      <GlassButton size="lg" label="Save" disabled={!name.trim()} onPress={() => void save()} />
      {contact && original && contact.name !== original && (
        <Pressable onPress={() => void reset()} accessibilityRole="button" style={styles.reset}>
          <Text style={[font(600), styles.small, { color: palette.mutedForeground }]}>Reset to {original}</Text>
        </Pressable>
      )}
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  pad: { paddingHorizontal: 16, gap: 16 },
  flex: { flex: 1, minWidth: 0 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  round: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  ghost: { width: 32, height: 32, borderRadius: radii.lg, alignItems: 'center', justifyContent: 'center' },
  half: { opacity: 0.5 },
  reset: { alignSelf: 'center', paddingVertical: 6, paddingHorizontal: 12 },
  textButton: { height: 32, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 999 },
  search: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: radii['2xl'], paddingHorizontal: 14 },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  tabs: { flexDirection: 'row' },
  tab: { flex: 1, alignItems: 'center', paddingBottom: 6 },
  tabText: { fontSize: 16, lineHeight: 24 },
  tabBar: { position: 'absolute', left: 0, right: 0, bottom: -2, height: 2, borderRadius: 1 },
  list: { paddingHorizontal: 8, paddingTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: radii.xl, paddingRight: 4 },
  rowPad: { paddingHorizontal: 12, paddingVertical: 12, gap: 12 },
  rowMain: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radii.xl, paddingHorizontal: 12, paddingVertical: 12 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  icon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  deletePill: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6 },
  pick: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', gap: 16, paddingHorizontal: 16, paddingVertical: 32 },
  center: { textAlign: 'center', alignSelf: 'stretch' },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 },
  batch: { position: 'absolute', left: 16, right: 16, gap: 8, borderRadius: radii['2xl'], padding: 8 },
  batchHead: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 8, paddingTop: 2 },
  batchButtons: { flexDirection: 'row', gap: 8 },
  batchButton: { flex: 1, height: 32, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 999 },
  input: { height: 48, borderRadius: 16, paddingHorizontal: 16, fontSize: 15 }
})
