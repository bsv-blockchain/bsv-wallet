/**
 * XQ-013: kek.ts's provisionKek()/destroyKek() delete-then-add pattern is
 * commented as "never blind-write" to guarantee a clean slate before the
 * next write. That guarantee only holds on iOS. The vendored
 * expo-secure-store Android module's plain item-delete path
 * (deleteItemImpl -> removeItem) never calls into the AndroidKeyStore to
 * drop the underlying hardware-backed wrapping key — only setItemImpl's
 * KeyPermanentlyInvalidatedException retry branch does that — so a
 * delete-then-add cycle on Android silently reuses the pre-existing hardware
 * key instead of rotating it, contrary to what an uncorrected comment would
 * suggest.
 *
 * This is not unit-testable against real Android/iOS Keystore/Keychain
 * behavior in this repo's Jest harness (no native module, no OS to run
 * against) — the concrete missing evidence is an on-device check, which
 * needs real hardware. What IS testable, and load-bearing for the corrected
 * comment in kek.ts staying honest, is that the vendored dependency's own
 * source still has the asymmetry this finding is about. This test reads the
 * exact vendored file kek.ts's comment relies on and fails loudly if a
 * future `expo-secure-store` bump changes that shape — at which point the
 * comment (and this finding) need re-checking, not silent staleness.
 */
import fs from 'node:fs'
import path from 'node:path'

const MODULE_PATH = path.join(
  __dirname,
  '../../../../node_modules/expo-secure-store/android/src/main/java/expo/modules/securestore/SecureStoreModule.kt'
)

function readModuleSource(): string {
  return fs.readFileSync(MODULE_PATH, 'utf8')
}

/** The body of a named Kotlin function/method, up to (but excluding) the next
 * top-level `private fun` / `fun` declaration at the same indentation. */
function extractFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  if (start === -1) throw new Error(`could not find ${JSON.stringify(signature)} in vendored SecureStoreModule.kt`)
  const nextFun = source.indexOf('\n  private fun ', start + signature.length)
  const nextFun2 = source.indexOf('\n  fun ', start + signature.length)
  const candidates = [nextFun, nextFun2].filter(i => i !== -1)
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length
  return source.slice(start, end)
}

describe('XQ-013: vendored expo-secure-store Android delete path does not rotate the Keystore key', () => {
  it('deleteItemImpl never touches the AndroidKeyStore entry', () => {
    const source = readModuleSource()
    const body = extractFunctionBody(source, 'private fun deleteItemImpl(')

    expect(body).not.toMatch(/removeKeyFromKeystore/)
    expect(body).not.toMatch(/keyStore\.deleteEntry/)
  })

  it('removeKeyFromKeystore (the one call that DOES rotate the key) is reachable only from setItemImpl\'s invalidated-key retry, not from a plain delete', () => {
    const source = readModuleSource()
    const setItemBody = extractFunctionBody(source, 'private suspend fun setItemImpl(')

    // The only production call site of removeKeyFromKeystore in this module.
    expect(setItemBody).toMatch(/removeKeyFromKeystore\(/)
    // ...and it is gated on keyIsInvalidated, i.e. only reached via the
    // KeyPermanentlyInvalidatedException retry, never a plain write or delete.
    expect(setItemBody).toMatch(/if \(keyIsInvalidated\) \{[\s\S]*?removeKeyFromKeystore\(/)
  })
})
