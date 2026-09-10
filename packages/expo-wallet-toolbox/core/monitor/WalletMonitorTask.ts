import type { Monitor, MonitorStorage } from '@bsv/wallet-toolbox-mobile'

/**
 * Public-package compatibility base for application-specific monitor tasks.
 * Wallet Toolbox no longer publishes its internal task source path.
 */
export abstract class WalletMonitorTask {
  lastRunMsecsSinceEpoch = 0
  storage: MonitorStorage

  constructor(
    public monitor: Monitor,
    public name: string
  ) {
    this.storage = monitor.storage
  }

  async asyncSetup(): Promise<void> {}

  abstract trigger(nowMsecsSinceEpoch: number): { run: boolean }
  abstract runTask(): Promise<string>
}
