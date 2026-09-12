# Vault Enrollment Step Flow + In-App PIV Reset — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split vault YubiKey enrollment into one decision per page with a visible four-step progress bar, supply the factory PIN and PUK below the UI, generate the recovery code instead of asking for one, and let a previously used YubiKey be reset in place instead of being a dead end.

**Architecture:** The wizard's `key` step grows two new sub-steps (`puk`, `reset`) and its single four-field credential page becomes two single-purpose pages. No change to `enrollKey`'s signature — the wizard supplies `'123456'` / `'12345678'` to the existing callbacks. A new nitro method `resetPivApplication` and a new service module `core/services/vault/pivReset.ts` add the reset path, guarded so a key already in the vault meta can never be reset.

**Tech Stack:** React Native (Expo), TypeScript strict, Nitro modules (nitrogen 0.35.10), YubiKit iOS 4.4.1 (`YKFPIVSession`), yubikit-android 3.1.0 (`PivSession`), Jest (preset `jest-expo`), i18next with 12 languages.

**Spec:** `docs/superpowers/specs/2026-09-12-vault-enrollment-step-flow-design.md`

## Global Constraints

- **Node:** the shell default is v12.0.0, which prettier and jest refuse to run under. Every command below must be preceded by `export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"` in that shell.
- **Verification bar:** `npm test`, `npx tsc --noEmit`, `npm run lint`. A task is not done until all three pass for the files it touched. There is no CI running these — verification is entirely local.
- **`npm run fix` before every commit** (repo CONTRIBUTING convention).
- **Commit style:** short, imperative, lowercase. Example: `add recovery code page to vault enrollment`.
- **Prettier:** `semi: false`, `singleQuote: true`, `trailingComma: "none"`, `arrowParens: "avoid"`, `printWidth: 120`, `tabWidth: 2`.
- **12 languages, exact parity:** `en, zh, hi, es, fr, ar, pt, bn, ru, id, ja, pl`. Every new key must appear in all 12 blocks, with the same `{{placeholder}}` set and a value that is **not** byte-identical to English. Entries indent 6 spaces; a continuation line indents 8. Keys unquoted, values single-quoted, trailing comma except on a block's last entry.
- **Key order is not identical across language blocks.** Locate an insertion point by anchor key name, never by line offset.
- **Never run `nitro-codegen`.** The only regen path is `cd packages/react-native-yubikey && npx nitrogen`, run from inside the package. `nitrogen/generated/**` is committed (26 tracked files).
- **Do not trust `.claude/worktrees/`.** Three full checkouts live there with diverged copies of these files. Jest ignores them; root `tsc` does not.
- **PIV codes are 6–8 ASCII digits** (`/^[0-9]{6,8}$/`), enforced in native, service and UI.
- **A PIV reset is irreversible and destroys every credential on the key.** The enrolled-serial refusal in Task 5 is safety-critical and must never be made overridable.

---

## Baseline: the tree is already red

`npx jest packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts` on `master` at `8b39aeb` reports **22 failed, 11 passed**. This is pre-existing, caused by commit `637a508` adding `vault_replace_key_warning` and `vault_replace_key_confirm` to the `en` block only. Task 1 fixes it. Do not start any other task until Task 1 is green, or you will not be able to tell your own breakage apart from this.

## File Structure

| File | Responsibility |
|---|---|
| `packages/react-native-yubikey/src/specs/YubiKeyPiv.nitro.ts` | Cross-language contract. Gains `resetPivApplication`. |
| `packages/react-native-yubikey/nitrogen/generated/**` | Generated glue. Regenerated, never hand-edited. |
| `packages/react-native-yubikey/ios/HybridYubiKeyPiv.swift` | iOS impl. Gains `resetPivApplication` with a watchdog. |
| `packages/react-native-yubikey/android/.../HybridYubiKeyPiv.kt` | Android impl. Gains `resetPivApplication` with bio-key mapping. |
| `packages/expo-wallet-toolbox/core/services/vault/driver.ts` | The single hardware seam. Gains the interface member and the native adapter line. |
| `packages/expo-wallet-toolbox/core/services/vault/mockYubiKey.ts` | Software driver for tests. Gains `resetPivApplication` + test controls. |
| `packages/expo-wallet-toolbox/core/services/vault/pivReset.ts` | **New.** One exported function, all reset guards. Kept out of `VaultKeyService.ts` (864 lines, owns the enrollment state machine). |
| `packages/expo-wallet-toolbox/core/services/vault/VaultKeyService.ts` | Preflight hoist + `details.serial` on four error codes. |
| `packages/expo-wallet-toolbox/core/index.ts` | Re-export the new module. |
| `packages/expo-wallet-toolbox/ui/components/vault/EnrollWizard.tsx` | The page split, the progress bar, the generated PUK, the reset page. |
| `packages/expo-wallet-toolbox/core/i18n/translations.tsx` | 19 new keys + 2 backfills × 12 languages. |

---

## Task 1: Green the translation parity baseline

Two keys exist only in `en`, which fails the parity suite's first assertion for all 11 other languages. Nothing else can be verified until this is fixed.

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/i18n/translations.tsx`
- Test: `packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts` (existing, unchanged)

**Interfaces:**
- Consumes: nothing.
- Produces: a green parity suite, which every later i18n task depends on.

- [ ] **Step 1: Run the test to see the pre-existing failure**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx jest packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts
```

Expected: FAIL — `Tests: 22 failed, 11 passed, 33 total`, with `zh has exactly the English key set` reporting `["vault_replace_key_warning", "vault_replace_key_confirm"]`.

- [ ] **Step 2: Confirm the two keys are English-only**

```bash
grep -n "vault_replace_key_warning\|vault_replace_key_confirm" packages/expo-wallet-toolbox/core/i18n/translations.tsx
```

Expected: exactly two hits, lines 380 and 382, both inside the `en` block.

- [ ] **Step 3: Add both keys to the 11 non-English blocks**

In each language block, insert immediately after that block's `vault_err_slot_occupied` entry (find it by name — key order differs per language). Values:

```
zh:
      vault_replace_key_warning:
        '替换它将永久销毁现有的 P-256 私钥。任何需要该密钥的保险库资金可能变得无法花费。',
      vault_replace_key_confirm: '替换现有密钥',
hi:
      vault_replace_key_warning:
        'इसे बदलने पर मौजूदा P-256 निजी कुंजी स्थायी रूप से नष्ट हो जाएगी। उस कुंजी पर निर्भर वॉल्ट राशि अख़र्च योग्य हो सकती है।',
      vault_replace_key_confirm: 'मौजूदा कुंजी बदलें',
es:
      vault_replace_key_warning:
        'Sustituirla destruye de forma permanente la clave privada P-256 existente. Los fondos de la caja fuerte que necesiten esa clave podrían volverse inutilizables.',
      vault_replace_key_confirm: 'Sustituir la clave existente',
fr:
      vault_replace_key_warning:
        'La remplacer détruit définitivement la clé privée P-256 existante. Les fonds du coffre qui dépendent de cette clé pourraient devenir indépensables.',
      vault_replace_key_confirm: 'Remplacer la clé existante',
ar:
      vault_replace_key_warning:
        'استبدالها يدمّر نهائيًا مفتاح P-256 الخاص الحالي. قد تصبح أموال الخزنة التي تعتمد على ذلك المفتاح غير قابلة للإنفاق.',
      vault_replace_key_confirm: 'استبدال المفتاح الحالي',
pt:
      vault_replace_key_warning:
        'Substituí-la destrói permanentemente a chave privada P-256 existente. Os fundos do cofre que dependem dessa chave podem ficar impossíveis de gastar.',
      vault_replace_key_confirm: 'Substituir a chave existente',
bn:
      vault_replace_key_warning:
        'এটি প্রতিস্থাপন করলে বিদ্যমান P-256 প্রাইভেট কী স্থায়ীভাবে ধ্বংস হবে। সেই কীর উপর নির্ভরশীল ভল্টের তহবিল খরচের অযোগ্য হয়ে যেতে পারে।',
      vault_replace_key_confirm: 'বিদ্যমান কী প্রতিস্থাপন করুন',
ru:
      vault_replace_key_warning:
        'Замена безвозвратно уничтожит существующий закрытый ключ P-256. Средства хранилища, которым нужен этот ключ, могут стать непотратимыми.',
      vault_replace_key_confirm: 'Заменить существующий ключ',
id:
      vault_replace_key_warning:
        'Menggantinya akan menghancurkan kunci privat P-256 yang ada secara permanen. Dana brankas yang memerlukan kunci itu bisa menjadi tidak dapat dibelanjakan.',
      vault_replace_key_confirm: 'Ganti kunci yang ada',
ja:
      vault_replace_key_warning:
        '置き換えると既存の P-256 秘密鍵は完全に破棄されます。その鍵を必要とする保管庫の残高は使用できなくなる可能性があります。',
      vault_replace_key_confirm: '既存のキーを置き換える',
pl:
      vault_replace_key_warning:
        'Zastąpienie trwale niszczy istniejący klucz prywatny P-256. Środki w sejfie wymagające tego klucza mogą stać się niemożliwe do wydania.',
      vault_replace_key_confirm: 'Zastąp istniejący klucz',
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx jest packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts
```

Expected: PASS — `Tests: 33 passed, 33 total`.

- [ ] **Step 5: Commit**

```bash
npm run fix && git add packages/expo-wallet-toolbox/core/i18n/translations.tsx && git commit -m "translate vault key replacement copy into all languages"
```

---

## Task 2: Fix the two enrollment phases that render as raw keys

`EnrollPhase` emits `checking-slot` and `personalizing`; `EnrollWizard` renders `t('vault_enroll_phase_' + phase.replace(/-/g,'_'))`. Neither key exists, so the tap screen currently displays the literal strings `vault_enroll_phase_checking_slot` and `vault_enroll_phase_personalizing`. The progress work in Task 6 makes this screen more prominent, so fix it first.

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/i18n/translations.tsx`
- Test: `packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts`

**Interfaces:**
- Consumes: Task 1's green baseline.
- Produces: `vault_enroll_phase_checking_slot`, `vault_enroll_phase_personalizing`.

- [ ] **Step 1: Prove the keys are missing**

```bash
grep -c "vault_enroll_phase_checking_slot\|vault_enroll_phase_personalizing" packages/expo-wallet-toolbox/core/i18n/translations.tsx
```

Expected: `0`.

- [ ] **Step 2: Add both keys to all 12 blocks**

Insert after each block's `vault_enroll_phase_pin_check` entry (English is line 318; other languages differ — find by name).

```
en:
      vault_enroll_phase_checking_slot: 'Checking the vault slot…',
      vault_enroll_phase_personalizing: 'Setting your PIN and recovery code…',
zh:
      vault_enroll_phase_checking_slot: '正在检查保险库槽位…',
      vault_enroll_phase_personalizing: '正在设置您的 PIN 码和恢复码…',
hi:
      vault_enroll_phase_checking_slot: 'वॉल्ट स्लॉट जाँचा जा रहा है…',
      vault_enroll_phase_personalizing: 'आपका PIN और रिकवरी कोड सेट किया जा रहा है…',
es:
      vault_enroll_phase_checking_slot: 'Comprobando la ranura de la caja fuerte…',
      vault_enroll_phase_personalizing: 'Configurando tu PIN y código de recuperación…',
fr:
      vault_enroll_phase_checking_slot: 'Vérification de l’emplacement du coffre…',
      vault_enroll_phase_personalizing: 'Configuration de votre code PIN et de votre code de récupération…',
ar:
      vault_enroll_phase_checking_slot: 'جارٍ فحص خانة الخزنة…',
      vault_enroll_phase_personalizing: 'جارٍ ضبط رمز PIN ورمز الاسترداد…',
pt:
      vault_enroll_phase_checking_slot: 'A verificar a ranhura do cofre…',
      vault_enroll_phase_personalizing: 'A definir o seu PIN e código de recuperação…',
bn:
      vault_enroll_phase_checking_slot: 'ভল্ট স্লট পরীক্ষা করা হচ্ছে…',
      vault_enroll_phase_personalizing: 'আপনার PIN ও পুনরুদ্ধার কোড সেট করা হচ্ছে…',
ru:
      vault_enroll_phase_checking_slot: 'Проверка слота хранилища…',
      vault_enroll_phase_personalizing: 'Настройка PIN-кода и кода восстановления…',
id:
      vault_enroll_phase_checking_slot: 'Memeriksa slot brankas…',
      vault_enroll_phase_personalizing: 'Menyiapkan PIN dan kode pemulihan Anda…',
ja:
      vault_enroll_phase_checking_slot: '保管庫スロットを確認しています…',
      vault_enroll_phase_personalizing: 'PIN と復旧コードを設定しています…',
pl:
      vault_enroll_phase_checking_slot: 'Sprawdzanie gniazda sejfu…',
      vault_enroll_phase_personalizing: 'Ustawianie PIN-u i kodu odzyskiwania…',
```

- [ ] **Step 3: Verify parity still passes**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx jest packages/expo-wallet-toolbox/__tests__/i18n/translationParity.test.ts
```

Expected: PASS — 33 passed.

- [ ] **Step 4: Commit**

```bash
npm run fix && git add packages/expo-wallet-toolbox/core/i18n/translations.tsx && git commit -m "add missing enrollment phase copy for slot check and personalizing"
```

---

## Task 3: Native `resetPivApplication` on both platforms

Adding a method to the nitro spec makes the generated Kotlin `HybridYubiKeyPivSpec` declare a new `abstract fun`, which breaks the Android build until implemented. Spec, codegen and both implementations therefore land together.

**Files:**
- Modify: `packages/react-native-yubikey/src/specs/YubiKeyPiv.nitro.ts:36` (after `signEcdsa`)
- Modify: `packages/react-native-yubikey/ios/HybridYubiKeyPiv.swift` (after `signEcdsa`, before the `// MARK:` helpers)
- Modify: `packages/react-native-yubikey/android/src/main/java/com/margelo/nitro/yubikeypiv/HybridYubiKeyPiv.kt` (after `signEcdsa`, before `withPiv`)
- Modify (generated): `packages/react-native-yubikey/nitrogen/generated/**`

**Interfaces:**
- Consumes: nothing.
- Produces: `resetPivApplication(expectedSerial: string): Promise<string>` resolving `{"ok":true}`, consumed by Task 4.

**Facts this task is built on** (all verified against the sources on this machine):

- `YKFPIVSession.resetWithCompletion:` (`YKFPIVSession.m:555-572`) blocks the PIN, blocks the PUK, then sends `INS 0xFB`. It requires **no** prior `verifyPin:` or `authenticateWithManagementKey:`, and its header documents no precondition.
- **Hang risk (iOS).** `blockPuk:` drives `changeReference:`, which only invokes its completion when `retries >= 0` (`YKFPIVSession.m:781`). `getRetriesFromStatusCode:` returns `-1` for any status word outside `0x6983` and `0x63c0-0x63cf`. On such a word the completion is dropped, `resetWithCompletion:` never fires, and the Nitro promise hangs forever. `SettleGuard` guards double-settle, not never-settle — a watchdog is required.
- `PivSession.reset()` in `piv-3.1.0.jar` blocks PIN and PUK itself, then sends `Apdu(0, 0xFB, 0, 0, null)`. No authenticate, no verify.
- **Bio-key refusal (Android).** `reset()` throws `IllegalArgumentException("Cannot perform PIV reset when biometrics are configured")`. `IllegalArgumentException` is neither `ApduException` nor `IOException` nor `InvalidPinException`, so the existing `mapError` `else ->` branch would mislabel it `VAULT_ERR:wrong-key`. It needs an explicit branch.
- After a successful reset the Android session restores `currentPinAttempts = 3` in memory, so the card is back at factory PIN/PUK/management key.

- [ ] **Step 1: Add the spec method**

Append inside the `YubiKeyPiv` interface in `packages/react-native-yubikey/src/specs/YubiKeyPiv.nitro.ts`, after `signEcdsa`:

```ts
  /** Reset the whole PIV application to just-installed state. Destroys every
   * key, certificate and credential in it, Vault slot 0x82 included. Both
   * SDKs block the PIN and the PUK first — PIV requires both blocked before
   * RESET — so the card's retry counters are spent regardless of outcome.
   * Needs neither a verified PIN nor an authenticated management key. */
  resetPivApplication(expectedSerial: string): Promise<string> // JSON {ok:true}
```

- [ ] **Step 2: Regenerate the nitro glue**

```bash
cd /Users/personal/git/bsv-wallet/packages/react-native-yubikey && npx nitrogen
```

Expected output: `Nitrogen 0.35.10 runs at ./`, `Nitrogen found 1 spec in ./src/specs`, `Generating specs for HybridObject "YubiKeyPiv"...`.

- [ ] **Step 3: Verify the method reached all three generated surfaces**

```bash
cd /Users/personal/git/bsv-wallet && grep -rn "resetPivApplication" packages/react-native-yubikey/nitrogen/generated | cut -d: -f1 | sort -u
```

Expected: at minimum the Swift spec, the Kotlin spec and the shared C++ header.

- [ ] **Step 4: Implement on iOS**

Add to `packages/react-native-yubikey/ios/HybridYubiKeyPiv.swift`, after `signEcdsa`:

```swift
  func resetPivApplication(expectedSerial: String) throws -> Promise<String> {
    try Self.requireExpectedSerial(expectedSerial)
    let promise = Promise<String>()
    let settled = SettleGuard()
    withSession(promise) { session in
      self.withExpectedSerial(session, expectedSerial, promise) {
        // YubiKit's reset blocks the PIN, then the PUK, then sends RESET. It
        // needs no verified PIN and no management-key auth. But blockPuk's
        // changeReference: helper only calls its completion when the card's
        // status word maps to a retry count >= 0 (YKFPIVSession.m:781); any
        // other word drops the completion and this promise would never settle.
        // SettleGuard only prevents a DOUBLE settle, so add a watchdog: the JS
        // side must always get an answer, and the card is already unusable by
        // the time blockPuk runs.
        let watchdog = DispatchWorkItem {
          settled.reject(promise, Self.vaultError("nfc-lost", "PIV reset did not report completion"))
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: watchdog)
        session.reset { error in
          watchdog.cancel()
          if let error { return settled.reject(promise, Self.mapError(error)) }
          settled.resolve(promise, "{\"ok\":true}")
        }
      }
    }
    return promise
  }
```

- [ ] **Step 5: Implement on Android**

Add to `packages/react-native-yubikey/android/src/main/java/com/margelo/nitro/yubikeypiv/HybridYubiKeyPiv.kt`, after `signEcdsa`:

```kotlin
  override fun resetPivApplication(expectedSerial: String): Promise<String> {
    return withPiv { piv ->
      requireExpectedSerial(piv, expectedSerial)
      // PivSession.reset() blocks the PIN and the PUK itself, then sends
      // INS_RESET. It needs neither authenticate() nor verifyPin(). It refuses
      // outright on a key with biometrics configured, throwing a plain
      // IllegalArgumentException that mapError would otherwise report as
      // 'wrong-key'.
      try {
        piv.reset()
      } catch (e: IllegalArgumentException) {
        throw vaultError("template-invalid", e.message ?: "PIV reset refused by this YubiKey")
      }
      "{\"ok\":true}"
    }
  }
```

- [ ] **Step 6: Type-check the spec and the whole tree**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx tsc -p packages/react-native-yubikey --noEmit && npx tsc --noEmit
```

Expected: no new errors versus the baseline you recorded before starting.

- [ ] **Step 7: Commit**

```bash
npm run fix && git add packages/react-native-yubikey/src/specs/YubiKeyPiv.nitro.ts packages/react-native-yubikey/ios/HybridYubiKeyPiv.swift packages/react-native-yubikey/android/src/main/java/com/margelo/nitro/yubikeypiv/HybridYubiKeyPiv.kt packages/react-native-yubikey/nitrogen/generated && git commit -m "add piv application reset to the yubikey native module"
```

---

## Task 4: Driver seam and mock

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/services/vault/driver.ts` (interface ~line 69, native shape ~line 89, adapter ~line 192)
- Modify: `packages/expo-wallet-toolbox/core/services/vault/mockYubiKey.ts`
- Test: `packages/expo-wallet-toolbox/__tests__/vault/mockYubiKey.test.ts`

**Interfaces:**
- Consumes: the native `resetPivApplication` from Task 3.
- Produces: `VaultDriver.resetPivApplication(expectedSerial: string): Promise<{ ok: true }>`, and the mock controls `MockYubiKey.personalise(pin: string, puk: string)` and `MockYubiKey.isFactory(serial?: string)` used by Tasks 5 and 9.

- [ ] **Step 1: Write the failing test**

Append to `packages/expo-wallet-toolbox/__tests__/vault/mockYubiKey.test.ts`:

```ts
describe('MockYubiKey.resetPivApplication', () => {
  it('returns a personalised card to factory PIN, PUK and retry counters', async () => {
    const key = new MockYubiKey()
    key.insertKey('MOCK-RST')
    key.personalise('998877', '11112222')
    await expect(key.verifyPin('MOCK-RST', '123456')).resolves.toEqual({ ok: false, retriesLeft: 2 })

    await expect(key.resetPivApplication('MOCK-RST')).resolves.toEqual({ ok: true })

    expect(key.isFactory('MOCK-RST')).toBe(true)
    await expect(key.verifyPin('MOCK-RST', '123456')).resolves.toEqual({ ok: true, retriesLeft: 3 })
  })

  it('discards the generated slot key, so the card reads as empty afterwards', async () => {
    const key = new MockYubiKey()
    key.insertKey('MOCK-RST')
    await key.verifyPin('MOCK-RST', '123456')
    await key.generateVaultKey('MOCK-RST')
    await expect(key.readVaultPublicKey('MOCK-RST')).resolves.not.toBeNull()

    await key.resetPivApplication('MOCK-RST')

    await expect(key.readVaultPublicKey('MOCK-RST')).resolves.toBeNull()
  })

  it('refuses a serial other than the one presented', async () => {
    const key = new MockYubiKey()
    key.insertKey('MOCK-RST')
    await expect(key.resetPivApplication('MOCK-OTHER')).rejects.toMatchObject({ code: 'serial-mismatch' })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx jest packages/expo-wallet-toolbox/__tests__/vault/mockYubiKey.test.ts
```

Expected: FAIL — `key.personalise is not a function`.

- [ ] **Step 3: Add the interface member and the native adapter line**

In `driver.ts`, inside `interface VaultDriver`, after `protectManagementKey`:

```ts
  /** Reset the entire PIV application to factory state, destroying every key
   * and certificate in it — Vault slot 0x82 included. Both native SDKs block
   * the PIN and PUK before the RESET APDU, so the retry counters are spent
   * whatever the outcome. Never call this for a serial that is already an
   * enrolled vault key; see pivReset.ts. */
  resetPivApplication(expectedSerial: string): Promise<{ ok: true }>
```

In `interface NativeYubiKeyPiv`, after `protectManagementKey`:

```ts
  resetPivApplication(expectedSerial: string): Promise<string>
```

In the native adapter object, after the `protectManagementKey` line:

```ts
    resetPivApplication: serial => parse(native.resetPivApplication(serial)),
```

- [ ] **Step 4: Implement on the mock**

In `mockYubiKey.ts`, after `protectManagementKey`:

```ts
  async resetPivApplication(expectedSerial: string): Promise<{ ok: true }> {
    this.requireExpectedSerial(expectedSerial)
    // The real card blocks the PIN and PUK before RESET, so nothing here is
    // conditional on knowing either code — that is the whole point of reset.
    this.keys.set(expectedSerial, freshRecord())
    return { ok: true }
  }

  /** DEV/test control: drive a card away from factory state, the way a
   * YubiKey that has been used for something else arrives. */
  personalise(pin: string, puk: string): void {
    requirePivCode(pin, 'PIN')
    requirePivCode(puk, 'PUK')
    const r = this.record()
    r.pin = pin
    r.puk = puk
    r.managementProtected = true
  }

  /** DEV/test control: is this card in just-installed state? */
  isFactory(serial = this.serial): boolean {
    const r = this.keys.get(serial)
    if (!r) return false
    return (
      r.pin === DEFAULT_PIN &&
      r.puk === DEFAULT_PUK &&
      r.pinRetries === 3 &&
      r.pukRetries === 3 &&
      !r.managementProtected &&
      r.priv === null
    )
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx jest packages/expo-wallet-toolbox/__tests__/vault/mockYubiKey.test.ts
```

Expected: PASS, including the three new cases.

- [ ] **Step 6: Commit**

```bash
npm run fix && git add packages/expo-wallet-toolbox/core/services/vault/driver.ts packages/expo-wallet-toolbox/core/services/vault/mockYubiKey.ts packages/expo-wallet-toolbox/__tests__/vault/mockYubiKey.test.ts && git commit -m "expose piv application reset through the vault driver seam"
```

---

## Task 5: `pivReset.ts` — the guarded reset service

**Files:**
- Create: `packages/expo-wallet-toolbox/core/services/vault/pivReset.ts`
- Modify: `packages/expo-wallet-toolbox/core/index.ts:280` (add the re-export beside `VaultKeyService`)
- Test: `packages/expo-wallet-toolbox/__tests__/vault/pivReset.test.ts` (new)

**Interfaces:**
- Consumes: `VaultDriver.resetPivApplication` (Task 4), `withKeySession` from `./session`, `vaultStore.getMeta / discardEnrollmentDraft / discardEnrollmentQuarantine / assertScopeToken`.
- Produces:

```ts
export async function resetPivApplication(args: {
  serial: string
  refuseSerials?: readonly string[]
  acknowledgeDestroysAllCredentials: true
  scopeToken?: VaultScopeToken
  nfcMessage?: string
  onPhase?: (p: PivResetPhase) => void
}): Promise<void>

export type PivResetPhase = 'waiting' | 'resetting'
```

- [ ] **Step 1: Write the failing test**

Create `packages/expo-wallet-toolbox/__tests__/vault/pivReset.test.ts`:

```ts
import { resetPivApplication } from '../../core/services/vault/pivReset'
import { VaultError } from '../../core/services/vault/types'
import { MockYubiKey } from '../../core/services/vault/mockYubiKey'
import { setVaultDriverMock } from '../../core/services/vault/driver'
import { vaultStore } from '../../core/services/vault/vaultStore'

const SERIAL = 'MOCK-RST'
const record = (serial: string) => ({
  serial,
  pubkey: '02'.padEnd(66, 'a'),
  nickname: 'Desk',
  enrolledAt: 1
})

let key: MockYubiKey

beforeEach(() => {
  key = new MockYubiKey()
  key.insertKey(SERIAL)
  setVaultDriverMock(key)
  jest.spyOn(vaultStore, 'getMeta').mockResolvedValue(null)
  jest.spyOn(vaultStore, 'discardEnrollmentDraft').mockResolvedValue(undefined)
  jest.spyOn(vaultStore, 'discardEnrollmentQuarantine').mockResolvedValue(undefined)
})

afterEach(() => {
  setVaultDriverMock(null)
  jest.restoreAllMocks()
})

test('resets a used key and clears its draft and quarantine markers', async () => {
  key.personalise('998877', '11112222')

  await resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true })

  expect(key.isFactory(SERIAL)).toBe(true)
  expect(vaultStore.discardEnrollmentDraft).toHaveBeenCalledWith(SERIAL, expect.anything())
  expect(vaultStore.discardEnrollmentQuarantine).toHaveBeenCalledWith(SERIAL, expect.anything())
})

test('refuses without the destruction acknowledgement, before touching the card', async () => {
  const spy = jest.spyOn(key, 'resetPivApplication')
  await expect(
    // @ts-expect-error deliberately omitting the acknowledgement
    resetPivApplication({ serial: SERIAL })
  ).rejects.toMatchObject({ code: 'template-invalid' })
  expect(spy).not.toHaveBeenCalled()
})

test('refuses a serial that is already an enrolled vault key, before touching the card', async () => {
  jest.spyOn(vaultStore, 'getMeta').mockResolvedValue({ v: 5, createdAt: 1, keys: [record(SERIAL)] } as never)
  const spy = jest.spyOn(key, 'resetPivApplication')

  await expect(
    resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true })
  ).rejects.toMatchObject({ code: 'key-already-enrolled' })

  expect(spy).not.toHaveBeenCalled()
  expect(key.isFactory(SERIAL)).toBe(true)
})

test('refuses a serial listed in refuseSerials, before touching the card', async () => {
  const spy = jest.spyOn(key, 'resetPivApplication')

  await expect(
    resetPivApplication({
      serial: SERIAL,
      refuseSerials: [SERIAL],
      acknowledgeDestroysAllCredentials: true
    })
  ).rejects.toMatchObject({ code: 'key-already-enrolled' })

  expect(spy).not.toHaveBeenCalled()
})

test('refuses when a different card is presented for the reset tap', async () => {
  key.removeKey()
  key.insertKey('MOCK-OTHER')

  await expect(
    resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true })
  ).rejects.toMatchObject({ code: 'serial-mismatch' })

  expect(key.isFactory('MOCK-OTHER')).toBe(true)
})

test('refuses a structurally invalid serial', async () => {
  await expect(
    resetPivApplication({ serial: '', acknowledgeDestroysAllCredentials: true })
  ).rejects.toMatchObject({ code: 'template-invalid' })
})

test('re-checks the meta inside the session and refuses a key enrolled meanwhile', async () => {
  const getMeta = jest.spyOn(vaultStore, 'getMeta')
  getMeta.mockResolvedValueOnce(null)
  getMeta.mockResolvedValueOnce({ v: 5, createdAt: 1, keys: [record(SERIAL)] } as never)
  const spy = jest.spyOn(key, 'resetPivApplication')

  await expect(
    resetPivApplication({ serial: SERIAL, acknowledgeDestroysAllCredentials: true })
  ).rejects.toMatchObject({ code: 'key-already-enrolled' })

  expect(spy).not.toHaveBeenCalled()
  expect(getMeta).toHaveBeenCalledTimes(2)
})

test('reports its phases in order', async () => {
  const phases: string[] = []
  await resetPivApplication({
    serial: SERIAL,
    acknowledgeDestroysAllCredentials: true,
    onPhase: p => phases.push(p)
  })
  expect(phases).toEqual(['waiting', 'resetting'])
})
```

- [ ] **Step 2: Run it to verify it fails**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx jest packages/expo-wallet-toolbox/__tests__/vault/pivReset.test.ts
```

Expected: FAIL — `Cannot find module '../../core/services/vault/pivReset'`.

- [ ] **Step 3: Write the implementation**

Create `packages/expo-wallet-toolbox/core/services/vault/pivReset.ts`:

```ts
/**
 * Resetting a YubiKey's PIV application back to factory state.
 *
 * Kept out of VaultKeyService.ts on purpose: this is a destructive maintenance
 * operation with its own failure modes, not part of the enrollment state
 * machine. It runs in its own card session — never folded into an enrollment
 * tap — so a dropped session can never leave the enrollment quarantine
 * machinery in a state it was not designed for.
 *
 * SAFETY. A PIV reset destroys the P-256 key in Vault slot 0x82. If the token
 * is already an enrolled vault key, that removes one of the k-of-n signers and
 * can make vault funds permanently unspendable. The enrolled-serial refusal
 * below runs before the card is touched AND again inside the session, and is
 * deliberately not overridable by any caller flag — unlike
 * `replaceOccupiedVaultSlot`, which consents to replacing a slot that is by
 * definition not yet part of the vault.
 */
import { getVaultDriver } from './driver'
import { withKeySession } from './session'
import { vaultStore } from './vaultStore'
import { VaultError, isVaultSerial, type VaultScopeToken } from './types'

export type PivResetPhase = 'waiting' | 'resetting'

export async function resetPivApplication(args: {
  /** The reset tap must present exactly this key. */
  serial: string
  /** Serials the caller holds beyond the stored meta — a wizard's pending
   * records. Refused alongside meta. */
  refuseSerials?: readonly string[]
  /** Explicit acknowledgement that this destroys every credential on the
   * token, not only Vault's slot. */
  acknowledgeDestroysAllCredentials: true
  scopeToken?: VaultScopeToken
  nfcMessage?: string
  onPhase?: (p: PivResetPhase) => void
}): Promise<void> {
  const driver = getVaultDriver()
  if (!driver) throw new VaultError('driver-unavailable')
  if (args.acknowledgeDestroysAllCredentials !== true) {
    throw new VaultError('template-invalid', 'Confirm that resetting destroys every credential on this YubiKey')
  }
  if (!isVaultSerial(args.serial)) {
    throw new VaultError('template-invalid', 'Invalid YubiKey serial')
  }
  const scopeToken = args.scopeToken ?? vaultStore.captureScopeToken()

  const refuse = async () => {
    const meta = await vaultStore.getMeta(scopeToken)
    const enrolled = new Set<string>([
      ...(meta?.keys.map(k => k.serial) ?? []),
      ...(args.refuseSerials ?? [])
    ])
    if (enrolled.has(args.serial)) {
      // The message IS the serial, matching enrollKey's convention.
      throw new VaultError('key-already-enrolled', args.serial, undefined, { serial: args.serial })
    }
  }

  // Guard 1: before any card contact.
  await refuse()
  vaultStore.assertScopeToken(scopeToken)

  await withKeySession(
    driver,
    async () => {
      vaultStore.assertScopeToken(scopeToken)
      const info = await driver.getKeyInfo()
      if (info.serial !== args.serial) {
        throw new VaultError('serial-mismatch', 'A different YubiKey was presented', undefined, {
          tapped: info.serial,
          chosen: args.serial
        })
      }
      // Guard 2: re-read inside the session. Meta can change between the
      // first check and the tap, and this is the last chance before an
      // irreversible destruction.
      await refuse()
      vaultStore.assertScopeToken(scopeToken)

      args.onPhase?.('resetting')
      await driver.resetPivApplication(args.serial)

      // The reset destroyed whatever partial state these described. Leaving
      // them would refuse this key forever.
      vaultStore.assertScopeToken(scopeToken)
      await vaultStore.discardEnrollmentDraft(args.serial, scopeToken)
      await vaultStore.discardEnrollmentQuarantine(args.serial, scopeToken)
    },
    () => args.onPhase?.('waiting'),
    { nfcMessage: args.nfcMessage }
  )
}
```

- [ ] **Step 4: Re-export from the package entrypoint**

In `packages/expo-wallet-toolbox/core/index.ts`, immediately after line 280:

```ts
export * from './services/vault/pivReset'
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx jest packages/expo-wallet-toolbox/__tests__/vault/pivReset.test.ts
```

Expected: PASS — 8 passed.

- [ ] **Step 6: Commit**

```bash
npm run fix && git add packages/expo-wallet-toolbox/core/services/vault/pivReset.ts packages/expo-wallet-toolbox/core/index.ts packages/expo-wallet-toolbox/__tests__/vault/pivReset.test.ts && git commit -m "add guarded piv reset service"
```

---

## Task 6: Preflight hoist and `details.serial` on the not-factory errors

Two changes to `enrollKey`, both prerequisites for the wizard work.

**Preflight hoist.** `preflightDedicatedPiv` currently runs *after* `driver.verifyPin` (`VaultKeyService.ts:305` vs `:315`). Once the wizard sends the factory PIN on the user's behalf, a personalised key would burn a PIN retry on a code the user never chose. Preflight rejects every personalised PIV application and issues no `verifyPin` on either platform — verified by tracing its whole call graph (iOS: `getCertificateIn(0xf9)`, `authenticate(withManagementKey:)`, `attestKey(in:)`; Android: `getCertificate(Slot.ATTESTATION)`, `authenticate(DEFAULT_MANAGEMENT_KEY)`, `getSlotMetadata`/`attestKey`) — so it is safe above `verifyPin`.

**Serial on errors.** The reset offer must bind to the key that failed. `vaultErrorFromNative` (`types.ts:119-134`) parses only the code, message and `retries=`, and never populates `details` — so a native-origin error cannot carry a serial. It must be attached in JS, where `info.serial` is already in scope.

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/services/vault/VaultKeyService.ts:301-320`
- Test: `packages/expo-wallet-toolbox/__tests__/vault/vaultKeyService.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `pin-invalid`, `puk-invalid`, `mgmt-key-custom` and `attestation-invalid` raised from `enrollKey`'s card session now carry `details.serial`. Task 9 reads it.

- [ ] **Step 1: Write the failing tests**

Append to `packages/expo-wallet-toolbox/__tests__/vault/vaultKeyService.test.ts`:

```ts
test('preflight runs before verifyPin, so a personalised key costs no PIN retry', async () => {
  const calls: string[] = []
  driver.getKeyInfo = jest.fn(async () => ({ serial: SERIAL, firmwareVersion: '5.7.1', pinRetries: 3 }))
  driver.preflightDedicatedPiv = jest.fn(async () => {
    calls.push('preflight')
    throw new VaultError('mgmt-key-custom', 'default management key rejected')
  })
  driver.verifyPin = jest.fn(async () => {
    calls.push('verifyPin')
    return { ok: true, retriesLeft: 3 }
  })

  await expect(enrollKey(baseArgs())).rejects.toMatchObject({ code: 'mgmt-key-custom' })

  expect(calls).toEqual(['preflight'])
  expect(driver.verifyPin).not.toHaveBeenCalled()
})

test.each(['pin-invalid', 'puk-invalid', 'mgmt-key-custom', 'attestation-invalid'] as const)(
  '%s from the card session carries the serial so the UI can offer a reset',
  async code => {
    driver.getKeyInfo = jest.fn(async () => ({ serial: SERIAL, firmwareVersion: '5.7.1', pinRetries: 3 }))
    if (code === 'mgmt-key-custom' || code === 'attestation-invalid') {
      driver.preflightDedicatedPiv = jest.fn(async () => {
        throw new VaultError(code, 'native rejection')
      })
    } else if (code === 'pin-invalid') {
      driver.verifyPin = jest.fn(async () => ({ ok: false, retriesLeft: 2 }))
    } else {
      driver.changePuk = jest.fn(async () => {
        throw new VaultError('puk-invalid', 'Wrong PUK', 2)
      })
    }

    await expect(enrollKey(baseArgs())).rejects.toMatchObject({
      code,
      details: { serial: SERIAL }
    })
  }
)
```

Add this helper beside the file's existing fixtures if one is not already present:

```ts
const baseArgs = () => ({
  pendingSerials: [],
  acknowledgeDedicatedPivApplication: true as const,
  onPhase: () => {},
  getPin: async () => '123456',
  requestPinChange: async () => ({ oldPin: '123456', newPin: '654321' }),
  requestPukChange: async () => ({ oldPuk: '12345678', newPuk: '87654321' })
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx jest packages/expo-wallet-toolbox/__tests__/vault/vaultKeyService.test.ts
```

Expected: FAIL — the order test reports `['verifyPin']` or `['verifyPin','preflight']`, and the serial cases report `details: undefined`.

- [ ] **Step 3: Reorder and attach the serial**

In `VaultKeyService.ts`, replace the block currently spanning lines 301-321 with:

```ts
      // A blocked PIN can't be enrolled — surface it before burning anything.
      if (info.pinRetries === 0) throw withSerial(new VaultError('pin-locked', 'PIN is blocked'), info.serial)
      // PIN/PUK and management credentials are global to the whole PIV
      // application, not slot 0x82. Native must cryptographically verify the
      // factory F9 chain, authenticate the default management key, and reject
      // every occupied user slot it can reliably inspect before mutation.
      //
      // This runs BEFORE verifyPin deliberately. It is read-only, issues no
      // VERIFY on either platform, and refuses every personalised PIV
      // application — so a used token is identified without spending one of
      // three PIN retries on the factory PIN the UI supplies on the user's
      // behalf.
      let preflight
      try {
        preflight = await driver.preflightDedicatedPiv(info.serial, args.replaceOccupiedVaultSlot === true)
      } catch (e) {
        throw withSerial(e, info.serial)
      }
      if (
        preflight.ok !== true ||
        preflight.manufacturerAttestation !== 'verified' ||
        (preflight.inspection !== 'metadata' && preflight.inspection !== 'attestation')
      ) {
        throw withSerial(
          new VaultError('attestation-invalid', 'Native manufacturer attestation was not verified'),
          info.serial
        )
      }
      // Verify the entered PIN before doing any card mutation. The signing
      // probe below is the iOS-safe occupancy check for retired slot 0x82.
      try {
        const verified = await driver.verifyPin(info.serial, pin0)
        requireVerifiedPin(verified)
      } catch (e) {
        throw withSerial(e, info.serial)
      }
      args.onPhase('checking-slot')
      await requireEmptyVaultSlot(info.serial, pin0, args.replaceOccupiedVaultSlot === true)
```

Wrap the existing `driver.changePuk` call (the one inside the `try` at what is currently line 386) so its rejection also carries the serial — change `throw e` in the `isDefiniteCredentialRejection(e)` branch to `throw withSerial(e, info.serial)`.

Add this helper beside `requirePivCode` near the top of the file:

```ts
/**
 * Attach the tapped serial to an error leaving the card session.
 *
 * The UI's reset offer must bind to the exact key that failed, and a separate
 * reset tap has no other way to learn which one that was. Native-origin errors
 * cannot carry it themselves: vaultErrorFromNative parses only the code, the
 * message and `retries=`, never `details`. Non-VaultErrors pass through
 * untouched, and an existing `details.serial` is never overwritten.
 */
function withSerial(error: unknown, serial: string): unknown {
  if (!(error instanceof VaultError)) return error
  if (error.details?.serial !== undefined) return error
  return new VaultError(error.code, error.message, error.retriesLeft, { ...error.details, serial })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx jest packages/expo-wallet-toolbox/__tests__/vault/vaultKeyService.test.ts
```

Expected: PASS, including the five new cases and every pre-existing one.

- [ ] **Step 5: Commit**

```bash
npm run fix && git add packages/expo-wallet-toolbox/core/services/vault/VaultKeyService.ts packages/expo-wallet-toolbox/__tests__/vault/vaultKeyService.test.ts && git commit -m "check piv preflight before spending a pin retry and tag errors with the serial"
```

---

## Task 7: The PIN page and the progress bar

Replaces the four-field page with a single "choose a PIN" page carrying a confirm field, and adds the step indicator.

**Files:**
- Modify: `packages/expo-wallet-toolbox/ui/components/vault/EnrollWizard.tsx` (types at 80-81, state at ~139-142, the `pin` sub-step at 566-665, styles at the file tail)
- Modify: `packages/expo-wallet-toolbox/core/i18n/translations.tsx`
- Test: `packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `KeySub` gains `'puk'` and `'reset'`; state `newPin`/`confirmPin`/`newPuk`/`pukAck`; `generateRecoveryCode(pin: string): string`; the `StepProgress` component used by Tasks 8 and 9; i18n keys `vault_pin_choose_title`, `vault_pin_choose_sub`, `vault_pin_confirm_label`, `vault_pin_mismatch`, `vault_pin_not_default`, `vault_setup_step`.

- [ ] **Step 1: Add the i18n keys**

Insert after each block's `vault_key_step_replace` entry (find by name; order differs per language).

```
en:
      vault_pin_choose_title: 'Choose a PIN',
      vault_pin_choose_sub: 'You will enter this every time you use this key. 6 to 8 digits.',
      vault_pin_confirm_label: 'Enter it again',
      vault_pin_mismatch: 'Those two PINs do not match.',
      vault_pin_not_default: 'Pick something other than 123456.',
      vault_setup_step: 'Step {{n}} of {{total}}',
zh:
      vault_pin_choose_title: '设置 PIN 码',
      vault_pin_choose_sub: '每次使用此密钥时都需要输入。6 至 8 位数字。',
      vault_pin_confirm_label: '再次输入',
      vault_pin_mismatch: '两次输入的 PIN 码不一致。',
      vault_pin_not_default: '请选择 123456 以外的数字。',
      vault_setup_step: '第 {{n}} 步，共 {{total}} 步',
hi:
      vault_pin_choose_title: 'PIN चुनें',
      vault_pin_choose_sub: 'इस कुंजी का उपयोग करते समय हर बार यही दर्ज करना होगा। 6 से 8 अंक।',
      vault_pin_confirm_label: 'इसे दोबारा दर्ज करें',
      vault_pin_mismatch: 'दोनों PIN मेल नहीं खाते।',
      vault_pin_not_default: '123456 के अलावा कुछ चुनें।',
      vault_setup_step: 'चरण {{n}} / {{total}}',
es:
      vault_pin_choose_title: 'Elige un PIN',
      vault_pin_choose_sub: 'Lo introducirás cada vez que uses esta llave. De 6 a 8 dígitos.',
      vault_pin_confirm_label: 'Introdúcelo otra vez',
      vault_pin_mismatch: 'Esos dos PIN no coinciden.',
      vault_pin_not_default: 'Elige algo distinto de 123456.',
      vault_setup_step: 'Paso {{n}} de {{total}}',
fr:
      vault_pin_choose_title: 'Choisissez un code PIN',
      vault_pin_choose_sub: 'Vous le saisirez à chaque utilisation de cette clé. 6 à 8 chiffres.',
      vault_pin_confirm_label: 'Saisissez-le à nouveau',
      vault_pin_mismatch: 'Ces deux codes PIN ne correspondent pas.',
      vault_pin_not_default: 'Choisissez autre chose que 123456.',
      vault_setup_step: 'Étape {{n}} sur {{total}}',
ar:
      vault_pin_choose_title: 'اختر رمز PIN',
      vault_pin_choose_sub: 'ستُدخله في كل مرة تستخدم فيها هذا المفتاح. من 6 إلى 8 أرقام.',
      vault_pin_confirm_label: 'أدخله مرة أخرى',
      vault_pin_mismatch: 'الرمزان غير متطابقين.',
      vault_pin_not_default: 'اختر رمزًا غير 123456.',
      vault_setup_step: 'الخطوة {{n}} من {{total}}',
pt:
      vault_pin_choose_title: 'Escolha um PIN',
      vault_pin_choose_sub: 'Vai introduzi-lo sempre que usar esta chave. 6 a 8 dígitos.',
      vault_pin_confirm_label: 'Introduza-o novamente',
      vault_pin_mismatch: 'Os dois PIN não coincidem.',
      vault_pin_not_default: 'Escolha algo diferente de 123456.',
      vault_setup_step: 'Passo {{n}} de {{total}}',
bn:
      vault_pin_choose_title: 'একটি PIN বাছুন',
      vault_pin_choose_sub: 'এই কী ব্যবহারের প্রতিবার এটি দিতে হবে। ৬ থেকে ৮ অঙ্ক।',
      vault_pin_confirm_label: 'আবার লিখুন',
      vault_pin_mismatch: 'দুটি PIN মিলছে না।',
      vault_pin_not_default: '123456 ছাড়া অন্য কিছু বাছুন।',
      vault_setup_step: 'ধাপ {{n}} / {{total}}',
ru:
      vault_pin_choose_title: 'Придумайте PIN-код',
      vault_pin_choose_sub: 'Его нужно будет вводить при каждом использовании этого ключа. От 6 до 8 цифр.',
      vault_pin_confirm_label: 'Введите ещё раз',
      vault_pin_mismatch: 'PIN-коды не совпадают.',
      vault_pin_not_default: 'Выберите что-нибудь кроме 123456.',
      vault_setup_step: 'Шаг {{n}} из {{total}}',
id:
      vault_pin_choose_title: 'Pilih PIN',
      vault_pin_choose_sub: 'Anda akan memasukkannya setiap kali memakai kunci ini. 6 sampai 8 digit.',
      vault_pin_confirm_label: 'Masukkan sekali lagi',
      vault_pin_mismatch: 'Kedua PIN tidak sama.',
      vault_pin_not_default: 'Pilih selain 123456.',
      vault_setup_step: 'Langkah {{n}} dari {{total}}',
ja:
      vault_pin_choose_title: 'PIN を決めてください',
      vault_pin_choose_sub: 'このキーを使うたびに入力します。6〜8 桁の数字。',
      vault_pin_confirm_label: 'もう一度入力',
      vault_pin_mismatch: '2 つの PIN が一致しません。',
      vault_pin_not_default: '123456 以外を選んでください。',
      vault_setup_step: 'ステップ {{n}}／{{total}}',
pl:
      vault_pin_choose_title: 'Wybierz PIN',
      vault_pin_choose_sub: 'Będziesz go podawać przy każdym użyciu tego klucza. Od 6 do 8 cyfr.',
      vault_pin_confirm_label: 'Wpisz go ponownie',
      vault_pin_mismatch: 'Te dwa PIN-y nie są takie same.',
      vault_pin_not_default: 'Wybierz coś innego niż 123456.',
      vault_setup_step: 'Krok {{n}} z {{total}}',
```

- [ ] **Step 2: Write the failing tests**

In `packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx`, replace the `enterCredentials` helper with:

```ts
/** From the pin sub-state: choose and confirm a PIN, then advance to the PUK page. */
function choosePin(screen: ReturnType<typeof render>, pin = '654321') {
  fireEvent.changeText(screen.getByLabelText('vault_pin_choose_title'), pin)
  fireEvent.changeText(screen.getByLabelText('vault_pin_confirm_label'), pin)
}
```

and add these tests:

```ts
test('the PIN page shows step 1 of 4 and no PUK fields', async () => {
  const { screen } = await beginEnroll()
  expect(screen.getByText('vault_setup_step:{"n":1,"total":4}')).toBeTruthy()
  expect(screen.queryByLabelText('vault_enter_puk')).toBeNull()
  expect(screen.queryByLabelText('vault_set_new_puk')).toBeNull()
})

test('Continue stays inert until both PIN fields match a valid non-default code', async () => {
  const { screen } = await beginEnroll()
  const cont = () => screen.getByText('vault_continue')

  fireEvent.changeText(screen.getByLabelText('vault_pin_choose_title'), '654321')
  await act(async () => fireEvent.press(cont()))
  expect(screen.queryByText('vault_puk_title')).toBeNull()

  fireEvent.changeText(screen.getByLabelText('vault_pin_confirm_label'), '654322')
  await act(async () => fireEvent.press(cont()))
  expect(screen.getByText('vault_pin_mismatch')).toBeTruthy()
  expect(screen.queryByText('vault_puk_title')).toBeNull()

  fireEvent.changeText(screen.getByLabelText('vault_pin_confirm_label'), '654321')
  await act(async () => fireEvent.press(cont()))
  await settle()
  expect(screen.getByText('vault_puk_title')).toBeTruthy()
})

test('the factory PIN is refused as a choice', async () => {
  const { screen } = await beginEnroll()
  fireEvent.changeText(screen.getByLabelText('vault_pin_choose_title'), '123456')
  fireEvent.changeText(screen.getByLabelText('vault_pin_confirm_label'), '123456')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  expect(screen.getByText('vault_pin_not_default')).toBeTruthy()
  expect(screen.queryByText('vault_puk_title')).toBeNull()
})
```

- [ ] **Step 3: Run them to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx jest packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx
```

Expected: FAIL — `Unable to find an element with accessibility label: vault_pin_choose_title`.

- [ ] **Step 4: Widen the sub-step union and the state**

Replace line 81:

```ts
type KeySub = 'pin' | 'puk' | 'tap' | 'name' | 'reset' | 'error'

/** Pages a single key's setup walks through, for the progress indicator. The
 * count is per key, not per wizard: the number of keys is chosen during the
 * run (2 to 5), so a whole-wizard bar would move at a rate nobody can predict. */
const KEY_STEPS: readonly KeySub[] = ['pin', 'puk', 'tap', 'name']
```

Replace the `pin`/`newPin`/`puk`/`newPuk` state declarations with:

```ts
  /** The PIN the user chose for this key. The factory PIN is supplied to the
   * service below the UI, never typed. */
  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  /** The generated recovery code for this key. Created when the PUK page is
   * first shown and cleared with the rest of the key's inputs. */
  const [newPuk, setNewPuk] = useState('')
  const [pukAck, setPukAck] = useState(false)
```

Replace the `pinOk` / `needsNewPin` / `effectivePin` derivations with:

```ts
  const pinChosen = pivCodeOk(newPin) && newPin !== DEFAULT_PIV_PIN
  const pinOk = pinChosen && confirmPin === newPin
```

Add `randomBytes` to the `@bsv/expo-wallet-toolbox` import list, and this generator beside `pivCodeOk` (Task 8's page displays what it returns; it is defined here because the PIN page's Continue handler calls it):

```ts
const PUK_LENGTH = 8

/**
 * A fresh recovery code (PIV PUK) for one key.
 *
 * Rejection sampling, not `byte % 10`: a modulo over 256 would make the digits
 * 0-5 measurably likelier than 6-9. Bytes of 250 or more are discarded.
 *
 * The service refuses a PUK equal to the PIN (validatePukChange), so a
 * collision is redrawn rather than surfaced as a validation error.
 */
function generateRecoveryCode(pin: string): string {
  for (;;) {
    let code = ''
    while (code.length < PUK_LENGTH) {
      for (const byte of randomBytes(PUK_LENGTH)) {
        if (byte >= 250) continue
        code += String(byte % 10)
        if (code.length === PUK_LENGTH) break
      }
    }
    if (code !== DEFAULT_PIV_PUK && code !== pin) return code
  }
}
```

Update `clearKeyInputs` to reset the new state:

```ts
  const clearKeyInputs = () => {
    setNewPin('')
    setConfirmPin('')
    setNewPuk('')
    setPukAck(false)
    setPinError(null)
    setFresh(null)
    setName('')
  }
```

Update the `runTap` callback's `enrollKey` arguments — the factory codes are supplied here:

```ts
          // The intro's whole-PIV acknowledgement already asserts a
          // factory-reset, dedicated PIV application, and preflight
          // authenticates the factory management key before any mutation. So
          // the factory PIN and PUK are ours to supply; making the user type
          // '123456' was ceremony, not security.
          getPin: async () => DEFAULT_PIV_PIN,
          requestPinChange: async () => ({ oldPin: DEFAULT_PIV_PIN, newPin }),
          requestPukChange: async () => ({ oldPuk: DEFAULT_PIV_PUK, newPuk }),
```

and change its dependency array from `[metaKeys, pending, pin, newPin, puk, newPuk, needsNewPin, onCancel, pivAck, scopeToken]` to `[metaKeys, pending, newPin, newPuk, onCancel, pivAck, scopeToken]`.

- [ ] **Step 5: Add the StepProgress component**

Add above the `Bullet` helper near the file's tail:

```tsx
/**
 * Where this key's setup has got to. Per key, four steps: choose a PIN, note
 * the recovery code, tap, name it.
 */
const StepProgress: React.FC<{ sub: KeySub }> = ({ sub }) => {
  const { colors } = useTheme()
  const index = KEY_STEPS.indexOf(sub)
  if (index < 0) return null
  const n = index + 1
  const total = KEY_STEPS.length
  return (
    <View
      style={styles.progress}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 1, max: total, now: n }}
    >
      <View style={[styles.progressTrack, { backgroundColor: colors.backgroundSecondary }]}>
        <View style={[styles.progressFill, { backgroundColor: colors.accent, width: `${(n / total) * 100}%` }]} />
      </View>
      <Text style={[styles.progressLabel, { color: colors.textSecondary }]}>
        {t('vault_setup_step', { n, total })}
      </Text>
    </View>
  )
}
```

and these styles to the `StyleSheet.create` block:

```ts
  progress: { gap: spacing.xs },
  progressTrack: { height: 4, borderRadius: radii.sm, overflow: 'hidden' },
  progressFill: { height: 4, borderRadius: radii.sm },
  progressLabel: { ...typography.footnote, textAlign: 'center' },
```

- [ ] **Step 6: Replace the `pin` sub-step JSX**

Replace the whole `if (sub === 'pin') { ... }` block (lines 566-665) with:

```tsx
    if (sub === 'pin') {
      const advance = () => {
        if (!pivAck || busy) return
        if (!pinChosen) {
          setPinError(newPin === DEFAULT_PIV_PIN ? t('vault_pin_not_default') : null)
          return
        }
        if (confirmPin !== newPin) {
          setPinError(t('vault_pin_mismatch'))
          return
        }
        setPinError(null)
        // Generated once per visit to the PUK page, so going back and forward
        // does not silently hand the user a different code to write down.
        if (!newPuk) setNewPuk(generateRecoveryCode(newPin))
        setSub('puk')
      }
      return (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_key_step_title', { k })}</Text>
          <StepProgress sub={sub} />
          <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_key_step_replace')}</Text>
          {mode === 'add-key' && pivAcknowledgement}

          <Text style={[styles.label, { color: colors.textPrimary }]}>{t('vault_pin_choose_title')}</Text>
          <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('vault_pin_choose_sub')}</Text>
          <TextInput
            ref={pinInputRef}
            accessibilityLabel={t('vault_pin_choose_title')}
            style={[styles.pin, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
            value={newPin}
            onChangeText={text => {
              setPinError(null)
              setNewPin(text)
            }}
            placeholder="••••••"
            placeholderTextColor={colors.textTertiary}
            keyboardType="number-pad"
            // Always secure: toggling this prop on based on length forces the
            // native field to remount on the first keystroke and drops it.
            secureTextEntry
            maxLength={PIN_MAX}
          />

          <Text style={[styles.label, { color: colors.textPrimary }]}>{t('vault_pin_confirm_label')}</Text>
          <TextInput
            accessibilityLabel={t('vault_pin_confirm_label')}
            style={[styles.pin, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
            value={confirmPin}
            onChangeText={text => {
              setPinError(null)
              setConfirmPin(text)
            }}
            placeholder="••••••"
            placeholderTextColor={colors.textTertiary}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={PIN_MAX}
          />

          {pinError && <Text style={[styles.err, { color: colors.error }]}>{pinError}</Text>}
          {stepError && <Text style={[styles.err, { color: colors.error }]}>{stepError}</Text>}
          {recoverableDrafts.map(entry => (
            <ActionButton
              key={entry.record.serial}
              label={`${t('vault_enrollment_resume')} · …${entry.record.serial.slice(-4)}`}
              variant="outline"
              enabled={pivAck && pinOk && !busy}
              onPress={() => void resumeDraft(entry)}
            />
          ))}
          {blockedDrafts.length > 0 && (
            <Text style={[styles.warn, { color: colors.warning }]}>{t('vault_enrollment_reset_required')}</Text>
          )}
          {Platform.OS === 'ios' && (
            <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('vault_nfc_activation_hint')}</Text>
          )}
          <ActionButton label={t('vault_continue')} enabled={pivAck && !busy} onPress={advance} />
          {leaveLink}
        </ScrollView>
      )
    }
```

Note `resumeDraft` previously gated on `pivCodeOk(pin)` and called `getPin: async () => pin`. Change its `getPin` to `async () => newPin` — a protected draft's card already carries the PIN chosen in this run.

- [ ] **Step 7: Add StepProgress to the tap and name sub-steps**

In the `sub === 'tap'` block, insert `<StepProgress sub={sub} />` directly after the `ActivityIndicator`. In the `sub === 'name'` block, insert it directly after the `Ionicons` hero.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx jest packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx
```

Expected: the three new tests PASS. Pre-existing tests that call the old `enterCredentials` will still fail — Task 8 finishes the flow and repairs them. If you need a green gate here, temporarily mark those with `test.skip` and remove the skips in Task 8's Step 5.

- [ ] **Step 9: Commit**

```bash
npm run fix && git add packages/expo-wallet-toolbox/ui/components/vault/EnrollWizard.tsx packages/expo-wallet-toolbox/core/i18n/translations.tsx packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx && git commit -m "give vault setup a pin page with confirmation and a step indicator"
```

---

## Task 8: The generated recovery code page

**Files:**
- Modify: `packages/expo-wallet-toolbox/ui/components/vault/EnrollWizard.tsx`
- Modify: `packages/expo-wallet-toolbox/core/i18n/translations.tsx`
- Test: `packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx`

**Interfaces:**
- Consumes: `KeySub` `'puk'`, the `newPuk`/`pukAck` state, `generateRecoveryCode` and `StepProgress`, all from Task 7.
- Produces: i18n keys `vault_puk_title`, `vault_puk_body`, `vault_puk_ack`.

- [ ] **Step 1: Add the i18n keys**

Insert after each block's `vault_pin_not_default` entry.

```
en:
      vault_puk_title: 'Your recovery code',
      vault_puk_body:
        'Write this down and keep it somewhere safe. It is the only way to unlock this key if the PIN is forgotten, and it will not be shown again.',
      vault_puk_ack: 'I have written this down',
zh:
      vault_puk_title: '您的恢复码',
      vault_puk_body: '请抄下并妥善保管。忘记 PIN 码时，这是解锁此密钥的唯一方式，且不会再次显示。',
      vault_puk_ack: '我已抄下',
hi:
      vault_puk_title: 'आपका रिकवरी कोड',
      vault_puk_body:
        'इसे लिखकर सुरक्षित जगह रखें। PIN भूल जाने पर इस कुंजी को खोलने का यही एकमात्र तरीका है, और यह दोबारा नहीं दिखाया जाएगा।',
      vault_puk_ack: 'मैंने इसे लिख लिया है',
es:
      vault_puk_title: 'Tu código de recuperación',
      vault_puk_body:
        'Anótalo y guárdalo en un lugar seguro. Es la única forma de desbloquear esta llave si olvidas el PIN, y no volverá a mostrarse.',
      vault_puk_ack: 'Lo he anotado',
fr:
      vault_puk_title: 'Votre code de récupération',
      vault_puk_body:
        'Notez-le et conservez-le en lieu sûr. C’est le seul moyen de débloquer cette clé en cas d’oubli du code PIN, et il ne sera plus affiché.',
      vault_puk_ack: 'Je l’ai noté',
ar:
      vault_puk_title: 'رمز الاسترداد الخاص بك',
      vault_puk_body:
        'دوّنه واحتفظ به في مكان آمن. إنه الطريقة الوحيدة لفتح هذا المفتاح إذا نسيت رمز PIN، ولن يُعرض مرة أخرى.',
      vault_puk_ack: 'لقد دوّنته',
pt:
      vault_puk_title: 'O seu código de recuperação',
      vault_puk_body:
        'Anote-o e guarde-o num local seguro. É a única forma de desbloquear esta chave se esquecer o PIN, e não voltará a ser mostrado.',
      vault_puk_ack: 'Já o anotei',
bn:
      vault_puk_title: 'আপনার পুনরুদ্ধার কোড',
      vault_puk_body:
        'এটি লিখে নিরাপদ জায়গায় রাখুন। PIN ভুলে গেলে এই কী খোলার এটিই একমাত্র উপায়, এবং এটি আর দেখানো হবে না।',
      vault_puk_ack: 'আমি লিখে নিয়েছি',
ru:
      vault_puk_title: 'Ваш код восстановления',
      vault_puk_body:
        'Запишите его и храните в надёжном месте. Это единственный способ разблокировать ключ, если PIN-код забыт, и повторно он показан не будет.',
      vault_puk_ack: 'Я записал его',
id:
      vault_puk_title: 'Kode pemulihan Anda',
      vault_puk_body:
        'Catat dan simpan di tempat aman. Ini satu-satunya cara membuka kunci ini bila PIN terlupa, dan tidak akan ditampilkan lagi.',
      vault_puk_ack: 'Saya sudah mencatatnya',
ja:
      vault_puk_title: '復旧コード',
      vault_puk_body:
        '書き留めて安全な場所に保管してください。PIN を忘れたときにこのキーを解除できる唯一の方法で、二度と表示されません。',
      vault_puk_ack: '書き留めました',
pl:
      vault_puk_title: 'Twój kod odzyskiwania',
      vault_puk_body:
        'Zapisz go i trzymaj w bezpiecznym miejscu. To jedyny sposób na odblokowanie tego klucza po zapomnieniu PIN-u, a nie zostanie pokazany ponownie.',
      vault_puk_ack: 'Zapisałem go',
```

- [ ] **Step 2: Write the failing tests**

Add to `enrollWizard.test.tsx`:

```ts
/** From the pin sub-state: choose a PIN, accept the generated code, reach the tap. */
function enterCredentials(screen: ReturnType<typeof render>, pin = '654321') {
  choosePin(screen, pin)
  fireEvent.press(screen.getByText('vault_continue'))
  fireEvent.press(screen.getByText('vault_puk_ack'))
}

test('the recovery code page shows step 2 of 4 and gates Continue on the acknowledgement', async () => {
  const { screen } = await beginEnroll()
  choosePin(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()

  expect(screen.getByText('vault_puk_title')).toBeTruthy()
  expect(screen.getByText('vault_setup_step:{"n":2,"total":4}')).toBeTruthy()

  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  expect(mockEnrollKey).not.toHaveBeenCalled()

  fireEvent.press(screen.getByText('vault_puk_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  expect(mockEnrollKey).toHaveBeenCalled()
})

test('the factory codes are supplied below the UI and the generated PUK is 8 digits', async () => {
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a'))
  const { screen } = await beginEnroll()
  enterCredentials(screen, '778899')
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()

  const args = mockEnrollKey.mock.calls[0][0]
  await expect(args.getPin()).resolves.toBe('123456')
  await expect(args.requestPinChange(3)).resolves.toEqual({ oldPin: '123456', newPin: '778899' })
  const puk = await args.requestPukChange()
  expect(puk.oldPuk).toBe('12345678')
  expect(puk.newPuk).toMatch(/^[0-9]{8}$/)
  expect(puk.newPuk).not.toBe('12345678')
  expect(puk.newPuk).not.toBe('778899')
})

test('the code shown on screen is the one sent to the service', async () => {
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a'))
  const { screen } = await beginEnroll()
  choosePin(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()

  const shown = screen.getByLabelText('vault_puk_title').props.children as string
  fireEvent.press(screen.getByText('vault_puk_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()

  await expect(mockEnrollKey.mock.calls[0][0].requestPukChange()).resolves.toEqual({
    oldPuk: '12345678',
    newPuk: shown
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx jest packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx -t "recovery code"
```

Expected: FAIL — `vault_puk_title` not found.

- [ ] **Step 4: Add the page**

`generateRecoveryCode` and the `newPuk` / `pukAck` state already landed in Task 7. Add the sub-step block directly after the `pin` block:

```tsx
    if (sub === 'puk') {
      return (
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_key_step_title', { k })}</Text>
          <StepProgress sub={sub} />
          <Text style={[styles.label, { color: colors.textPrimary }]}>{t('vault_puk_title')}</Text>
          {/* Shown once and never stored, exactly like the PIN. The
              acknowledgement is a tick rather than a plain button because
              losing this code silently is the failure this page exists to
              prevent. */}
          <Text
            accessibilityLabel={t('vault_puk_title')}
            selectable
            style={[styles.code, { color: colors.textPrimary, backgroundColor: colors.backgroundSecondary }]}
          >
            {newPuk}
          </Text>
          <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_puk_body')}</Text>
          <PressableScale
            accessibilityRole="checkbox"
            accessibilityState={{ checked: pukAck }}
            haptic="tap"
            onPress={() => setPukAck(value => !value)}
            style={[styles.ackRow, { borderColor: pukAck ? colors.accent : colors.separator }]}
          >
            <Ionicons
              name={pukAck ? 'checkbox' : 'square-outline'}
              size={24}
              color={pukAck ? colors.accent : colors.textTertiary}
            />
            <Text style={[styles.ackText, { color: colors.textPrimary }]}>{t('vault_puk_ack')}</Text>
          </PressableScale>
          {stepError && <Text style={[styles.err, { color: colors.error }]}>{stepError}</Text>}
          <ActionButton
            label={t('vault_continue')}
            enabled={pukAck && pinOk && !busy}
            onPress={() => void runTap()}
          />
          <ActionButton label={t('vault_back')} variant="outline" onPress={() => setSub('pin')} />
          {leaveLink}
        </ScrollView>
      )
    }
```

Add the style:

```ts
  code: {
    width: '80%',
    alignSelf: 'center',
    textAlign: 'center',
    ...typography.title2,
    letterSpacing: 6,
    borderRadius: radii.md,
    paddingVertical: spacing.lg
  },
```

`vault_back` already exists in all 12 blocks — confirm with `grep -c "vault_back:" packages/expo-wallet-toolbox/core/i18n/translations.tsx` (expected `12`). If it returns `0`, add it with the values: en `'Back'`, zh `'返回'`, hi `'वापस'`, es `'Atrás'`, fr `'Retour'`, ar `'رجوع'`, pt `'Voltar'`, bn `'ফিরে যান'`, ru `'Назад'`, id `'Kembali'`, ja `'戻る'`, pl `'Wstecz'`.

- [ ] **Step 5: Repair the pre-existing tests**

Remove any `test.skip` added in Task 7. The old tests that referenced `vault_enter_puk` / `vault_set_new_puk` now go through the rewritten `enterCredentials`. Delete the test `the factory PIN demands a new PIN before the tap and passes both to enrollKey` — the factory PIN is never typed now, and Step 2's `the factory codes are supplied below the UI` replaces it.

- [ ] **Step 6: Run the whole wizard suite**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx jest packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx
```

Expected: PASS — every test, old and new.

- [ ] **Step 7: Commit**

```bash
npm run fix && git add packages/expo-wallet-toolbox/ui/components/vault/EnrollWizard.tsx packages/expo-wallet-toolbox/core/i18n/translations.tsx packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx && git commit -m "generate the vault recovery code on its own setup page"
```

---

## Task 9: The reset page and error routing

**Files:**
- Modify: `packages/expo-wallet-toolbox/ui/components/vault/EnrollWizard.tsx` (the `error` sub-step, currently ~703-735)
- Modify: `packages/expo-wallet-toolbox/core/i18n/translations.tsx`
- Test: `packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx`

**Interfaces:**
- Consumes: `resetPivApplication` (Task 5), `details.serial` on errors (Task 6), `KeySub` `'reset'` (Task 7).
- Produces: the final wizard behaviour. Nothing downstream.

**Which codes offer a reset.** `attestation-invalid` must **not** — it means the F9 factory chain failed, i.e. counterfeit or tampered, and a reset cannot fix it. `key-already-enrolled` must not — it is a live vault key.

- [ ] **Step 1: Add the i18n keys**

Insert after each block's `vault_puk_ack` entry.

```
en:
      vault_reset_offer: 'Reset this key',
      vault_reset_title: 'Reset this key?',
      vault_reset_body:
        'This key has been used before. Resetting erases every certificate and key in its PIV application, not only the vault slot. Anything that relies on this key stops working.',
      vault_reset_ack: 'I understand this erases everything on this key',
      vault_reset_confirm: 'Erase and reset',
      vault_resetting: 'Resetting the key…',
      vault_reset_done: 'Key reset. Tap it again to continue.',
      vault_err_reset_enrolled: 'That key is already part of your vault — resetting it would destroy one of your vault keys.',
zh:
      vault_reset_offer: '重置此密钥',
      vault_reset_title: '要重置此密钥吗？',
      vault_reset_body:
        '此密钥曾被使用过。重置会抹除其 PIV 应用中的所有证书和密钥，而不仅仅是保险库槽位。任何依赖此密钥的功能都将失效。',
      vault_reset_ack: '我明白这会抹除此密钥上的所有内容',
      vault_reset_confirm: '抹除并重置',
      vault_resetting: '正在重置密钥…',
      vault_reset_done: '密钥已重置。请再次轻触以继续。',
      vault_err_reset_enrolled: '该密钥已是您保险库的一部分 — 重置它会销毁您的一把保险库密钥。',
hi:
      vault_reset_offer: 'इस कुंजी को रीसेट करें',
      vault_reset_title: 'इस कुंजी को रीसेट करें?',
      vault_reset_body:
        'यह कुंजी पहले इस्तेमाल हो चुकी है। रीसेट करने पर इसके PIV ऐप्लिकेशन का हर प्रमाणपत्र और कुंजी मिट जाएगी, सिर्फ़ वॉल्ट स्लॉट नहीं। इस कुंजी पर निर्भर सब कुछ काम करना बंद कर देगा।',
      vault_reset_ack: 'मैं समझता हूँ कि इससे इस कुंजी का सब कुछ मिट जाएगा',
      vault_reset_confirm: 'मिटाएँ और रीसेट करें',
      vault_resetting: 'कुंजी रीसेट की जा रही है…',
      vault_reset_done: 'कुंजी रीसेट हो गई। जारी रखने के लिए इसे फिर से टैप करें।',
      vault_err_reset_enrolled: 'वह कुंजी पहले से आपके वॉल्ट का हिस्सा है — उसे रीसेट करने से आपकी एक वॉल्ट कुंजी नष्ट हो जाएगी।',
es:
      vault_reset_offer: 'Restablecer esta llave',
      vault_reset_title: '¿Restablecer esta llave?',
      vault_reset_body:
        'Esta llave ya se ha usado antes. Restablecerla borra todos los certificados y claves de su aplicación PIV, no solo la ranura de la caja fuerte. Todo lo que dependa de ella dejará de funcionar.',
      vault_reset_ack: 'Entiendo que esto borra todo lo que hay en esta llave',
      vault_reset_confirm: 'Borrar y restablecer',
      vault_resetting: 'Restableciendo la llave…',
      vault_reset_done: 'Llave restablecida. Vuelve a acercarla para continuar.',
      vault_err_reset_enrolled: 'Esa llave ya forma parte de tu caja fuerte: restablecerla destruiría una de tus claves.',
fr:
      vault_reset_offer: 'Réinitialiser cette clé',
      vault_reset_title: 'Réinitialiser cette clé ?',
      vault_reset_body:
        'Cette clé a déjà servi. La réinitialiser efface tous les certificats et toutes les clés de son application PIV, pas seulement l’emplacement du coffre. Tout ce qui en dépend cessera de fonctionner.',
      vault_reset_ack: 'Je comprends que cela efface tout sur cette clé',
      vault_reset_confirm: 'Effacer et réinitialiser',
      vault_resetting: 'Réinitialisation de la clé…',
      vault_reset_done: 'Clé réinitialisée. Présentez-la à nouveau pour continuer.',
      vault_err_reset_enrolled: 'Cette clé fait déjà partie de votre coffre — la réinitialiser détruirait une de vos clés.',
ar:
      vault_reset_offer: 'إعادة ضبط هذا المفتاح',
      vault_reset_title: 'إعادة ضبط هذا المفتاح؟',
      vault_reset_body:
        'استُخدم هذا المفتاح من قبل. إعادة الضبط تمحو كل شهادة ومفتاح في تطبيق PIV الخاص به، وليس خانة الخزنة وحدها. كل ما يعتمد على هذا المفتاح سيتوقف عن العمل.',
      vault_reset_ack: 'أفهم أن هذا يمحو كل شيء على هذا المفتاح',
      vault_reset_confirm: 'محو وإعادة ضبط',
      vault_resetting: 'جارٍ إعادة ضبط المفتاح…',
      vault_reset_done: 'أُعيد ضبط المفتاح. قرّبه مرة أخرى للمتابعة.',
      vault_err_reset_enrolled: 'هذا المفتاح جزء من خزنتك بالفعل — إعادة ضبطه ستدمّر أحد مفاتيح خزنتك.',
pt:
      vault_reset_offer: 'Repor esta chave',
      vault_reset_title: 'Repor esta chave?',
      vault_reset_body:
        'Esta chave já foi usada. Repô-la apaga todos os certificados e chaves da sua aplicação PIV, não apenas a ranhura do cofre. Tudo o que depende desta chave deixa de funcionar.',
      vault_reset_ack: 'Compreendo que isto apaga tudo nesta chave',
      vault_reset_confirm: 'Apagar e repor',
      vault_resetting: 'A repor a chave…',
      vault_reset_done: 'Chave reposta. Aproxime-a novamente para continuar.',
      vault_err_reset_enrolled: 'Essa chave já faz parte do seu cofre — repô-la destruiria uma das suas chaves do cofre.',
bn:
      vault_reset_offer: 'এই কী রিসেট করুন',
      vault_reset_title: 'এই কী রিসেট করবেন?',
      vault_reset_body:
        'এই কী আগে ব্যবহার হয়েছে। রিসেট করলে এর PIV অ্যাপ্লিকেশনের প্রতিটি সার্টিফিকেট ও কী মুছে যাবে, শুধু ভল্ট স্লট নয়। এই কীর উপর নির্ভরশীল সবকিছু কাজ করা বন্ধ করবে।',
      vault_reset_ack: 'আমি বুঝেছি এতে এই কীর সবকিছু মুছে যাবে',
      vault_reset_confirm: 'মুছে ফেলে রিসেট করুন',
      vault_resetting: 'কী রিসেট করা হচ্ছে…',
      vault_reset_done: 'কী রিসেট হয়েছে। চালিয়ে যেতে আবার ট্যাপ করুন।',
      vault_err_reset_enrolled: 'ওই কী ইতিমধ্যে আপনার ভল্টের অংশ — রিসেট করলে আপনার একটি ভল্ট কী নষ্ট হবে।',
ru:
      vault_reset_offer: 'Сбросить этот ключ',
      vault_reset_title: 'Сбросить этот ключ?',
      vault_reset_body:
        'Этот ключ уже использовался. Сброс стирает все сертификаты и ключи в его PIV-приложении, а не только слот хранилища. Всё, что на него опирается, перестанет работать.',
      vault_reset_ack: 'Я понимаю, что это сотрёт с ключа всё',
      vault_reset_confirm: 'Стереть и сбросить',
      vault_resetting: 'Сброс ключа…',
      vault_reset_done: 'Ключ сброшен. Приложите его снова, чтобы продолжить.',
      vault_err_reset_enrolled: 'Этот ключ уже входит в ваше хранилище — сброс уничтожил бы один из его ключей.',
id:
      vault_reset_offer: 'Setel ulang kunci ini',
      vault_reset_title: 'Setel ulang kunci ini?',
      vault_reset_body:
        'Kunci ini pernah dipakai. Menyetel ulang menghapus setiap sertifikat dan kunci di aplikasi PIV-nya, bukan hanya slot brankas. Semua yang bergantung padanya berhenti berfungsi.',
      vault_reset_ack: 'Saya paham ini menghapus semua isi kunci ini',
      vault_reset_confirm: 'Hapus dan setel ulang',
      vault_resetting: 'Menyetel ulang kunci…',
      vault_reset_done: 'Kunci disetel ulang. Tempelkan lagi untuk melanjutkan.',
      vault_err_reset_enrolled: 'Kunci itu sudah menjadi bagian brankas Anda — menyetel ulangnya akan menghancurkan salah satu kunci brankas.',
ja:
      vault_reset_offer: 'このキーをリセット',
      vault_reset_title: 'このキーをリセットしますか？',
      vault_reset_body:
        'このキーは以前に使われています。リセットすると、保管庫スロットだけでなく PIV アプリケーション内のすべての証明書と鍵が消去されます。このキーに依存しているものは動作しなくなります。',
      vault_reset_ack: 'このキーの内容がすべて消えることを理解しました',
      vault_reset_confirm: '消去してリセット',
      vault_resetting: 'キーをリセットしています…',
      vault_reset_done: 'キーをリセットしました。続けるにはもう一度かざしてください。',
      vault_err_reset_enrolled: 'そのキーは既に保管庫の一部です。リセットすると保管庫の鍵が 1 つ失われます。',
pl:
      vault_reset_offer: 'Zresetuj ten klucz',
      vault_reset_title: 'Zresetować ten klucz?',
      vault_reset_body:
        'Ten klucz był już używany. Reset kasuje każdy certyfikat i klucz w jego aplikacji PIV, nie tylko gniazdo sejfu. Wszystko, co na nim polega, przestanie działać.',
      vault_reset_ack: 'Rozumiem, że to skasuje całą zawartość tego klucza',
      vault_reset_confirm: 'Skasuj i zresetuj',
      vault_resetting: 'Resetowanie klucza…',
      vault_reset_done: 'Klucz zresetowany. Przyłóż go ponownie, aby kontynuować.',
      vault_err_reset_enrolled: 'Ten klucz jest już częścią Twojego sejfu — reset zniszczyłby jeden z kluczy sejfu.',
```

- [ ] **Step 2: Write the failing tests**

Add to `enrollWizard.test.tsx`. Extend the `@bsv/expo-wallet-toolbox` mock factory with `resetPivApplication: mockResetPiv`, and declare `const mockResetPiv = jest.fn()` beside the other module-scope mocks, resetting it in `beforeEach`.

```ts
async function failTapWith(code: string, details?: Record<string, string>) {
  mockEnrollKey.mockRejectedValueOnce(new VaultError(code, undefined, undefined, details))
  const { screen, onCancel } = await beginEnroll()
  enterCredentials(screen)
  await act(async () => fireEvent.press(screen.getByText('vault_continue')))
  await settle()
  return { screen, onCancel }
}

test.each(['mgmt-key-custom', 'pin-invalid', 'puk-invalid', 'pin-locked', 'puk-locked'])(
  '%s offers a reset when the serial is known',
  async code => {
    const { screen } = await failTapWith(code, { serial: '12340001' })
    expect(screen.getByText('vault_reset_offer')).toBeTruthy()
  }
)

test('a counterfeit key is never offered a reset', async () => {
  const { screen } = await failTapWith('attestation-invalid', { serial: '12340001' })
  expect(screen.queryByText('vault_reset_offer')).toBeNull()
  expect(screen.getByText('vault_key_use_different')).toBeTruthy()
})

test('an already-enrolled key is never offered a reset', async () => {
  const { screen } = await failTapWith('key-already-enrolled', { serial: '12340001' })
  expect(screen.queryByText('vault_reset_offer')).toBeNull()
})

test('without a serial there is nothing to bind a reset to, so none is offered', async () => {
  const { screen } = await failTapWith('mgmt-key-custom')
  expect(screen.queryByText('vault_reset_offer')).toBeNull()
  expect(screen.getByText('vault_key_use_different')).toBeTruthy()
})

test('the reset page gates the destructive button on the acknowledgement', async () => {
  const { screen } = await failTapWith('mgmt-key-custom', { serial: '12340001' })
  fireEvent.press(screen.getByText('vault_reset_offer'))
  await settle()

  expect(screen.getByText('vault_reset_title')).toBeTruthy()
  await act(async () => fireEvent.press(screen.getByText('vault_reset_confirm')))
  expect(mockResetPiv).not.toHaveBeenCalled()

  fireEvent.press(screen.getByText('vault_reset_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_reset_confirm')))
  await settle()
  expect(mockResetPiv).toHaveBeenCalledWith(
    expect.objectContaining({
      serial: '12340001',
      acknowledgeDestroysAllCredentials: true
    })
  )
})

test('a successful reset returns to the tap step without re-asking for the PIN', async () => {
  mockResetPiv.mockResolvedValueOnce(undefined)
  mockEnrollKey.mockResolvedValueOnce(record('12340001', 'a'))
  const { screen } = await failTapWith('mgmt-key-custom', { serial: '12340001' })

  fireEvent.press(screen.getByText('vault_reset_offer'))
  await settle()
  fireEvent.press(screen.getByText('vault_reset_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_reset_confirm')))
  await settle()

  expect(screen.queryByLabelText('vault_pin_choose_title')).toBeNull()
  expect(mockEnrollKey).toHaveBeenCalledTimes(2)
})

test('the reset passes pending and stored serials so a vault key can never be erased', async () => {
  mockMeta = { v: 5, createdAt: 1, keys: [record('99990001', 'z')] }
  const { screen } = await failTapWith('mgmt-key-custom', { serial: '12340001' })
  fireEvent.press(screen.getByText('vault_reset_offer'))
  await settle()
  fireEvent.press(screen.getByText('vault_reset_ack'))
  await act(async () => fireEvent.press(screen.getByText('vault_reset_confirm')))
  await settle()

  expect(mockResetPiv.mock.calls[0][0].refuseSerials).toContain('99990001')
})
```

- [ ] **Step 3: Run them to verify they fail**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx jest packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx -t reset
```

Expected: FAIL — `vault_reset_offer` not found.

- [ ] **Step 4: Implement**

Add `resetPivApplication` to the `@bsv/expo-wallet-toolbox` import list. Add state and the eligibility rule near `KeyStepError`:

```ts
/**
 * Codes a PIV reset can actually fix. `attestation-invalid` is excluded on
 * purpose: the factory F9 chain failed, so the token is counterfeit or
 * tampered and a reset changes nothing — offering one would mislead. A key
 * already enrolled is excluded because resetting it destroys a live vault
 * signer; pivReset refuses it below the UI as well.
 */
const RESETTABLE: ReadonlySet<VaultErrorCode> = new Set<VaultErrorCode>([
  'mgmt-key-custom',
  'slot-occupied',
  'pin-invalid',
  'puk-invalid',
  'pin-locked',
  'puk-locked',
  'enrollment-partial'
])
```

Add to the component state:

```ts
  /** The serial the failed attempt reported; a reset tap binds to it. */
  const [resetSerial, setResetSerial] = useState<string | null>(null)
  const [resetAck, setResetAck] = useState(false)
  const [resetting, setResetting] = useState(false)
```

In `runTap`'s catch, after `copy` is computed, record the serial:

```ts
        const failedSerial = duplicateSerial(err)
        setResetSerial(
          failedSerial && err && RESETTABLE.has(err.code) && err.code !== 'key-already-enrolled'
            ? failedSerial
            : null
        )
```

Add the reset handler beside `useDifferentKey`:

```ts
  const runReset = useCallback(async () => {
    if (!resetSerial || !resetAck || resetting) return
    setResetting(true)
    setStepError(null)
    try {
      await resetPivApplication({
        serial: resetSerial,
        // Stored ∪ pending: pivReset refuses these below the UI too, but the
        // wizard holds pending records the store has not seen yet.
        refuseSerials: [...metaKeys.map(r => r.serial), ...pending.map(r => r.serial)],
        acknowledgeDestroysAllCredentials: true,
        scopeToken,
        nfcMessage: t('vault_nfc_enroll_message')
      })
      haptics.success()
      showToast(t('vault_reset_done'), { type: 'success' })
      setResetAck(false)
      setResetSerial(null)
      setKeyError(null)
      // The PIN and recovery code chosen for this key are still valid — the
      // card is back at factory state and they have not been written yet.
      await runTap()
    } catch (e) {
      haptics.error()
      const err = e instanceof VaultError ? e : undefined
      if (err?.code === 'scope-changed') {
        clearKeyInputs()
        showToast(vaultErrorCopy('scope-changed'), { type: 'error' })
        onCancel()
        return
      }
      setStepError(
        err?.code === 'key-already-enrolled' ? t('vault_err_reset_enrolled') : vaultErrorCopy(err?.code)
      )
    } finally {
      setResetting(false)
    }
  }, [resetSerial, resetAck, resetting, metaKeys, pending, scopeToken, onCancel, runTap])
```

Add the `reset` sub-step block before the `error` block:

```tsx
    if (sub === 'reset') {
      return (
        <ScrollView contentContainerStyle={styles.body}>
          <Ionicons name="warning-outline" size={48} color={colors.warning} style={styles.hero} />
          <Text style={[styles.h1, { color: colors.textPrimary }]}>{t('vault_reset_title')}</Text>
          <Text style={[styles.p, { color: colors.textSecondary }]}>
            {resetSerial ? `…${resetSerial.slice(-4)}` : ''}
          </Text>
          <Text style={[styles.p, { color: colors.textSecondary }]}>{t('vault_reset_body')}</Text>
          <PressableScale
            accessibilityRole="checkbox"
            accessibilityState={{ checked: resetAck }}
            haptic="tap"
            onPress={() => setResetAck(value => !value)}
            style={[styles.ackRow, { borderColor: resetAck ? colors.error : colors.separator }]}
          >
            <Ionicons
              name={resetAck ? 'checkbox' : 'square-outline'}
              size={24}
              color={resetAck ? colors.error : colors.textTertiary}
            />
            <Text style={[styles.ackText, { color: colors.textPrimary }]}>{t('vault_reset_ack')}</Text>
          </PressableScale>
          {stepError && <Text style={[styles.err, { color: colors.error }]}>{stepError}</Text>}
          <ActionButton
            label={resetting ? t('vault_resetting') : t('vault_reset_confirm')}
            enabled={resetAck && !resetting}
            busy={resetting}
            onPress={() => void runReset()}
          />
          <ActionButton
            label={t('vault_key_use_different')}
            variant="outline"
            enabled={!resetting}
            onPress={() => {
              setResetAck(false)
              setStepError(null)
              useDifferentKey()
            }}
          />
        </ScrollView>
      )
    }
```

In the `error` sub-step, add the offer above the existing branches:

```tsx
        {resetSerial && (
          <ActionButton
            label={t('vault_reset_offer')}
            variant="outline"
            onPress={() => {
              setStepError(null)
              setSub('reset')
            }}
          />
        )}
```

Extend `clearKeyInputs` with `setResetSerial(null)` and `setResetAck(false)`.

- [ ] **Step 5: Run the whole suite**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npm test
```

Expected: PASS across every suite.

- [ ] **Step 6: Type-check and lint**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npx tsc --noEmit && npm run lint
```

Expected: no new errors versus the baseline recorded before Task 1.

- [ ] **Step 7: Commit**

```bash
npm run fix && git add packages/expo-wallet-toolbox/ui/components/vault/EnrollWizard.tsx packages/expo-wallet-toolbox/core/i18n/translations.tsx packages/expo-wallet-toolbox/__tests__/ui/enrollWizard.test.tsx && git commit -m "offer an in-app piv reset for a previously used vault key"
```

---

## Task 10: Retire the dead credential copy

Seven of the eight old credential keys are now unreferenced. **`vault_enter_pin` is not one of them** — it is shared with `VaultCeremonySheet.tsx:195` and `VaultScreen.tsx:981,983` and must stay. (The design doc's §6 retire list is wrong on this point; it also omits `vault_set_new_puk` and `vault_default_pin_warning`, which are retirable.)

**Files:**
- Modify: `packages/expo-wallet-toolbox/core/i18n/translations.tsx`

**Interfaces:** consumes Tasks 7–9; produces nothing.

- [ ] **Step 1: Prove each key is unreferenced**

```bash
for k in vault_enter_pin_sub vault_enter_puk vault_enter_puk_sub vault_set_new_pin vault_set_new_puk vault_default_pin_warning vault_default_puk_warning; do echo "== $k"; grep -rn "$k" --include="*.ts" --include="*.tsx" packages src 2>/dev/null | grep -v "core/i18n/translations.tsx"; done
```

Expected: no output under any heading. Any hit means that key is still in use — leave it and note which.

- [ ] **Step 2: Confirm `vault_enter_pin` IS still used**

```bash
grep -rn "vault_enter_pin'" --include="*.tsx" packages | grep -v translations.tsx
```

Expected: hits in `VaultCeremonySheet.tsx` and `VaultScreen.tsx`. Do not delete this key.

- [ ] **Step 3: Delete the seven keys from all 12 blocks**

```bash
cd /Users/personal/git/bsv-wallet && for k in vault_enter_pin_sub vault_enter_puk vault_enter_puk_sub vault_set_new_pin vault_set_new_puk vault_default_pin_warning vault_default_puk_warning; do sed -i '' "/^      $k:/d" packages/expo-wallet-toolbox/core/i18n/translations.tsx; done
```

Then inspect the file for orphaned continuation lines — `vault_default_pin_warning` and `vault_default_puk_warning` are single-line in `en` but some languages wrap. Check with:

```bash
npx prettier --check packages/expo-wallet-toolbox/core/i18n/translations.tsx
```

and fix any line the parser rejects by hand.

- [ ] **Step 4: Fix the stale `vault_key_step_replace` translations**

All 11 non-English values still say setup *stops* when a PIV slot is occupied; English was changed to say setup *warns* before replacing. The parity test cannot catch a meaning drift. Replace each with:

```
zh: '请使用专供保险库且已恢复出厂设置的 YubiKey。若其保险库槽位中已有旧密钥，设置会在替换前提示您。',
hi: 'वॉल्ट के लिए समर्पित, फ़ैक्टरी-रीसेट YubiKey का उपयोग करें। यदि उसके वॉल्ट स्लॉट में पुरानी कुंजी है, तो बदलने से पहले सेटअप चेतावनी देगा।',
es: 'Usa una YubiKey restablecida de fábrica y dedicada a la caja fuerte. Si su ranura contiene una clave antigua, la configuración avisará antes de sustituirla.',
fr: 'Utilisez une YubiKey réinitialisée en usine et dédiée au coffre. Si son emplacement contient une ancienne clé, la configuration vous avertira avant de la remplacer.',
ar: 'استخدم YubiKey مُعاد ضبطه للمصنع ومخصصًا للخزنة. إذا كانت خانة الخزنة تحتوي على مفتاح قديم، فسينبّهك الإعداد قبل استبداله.',
pt: 'Use uma YubiKey reposta de fábrica e dedicada ao cofre. Se a ranhura do cofre contiver uma chave antiga, a configuração avisará antes de a substituir.',
bn: 'ভল্টের জন্য নির্দিষ্ট, ফ্যাক্টরি-রিসেট YubiKey ব্যবহার করুন। এর ভল্ট স্লটে পুরনো কী থাকলে প্রতিস্থাপনের আগে সেটআপ সতর্ক করবে।',
ru: 'Используйте сброшенный до заводского состояния YubiKey, выделенный для хранилища. Если в его слоте есть старый ключ, настройка предупредит перед заменой.',
id: 'Gunakan YubiKey yang disetel ulang ke pabrik dan khusus untuk brankas. Bila slot brankasnya berisi kunci lama, penyiapan akan memperingatkan sebelum menggantinya.',
ja: '保管庫専用に初期化した YubiKey を使ってください。保管庫スロットに古い鍵がある場合、置き換える前に確認が表示されます。',
pl: 'Użyj klucza YubiKey zresetowanego fabrycznie i przeznaczonego dla sejfu. Jeśli w gnieździe sejfu jest stary klucz, konfiguracja ostrzeże przed jego zastąpieniem.',
```

- [ ] **Step 5: Run the full verification bar**

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npm test && npx tsc --noEmit && npm run lint
```

Expected: all three clean.

- [ ] **Step 6: Commit**

```bash
npm run fix && git add packages/expo-wallet-toolbox/core/i18n/translations.tsx && git commit -m "drop retired vault credential copy and refresh stale slot warning"
```

---

## Device verification (after an EAS build)

The native reset cannot be exercised by jest, and this change cannot ship over the air. Build and install before signing this off:

```bash
export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH" && npm run ios-dev-build
```

Then check, on hardware:

1. **A factory YubiKey through the full flow** — four pages, progress reads 1→4, the recovery code is 8 digits, enrollment completes, and the PIN chosen on page 1 works on a later vault transfer.
2. **A used YubiKey** — setup stops with a reset offer rather than a dead end; the PIN retry counter is untouched (`ykman piv info` before and after should both read 3 retries, proving the preflight hoist works).
3. **Reset then enrol** — accept the reset, tap, confirm the key comes back at factory state and enrollment continues without re-asking for the PIN.
4. **Reset refusal** — attempt a reset on a key already enrolled in the vault. It must be refused before the card is contacted.
5. **Android bio key**, if one is available — reset must report a clear refusal, not a generic "wrong key".

## Self-Review

**Spec coverage.** §1 page flow → Tasks 7, 8. §2 generated PUK → Task 8. §3 factory codes below the UI → Task 7 Step 4. §4 preflight hoist → Task 6 (the spec's escape hatch is now closed: preflight issues no VERIFY on either platform, verified by tracing both call graphs). §5 native reset → Task 3. §6 `pivReset.ts` → Task 5. §7 error routing → Task 9. §6 file table's i18n row → Tasks 1, 2, 7, 8, 9, 10.

**Corrections to the spec made here.** `vault_enter_pin` is shared and cannot be retired, contrary to §6; the retire list gains `vault_set_new_puk` and `vault_default_pin_warning`. Two hazards the spec did not know about are handled in Task 3: the iOS `blockPuk` never-settle path, and Android's `IllegalArgumentException` on bio-configured keys. Two pre-existing defects found while grounding are fixed in Tasks 1 and 2.

**Type consistency.** `resetPivApplication` carries one name across the nitro spec, both native impls, `VaultDriver`, the mock and `pivReset.ts`. `KEY_STEPS`, `StepProgress` and `generateRecoveryCode` are all defined in Task 7 and consumed in Tasks 8 and 9 — an earlier draft split the generator into Task 8, leaving Task 7 calling something that did not exist yet.

**Known cross-task seam.** Task 7 routes the PIN page to `sub = 'puk'`, whose page Task 8 renders. Task 7's own three tests pass on their own, but the wizard suite is only fully green once Task 8 lands; Task 7 Step 8 says so and offers a temporary `test.skip`. These two tasks should be executed back to back.
