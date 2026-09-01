/**
 * The settings footer exists so a user can quote a version number when
 * something goes wrong; a footer that silently renders nothing is worse than
 * useless, so the shapes expo-constants can return are pinned here.
 */
function labelFrom(Constants: any): string {
  const version = Constants?.expoConfig?.version ?? Constants?.nativeAppVersion
  const build =
    Constants?.expoConfig?.ios?.buildNumber ??
    Constants?.expoConfig?.android?.versionCode ??
    Constants?.nativeBuildVersion
  if (!version) return ''
  return build ? `${version} (${build})` : `${version}`
}

describe('settings version label', () => {
  it('pairs the version with the iOS build number', () => {
    expect(labelFrom({ expoConfig: { version: '1.0.0', ios: { buildNumber: '11' } } })).toBe('1.0.0 (11)')
  })

  it('falls back to the Android version code', () => {
    expect(labelFrom({ expoConfig: { version: '1.0.0', android: { versionCode: 6 } } })).toBe('1.0.0 (6)')
  })

  it('shows the version alone when no build number is configured', () => {
    expect(labelFrom({ expoConfig: { version: '1.0.0' } })).toBe('1.0.0')
  })

  it('reads the native values when there is no expoConfig', () => {
    expect(labelFrom({ nativeAppVersion: '1.0.0', nativeBuildVersion: '11' })).toBe('1.0.0 (11)')
  })

  it('renders nothing rather than a broken string when the module gives nothing', () => {
    expect(labelFrom({})).toBe('')
    expect(labelFrom(undefined)).toBe('')
  })
})
