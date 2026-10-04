import type { Address, Chain } from 'viem'

export type DiscoveryMode = 'allowlist' | 'blockscout' | 'etherscan'

export type TokenRef = {
  symbol: string
  address: Address
  decimals?: number
  /** 價格 API 失敗時的備用美元價格。只適合穩定幣。 */
  assumedUsd?: number
}

export type ChainInput = {
  preset?: string
  enabled?: boolean
  chainId?: number
  name?: string
  rpcUrl?: string
  rpcUrls?: string[]
  nativeSymbol?: string
  nativeDecimals?: number
  nativeCoingeckoId?: string
  llamaChain?: string
  blockscoutUrl?: string
  multicall3?: Address
  /** 若有設定，會取代該鏈的預設代幣，不再使用內建白名單。 */
  tokens?: TokenRef[]
  extraTokens?: TokenRef[]
}

export type ResolvedChain = {
  key: string
  enabled: boolean
  chainId: number
  name: string
  rpcUrls: string[]
  nativeSymbol: string
  nativeDecimals: number
  nativeCoingeckoId: string
  llamaChain: string
  blockscoutUrl?: string
  tokens: TokenRef[]
  viemChain: Chain
}

export type AppConfig = {
  receiver: Address
  keysFile: string
  discovery: DiscoveryMode
  etherscanApiKey?: string
  minTransferUsd: number
  minValueToGasRatio: number
  gasCostMultiplier: number
  maxSellTax: number
  minPriceConfidence: number
  maxPriceAgeSec: number
  maxGasLimit: bigint
  confirmations: number
  concurrency: number
  denyTokens: Address[]
  /** 對白名單代幣也跑 GoPlus。預設關閉，避免沙箱誤判擋掉 USDC 這類資產。 */
  screenAllowlist: boolean
  /** 沒有這個檔代表不補 gas。 */
  gasProviderFile?: string
  chains: ResolvedChain[]
}

export type HoldingSource = 'native' | 'allowlist' | 'blockscout' | 'etherscan'

export type Holding = {
  chainKey: string
  chainId: number
  chainName: string
  wallet: Address
  kind: 'native' | 'erc20'
  symbol: string
  name?: string
  token?: Address
  amount: bigint
  decimals: number
  source: HoldingSource
  reputation?: string | null
  assumedUsd?: number
  allowlisted: boolean
  /** 這個資產在 DefiLlama 的價格代號。 */
  priceId: string
  /** 這條鏈原生幣的價格代號，用來把 gas 換成美元。 */
  nativePriceId: string
  nativeDecimals: number
}

export type FeeQuote = {
  feePerGas: bigint
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  gasPrice?: bigint
}

export type Decision = {
  holding: Holding
  action: 'send' | 'skip'
  reason: string
  amountFormatted: string
  valueUsd: number | null
  netValueUsd: number | null
  gasCostUsd: number | null
  gasLimit?: bigint
  costWei: bigint
  fee?: FeeQuote
  /** 原生幣實際要送出的金額（已預留 gas）。 */
  sendAmount?: bigint
  sellTax: number
  /** 補過 gas 之後，把剩下的原生幣清到接收地址，不再用最低價值擋下。 */
  forceSweep?: boolean
}

export type GasTopUp = {
  chainKey: string
  chainId: number
  chainName: string
  wallet: Address
  amount: bigint
  nativeSymbol: string
  nativeDecimals: number
  symbols: string[]
}

export type PriceQuote = {
  price: number
  confidence: number
  timestamp: number
}

export type SecurityVerdict = {
  known: boolean
  sellTax: number
  rejectReason?: string
}
