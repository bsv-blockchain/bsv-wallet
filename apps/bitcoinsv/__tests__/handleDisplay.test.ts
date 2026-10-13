import { bareHandle, detailLabel, handleLabel, isHandle, matchesSearch, ownDomains } from '../src/contacts/handles'

const own = ownDomains('deggen.com')

describe('handles as they are written', () => {
  it('is @name in this wallet’s own space', () => {
    expect(handleLabel('rosa@bitcoinsv.com', own)).toBe('@rosa')
    expect(handleLabel('rosa@deggen.com', own)).toBe('@rosa')
    expect(handleLabel('@rosa', own)).toBe('@rosa')
  })
  it('carries another wallet’s domain, short or in full', () => {
    expect(handleLabel('rosa@handcash.io', own)).toBe('@rosa@handcash')
    expect(handleLabel('rosa@handcash.io', own, { qualified: true })).toBe('@rosa@handcash.io')
  })
  it('only rewrites lines that are handles', () => {
    expect(isHandle('rosa@bitcoinsv.com')).toBe(true)
    expect(isHandle('@rosa')).toBe(true)
    expect(detailLabel('Identity key · 02ab…cd', own)).toBe('Identity key · 02ab…cd')
    expect(detailLabel('Address · 1Abc…xyz', own)).toBe('Address · 1Abc…xyz')
    expect(detailLabel('rosa@bitcoinsv.com', own)).toBe('@rosa')
  })
  it('finds the bare name in any form', () => {
    expect(bareHandle('@rosa@bitcoinsv.com')).toBe('rosa')
  })
})

describe('searching for people', () => {
  const rosa = { name: 'Rosa Martínez', handle: 'rosa@bitcoinsv.com' }
  it('finds them by name', () => {
    expect(matchesSearch(rosa, 'martí')).toBe(true)
  })
  it('finds them by handle, with or without the @', () => {
    expect(matchesSearch(rosa, '@rosa')).toBe(true)
    expect(matchesSearch(rosa, 'ros')).toBe(true)
    expect(matchesSearch(rosa, '@rosa@bitcoinsv.com')).toBe(true)
    expect(matchesSearch(rosa, 'rosa@bitcoinsv')).toBe(true)
  })
  it('finds another wallet’s handle by its short form', () => {
    expect(matchesSearch({ name: 'R', handle: 'rosa@handcash.io' }, '@rosa@handcash')).toBe(true)
  })
  it('doesn’t match a lone @, or someone else', () => {
    expect(matchesSearch(rosa, '@')).toBe(false)
    expect(matchesSearch(rosa, '@dee')).toBe(false)
    expect(matchesSearch({ name: 'No handle' }, '@rosa')).toBe(false)
  })
})
