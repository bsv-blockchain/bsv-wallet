import { BRIDGE_DEVIATIONS, buildConformanceReport } from '../../core/bridge/conformance'
import { BRIDGE_METHODS } from '../../core/bridge/protocol/methods'

describe('conformance report', () => {
  const report = buildConformanceReport()

  it('lists all 28 methods, probes marked', () => {
    expect(report.methods).toHaveLength(28)
    expect(report.methods.map(m => m.name).sort()).toEqual(Object.keys(BRIDGE_METHODS).sort())
    expect(report.methods.filter(m => m.handling === 'probe').map(m => m.name)).toEqual([
      'getVersion',
      'isAuthenticated'
    ])
  })

  it('method deviations point at recorded deviations', () => {
    const ids = new Set(BRIDGE_DEVIATIONS.map(d => d.id))
    for (const m of report.methods) for (const d of m.deviations) expect(ids.has(d)).toBe(true)
  })

  it('is plain JSON and stable', () => {
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
    expect(buildConformanceReport()).toEqual(report)
  })

  it('matches the recorded report', () => {
    expect(report).toMatchSnapshot()
  })
})
