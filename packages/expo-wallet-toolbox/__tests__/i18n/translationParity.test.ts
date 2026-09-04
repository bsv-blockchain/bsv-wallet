import { resources } from '../../core/i18n/translations'

type Translation = Record<string, string>

const english = resources.en.translation as Translation
const englishKeys = Object.keys(english)
const otherLanguages = Object.keys(resources).filter(code => code !== 'en')

// Strings that are deliberately identical to English: product names, network
// names, loanwords a language actually uses, and pure format strings.
const allowedUntranslated: Record<string, string[]> = {
  teratest: ['*'],
  mainnet: ['*'],
  testnet: ['*'],
  settings_version: ['*'],
  vault_ok: ['fr', 'pt', 'id', 'ja', 'pl'],
  bookmark: ['id'],
  browser: ['id'],
  configuration: ['fr'],
  transactions: ['fr'],
  note: ['fr'],
  tx_action_refresh_short: ['id', 'pl']
}

const placeholders = (value: string): string[] => [...value.matchAll(/{{(\w+)}}/g)].map(match => match[1]).sort()

const isAllowedUntranslated = (key: string, language: string): boolean => {
  const allowed = allowedUntranslated[key]
  return !!allowed && (allowed.includes('*') || allowed.includes(language))
}

describe('translation parity', () => {
  it.each(otherLanguages)('%s has exactly the English key set', language => {
    const translation = resources[language as keyof typeof resources].translation as Translation
    const keys = Object.keys(translation)
    expect(englishKeys.filter(key => !(key in translation))).toEqual([])
    expect(keys.filter(key => !(key in english))).toEqual([])
  })

  it.each(otherLanguages)('%s keeps the same interpolation placeholders', language => {
    const translation = resources[language as keyof typeof resources].translation as Translation
    const mismatched = englishKeys.filter(
      key => placeholders(english[key]).join(',') !== placeholders(translation[key]).join(',')
    )
    expect(mismatched).toEqual([])
  })

  it.each(otherLanguages)('%s has no copy left in English', language => {
    const translation = resources[language as keyof typeof resources].translation as Translation
    const untranslated = englishKeys.filter(
      key => translation[key] === english[key] && !isAllowedUntranslated(key, language)
    )
    expect(untranslated).toEqual([])
  })
})
