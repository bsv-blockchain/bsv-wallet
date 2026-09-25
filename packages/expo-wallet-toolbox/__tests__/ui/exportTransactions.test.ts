/**
 * XR-078: a remote PeerPay/nearby-payment sender's note is stored verbatim
 * (trimmed, length-capped) as the recipient's action `description`
 * (core/pay/rails/handle.ts, core/localpay/pending.ts) and later flows
 * straight into the exported CSV's `description` column through
 * `csvEscape`, which only quotes for commas/quotes/newlines — never
 * neutralizing a leading `=`, `+`, `-`, `@`, tab or CR. A note crafted as a
 * formula (e.g. `=1+1`, `@SUM(...)`) becomes a live spreadsheet cell in any
 * formula-evaluating application that opens the exported file (OWASP CSV
 * injection).
 */
const mockEvents: { write?: string } = {}

jest.mock('expo-secure-store', () => require('../__mocks__/secureStoreFake').fake)
jest.mock('expo-local-authentication', () => require('../__mocks__/localAuthFake').fake)

jest.mock('expo-file-system', () => {
  class File {
    uri: string
    constructor(...parts: unknown[]) {
      this.uri = parts.map(p => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/')
    }
    get exists() {
      return false
    }
    write(bytes: string) {
      mockEvents.write = bytes
    }
    delete() {}
  }
  class Directory {
    uri: string
    constructor(...parts: unknown[]) {
      this.uri = parts.map(p => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/')
    }
    get exists() {
      return false
    }
    create() {}
    delete() {}
  }
  return { File, Directory, Paths: { cache: { uri: '/cache' } } }
})
jest.mock('expo-sharing', () => ({ shareAsync: async () => undefined }))

import { exportTransactionsAsCsv } from '../../ui/exportTransactions'

function walletWithDescription(description: string) {
  return {
    listActions: jest.fn(async ({ offset }: { offset: number }) => {
      if (offset > 0) return { totalActions: 1, actions: [] }
      return {
        totalActions: 1,
        actions: [
          {
            txid: 'a'.repeat(64),
            satoshis: 1000,
            isOutgoing: false,
            status: 'completed',
            description,
            labels: [],
            outputs: []
          }
        ]
      }
    })
  } as never
}

beforeEach(() => {
  delete mockEvents.write
})

describe('exportTransactionsAsCsv (XR-078)', () => {
  it('neutralizes a description that begins with a formula-triggering character before writing the CSV', async () => {
    await exportTransactionsAsCsv(walletWithDescription('=1+1'), null, 'admin')

    expect(mockEvents.write).toBeDefined()
    const lines = (mockEvents.write as string).split('\n')
    // header, one data row, trailing blank from the final '\n'
    expect(lines.length).toBeGreaterThanOrEqual(2)
    const dataRow = lines[1]
    const descriptionCell = dataRow.split(',')[2]
    // Never a raw formula character as the cell's own first character.
    expect(/^[=+\-@]/.test(descriptionCell)) .toBe(false)
    // The OWASP-recommended neutralization: force literal-text interpretation
    // with a leading apostrophe, so the original content is still visible
    // (and still round-trips) rather than silently dropped.
    expect(descriptionCell.startsWith("'=1+1")).toBe(true)
  })

  it.each(['+1+1', '-1+1', '@SUM(A1:A9)', '\t=1+1', '\r=1+1'])(
    'neutralizes %j the same way',
    async (raw) => {
      await exportTransactionsAsCsv(walletWithDescription(raw), null, 'admin')
      const dataRow = (mockEvents.write as string).split('\n')[1]
      const descriptionCell = dataRow.split(',')[2]
      expect(/^[=+\-@\t\r]/.test(descriptionCell)).toBe(false)
    }
  )

  it('leaves an ordinary description untouched', async () => {
    await exportTransactionsAsCsv(walletWithDescription('Coffee with Alice'), null, 'admin')
    const dataRow = (mockEvents.write as string).split('\n')[1]
    const descriptionCell = dataRow.split(',')[2]
    expect(descriptionCell).toBe('Coffee with Alice')
  })
})
