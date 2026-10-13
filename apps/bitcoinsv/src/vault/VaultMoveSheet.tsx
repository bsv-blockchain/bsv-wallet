// Move money (the prototype's components/vault-move-sheet.tsx), on the shared
// core's vault transfers: one sheet, Into the vault or Out of it, a big
// amount, and the button that says what happens. BitcoinSV only, and money
// out goes back to this wallet's spending (decision 14), so there is no
// currency or counterpart to pick.
//
// What runs is the core's VaultTransferScreen's, step for step and in its
// order (ui/screens/VaultTransferScreen.tsx):
// - In: the recovery phrase must have been kept (readBackupAttestation), Sync
//   must be on (the vault's key records live in it), the first deposit into
//   an empty vault is confirmed with the keys that will hold it, then
//   depositToVault. No hardware.
// - Out: which key you'll tap, a preview of what that key can open (nothing
//   reserved), the remainder rule (a leftover under the floor goes too, after
//   asking), the lock limit, then withdrawFromVault. That's where the key's
//   PIN and touch come in, on the core's own ceremony sheet at the root, so
//   this sheet steps aside first (it would sit on top of it).
// Confirmations are the phone's own alerts, which show above a sheet.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { ArrowDownToLine, ArrowRight, ArrowUpFromLine } from 'lucide-react-native'
import {
  R1C_LOCK_LEN,
  VAULT_DEPOSIT_MIN,
  VAULT_MAX_KEYS,
  VaultError,
  depositToVault,
  estimateRelockFee,
  getBackupUrl,
  getOnline,
  isBackupPushEnabled,
  isVaultAvailable,
  previewVaultWithdrawal,
  readBackupAttestation,
  sounds,
  useWallet,
  vaultStore,
  withdrawFromVault,
  type VaultMeta,
  type VaultWallet
} from '@bsv/expo-wallet-toolbox'
import { useSpendableBalance, useVaultBalance, vaultErrorCopy, vaultKeyLabel } from '@bsv/expo-wallet-toolbox/ui'
import { showToast } from '../ui/Toast'
import { expectVaultBalance } from '@bsv/expo-wallet-toolbox/ui/hooks/useVaultBalance'
import i18n from '@bsv/expo-wallet-toolbox/core/i18n/translations'
import { useRouter } from 'expo-router'
import { font, usePalette } from '../theme'
import { BottomSheet } from '../ui/BottomSheet'
import { GlassButton } from '../ui/GlassButton'
import { BsvMark } from '../ui/BsvMark'
import { bsvFigure } from '../activity/format'

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string
const SATS_PER_BSV = 100_000_000

/** The phone's own alert, as a choice: true for the action, false for cancel. */
const ask = (title: string, message: string, action: string) =>
  new Promise<boolean>(resolve =>
    Alert.alert(title, message, [
      { text: t('vault_cancel'), style: 'cancel', onPress: () => resolve(false) },
      { text: action, onPress: () => resolve(true) }
    ])
  )
const tell = (title: string, message: string) =>
  new Promise<void>(resolve => Alert.alert(title, message, [{ text: t('vault_ok'), onPress: () => resolve() }]))

export type MoveDirection = 'in' | 'out'

export function VaultMoveSheet({
  open,
  onOpenChange,
  direction: initial = 'in'
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  direction?: MoveDirection
}) {
  const palette = usePalette()
  const router = useRouter()
  const { managers, adminOriginator, selectedNetwork, storage, activeProfile } = useWallet()
  const { balance, refresh } = useVaultBalance()
  const spendable = useSpendableBalance()
  const [direction, setDirection] = useState<MoveDirection>(initial)
  const [raw, setRaw] = useState('')
  const [all, setAll] = useState(false)
  const [meta, setMeta] = useState<VaultMeta | null>(null)
  const [serial, setSerial] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)

  // each time it opens: the direction asked for, a clean amount, the keys as they are
  useEffect(() => {
    if (!open) return
    setDirection(initial)
    setRaw('')
    setAll(false)
    setError(null)
    let alive = true
    void vaultStore.getMeta().then(m => {
      if (!alive) return
      setMeta(m)
      // as the core: restored keys only once proved; the last one used, else the first
      const eligible = m?.recovery?.required ? m.keys.filter(k => m.recovery!.adoptedSerials.includes(k.serial)) : (m?.keys ?? [])
      setSerial((eligible.find(k => k.serial === m?.lastUsedSerial) ?? eligible[0])?.serial)
    })
    return () => {
      alive = false
    }
  }, [open, initial])

  const pm = managers.permissionsManager
  const isIn = direction === 'in'
  const allKeys = useMemo(() => meta?.keys ?? [], [meta])
  const keys = useMemo(
    () => (meta?.recovery?.required ? allKeys.filter(k => meta.recovery!.adoptedSerials.includes(k.serial)) : allKeys),
    [meta, allKeys]
  )
  const chosen = keys.find(k => k.serial === serial)
  const allNames = keys.map(vaultKeyLabel).join(', ')
  const released = isVaultAvailable(selectedNetwork, activeProfile)
  const backupConfigured = getBackupUrl() !== ''
  const depositFee = estimateRelockFee(0, R1C_LOCK_LEN(Math.min(VAULT_MAX_KEYS, Math.max(1, allKeys.length))))
  const overLockLimit = allKeys.length > VAULT_MAX_KEYS
  const blocked = !!meta?.pendingRemoval

  const n = parseFloat(raw)
  const sats = Number.isFinite(n) && n > 0 ? Math.round(n * SATS_PER_BSV) : 0
  const total = balance ?? 0
  const available = isIn ? spendable : total
  const amountOk = isIn ? sats >= VAULT_DEPOSIT_MIN && (spendable === null || sats + depositFee <= spendable) : all || (sats > 0 && sats <= total)
  const canRun = !!pm && balance !== null && !busy && !blocked && amountOk && (isIn ? released && !overLockLimit : !!chosen)
  const amountText = all ? 'everything' : `${bsvFigure(sats)} BSV`

  const privateBackupEnabled = useCallback(async () => {
    if (!backupConfigured) return false
    try {
      return await isBackupPushEnabled()
    } catch {
      return false
    }
  }, [backupConfigured])

  const run = async () => {
    if (!pm || !canRun || running.current) return
    running.current = true
    const w = pm as unknown as VaultWallet
    // set once this sheet has stepped aside for the key
    let handedOff = false
    setError(null)
    try {
      if (isIn) {
        // the phrase that alone can recover a vault must have been kept
        if (!(await readBackupAttestation(pm, adminOriginator))) {
          if (await ask(t('vault_seed_not_preserved_title'), t('vault_seed_not_preserved_body'), t('vault_seed_not_preserved_cta'))) {
            onOpenChange(false)
            router.push('/settings?backup=1')
          }
          return
        }
        if (!(await privateBackupEnabled())) {
          if (backupConfigured && (await ask(t('vault_backup_off_title'), t('vault_backup_off_body'), t('vault_backup_off_cta')))) {
            onOpenChange(false)
            router.push('/settings?backup=1')
          } else if (!backupConfigured) await tell(t('vault_backup_off_title'), t('vault_backup_off_body'))
          return
        }
        // the first deposit is when the recovery model becomes real money
        if (total === 0) {
          const ok = await ask(
            t('vault_first_deposit_title'),
            t('vault_first_deposit_body', { amount: `${bsvFigure(sats)} BSV`, count: keys.length, names: allNames }),
            t('vault_deposit_cta')
          )
          if (!ok) return
        }
        setBusy(true)
        await depositToVault(w, adminOriginator, sats, { isOnline: getOnline, backupEnabled: privateBackupEnabled })
        expectVaultBalance(total + sats)
        sounds.vaultDeposit()
        showToast(`Moved ${bsvFigure(sats)} BSV into your vault`, { type: 'success' })
        onOpenChange(false)
      } else {
        if (!chosen) return
        let everything = all
        // what this key can open: a read, nothing reserved or tapped
        const preview = await previewVaultWithdrawal(w, adminOriginator, chosen.serial, everything ? 'all' : sats)
        const remainder = preview.selectedTotal - (everything ? preview.selectedTotal : sats)
        // a leftover under the floor can't stay vaulted: it comes out too, after asking
        if (!everything && remainder > 0 && remainder < VAULT_DEPOSIT_MIN) {
          const ok = await ask(
            t('vault_remainder_title'),
            t('vault_remainder_body', { amount: `${bsvFigure(sats)} BSV`, remainder: `${bsvFigure(remainder)} BSV` }),
            t('vault_remainder_all')
          )
          if (!ok) return
          everything = true
        }
        if (overLockLimit && !everything && remainder >= VAULT_DEPOSIT_MIN) {
          setError(vaultErrorCopy('too-many-active-keys'))
          return
        }
        setBusy(true)
        // the key's PIN and touch come next, on the core's ceremony sheet: this one steps aside
        onOpenChange(false)
        handedOff = true
        const result = await withdrawFromVault(
          w,
          adminOriginator,
          everything ? 'all' : sats,
          t('vault_withdraw_reason', { amount: everything ? total : sats }),
          chosen.serial,
          {
            findSpendingReferences: storage ? outpoints => storage.findSpendingReferences(outpoints) : undefined,
            isOnline: getOnline,
            backupEnabled: privateBackupEnabled
          }
        )
        sounds.vaultWithdraw()
        const moved = everything ? Math.max(0, total - result.unreachable.satoshis) : sats
        expectVaultBalance(Math.max(0, total - moved))
        // what did NOT move is said in alerts, not toasts: there's something to do about it
        let reported = false
        if (result.unreachable.count > 0) {
          reported = true
          await tell(
            t('vault_unreachable_title'),
            t('vault_unreachable_body', {
              moved: `${bsvFigure(moved)} BSV`,
              count: result.unreachable.count,
              amount: `${bsvFigure(result.unreachable.satoshis)} BSV`,
              names: result.unreachable.keys.map(k => keys.find(r => r.pubkey === k.pubkey || r.serial === k.serial)?.nickname ?? `…${k.pubkey.slice(-4)}`).join(', ')
            })
          )
        }
        if (result.cappedInputs > 0) {
          reported = true
          await tell(t('vault_withdraw_done'), t('vault_withdraw_partial', { count: result.cappedInputs }))
        }
        if (!reported) showToast(`Moved ${bsvFigure(moved)} BSV to spending`, { type: 'success' })
      }
      refresh()
    } catch (e) {
      const code = e instanceof VaultError ? e.code : undefined
      const message = vaultErrorCopy(code, { nickname: chosen ? vaultKeyLabel(chosen) : undefined, names: allNames || undefined })
      // still open: said in the sheet; after it stepped aside for the key: a toast
      if (handedOff) showToast(message, { type: 'error' })
      else setError(message)
    } finally {
      setBusy(false)
      running.current = false
    }
  }

  const label = busy
    ? isIn
      ? 'Moving…'
      : 'Waiting for your key…'
    : isIn
      ? sats
        ? `Move ${bsvFigure(sats)} BSV into vault`
        : 'Enter an amount'
      : all || sats
        ? `Take ${amountText} out`
        : 'Enter an amount'

  return (
    <BottomSheet open={open} onOpenChange={o => !busy && onOpenChange(o)} title="Move money">
      {/* Into / Out of */}
      <View style={[styles.segments, { backgroundColor: palette.secondary }]}>
        {(['in', 'out'] as const).map(d => {
          const on = direction === d
          const Icon = d === 'in' ? ArrowDownToLine : ArrowUpFromLine
          return (
            <Pressable
              key={d}
              onPress={() => {
                setDirection(d)
                setAll(false)
                setError(null)
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={[styles.segment, on && { backgroundColor: palette.background, boxShadow: '0 1px 3px rgba(0,0,0,0.12)' }]}
            >
              <Icon size={15} color={on ? palette.foreground : palette.mutedForeground} />
              <Text style={[font(600), styles.small, { color: on ? palette.foreground : palette.mutedForeground }]}>{d === 'in' ? 'Into vault' : 'Out of vault'}</Text>
            </Pressable>
          )
        })}
      </View>

      {/* from where to where */}
      <View style={styles.route}>
        <Text style={[font(600), styles.xs, { color: palette.mutedForeground }]}>{isIn ? 'SPENDING' : 'VAULT'}</Text>
        <ArrowRight size={13} color={palette.mutedForeground} />
        <Text style={[font(600), styles.xs, { color: palette.mutedForeground }]}>{isIn ? 'VAULT' : 'SPENDING'}</Text>
      </View>

      {/* how much */}
      <View style={styles.amountRow}>
        <TextInput
          value={all ? bsvFigure(total) : raw}
          onChangeText={v => {
            setAll(false)
            setRaw(v.replace(/[^0-9.]/g, ''))
          }}
          placeholder="0"
          placeholderTextColor={palette.mutedForeground + '80'}
          keyboardType="decimal-pad"
          accessibilityLabel="Amount in BSV"
          style={[font(800), styles.amount, { color: palette.foreground }]}
        />
        <BsvMark size={34} />
      </View>
      <View style={styles.under}>
        <Text style={[font(400), styles.xs, { color: palette.mutedForeground }]}>
          {isIn ? 'Spending' : 'In your vault'}: {available === null ? '…' : `${bsvFigure(available)} BSV`}
        </Text>
        {/* everything out (money in leaves the fee, so it's typed) */}
        {!isIn && total > 0 && (
          <Pressable onPress={() => setAll(true)} accessibilityRole="button" style={[styles.all, { backgroundColor: all ? palette.ink : palette.secondary }]}>
            <Text style={[font(600), styles.xs, { color: all ? palette.inkForeground : palette.foreground }]}>All</Text>
          </Pressable>
        )}
      </View>
      {isIn && (
        <Text style={[font(400), styles.xs, styles.note, { color: palette.mutedForeground }]}>
          At least {bsvFigure(VAULT_DEPOSIT_MIN)} BSV. The network fee is about {bsvFigure(depositFee)} BSV.
        </Text>
      )}

      {/* out: which key you'll tap */}
      {!isIn && keys.length > 1 && (
        <View style={styles.keys}>
          <Text style={[font(600), styles.xs, { color: palette.mutedForeground }]}>KEY YOU’LL TAP</Text>
          <View style={styles.keyRow}>
            {keys.map(k => {
              const on = k.serial === serial
              return (
                <Pressable
                  key={k.serial}
                  onPress={() => setSerial(k.serial)}
                  disabled={busy}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  style={[styles.keyChip, { backgroundColor: on ? palette.ink : palette.secondary }]}
                >
                  <Text style={[font(600), styles.xs, { color: on ? palette.inkForeground : palette.foreground }]}>{vaultKeyLabel(k)}</Text>
                </Pressable>
              )
            })}
          </View>
        </View>
      )}

      {(error || blocked || (isIn && !released)) && (
        <Text style={[font(500), styles.xs, styles.note, { color: palette.destructive }]}>
          {error ??
            (blocked
              ? 'A key is being removed. Finish that in Keys and recovery first.'
              : selectedNetwork !== 'main'
                ? 'Money goes into the vault on mainnet only.'
                : 'The vault is on the first wallet on this phone only.')}
        </Text>
      )}

      <GlassButton size="lg" label={label} disabled={!canRun} onPress={() => void run()} />
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  segments: { flexDirection: 'row', borderRadius: 999, padding: 3 },
  segment: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 999, paddingVertical: 8 },
  route: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingTop: 4 },
  amountRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  // no lineHeight on a big TextInput: iOS clips the tops of the figures to it
  amount: { minWidth: 40, fontSize: 48, height: 62, letterSpacing: -1.2, padding: 0, textAlign: 'center', fontVariant: ['tabular-nums', 'lining-nums'] },
  under: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  all: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
  note: { textAlign: 'center', alignSelf: 'stretch' },
  keys: { gap: 8 },
  keyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  keyChip: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  small: { fontSize: 14, lineHeight: 20 },
  xs: { fontSize: 12, lineHeight: 16 }
})
