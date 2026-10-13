import { selector, type ExportChoice } from '../src/settings/exportSelect'

const NOW = new Date(2026, 9, 10, 12) // Oct 10 2026, local
const choice = (over: Partial<ExportChoice>): ExportChoice => ({ period: 'all', from: '', to: '', type: 'all', ...over })
const at = (y: number, m: number, d: number, out = false) => ({ created_at: new Date(y, m - 1, d, 9).toISOString(), isOutgoing: out })

describe('what an export takes', () => {
  it('keeps one direction when asked', () => {
    expect(selector(choice({ type: 'received' }), NOW)(at(2026, 10, 1, true))).toBe(false)
    expect(selector(choice({ type: 'sent' }), NOW)(at(2026, 10, 1, true))).toBe(true)
  })

  it('takes the last 30 days and this year from today', () => {
    expect(selector(choice({ period: '30d' }), NOW)(at(2026, 9, 12))).toBe(true)
    expect(selector(choice({ period: '30d' }), NOW)(at(2026, 9, 9))).toBe(false)
    expect(selector(choice({ period: 'year' }), NOW)(at(2026, 1, 1))).toBe(true)
    expect(selector(choice({ period: 'year' }), NOW)(at(2025, 12, 31))).toBe(false)
  })

  it('takes a custom range’s days whole, and an open end as open', () => {
    const range = selector(choice({ period: 'custom', from: '2026-10-03', to: '2026-10-05' }), NOW)
    expect(range(at(2026, 10, 3))).toBe(true)
    expect(range(at(2026, 10, 5))).toBe(true)
    expect(range(at(2026, 10, 6))).toBe(false)
    expect(selector(choice({ period: 'custom' }), NOW)(at(2020, 1, 1))).toBe(true)
  })
})

describe('the export’s file name', () => {
  const { exportFileName } = require('../src/settings/exportSelect') as typeof import('../src/settings/exportSelect')
  const now = new Date(2026, 9, 12, 15, 30)
  const choice = (p: Partial<import('../src/settings/exportSelect').ExportChoice>) => ({ period: 'all' as const, from: '', to: '', type: 'all' as const, ...p })
  it('starts with the day it was made, then the app and what’s in it', () => {
    expect(exportFileName(choice({}), 'csv', now)).toBe('261012-bitcoinsv-wallet-payments.csv')
    expect(exportFileName(choice({ type: 'sent' }), 'pdf', now)).toBe('261012-bitcoinsv-wallet-sent.pdf')
  })
  it('says the period, unless it’s all time', () => {
    expect(exportFileName(choice({ period: '30d', type: 'received' }), 'csv', now)).toBe('261012-bitcoinsv-wallet-received-last-30-days.csv')
    expect(exportFileName(choice({ period: 'year' }), 'pdf', now)).toBe('261012-bitcoinsv-wallet-payments-2026.pdf')
    expect(exportFileName(choice({ period: 'custom', from: '2026-10-01', to: '2026-10-12' }), 'pdf', now)).toBe('261012-bitcoinsv-wallet-payments-261001-to-261012.pdf')
    expect(exportFileName(choice({ period: 'custom', from: '2026-10-01' }), 'csv', now)).toBe('261012-bitcoinsv-wallet-payments-261001.csv')
    expect(exportFileName(choice({ period: 'custom', to: '2026-10-05' }), 'csv', now)).toBe('261012-bitcoinsv-wallet-payments-to-261005.csv')
  })
})
