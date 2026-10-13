// Free generated handles, as the prototype's lib/handle-generator.ts:
// <adjective><animal><2 digits>, e.g. "sneakyotter07".
import { ADJECTIVES, ANIMALS } from './words'

const ADJ_SET = new Set<string>(ADJECTIVES)
const ANIMAL_SET = new Set<string>(ANIMALS)

/** Uniform random integer in [0, max), from the platform CSPRNG, without modulo bias. */
function randomInt(max: number): number {
  const limit = Math.floor(2 ** 32 / max) * max
  const buf = new Uint32Array(1)
  while (true) {
    globalThis.crypto.getRandomValues(buf)
    if (buf[0] < limit) return buf[0] % max
  }
}

export interface GeneratedHandle {
  handle: string
  adjective: string
  animal: string
}

/** A fresh handle, avoiding any in `taken` (case-insensitively). */
export function generateHandle(taken: string[] = []): GeneratedHandle {
  const lower = new Set(taken.map(t => t.toLowerCase()))
  while (true) {
    const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)]
    const animal = ANIMALS[randomInt(ANIMALS.length)]
    const handle = `${adjective}${animal}${randomInt(100).toString().padStart(2, '0')}`
    if (!lower.has(handle)) return { handle, adjective, animal }
  }
}

/** "Sneaky Otter": the display name that goes with a generated handle. */
export const generatedName = ({ adjective, animal }: GeneratedHandle) =>
  `${adjective[0].toUpperCase()}${adjective.slice(1)} ${animal[0].toUpperCase()}${animal.slice(1)}`

/** True if `name` has the exact shape of a generated handle (custom handles can't). */
export function isGeneratedPattern(name: string): boolean {
  const m = /^([a-z]+)(\d{2})$/.exec(name.toLowerCase())
  if (!m) return false
  const letters = m[1]
  for (let i = 1; i < letters.length; i++) {
    if (ADJ_SET.has(letters.slice(0, i)) && ANIMAL_SET.has(letters.slice(i))) return true
  }
  return false
}
