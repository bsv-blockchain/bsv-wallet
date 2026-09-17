/**
 * The token activity row's title: normally the fixed "Sent/Received <ticker>"
 * template, overridden by the sender's own note — for a nearby-rail action
 * (label 'localpay', fixed wording "Sent/Received token") and for a
 * message-box/mandala-lib action (label 'transfer'/'receive', fixed wording
 * "Send/Receive N of assetId"). An action from neither rail never has its
 * description shown, whatever it says — the lib can write an opaque
 * developer string there (see ActivityRow's original comment) and there is
 * no way to tell that apart from a note without a recognised rail marker.
 */
import { tokenRowTitle } from '../../ui/screens/tokenRowTitle'

const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${Object.values(values).join('|')}` : key

const ASSET_ID = '615a06ab' + 'cd'.repeat(28) + '.0'

describe('tokenRowTitle — nearby rail (label localpay)', () => {
  it('uses the fixed ticker template for a nearby row with no note', () => {
    expect(
      tokenRowTitle({ role: 'sent', ticker: 'USDX', labels: ['localpay', 'mandala'], description: 'Sent token', t })
    ).toBe('token_row_sent:USDX')
    expect(
      tokenRowTitle({ role: 'received', ticker: 'USDX', labels: ['localpay', 'mandala'], description: 'Received token', t })
    ).toBe('token_row_received:USDX')
  })

  it('prefers the sender’s note over the ticker template for a nearby sent row', () => {
    expect(
      tokenRowTitle({ role: 'sent', ticker: 'USDX', labels: ['localpay', 'mandala'], description: 'lunch split', t })
    ).toBe('lunch split')
  })

  it('prefers the sender’s note over the ticker template for a nearby received row', () => {
    expect(
      tokenRowTitle({ role: 'received', ticker: 'USDX', labels: ['localpay', 'mandala'], description: 'thanks!', t })
    ).toBe('thanks!')
  })

  it('falls back to the ticker template when there is no description at all', () => {
    expect(tokenRowTitle({ role: 'sent', ticker: 'USDX', labels: ['localpay'], t })).toBe('token_row_sent:USDX')
  })
})

describe('tokenRowTitle — message-box rail (label transfer/receive, @bsv/mandala)', () => {
  it('uses the fixed ticker template when the description is the lib’s own fixed wording', () => {
    expect(
      tokenRowTitle({
        role: 'sent',
        ticker: 'USDX',
        labels: ['mandala', 'transfer'],
        description: `Send 4000 of ${ASSET_ID}`,
        assetId: ASSET_ID,
        baseUnits: 4000,
        t
      })
    ).toBe('token_row_sent:USDX')
    expect(
      tokenRowTitle({
        role: 'received',
        ticker: 'USDX',
        labels: ['mandala', 'receive'],
        description: `Receive 4000 of ${ASSET_ID}`,
        assetId: ASSET_ID,
        baseUnits: 4000,
        t
      })
    ).toBe('token_row_received:USDX')
  })

  it('prefers the sender’s note over the fixed wording', () => {
    expect(
      tokenRowTitle({
        role: 'received',
        ticker: 'USDX',
        labels: ['mandala', 'receive'],
        description: 'thanks!',
        assetId: ASSET_ID,
        baseUnits: 4000,
        t
      })
    ).toBe('thanks!')
  })

  it('never shows the raw description for an action from neither rail — the lib’s dev-string case', () => {
    expect(
      tokenRowTitle({
        role: 'received',
        ticker: 'USDX',
        labels: ['mandala'],
        description: `Receive 4000 of ${ASSET_ID}`,
        assetId: ASSET_ID,
        baseUnits: 4000,
        t
      })
    ).toBe('token_row_received:USDX')
  })

  it('never shows a message-box description when assetId/baseUnits are unavailable to reconstruct the fixed wording', () => {
    expect(
      tokenRowTitle({ role: 'sent', ticker: 'USDX', labels: ['mandala', 'transfer'], description: 'lunch split', t })
    ).toBe('token_row_sent:USDX')
  })
})
