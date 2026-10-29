/** @jest-environment node */
const { run, hostConfig, hostManifest } = require('./support')

const tramp = manifest =>
  manifest.manifest.application[0].activity.find(
    a => a.$['android:name'] === 'org.bsv.walletbridge.LaunchTrampolineActivity'
  )

describe('plugin manifest output', () => {
  test('manifest snapshot: the trampoline gets exactly one filter with the scheme and host launch', () => {
    const { manifest } = run({})
    const t = tramp(manifest)
    expect(t).toEqual({
      $: { 'android:name': 'org.bsv.walletbridge.LaunchTrampolineActivity', 'tools:node': 'merge' },
      'intent-filter': [
        {
          action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
          category: [
            { $: { 'android:name': 'android.intent.category.DEFAULT' } },
            { $: { 'android:name': 'android.intent.category.BROWSABLE' } }
          ],
          data: [{ $: { 'android:scheme': 'bsv-wallet-bridge', 'android:host': 'launch' } }]
        }
      ]
    })
    expect(manifest.manifest.$['xmlns:tools']).toBe('http://schemas.android.com/tools')
  })

  test('running twice keeps one filter, and a changed scheme replaces it', () => {
    const first = run({}).manifest
    const again = run({ manifest: first }).manifest
    expect(tramp(again)['intent-filter']).toHaveLength(1)
    const changed = run({ manifest: again, options: { scheme: 'other-bridge' } }).manifest
    expect(tramp(changed)['intent-filter']).toHaveLength(1)
    expect(tramp(changed)['intent-filter'][0].data[0].$['android:scheme']).toBe('other-bridge')
  })

  test('a scheme already handled by another activity in the manifest throws', () => {
    expect(() =>
      run({ options: { scheme: 'bsv-wallet-bridge' }, manifest: withMainScheme('bsv-wallet-bridge') })
    ).toThrow(/already handled by .MainActivity/)
  })

  test('no SYSTEM_ALERT_WINDOW, network security config, App Link, boot receiver or queries entry is added', () => {
    const before = JSON.parse(JSON.stringify(hostManifest()))
    const { manifest } = run({})
    const m = manifest.manifest
    const text = JSON.stringify(m)
    expect(text).not.toContain('SYSTEM_ALERT_WINDOW')
    expect(text).not.toContain('networkSecurityConfig')
    expect(text).not.toContain('autoVerify')
    expect(text).not.toContain('BOOT_COMPLETED')
    expect(m.queries).toBeUndefined()
    expect(m['uses-permission']).toBeUndefined()
    expect(m.application[0].receiver).toBeUndefined()
    expect(m.application[0].service).toBeUndefined()
    // MainActivity and the alias are exactly as the host had them
    expect(m.application[0].activity.find(a => a.$['android:name'] === '.MainActivity')).toEqual(
      before.manifest.application[0].activity[0]
    )
    expect(m.application[0]['activity-alias']).toEqual(before.manifest.application[0]['activity-alias'])
  })

  test('allowBackup true warns, false does not', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      run({ config: hostConfig({ android: { package: 'org.bsvblockchain.wallet', allowBackup: true } }) })
      expect(warn.mock.calls.some(c => /allowBackup/.test(c[0]))).toBe(true)
      warn.mockClear()
      run({})
      expect(warn).not.toHaveBeenCalled()
      // manifest attribute
      const m = hostManifest()
      m.manifest.application[0].$['android:allowBackup'] = 'true'
      run({ manifest: m })
      expect(warn.mock.calls.some(c => /allowBackup/.test(c[0]))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })

  test('declaring SYSTEM_ALERT_WINDOW warns; blocking it does not', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      run({})
      expect(warn).not.toHaveBeenCalled()
      run({
        config: hostConfig({
          android: { package: 'org.bsvblockchain.wallet', permissions: ['android.permission.SYSTEM_ALERT_WINDOW'] }
        })
      })
      expect(warn.mock.calls.some(c => /SYSTEM_ALERT_WINDOW/.test(c[0]))).toBe(true)
    } finally {
      warn.mockRestore()
    }
  })
})

function withMainScheme(scheme) {
  const m = hostManifest()
  m.manifest.application[0].activity[0]['intent-filter'][1].data[0].$['android:scheme'] = scheme
  return m
}
