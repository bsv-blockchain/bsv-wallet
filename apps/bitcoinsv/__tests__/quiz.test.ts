import { Mnemonic } from '@bsv/sdk'
import { quizFor } from '../src/backup/quiz'

const words = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ')

describe('quizFor', () => {
  it('asks one word from each third of the phrase', () => {
    for (let run = 0; run < 50; run++) {
      const quiz = quizFor(words)
      expect(quiz.map(q => Math.floor(q.index / 4))).toEqual([0, 1, 2])
    }
  })

  it('offers the right word beside two different BIP39 decoys not in the phrase', () => {
    const list = new Set(new Mnemonic().Wordlist.value)
    for (let run = 0; run < 50; run++) {
      for (const q of quizFor(words)) {
        expect(q.options).toHaveLength(3)
        expect(new Set(q.options).size).toBe(3)
        expect(q.options).toContain(words[q.index])
        const decoys = q.options.filter(o => o !== words[q.index])
        decoys.forEach(d => {
          expect(words).not.toContain(d)
          expect(list.has(d)).toBe(true)
        })
      }
    }
  })
})
