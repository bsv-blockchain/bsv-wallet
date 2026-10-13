// WhatsOnChain for this wallet's network (the existing Home's explorer links).

export const wocBase = (network: string) =>
  network === 'main' ? 'https://whatsonchain.com' : network === 'teratest' ? 'https://woc-ttn.bsvblockchain.tech' : 'https://test.whatsonchain.com'

/** a transaction's page on WhatsOnChain */
export const explorerUrl = (network: string, txid: string) => `${wocBase(network)}/tx/${txid}`

/** an address's page on WhatsOnChain */
export const addressUrl = (network: string, address: string) => `${wocBase(network)}/address/${address}`
