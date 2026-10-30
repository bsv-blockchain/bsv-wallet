/** @jest-environment node */
const { inheritPodLinkerFlags } = require('../../plugin')

const target = (name, configs) => ({
  props: {
    name,
    buildConfigurationList: {
      props: { buildConfigurations: configs.map(buildSettings => ({ props: { buildSettings } })) }
    }
  }
})
const project = (...targets) => ({ rootObject: { props: { targets } } })

describe('extension linker flags', () => {
  test('the extension target keeps the flags CocoaPods puts in its xcconfig', () => {
    const debug = { OTHER_LDFLAGS: ['-framework', 'SafariServices'] }
    const release = { OTHER_LDFLAGS: ['-framework', 'SafariServices'] }
    const app = { OTHER_LDFLAGS: ['-ObjC'] }
    expect(
      inheritPodLinkerFlags(project(target('SafariBridge', [debug, release]), target('App', [app])), 'SafariBridge')
    ).toBe(2)
    expect(debug.OTHER_LDFLAGS).toEqual(['$(inherited)', '-framework', 'SafariServices'])
    expect(release.OTHER_LDFLAGS).toEqual(['$(inherited)', '-framework', 'SafariServices'])
    // the host app target is not touched
    expect(app.OTHER_LDFLAGS).toEqual(['-ObjC'])
  })

  test('running it again changes nothing, and a missing setting becomes just the inherited flags', () => {
    const settings = { OTHER_LDFLAGS: ['$(inherited)', 'x'] }
    const bare = {}
    expect(inheritPodLinkerFlags(project(target('SafariBridge', [settings, bare])), 'SafariBridge')).toBe(1)
    expect(settings.OTHER_LDFLAGS).toEqual(['$(inherited)', 'x'])
    expect(bare.OTHER_LDFLAGS).toEqual(['$(inherited)'])
  })
})
