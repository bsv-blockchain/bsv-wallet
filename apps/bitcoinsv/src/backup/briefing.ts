// The briefing before a key is shown (the prototype's components/key-briefing):
// one point per screen, each acknowledged with a button that fills over four
// seconds first, so each one is actually read. The last screen leads on to
// the device check and the reveal.

/** What's being shown: the 12 words, or the key in three slices. */
export type KeyKind = 'phrase' | 'slices'

/** How long each briefing button takes to fill before it can be tapped. */
export const FILL_MS = 4000

/** How long to press before the key shows. */
export const HOLD_MS = 1200

export interface BriefCard {
  title: string
  body: string
  button: string
  /** the promise it adds to the checklist before the reveal */
  promise?: string
}

export function briefing(kind: KeyKind): BriefCard[] {
  const it = kind === 'phrase' ? 'your recovery phrase' : 'your key slices'
  const It = kind === 'phrase' ? 'Your recovery phrase' : 'Your key slices'
  return [
    {
      title: 'Is your screen private?',
      body: 'Be somewhere private, on your own phone. No cameras, no screen sharing, and no one helping you.',
      button: 'My screen is private',
      promise: 'Keep your screen private'
    },
    {
      title: kind === 'phrase' ? 'What is a recovery phrase?' : 'What are key slices?',
      body:
        kind === 'phrase'
          ? '12 words that are your wallet. Whoever has them can open it and everything in it. Protect them like money.'
          : 'Your wallet’s key, split in three. Any two of them open your wallet and everything in it. Protect them like money.',
      button: 'I understand',
      promise: kind === 'phrase' ? 'Protect your phrase' : 'Protect your slices'
    },
    {
      title: 'Anyone with it can take your money',
      body: `If someone gets ${it}, they can move everything out of your wallet. Nobody can stop it or undo it.`,
      button: 'I understand'
    },
    {
      title: 'Never share it',
      body: `Not with friends, family, or anyone saying they’re support. Bitcoin SV Wallet will never ask for ${it}.`,
      button: 'I understand',
      promise: 'Never share it'
    },
    {
      title: 'Write it down',
      body:
        kind === 'phrase'
          ? 'On paper. Don’t take a screenshot, and don’t save it on your phone or computer.'
          : 'Each slice on its own paper, kept in different places. Don’t take screenshots or save them digitally.',
      button: 'I understand',
      promise: 'Write it down, not digitally'
    },
    {
      title: 'Don’t lose it',
      body: `${It} ${kind === 'phrase' ? 'is' : 'are'} the way back if you lose this phone. Lose both, and your money is gone for good: nobody can recover it.`,
      button: 'I understand',
      promise: 'Don’t lose it'
    },
    {
      title: 'Ready?',
      body: `You know what ${it} ${kind === 'phrase' ? 'is' : 'are'}, the risks, and how to keep ${kind === 'phrase' ? 'it' : 'them'} safe.`,
      button: 'Let’s go'
    }
  ]
}

/** The briefing's last screen (the same number of screens for phrase and slices). */
export const BRIEF_LAST = briefing('phrase').length - 1
