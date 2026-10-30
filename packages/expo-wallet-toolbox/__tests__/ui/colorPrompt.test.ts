/**
 * Consent copy for the BRC-207 color module's `requestTokenAccess` messages.
 * The `color_send` / `color_signature` fixtures use exactly the field names
 * of the vendored module's `transactionConsent` / `actionConsent`
 * (@bsv/color-permission-module 0.2.0 dist/index.mjs). Amounts are canonical
 * decimal strings (IC §0) and must render exactly above 2^53.
 */
import { describeColorRequest } from '../../ui/components/ui/colorPrompt'

const USDX = 'a'.repeat(64) + '_0'
const GOLD = 'b'.repeat(64) + '_0'
const SIGNER = '02' + 'c'.repeat(64)
const t = (key: string) => key
const info = (assetId: string) =>
  assetId === USDX ? { ticker: 'USDX', decimals: 2 } : assetId === GOLD ? { ticker: 'GOLD', decimals: 0 } : undefined

function leg(assetId: string, fields: Record<string, string | number | string[]> = {}) {
  return {
    assetId,
    operations: ['transfer'],
    inputAmount: '0',
    foreignAmount: '0',
    authorityInputs: 0,
    foreignAuthorityInputs: 0,
    keptAmount: '0',
    keptAuthorities: 0,
    outgoingAmount: '0',
    outgoingAuthorities: 0,
    transferred: '0',
    burned: '0',
    minted: '0',
    ...fields
  }
}

/** A recorded `color_send` (actionConsent) for one USDX leg of 2^64-1 units. */
function sendMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: 'color_send',
    handoff: true,
    seekPermission: true,
    assets: [
      leg(USDX, {
        inputAmount: '18446744073709551615',
        outgoingAmount: '18446744073709551615',
        transferred: '18446744073709551615'
      })
    ],
    destinations: [
      {
        outputIndex: 0,
        satoshis: 1,
        lockingScript: '76a914' + '00'.repeat(20) + '88ac',
        assetId: USDX,
        role: 'value',
        amount: '18446744073709551615'
      }
    ],
    satoshis: { inputs: 1001, outputs: 1, fee: 1000 },
    signatures: [{ outpoint: 'd'.repeat(64) + '.0', inputIndex: 0, sighashType: 65 }],
    lockTime: 0,
    ...overrides
  }
}

const values = (view: ReturnType<typeof describeColorRequest>) => view!.lines.map(line => line.value)
const labels = (view: ReturnType<typeof describeColorRequest>) => view!.lines.map(line => line.label)

describe('describeColorRequest', () => {
  it('renders a 2^64-1 color_send leg exactly at dec 2', () => {
    const view = describeColorRequest(JSON.stringify(sendMessage()), info, t)
    expect(view).not.toBeNull()
    expect(view!.type).toBe('color_send')
    expect(view!.title).toBe('color_prompt_send_title')
    expect(values(view)).toContain('184467440737095516.15 USDX')
    // The full asset id is always shown (IC §2.5), never truncated.
    expect(values(view)).toContain(USDX)
    expect(view!.warning).toBeUndefined()
  })

  it('shows every asset leg of a multi-asset send', () => {
    const message = sendMessage({
      assets: [
        leg(USDX, { inputAmount: '2600', outgoingAmount: '2500', keptAmount: '100', transferred: '2600' }),
        leg(GOLD, { inputAmount: '9000', outgoingAmount: '9000', transferred: '9000' })
      ],
      destinations: []
    })
    const view = describeColorRequest(JSON.stringify(message), info, t)
    expect(values(view)).toEqual(expect.arrayContaining([USDX, GOLD, '25 USDX', '1 USDX', '9000 GOLD']))
    expect(labels(view)).toContain('Kept as change')
  })

  it('omits the Kept as change line when nothing is kept', () => {
    const view = describeColorRequest(JSON.stringify(sendMessage()), info, t)
    expect(labels(view)).not.toContain('Kept as change')
  })

  it('shows burned and minted supply changes', () => {
    const message = sendMessage({
      assets: [leg(USDX, { inputAmount: '500', burned: '500', operations: ['burn'] })],
      destinations: []
    })
    const view = describeColorRequest(JSON.stringify(message), info, t)
    expect(view!.lines).toContainEqual({ label: 'Burned', value: '5 USDX' })
  })

  it('falls back to exact base units when the asset has no metadata', () => {
    const unknown = 'e'.repeat(64) + '_0'
    const message = sendMessage({
      assets: [leg(unknown, { inputAmount: '18446744073709551615', outgoingAmount: '18446744073709551615' })],
      destinations: []
    })
    const view = describeColorRequest(JSON.stringify(message), info, t)
    expect(values(view)).toContain('18446744073709551615 units')
    expect(values(view)).toContain(unknown)
  })

  it('renders a color_signature with its input', () => {
    const message = { ...sendMessage(), type: 'color_signature', inputIndex: 2 }
    delete (message as Record<string, unknown>).handoff
    const view = describeColorRequest(JSON.stringify(message), info, t)
    expect(view!.type).toBe('color_signature')
    expect(view!.title).toBe('color_prompt_signature_title')
    expect(values(view)).toContain('184467440737095516.15 USDX')
    expect(view!.lines).toContainEqual({ label: 'Signs input', value: '2' })
  })

  it('renders color_access and color_relinquish', () => {
    const access = describeColorRequest(
      JSON.stringify({ type: 'color_access', basket: 'p color assets', seekPermission: true }),
      info,
      t
    )
    expect(access!.title).toBe('color_prompt_access_title')
    expect(values(access)).toContain('p color assets')

    const outpoint = 'f'.repeat(64) + '.3'
    const relinquish = describeColorRequest(
      JSON.stringify({ type: 'color_relinquish', assetId: USDX, role: 'value', outpoint, seekPermission: true }),
      info,
      t
    )
    expect(relinquish!.title).toBe('color_prompt_relinquish_title')
    expect(values(relinquish)).toEqual(expect.arrayContaining([USDX, outpoint]))
  })

  it.each([
    ['malformed JSON', '{'],
    ['an unknown type', JSON.stringify({ type: 'color_mint' })],
    ['a JSON number amount', JSON.stringify(sendMessage({ assets: [leg(USDX, { outgoingAmount: 5 as never })] }))],
    ['a non-canonical amount', JSON.stringify(sendMessage({ assets: [leg(USDX, { outgoingAmount: '007' })] }))],
    ['a missing assets array', JSON.stringify({ ...sendMessage(), assets: undefined })],
    ['a bad asset id', JSON.stringify(sendMessage({ assets: [leg('USDX', { outgoingAmount: '1' })] }))],
    [
      // B7 removed the module's offline-credit prompt: it is an unknown type now.
      'the removed color_receive_offline type',
      JSON.stringify({
        type: 'color_receive_offline',
        assetId: USDX,
        outputs: [{ outputIndex: 0, amount: '1500' }],
        unsettledTransactions: 1,
        signers: []
      })
    ]
  ])('returns null for %s', (_label, message) => {
    expect(describeColorRequest(message, info, t)).toBeNull()
  })
})
