/**
 * The native app must look like the designer's prototype: colours come from
 * the generated tokens (scripts/sync-design-tokens.mjs) and the prototype's
 * typefaces are embedded. Native config cannot import the TS tokens, so these
 * checks keep its copies in step.
 */
import fs from 'fs'
import path from 'path'
import { dark, light } from '../src/theme/tokens'

const appDir = path.resolve(__dirname, '..')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = require('../app.config.js')()
const plugin = (name: string) => config.plugins.find((p: unknown) => (Array.isArray(p) ? p[0] : p) === name)

test('splash backgrounds are the prototype page backgrounds', () => {
  const [, splash] = plugin('expo-splash-screen')
  expect(splash.backgroundColor).toBe(light.background)
  expect(splash.dark.backgroundColor).toBe(dark.background)
})

test('Nunito (400–900) and Caveat (600, 700) are embedded and present', () => {
  const [, fonts] = plugin('expo-font')
  const families = Object.fromEntries(
    fonts.android.fonts.map((f: { fontFamily: string; fontDefinitions: { weight: number }[] }) => [
      f.fontFamily,
      f.fontDefinitions.map(d => d.weight)
    ])
  )
  expect(families).toEqual({ Nunito: [400, 500, 600, 700, 800, 900], Caveat: [600, 700] })
  for (const file of fonts.ios.fonts) expect(fs.existsSync(path.join(appDir, file))).toBe(true)
})
