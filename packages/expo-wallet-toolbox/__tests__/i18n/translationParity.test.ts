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
  tx_action_refresh_short: ['id', 'pl'],
  contacts: ['fr'],
  pay_step_contacts: ['fr'],
  pay_review_note: ['fr'],
  contact_identifier: ['id'],
  profile_handle: ['id'],
  // Acronym and Apple product name, kept as-is where the language does.
  security_pin: ['*'],
  security_biometrics: ['*']
}

const placeholders = (value: string): string[] => [...value.matchAll(/{{(\w+)}}/g)].map(match => match[1]).sort()

const isAllowedUntranslated = (key: string, language: string): boolean => {
  const allowed = allowedUntranslated[key]
  return !!allowed && (allowed.includes('*') || allowed.includes(language))
}

// The word a language uses for a handle is the one on its `profile_handle`
// field label — Alias, Pseudo, Apelido, Юзернейм — and the copy around that
// field has to keep saying it. Several languages spend their word for
// "identifier" on the Identifier (the identity key, two sections down the same
// screen), so a handle line that borrows that word names the wrong thing. The
// checks above cannot see it: such a value is present, placeholder-correct and
// not English.
const handleNounKeys = [
  'profile_handle_unavailable',
  'profile_handle_registered',
  'profile_handle_changed',
  'profile_handle_rejected',
  'profile_handle_replace_warning',
  'profile_display_name_hint',
  'contact_handle_caption'
]

// And the handle's own status lines must not borrow the Identifier's word back
// the other way. `profile_handle_registered_hint` is excluded on purpose: it
// really does say the handle is registered to your Identifier.
const identifierFreeKeys = [
  'profile_handle_available',
  'profile_handle_taken',
  'profile_handle_invalid',
  'profile_handle_failed',
  'profile_handle_too_similar',
  'profile_handle_reserved',
  'profile_handle_cooldown',
  'profile_handle_pending',
  'profile_handle_rolled_back',
  'profile_handle_changed',
  'profile_handle_rejected',
  'profile_display_name_hint'
]

const languages = Object.keys(resources)

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

  it.each(languages)('%s names the handle with its own word for it', language => {
    const translation = resources[language as keyof typeof resources].translation as Translation
    const handleNoun = translation.profile_handle.toLowerCase()
    expect(handleNounKeys.filter(key => !translation[key].toLowerCase().includes(handleNoun))).toEqual([])
  })

  it.each(languages)('%s keeps the Identifier out of the handle status lines', language => {
    const translation = resources[language as keyof typeof resources].translation as Translation
    const identifierNoun = translation.contact_identifier.toLowerCase()
    expect(identifierFreeKeys.filter(key => translation[key].toLowerCase().includes(identifierNoun))).toEqual([])
  })
})
