import { shouldReleaseUtxo } from '../../core/walletRepair/shouldReleaseUtxo'

const spent = { status: 'success' as const, isUtxo: false }
const base = { online: true, txStatus: 'completed', txid: 'aa', liveOfflineTxids: new Set<string>(), probe: spent }

it('releases only on a confirmed spent probe while online', () => {
  expect(shouldReleaseUtxo(base)).toBe(true)
})
it.each([
  { online: false },
  { txStatus: 'nosend' },
  { txStatus: 'unproven' },
  { liveOfflineTxids: new Set(['aa']) },
  { probe: { status: 'error' as const } },
  { probe: { status: 'success' as const, isUtxo: true } }
])('does not release %#', extra => {
  expect(shouldReleaseUtxo({ ...base, ...extra })).toBe(false)
})
