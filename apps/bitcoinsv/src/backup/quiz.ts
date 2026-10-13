// The backup check (the prototype's quizFor in lib/recovery.ts): one word
// from each third of the phrase, each offered beside two decoys from the
// BIP39 list, shuffled so the right answer moves around.
import { Mnemonic } from '@bsv/sdk'

export interface QuizItem {
  /** the word's position, 0-based */
  index: number
  options: string[]
}

let WORDS: string[] | null = null
const bip39 = () => (WORDS ??= new Mnemonic().Wordlist.value)

export function quizFor(words: string[], random: () => number = Math.random): QuizItem[] {
  const list = bip39()
  const third = Math.floor(words.length / 3)
  return [0, third, third * 2].map(start => {
    const index = start + Math.floor(random() * third)
    const decoys: string[] = []
    while (decoys.length < 2) {
      const w = list[Math.floor(random() * list.length)]
      if (!words.includes(w) && !decoys.includes(w)) decoys.push(w)
    }
    const options = [words[index], ...decoys]
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[options[i], options[j]] = [options[j], options[i]]
    }
    return { index, options }
  })
}
