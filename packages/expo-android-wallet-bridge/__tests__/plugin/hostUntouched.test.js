/** @jest-environment node */
const fs = require('fs')
const path = require('path')
const { run, hostConfig, applyMods } = require('./support')

describe('host output', () => {
  test('the trampoline is never touched by withIconAliasLinks', () => {
    const withIconAliasLinks = require('./fixtures/withIconAliasLinks')
    const { manifest } = run({})
    const merged = applyMods(withIconAliasLinks, manifest)
    const app = merged.manifest.application[0]
    const bridgeSchemes = a =>
      (a['intent-filter'] || [])
        .flatMap(f => (f.data || []).map(d => d.$['android:scheme']))
        .filter(s => s === 'bsv-wallet-bridge')
    // the alias gets the host's links, never the bridge filter
    expect(app['activity-alias'].flatMap(bridgeSchemes)).toEqual([])
    expect(app['activity-alias'][0]['intent-filter']).toHaveLength(2)
    // the trampoline entry is unchanged and still has exactly its one filter
    const t = app.activity.find(a => a.$['android:name'] === 'org.bsv.walletbridge.LaunchTrampolineActivity')
    expect(t['intent-filter']).toHaveLength(1)
    expect(bridgeSchemes(t)).toEqual(['bsv-wallet-bridge'])
    // MainActivity does not carry it either
    expect(bridgeSchemes(app.activity.find(a => a.$['android:name'] === '.MainActivity'))).toEqual([])
  })

  test('plugin changes nothing else in a fixture host config', () => {
    const cfg = hostConfig()
    const snapshot = JSON.parse(JSON.stringify(cfg))
    const { config } = run({ config: cfg })
    const { __manifestMods, ...rest } = config
    expect(rest).toEqual(snapshot)
    expect(__manifestMods).toHaveLength(1)
  })

  test('no process.env in plugin/', () => {
    const dir = path.join(__dirname, '..', '..', 'plugin')
    for (const file of fs.readdirSync(dir)) {
      expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toMatch(/process\.env/)
    }
    expect(fs.readFileSync(path.join(__dirname, '..', '..', 'app.plugin.js'), 'utf8')).not.toMatch(/process\.env/)
  })
})
