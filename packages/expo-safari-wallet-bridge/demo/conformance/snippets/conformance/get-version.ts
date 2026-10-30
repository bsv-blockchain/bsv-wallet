// @ts-nocheck
import { conformanceWallet } from './support'

export async function conformanceGetVersion(runner) {
  const wallet = conformanceWallet()
  const version = await wallet.getVersion({})
  const versionText = version.version
  const versionOk = versionText.length >= 7
    && versionText.length <= 30
    && /^[^\s]+-\d+\.\d+\.\d+$/.test(versionText)
  if (!versionOk) {
    throw new Error(`Version "${versionText}" is not vendor-major.minor.patch within 7-30 bytes`)
  }
  runner.log({ version: versionText })
}
